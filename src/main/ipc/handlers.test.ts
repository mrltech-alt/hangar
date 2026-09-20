import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { DICTATION_IDLE, dictationMessage, type DictationOutcome, type DictationState } from '../../../shared/dictation.ts';
import type { ClientMessage } from '../../../shared/host-protocol.ts';
import {
  IPC_REQUEST_KEYS, LINEAR_CREATE_UNCONFIRMED, type ChangeSet, type DeleteAgentOptions, type DeleteInspection, type FileDiff, type IpcEvents,
} from '../../../shared/ipc-contract.ts';
import { IpcSchemas } from '../../../shared/ipc-schemas.ts';
import { defaultAppConfig, defaultProjectSetup, initialSessionState, type Agent, type Project, type SessionState } from '../../../shared/types.ts';
import { manualDraft } from '../../../shared/linear-draft.ts';
import { TICKET_DESCRIPTION_MAX } from '../../../shared/linear-issues.ts';
import { createConfigStore } from '../services/config-store.ts';
import { DictationServiceError, createDictationService, type DictationService, type DictationUpdate } from '../services/dictation.ts';
import { LINEAR_MESSAGES, LinearError, type LinearTool } from '../services/linear-mcp.ts';
import { TriageError } from '../services/linear-triage.ts';
import { getPaths } from '../services/paths.ts';
import { createWorkspaceStore } from '../services/workspace-store.ts';
import { toIpcError } from './errors.ts';
import { createHandlers, type HandlerDeps, type Handlers } from './handlers.ts';
import { StoreError } from '../services/workspace-ops.ts';
import { freeBytes } from '../util/disk.ts';
import type { ExecOptions } from '../util/exec.ts';

/**
 * The env the fixture hands `createHandlers`. It is asserted by value below: the point of
 * `HandlerDeps.env` is that `fs:list`'s `git check-ignore` runs under the SAME environment as
 * `GitService`, rather than under whatever `process.env` happens to hold, and only an assertion on
 * the object that actually reached `exec` can tell those two apart.
 */
const TEST_ENV: Record<string, string> = { PATH: '/fixture/bin', HOME: '/fixture/home' };

const MERGE_BASE = 'a'.repeat(40);

function projectFixture(id: string, repoPath: string, defaultBranch: string): Project {
  return { id, name: id, repoPath, defaultBranch, setup: defaultProjectSetup(), claudeArgs: [], createdAt: '2026-09-08T00:00:00.000Z' };
}

/** A minimal persisted agent. Injected straight into the store: `createAgent` would also need a project. */
function agentFixture(id: string, workspaceId: string, worktreePath: string, projectId = 'p1'): Agent {
  return {
    id, name: id, slug: id, folderId: null, sortKey: 1, notes: '',
    workspaces: [{ id: workspaceId, projectId, branch: `hangar/${id}`, worktreePath, baseRef: 'main', createdAt: '2026-09-08T00:00:00.000Z' }],
    claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
    createdAt: '2026-09-08T00:00:00.000Z', lastOpenedAt: null,
  };
}

/** What the fake `DiffService` was asked for, so a test can assert WHERE each argument came from. */
interface DiffCall {
  method: 'mergeBaseFor' | 'changes' | 'fileDiff';
  args: string[];
}

/** One `emit` call, as `index.ts`'s queued emitter would have received it. */
interface Emitted {
  event: keyof IpcEvents;
  payload: unknown;
}

/**
 * A dictation service the test drives by hand. It keeps the real service's contract where the
 * handlers depend on it: `start()` reports the run's FIRST update synchronously, before it returns
 * the id (the real one dispatches `start` inside `start()`), and refuses with `DICTATION_BUSY` while
 * a run has not ended. Everything after that first update is `report`ed by the test.
 */
interface FakeDictation {
  create: HandlerDeps['createDictation'];
  /** Hands the handlers an update, exactly as the service's `onUpdate` would. */
  report: (update: DictationUpdate) => void;
  /** The id `start()` handed out last (0 before the first). */
  lastRun: () => number;
  calls: ('start' | 'stop' | 'cancel')[];
}

function fakeDictation(): FakeDictation {
  let onUpdate: ((u: DictationUpdate) => void) | null = null;
  let runId = 0;
  let active = false;
  const calls: FakeDictation['calls'] = [];
  const service: DictationService = {
    start: () => {
      if (active) throw new DictationServiceError('DICTATION_BUSY', 'Dictation is still running. Wait for it to finish.');
      runId += 1;
      active = true;
      calls.push('start');
      onUpdate!({ runId, state: { phase: 'starting' }, outcome: null });
      return runId;
    },
    stop: () => {
      calls.push('stop');
      return true;
    },
    cancel: () => {
      calls.push('cancel');
      return true;
    },
    state: () => DICTATION_IDLE,
    busy: () => active,
    reaped: async () => {},
    dispose: async () => {},
  };
  return {
    calls,
    lastRun: () => runId,
    create: (cb) => {
      onUpdate = cb;
      return service;
    },
    report: (update) => {
      if (update.outcome !== null) active = false;
      onUpdate!(update);
    },
  };
}

