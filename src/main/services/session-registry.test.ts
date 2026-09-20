import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import type { HostClient, HostClientEvents } from './host-client.ts';
import type { HostMessage, RequestMessage } from '../../../shared/host-protocol.ts';
import { applyNote, createSessionRegistry, formatNoteLine, type SessionRegistry } from './session-registry.ts';
import { createWorkspaceStore, type WorkspaceStore } from './workspace-store.ts';
import { addProject, createAgent, deleteAgent } from './workspace-ops.ts';
import { defaultProjectSetup, initialSessionState, type Agent, type SessionState } from '../../../shared/types.ts';
import { reduceSession } from '../../../shared/status.ts';
import { NOTE_MAX } from '../../../shared/constants.ts';
import type { IpcEvents } from '../../../shared/ipc-contract.ts';
import { join } from 'node:path';

type Handlers = { [K in keyof HostClientEvents]: HostClientEvents[K][] };
type Reply = (m: RequestMessage) => Promise<HostMessage>;

function fakeHostClient(reply: Reply): { client: HostClient; fire: <K extends keyof HostClientEvents>(k: K, ...args: Parameters<HostClientEvents[K]>) => void; sent: RequestMessage[]; listeners: () => number } {
  const handlers: Handlers = { data: [], title: [], bell: [], exit: [], snapshot: [], agentEvent: [], connected: [], disconnected: [], hostError: [] };
  const sent: RequestMessage[] = [];
  const client = {
    connect: async () => ({ version: 1, hostPid: 1, sessions: [] }),
    request: async (m: RequestMessage) => {
      sent.push(m);
      return reply(m);
    },
    send: () => {},
    on: <K extends keyof HostClientEvents>(k: K, fn: HostClientEvents[K]) => {
      handlers[k].push(fn);
      return () => {
        handlers[k] = handlers[k].filter((f) => f !== fn) as Handlers[K];
      };
    },
    isConnected: () => true,
    close: () => {},
    // `satisfies`, not `as unknown as`: the double cast hid every method this fake does not
    // implement, so a new or renamed `HostClient` method would compile here and fail at runtime.
  } satisfies HostClient;
  const listeners = (): number => Object.values(handlers).reduce((n, list) => n + list.length, 0);
  return { client, sent, listeners, fire: (k, ...args) => { for (const fn of [...handlers[k]]) (fn as (...a: unknown[]) => void)(...args); } };
}

// Each setup() leaves a live debounce timer in its store; flush it so the suite does not hold the
// event loop open with one timer per test.
const open: { store: WorkspaceStore; registry: SessionRegistry }[] = [];
afterEach(() => {
  for (const o of open) {
    o.registry.dispose();
    o.store.flush();
  }
  open.length = 0;
});

function setup(opts: { reply?: Reply } = {}) {
  const dir = tempDir('reg');
  const store = createWorkspaceStore({ file: join(dir, 'w.json'), bakFile: join(dir, 'w.bak'), debounceMs: 10 });
  store.load();
  const agent: Agent = {
    id: 'a1', name: 'One', slug: 'one', folderId: null, sortKey: 0, notes: '', createdAt: 'x', lastOpenedAt: null,
    workspaces: [{ id: 'w', projectId: 'p1', branch: 'agent/one', worktreePath: '/wt', baseRef: 'origin/main', createdAt: 'x' }],
    claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  };
  store.update((ws) => createAgent(addProject(ws, { id: 'p1', name: 'P', repoPath: '/r', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: 'x' }), agent));
  const emitted: { k: string; p: unknown }[] = [];
  const logged: string[] = [];
  const observed: { agentId: string; state: SessionState }[] = [];
  const { client, fire, sent, listeners } = fakeHostClient(opts.reply ?? (async () => ({ t: 'ok' as const })));
  let now = 1000;
  const registry = createSessionRegistry({
    hostClient: client,
    store,
    emit: <K extends keyof IpcEvents>(k: K, p: IpcEvents[K]) => emitted.push({ k, p }),
    onState: (agentId, state) => observed.push({ agentId, state }),
    log: (line) => logged.push(line),
    now: () => now,
    clock: () => new Date('2026-09-07T12:34:00.000Z'),
  });
  open.push({ store, registry });
  return { store, registry, emitted, logged, observed, fire, sent, listeners, tick: (ms: number) => (now += ms) };
}

