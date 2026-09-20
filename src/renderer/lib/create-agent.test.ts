/**
 * The four-step create sequence, away from any dialog. Every behaviour pinned here was learned in
 * `NewAgentDialog` first (`dialogs.test.tsx` → "New agent — from a ticket draft", which still runs
 * the same cases through the mounted dialog); this file is what stops the whole-cycle run's second
 * caller from drifting away from them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests, ProgressEvent } from '../../../shared/ipc-contract.ts';
import { defaultLayout, defaultProjectSetup, emptyWorkspace, type Agent, type Folder, type Project, type WorkspaceSnapshot } from '../../../shared/types.ts';

const ISO = '2026-09-17T10:00:00.000Z';

const project = (id: string, name: string, repoPath: string, defaultBranch = 'main'): Project => ({
  id, name, repoPath, defaultBranch, setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const CREATED: Agent = {
  id: 'a-new', name: 'AC-1368 fix the thing', slug: 'ac-1368-fix-the-thing', folderId: 'f-cycle', sortKey: 0, notes: '',
  workspaces: [{ id: 'w1', projectId: 'p1', branch: 'agent/ac-1368-fix-the-thing', worktreePath: '/wt/x', baseRef: 'main', createdAt: ISO }],
  claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] }, createdAt: ISO, lastOpenedAt: null,
};

const FOLDERS: Folder[] = [{ id: 'f-cycle', name: 'Cycle 33', parentId: null, sortKey: 0, collapsed: false }];

/**
 * `opId` and `message` are required on a real `agent:progress` payload, so the fakes carry them —
 * and `opId` is what one operation's events are told apart BY (`agent-service.ts` mints one per
 * operation), so every fake event names the operation it belongs to.
 */
const ev = (opId: string, agentId: string, step: string, status: ProgressEvent['status'] = 'done'): ProgressEvent =>
  ({ agentId, opId, step, status, message: `${step} ${status}` });
const saved = (): ProgressEvent => ev('op-1', 'a-new', 'saved');

interface Stub<K extends IpcRequestKey> { reply: IpcReply<IpcRequests[K]['res']>; gate?: Promise<unknown> }
type Stubs = { [K in IpcRequestKey]?: Stub<K> };

function snapshot(patch: Partial<WorkspaceSnapshot['workspace']> = {}): WorkspaceSnapshot {
  return {
    workspace: { ...emptyWorkspace(), projects: [project('p1', 'hangar', '/repos/hangar')], folders: [], agents: [], layout: defaultLayout(), ...patch },
    sessions: {}, runtime: {}, host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null }, profile: { home: '/h', isDefault: true },
  };
}

async function load(stubs: Stubs, snap: WorkspaceSnapshot = snapshot()) {
  const calls: { channel: IpcRequestKey; payload: unknown }[] = [];
  const listeners = new Map<string, ((p: never) => void)[]>();
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const stub = stubs[channel];
      if (stub === undefined) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return stub.gate === undefined ? Promise.resolve(stub.reply) : stub.gate.then(() => stub.reply);
    },
    on<K extends IpcEventKey>(channel: K, handler: (p: IpcEvents[K]) => void): () => void {
      const erased = handler as (p: never) => void;
      listeners.set(channel, [...(listeners.get(channel) ?? []), erased]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  /** Changes an answer BETWEEN calls, which a fixed map cannot — two overlapping creates need two. */
  const setStub = <K extends IpcRequestKey>(channel: K, stub: Stub<K>): void => {
    // `Stubs` is a MAPPED type, so a write under a generic `K` widens to the intersection of every
    // key's stub type; the assertion narrows the view to the one key being written.
    (stubs as Record<K, Stub<K>>)[channel] = stub;
  };
  vi.resetModules();
  const [mod, workspace] = await Promise.all([import('./create-agent.ts'), import('../stores/workspace.ts')]);
  workspace.useWorkspace.getState().setSnapshot(snap);
  const emit = (p: ProgressEvent): void => { for (const h of listeners.get('agent:progress') ?? []) (h as (e: ProgressEvent) => void)(p); };
  /**
   * How many `agent:progress` handlers are subscribed RIGHT NOW. This is the probe that makes a
   * missing `stopRecording()` fail: without it the count never comes back down, and asserting only
   * that a late event does not throw cannot see the leak at all.
   */
  const subscribed = (): number => (listeners.get('agent:progress') ?? []).length;
  return { ...mod, calls, emit, subscribed, setStub, workspace };
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => { resolve = () => r(); });
  return { promise, resolve };
};


