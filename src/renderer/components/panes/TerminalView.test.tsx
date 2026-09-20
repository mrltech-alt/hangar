/**
 * The terminal view: a real `Terminal` on a real React root, attached to a stubbed main.
 *
 * **G8 / G17 — the container has no size.** jsdom reports 0 for every box, which is exactly the
 * state a freshly mounted pane is in for one frame, so the attach path here runs the same code the
 * app runs on mount. The tests below pin what it sends in that state (the 120x40 fallback) and,
 * more importantly, that it corrects itself the moment a size exists — a resize that only ever
 * fired from the ResizeObserver would leave a guessed PTY size in place until the user dragged the
 * window.
 *
 * **G59 — selector stability.** `TerminalView` reads config through `useConfig.getState()` rather
 * than a hook, so it subscribes to nothing and cannot loop. That is a decision, not an absence, so
 * the commit counter below asserts it and a control mounts the allocating selector it would have
 * been if written the obvious way, proving the probe is not blind.
 *
 * **G60 — an ancestor stealing the event.** `Pane` carries `onMouseDownCapture`, this view carries
 * one of its own, and a live xterm sits under both. Measured here on xterm 6.0.0 in jsdom: xterm
 * does NOT stop propagation of mousedown (nor of keydown), so the plain "click the terminal" tests
 * pass in the bubble phase too — which is precisely the blind spot Task 4 shipped through. The
 * tests that mean something put a consumer between the terminal and React's root and assert the
 * handler still fires; those fail on a revert to `onMouseDown`, and only those.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import {
  defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Id, type Layout, type Project, type SessionState, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';
const ATTACH: IpcRequests['session:attach']['res'] = { snapshot: 'SNAPSHOT', title: 'a title' };

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const agent = (id: string, name: string): Agent => ({
  id, name, slug: name, folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `hangar/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

const running = (id: Id): SessionState => ({ ...initialSessionState(id), activity: 'idle' });

function snapshotWith(layout: Partial<Layout>, sessions: Record<Id, SessionState | undefined> = {}): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: [project('p1', 'hangar')],
      agents: [agent('a1', 'alpha'), agent('a2', 'beta')],
      layout: { ...defaultLayout(), ...layout },
    },
    sessions,
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

/** The ResizeObserver instances a test can drive. jsdom has none, and `test-setup.ts`'s stand-in
 *  never fires — deliberately, so a resize in these tests is an explicit act, not a race. */
interface ObserverRecord { fire: () => void; targets: Element[]; disconnected: boolean }
let observers: ObserverRecord[] = [];

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — `vi.resetModules()` plus dynamic imports, the same dance every other
 * renderer test uses, and the reason each test gets fresh stores AND a fresh `terminals` registry.
 *
 * `deferAttach` holds the `session:attach` reply open so a test can decide what happens in the
 * window between the request and the snapshot — which is where the data-buffering and the
 * first-resize behaviour both live.
 */
async function load({ deferAttach = false }: { deferAttach?: boolean } = {}) {
  const calls: { channel: IpcRequestKey; payload: unknown }[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  let releaseAttach: (() => void) | null = null;
  // Typed as the real `HangarBridge`, no `as unknown as` escape hatch (Plan 02's standing rule).
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const reply = { ok: true, value: (channel === 'session:attach' ? ATTACH : undefined) as IpcRequests[K]['res'] } as const;
      if (channel !== 'session:attach' || !deferAttach) return Promise.resolve(reply);
      return new Promise((resolve) => {
        releaseAttach = () => resolve(reply);
      });
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      // The one narrowing this file cannot express: a single Map holding handlers for eight
      // different payload types. It hides nothing about any interface.
      const erased = handler as (payload: never) => void;
      listeners.set(channel, [...(listeners.get(channel) ?? []), erased]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [view, panes, workspace, sessions, layout, registry, search, dictation] = await Promise.all([
    import('./TerminalView.tsx'),
    import('./PaneGrid.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/layout.ts'),
    import('../../lib/terminal-registry.ts'),
    import('../../stores/terminal-search.ts'),
    // Plan 09: the run Escape consults — the SAME instance `TerminalView`'s `onEscape` reads.
    import('../../stores/dictation.ts'),
  ]);
  const emit = <K extends IpcEventKey>(channel: K, payload: IpcEvents[K]): void => {
    act(() => {
      for (const h of listeners.get(channel) ?? []) (h as (p: IpcEvents[K]) => void)(payload);
    });
  };
  const finishAttach = async (): Promise<void> => {
    releaseAttach?.();
    await act(async () => undefined);
  };
  const only = (channel: IpcRequestKey) => calls.filter((c) => c.channel === channel).map((c) => c.payload);
  return { ...view, ...panes, workspace, sessions, layout, registry, search, dictation, calls, emit, finishAttach, only };
}

type Harness = Awaited<ReturnType<typeof load>>;

async function withGrid(t: Harness, snapshot: WorkspaceSnapshot): Promise<void> {
  t.workspace.useWorkspace.getState().setSnapshot(snapshot);
  t.sessions.useSessions.getState().setAll(snapshot.sessions);
  t.layout.layoutStore.getState().hydrate(snapshot.workspace.layout);
}

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];
let realResizeObserver: unknown;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
  observers = [];
  const globals = globalThis as { ResizeObserver?: unknown };
  realResizeObserver = globals.ResizeObserver;
  globals.ResizeObserver = class {
    private readonly record: ObserverRecord;
    constructor(callback: () => void) {
      this.record = { fire: callback, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true;
    }
  };
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver;
});