function deps(): {
  deps: HandlerDeps;
  clipboard: string[];
  revealed: string[];
  connected: { value: boolean };
  execCalls: { file: string; args: string[]; opts: ExecOptions | undefined }[];
  diffCalls: DiffCall[];
  /** Every message handed to the host, in order — `session:write`'s and dictation's writes land here. */
  sent: ClientMessage[];
  emitted: Emitted[];
  warnings: string[];
  dictation: FakeDictation;
  /** Every listener `onSessionState` was given — the registry's broadcasts, as the test fires them. */
  sessionListeners: ((agentId: string, state: SessionState) => void)[];
} {
  const dir = tempDir('handlers');
  const store = createWorkspaceStore({ file: join(dir, 'w.json'), bakFile: join(dir, 'w.bak'), debounceMs: 10 });
  store.load();
  const clipboard: string[] = [];
  const revealed: string[] = [];
  const connected = { value: false };
  const execCalls: { file: string; args: string[]; opts: ExecOptions | undefined }[] = [];
  const diffCalls: DiffCall[] = [];
  const sent: ClientMessage[] = [];
  const emitted: Emitted[] = [];
  const warnings: string[] = [];
  const dictation = fakeDictation();
  const sessionListeners: ((agentId: string, state: SessionState) => void)[] = [];
  const emptyChangeSet: ChangeSet = { mergeBase: MERGE_BASE, aheadCommits: 0, stats: { insertions: 0, deletions: 0 }, files: [] };
  const emptyFileDiff: FileDiff = { oldText: '', newText: '', oldMissing: false, newMissing: false, binary: false, tooLarge: false };
  const deps: HandlerDeps = {
    store,
    // The two deps these handlers never call themselves (`agents` and `git` are reached only
    // through the pass-through handlers — and `diff`, which they DO call, is a real typed fake just
    // below). Everything else here is fully typed: the blanket `as unknown as HandlerDeps` this
    // fixture used to end with was hiding four real gaps — `registry.dispose`,
    // `config.flush`/`lastWriteError` and `shellEnv.reason` — none of which vitest can see, because
    // it does not typecheck.
    agents: {} as HandlerDeps['agents'],
    registry: { get: (id: string) => initialSessionState(id), all: () => ({}), apply: () => initialSessionState('x'), setWindowFocused: () => {}, isWindowFocused: () => true, resetFromHello: () => {}, tick: () => {}, dispose: () => {} },
    hostClient: { isConnected: () => connected.value, request: async () => ({ t: 'ok' as const }), send: (m) => { sent.push(m); }, on: () => () => {}, connect: async () => ({ version: 1, hostPid: 1, sessions: [] }), close: () => {} },
    git: {} as HandlerDeps['git'],
    // Real paths, not `{} as HangarPaths`: `app:diskFree` reads `paths.worktreesDir`, and the cast
    // this replaced would have handed `freeBytes` an `undefined` path.
    paths: getPaths(dir),
    // NOT a cast: `diff` IS called by two of the handlers, so a `{} as DiffService` would throw at
    // the first property access and hide which arguments the handler chose. This fake records the
    // three strings each call was given, which is the whole point — the tests below assert that
    // `repoPath`, `worktreePath` and `defaultBranch` came from the STORE and not from the payload.
    diff: {
      mergeBaseFor: async (repoPath, worktree, defaultBranch) => {
        diffCalls.push({ method: 'mergeBaseFor', args: [repoPath, worktree, defaultBranch] });
        return MERGE_BASE;
      },
      changes: async (repoPath, worktree, defaultBranch) => {
        diffCalls.push({ method: 'changes', args: [repoPath, worktree, defaultBranch] });
        return emptyChangeSet;
      },
      fileDiff: async (worktree, mergeBase, relPath) => {
        diffCalls.push({ method: 'fileDiff', args: [worktree, mergeBase, relPath] });
        return emptyFileDiff;
      },
    },
    config: { get: () => defaultAppConfig('/bin/zsh'), set: (p: object) => ({ ...defaultAppConfig('/bin/zsh'), ...p }), flush: () => true, lastWriteError: () => null, problems: () => [] },
    bridge: { pickFolder: async () => '/picked', showItemInFolder: (p: string) => { revealed.push(p); }, writeClipboard: (t: string) => { clipboard.push(t); } },
    exec: async (file, args, opts) => {
      execCalls.push({ file, args, opts });
      return { stdout: '', stderr: '', code: 0 };
    },
    env: TEST_ENV,
    shellEnv: () => ({ path: '/usr/bin', nodeBin: null, claudeBin: null, claudeVersion: null, shell: '/bin/zsh', source: 'fallback' as const, reason: null }),
    snapshot: () => ({ workspace: store.get(), sessions: {}, runtime: {}, host: { connected: false, version: null, sessions: 0, socketPath: '', nodeBin: null, lastError: null }, profile: { home: dir, isDefault: false } }),
    hostStatus: () => ({ connected: false, version: null, sessions: 0, socketPath: '', nodeBin: null, lastError: null }),
    restartHost: async () => {},
    // Replaced per test where it matters; the default refuses loudly so a handler that reached it by
    // accident is visible.
    triage: { run: async () => { throw new Error('triage not stubbed'); }, cancel: () => {}, cancelAll: () => {} },
    ticketDraft: { draft: async () => { throw new Error('ticketDraft not stubbed'); }, cancel: () => {}, cancelAll: () => {} },
    linear: { call: async () => { throw new Error('linear not stubbed'); } },
    createDictation: dictation.create,
    onSessionState: (listener) => { sessionListeners.push(listener); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
    log: { info: () => {}, warn: (l) => { warnings.push(l); }, error: () => {}, close: () => {} },
  };
  return { deps, clipboard, revealed, connected, execCalls, diffCalls, sent, emitted, warnings, dictation, sessionListeners };
}

describe('createHandlers', () => {
  // A tsc-backed invariant more than a runtime one: the returned object literal is static and the
  // `Handlers` mapped type already forces exactly these keys, so this cannot fail while `tsc` passes.
  // Kept as the cheap check that the two key lists are the same list; the tests below are the ones
  // that exercise behaviour.
  it('implements every request key', () => {
    const h = createHandlers(deps().deps);
    for (const key of IPC_REQUEST_KEYS) expect(typeof h[key]).toBe('function');
  });
  it('folder and layout handlers go through the store', async () => {
    const d = deps();
    const h = createHandlers(d.deps);
    const folder = await h['folder:create']({ name: 'Ac', parentId: null });
    expect(folder.name).toBe('Ac');
    await h['folder:update']({ id: folder.id, patch: { collapsed: true } });
    expect(d.deps.store.get().folders[0]!.collapsed).toBe(true);
    await h['layout:set']({ ...d.deps.store.get().layout, sidebarWidth: 300 });
    expect(d.deps.store.get().layout.sidebarWidth).toBe(300);
    expect((await h['workspace:get'](undefined)).workspace.folders.length).toBe(1);
  });
  /**
   * All three layers of `config:set` in one test, because they drifted apart in shipped code:
   * `ConfigStore.set` was widened to take a partial `terminal` (what a settings UI sends when the
   * user moves one slider), the contract and the zod schema were not, and this handler — typed by
   * the contract — could no longer express the patch the service documents. The call below is the
   * compile-time half; the assertions are the runtime half.
   */
  it('config:set accepts the partial terminal patch a settings UI sends', async () => {
    const d = deps();
    const config = createConfigStore(join(tempDir('handlers-cfg'), 'config.json'), '/bin/zsh');
    const h = createHandlers({ ...d.deps, config });
    const after = await h['config:set']({ terminal: { fontSize: 14 } });
    expect(after.terminal).toEqual({ ...defaultAppConfig('/bin/zsh').terminal, fontSize: 14 });
    expect(IpcSchemas['config:set'].safeParse({ terminal: { fontSize: 14 } }).success).toBe(true);
  });

  it('session:attach refuses when the host is down; clipboard uses the bridge', async () => {
    const d = deps();
    const h = createHandlers(d.deps);
    await expect(h['session:attach']({ agentId: 'a', paneIndex: 0, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'HOST_DOWN' });
    await h['app:copyToClipboard']({ text: 'hi' });
    expect(d.clipboard).toEqual(['hi']);
    expect(await h['app:pickFolder'](undefined)).toBe('/picked');
  });

  it('app:pickFolder hands an optional title to the bridge', async () => {
    const d = deps();
    const titles: (string | undefined)[] = [];
    const h = createHandlers({ ...d.deps, bridge: { ...d.deps.bridge, pickFolder: async (title) => { titles.push(title); return '/picked'; } } });
    expect(await h['app:pickFolder']({ title: 'Choose your repos folder' })).toBe('/picked');
    expect(await h['app:pickFolder'](undefined)).toBe('/picked');
    expect(titles).toEqual(['Choose your repos folder', undefined]);
  });

  it('linear:triage and linear:cancel route to the triage service by request id', async () => {
    const d = deps();
    const seen: string[] = [];
    const draft = manualDraft('AC-3461');
    const h = createHandlers({
      ...d.deps,
      triage: {
        run: async (requestId, ref) => { seen.push(`run ${requestId} ${ref}`); return draft; },
        cancel: (requestId) => { seen.push(`cancel ${requestId}`); },
        cancelAll: () => {},
      },
    });
    expect(await h['linear:triage']({ requestId: 'r1', ref: 'AC-3461' })).toBe(draft);
    await expect(h['linear:cancel']({ requestId: 'r1' })).resolves.toBeUndefined();
    expect(seen).toEqual(['run r1 AC-3461', 'cancel r1']);
  });

  /**
   * Spec §8: a cancelled look-up shows NOTHING, every other failure shows its message and hint. The
   * renderer can only tell them apart by `code`, so the handler must let the service's `TriageError`
   * reach `toIpcError` (what `register.ts` replies with) untouched — not wrap or re-code it.
   */
  it('linear:triage passes the TriageError code and detail through to the IPC reply unchanged', async () => {
    const d = deps();
    const cases: [TriageError, ReturnType<typeof toIpcError>][] = [
      [new TriageError('CANCELLED', 'The look-up was cancelled.'), { code: 'CANCELLED', message: 'The look-up was cancelled.' }],
      [new TriageError('BUSY', 'A look-up with id r1 is already running.'), { code: 'BUSY', message: 'A look-up with id r1 is already running.' }],
      [
        new TriageError('TRIAGE_FAILED', "Couldn't read the ticket: nope", 'Is Linear connected? Check with: claude mcp list'),
        { code: 'TRIAGE_FAILED', message: "Couldn't read the ticket: nope", detail: 'Is Linear connected? Check with: claude mcp list' },
      ],
    ];
    for (const [error, expected] of cases) {
      const h = createHandlers({ ...d.deps, triage: { run: async () => { throw error; }, cancel: () => {}, cancelAll: () => {} } });
      const caught = await h['linear:triage']({ requestId: 'r1', ref: 'AC-3461' }).catch((e: unknown) => e);
      expect(caught).toBe(error);
      expect(toIpcError(caught)).toEqual(expected);
    }
  });

  it('agent:inspectRemoveWorkspace and agent:removeWorkspace pass the workspace id and the options through', async () => {
    const d = deps();
    const seen: unknown[] = [];
    const inspection: DeleteInspection = { workspaces: [] };
    const agents = {
      inspectRemoveWorkspace: async (id: string, workspaceId: string) => { seen.push(['inspect', id, workspaceId]); return inspection; },
      removeWorkspace: async (id: string, workspaceId: string, options: DeleteAgentOptions) => { seen.push(['remove', id, workspaceId, options]); },
    } as HandlerDeps['agents'];
    const h = createHandlers({ ...d.deps, agents });
    expect(await h['agent:inspectRemoveWorkspace']({ id: 'a1', workspaceId: 'w2' })).toBe(inspection);
    await h['agent:removeWorkspace']({ id: 'a1', workspaceId: 'w2', options: { removeWorktrees: true, deleteBranches: false, force: true } });
    expect(seen).toEqual([['inspect', 'a1', 'w2'], ['remove', 'a1', 'w2', { removeWorktrees: true, deleteBranches: false, force: true }]]);
  });

  /**
   * §12.8's free-space figure. The number itself is whatever the machine has, so what this pins is
   * the CHOICE of volume: `worktreesDir`, the same path `agent-service.create`'s 2 GB preflight
   * measures. On a one-volume machine every path returns the same bytes, so `path` is the only
   * thing that can distinguish "measured the right filesystem" from "measured a filesystem" — and
   * it is what the status bar puts in its tooltip.
   *
   * `worktreesDir` does not exist here (`getPaths` creates nothing), which is deliberate: it is
   * also the state on a profile whose first agent has not been created yet, and `freeBytes` walks
   * up to an existing ancestor rather than throwing.
   */
  it('app:diskFree measures the worktrees volume, not the process cwd, and answers before the dir exists', async () => {
    const d = deps();
    const h = createHandlers(d.deps);
    expect(existsSync(d.deps.paths.worktreesDir)).toBe(false);
    const r = await h['app:diskFree'](undefined);
    expect(r.path).toBe(d.deps.paths.worktreesDir);
    expect(r.freeBytes).toBeGreaterThan(0);
    // Within a block of what the ancestor reports: a walk to the WRONG volume would be off by
    // orders of magnitude, while two `statfs` calls on a live volume routinely differ by one block.
    expect(Math.abs(r.freeBytes - freeBytes(d.deps.paths.home))).toBeLessThan(64 * 1024 * 1024);
  });

  it('app:openExternal checks the agent/workspace PAIRING, not each id separately', async () => {
    const d = deps();
    d.deps.store.update((ws) => ({ ...ws, agents: [agentFixture('a1', 'w1', '/wt/one'), agentFixture('a2', 'w2', '/wt/two')] }));
    const h = createHandlers(d.deps);

    await h['app:openExternal']({ agentId: 'a1', workspaceId: 'w1', target: 'finder' });
    expect(d.revealed).toEqual(['/wt/one']);

    // Both ids exist, but not together — checking them independently would have opened a1's worktree
    // for a workspace belonging to a2. This is the only authorization gate in the file.
    await expect(h['app:openExternal']({ agentId: 'a1', workspaceId: 'w2', target: 'finder' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h['app:openExternal']({ agentId: 'nope', workspaceId: 'w1', target: 'finder' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(d.revealed).toEqual(['/wt/one']);
  });

  it('session handlers reject a stale agentId and refuse to drop input while the host is down', async () => {
    const d = deps();
    d.deps.store.update((ws) => ({ ...ws, agents: [agentFixture('a1', 'w1', '/wt/one')] }));
    const h = createHandlers(d.deps);

    // Host down: write and resize used to resolve while the keystroke went nowhere.
    await expect(h['session:write']({ agentId: 'a1', data: 'x' })).rejects.toMatchObject({ code: 'HOST_DOWN' });
    await expect(h['session:resize']({ agentId: 'a1', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'HOST_DOWN' });

    d.connected.value = true;
    // Host up, agent gone (§10.5 orphan): NOT_FOUND rather than a silent attach to a session we no
    // longer model, which painted one snapshot and then never received another byte.
    for (const call of [
      h['session:attach']({ agentId: 'ghost', paneIndex: 0, cols: 80, rows: 24 }),
      h['session:write']({ agentId: 'ghost', data: 'rm -rf ~\r' }),
      h['session:resize']({ agentId: 'ghost', cols: 80, rows: 24 }),
      h['session:detach']({ agentId: 'ghost' }),
      h['agent:markViewed']({ id: 'ghost' }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    // detach deliberately does NOT require the host: it is implicit cleanup when a pane closes.
    d.connected.value = false;
    await expect(h['session:detach']({ agentId: 'a1' })).resolves.toBeUndefined();
  });
});

/** One fake Linear transport that records what it was asked for and answers from a queue. */
function fakeLinear(replies: string[]): { call: HandlerDeps['linear']['call']; calls: { tool: LinearTool; args: Record<string, unknown> }[] } {
  const calls: { tool: LinearTool; args: Record<string, unknown> }[] = [];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      const next = replies.shift();
      if (next === undefined) throw new Error(`no reply queued for ${tool}`);
      return next;
    },
  };
}

/**
 * A Linear transport whose answers are released BY HAND, so two handler calls can be interleaved.
 * `answer(n, text)` settles the nth call in the order the calls were made.
 */
function gatedLinear(): {
  call: HandlerDeps['linear']['call'];
  calls: { tool: LinearTool; args: Record<string, unknown> }[];
  answer: (index: number, text: string) => void;
} {
  const calls: { tool: LinearTool; args: Record<string, unknown> }[] = [];
  const gates: ((text: string) => void)[] = [];
  return {
    calls,
    call: (tool, args) => {
      calls.push({ tool, args });
      return new Promise<string>((resolve) => { gates.push(resolve); });
    },
    answer: (index, text) => { gates[index]!(text); },
  };
}

/** Let every pending microtask (and so every handler waiting on a settled answer) run. */
const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** One issue on team `tu1` in cycle `cy-1`, which is the row `list_cycles` gives a number to. */
const CYCLE_PAGE = JSON.stringify({
  issues: [{ id: 'AC-1', title: 'a', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 'tu1', cycleId: 'cy-1', updatedAt: '2026-09-16T10:00:00.000Z' }],
  hasNextPage: false, cursor: null,
});
const CYCLES = JSON.stringify([{ id: 'cy-1', number: 32, isCurrent: true }]);

const page = (ids: string[], cursor: string | null): string => JSON.stringify({
  issues: ids.map((id) => ({ id, title: id, status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 'tu1', updatedAt: '2026-09-16T10:00:00.000Z' })),
  hasNextPage: cursor !== null,
  cursor,
});

describe('linear:myIssues (Plan 07)', () => {
  it('asks for everything assigned to the owner and caches it for the app run', async () => {
    const d = deps();
    const linear = fakeLinear([page(['AC-1', 'AC-2'], 'c2')]);
    const h = createHandlers({ ...d.deps, linear });

    const first = await h['linear:myIssues']({});
    expect(first.issues.map((i) => i.identifier)).toEqual(['AC-1', 'AC-2']);
    // Stamped with the cache generation it belongs to; the renderer hands it back unread.
    expect(first.nextCursor).toBe('0:c2');
    // Second open of the dialog: the same answer, and NOT a second request — §2's rule is that
    // nothing happens that the owner did not press, and this is the call that would otherwise repeat.
    expect(await h['linear:myIssues']({})).toEqual(first);
    expect(linear.calls).toEqual([{ tool: 'list_issues', args: { assignee: 'me', orderBy: 'updatedAt', limit: 50 } }]);
  });

  it('appends a page for a cursor and re-fetches from scratch for a refresh', async () => {
    const d = deps();
    const linear = fakeLinear([page(['AC-1'], 'c2'), page(['AC-1', 'AC-2'], null), page(['AC-9'], null)]);
    const h = createHandlers({ ...d.deps, linear });

    const first = await h['linear:myIssues']({});
    const more = await h['linear:myIssues']({ cursor: first.nextCursor! });
    // The whole list, with the ticket that appeared on both pages counted once.
    expect(more.issues.map((i) => i.identifier)).toEqual(['AC-1', 'AC-2']);
    expect(more.nextCursor).toBeNull();

    const refreshed = await h['linear:myIssues']({ refresh: true });
    expect(refreshed.issues.map((i) => i.identifier)).toEqual(['AC-9']);
    expect(linear.calls.map((c) => c.args.cursor)).toEqual([undefined, 'c2', undefined]);
  });

  it('resolves cycle numbers through list_cycles, once per team, and survives that call failing', async () => {
    const d = deps();
    // A bare array, which is what `list_cycles` really answers with.
    const linear = fakeLinear([CYCLE_PAGE, CYCLES, CYCLE_PAGE]);
    const h = createHandlers({ ...d.deps, linear });
    expect((await h['linear:myIssues']({})).issues[0]?.cycleNumber).toBe(32);
    // A later PAGE for the same team asks `list_cycles` nothing further.
    expect((await h['linear:myIssues']({ cursor: '0:c2' })).issues[0]?.cycleNumber).toBe(32);
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_issues', 'list_cycles', 'list_issues']);
    expect(linear.calls[1]?.args).toEqual({ teamId: 'tu1' });

    // And when `list_cycles` refuses, the list still arrives — just without the cycle on the row.
    const d2 = deps();
    const h2 = createHandlers({
      ...d2.deps,
      linear: { call: async (tool) => { if (tool === 'list_cycles') throw new LinearError('LINEAR_FAILED', 'nope'); return CYCLE_PAGE; } },
    });
    expect((await h2['linear:myIssues']({})).issues[0]?.cycleNumber).toBeNull();
  });

  /**
   * The mutant this kills: dropping the memo, or keying it off a flag set before the await. A team
   * whose `list_cycles` refused must not be asked again — the answer would be the same refusal, once
   * per page and per open — and a row whose `teamId` did not parse must not be asked about at all,
   * because `{ teamId: '' }` is a request that can only be refused.
   */
  it('asks a failing team for cycles only once, and never asks for a row with no team', async () => {
    const d = deps();
    const noTeam = JSON.stringify({
      issues: [{ id: 'AC-5', title: 'a', status: 'Todo', statusType: 'unstarted', team: '', teamId: '', cycleId: 'cy-9', updatedAt: '2026-09-16T10:00:00.000Z' }],
      hasNextPage: false, cursor: null,
    });
    const calls: LinearTool[] = [];
    const pages = [CYCLE_PAGE, CYCLE_PAGE, noTeam];
    const h = createHandlers({
      ...d.deps,
      linear: {
        call: async (tool) => {
          calls.push(tool);
          if (tool === 'list_cycles') throw new LinearError('LINEAR_FAILED', 'nope');
          return pages.shift() ?? CYCLE_PAGE;
        },
      },
    });
    await h['linear:myIssues']({});
    await h['linear:myIssues']({ cursor: '0:c2' });
    await h['linear:myIssues']({ cursor: '0:c3' });
    expect(calls.filter((t) => t === 'list_cycles')).toEqual(['list_cycles']);
  });

  /**
   * Two dialogs opening at once. The guard this replaced was a `Set.add` BEFORE the await, so the
   * second caller saw the team as already fetched, waited for nothing, and answered `null` while the
   * first answered `32` — two callers disagreeing about the same ticket.
   */
  it('makes two simultaneous opens share one list_cycles read and agree about the cycle', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const first = h['linear:myIssues']({});
    const second = h['linear:myIssues']({});
    linear.answer(0, CYCLE_PAGE);
    await settle();
    linear.answer(1, CYCLE_PAGE);
    await settle();
    // Call 2 is the ONE `list_cycles`; the second caller is waiting on the first caller's read.
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_issues', 'list_issues', 'list_cycles']);
    linear.answer(2, CYCLES);
    expect((await first).issues[0]?.cycleNumber).toBe(32);
    expect((await second).issues[0]?.cycleNumber).toBe(32);
  });

  /** A refresh is the owner asking for the current truth, so a cycle created mid-run resolves. */
  it('re-reads the cycles after a refresh', async () => {
    const d = deps();
    const linear = fakeLinear([CYCLE_PAGE, '[]', CYCLE_PAGE, CYCLES]);
    const h = createHandlers({ ...d.deps, linear });
    expect((await h['linear:myIssues']({})).issues[0]?.cycleNumber).toBeNull();
    expect((await h['linear:myIssues']({ refresh: true })).issues[0]?.cycleNumber).toBe(32);
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_issues', 'list_cycles', 'list_issues', 'list_cycles']);
  });

  /** §6: a dead token is the failure the owner must see, so it is not swallowed with the cycles. */
  it('surfaces a LINEAR_REAUTH from list_cycles, and lets a reconnect fix it', async () => {
    const d = deps();
    let reconnected = false;
    const h = createHandlers({
      ...d.deps,
      linear: {
        call: async (tool) => {
          if (tool !== 'list_cycles') return CYCLE_PAGE;
          if (!reconnected) throw new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH);
          return CYCLES;
        },
      },
    });
    expect(toIpcError(await h['linear:myIssues']({}).catch((e: unknown) => e))).toEqual({ code: 'LINEAR_REAUTH', message: LINEAR_MESSAGES.LINEAR_REAUTH });
    reconnected = true;
    expect((await h['linear:myIssues']({})).issues[0]?.cycleNumber).toBe(32);
  });

  /**
   * `Load more` and `Refresh` in flight together. The page that lands second used to be MERGED into
   * the refreshed list, so the owner saw a fresh first page with a stale second one under it, and
   * `nextCursor` came from the chain the refresh had already abandoned.
   */
  it('discards a page the owner refreshed out from under, and keeps the fresh chain', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const opened = h['linear:myIssues']({});
    linear.answer(0, page(['OLD-1'], 'c2'));
    expect((await opened).issues.map((i) => i.identifier)).toEqual(['OLD-1']);

    const more = h['linear:myIssues']({ cursor: (await opened).nextCursor! });
    const refreshed = h['linear:myIssues']({ refresh: true });
    linear.answer(1, page(['STALE-2'], 'c3-stale'));
    // The superseded page is dropped and the caller gets the cache as it stands — the list the owner
    // is still looking at — rather than an empty one that would read as "nothing assigned to you".
    expect((await more).issues.map((i) => i.identifier)).toEqual(['OLD-1']);
    linear.answer(2, page(['FRESH-1'], null));
    expect((await refreshed).issues.map((i) => i.identifier)).toEqual(['FRESH-1']);
    // Nothing of the stale page survived: not the row, and not its cursor.
    expect(await h['linear:myIssues']({})).toEqual({ issues: [{ ...(await refreshed).issues[0]! }], nextCursor: null });
  });

  /** Both fields pass the schema together, and the handler is what decides which one wins. */
  it('ignores a cursor sent with a refresh instead of collapsing the list to that page', async () => {
    const d = deps();
    expect(IpcSchemas['linear:myIssues'].safeParse({ refresh: true, cursor: 'c2' }).success).toBe(true);
    const linear = fakeLinear([page(['AC-1'], 'c2'), page(['AC-9'], null)]);
    const h = createHandlers({ ...d.deps, linear });
    await h['linear:myIssues']({});
    const after = await h['linear:myIssues']({ refresh: true, cursor: 'c2' });
    expect(after.issues.map((i) => i.identifier)).toEqual(['AC-9']);
    expect(linear.calls.map((c) => c.args.cursor)).toEqual([undefined, undefined]);
  });

  /**
   * The other order, and the one a generation captured at REQUEST time could not see: the refresh
   * lands first, and the owner then presses a `Load more` button still showing the old list. That
   * cursor names a page of the chain the refresh abandoned — fetching it cached `FRESH-1, STALE-2`
   * and handed back the old chain's cursor, so every later `Load more` paged the old list.
   */
  it('ignores a Load more whose cursor predates a refresh, without asking Linear for it', async () => {
    const d = deps();
    const linear = fakeLinear([page(['OLD-1'], 'c2'), page(['FRESH-1'], 'c9')]);
    const h = createHandlers({ ...d.deps, linear });
    const stale = (await h['linear:myIssues']({})).nextCursor!;
    const refreshed = await h['linear:myIssues']({ refresh: true });
    expect(refreshed.issues.map((i) => i.identifier)).toEqual(['FRESH-1']);

    const paged = await h['linear:myIssues']({ cursor: stale });
    expect(paged).toEqual(refreshed);
    // Two requests, not three: the stale cursor never reached Linear at all.
    expect(linear.calls.map((c) => c.args.cursor)).toEqual([undefined, undefined]);
    // And what it was answered with carries the FRESH chain's cursor, so the button corrects itself.
    expect(paged.nextCursor).toBe('1:c9');
  });

  /** A cursor this process did not stamp cannot page anything — it is ignored, not fetched. */
  it('ignores a cursor it did not stamp', async () => {
    const d = deps();
    const linear = fakeLinear([page(['AC-1'], 'c2')]);
    const h = createHandlers({ ...d.deps, linear });
    const opened = await h['linear:myIssues']({});
    for (const cursor of ['c2', ':c2', 'x:c2', '0:', '99:c2', '0000000009:c2']) {
      expect(await h['linear:myIssues']({ cursor })).toEqual(opened);
    }
    expect(linear.calls).toHaveLength(1);
  });

  /** §4's list failure is a line above the list, so a refresh that fails must not empty the list. */
  it('keeps the previous list when a refresh fails', async () => {
    const d = deps();
    let calls = 0;
    let failing = false;
    const h = createHandlers({
      ...d.deps,
      linear: {
        call: async () => {
          calls += 1;
          if (failing) throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
          return page(['AC-1'], null);
        },
      },
    });
    const opened = await h['linear:myIssues']({});
    failing = true;
    expect(toIpcError(await h['linear:myIssues']({ refresh: true }).catch((e: unknown) => e)).code).toBe('LINEAR_TIMEOUT');
    failing = false;
    expect(await h['linear:myIssues']({})).toEqual(opened);
    // Two requests: the open and the failed refresh. The answer above came from the cache the failed
    // refresh left exactly as it was.
    expect(calls).toBe(2);
  });

  it('caches nothing when the call fails, and passes the LinearError code through', async () => {
    const d = deps();
    const error = new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH);
    let calls = 0;
    const h = createHandlers({
      ...d.deps,
      linear: {
        call: async () => {
          calls += 1;
          if (calls === 1) throw error;
          return page(['AC-1'], null);
        },
      },
    });
    expect(toIpcError(await h['linear:myIssues']({}).catch((e: unknown) => e))).toEqual({ code: 'LINEAR_REAUTH', message: LINEAR_MESSAGES.LINEAR_REAUTH });
    expect((await h['linear:myIssues']({})).issues.map((i) => i.identifier)).toEqual(['AC-1']);
  });
});

describe('linear:teams (Plan 07)', () => {
  it('follows hasNextPage and reads the teams once per app run', async () => {
    const d = deps();
    const linear = fakeLinear([
      JSON.stringify({ teams: [{ id: 't1', name: 'Acme', icon: 'x' }], hasNextPage: true, cursor: 'tc2' }),
      JSON.stringify({ teams: [{ id: 't2', name: 'Infra' }], hasNextPage: false }),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    const teams = { teams: [{ id: 't1', name: 'Acme' }, { id: 't2', name: 'Infra' }] };
    expect(await h['linear:teams']()).toEqual(teams);
    expect(await h['linear:teams']()).toEqual(teams);
    expect(linear.calls).toEqual([
      { tool: 'list_teams', args: { limit: 100 } },
      { tool: 'list_teams', args: { limit: 100, cursor: 'tc2' } },
    ]);
  });

  /** Two dialogs opening together share one chain — without the memo the second would page again. */
  it('sends one chain for two simultaneous asks', async () => {
    const d = deps();
    const linear = fakeLinear([JSON.stringify({ teams: [{ id: 't1', name: 'Acme' }], hasNextPage: false })]);
    const h = createHandlers({ ...d.deps, linear });
    const [a, b] = await Promise.all([h['linear:teams'](), h['linear:teams']()]);
    expect(a).toEqual({ teams: [{ id: 't1', name: 'Acme' }] });
    expect(b).toEqual(a);
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_teams']);
  });

  /** A team created mid-run has to be able to appear, so `refresh` drops this cache with the list. */
  it('reads the teams again after the owner refreshes the list', async () => {
    const d = deps();
    const linear = fakeLinear([
      JSON.stringify({ teams: [{ id: 't1', name: 'Acme' }], hasNextPage: false }),
      page([], null),
      JSON.stringify({ teams: [{ id: 't1', name: 'Acme' }, { id: 't2', name: 'New' }], hasNextPage: false }),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    expect((await h['linear:teams']()).teams).toHaveLength(1);
    await h['linear:myIssues']({ refresh: true });
    expect((await h['linear:teams']()).teams).toHaveLength(2);
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_teams', 'list_issues', 'list_teams']);
  });
});

describe('linear:draftTicket and linear:createTicket (Plan 07)', () => {
  const FIELDS = { title: 'Zero click payments', description: 'Charge a saved card.', estimate: 3, priority: 2, teamId: 't1', projectId: 'Payments', assigneeSelf: true, state: 'Backlog' } as const;

  it('routes a draft to the draft service by request id, and linear:cancel reaches both registries', async () => {
    const d = deps();
    const cancelled: string[] = [];
    const drafted = { description: 'x', estimate: 1, priority: 2, teamId: 't1', projectId: null };
    const h = createHandlers({
      ...d.deps,
      ticketDraft: { draft: async (id, title) => ({ ...drafted, description: `${id}:${title}` }), cancel: (id) => cancelled.push(`draft:${id}`), cancelAll: () => {} },
      triage: { run: async () => { throw new Error('unused'); }, cancel: (id) => cancelled.push(`triage:${id}`), cancelAll: () => {} },
    });
    expect(await h['linear:draftTicket']({ requestId: 'r1', title: 'A title' })).toMatchObject({ description: 'r1:A title' });
    await h['linear:cancel']({ requestId: 'r1' });
    expect(cancelled).toEqual(['triage:r1', 'draft:r1']);
  });

  /**
   * The mutant this kills: handing `ticketDraft.draft`'s answer straight back. `linear-ticket-draft.ts`
   * schema-checks the model's answer, bounds its length and resolves its team and project against real
   * ones, but it does NOT clean the description — its own comment says that is `mergeTicketFields`'s
   * job, which runs in the RENDERER. So without a boundary pass the one IPC reply in this feature that
   * carries model-written prose carries its C0/C1 control bytes and invisible formatting characters
   * with it. `LinearTicketDraft` is an injected interface besides, so the guarantee has to be made
   * here rather than borrowed from whatever is behind it.
   *
   * `mergeTicketFields` over an empty `TicketFields` is what runs here, rather than a second copy of
   * the same rules, so main and the renderer cannot disagree about what cleaning means — and the
   * renderer's own merge stays exactly as it was, now idempotent rather than load-bearing.
   *
   * Control characters are written as escapes, never as literal bytes (G48).
   */
  it('cleans and caps the drafted description at the IPC boundary, not only in the renderer merge', async () => {
    const d = deps();
    const h = createHandlers({
      ...d.deps,
      ticketDraft: {
        draft: async () => ({
          description: `  lead\u0007ing\u200b ${'z'.repeat(TICKET_DESCRIPTION_MAX)}  `,
          // Out of range rather than merely wrong: `mergeTicketFields` DROPS these rather than
          // clamping, so an absurd answer leaves the field empty for the owner to fill.
          estimate: 999_999, priority: 9, teamId: `  t1\u0007  `, projectId: 'Payments',
        }),
        cancel: () => {}, cancelAll: () => {},
      },
    });
    const drafted = await h['linear:draftTicket']({ requestId: 'r1', title: 'A title' });
    expect(drafted.description?.startsWith('lead ing z')).toBe(true);
    expect(Array.from(drafted.description ?? '')).toHaveLength(TICKET_DESCRIPTION_MAX);
    expect(drafted.estimate).toBeNull();
    expect(drafted.priority).toBeNull();
    expect(drafted.teamId).toBe('t1');
    expect(drafted.projectId).toBe('Payments');
  });

  it('creates through save_issue with no id, and prepends the new ticket to the cached list', async () => {
    const d = deps();
    const linear = fakeLinear([
      page(['AC-1'], null),
      JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/zero-click' }),
    ]);
    const h = createHandlers({ ...d.deps, linear });

    await h['linear:myIssues']({});
    expect(await h['linear:createTicket']({ fields: FIELDS })).toEqual({ identifier: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/zero-click' });

    const save = linear.calls[1];
    expect(save?.tool).toBe('save_issue');
    expect(save?.args).toEqual({ title: 'Zero click payments', description: 'Charge a saved card.', estimate: 3, priority: 2, team: 't1', project: 'Payments', assignee: 'me', state: 'Backlog' });
    expect(Object.keys(save?.args ?? {})).not.toContain('id');

    // The list the dialog goes back to already has it, without another request.
    const listed = await h['linear:myIssues']({});
    expect(listed.issues.map((i) => i.identifier)).toEqual(['AC-3500', 'AC-1']);
    expect(linear.calls).toHaveLength(2);
  });

  /**
   * The title's half of P7-6b. The drafted DESCRIPTION stopped depending on the renderer to clean it
   * when `linear:draftTicket` took that over; the title a ticket is FILED with still did, because
   * `saveIssueArgs` sent `fields.title.trim()` and the only thing that had ever cleaned it was the
   * form. Flagged by Task 7's implementer. A caller that skips the form — a future one, a test, a
   * compromised renderer — could file a ticket whose title carries a bell character, a right-to-left
   * override that reverses what follows it, or a zero-width space that makes one title pass for
   * another, into a ticket other people read.
   */
  it('cleans a hostile title and description before they reach save_issue', async () => {
    const d = deps();
    const linear = fakeLinear([JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' })]);
    const h = createHandlers({ ...d.deps, linear });
    const BIDI = String.fromCodePoint(0x202e);
    const ZWSP = String.fromCodePoint(0x200b);
    const BELL = String.fromCodePoint(7);
    await h['linear:createTicket']({
      fields: { ...FIELDS, title: `Zero${BIDI} click${BELL}payments${ZWSP}`, description: `Charge a${BELL} saved${BIDI} card.` },
    });
    const sent = linear.calls[0]?.args ?? {};
    // A control character becomes a SPACE rather than nothing, so two words cannot be merged into
    // one by deleting the byte between them; the invisibles, which drew nothing, are deleted.
    expect(sent.title).toBe('Zero click payments');
    // The description keeps the double space that leaves behind: it is markdown, and only the title
    // is collapsed to one line. What matters is that neither carries a character that can act.
    expect(sent.description).toBe('Charge a  saved card.');
    for (const ch of [BIDI, ZWSP, BELL]) expect(JSON.stringify(sent).includes(ch)).toBe(false);
  });

  /**
   * The placeholder row is the one `LinearIssue` in the application that is BUILT rather than parsed,
   * so it is the one that can disagree with the rest. It did: `save_issue` was sent the cleaned title
   * while the row kept `fields.title.trim()`, so a pasted U+202E — which reverses everything after it
   * — survived into the list the owner is sent back to, next to rows `parseIssuesPayload` had cleaned.
   * The row now goes through the same `cleanTicketTitle` as the request, so what is listed is what
   * Linear stored.
   */
  it('shows the cleaned title in the pending row, not the raw one', async () => {
    const d = deps();
    const BIDI = String.fromCodePoint(0x202e);
    const BELL = String.fromCodePoint(7);
    const linear = fakeLinear([
      page(['AC-1'], null),
      JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' }),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    await h['linear:myIssues']({});
    await h['linear:createTicket']({ fields: { ...FIELDS, title: `Zero${BIDI} click${BELL}payments` } });

    const row = (await h['linear:myIssues']({})).issues[0];
    expect(row?.identifier).toBe('AC-3500');
    // The same string `save_issue` was given, so the list and Linear cannot disagree about the title.
    expect(row?.title).toBe('Zero click payments');
    expect(row?.title).toBe(linear.calls[1]?.args.title);
  });

  it('refuses a create that could not be a ticket, before any request', async () => {
    const d = deps();
    const linear = fakeLinear([]);
    const h = createHandlers({ ...d.deps, linear });
    expect(toIpcError(await h['linear:createTicket']({ fields: { ...FIELDS, teamId: null } }).catch((e: unknown) => e))).toMatchObject({ code: 'BAD_REQUEST', message: 'Choose a team.' });
    expect(linear.calls).toEqual([]);
  });

  /**
   * A 200 whose payload carries no identifier. `save_issue` ANSWERED, so the ticket almost certainly
   * exists — Hangar simply cannot name it — and this was the plan's one `LINEAR_FAILED`. It is not a
   * failure: the form must send the owner to Linear rather than offer the Save that files a second.
   */
  it('treats a saved ticket it cannot name as unconfirmed, not failed', async () => {
    const d = deps();
    const h = createHandlers({ ...d.deps, linear: fakeLinear(['{"ok":true}']) });
    const error = toIpcError(await h['linear:createTicket']({ fields: FIELDS }).catch((e: unknown) => e));
    expect(error.code).toBe(LINEAR_CREATE_UNCONFIRMED);
    expect(error.message).toMatch(/Check Linear/);
  });

  /**
   * The one failure a create cannot treat as a failure. `linear-mcp.ts` already refuses to retry a
   * write — a transport failure says the ANSWER was lost, not the request — but that only means main
   * sends one request; the renderer is still holding a filled-in form and a Save button, and
   * `LINEAR_TIMEOUT` reads exactly like every other "try again" in this feature. Pressing Save again
   * would file the ticket twice.
   *
   * So the timeout is re-coded here, at the only place that knows the call was a WRITE, into a code of
   * its own. `save_issue` is sent exactly once whatever the renderer does next, and Task 7's form can
   * offer "check Linear" instead of a blind retry. Every other `LinearError` passes through untouched:
   * a dead token or a refusal is a request Linear never accepted, and those ARE safe to retry.
   */
  it('never retries a create, and reports a timeout as unconfirmed rather than failed', async () => {
    const d = deps();
    let calls = 0;
    const h = createHandlers({
      ...d.deps,
      linear: {
        call: async () => {
          calls += 1;
          throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
        },
      },
    });
    const error = toIpcError(await h['linear:createTicket']({ fields: FIELDS }).catch((e: unknown) => e));
    expect(calls).toBe(1);
    expect(error.code).toBe(LINEAR_CREATE_UNCONFIRMED);
    expect(error.code).not.toBe('LINEAR_TIMEOUT');
    // The message has to say the thing the code exists for, or the form's own copy is the only place
    // the owner is warned and a toast raised from `toIpcError` alone would tell them to retry.
    expect(error.message).toMatch(/Check Linear/);

    // And nothing else is re-coded: a refusal Linear never accepted is safe to press Save on again.
    const reauth = createHandlers({
      ...deps().deps,
      linear: { call: async () => { throw new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH); } },
    });
    expect(toIpcError(await reauth['linear:createTicket']({ fields: FIELDS }).catch((e: unknown) => e))).toEqual({ code: 'LINEAR_REAUTH', message: LINEAR_MESSAGES.LINEAR_REAUTH });
  });

  /**
   * The bug this kills is subtler than the timeout, and it was live: a `LINEAR_FAILED` was read here
   * as "Linear refused the request", but `linear-mcp.ts` raises that code for a 502 and for a 200
   * whose body is not an MCP reply as well as for a genuine refusal. Both of those were SENT, so the
   * ticket may exist — and answering them as a refusal is what puts a Save button back in front of
   * the owner. The code is no longer what decides: `LinearError.outcome` is.
   */
  it('reads a sent-but-unanswered failure as unconfirmed, whatever code it carries', async () => {
    const create = async (error: LinearError): Promise<ReturnType<typeof toIpcError>> => {
      const h = createHandlers({ ...deps().deps, linear: { call: async () => { throw error; } } });
      return toIpcError(await h['linear:createTicket']({ fields: FIELDS }).catch((e: unknown) => e));
    };
    // The two the transport marks `unknown`: a bad gateway, and an unreadable 200 body.
    const gateway = new LinearError('LINEAR_FAILED', "Couldn't reach Linear (HTTP 502).", undefined, 'unknown');
    const unreadable = new LinearError('LINEAR_FAILED', "Linear's answer could not be read.", undefined, 'unknown');
    for (const e of [gateway, unreadable]) expect(await create(e)).toMatchObject({ code: LINEAR_CREATE_UNCONFIRMED, message: expect.stringMatching(/Check Linear/) as unknown as string });

    // A genuine refusal is still a refusal: Linear answered, it said no, and Save is the right button.
    const refused = new LinearError('LINEAR_FAILED', 'Linear rejected that: no such team');
    expect(await create(refused)).toEqual({ code: 'LINEAR_FAILED', message: 'Linear rejected that: no such team' });
  });

  /**
   * Two Saves at once. Measured in review: without a guard both presses reached `save_issue` and made
   * two tickets. The form disables its own button, but this file's doctrine is that the form is a
   * courtesy and the wire is the guarantee — and a create is the one request in Hangar where losing
   * that argument costs the owner a duplicate they have to go and delete.
   */
  it('sends one save_issue for two simultaneous saves, and answers both with the same ticket', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const first = h['linear:createTicket']({ fields: FIELDS });
    const second = h['linear:createTicket']({ fields: FIELDS });
    await settle();
    expect(linear.calls.map((c) => c.tool)).toEqual(['save_issue']);
    linear.answer(0, JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' }));
    expect(await first).toEqual({ identifier: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' });
    expect(await second).toEqual(await first);

    // And the guard is released rather than latched: a later Save is a new ticket, not the old
    // answer replayed at an owner who meant to file a second one.
    const third = h['linear:createTicket']({ fields: FIELDS });
    await settle();
    expect(linear.calls.map((c) => c.tool)).toEqual(['save_issue', 'save_issue']);
    linear.answer(1, JSON.stringify({ id: 'AC-3501', url: 'https://linear.app/acme/issue/AC-3501/y' }));
    expect((await third).identifier).toBe('AC-3501');
  });

  /**
   * The bug the first single-flight introduced, and it was worse than the duplicate it prevented:
   * the guard keyed on NOTHING, so a second Save carrying a DIFFERENT ticket was handed the first
   * one's answer. Reproduced in review — ticket B was never filed and its caller was told it had
   * succeeded as A's identifier. A duplicate ticket is a minute's tidying; a ticket the owner watched
   * succeed and which does not exist is a lie, and they have no reason ever to look for it.
   *
   * So the memo is keyed on the request that would actually be sent, and only an identical resend —
   * a double-click — is shared. Anything else is `BUSY`: the press is refused, loudly, with the
   * owner's own typing still in the form to press again in a moment.
   */
  it('shares a create only with an identical one, and refuses a different one as BUSY', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const first = h['linear:createTicket']({ fields: FIELDS });
    // Settled AFTER the first answer, deliberately: under the bug this replaced, `other` resolves
    // with A's ticket rather than rejecting, and this ordering makes that a failed assertion instead
    // of a test that waits for ever on an answer nobody is going to give.
    const other = h['linear:createTicket']({ fields: { ...FIELDS, title: 'Totally different ticket B' } }).catch((e: unknown) => e);
    await settle();

    // One request, and it is the FIRST ticket's.
    expect(linear.calls.map((c) => c.tool)).toEqual(['save_issue']);
    expect(linear.calls[0]?.args).toMatchObject({ title: 'Zero click payments' });

    linear.answer(0, JSON.stringify({ id: 'AC-100', url: 'https://linear.app/acme/issue/AC-100/a' }));
    expect((await first).identifier).toBe('AC-100');
    // The second press was refused, not answered with a ticket that is not the one it asked for.
    expect(toIpcError(await other)).toMatchObject({ code: 'BUSY' });

    // And B is still fileable — it was refused, not swallowed, so pressing Save again files it.
    const b = h['linear:createTicket']({ fields: { ...FIELDS, title: 'Totally different ticket B' } });
    await settle();
    expect(linear.calls[1]?.args).toMatchObject({ title: 'Totally different ticket B' });
    linear.answer(1, JSON.stringify({ id: 'AC-101', url: 'https://linear.app/acme/issue/AC-101/b' }));
    expect((await b).identifier).toBe('AC-101');
  });

  /**
   * The bug `createdThisRun` introduced: it remembered for ever. A ticket created this app run was
   * re-prepended to every list written afterwards, so once the owner deleted it in Linear it came
   * BACK on the next refresh and no amount of refreshing could clear it — a row for a ticket that
   * does not exist, pinned to the top of the list, for the rest of the app run.
   *
   * The placeholder exists only to cover the window before Linear hands the row back. Once a server
   * page has carried that identifier the window is closed, so the entry is dropped and the list is
   * Linear's again. Presence is what drops it, never absence: a `Load more` page legitimately does
   * not contain a ticket that lives on page one.
   */
  it('stops re-prepending a created ticket once the server has returned it, so a delete sticks', async () => {
    const d = deps();
    const linear = fakeLinear([
      page(['AC-1'], null),
      JSON.stringify({ id: 'AC-100', url: 'https://linear.app/acme/issue/AC-100/a' }),
      // The refresh that carries it: the window the placeholder covered is now closed.
      page(['AC-100', 'AC-1'], null),
      // Deleted in Linear, and refreshed again. It must not come back.
      page(['AC-1'], null),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    await h['linear:myIssues']({});
    await h['linear:createTicket']({ fields: FIELDS });
    expect((await h['linear:myIssues']({})).issues.map((i) => i.identifier)).toEqual(['AC-100', 'AC-1']);
    expect((await h['linear:myIssues']({ refresh: true })).issues.map((i) => i.identifier)).toEqual(['AC-100', 'AC-1']);
    expect((await h['linear:myIssues']({ refresh: true })).issues.map((i) => i.identifier)).toEqual(['AC-1']);
    // And it stays gone, rather than returning on the one after that.
    expect((await h['linear:myIssues']({})).issues.map((i) => i.identifier)).toEqual(['AC-1']);
  });

  /** Absence never drops it: a `Load more` page does not carry a ticket that lives on page one. */
  it('keeps a created ticket across a Load more page that cannot contain it', async () => {
    const d = deps();
    const linear = fakeLinear([
      page(['AC-1'], 'c2'),
      JSON.stringify({ id: 'AC-100', url: 'https://linear.app/acme/issue/AC-100/a' }),
      page(['AC-2'], null),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    const opened = await h['linear:myIssues']({});
    await h['linear:createTicket']({ fields: FIELDS });
    const more = await h['linear:myIssues']({ cursor: opened.nextCursor! });
    expect(more.issues.map((i) => i.identifier)).toEqual(['AC-100', 'AC-1', 'AC-2']);
  });

  /**
   * Save and Refresh in flight together. The prepend used to write into an `issueCache` the refresh
   * then replaced wholesale, so the ticket the owner had just made vanished from the list they were
   * sent back to — the one row §4 promises can never be missing. Every ticket this app run created is
   * therefore re-applied to whatever list is written next, and de-duplicated against it, so the
   * server's own row wins as soon as Linear returns it.
   */
  it('keeps a created ticket in the list when a refresh lands after the save', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const opened = h['linear:myIssues']({});
    await settle();
    linear.answer(0, page(['AC-1'], null));
    expect((await opened).issues.map((i) => i.identifier)).toEqual(['AC-1']);

    // Both in flight: Refresh pressed, then Save, with neither answered yet.
    const refreshed = h['linear:myIssues']({ refresh: true });
    const created = h['linear:createTicket']({ fields: FIELDS });
    await settle();
    expect(linear.calls.map((c) => c.tool)).toEqual(['list_issues', 'list_issues', 'save_issue']);

    // The create answers FIRST, so its prepend goes into a list the refresh is about to replace.
    linear.answer(2, JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' }));
    expect((await created).identifier).toBe('AC-3500');
    linear.answer(1, page(['AC-1', 'AC-2'], null));
    expect((await refreshed).issues.map((i) => i.identifier)).toEqual(['AC-3500', 'AC-1', 'AC-2']);
    // And the list the dialog reopens on is that one, not the refresh's page without the new ticket.
    expect((await h['linear:myIssues']({})).issues.map((i) => i.identifier)).toEqual(['AC-3500', 'AC-1', 'AC-2']);
  });

  /** And the other order, plus the de-duplication: once Linear returns the row, the row is Linear's. */
  it('lets the server row replace the created one once a refresh returns it', async () => {
    const d = deps();
    const linear = fakeLinear([
      page(['AC-1'], null),
      JSON.stringify({ id: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/x' }),
      JSON.stringify({ issues: [{ id: 'AC-3500', title: 'Zero click payments', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 't1', updatedAt: '2026-09-16T11:00:00.000Z' }], hasNextPage: false, cursor: null }),
    ]);
    const h = createHandlers({ ...d.deps, linear });
    await h['linear:myIssues']({});
    await h['linear:createTicket']({ fields: FIELDS });
    const after = await h['linear:myIssues']({ refresh: true });
    expect(after.issues.map((i) => i.identifier)).toEqual(['AC-3500']);
    // Linear's own row, not the placeholder: the state it really has, and the team NAME it really has.
    expect(after.issues[0]).toMatchObject({ state: 'Todo', stateType: 'unstarted', teamName: 'Acme' });
  });
});

describe('linear:cycles and linear:cycleIssues (Plan 08)', () => {
  const ISSUE_PAGE = JSON.stringify({
    issues: [
      { id: 'AC-1368', title: 'Cycle work', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 't1', cycleId: 'cy-33', url: '', updatedAt: '2026-09-17T09:00:00.000Z' },
      { id: 'AC-1400', title: 'Other team', status: 'Todo', statusType: 'unstarted', team: 'Platform', teamId: 't2', cycleId: 'cy-9', url: '', updatedAt: '2026-09-17T08:00:00.000Z' },
    ],
    hasNextPage: false,
  });
  const CYCLES_T1 = JSON.stringify([
    { id: 'cy-33', number: 33, startsAt: '2026-09-28T00:00:00.000Z', endsAt: '2026-10-12T00:00:00.000Z', isCurrent: true },
    { id: 'cy-32', number: 32, startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-09-28T00:00:00.000Z', isCurrent: false },
  ]);
  const CYCLES_T2 = JSON.stringify([{ id: 'cy-9', number: 9, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-14T00:00:00.000Z', isCurrent: false }]);

  /** Answers each tool from a queue, recording every call — no network, no keychain. */
  function withLinear(answers: { tool: LinearTool; args: Record<string, unknown>; text: string }[]) {
    const d = deps();
    const calls: { tool: LinearTool; args: Record<string, unknown> }[] = [];
    d.deps.linear = {
      call: async (tool, args) => {
        calls.push({ tool, args });
        const found = answers.find((a) => a.tool === tool && JSON.stringify(a.args) === JSON.stringify(args));
        if (found === undefined) throw new LinearError('LINEAR_FAILED', `no answer for ${tool} ${JSON.stringify(args)}`);
        return found.text;
      },
    };
    return { ...d, calls, handlers: createHandlers(d.deps) };
  }

  const listCall = { tool: 'list_issues' as const, args: { assignee: 'me', orderBy: 'updatedAt', limit: 50 }, text: ISSUE_PAGE };
  const cycleCalls = [
    { tool: 'list_cycles' as const, args: { teamId: 't1' }, text: CYCLES_T1 },
    { tool: 'list_cycles' as const, args: { teamId: 't2' }, text: CYCLES_T2 },
  ];

  it('asks list_cycles once per team the owner has tickets in, and stamps the team on each row', async () => {
    const t = withLinear([listCall, ...cycleCalls]);
    const { cycles } = await t.handlers['linear:cycles']({});

    expect(t.calls.map((c) => c.tool)).toEqual(['list_issues', 'list_cycles', 'list_cycles']);
    // `{teamId}` and nothing else — a `limit` is REFUSED by this tool (measured).
    expect(t.calls.filter((c) => c.tool === 'list_cycles').map((c) => c.args)).toEqual([{ teamId: 't1' }, { teamId: 't2' }]);
    expect(cycles.map((c) => `${c.number}:${c.teamName}`)).toEqual(['33:Acme', '32:Acme', '9:Platform']);
    expect(cycles[0]).toMatchObject({ id: 'cy-33', isCurrent: true, startsAt: '2026-09-28T00:00:00.000Z', teamId: 't1' });
  });

  it('serves the second call from the app-run cache, asking Linear nothing', async () => {
    const t = withLinear([listCall, ...cycleCalls]);
    await t.handlers['linear:cycles']({});
    const before = t.calls.length;
    const again = await t.handlers['linear:cycles']({});
    expect(t.calls.length).toBe(before);
    expect(again.cycles).toHaveLength(3);
  });

  it('shares one per-team read with the ticket list, so a row keeps its cycle number', async () => {
    const t = withLinear([listCall, ...cycleCalls]);
    await t.handlers['linear:cycles']({});
    const list = await t.handlers['linear:myIssues']({});
    expect(list.issues.map((i) => i.cycleNumber)).toEqual([33, 9]);
    // Still two `list_cycles` calls in total: the list did not re-ask for what the picker read.
    expect(t.calls.filter((c) => c.tool === 'list_cycles')).toHaveLength(2);
  });

  /**
   * Asserted on the CONTENT served, not on a call count.
   *
   * The count version of this test did not bite: deleting `cycleCache = null` from
   * `linear:myIssues`' refresh block left the whole file green, because the `list_cycles` calls it
   * counted were `myIssues`' OWN fan-out and the stale cycle list was still handed to the picker
   * afterwards. So Linear answers with a different cycle each round, and what changes across a
   * refresh is what this checks.
   */
  it('refresh re-asks, and a refresh of the ticket list drops the cycle cache too', async () => {
    const rounds: Record<string, string>[] = [
      { t1: CYCLES_T1, t2: CYCLES_T2 },
      { t1: JSON.stringify([{ id: 'cy-34', number: 34, startsAt: '2026-10-12T00:00:00.000Z', endsAt: '2026-10-26T00:00:00.000Z', isCurrent: true }]), t2: CYCLES_T2 },
      { t1: JSON.stringify([{ id: 'cy-35', number: 35, startsAt: '2026-10-26T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z', isCurrent: true }]), t2: CYCLES_T2 },
    ];
    const seen = new Map<string, number>();
    const d = deps();
    const calls: { tool: LinearTool; args: Record<string, unknown> }[] = [];
    d.deps.linear = {
      call: async (tool, args) => {
        calls.push({ tool, args });
        if (tool !== 'list_cycles') return ISSUE_PAGE;
        const teamId = String(args.teamId);
        const round = seen.get(teamId) ?? 0;
        seen.set(teamId, round + 1);
        return rounds[round]?.[teamId] ?? JSON.stringify([]);
      },
    };
    const h = createHandlers(d.deps);

    expect((await h['linear:cycles']({})).cycles.map((c) => c.number)).toEqual([33, 32, 9]);
    // `refresh` on the picker itself: the memo, the remembered failures and the cached list all go.
    expect((await h['linear:cycles']({ refresh: true })).cycles.map((c) => c.number)).toEqual([34, 9]);
    expect(calls.filter((c) => c.tool === 'list_cycles')).toHaveLength(4);
    // And a refresh of the TICKET list drops the picker's cache too — otherwise the next open would
    // serve cycles from before the refresh while the rows beside them came from after it.
    await h['linear:myIssues']({ refresh: true });
    expect((await h['linear:cycles']({})).cycles.map((c) => c.number)).toEqual([35, 9]);
    expect(calls.filter((c) => c.tool === 'list_cycles')).toHaveLength(6);
  });

  /**
   * A `Refresh` landing in the middle of the picker's fan-out. `readMyIssues`' refresh CLEARS
   * `cycleRows`, so the list this call finishes assembling is half of one generation and half of the
   * next. Answering this caller with it is right — it is what main holds. Keeping it is not: without
   * the generation guard it became the app run's cycle list, and only another refresh could dislodge
   * it.
   */
  it('does not cache a cycle list a concurrent refresh has already invalidated', async () => {
    const d = deps();
    const linear = gatedLinear();
    const h = createHandlers({ ...d.deps, linear });
    const picker = h['linear:cycles']({});
    linear.answer(0, ISSUE_PAGE); // the first page: teams t1 and t2
    await settle();
    linear.answer(1, CYCLES_T1); // t1's cycles land
    await settle();
    // The owner presses Refresh while t2 is still in flight.
    const refreshed = h['linear:myIssues']({ refresh: true });
    await settle();
    linear.answer(2, CYCLES_T2); // t2 lands into the map the refresh just emptied
    expect((await picker).cycles.map((c) => c.number)).toEqual([9]);

    linear.answer(3, ISSUE_PAGE); // the refresh's own page…
    await settle();
    linear.answer(4, CYCLES_T1); // …and its own t1 read
    await refreshed;
    const again = h['linear:cycles']({});
    await settle();
    // The half list was NOT kept: this open re-reads the team whose answer the refresh orphaned.
    expect(linear.calls[5]).toMatchObject({ tool: 'list_cycles', args: { teamId: 't2' } });
    linear.answer(5, CYCLES_T2);
    expect((await again).cycles.map((c) => c.number)).toEqual([33, 32, 9]);
  });

  it('lists a cycle\u2019s own tickets with cycle + assignee, following every page', async () => {
    const page1 = JSON.stringify({
      issues: [{ id: 'AC-1368', title: 'One', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 't1', cycleId: 'cy-33', url: '', updatedAt: '2026-09-17T09:00:00.000Z' }],
      hasNextPage: true, cursor: 'next-1',
    });
    const page2 = JSON.stringify({
      issues: [{ id: 'AC-1369', title: 'Two', status: 'Done', statusType: 'completed', team: 'Acme', teamId: 't1', cycleId: 'cy-33', url: '', updatedAt: '2026-09-17T08:00:00.000Z' }],
      hasNextPage: false,
    });
    const t = withLinear([
      { tool: 'list_issues', args: { cycle: 'cy-33', assignee: 'me', orderBy: 'updatedAt', limit: 50 }, text: page1 },
      { tool: 'list_issues', args: { cycle: 'cy-33', assignee: 'me', orderBy: 'updatedAt', limit: 50, cursor: 'next-1' }, text: page2 },
      listCall, ...cycleCalls,
    ]);
    const { issues } = await t.handlers['linear:cycleIssues']({ cycleId: 'cy-33' });
    expect(issues.map((i) => i.identifier)).toEqual(['AC-1368', 'AC-1369']);
    expect(issues.map((i) => i.stateType)).toEqual(['unstarted', 'completed']);
  });

  it('fills the cycle number on those rows from the cycles it has already read', async () => {
    const page = JSON.stringify({
      issues: [{ id: 'AC-1368', title: 'One', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 't1', cycleId: 'cy-33', url: '', updatedAt: '2026-09-17T09:00:00.000Z' }],
      hasNextPage: false,
    });
    const t = withLinear([{ tool: 'list_issues', args: { cycle: 'cy-33', assignee: 'me', orderBy: 'updatedAt', limit: 50 }, text: page }, listCall, ...cycleCalls]);
    await t.handlers['linear:cycles']({});
    const { issues } = await t.handlers['linear:cycleIssues']({ cycleId: 'cy-33' });
    expect(issues[0]?.cycleNumber).toBe(33);
  });

  it('a dead token surfaces, with the reconnect wording §6 already uses', async () => {
    const dead = deps();
    dead.deps.linear = { call: async (tool) => { if (tool === 'list_issues') return ISSUE_PAGE; throw new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH); } };
    await expect(createHandlers(dead.deps)['linear:cycles']({})).rejects.toMatchObject({ code: 'LINEAR_REAUTH', message: LINEAR_MESSAGES.LINEAR_REAUTH });
  });

  it('a partial answer is a list, not a failure — one team down still offers the other\u2019s cycles', async () => {
    const t = withLinear([listCall, cycleCalls[0]!]);
    const { cycles } = await t.handlers['linear:cycles']({});
    expect(cycles.map((c) => c.number)).toEqual([33, 32]);
  });

  it('surfaces the failure rather than an empty list when EVERY team fails', async () => {
    const down = deps();
    down.deps.linear = {
      call: async (tool) => {
        if (tool === 'list_issues') return ISSUE_PAGE;
        throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
      },
    };
    // An empty select would read as "you have no cycles"; the truth is "Linear could not be reached".
    await expect(createHandlers(down.deps)['linear:cycles']({})).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT', message: LINEAR_MESSAGES.LINEAR_TIMEOUT });
  });

  it('is an honest empty list when the owner has no assigned tickets at all', async () => {
    // No tickets means no teams to fan out over, so nothing was asked and nothing failed. That is
    // "No cycles found for your teams.", not an error.
    const t = withLinear([{ tool: 'list_issues', args: { assignee: 'me', orderBy: 'updatedAt', limit: 50 }, text: JSON.stringify({ issues: [], hasNextPage: false }) }]);
    await expect(t.handlers['linear:cycles']({})).resolves.toEqual({ cycles: [] });
    expect(t.calls.some((c) => c.tool === 'list_cycles')).toBe(false);
  });

  it('warns rather than truncating in silence when a cycle outruns CYCLE_PAGES_MAX', async () => {
    // The contract promises the WHOLE cycle, and every count the step shows (the tick boxes,
    // `Select all`, the number in the button) is a statement about a complete list. A stop that is
    // hit without a word would make a short list look like the cycle.
    const warned: string[] = [];
    const d = deps();
    let n = 0;
    d.deps.linear = {
      call: async () => {
        n += 1;
        return JSON.stringify({
          issues: [{ id: `AC-${n}`, title: 'x', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 't1', cycleId: 'cy-33', url: '', updatedAt: '2026-09-17T09:00:00.000Z' }],
          hasNextPage: true, cursor: `c${n}`,
        });
      },
    };
    d.deps.log = { ...d.deps.log, warn: (m: string) => { warned.push(m); } };
    const { issues } = await createHandlers(d.deps)['linear:cycleIssues']({ cycleId: 'cy-33' });
    expect(issues).toHaveLength(5);
    expect(n).toBe(5);
    expect(warned).toEqual(['linear:cycleIssues: cycle cy-33 has more than 5 pages; the list is truncated']);
  });

  it('never calls save_issue, whatever it is asked for', async () => {
    // The teams this fans out over come from the CACHED FIRST PAGE of the owner's tickets and only
    // that page — `readCycleList` never pages the list, so a team behind a `Load more` is not asked
    // about. Read-only either way: neither key has a write on any path through it.
    const t = withLinear([
      { tool: 'list_issues', args: { cycle: 'cy-33', assignee: 'me', orderBy: 'updatedAt', limit: 50 }, text: JSON.stringify({ issues: [], hasNextPage: false }) },
      listCall, ...cycleCalls,
    ]);
    await t.handlers['linear:cycles']({});
    await t.handlers['linear:cycles']({ refresh: true });
    await t.handlers['linear:cycleIssues']({ cycleId: 'cy-33' });
    expect(t.calls.some((c) => c.tool === 'save_issue')).toBe(false);
    expect([...new Set(t.calls.map((c) => c.tool))].sort()).toEqual(['list_cycles', 'list_issues']);
  });
});

/**
 * A worktree with one ordinary file and one symlink that escapes it. `tempDir`, not a bare
 * `mkdtempSync`: it removes itself with `onTestFinished` and it mkdtemps under `/tmp` deliberately,
 * because macOS's `os.tmpdir()` is a long `/var/folders/…` path that blows the 104-byte `sun_path`
 * limit (G40). `/tmp` is itself a symlink to `/private/tmp`, which is why every path assertion
 * below goes through `realpathSync` — `jailPath` realpaths its root, so that is what the handler
 * actually operates on.
 */
function worktreeFixture(): { wt: string; outside: string } {
  const wt = tempDir('h-wt');
  const outside = tempDir('h-outside');
  writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
  mkdirSync(join(wt, 'src'));
  writeFileSync(join(wt, 'src', 'a.ts'), 'const a = 1;\n');
  symlinkSync(outside, join(wt, 'escape'));
  return { wt, outside };
}

/** Store state for one agent whose single workspace is `wt`, under a project rooted at `repo`. */
function seed(d: ReturnType<typeof deps>, wt: string, repo: string): void {
  d.deps.store.update((ws) => ({
    ...ws,
    projects: [projectFixture('p1', repo, 'trunk')],
    agents: [agentFixture('ag', 'w', wt, 'p1')],
  }));
}

describe('fs and diff handlers', () => {
  it('jails the renderer relPath under the worktree the STORE names', async () => {
    const d = deps();
    const { wt } = worktreeFixture();
    seed(d, wt, '/repo');
    const h = createHandlers(d.deps);

    expect((await h['fs:list']({ agentId: 'ag', workspaceId: 'w', relPath: '' })).map((e) => `${e.name}:${e.kind}`)).toEqual(['src:dir', 'escape:symlink']);
    expect((await h['fs:read']({ agentId: 'ag', workspaceId: 'w', relPath: 'src/a.ts' })).content).toBe('const a = 1;\n');

    // The lexical escape `shared/ipc-schemas.ts` also refuses on the wire. Asserted HERE as well
    // because the handler is reachable without the schema (this test calls it directly, and so does
    // any future in-main caller), so the jail must be the thing that refuses, not the validator.
    await expect(h['fs:read']({ agentId: 'ag', workspaceId: 'w', relPath: '../../etc/hosts' })).rejects.toMatchObject({ code: 'EACCES' });
    // The escape zod CANNOT see: every segment is innocent and there is no `..` anywhere. Only the
    // physical realpath check in `jailPath` catches it, and it only runs if the handler passes the
    // worktree root from the store rather than a path from the payload.
    await expect(h['fs:read']({ agentId: 'ag', workspaceId: 'w', relPath: 'escape/secret.txt' })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(h['fs:list']({ agentId: 'ag', workspaceId: 'w', relPath: 'escape' })).rejects.toMatchObject({ code: 'EACCES' });
    // A worktree mutates under the drawer constantly, so a vanished file is NOT_FOUND, not EACCES.
    await expect(h['fs:read']({ agentId: 'ag', workspaceId: 'w', relPath: 'src/gone.ts' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives `git check-ignore` the jailed directory and the shared env, not process.env', async () => {
    const d = deps();
    const { wt } = worktreeFixture();
    seed(d, wt, '/repo');
    await createHandlers(d.deps)['fs:list']({ agentId: 'ag', workspaceId: 'w', relPath: 'src' });

    expect(d.execCalls.map((c) => `${c.file} ${c.args.join(' ')}`)).toEqual(['git check-ignore --stdin -z']);
    // The REALPATHED subdirectory, so `check-ignore` answers about the directory being listed.
    expect(d.execCalls[0]!.opts?.cwd).toBe(join(realpathSync(wt), 'src'));
    // `toBe`, not `toEqual`: the same object main built for GitService and DiffService. A handler
    // that rebuilt an env from `process.env` would pass a deep-equal check on a machine whose PATH
    // happened to match, and would silently diverge from `git diff` on one whose did not.
    expect(d.execCalls[0]!.opts?.env).toBe(TEST_ENV);
  });

  it('resolves repo, worktree and default branch from the store — never from the payload', async () => {
    const d = deps();
    const { wt } = worktreeFixture();
    seed(d, wt, '/repo/main-checkout');
    const h = createHandlers(d.deps);

    expect(await h['git:changes']({ agentId: 'ag', workspaceId: 'w' })).toMatchObject({ mergeBase: MERGE_BASE });
    await h['git:fileDiff']({ agentId: 'ag', workspaceId: 'w', relPath: 'src/a.ts' });

    // `/repo/main-checkout` and `trunk` appear nowhere in either payload: they are the project
    // record's, reached through the workspace's `projectId`. `wt` likewise comes from the workspace.
    expect(d.diffCalls).toEqual([
      { method: 'changes', args: ['/repo/main-checkout', wt, 'trunk'] },
      { method: 'mergeBaseFor', args: ['/repo/main-checkout', wt, 'trunk'] },
      { method: 'fileDiff', args: [wt, MERGE_BASE, 'src/a.ts'] },
    ]);
    // The row list and the file's diff describe the SAME comparison. `mergeBaseFor` is one
    // implementation with two callers precisely so a fetch between the two calls cannot make the
    // diff answer about a different base than the list that offered the row.
    const [changes, forDiff] = [d.diffCalls[0]!, d.diffCalls[1]!];
    expect(forDiff.args).toEqual(changes.args);
  });

  it('refuses an agent/workspace pair that is not actually paired, before any service runs', async () => {
    const d = deps();
    const { wt } = worktreeFixture();
    d.deps.store.update((ws) => ({
      ...ws,
      projects: [projectFixture('p1', '/repo', 'trunk')],
      agents: [agentFixture('a1', 'w1', wt, 'p1'), agentFixture('a2', 'w2', '/wt/two', 'p1')],
    }));
    const h = createHandlers(d.deps);

    // Both ids exist, but not together. Checking them separately would have opened a1's drawer onto
    // a worktree belonging to a2 — the gate `app:openExternal` already records, asserted here for
    // all four Phase 2 keys so a new handler cannot quietly skip it.
    for (const call of [
      h['fs:list']({ agentId: 'a1', workspaceId: 'w2', relPath: '' }),
      h['fs:read']({ agentId: 'a1', workspaceId: 'w2', relPath: 'src/a.ts' }),
      h['git:changes']({ agentId: 'a1', workspaceId: 'w2' }),
      h['git:fileDiff']({ agentId: 'a1', workspaceId: 'w2', relPath: 'src/a.ts' }),
      h['fs:list']({ agentId: 'ghost', workspaceId: 'w1', relPath: '' }),
      h['git:changes']({ agentId: 'ghost', workspaceId: 'w1' }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    // The refusal happens before anything is read or spawned: no git ran, no diff call was made.
    expect(d.execCalls).toEqual([]);
    expect(d.diffCalls).toEqual([]);
  });

  it('reports a workspace whose project is gone as NOT_FOUND rather than reading the wrong repo', async () => {
    const d = deps();
    const { wt } = worktreeFixture();
    // A project removed while an agent still references it (`project:remove` does not cascade).
    d.deps.store.update((ws) => ({ ...ws, projects: [], agents: [agentFixture('ag', 'w', wt, 'p1')] }));
    const h = createHandlers(d.deps);

    await expect(h['git:changes']({ agentId: 'ag', workspaceId: 'w' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h['git:fileDiff']({ agentId: 'ag', workspaceId: 'w', relPath: 'src/a.ts' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(d.diffCalls).toEqual([]);
    // `fs:*` need only the worktree, so they keep working for a workspace whose project is missing.
    expect((await h['fs:list']({ agentId: 'ag', workspaceId: 'w', relPath: 'src' })).map((e) => e.name)).toEqual(['a.ts']);
  });
});

/**
 * Plan 09 Task 7 — dictation's three requests, its broadcast, and its one write.
 *
 * Driven through a fake service (`fakeDictation`) so every update of a run is placed by hand, plus
 * two runs of the REAL service at the end: one with no helper at all, and one against a tiny helper
 * that says `ready`, waits for `stop` and answers with a final — the whole path from a helper's
 * stdout to the host message, with nothing faked but the helper and the host.
 */
describe('dictation (Plan 09 Task 7)', () => {
  type Live = ReturnType<typeof deps> & { sessions: Map<string, SessionState>; h: Handlers };

  /** a1 and a2 in the workspace, BOTH with a live session, and the host up. */
  function live(createDictation?: HandlerDeps['createDictation']): Live {
    const d = deps();
    d.deps.store.update((ws) => ({ ...ws, agents: [agentFixture('a1', 'w1', '/wt/one'), agentFixture('a2', 'w2', '/wt/two')] }));
    const sessions = new Map<string, SessionState>([
      ['a1', { ...initialSessionState('a1'), activity: 'idle', pid: 101 }],
      ['a2', { ...initialSessionState('a2'), activity: 'working', pid: 202 }],
    ]);
    // Absent from the map = never started (§6.5), exactly as the real registry answers.
    d.deps.registry = { ...d.deps.registry, get: (id) => sessions.get(id) ?? initialSessionState(id) };
    d.connected.value = true;
    return { ...d, sessions, h: createHandlers({ ...d.deps, createDictation: createDictation ?? d.dictation.create }) };
  }

  const recording = (partial: string): DictationState => ({ phase: 'recording', partial });
  /** The update that ends a run, as the service sends it: `idle` carrying the outcome, and the outcome. */
  const ended = (runId: number, outcome: DictationOutcome): DictationUpdate => ({ runId, state: { phase: 'idle', outcome }, outcome });
  const events = (t: Live): IpcEvents['dictation:event'][] =>
    t.emitted.filter((e) => e.event === 'dictation:event').map((e) => e.payload as IpcEvents['dictation:event']);

  it('a write outcome is typed into that agent’s session exactly once, as exactly the text', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    t.dictation.report({ runId: run, state: recording('fix the'), outcome: null });
    t.dictation.report({ runId: run, state: { phase: 'finalizing', partial: 'fix the flaky test' }, outcome: null });
    // Partials are for the pill. Nothing is typed until the run has ended with its final.
    expect(t.sent).toEqual([]);

    const text = 'fix the flaky test in the parser';
    t.dictation.report(ended(run, { kind: 'write', text }));
    // The host message `session:write` sends, to a1 alone, with the text and nothing after it — no
    // newline, no CR: it is never submitted (spec §4.3).
    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: text }]);

    // The same final delivered a second time finds its run already over: still exactly one write.
    t.dictation.report(ended(run, { kind: 'write', text }));
    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: text }]);
    // And the one outcome was broadcast once, on the event that ended the run.
    expect(events(t).filter((e) => e.outcome !== null)).toEqual([{ agentId: 'a1', state: { phase: 'idle', outcome: { kind: 'write', text } }, outcome: { kind: 'write', text } }]);
  });

  /**
   * "Never a control byte" holds AT THE WRITE, not only in the reducer upstream of it. The real
   * service cannot produce this outcome — the reducer has already run `textToWrite` — so it is made
   * by hand: a CR (Enter), an ESC sequence, a ^U and a line feed, any one of which would act on the
   * prompt if it were typed.
   */
  it('cleans the text again at the write: nothing but the cleaned words reaches the host, whatever the outcome carried', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a2' });
    t.dictation.report(ended(t.dictation.lastRun(), { kind: 'write', text: ' run the\r tests\u001b[2J now\u0015\n ' }));
    expect(t.sent).toEqual([{ t: 'write', id: 'a2', data: 'run the tests [2J now' }]);
    // What is broadcast is what was typed.
    expect(events(t).at(-1)?.outcome).toEqual({ kind: 'write', text: 'run the tests [2J now' });
  });

  it('cleans before the clipboard too, and an outcome that cleans to nothing writes nothing and says `Nothing heard.`', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a2' });
    t.dictation.report(ended(t.dictation.lastRun(), { kind: 'write', text: '\r\n\u001b\u0003' }));
    expect(t.sent).toEqual([]);
    const nothing: DictationOutcome = { kind: 'nothing', message: dictationMessage('NOTHING_HEARD') };
    expect(events(t).at(-1)).toEqual({ agentId: 'a2', state: { phase: 'idle', outcome: nothing }, outcome: nothing });

    t.sessions.set('a1', { ...initialSessionState('a1'), activity: 'needs-permission', pid: 101 });
    await t.h['dictation:start']({ agentId: 'a1' });
    t.dictation.report(ended(t.dictation.lastRun(), { kind: 'write', text: 'yes\r' }));
    expect(t.clipboard).toEqual(['yes']);
    expect(t.sent).toEqual([]);
  });

  it.each<[string, DictationOutcome]>([
    ['cancelled', { kind: 'cancelled' }],
    ['nothing', { kind: 'nothing', message: dictationMessage('NOTHING_HEARD') }],
    ['error', { kind: 'error', code: 'MIC_DENIED', message: dictationMessage('MIC_DENIED') }],
  ])('a %s outcome writes nothing at all — not the partial, not the sentence — and is still broadcast once', async (_kind, outcome) => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    t.dictation.report({ runId: run, state: recording('half a sentence'), outcome: null });
    t.dictation.report(ended(run, outcome));
    expect(t.sent).toEqual([]);
    expect(events(t).map((e) => [e.agentId, e.outcome])).toEqual([['a1', null], ['a1', null], ['a1', outcome]]);
  });

  it.each<[string, (t: Live) => void]>([
    ['exited', (t) => { t.sessions.set('a1', { ...initialSessionState('a1'), activity: 'exited', exitCode: 0 }); }],
    ['stopped', (t) => { t.sessions.delete('a1'); }],
    ['deleted', (t) => { t.deps.store.update((ws) => ({ ...ws, agents: ws.agents.filter((a) => a.id !== 'a1') })); }],
    // The same agent id, but a PTY nobody dictated into: stopped and started again mid-run.
    ['restarted', (t) => { t.sessions.set('a1', { ...initialSessionState('a1'), activity: 'starting', pid: 999 }); }],
    ['behind a host that has gone', (t) => { t.connected.value = false; }],
  ])('a final for an agent whose session has gone (%s) is dropped with a warning: no write anywhere, no throw', async (_why, gone) => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    t.dictation.report({ runId: run, state: recording('fix the flaky test'), outcome: null });
    gone(t);

    expect(() => t.dictation.report(ended(run, { kind: 'write', text: 'fix the flaky test' }))).not.toThrow();
    // Not a1's session — and not a2's, which is live and right there.
    expect(t.sent).toEqual([]);
    expect(t.warnings.filter((w) => w.startsWith('dictation: transcript for agent a1 dropped'))).toHaveLength(1);
    // The words themselves never reach the log.
    expect(t.warnings.join('\n')).not.toContain('flaky');
    // The renderer is still told how the run ended, for the agent it was started for.
    expect(events(t).at(-1)).toMatchObject({ agentId: 'a1', outcome: { kind: 'write' } });
  });

  /**
   * The write is KEYSTROKES. A Claude Code permission menu reads a digit or a letter as a choice, so
   * a sentence typed into one could answer it — work started by a misheard sentence, which is what
   * spec §4.3 forbids. While the session says `needs-permission` the words go to the clipboard and
   * the renderer is told so; they are never typed and never lost.
   */
  it('a final arriving while the agent waits on a permission prompt is copied, never typed — and the broadcast says so', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    t.dictation.report({ runId: run, state: recording('yes 2 of them'), outcome: null });
    // The prompt appears while the owner is still speaking.
    t.sessions.set('a1', { ...initialSessionState('a1'), activity: 'needs-permission', pid: 101 });

    t.dictation.report(ended(run, { kind: 'write', text: 'yes 2 of them' }));
    // Nothing reached the PTY: not the text, not a byte.
    expect(t.sent).toEqual([]);
    expect(t.clipboard).toEqual(['yes 2 of them']);
    // Told as what happened — on the outcome AND on the `idle` the renderer keeps drawing from — and
    // the text itself does not ride along on the wire.
    const copied: DictationOutcome = { kind: 'copied', message: dictationMessage('COPIED') };
    expect(events(t).at(-1)).toEqual({ agentId: 'a1', state: { phase: 'idle', outcome: copied }, outcome: copied });
    expect(JSON.stringify(events(t).at(-1))).not.toContain('yes 2');
    expect(t.warnings.join('\n')).not.toContain('yes 2');
  });

  it('a permission prompt on ANOTHER agent does not stop this one’s words being typed', async () => {
    const t = live();
    t.sessions.set('a2', { ...initialSessionState('a2'), activity: 'needs-permission', pid: 202 });
    await t.h['dictation:start']({ agentId: 'a1' });
    t.dictation.report(ended(t.dictation.lastRun(), { kind: 'write', text: 'fix the test' }));
    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: 'fix the test' }]);
    expect(t.clipboard).toEqual([]);
  });

  it('a clipboard that refuses the words types nothing either, and ends the run as a crash rather than as a copy', async () => {
    const t = live();
    const h = createHandlers({
      ...t.deps,
      registry: { ...t.deps.registry, get: (id) => (id === 'a1' ? { ...initialSessionState('a1'), activity: 'needs-permission', pid: 101 } : initialSessionState(id)) },
      bridge: { ...t.deps.bridge, writeClipboard: () => { throw new Error('pasteboard unavailable'); } },
      createDictation: t.dictation.create,
    });
    await h['dictation:start']({ agentId: 'a1' });
    expect(() => t.dictation.report(ended(t.dictation.lastRun(), { kind: 'write', text: 'words' }))).not.toThrow();
    expect(t.sent).toEqual([]);
    const crashed: DictationOutcome = { kind: 'error', code: 'CRASHED', message: dictationMessage('CRASHED') };
    expect(events(t).at(-1)).toEqual({ agentId: 'a1', state: { phase: 'idle', outcome: crashed }, outcome: crashed });
    expect(t.warnings.filter((w) => w.startsWith('dictation: transcript for agent a1 not copied'))).toHaveLength(1);
  });

  /** What the registry does when a session changes: records it, then tells every `onSessionState` listener. */
  const sessionBecomes = (t: Live, agentId: string, state: SessionState): void => {
    t.sessions.set(agentId, state);
    for (const listener of t.sessionListeners) listener(agentId, state);
  };

  it.each<[string, SessionState]>([
    ['exits', { ...initialSessionState('a1'), activity: 'exited', exitCode: 0 }],
    // `stopped` is what a host reconnect reports for a session that is simply not there any more.
    ['stops', initialSessionState('a1')],
  ])('a run whose session %s under it is cancelled then and there, not left listening for words it can only drop', async (_how, endState) => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    t.dictation.report({ runId: t.dictation.lastRun(), state: recording('half a'), outcome: null });
    sessionBecomes(t, 'a1', endState);
    expect(t.dictation.calls).toEqual(['start', 'cancel']);
  });

  it('cancels nothing for another agent’s session ending, for a live change, or once the run is over', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    t.dictation.report({ runId: run, state: recording('still going'), outcome: null });
    // a2 is not the run's agent.
    sessionBecomes(t, 'a2', { ...initialSessionState('a2'), activity: 'exited', exitCode: 1 });
    // A change that leaves a PTY behind it — a permission prompt, a turn ending — is not an end.
    sessionBecomes(t, 'a1', { ...initialSessionState('a1'), activity: 'needs-permission', pid: 101 });
    sessionBecomes(t, 'a1', { ...initialSessionState('a1'), activity: 'waiting', pid: 101 });
    expect(t.dictation.calls).toEqual(['start']);
    // The run ends; a session ending afterwards has no run left to cancel.
    t.dictation.report(ended(run, { kind: 'cancelled' }));
    sessionBecomes(t, 'a1', { ...initialSessionState('a1'), activity: 'exited', exitCode: 0 });
    expect(t.dictation.calls).toEqual(['start']);
  });

  it('stamps every event with the agent its run was started for — a later run for ANOTHER agent never carries the first one’s id', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const first = t.dictation.lastRun();
    t.dictation.report({ runId: first, state: recording('one'), outcome: null });
    t.dictation.report(ended(first, { kind: 'write', text: 'one' }));
    const firstCount = events(t).length;

    await t.h['dictation:start']({ agentId: 'a2' });
    const second = t.dictation.lastRun();
    expect(second).not.toBe(first);
    t.dictation.report({ runId: second, state: recording('two'), outcome: null });
    t.dictation.report({ runId: second, state: { phase: 'finalizing', partial: 'two' }, outcome: null });
    t.dictation.report(ended(second, { kind: 'write', text: 'two' }));

    const all = events(t);
    expect(all.slice(0, firstCount).map((e) => [e.agentId, e.state.phase])).toEqual([['a1', 'starting'], ['a1', 'recording'], ['a1', 'idle']]);
    expect(all.slice(firstCount).map((e) => [e.agentId, e.state.phase])).toEqual([['a2', 'starting'], ['a2', 'recording'], ['a2', 'finalizing'], ['a2', 'idle']]);
    // And each transcript went into its own agent's session.
    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: 'one' }, { t: 'write', id: 'a2', data: 'two' }]);
  });

  it('a start refused as DICTATION_BUSY does not lend its agent to the run that is still going', async () => {
    const t = live();
    await t.h['dictation:start']({ agentId: 'a1' });
    const run = t.dictation.lastRun();
    const refused = await t.h['dictation:start']({ agentId: 'a2' }).catch((e: unknown) => e);
    expect(toIpcError(refused)).toEqual({ code: 'DICTATION_BUSY', message: 'Dictation is still running. Wait for it to finish.' });

    t.dictation.report({ runId: run, state: recording('still a1'), outcome: null });
    t.dictation.report(ended(run, { kind: 'write', text: 'still a1' }));
    expect(events(t).map((e) => e.agentId)).toEqual(['a1', 'a1', 'a1']);
    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: 'still a1' }]);
  });

  it('an update no start claimed is dropped rather than stamped with a guess — a straggler from an ended run included', async () => {
    // One handler instance throughout: the guard lives in its closure. The service is the fake, with
    // one addition — `start()` can be made to deliver a straggler from an old run FIRST, while the
    // new start's claim is waiting, which the real service says it never does.
    const fake = fakeDictation();
    let straggler: DictationUpdate | null = null;
    const t = live((onUpdate) => {
      const service = fake.create(onUpdate);
      return {
        ...service,
        start: () => {
          if (straggler !== null) onUpdate(straggler);
          return service.start();
        },
      };
    });

    // No start at all: nobody's run, so nobody's event.
    fake.report({ runId: 41, state: recording('whose?'), outcome: null });
    expect(events(t)).toEqual([]);

    await t.h['dictation:start']({ agentId: 'a1' });
    const first = fake.lastRun();
    fake.report(ended(first, { kind: 'cancelled' }));
    straggler = { runId: first, state: recording('late'), outcome: null };
    await t.h['dictation:start']({ agentId: 'a2' });

    // a2's run is claimed by ITS first update, and the straggler went nowhere.
    expect(events(t).map((e) => [e.agentId, e.state.phase])).toEqual([['a1', 'starting'], ['a1', 'idle'], ['a2', 'starting']]);
    expect(t.warnings.filter((w) => w.startsWith('dictation: an update for run'))).toHaveLength(2);
  });

  it('start is refused without a host, without the agent and without a live session — and nothing is started', async () => {
    const t = live();
    t.connected.value = false;
    await expect(t.h['dictation:start']({ agentId: 'a1' })).rejects.toMatchObject({ code: 'HOST_DOWN' });
    t.connected.value = true;
    await expect(t.h['dictation:start']({ agentId: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Never started: no PTY at all.
    t.sessions.delete('a1');
    const refused = await t.h['dictation:start']({ agentId: 'a1' }).catch((e: unknown) => e);
    expect(toIpcError(refused)).toEqual({ code: 'NOT_RUNNING', message: 'the agent has no running session to dictate into' });
    // Exited: a PTY that has gone, exit code kept.
    t.sessions.set('a1', { ...initialSessionState('a1'), activity: 'exited', exitCode: 1 });
    await expect(t.h['dictation:start']({ agentId: 'a1' })).rejects.toMatchObject({ code: 'NOT_RUNNING' });

    expect(t.dictation.calls).toEqual([]);
    expect(events(t)).toEqual([]);
  });

  it('stop and cancel go to the service, and need neither a host nor a session — cancel is what lets go of the microphone', async () => {
    const t = live();
    t.connected.value = false;
    t.sessions.clear();
    await t.h['dictation:stop']();
    await t.h['dictation:cancel']();
    expect(t.dictation.calls).toEqual(['stop', 'cancel']);
  });

  it('with the real service: a helper that is not there ends as NOT_BUILT, for the agent that started it, and writes nothing', async () => {
    let service: DictationService | null = null;
    const t = live((onUpdate) => {
      service = createDictationService({ helperPath: join(tempDir('dictate-missing'), 'hangar-dictate'), env: TEST_ENV, onUpdate, log: () => {} });
      return service;
    });
    onTestFinished(async () => { await service?.dispose(); });
    await t.h['dictation:start']({ agentId: 'a2' });
    await service!.reaped();

    const outcome: DictationOutcome = { kind: 'error', code: 'NOT_BUILT', message: dictationMessage('NOT_BUILT') };
    expect(events(t)).toEqual([
      { agentId: 'a2', state: { phase: 'starting' }, outcome: null },
      { agentId: 'a2', state: { phase: 'idle', outcome }, outcome },
    ]);
    expect(t.sent).toEqual([]);
  });

  it('with the real service and a real helper process: the final reaches the pane once, cleaned, with no newline', async () => {
    const dir = tempDir('dictate-helper');
    const helper = join(dir, 'hangar-dictate');
    // A helper that says `ready`, waits for `stop`, and answers with a partial and a final whose text
    // carries a run of spaces and a trailing newline — both of which `textToWrite` removes.
    writeFileSync(helper, [
      `#!${process.execPath}`,
      `const out = (o) => new Promise((r) => process.stdout.write(JSON.stringify(o) + '\\n', r));`,
      `out({ t: 'ready' });`,
      `process.stdin.on('data', async (d) => {`,
      `  if (!String(d).includes('stop')) return;`,
      `  await out({ t: 'partial', text: 'fix the flaky' });`,
      `  await out({ t: 'final', text: ${JSON.stringify('fix the   flaky test\n')} });`,
      `  process.exit(0);`,
      `});`,
      `process.stdin.on('end', () => process.exit(0));`,
      '',
    ].join('\n'));
    chmodSync(helper, 0o755);
    let service: DictationService | null = null;
    const t = live((onUpdate) => {
      service = createDictationService({ helperPath: helper, env: TEST_ENV, onUpdate, log: () => {} });
      return service;
    });
    onTestFinished(async () => { await service?.dispose(); });

    await t.h['dictation:start']({ agentId: 'a1' });
    await vi.waitFor(() => expect(events(t).at(-1)?.state.phase).toBe('recording'), { timeout: 5_000 });
    await t.h['dictation:stop']();
    await service!.reaped();

    expect(t.sent).toEqual([{ t: 'write', id: 'a1', data: 'fix the flaky test' }]);
    expect(new Set(events(t).map((e) => e.agentId))).toEqual(new Set(['a1']));
    expect(events(t).filter((e) => e.outcome !== null).map((e) => e.outcome)).toEqual([{ kind: 'write', text: 'fix the flaky test' }]);
  });
});

describe('toIpcError', () => {
  it('preserves codes from known errors and wraps unknowns', () => {
    expect(toIpcError(new StoreError('NAME_TAKEN', 'taken'))).toEqual({ code: 'NAME_TAKEN', message: 'taken' });
    expect(toIpcError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(toIpcError('str')).toEqual({ code: 'INTERNAL', message: 'str' });
  });
  it('drops a non-string code, which is what git.ts relies on', () => {
    // `GitError` carries `code: 'GIT'` precisely so it survives this; an exit status left in `code`
    // as a number must fall back to INTERNAL rather than reach the renderer as `code: 128`.
    const numeric = Object.assign(new Error('git exploded'), { code: 128 });
    expect(toIpcError(numeric)).toEqual({ code: 'INTERNAL', message: 'git exploded' });
    const symbolic = Object.assign(new Error('nope'), { code: Symbol('x') });
    expect(toIpcError(symbolic)).toEqual({ code: 'INTERNAL', message: 'nope' });
    // a string `detail` rides along; a non-string one is dropped rather than stringified
    expect(toIpcError(Object.assign(new Error('m'), { code: 'C', detail: 'd' }))).toEqual({ code: 'C', message: 'm', detail: 'd' });
    expect(toIpcError(Object.assign(new Error('m'), { code: 'C', detail: { a: 1 } }))).toEqual({ code: 'C', message: 'm' });
  });
});
