/**
 * The decisions inside spec §12.6's dialogs, tested away from React: the progress reduction and
 * its two failure readings, the base-branch suggestions (which the plan got wrong in a way that
 * would have failed every remote pick), and the delete force-confirm gate — the only thing
 * standing between a mis-click and lost work.
 */
import { describe, expect, it } from 'vitest';
import { PROGRESS_STEP_ROLLBACK, PROGRESS_STEP_SAVED, type DeleteInspection, type ProgressEvent } from '../../../../shared/ipc-contract.ts';
import { defaultProjectSetup, type Project, type Workspace } from '../../../../shared/types.ts';
import {
  addableProjects, agentWasSaved, branchOptions, canConfirmDelete, deleteIsRisky,
  duplicateRowIndexes, failStalledSteps, linesOf, progressAgentId, PROGRESS_GLYPH, reduceProgress,
  rollbackRan,
} from './logic.ts';

const ev = (step: string, status: ProgressEvent['status'], patch: Partial<ProgressEvent> = {}): ProgressEvent => ({
  agentId: 'a1', opId: 'op1', step, status, message: `${step} ${status}`, ...patch,
});

const fold = (events: ProgressEvent[]): ProgressEvent[] => events.reduce<ProgressEvent[]>(reduceProgress, []);

describe('reduceProgress', () => {
  it('upserts by (opId, step) rather than appending, so a step never appears twice', () => {
    const list = fold([ev('hangar: fetch', 'running'), ev('hangar: fetch', 'done')]);
    expect(list.map((p) => [p.step, p.status])).toEqual([['hangar: fetch', 'done']]);
  });

  it('keeps a step in its original slot when it finishes after a later one started', () => {
    const list = fold([
      ev('a: fetch', 'running'),
      ev('a: worktree', 'running'),
      ev('a: fetch', 'warn'),
      ev('a: worktree', 'done'),
    ]);
    expect(list.map((p) => p.step)).toEqual(['a: fetch', 'a: worktree']);
    expect(list.map((p) => p.status)).toEqual(['warn', 'done']);
  });

  // A retry mints a fresh opId (`progressFor` calls `uuid()` per operation). Same step name, and
  // it must not overwrite the previous attempt's line.
  it('treats the same step from a different operation as a separate line', () => {
    const list = fold([ev('a: fetch', 'error'), ev('a: fetch', 'running', { opId: 'op2' })]);
    expect(list.length).toBe(2);
  });

  it('carries the expandable log through — postCreate output is the reason it exists', () => {
    const list = fold([ev('a: postCreate', 'running'), ev('a: postCreate', 'done', { log: 'npm ci\nok' })]);
    expect(list[0]?.log).toBe('npm ci\nok');
  });

  it('does not mutate the list it was given', () => {
    const before = [ev('a: fetch', 'running')];
    const after = reduceProgress(before, ev('a: fetch', 'done'));
    expect(before[0]?.status).toBe('running');
    expect(after).not.toBe(before);
  });

  it('has a glyph for every status the contract allows', () => {
    expect(Object.keys(PROGRESS_GLYPH).sort()).toEqual(['done', 'error', 'running', 'warn']);
  });
});

/**
 * The real shape of a mid-flight failure, taken from `agent-service.provisionWorkspace`: the step
 * that threw is left on `running` forever, `rollback` reports ✓ underneath it, and the only ✗ is
 * the trailing `failed` line. Without `failStalledSteps` the dialog shows a spinner on the very
 * step spec §12.6 asks to highlight.
 */
describe('failStalledSteps', () => {
  const midFlightFailure = fold([
    ev('hangar: fetch', 'running'),
    ev('hangar: fetch', 'done'),
    ev('hangar: worktree', 'running'),
    ev(PROGRESS_STEP_ROLLBACK, 'running'),
    ev(PROGRESS_STEP_ROLLBACK, 'done'),
    ev('failed', 'error', { message: 'hangar: branch "nope" was not found locally or on origin' }),
  ]);

  it('turns the step left mid-spinner into the failing step', () => {
    const shown = failStalledSteps(midFlightFailure);
    expect(shown.map((p) => p.status)).toEqual(['done', 'error', 'done', 'error']);
    expect(shown.find((p) => p.step === 'hangar: worktree')?.status).toBe('error');
  });

  it('leaves finished steps and their messages alone', () => {
    const shown = failStalledSteps(midFlightFailure);
    expect(shown[0]).toEqual(midFlightFailure[0]);
    expect(shown.find((p) => p.step === 'hangar: worktree')?.message).toBe('hangar: worktree running');
  });

  it('is a no-op once nothing is running', () => {
    const done = fold([ev('a: fetch', 'done')]);
    expect(failStalledSteps(done)).toEqual(done);
  });
});