// `request()` is async and its reply is itself a promise, so the re-attach `.then()` settles a few
// microtask turns later. `setImmediate` drains all of them; a fixed number of `await Promise.resolve()`
// is a guess that silently under-awaits.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const live = (over: Partial<{ exited: boolean; exitCode: number | null; title: string; cols: number; rows: number }> = {}) => ({
  id: 'a1', pid: 9, cwd: '/wt', cols: 80, rows: 24, startedAt: 'x', exited: false, signal: null, exitCode: null, title: 'T', attached: 0, ...over,
});

describe('createSessionRegistry', () => {
  it('starts every agent as stopped and applies events with broadcasts', () => {
    const { registry, emitted } = setup();
    expect(registry.get('a1').activity).toBe('stopped');
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    expect(registry.get('a1')).toMatchObject({ activity: 'starting', pid: 7 });
    expect(emitted.at(-1)).toMatchObject({ k: 'session:state', p: { agentId: 'a1', state: { activity: 'starting' } } });
    expect(registry.all()).toEqual({ a1: registry.get('a1') });
  });

  it('forwards host data/title/bell/exit into state and renderer events', () => {
    const { registry, emitted, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('data', 'a1', 'hello');
    expect(emitted.some((e) => e.k === 'session:data' && (e.p as { data: string }).data === 'hello')).toBe(true);
    expect(registry.get('a1').activity).toBe('working');
    fire('title', 'a1', 'T');
    expect(registry.get('a1').title).toBe('T');
    expect(emitted.some((e) => e.k === 'session:title')).toBe(true);
    fire('snapshot', 'a1', 'painted', 'T2');
    expect(emitted.at(-1)).toMatchObject({ k: 'session:snapshot', p: { agentId: 'a1', data: 'painted', title: 'T2' } });
    fire('exit', 'a1', 2, null);
    expect(registry.get('a1')).toMatchObject({ activity: 'exited', exitCode: 2 });
  });

  // The only thing stopping a deleted agent's PTY output reaching the renderer. The original probe
  // here was `fire('data', 'unknown-agent', 'x'); // ignored, no throw`, which asserted nothing:
  // every one of the six guards could be deleted with the suite green.
  it('ignores every host event for an agent that is not in the workspace', () => {
    const { registry, emitted, store, fire } = setup();
    const fireAll = (id: string): void => {
      fire('data', id, 'x');
      fire('snapshot', id, 'x', 't');
      fire('title', id, 't');
      fire('bell', id);
      fire('exit', id, 0, null);
      fire('agentEvent', id, 'event', { hook_event_name: 'Stop' }, 'now');
      fire('agentEvent', id, 'rename', { name: 'nope' }, 'now');
    };
    emitted.length = 0;
    fireAll('unknown-agent');
    expect(emitted).toEqual([]);
    expect(registry.get('unknown-agent')).toEqual(initialSessionState('unknown-agent'));

    // Then a DELETED agent, left mid-session on purpose. A `stopped` state absorbs a bell silently
    // (the reducer ignores it in a terminal activity), so testing only the never-seen id above lets
    // the bell guard be deleted with the suite green.
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('data', 'a1', 'x');
    registry.setWindowFocused(false);
    const before = registry.get('a1');
    expect(before.activity).toBe('working');
    store.update((ws) => deleteAgent(ws, 'a1'));
    emitted.length = 0;
    fireAll('a1');
    expect(emitted).toEqual([]);
    expect(registry.get('a1')).toEqual(before);
  });

  it('maps agentEvent event/rename/note', () => {
    const { registry, store, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'UserPromptSubmit' }, 'now');
    expect(registry.get('a1')).toMatchObject({ activity: 'working', hooksSeen: true });
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }, 'now');
    expect(registry.get('a1').activity).toBe('needs-permission');
    fire('agentEvent', 'a1', 'rename', { name: 'Renamed by agent' }, 'now');
    expect(store.get().agents[0]!.name).toBe('Renamed by agent');
    fire('agentEvent', 'a1', 'note', { mode: 'append', text: 'first' }, 'now');
    fire('agentEvent', 'a1', 'note', { mode: 'append', text: 'second' }, 'now');
    expect(store.get().agents[0]!.notes).toBe('- [12:34] first\n- [12:34] second');
    fire('agentEvent', 'a1', 'note', { mode: 'replace', text: 'only' }, 'now');
    expect(store.get().agents[0]!.notes).toBe('only');
    fire('agentEvent', 'a1', 'note', { mode: 'clear', text: '' }, 'now');
    expect(store.get().agents[0]!.notes).toBe('');
  });

  // Spec §12. `/clear`, `/resume` and plan mode's "clear context" start a new session id without
  // exiting, and `SessionStart` is the only hook that reports it. Measured on a real profile: an agent
  // launched with one id had its conversation under another, and Resume named a transcript that did
  // not exist.
  describe('SessionStart adopts the session id', () => {
    const NEXT = 'd070c671-1892-4d68-a82c-e2f99c8f8f9f';

    it('stores a new UUID from SessionStart and marks the agent as started', () => {
      const { registry, store, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT }, 'now');
      expect(store.get().agents[0]!.claude).toMatchObject({ sessionId: NEXT, hasStartedOnce: true });
    });

    it('ignores session_id on every other hook', () => {
      const { registry, store, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      for (const name of ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']) {
        fire('agentEvent', 'a1', 'event', { hook_event_name: name, session_id: NEXT }, 'now');
      }
      expect(store.get().agents[0]!.claude.sessionId).toBe('s');
    });

    it('ignores a missing or non-UUID session_id', () => {
      const { registry, store, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      for (const session_id of [undefined, 42, '', 'sess-1', `${NEXT}\n`, `x${NEXT}`]) {
        fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id }, 'now');
      }
      expect(store.get().agents[0]!.claude).toMatchObject({ sessionId: 's', hasStartedOnce: false });
    });

    it('makes no store write when the id is unchanged', () => {
      const { registry, store, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT }, 'now');
      let writes = 0;
      const off = store.subscribe(() => { writes += 1; });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT }, 'now');
      off();
      expect(writes).toBe(0);
    });

    // Claude writes lowercase ids, but the regex accepts either case: an uppercase copy of the
    // current id must not count as a switch (and write + broadcast), and must never be stored as-is.
    it('lowercases the id, so an uppercase copy of the current one is not a change', () => {
      const { registry, store, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT.toUpperCase() }, 'now');
      expect(store.get().agents[0]!.claude.sessionId).toBe(NEXT);
      let writes = 0;
      const off = store.subscribe(() => { writes += 1; });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT.toUpperCase() }, 'now');
      off();
      expect(writes).toBe(0);
    });

    it('logs the adoption once, and nothing for an unchanged id', () => {
      const { registry, logged, fire } = setup();
      registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT }, 'now');
      fire('agentEvent', 'a1', 'event', { hook_event_name: 'SessionStart', session_id: NEXT }, 'now');
      expect(logged.filter((l) => l.startsWith('session id for'))).toEqual([`session id for a1: s → ${NEXT} (SessionStart)`]);
    });
  });

  // `reduceSession`'s `case 'hook'` has no trailing return on purpose, so an unrecognised name does
  // not fall out harmlessly — it falls THROUGH into `case 'bell'` and raises an unread badge.
  // Relaxing the guard to `typeof name === 'string'` must not pass.
  it('drops an unrecognised hook name rather than falling through to the bell case', () => {
    const { registry, emitted, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    registry.setWindowFocused(false);
    emitted.length = 0;
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'PreToolUse' }, 'now');
    expect(registry.get('a1')).toMatchObject({ activity: 'starting', unread: false, hooksSeen: false });
    expect(emitted).toEqual([]);
  });

  it('sanitises a hostile rename payload', () => {
    const { store, fire } = setup();
    fire('agentEvent', 'a1', 'rename', { name: 'x'.repeat(500) }, 'now');
    expect(store.get().agents[0]!.name).toBe('x'.repeat(80));
    fire('agentEvent', 'a1', 'rename', { name: 'ev\u001b[2Jil' }, 'now');
    expect(store.get().agents[0]!.name).toBe('ev [2Jil');
    fire('agentEvent', 'a1', 'rename', { name: '   ' }, 'now');
    expect(store.get().agents[0]!.name).toBe('ev [2Jil'); // an all-blank name is ignored, not stored
    fire('agentEvent', 'a1', 'rename', { name: 42 }, 'now');
    expect(store.get().agents[0]!.name).toBe('ev [2Jil');
  });

  // The host types the `cli` payload `z.unknown()` and relays it unvalidated, and the workspace
  // schema types `notes` as an unbounded string — so this module is the only cap before disk.
  it('clamps and sanitises a hostile note payload', () => {
    const { store, fire } = setup();
    fire('agentEvent', 'a1', 'note', { mode: 'replace', text: 'a'.repeat(NOTE_MAX * 3) }, 'now');
    expect(store.get().agents[0]!.notes.length).toBe(NOTE_MAX);
    fire('agentEvent', 'a1', 'note', { mode: 'append', text: 'b'.repeat(NOTE_MAX) }, 'now');
    expect(store.get().agents[0]!.notes.length).toBe(NOTE_MAX); // appends cannot grow it past the cap
    fire('agentEvent', 'a1', 'note', { mode: 'replace', text: 'esc\u001b[2K' }, 'now');
    expect(store.get().agents[0]!.notes).toBe('esc [2K'); // `hangar status` prints notes to a terminal
  });

  it('resetFromHello rebuilds states; ticking decays working → idle without hooks', () => {
    const { registry, emitted, fire, tick } = setup();
    fire('connected', { version: 1, hostPid: 1, sessions: [live()] });
    expect(registry.get('a1')).toMatchObject({ activity: 'idle', pid: 9, title: 'T', hooksSeen: false });
    expect(emitted).toEqual([{ k: 'session:state', p: { agentId: 'a1', state: registry.get('a1') } }]);
    fire('data', 'a1', 'out');
    expect(registry.get('a1').activity).toBe('working');
    tick(5000);
    registry.tick();
    expect(registry.get('a1').activity).toBe('idle');
    fire('connected', { version: 1, hostPid: 1, sessions: [live({ exited: true, exitCode: 0, title: '' })] });
    expect(registry.get('a1')).toMatchObject({ activity: 'exited', exitCode: 0 });
    fire('connected', { version: 1, hostPid: 1, sessions: [] });
    expect(registry.get('a1').activity).toBe('stopped');
  });

  it('carries unread, attachedPane and hooksSeen across a reconnect', () => {
    const { registry, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    registry.apply('a1', { kind: 'attached', paneIndex: 1 });
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'UserPromptSubmit' }, 'now');
    registry.setWindowFocused(false);
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'Stop' }, 'now');
    expect(registry.get('a1')).toMatchObject({ unread: true, hooksSeen: true, attachedPane: 1 });

    fire('connected', { version: 1, hostPid: 1, sessions: [live()] });
    expect(registry.get('a1')).toMatchObject({ unread: true, hooksSeen: true, attachedPane: 1 });

    // An exited session keeps the badge — "it crashed while I was away" is the case most worth
    // flagging — but loses `attachedPane`, because there is nothing left to attach to.
    fire('connected', { version: 1, hostPid: 1, sessions: [live({ exited: true, exitCode: 3 })] });
    expect(registry.get('a1')).toMatchObject({ unread: true, attachedPane: null, exitCode: 3 });
  });

  it('window focus affects unread', () => {
    const { registry, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    registry.apply('a1', { kind: 'attached', paneIndex: 0 });
    registry.setWindowFocused(false);
    fire('agentEvent', 'a1', 'event', { hook_event_name: 'Stop' }, 'now');
    expect(registry.get('a1').unread).toBe(true);
  });

  it('exposes the window-focus flag it reduces with', () => {
    // `notifications.ts` reads it from here rather than keeping a second copy — both writers (the
    // window's focus/blur handlers and the `app:windowFocused` handler) go through
    // `setWindowFocused`, and a second copy would only be fed by one of them.
    const { registry } = setup();
    expect(registry.isWindowFocused()).toBe(true); // main assumes focus until told otherwise
    registry.setWindowFocused(false);
    expect(registry.isWindowFocused()).toBe(false);
    registry.setWindowFocused(true);
    expect(registry.isWindowFocused()).toBe(true);
  });

  it('hands onState exactly the session:state broadcasts, and nothing else', () => {
    const { registry, emitted, observed, fire } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('data', 'a1', 'hello');   // one session:data (not observed) + one session:state
    fire('title', 'a1', 'T');      // one session:title (not observed) + one session:state
    fire('exit', 'a1', 2, null);
    const broadcasts = emitted.filter((e) => e.k === 'session:state');
    expect(observed.map((o) => [o.agentId, o.state.activity])).toEqual(broadcasts.map((e) => ['a1', (e.p as { state: SessionState }).state.activity]));
    // starting; the data burst -> working; the title change, still working; the exit.
    expect(observed.map((o) => o.state.activity)).toEqual(['starting', 'working', 'working', 'exited']);
  });

  it('throttles session:state while output streams, and never emits one for an unchanged tick', () => {
    const { registry, emitted, fire, tick } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('data', 'a1', 'first');   // stopped -> working: a real change, broadcast
    emitted.length = 0;
    for (let i = 0; i < 20; i++) {
      tick(16);
      fire('data', 'a1', 'more');
    }
    // 20 `session:data`, and NOT 20 `session:state` — that is the §18 budget the throttle protects.
    expect(emitted.filter((e) => e.k === 'session:data')).toHaveLength(20);
    expect(emitted.filter((e) => e.k === 'session:state')).toHaveLength(0);
    // A tick that changes nothing and follows no new output is silent.
    registry.tick();
    emitted.length = 0;
    registry.tick();
    registry.tick();
    expect(emitted).toEqual([]);
  });

  // §13: the renderer keeps its OWN SessionState, fed only by `session:state`, and runs the same
  // reducer on a local 1 s tick. If main throttles `lastOutputAt` away and never refreshes it, the
  // renderer's copy freezes and decays to `idle` while main still reads `working`.
  it("keeps the renderer's mirror from decaying while output is still flowing", () => {
    const { registry, emitted, fire, tick } = setup();
    let mirror: SessionState = initialSessionState('a1');
    let at = 1000;
    const drain = (): void => {
      for (const e of emitted.splice(0)) if (e.k === 'session:state') mirror = (e.p as { state: SessionState }).state;
    };
    registry.apply('a1', { kind: 'spawned', pid: 7, at });
    fire('data', 'a1', 'x');
    drain();
    for (let second = 0; second < 6; second++) {
      for (let frame = 0; frame < 60; frame++) {
        tick(16);
        at += 16;
        fire('data', 'a1', 'x');
      }
      registry.tick();                                        // main's ticker
      drain();
      mirror = reduceSession(mirror, { kind: 'tick', at });    // the renderer's own 1 s ticker
    }
    expect(registry.get('a1').activity).toBe('working');
    expect(mirror.activity).toBe('working');
    expect(mirror.lastOutputAt).toBe(registry.get('a1').lastOutputAt);
  });

  it('stops broadcasting for an agent deleted from the workspace', () => {
    const { registry, emitted, store, fire, tick } = setup();
    registry.apply('a1', { kind: 'spawned', pid: 7, at: 1 });
    fire('data', 'a1', 'x');
    store.update((ws) => deleteAgent(ws, 'a1'));
    emitted.length = 0;
    tick(9000);
    registry.tick();
    registry.tick();
    expect(emitted).toEqual([]);
  });

  it('dispose() detaches every host-client listener', () => {
    const { registry, emitted, fire, listeners } = setup();
    expect(listeners()).toBeGreaterThan(0);
    registry.dispose();
    expect(listeners()).toBe(0);
    emitted.length = 0;
    fire('data', 'a1', 'x');
    fire('connected', { version: 1, hostPid: 1, sessions: [live()] });
    expect(emitted).toEqual([]);
  });
});