/** Mounts `node` and returns the host element plus a live count of subtree COMMITS. */
function mount(node: ReactNode): { el: HTMLElement; commits: () => number; unmount: () => void } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>));
  return { el, commits: () => commits, unmount: () => act(() => root.unmount()) };
}

/**
 * The same, with `<StrictMode>` as the OUTERMOST element handed to `root.render()`.
 *
 * G65: putting the `<Profiler>` above the shell instead silently switches effect double-invocation
 * off — measured on React 19.2.8 at effects 2 vs 1 — so the counter goes INSIDE. Copied from
 * `FilesTab.test.tsx`'s reference spelling.
 */
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number; unmount: () => void } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(<StrictMode><Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler></StrictMode>));
  return { el, commits: () => commits, unmount: () => act(() => root.unmount()) };
}

/** Mounts one view and flushes the attach round-trip unless the harness is holding it open. */
async function mountView(t: Harness, props: { agentId?: string; paneIndex?: number; focused?: boolean } = {}) {
  const mounted = mount(<t.TerminalView agentId={props.agentId ?? 'a1'} paneIndex={props.paneIndex ?? 0} focused={props.focused ?? true} />);
  await act(async () => undefined);
  const handle = t.registry.terminals.get(props.agentId ?? 'a1');
  if (!handle) throw new Error('no terminal registered for the mounted view');
  const box = mounted.el.querySelector('div') as HTMLElement;
  return { ...mounted, handle, box };
}

/** jsdom lays nothing out, so a container only has a size if the test gives it one. */
function giveSize(el: HTMLElement, w: number, h: number): void {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}

describe('attaching', () => {
  it('attaches once, with its own agent id and pane index', async () => {
    const t = await load();
    const { handle } = await mountView(t, { agentId: 'a2', paneIndex: 2 });
    expect(t.only('session:attach')).toEqual([{ agentId: 'a2', paneIndex: 2, cols: 120, rows: 40 }]);
    expect(handle.term).toBeDefined();
  });

  /**
   * The G8 fallback. The pane has not been laid out when the effect runs — measured here as
   * `clientWidth === 0` — so `fitIfVisible` returns null and this is what main is told. It is a
   * guess, which is why the next test exists.
   */
  it('sends the fallback size while the container has no size', async () => {
    const t = await load();
    const { box } = await mountView(t);
    expect(box.clientWidth).toBe(0);
    expect(t.only('session:attach')).toEqual([{ agentId: 'a1', paneIndex: 0, cols: 120, rows: 40 }]);
  });

  /**
   * The race the plan's version loses. The ResizeObserver fires while the attach request is still
   * in flight, and its handler is a no-op until `attached` is true — so without a re-fit at the
   * end of `attach()` the guessed 120x40 stays until something else resizes the pane, which on a
   * pane that is never resized is forever.
   */
  it('corrects the guessed size as soon as the attach reply lands', async () => {
    const t = await load({ deferAttach: true });
    const { box } = await mountView(t);
    expect(t.only('session:resize')).toEqual([]);
    giveSize(box, 800, 400);
    await t.finishAttach();
    expect(t.only('session:resize')).toEqual([{ agentId: 'a1', cols: 80, rows: 24 }]);
  });

  it('writes the snapshot main replies with', async () => {
    const t = await load({ deferAttach: true });
    const { handle } = await mountView(t);
    const write = vi.spyOn(handle.term, 'write');
    await t.finishAttach();
    expect(write.mock.calls.map((c) => c[0])).toEqual(['SNAPSHOT']);
  });

  // §12.3: the focused pane owns the keyboard, and a pane that attaches while focused has to take
  // it without the user clicking.
  it('marks the agent viewed on mount when the pane is focused', async () => {
    const t = await load();
    await mountView(t, { focused: true });
    expect(t.only('agent:markViewed')).toContainEqual({ id: 'a1' });
  });
});