describe('reading what a failed create left behind', () => {
  it('reports rollback ran when the failure happened during provisioning', () => {
    const list = fold([ev('a: worktree', 'running'), ev(PROGRESS_STEP_ROLLBACK, 'done'), ev('failed', 'error')]);
    expect(rollbackRan(list)).toBe(true);
    expect(agentWasSaved(list)).toBe(false);
  });

  /**
   * The case that makes Retry wrong. `createAgent` commits the record, emits `saved`, and only
   * THEN awaits `startAgent(id, 'auto')` — with no catch — so `startNow` against a disconnected
   * host rejects `agent:create` for an agent that exists. Retrying would create a second one.
   */
  it('reports the agent as saved when only the start failed, and names it', () => {
    const list = fold([
      ev('a: worktree', 'done'),
      ev(PROGRESS_STEP_SAVED, 'done', { message: 'agent created' }),
    ]);
    expect(agentWasSaved(list)).toBe(true);
    expect(rollbackRan(list)).toBe(false);
    expect(progressAgentId(list)).toBe('a1');
  });

  it('does not read a rolled-back attempt as saved', () => {
    expect(agentWasSaved(fold([ev(PROGRESS_STEP_SAVED, 'error')]))).toBe(false);
    expect(agentWasSaved([])).toBe(false);
    expect(progressAgentId([])).toBeNull();
    expect(progressAgentId(fold([ev('x', 'done', { agentId: null })]))).toBeNull();
  });
});

/**
 * `agent-service.baseRefFor` resolves the typed base as `refs/remotes/origin/<base>` and then
 * `refs/heads/<base>`, so the datalist must offer BARE names. The plan's
 * `[...b.local, ...b.remote]` offered `origin/main`, which resolves to
 * `refs/remotes/origin/origin/main` and then `refs/heads/origin/main` — BASE_NOT_FOUND, every
 * time, for the entry a user is most likely to click.
 */
describe('branchOptions', () => {
  it('strips the remote so a picked suggestion is one baseRefFor can resolve', () => {
    expect(branchOptions({ local: ['main'], remote: ['origin/main', 'origin/release'] }))
      .toEqual(['main', 'release']);
  });

  it('strips only the remote segment, not every segment', () => {
    expect(branchOptions({ local: [], remote: ['origin/feature/login'] })).toEqual(['feature/login']);
  });

  it('lists locals first and de-duplicates across remotes', () => {
    expect(branchOptions({ local: ['main', 'wip'], remote: ['origin/wip', 'upstream/main', 'origin/main'] }))
      .toEqual(['main', 'wip']);
  });

  it('survives an empty repo and a remote with no branch part', () => {
    expect(branchOptions({ local: [], remote: [] })).toEqual([]);
    expect(branchOptions({ local: [], remote: ['origin'] })).toEqual([]);
  });
});

describe('linesOf', () => {
  it('trims, drops blanks, and keeps order', () => {
    expect(linesOf('  .env \n\n\t.claude/settings.local.json\n')).toEqual(['.env', '.claude/settings.local.json']);
  });

  it('is empty for empty or whitespace-only text', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('  \n \n')).toEqual([]);
  });
});

describe('duplicateRowIndexes', () => {
  it('names the LATER row, so the first pick is the one that stands', () => {
    expect(duplicateRowIndexes(['p1', 'p2', 'p1', 'p1'])).toEqual([2, 3]);
  });

  it('is empty when every project is distinct', () => {
    expect(duplicateRowIndexes(['p1', 'p2'])).toEqual([]);
    expect(duplicateRowIndexes([])).toEqual([]);
  });
});

const proj = (id: string): Project => ({
  id, name: id, repoPath: `/repos/${id}`, defaultBranch: 'main', setup: defaultProjectSetup(),
  claudeArgs: [], createdAt: '2026-09-07T10:00:00.000Z',
});

const wsOn = (projectId: string): Workspace => ({
  id: `w-${projectId}`, projectId, branch: 'agent/x', worktreePath: `/wt/${projectId}`,
  baseRef: 'main', createdAt: '2026-09-07T10:00:00.000Z',
});