describe('re-attach after a reconnect', () => {
  const snapshotReply: Reply = async (m) => (m.t === 'attach' ? { t: 'snapshot', id: m.id, data: 'REPAINT', title: 'T', re: 1 } : { t: 'ok' });

  // The host FORGETS its attachments across a socket drop (`hello` reports attached:0 for a live
  // session), so carrying `attachedPane` in our own state is not enough — without re-issuing attach
  // the pane stays blank forever and nothing reports it. §8.3 step 5.
  // Plan 02's completion checklist: a CLI relay for an unknown agent must be logged and must not
  // crash. The CLI reports success regardless (it only relays), so a silent drop leaves no trace.
  it('logs a relayed event for an unknown agent instead of dropping it silently', () => {
    const { fire, logged, emitted } = setup();
    const before = emitted.length;
    fire('agentEvent', 'no-such-agent', 'rename', { name: 'Ghost' }, 'now');
    expect(logged.join('\n')).toContain('no-such-agent');
    expect(emitted.length).toBe(before);
  });

  it('re-attaches panes that were attached before the reconnect', async () => {
    const { registry, fire, sent } = setup({ reply: snapshotReply });
    registry.apply('a1', { kind: 'attached', paneIndex: 2 });
    sent.length = 0;
    fire('connected', { version: 1, hostPid: 1, sessions: [live({ cols: 120, rows: 30 })] });
    await flush();
    expect(sent).toEqual([{ t: 'attach', id: 'a1', cols: 120, rows: 30 }]);
    expect(registry.get('a1').attachedPane).toBe(2);

    // An exited session must not be re-attached. What actually prevents it is the exited branch
    // resetting `attachedPane` to null — the `!info.exited` conjunct in the guard is belt-and-braces
    // and is dead today, so assert the mechanism that is really load-bearing rather than the guard.
    sent.length = 0;
    fire('connected', { version: 1, hostPid: 1, sessions: [live({ exited: true, exitCode: 0 })] });
    await flush();
    expect(registry.get('a1').attachedPane).toBeNull();
    expect(sent).toEqual([]);
  });

  // §14: "panes re-attach automatically (snapshot replaces screen)". The reply to `attach` is the
  // only copy of that snapshot the pane will ever be offered — the unsolicited push fires only on
  // respawn-over-an-exited-id — so dropping it leaves the pre-drop screen with new output appended.
  it('delivers the snapshot the host replies with', async () => {
    const { registry, emitted, fire } = setup({ reply: snapshotReply });
    registry.apply('a1', { kind: 'attached', paneIndex: 2 });
    emitted.length = 0;
    fire('connected', { version: 1, hostPid: 1, sessions: [live()] });
    await flush();
    expect(emitted.filter((e) => e.k === 'session:snapshot')).toEqual([
      { k: 'session:snapshot', p: { agentId: 'a1', data: 'REPAINT', title: 'T' } },
    ]);
  });

  // NOT_FOUND (the session died between `hello` and the request) or a TIMEOUT on an otherwise
  // healthy socket leaves the pane blank with no next reconnect to retry on.
  it('reports a failed re-attach instead of failing silently', async () => {
    const { registry, emitted, logged, fire } = setup({ reply: async () => { throw new Error('NOT_FOUND'); } });
    registry.apply('a1', { kind: 'attached', paneIndex: 2 });
    emitted.length = 0;
    fire('connected', { version: 1, hostPid: 1, sessions: [live()] });
    await flush();
    expect(logged.some((l) => l.includes('re-attach failed for a1') && l.includes('NOT_FOUND'))).toBe(true);
    expect(emitted.filter((e) => e.k === 'toast')).toHaveLength(1);
  });
});