describe('session data', () => {
  it('writes data for its own agent and ignores every other agent', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    const write = vi.spyOn(handle.term, 'write');
    t.emit('session:data', { agentId: 'a1', data: 'mine' });
    t.emit('session:data', { agentId: 'a2', data: 'theirs' });
    expect(write.mock.calls.map((c) => c[0])).toEqual(['mine']);
  });

  /**
   * The bytes the plan's version drops.
   *
   * Main emits `session:data` for every known agent whether or not this pane has attached
   * (`session-registry.ts`'s data relay checks `knownAgent` and nothing else), and the host
   * serialises its snapshot before the reply travels host → main → renderer. Subscribing after the
   * `await` — which is what the plan wrote — loses everything the PTY produced inside that window,
   * permanently, because nothing re-sends it. Subscribing first and replaying after the snapshot
   * keeps both the bytes and the order.
   */
  it('buffers data that arrives before the snapshot and replays it after, in order', async () => {
    const t = await load({ deferAttach: true });
    const { handle } = await mountView(t);
    const write = vi.spyOn(handle.term, 'write');
    t.emit('session:data', { agentId: 'a1', data: 'first' });
    t.emit('session:data', { agentId: 'a1', data: 'second' });
    expect(write.mock.calls).toEqual([]);
    await t.finishAttach();
    expect(write.mock.calls.map((c) => c[0])).toEqual(['SNAPSHOT', 'first', 'second']);
  });

  // A host-pushed snapshot (a restart respawning over the exited id, §8.2, or a reconnect
  // re-attach) means "reset the terminal, then write" — painting it onto the dead session's screen
  // is a permanent visual seam.
  it('resets before writing a pushed snapshot', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    const write = vi.spyOn(handle.term, 'write');
    const reset = vi.spyOn(handle.term, 'reset');
    t.emit('session:snapshot', { agentId: 'a1', data: 'FRESH', title: 't' });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.map((c) => c[0])).toEqual(['FRESH']);
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0] ?? 0);
  });

  it('ignores a pushed snapshot for another agent', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    const reset = vi.spyOn(handle.term, 'reset');
    t.emit('session:snapshot', { agentId: 'a2', data: 'FRESH', title: 't' });
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('typing', () => {
  /**
   * `term.input(...)` rather than a synthetic event on the helper textarea: jsdom does not
   * implement the `InputEvent`/composition path xterm's textarea handler reads, so a dispatched
   * `input` event produces nothing at all (measured: 0 `session:write` calls). `input()` is
   * xterm's own public "as if the user typed this", and it feeds the same `onData` emitter the
   * keyboard does — which is the wiring this test is about. The keyboard path itself is covered
   * in `terminal-registry.test.ts`, which dispatches real keydowns at that textarea.
   */
  it('sends what the user types to the PTY', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    handle.term.input('x');
    expect(t.only('session:write')).toEqual([{ agentId: 'a1', data: 'x' }]);
  });

  // G19: xterm sends a bare `\r` for Shift+Enter, identical to Enter, so Claude submits instead of
  // inserting a line break. `\n` is Ctrl-J, the newline every terminal documents.
  it('sends \\n for Shift+Enter, and nothing else', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    const textarea = handle.term.element?.querySelector('textarea.xterm-helper-textarea') as HTMLElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', shiftKey: true }));
    expect(t.only('session:write')).toEqual([{ agentId: 'a1', data: '\n' }]);
  });
});

/**
 * Plan 09: Escape cancels a dictation — while, and ONLY while, this terminal's agent is being
 * dictated to. At every other moment it is the terminal's, and it has to reach the PTY as ESC:
 * Claude Code interrupts with it. Dispatched at xterm's own helper textarea with `keyCode: 27`,
 * because xterm's keyboard evaluator reads the legacy code — without it the pass-through half would
 * pass vacuously, sending nothing either way.
 */