const ok = <K extends IpcRequestKey>(value: IpcRequests[K]['res']): Stub<K> => ({ reply: { ok: true, value } });

beforeEach(() => { vi.resetModules(); });

describe('createAgentSequence', () => {
  it('registers a will-be-added repo, makes the folder, creates the agent and saves its notes', async () => {
    const t = await load({
      'project:add': ok<'project:add'>(project('p2', 'acme-frontend', '/repos/acme-frontend', 'stage')),
      'folder:create': ok<'folder:create'>(FOLDERS[0]!),
      'agent:create': ok<'agent:create'>(CREATED),
      'agent:update': ok<'agent:update'>(CREATED),
    });
    const out = await t.createAgentSequence({
      name: 'AC-1368 fix the thing',
      folder: { kind: 'new', name: 'Cycle 33' },
      rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }, { kind: 'new', repoPath: '/repos/acme-frontend', name: 'acme-frontend', baseBranch: '' }],
      notes: 'AC-1368 — fix the thing',
      permissionMode: null,
      startNow: false,
    });

    expect(out).toMatchObject({ ok: true, agent: CREATED, notesFailed: null });
    expect(t.calls.map((c) => c.channel)).toEqual(['project:add', 'folder:create', 'agent:create', 'agent:update']);
    expect(t.calls[2]?.payload).toEqual({
      name: 'AC-1368 fix the thing',
      folderId: 'f-cycle',
      // The registered repo keeps the typed base (none); the new one falls back to the project's own.
      workspaces: [{ projectId: 'p1', baseBranch: null }, { projectId: 'p2', baseBranch: 'stage' }],
      permissionMode: null,
      startNow: false,
    });
  });

  it('reuses a top-level folder of that name instead of making a second one', async () => {
    const t = await load({ 'agent:create': ok<'agent:create'>(CREATED) }, snapshot({ folders: FOLDERS }));
    const out = await t.createAgentSequence({ name: 'X', folder: { kind: 'new', name: 'Cycle 33' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: '', permissionMode: null, startNow: false });
    expect(out.ok).toBe(true);
    expect(t.calls.map((c) => c.channel)).toEqual(['agent:create']);
    expect(t.calls[0]?.payload).toMatchObject({ folderId: 'f-cycle' });
  });

  it('treats PROJECT_EXISTS as a success and finds the project by repoPath', async () => {
    const t = await load(
      { 'project:add': { reply: { ok: false, error: { code: 'PROJECT_EXISTS', message: 'already registered' } } }, 'agent:create': ok<'agent:create'>(CREATED) },
      snapshot({ projects: [project('p1', 'hangar', '/repos/hangar'), project('p9', 'acme-frontend', '/repos/acme-frontend', 'stage')] }),
    );
    const out = await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'new', repoPath: '/repos/acme-frontend', name: 'acme-frontend', baseBranch: '' }], notes: '', permissionMode: null, startNow: false });
    expect(out).toMatchObject({ ok: true });
    expect(t.calls[1]?.payload).toMatchObject({ workspaces: [{ projectId: 'p9', baseBranch: 'stage' }] });
  });

  it('stops at the first failure and names the row it was in', async () => {
    const t = await load({ 'project:add': { reply: { ok: false, error: { code: 'NOT_A_REPO', message: 'not a git repository', detail: '/repos/nope' } } } });
    const out = await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'new', repoPath: '/repos/nope', name: 'nope', baseBranch: '' }], notes: '', permissionMode: null, startNow: false });
    expect(out).toEqual({ ok: false, message: 'nope: not a git repository\n/repos/nope', saved: false, agentId: null });
    expect(t.calls.map((c) => c.channel)).toEqual(['project:add']);
  });

  it('reports an agent that was SAVED but failed afterwards, so nobody retries it into a second one', async () => {
    const t = await load({ 'agent:create': { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'the session host is not connected' } } } });
    const started = t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: '', permissionMode: null, startNow: true });
    t.emit(saved());
    expect(await started).toEqual({ ok: false, message: 'the session host is not connected', saved: true, agentId: 'a-new' });
  });

  it('does not roll the agent back when only its notes fail', async () => {
    const t = await load({
      'agent:create': ok<'agent:create'>(CREATED),
      'agent:update': { reply: { ok: false, error: { code: 'NOT_FOUND', message: 'no agent' } } },
    });
    const out = await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: 'some notes', permissionMode: null, startNow: false });
    expect(out).toMatchObject({ ok: true, agent: CREATED, notesFailed: 'no agent' });
  });

  it('sends no notes update at all for empty notes', async () => {
    const t = await load({ 'agent:create': ok<'agent:create'>(CREATED) });
    await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: '   ', permissionMode: null, startNow: false });
    expect(t.calls.map((c) => c.channel)).toEqual(['agent:create']);
  });

  it('trims the name it sends, so a caller composing one from a ticket need not', async () => {
    const t = await load({ 'agent:create': ok<'agent:create'>(CREATED) });
    await t.createAgentSequence({ name: '  AC-1368 fix the thing\n', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: '', permissionMode: null, startNow: false });
    expect(t.calls[0]?.payload).toMatchObject({ name: 'AC-1368 fix the thing' });
  });

  /**
   * The `agent:progress` subscription is RELEASED, counted rather than inferred. Asserting that a
   * late event does not throw is blind to a leak: the handler goes on working perfectly, forever.
   */
  it('releases its agent:progress subscription, on success and on failure alike', async () => {
    const t = await load({ 'agent:create': ok<'agent:create'>(CREATED), 'agent:update': ok<'agent:update'>(CREATED) });
    expect(t.subscribed()).toBe(0);
    await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: 'n', permissionMode: null, startNow: false });
    expect(t.subscribed()).toBe(0);

    t.setStub('agent:create', { reply: { ok: false, error: { code: 'LOW_DISK', message: 'not enough free space' } } });
    await t.createAgentSequence({ name: 'X', folder: { kind: 'root' }, rows: [{ kind: 'existing', projectId: 'p1', baseBranch: '' }], notes: '', permissionMode: null, startNow: false });
    expect(t.subscribed()).toBe(0);
    // A late event has nowhere to land, and nothing throws.
    expect(() => t.emit(saved())).not.toThrow();
  });

  /**
   * The case the whole-cycle run makes reachable: the run's creates are sequential, but the New
   * Agent dialog is still open while it runs, so two sequences can record at once. Each must answer
   * from its OWN operation — measured wrong before the `opId` claim: the run's failed create took
   * the dialog's `saved` step (and would then refuse a Retry that rollback had made safe), and the
   * dialog's outcome named the run's agent id.
   */
  it('keeps two overlapping creates apart, each answering from its own operation', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const t = await load({ 'agent:create': { reply: { ok: false, error: { code: 'BASE_NOT_FOUND', message: 'branch "nope" was not found' } }, gate: gateA.promise } });
    const row = [{ kind: 'existing' as const, projectId: 'p1', baseBranch: '' }];

    const a = t.createAgentSequence({ name: 'A', folder: { kind: 'root' }, rows: row, notes: '', permissionMode: null, startNow: true });
    t.setStub('agent:create', { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'the session host is not connected' } }, gate: gateB.promise });
    const b = t.createAgentSequence({ name: 'B', folder: { kind: 'root' }, rows: row, notes: '', permissionMode: null, startNow: true });
    // The control for the probe above: both are listening while they are in flight.
    expect(t.subscribed()).toBe(2);

    // A's create gets as far as a worktree and then rolls back; B's commits its agent and fails to start.
    t.emit(ev('op-A', 'a-A', 'hangar: worktree', 'running'));
    t.emit(ev('op-B', 'a-B', 'saved'));
    gateA.resolve();
    gateB.resolve();

    // A did NOT see a `saved` of its own, so a Retry is safe and must stay on offer.
    expect(await a).toEqual({ ok: false, message: 'branch "nope" was not found', saved: false, agentId: 'a-A' });
    // B answers with its OWN agent, never A's.
    expect(await b).toEqual({ ok: false, message: 'the session host is not connected', saved: true, agentId: 'a-B' });
    expect(t.subscribed()).toBe(0);
  });

  /** The claim is released too, or the next create would skip its own events. */
  it('lets a later sequence claim an operation the earlier one has finished with', async () => {
    const t = await load({ 'agent:create': { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'down' } } } });
    const req = { name: 'X', folder: { kind: 'root' as const }, rows: [{ kind: 'existing' as const, projectId: 'p1', baseBranch: '' }], notes: '', permissionMode: null, startNow: true };
    const first = t.createAgentSequence(req);
    t.emit(ev('op-1', 'a-1', 'saved'));
    expect(await first).toMatchObject({ saved: true, agentId: 'a-1' });

    const second = t.createAgentSequence(req);
    t.emit(ev('op-1', 'a-1', 'saved'));
    expect(await second).toMatchObject({ saved: true, agentId: 'a-1' });
  });
});