describe('formatNoteLine', () => {
  it('prefixes with a HH:MM timestamp', () => {
    expect(formatNoteLine('hi', new Date('2026-09-07T09:05:00.000Z'))).toBe('- [09:05] hi');
  });
  // The suite pins TZ=UTC (vitest.config.ts), where local and UTC minutes always agree — so mixing
  // `getHours()` with `getUTCMinutes()` passes here and renders 14:05 instead of 14:35 in Asia/Kolkata.
  // Half-hour zones are the only thing that can catch it, hence the explicit override.
  it('uses local minutes, not UTC, in a half-hour timezone', () => {
    const before = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try {
      expect(formatNoteLine('hi', new Date('2026-09-07T09:05:00.000Z'))).toBe('- [14:35] hi');
    } finally {
      process.env.TZ = before;
    }
  });
});

describe('applyNote', () => {
  const at = new Date('2026-09-07T12:34:00.000Z');
  it('strips only trailing whitespace before appending', () => {
    expect(applyNote('  keep me  \n\n', { mode: 'append', text: 'next' }, at)).toBe('  keep me\n- [12:34] next');
    expect(applyNote('   \n ', { mode: 'append', text: 'first' }, at)).toBe('- [12:34] first');
  });
  it('leaves a multi-line note on disk intact', () => {
    expect(applyNote('one\ntwo', { mode: 'append', text: 'three' }, at)).toBe('one\ntwo\n- [12:34] three');
  });
});