describe('Escape and a dictation', () => {
  const ESC = String.fromCharCode(27);
  const escape = (handle: { term: { element?: HTMLElement } }): void => {
    const textarea = handle.term.element?.querySelector('textarea.xterm-helper-textarea') as HTMLElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', keyCode: 27 }));
  };
  const heard = (t: Harness, agentId: Id, state: IpcEvents['dictation:event']['state']): void => {
    act(() => t.dictation.useDictation.getState().receive({ agentId, state, outcome: null }));
  };

  it('reaches the PTY as ESC when nothing is being dictated', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    escape(handle);
    expect(t.only('session:write')).toEqual([{ agentId: 'a1', data: ESC }]);
    expect(t.only('dictation:cancel')).toEqual([]);
  });

  it('cancels the dictation, and sends the PTY nothing, while this agent is recording', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    heard(t, 'a1', { phase: 'recording', partial: 'half a sent' });
    escape(handle);
    expect(t.calls.filter((c) => c.channel === 'dictation:cancel')).toHaveLength(1);
    expect(t.only('session:write')).toEqual([]);
  });

  // The correlation half (G89): another agent's run does not make THIS terminal's Escape a cancel.
  it('reaches the PTY when it is ANOTHER agent that is recording', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    heard(t, 'a2', { phase: 'recording', partial: '' });
    escape(handle);
    expect(t.only('session:write')).toEqual([{ agentId: 'a1', data: ESC }]);
    expect(t.only('dictation:cancel')).toEqual([]);
  });

  // Asked per press: the run ending hands Escape straight back to the terminal.
  it('goes back to the PTY the moment the run has ended', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    heard(t, 'a1', { phase: 'recording', partial: '' });
    escape(handle);
    heard(t, 'a1', { phase: 'idle', outcome: { kind: 'cancelled' } });
    escape(handle);
    expect(t.calls.filter((c) => c.channel === 'dictation:cancel')).toHaveLength(1);
    expect(t.only('session:write')).toEqual([{ agentId: 'a1', data: ESC }]);
  });

  // Every phase that takes a cancel — not `recording` alone. Before `ready` the mic button's own
  // press is a cancel, and while finalizing Escape drops the transcript on its way in.
  it('also cancels while starting, preparing and finalizing', async () => {
    const t = await load();
    const { handle } = await mountView(t);
    for (const state of [{ phase: 'starting' }, { phase: 'preparing' }, { phase: 'finalizing', partial: 'x' }] as const) {
      heard(t, 'a1', state);
      escape(handle);
    }
    expect(t.calls.filter((c) => c.channel === 'dictation:cancel')).toHaveLength(3);
    expect(t.only('session:write')).toEqual([]);
  });
});

