import { describe, expect, it } from 'vitest';
import { PROJECT_NAME_MAX } from '../../../shared/constants.ts';
import { defaultProjectSetup, emptyWorkspace, type Agent, type Project, type WorkspaceFile } from '../../../shared/types.ts';
import { WorkspaceFileSchema } from '../../../shared/workspace-schema.ts';
import {
  StoreError, addProject, createAgent, createFolder, deleteAgent, deleteFolder, isDescendantFolder, moveAgent, moveFolder, needsRenumber,
  nextSortKey, normalizeOrder, removeProject, setLayout, siblings, sortKeyBefore, updateAgent, updateFolder, updateProject,
} from './workspace-ops.ts';

const project = (id: string, name = id): Project => ({ id, name, repoPath: `/repos/${id}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: '2026-09-07T00:00:00.000Z' });
const agent = (id: string, folderId: string | null = null, projectId = 'p1', branch = `agent/${id}`): Agent => ({
  id, name: id, slug: id, folderId, sortKey: 0, notes: '', createdAt: `2026-09-07T00:00:0${id.length}.000Z`, lastOpenedAt: null,
  workspaces: [{ id: `w-${id}`, projectId, branch, worktreePath: `/wt/${id}`, baseRef: 'origin/main', createdAt: 'x' }],
  claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
});
const ids = (ws: WorkspaceFile, parentId: string | null) => siblings(ws, parentId).map((c) => (c.kind === 'folder' ? c.folder.id : c.agent.id));

function base(): WorkspaceFile {
  let ws = addProject(emptyWorkspace(), project('p1'));
  ws = createFolder(ws, { id: 'f1', name: 'Ac', parentId: null });
  ws = createFolder(ws, { id: 'f2', name: 'Games', parentId: null });
  ws = createFolder(ws, { id: 'f1a', name: 'Sub', parentId: 'f1' });
  ws = createAgent(ws, agent('a1', 'f1'));
  ws = createAgent(ws, agent('a2', 'f1'));
  ws = createAgent(ws, agent('a3', null));
  return ws;
}

describe('projects', () => {
  it('adds with unique names and rejects duplicate repo paths', () => {
    let ws = addProject(emptyWorkspace(), project('p1', 'Api'));
    ws = addProject(ws, { ...project('p2', 'api'), repoPath: '/repos/other' });
    expect(ws.projects.map((p) => p.name)).toEqual(['Api', 'api-2']);
    expect(() => addProject(ws, { ...project('p3', 'X'), repoPath: '/repos/p1' })).toThrow(StoreError);
  });
  it('updates and refuses removal while in use', () => {
    let ws = base();
    ws = updateProject(ws, 'p1', { defaultBranch: 'develop' });
    expect(ws.projects[0]!.defaultBranch).toBe('develop');
    expect(() => removeProject(ws, 'p1')).toThrow(/used by 3 agent/);
    ws = deleteAgent(deleteAgent(deleteAgent(ws, 'a1'), 'a2'), 'a3');
    expect(removeProject(ws, 'p1').projects).toEqual([]);
  });
  it('rejects renaming to an existing project name or blanking the name', () => {
    let ws = addProject(emptyWorkspace(), project('p1', 'Api'));
    ws = addProject(ws, { ...project('p2', 'Web'), repoPath: '/repos/p2' });
    expect(() => updateProject(ws, 'p2', { name: 'api' })).toThrow(/already used/i);
    expect(() => updateProject(ws, 'p1', { name: '   ' })).toThrow(/required/i);
  });
  it('bounds a generated dedupe name so it always re-parses through WorkspaceFileSchema', () => {
    // Exactly at DirSegmentSchema's boundary: naively appending "-2" would make an 82-char name that
    // fails WorkspaceFileSchema on the very next load, classing the whole file corrupt (I2).
    const longName = 'x'.repeat(PROJECT_NAME_MAX);
    let ws = addProject(emptyWorkspace(), { ...project('p1', longName) });
    ws = addProject(ws, { ...project('p2', longName), repoPath: '/repos/p2' });
    const generated = ws.projects[1]!.name;
    expect(generated.length).toBeLessThanOrEqual(PROJECT_NAME_MAX);
    expect(generated).not.toBe(ws.projects[0]!.name);
    expect(WorkspaceFileSchema.safeParse(ws).success).toBe(true);
  });

  // Spec §15.4. `updateProject` spreads the patch, so this needs no code of its own — which is
  // exactly why it needs a test: nothing else would fail if `actions` were dropped from the
  // persisted `ProjectSchema`, because zod SILENTLY STRIPS keys it does not know and the loss would
  // only show up on the next load.
  it('stores project actions and keeps them re-parseable', () => {
    const ws = updateProject(base(), 'p1', { actions: [{ label: 'Tests', command: 'npm test' }] });
    expect(ws.projects[0]!.actions).toEqual([{ label: 'Tests', command: 'npm test' }]);
    expect(WorkspaceFileSchema.safeParse(ws).success).toBe(true);
    expect(WorkspaceFileSchema.parse(ws).projects[0]!.actions).toEqual([{ label: 'Tests', command: 'npm test' }]);
  });
});

describe('ordering', () => {
  it('siblings are folders and agents interleaved by sortKey, ties folders-first', () => {
    const ws = base();
    expect(ids(ws, null)).toEqual(['f1', 'f2', 'a3']);
    expect(ids(ws, 'f1')).toEqual(['f1a', 'a1', 'a2']);
    expect(nextSortKey(ws, 'f1')).toBe(3);
  });
  it('sortKeyBefore places between, first, or last', () => {
    const ws = base();
    expect(sortKeyBefore(ws, 'f1', 'a2', 'a1')).toBe(1); // between f1a(0) and a2(2), ignoring a1 itself
    expect(sortKeyBefore(ws, 'f1', 'f1a', 'a2')).toBe(-1);
    expect(sortKeyBefore(ws, 'f1', null, 'a1')).toBe(3);
    expect(() => sortKeyBefore(ws, 'f1', 'nope', 'a1')).toThrow(StoreError);
  });
  it('normalizeOrder renumbers a parent 0..n', () => {
    let ws = base();
    ws = moveAgent(ws, 'a2', 'f1', 'f1a');
    ws = moveAgent(ws, 'a1', 'f1', 'f1a');
    ws = normalizeOrder(ws, 'f1');
    expect(ids(ws, 'f1')).toEqual(['a2', 'a1', 'f1a']);
    expect(siblings(ws, 'f1').map((c) => (c.kind === 'folder' ? c.folder.sortKey : c.agent.sortKey))).toEqual([0, 1, 2]);
  });
  it('breaks an exact sortKey tie folders-before-agents, not by name or creation order', () => {
    const ws: WorkspaceFile = {
      ...emptyWorkspace(),
      folders: [{ id: 'fZ', name: 'Zeta', parentId: null, sortKey: 0, collapsed: false }],
      agents: [{ ...agent('early'), sortKey: 0, createdAt: '2000-01-01T00:00:00.000Z' }],
    };
    expect(ids(ws, null)).toEqual(['fZ', 'early']);
  });
  it('needsRenumber is false when every gap is healthy', () => {
    expect(needsRenumber(base(), 'f1')).toBe(false);
  });
});

describe('folders', () => {
  it('creates under an existing parent only, updates name/collapsed', () => {
    let ws = base();
    expect(() => createFolder(ws, { id: 'x', name: 'X', parentId: 'ghost' })).toThrow(StoreError);
    expect(() => createFolder(ws, { id: 'x', name: '   ', parentId: null })).toThrow(StoreError);
    ws = updateFolder(ws, 'f1', { name: 'Renamed', collapsed: true });
    expect(ws.folders.find((f) => f.id === 'f1')).toMatchObject({ name: 'Renamed', collapsed: true });
  });
  it('moves with cycle protection', () => {
    let ws = base();
    expect(() => moveFolder(ws, 'f1', 'f1a', null)).toThrow(/cycle/i);
    expect(() => moveFolder(ws, 'f1', 'f1', null)).toThrow(/cycle/i);
    ws = moveFolder(ws, 'f2', 'f1', 'a1');
    expect(ids(ws, 'f1')).toEqual(['f1a', 'f2', 'a1', 'a2']);
    // f1 STAYS at root: only f2 moved. Asserting `['a3']` here would be asserting that moving a
    // folder into another one also removes the destination from its own parent.
    expect(ids(ws, null)).toEqual(['f1', 'a3']);
  });
  it('deleting a folder re-parents its children', () => {
    const ws = deleteFolder(base(), 'f1');
    expect(ws.folders.map((f) => f.id)).toEqual(['f2', 'f1a']);
    expect(ws.folders.find((f) => f.id === 'f1a')!.parentId).toBeNull();
    expect(ws.agents.filter((a) => a.folderId === null).map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
  });
  it('deleting a folder preserves the interleaved order of its children, landing them in its old slot', () => {
    let ws = addProject(emptyWorkspace(), project('p1'));
    ws = createFolder(ws, { id: 'keep', name: 'Keep', parentId: null });
    ws = createAgent(ws, agent('rootAgent', null));
    ws = createFolder(ws, { id: 'doomed', name: 'Doomed', parentId: null });
    ws = createAgent(ws, agent('after', null)); // sits after `doomed`; must stay after the migrated block
    ws = createAgent(ws, agent('a1', 'doomed'));
    ws = createFolder(ws, { id: 'sub1', name: 'Sub1', parentId: 'doomed' });
    ws = createAgent(ws, agent('a2', 'doomed'));
    ws = createFolder(ws, { id: 'sub2', name: 'Sub2', parentId: 'doomed' });
    ws = createAgent(ws, agent('a3', 'doomed'));
    ws = deleteFolder(ws, 'doomed');
    // The old two-loop version floated every folder above every agent (an explicit interleaving
    // silently undone) and always appended at the end (`after` would have ended up before them).
    expect(ids(ws, null)).toEqual(['keep', 'rootAgent', 'a1', 'sub1', 'a2', 'sub2', 'a3', 'after']);
    const keys = siblings(ws, null).map((c) => (c.kind === 'folder' ? c.folder.sortKey : c.agent.sortKey));
    expect(new Set(keys).size).toBe(keys.length);
  });
  it.each([5, 30, 60, 200])('preserves order at scale for a deleted folder with %i children', (n) => {
    // A one-at-a-time `sortKeyBefore` insert against a fixed anchor halves the remaining float gap
    // on every child; past ~53 children in a single deleted folder that exhausts double precision and
    // `renumberIfNeeded` then bakes the wrong order into integers permanently. 60 is past that break;
    // 5/30 stay well below it, pinning the whole class rather than one instance.
    let ws = addProject(emptyWorkspace(), project('p1'));
    ws = createFolder(ws, { id: 'sibA', name: 'SibA', parentId: null });
    ws = createFolder(ws, { id: 'doomed', name: 'Doomed', parentId: null });
    ws = createFolder(ws, { id: 'sibB', name: 'SibB', parentId: null }); // the following sibling: must stay LAST
    const childIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const cid = `c${i}`;
      childIds.push(cid);
      ws = i % 2 === 0 ? createAgent(ws, agent(cid, 'doomed')) : createFolder(ws, { id: cid, name: cid, parentId: 'doomed' });
    }
    ws = deleteFolder(ws, 'doomed');
    expect(ids(ws, null)).toEqual(['sibA', ...childIds, 'sibB']);
    expect(ids(ws, null).at(-1)).toBe('sibB');
    const keys = siblings(ws, null).map((c) => (c.kind === 'folder' ? c.folder.sortKey : c.agent.sortKey));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cycle safety', () => {
  // WorkspaceFileSchema accepts a cyclic folder graph (repair is Task 7's job, not this pure file's);
  // a naive parent walk over one never terminates. The numeric timeouts below are NOT what makes
  // this safe: the walk is synchronous, so neither vitest's per-test timeout nor a `Promise.race`
  // could interrupt it — measured, removing the walk's own bound hangs the whole worker and it dies
  // to a SIGKILL, not a failing assertion. The real protection is `isDescendantFolder`'s own
  // `visited.size` bound, which guarantees these calls return in finite time regardless; the
  // timeouts are only a documented expectation that "finite" means "fast".
  const cyclic: WorkspaceFile = {
    ...emptyWorkspace(),
    folders: [
      { id: 'f1', name: 'F1', parentId: 'f2', sortKey: 0, collapsed: false },
      { id: 'f2', name: 'F2', parentId: 'f1', sortKey: 0, collapsed: false },
      { id: 'f3', name: 'F3', parentId: null, sortKey: 0, collapsed: false },
    ],
  };
  it('isDescendantFolder terminates instead of hanging on a cyclic folder graph', () => {
    expect(isDescendantFolder(cyclic, 'ghost', 'f1')).toBe(false);
  }, 1000);
  it('moveFolder terminates instead of hanging when the existing graph already contains a cycle', () => {
    expect(() => moveFolder(cyclic, 'f3', 'f1', null)).not.toThrow();
  }, 1000);
});

describe('layout schema repair', () => {
  it('repairs a junk arrangement or drawerTab instead of classing the file corrupt', () => {
    // `normalizeLayout` recomputes `arrangement` unconditionally from the pane count, so the
    // persisted value is never read — yet before `.catch()` was added, a junk value here failed the
    // whole schema (`success: false`), which `load()` classes as corrupt and replaces with an empty
    // workspace. `drawerTab` is cosmetic (which tab is selected) for the same reason.
    const raw = { ...emptyWorkspace(), layout: { ...emptyWorkspace().layout, arrangement: 'quad', drawerTab: 'history' } };
    const result = WorkspaceFileSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout.arrangement).toBe('single');
      expect(result.data.layout.drawerTab).toBe('notes');
    }
  });
});

describe('agents', () => {
  it('validates name, folder, project and branch uniqueness', () => {
    const ws = base();
    expect(() => createAgent(ws, { ...agent('a9'), name: '' })).toThrow(/name/);
    expect(() => createAgent(ws, agent('a9', 'ghost'))).toThrow(/folder/);
    expect(() => createAgent(ws, agent('a9', null, 'p-missing'))).toThrow(/project/);
    expect(() => createAgent(ws, agent('a9', null, 'p1', 'agent/a1'))).toThrow(/branch/i);
    expect(() => createAgent(ws, agent('a1'))).toThrow(/exists/);
    expect(() => createAgent(ws, { ...agent('a9'), workspaces: [] })).toThrow(/workspace/);
  });
  it("rejects self-collisions within one agent's own workspaces", () => {
    const ws = base();
    const w = (id: string, branch: string) => ({ id, projectId: 'p1', branch, worktreePath: `/wt/${id}`, baseRef: 'origin/main', createdAt: 'x' });
    expect(() => createAgent(ws, { ...agent('a9'), workspaces: [w('w-a9', 'shared'), w('w-a9b', 'shared')] })).toThrow(/branch/i);
    expect(() => createAgent(ws, { ...agent('a9'), workspaces: [w('dup', 'b1'), w('dup', 'b2')] })).toThrow(/workspace id/i);
  });
  it('updates fields including partial claude config', () => {
    let ws = base();
    ws = updateAgent(ws, 'a1', { name: 'Fix it', notes: 'n', claude: { hasStartedOnce: true }, lastOpenedAt: '2026-09-07T01:00:00.000Z' });
    const a = ws.agents.find((x) => x.id === 'a1')!;
    expect(a).toMatchObject({ name: 'Fix it', notes: 'n', lastOpenedAt: '2026-09-07T01:00:00.000Z' });
    expect(a.claude).toEqual({ sessionId: 's-a1', hasStartedOnce: true, permissionMode: null, extraArgs: [] });
    expect(() => updateAgent(ws, 'a1', { name: 'x'.repeat(81) })).toThrow(StoreError);
  });
  it('scopes branch uniqueness per project, not globally', () => {
    // `base()` has only one project, so nothing in the existing suite proves `clash` compares
    // `projectId` at all — the same branch name in a different project must be allowed.
    let ws = addProject(emptyWorkspace(), project('p1'));
    ws = addProject(ws, { ...project('p2'), repoPath: '/repos/p2' });
    ws = createAgent(ws, agent('a1', null, 'p1', 'shared-name'));
    expect(() => createAgent(ws, agent('a2', null, 'p2', 'shared-name'))).not.toThrow();
  });
  it('clears lastOpenedAt to null when explicitly passed null, not merely left out', () => {
    // `patch.lastOpenedAt !== undefined ? patch.lastOpenedAt : a.lastOpenedAt` is not the same as
    // `patch.lastOpenedAt ?? a.lastOpenedAt`: the latter would treat an explicit `null` the same as
    // "not provided" and silently keep the old value.
    let ws = base();
    ws = updateAgent(ws, 'a1', { lastOpenedAt: '2026-09-07T01:00:00.000Z' });
    ws = updateAgent(ws, 'a1', { lastOpenedAt: null });
    expect(ws.agents.find((a) => a.id === 'a1')!.lastOpenedAt).toBeNull();
  });
  it('moves between folders and deletes (also clearing layout panes)', () => {
    let ws = base();
    ws = moveAgent(ws, 'a3', 'f2', null);
    expect(ids(ws, 'f2')).toEqual(['a3']);
    ws = setLayout(ws, { ...ws.layout, panes: ['a3', 'ghost'] });
    expect(ws.layout.panes).toEqual(['a3', null]);
    ws = deleteAgent(ws, 'a3');
    expect(ws.agents.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(ws.layout.panes).toEqual([null, null]);
  });
});