describe('addableProjects', () => {
  const projects = [proj('p1'), proj('p2'), proj('p3')];

  it('drops the projects the agent already has a workspace on', () => {
    expect(addableProjects(projects, [wsOn('p2')]).map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('keeps the projects order rather than the workspaces order', () => {
    expect(addableProjects(projects, [wsOn('p3'), wsOn('p1')]).map((p) => p.id)).toEqual(['p2']);
  });

  it('is empty once every project is taken, and total on the empty inputs', () => {
    expect(addableProjects(projects, projects.map((p) => wsOn(p.id)))).toEqual([]);
    expect(addableProjects([], [wsOn('p1')])).toEqual([]);
    expect(addableProjects(projects, []).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  // A workspace naming a project that is no longer in the workspace file must not remove an
  // unrelated option — `deleteAgent` already has to cope with that state, so it is reachable.
  it('ignores a workspace whose project is gone', () => {
    expect(addableProjects(projects, [wsOn('p9')]).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });
});

const ws = (patch: Partial<DeleteInspection['workspaces'][number]> = {}): DeleteInspection['workspaces'][number] => ({
  workspaceId: 'w1', branch: 'hangar/alpha', worktreePath: '/wt/alpha',
  dirtyFiles: 0, unmergedCommits: 0, worktreeMissing: false, inspectionFailed: false, ...patch,
});

const gate = (patch: Partial<Parameters<typeof canConfirmDelete>[0]> = {}) => ({
  inspection: { workspaces: [ws()] } as DeleteInspection,
  inspectFailed: false,
  removeWorktrees: true,
  deleteBranches: false,
  agentName: 'alpha',
  typed: '',
  busy: false,
  ...patch,
});

describe('delete force-confirm gate', () => {
  it('is not risky when the worktrees are clean', () => {
    expect(deleteIsRisky(gate())).toBe(false);
    expect(canConfirmDelete(gate())).toBe(true);
  });

  it('arms on uncommitted changes only while the worktree is actually being removed', () => {
    const dirty = { inspection: { workspaces: [ws({ dirtyFiles: 3 })] } };
    expect(deleteIsRisky(gate({ ...dirty, removeWorktrees: true }))).toBe(true);
    expect(deleteIsRisky(gate({ ...dirty, removeWorktrees: false }))).toBe(false);
  });

  it('arms on unmerged commits only while the branch is actually being deleted', () => {
    const unmerged = { inspection: { workspaces: [ws({ unmergedCommits: 7 })] } };
    expect(deleteIsRisky(gate({ ...unmerged, deleteBranches: true }))).toBe(true);
    expect(deleteIsRisky(gate({ ...unmerged, deleteBranches: false }))).toBe(false);
  });

  it('arms on ANY workspace, not just the primary', () => {
    const inspection = { workspaces: [ws(), ws({ workspaceId: 'w2', dirtyFiles: 1 })] };
    expect(deleteIsRisky(gate({ inspection }))).toBe(true);
  });

  /**
   * The trap the contract's own comment on `inspectionFailed` describes: a broken `.git` link
   * answers "not a git repository", so every count reads 0 and `worktreeMissing` is false while
   * real files sit in the directory. Unknown must arm the gate, not disarm it — including with
   * both checkboxes off, where the counts would otherwise make it look like a safe delete.
   */
  it('arms on an uninspectable workspace whatever the checkboxes say', () => {
    const broken = { inspection: { workspaces: [ws({ inspectionFailed: true })] } };
    expect(deleteIsRisky(gate({ ...broken, removeWorktrees: true, deleteBranches: true }))).toBe(true);
    expect(deleteIsRisky(gate({ ...broken, removeWorktrees: false, deleteBranches: false }))).toBe(true);
  });

  it('arms when the inspect call itself failed and we know nothing', () => {
    expect(deleteIsRisky(gate({ inspectFailed: true, inspection: { workspaces: [] } }))).toBe(true);
  });

  // A missing directory has nothing left to lose; it is the one "0" that is a real answer.
  it('does not arm merely because the worktree directory is gone', () => {
    expect(deleteIsRisky(gate({ inspection: { workspaces: [ws({ worktreeMissing: true })] } }))).toBe(false);
  });

  it('keeps confirm disabled until the typed name matches exactly', () => {
    const dirty = gate({ inspection: { workspaces: [ws({ dirtyFiles: 2 })] } });
    expect(canConfirmDelete(dirty)).toBe(false);
    expect(canConfirmDelete({ ...dirty, typed: 'alph' })).toBe(false);
    expect(canConfirmDelete({ ...dirty, typed: 'Alpha' })).toBe(false);
    expect(canConfirmDelete({ ...dirty, typed: 'alpha beta' })).toBe(false);
    expect(canConfirmDelete({ ...dirty, typed: 'alpha' })).toBe(true);
    expect(canConfirmDelete({ ...dirty, typed: '  alpha \n' })).toBe(true);
  });

  // The checkboxes default to ON, so a click landing before `agent:inspectDelete` answers would
  // delete under numbers nobody had seen.
  it('is disabled while the inspection is still in flight, and while a delete is running', () => {
    expect(canConfirmDelete(gate({ inspection: null }))).toBe(false);
    expect(canConfirmDelete(gate({ busy: true }))).toBe(false);
    expect(canConfirmDelete(gate({ busy: true, typed: 'alpha' }))).toBe(false);
  });
});