describe('resizing', () => {
  it('observes the container itself, never the window', async () => {
    const t = await load();
    const { box } = await mountView(t);
    expect(observers.length).toBe(1);
    expect(observers[0]?.targets).toEqual([box]);
  });

  it('debounces, then sends one resize', async () => {
    vi.useFakeTimers();
    try {
      const t = await load();
      const { box } = await mountView(t);
      giveSize(box, 800, 400);
      act(() => {
        observers[0]?.fire();
        observers[0]?.fire();
        observers[0]?.fire();
      });
      expect(t.only('session:resize')).toEqual([]);
      act(() => void vi.advanceTimersByTime(60));
      expect(t.only('session:resize')).toEqual([{ agentId: 'a1', cols: 80, rows: 24 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Most pixels do not cross a character cell, and every resize is a SIGWINCH plus a full redraw
  // in Claude's TUI.
  it('does not repeat a resize that changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const t = await load();
      const { box } = await mountView(t);
      giveSize(box, 800, 400);
      for (let i = 0; i < 3; i += 1) {
        act(() => void observers[0]?.fire());
        act(() => void vi.advanceTimersByTime(60));
      }
      expect(t.only('session:resize').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // G8's other half: a container that has collapsed (a hidden pane, a layout mid-flight) reports 0,
  // and a fit against it would report the LAST size as though it had just been measured.
  it('sends nothing while the container has no size', async () => {
    vi.useFakeTimers();
    try {
      const t = await load();
      await mountView(t);
      act(() => void observers[0]?.fire());
      act(() => void vi.advanceTimersByTime(60));
      expect(t.only('session:resize')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('teardown', () => {
  it('registers the terminal while mounted and gives the id back on unmount', async () => {
    const t = await load();
    const view = await mountView(t);
    expect(t.registry.terminals.get('a1')).toBe(view.handle);
    view.unmount();
    expect(t.registry.terminals.has('a1')).toBe(false);
  });

  it('detaches, disconnects the observer and disposes the terminal', async () => {
    const t = await load();
    const view = await mountView(t);
    const dispose = vi.spyOn(view.handle.term, 'dispose');
    view.unmount();
    expect(t.only('session:detach')).toEqual([{ agentId: 'a1' }]);
    expect(observers[0]?.disconnected).toBe(true);
    expect(dispose).toHaveBeenCalled();
  });

  // An attach that never completed has nothing to detach from, and `session:detach` would raise an
  // error toast for a session main does not think this pane ever had.
  it('does not detach when the attach never landed', async () => {
    const t = await load({ deferAttach: true });
    const view = await mountView(t);
    view.unmount();
    expect(t.only('session:detach')).toEqual([]);
  });

  // The listeners are per-mount closures over a disposed `Terminal`; leaving one attached is a
  // write into a torn-down terminal on the next byte the host sends.
  it('stops writing data after unmount', async () => {
    const t = await load();
    const view = await mountView(t);
    const write = vi.spyOn(view.handle.term, 'write');
    view.unmount();
    t.emit('session:data', { agentId: 'a1', data: 'late' });
    expect(write).not.toHaveBeenCalled();
  });
});

/**
 * A pane is a SLOT and an agent moves between slots (`PaneGrid` keys by index for exactly this
 * reason). The effect is keyed on `[agentId, paneIndex]` because `session:attach` is the only way
 * to tell main which pane an agent is in — `src/main/services/session-registry.ts` says so in its
 * own comment — so a move is a detach and a re-attach, and the registry has to come out of it with
 * a live handle per agent rather than a hole where the first cleanup ran.
 */
describe('moving a pane', () => {
  it('re-attaches at the new index and leaves both agents registered', async () => {
    const t = await load();
    await withGrid(t, snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 }, { a1: running('a1'), a2: running('a2') }));
    mount(<t.PaneGrid />);
    await act(async () => undefined);
    expect(t.only('session:attach')).toEqual([
      { agentId: 'a1', paneIndex: 0, cols: 120, rows: 40 },
      { agentId: 'a2', paneIndex: 1, cols: 120, rows: 40 },
    ]);
    act(() => t.layout.layoutStore.getState().swapPanes(0, 1));
    await act(async () => undefined);
    expect(t.only('session:attach').slice(2)).toEqual([
      { agentId: 'a2', paneIndex: 0, cols: 120, rows: 40 },
      { agentId: 'a1', paneIndex: 1, cols: 120, rows: 40 },
    ]);
    expect(t.only('session:detach')).toEqual([{ agentId: 'a1' }, { agentId: 'a2' }]);
    // The registry comes out of the move whole. Measured: React 19.2.8 runs both cleanups before
    // both setups, so this holds with or without the ownership guard in the cleanup — the guard is
    // there for the interleaving this ordering does not currently produce, not for this test.
    expect(t.registry.terminals.has('a1')).toBe(true);
    expect(t.registry.terminals.has('a2')).toBe(true);
  });
});

/**
 * The ⌘F find bar (Plan 05 Task 3).
 *
 * Its open/closed flag lives in `stores/terminal-search.ts`, keyed by AGENT, and the tests that
 * matter here are the ones a positional `useState` inside this component would fail: that the bar
 * follows the agent rather than the pane, and that it searches whichever terminal is live NOW
 * rather than one captured when it opened.
 */
describe('the find bar', () => {
  const bar = (el: HTMLElement): HTMLElement | null => el.querySelector('input[aria-label="Find in terminal"]');
  const openFor = (t: Harness, id: string): void => act(() => t.search.useTerminalSearch.getState().toggle(id));

  /**
   * Types into the CONTROLLED input the way a browser does — `dialogs.test.tsx`'s helper, and for
   * the same reason: React installs its own value setter on the element, so assigning `.value`
   * directly is invisible to it and `onChange` never fires. Measured here first as three tests
   * that silently observed no search at all.
   */
  const type = (el: HTMLInputElement, value: string): void => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('renders nothing until the store opens one, and only for its own agent', async () => {
    const t = await load();
    const view = await mountView(t, { agentId: 'a1' });
    expect(bar(view.el)).toBeNull();
    openFor(t, 'a2');
    expect(bar(view.el)).toBeNull();
    openFor(t, 'a1');
    expect(bar(view.el)).not.toBeNull();
  });

  it('searches the terminal through the addon, forwards and backwards', async () => {
    const t = await load();
    const view = await mountView(t);
    const next = vi.spyOn(view.handle.search, 'findNext').mockReturnValue(true);
    const previous = vi.spyOn(view.handle.search, 'findPrevious').mockReturnValue(true);
    openFor(t, 'a1');
    const input = bar(view.el) as HTMLInputElement;
    type(input, 'needle');
    // Typing searches incrementally, so the viewport does not jump away from a half-spelled match.
    expect(next).toHaveBeenLastCalledWith('needle', expect.objectContaining({ incremental: true }));
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(next).toHaveBeenLastCalledWith('needle', expect.not.objectContaining({ incremental: true }));
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
    expect(previous).toHaveBeenLastCalledWith('needle', expect.anything());
  });

  /**
   * The reason `TerminalSearch` takes an agent id and not a `TerminalHandle`.
   *
   * A pane move disposes the `Terminal` and builds a new one, so a handle captured as a prop when
   * the bar opened would be searching a dead terminal. Here the registry entry is swapped
   * underneath an open bar and the NEW handle is the one that receives the search. Passing the
   * handle down as a prop instead fails this and nothing else.
   */
  it('searches the terminal that is live now, not the one that was live when it opened', async () => {
    const t = await load();
    const view = await mountView(t);
    openFor(t, 'a1');
    const replacement = t.registry.createTerminal({ fontFamily: 'monospace', fontSize: 13, scrollback: 10, onShiftEnter: () => undefined, onOpenLink: () => undefined, onEscape: () => false });
    try {
      t.registry.terminals.set('a1', replacement);
      const stale = vi.spyOn(view.handle.search, 'findNext').mockReturnValue(true);
      const live = vi.spyOn(replacement.search, 'findNext').mockReturnValue(true);
      type(bar(view.el) as HTMLInputElement, 'x');
      expect(live).toHaveBeenCalled();
      expect(stale).not.toHaveBeenCalled();
    } finally {
      replacement.dispose();
    }
  });

  it('clears the decorations, closes and hands the keyboard back on Escape', async () => {
    const t = await load();
    const view = await mountView(t);
    const cleared = vi.spyOn(view.handle.search, 'clearDecorations');
    const focus = vi.spyOn(view.handle.term, 'focus');
    openFor(t, 'a1');
    act(() => void (bar(view.el) as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(cleared).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(bar(view.el)).toBeNull();
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  it('does the same from the close button', async () => {
    const t = await load();
    const view = await mountView(t);
    openFor(t, 'a1');
    const close = view.el.querySelector('button[aria-label="Close find"]') as HTMLButtonElement;
    act(() => close.click());
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  /**
   * An empty box is no query, not a failed one: deleting the term back to nothing puts the terminal
   * back the way it was found rather than leaving the last match highlighted.
   *
   * Asserted as "`findNext` is never asked to search for nothing", NOT as "`clearDecorations` was
   * called" — measured, the second spelling is BLIND: with the empty-term branch deleted the call
   * falls through to `findNext('')`, and the addon clears the decorations itself on the way to
   * returning false, so the spy fires either way and the mutant survives.
   */
  it('does not search for an empty term when the box is cleared', async () => {
    const t = await load();
    const view = await mountView(t);
    openFor(t, 'a1');
    const input = bar(view.el) as HTMLInputElement;
    type(input, 'x');
    const next = vi.spyOn(view.handle.search, 'findNext').mockReturnValue(true);
    const cleared = vi.spyOn(view.handle.search, 'clearDecorations');
    type(input, '');
    expect(cleared).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('closes when the pane is unmounted', async () => {
    const t = await load();
    const view = await mountView(t);
    openFor(t, 'a1');
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a1']);
    view.unmount();
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  /**
   * A pane MOVE closes it too, and that is a decision rather than an accident. React reconciles
   * panes by slot (`PaneGrid` keys them `key={i}`), so a move either unmounts this view or changes
   * its `agentId` — neither is distinguishable from a real close inside a cleanup. The re-attach
   * rebuilds the `Terminal`, its `SearchAddon` and every decoration, so a bar left open would be
   * showing highlights that no longer exist.
   */
  it('closes when the pane moves, because the terminal is rebuilt underneath it', async () => {
    const t = await load();
    const el = document.createElement('div');
    container.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    act(() => root.render(<t.TerminalView agentId="a1" paneIndex={0} focused />));
    await act(async () => undefined);
    act(() => t.search.useTerminalSearch.getState().toggle('a1'));
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a1']);
    act(() => root.render(<t.TerminalView agentId="a1" paneIndex={1} focused />));
    await act(async () => undefined);
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  /**
   * The overlay decision, asserted. The bar is `absolute` against `Pane.tsx`'s `relative` wrapper,
   * so it takes no space, the container box never changes and no re-fit is needed — G17/G8's
   * stale-80x24 fit path is simply not on this route. A bar that took layout height instead would
   * have to resize the PTY twice per ⌘F.
   */
  it('does not resize the terminal when the bar appears', async () => {
    const t = await load();
    const view = await mountView(t);
    giveSize(view.box, 800, 600);
    const before = t.only('session:resize').length;
    openFor(t, 'a1');
    expect(t.only('session:resize').length).toBe(before);
    expect(observers.filter((o) => !o.disconnected).length).toBe(1);
  });
});

describe('render commits (G59)', () => {
  /**
   * `TerminalView` reads `config.terminal` through `useConfig.getState()`, so it subscribes to no
   * store and cannot loop — and a font-size change cannot tear down a live PTY attachment either.
   * The control below is what makes this number mean something.
   */
  it('commits exactly once for a mounted terminal', async () => {
    const t = await load();
    const view = await mountView(t);
    expect(view.commits()).toBe(1);
  });

  it('commits exactly once for a whole grid of running terminals', async () => {
    const t = await load();
    await withGrid(t, snapshotWith({ panes: ['a1', 'a2'] }, { a1: running('a1'), a2: running('a2') }));
    const { commits } = mount(<t.PaneGrid />);
    await act(async () => undefined);
    expect(commits()).toBe(1);
  });

  /**
   * G61's shape, the other way round. Every other test in this file mounts with the find-bar store
   * EMPTY, which is the case a `?? []`-style fallback would hide; this one mounts with it POPULATED
   * so both sides of `open.has(agentId)` are covered by a real root. Neither allocates.
   */
  it('commits exactly once with the find bar already open', async () => {
    const t = await load();
    t.search.useTerminalSearch.getState().toggle('a1');
    const view = await mountView(t);
    expect(view.el.querySelector('input[aria-label="Find in terminal"]')).not.toBeNull();
    expect(view.commits()).toBe(1);
  });

  /**
   * Control. Without it, "commits === 1" above could mean the probe is blind. Measured on this
   * tree with React 19.2.8: a selector that builds a fresh object renders ~55 times and then React
   * throws "Maximum update depth exceeded", having first logged "The result of getSnapshot should
   * be cached to avoid an infinite loop". This is the selector `TerminalView` would have used if
   * it had reached for the config through a hook.
   */
  it('catches a config selector that allocates — what TerminalView must not do', async () => {
    const t = await load();
    const config = await import('../../stores/config.ts');
    const Looping = (): ReactNode => {
      const cfg = config.useConfig((s) => ({ font: s.config.terminal.fontFamily, size: s.config.terminal.fontSize }));
      return <span>{cfg.size}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
    expect(t.calls.length).toBeGreaterThanOrEqual(0);
  });

  /**
   * The same control aimed at the find-bar store, because that is the subscription this component
   * actually has. `TerminalView` selects `open.has(agentId)` — a boolean; the spelling below builds
   * an array from the same Set and is what a "give me the open ids" selector would look like.
   */
  it('catches a find-bar selector that allocates — what TerminalView must not do', async () => {
    const t = await load();
    const Looping = (): ReactNode => {
      const ids = t.search.useTerminalSearch((s) => [...s.open]);
      return <span>{ids.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * G60. `Pane` focuses on `onMouseDownCapture` because xterm calls `stopPropagation()` on the
 * mousedown it uses to start a selection; `TerminalView`'s own handler sits between the two and is
 * capture for the same reason. Both are dispatched here as REAL bubbling events through a tree
 * with a LIVE terminal in it — the only shape that can see an ancestor, or a descendant, stealing
 * the event.
 */
describe('mouse routing (bubbling through the real tree)', () => {
  const mouseDown = (node: Element): void => {
    act(() => void node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  };

  it('marks the agent viewed when the mousedown lands on the terminal itself', async () => {
    const t = await load();
    const view = await mountView(t);
    const before = t.only('agent:markViewed').length;
    const screen = view.handle.term.element?.querySelector('.xterm-screen');
    expect(screen).not.toBeNull();
    mouseDown(screen as Element);
    expect(t.only('agent:markViewed').length).toBe(before + 1);
  });

  /**
   * The test that pins the capture phase on `TerminalView`'s own handler.
   *
   * Measured on xterm 6.0.0 in jsdom: the live terminal above does NOT stop propagation of
   * mousedown, so reverting `onMouseDownCapture` to `onMouseDown` leaves that test green. This one
   * puts a consumer between the terminal and React's root — what an xterm that owns its selection
   * gesture looks like, and what `Pane.tsx`'s comment describes — and fails alone on that revert.
   */
  it('still marks it viewed when a descendant stops propagation, the way xterm does', async () => {
    const t = await load();
    const view = await mountView(t);
    const before = t.only('agent:markViewed').length;
    const inner = view.handle.term.element as HTMLElement;
    inner.addEventListener('mousedown', (e) => e.stopPropagation());
    const leaf = document.createElement('span');
    inner.appendChild(leaf);
    mouseDown(leaf);
    expect(t.only('agent:markViewed').length).toBe(before + 1);
  });

  // The other half of G60: this handler must not consume what its ANCESTOR needs. `Pane` focuses
  // the pane a click lands in, and a click on the terminal is most clicks.
  it('lets the click through to the pane, which focuses on it', async () => {
    const t = await load();
    await withGrid(t, snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 }, { a1: running('a1'), a2: running('a2') }));
    const { el } = mount(<t.PaneGrid />);
    await act(async () => undefined);
    const second = el.querySelectorAll('section')[1] as HTMLElement;
    const screen = second.querySelector('.xterm-screen');
    expect(screen).not.toBeNull();
    mouseDown(screen as Element);
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });
});

/**
 * StrictMode, recording the gap this file has always had rather than closing it (G26/G65).
 *
 * `PROGRESS.md` lists a missing StrictMode test here as OWED, because this is the one place a
 * double-invoked mount effect would duplicate a real PTY attachment. That is still owed after Plan
 * 05 Task 3 — the numbers below are the measurement, not a fix, and they are here so the next
 * person starts from a fact instead of a suspicion. Nothing in the app renders `<StrictMode>`
 * today (G26: `main.tsx` deliberately does not), so this is a latent cost of ever turning it on,
 * not a live bug.
 *
 * Measured on React 19.2.8 with this harness: a single mount under StrictMode sends **2**
 * `session:attach` calls where a plain mount sends **1**, and **0** `session:detach` — the first
 * cleanup runs while its own attach is still awaiting, so `attached` is false and the detach branch
 * is skipped. The host would therefore see two attaches for one agent with nothing between them.
 * Fixing that means making `attach` cancellable or keyed, which is not Task 3's change to make.
 *
 * What Task 3 IS responsible for is not making it worse, and that is the rest of this test: the
 * find bar added no new registration to the mount effect (the keymap reaches the store directly as
 * a module singleton, so there is nothing to register), and its own teardown effect is idempotent.
 * Both survive the double invocation with a count of one.
 */
describe('StrictMode (the owed gap, measured)', () => {
  it('double-invokes the mount effect: 2 attaches, 1 live terminal', async () => {
    const t = await load();
    mountStrict(<t.TerminalView agentId="a1" paneIndex={0} focused />);
    await act(async () => undefined);
    // The assertion only a SECOND invocation can break. A plain `mount` of the same view sends 1.
    expect(t.only('session:attach').length).toBe(2);
    expect(t.only('session:detach').length).toBe(0);
    // The registry's ownership guard holds through it: the entry that survives is the live one.
    expect(t.registry.terminals.size).toBe(1);
    expect(t.registry.terminals.has('a1')).toBe(true);
  });

  it('sends one attach without StrictMode, so the number above means what it says', async () => {
    const t = await load();
    mount(<t.TerminalView agentId="a1" paneIndex={0} focused />);
    await act(async () => undefined);
    expect(t.only('session:attach').length).toBe(1);
  });

  // Task 3's own surface. `close` returns early when the agent is not open, so the doubled cleanup
  // is a no-op; an unconditional `set` there would notify subscribers twice for nothing.
  it('leaves the find bar consistent through the doubled mount and teardown', async () => {
    const t = await load();
    const view = mountStrict(<t.TerminalView agentId="a1" paneIndex={0} focused />);
    await act(async () => undefined);
    act(() => t.search.useTerminalSearch.getState().toggle('a1'));
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a1']);
    expect(view.el.querySelectorAll('input[aria-label="Find in terminal"]').length).toBe(1);
    view.unmount();
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });
});
