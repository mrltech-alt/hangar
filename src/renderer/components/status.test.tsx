/**
 * Spec §12.7 and §12.8: the status bar, the banner surface and the session-host panel — the three
 * places where the app talks about its own health.
 *
 * The standing renderer hazards, and what each block here does about them:
 *
 * **G61 (and G59 under it)** — a status bar COUNTS things, and counting means deriving. A selector
 * that derives allocates, zustand 5 hands the result to `useSyncExternalStore` as a new snapshot,
 * and the component renders forever (~55 commits on this project, then React throws). Worse, a
 * `?? []`-shaped selector only allocates on its nullish path, so a populated-state test cannot see
 * it — Task 8 measured a deliberately mutated hook leaving all 62 dialog tests green. So the
 * counts live in `sessionCounts`, called from the render body, and the render-count block below
 * mounts every one of these components with NO snapshot and NO sessions as well as with both.
 *
 * **G60** — a component test cannot see an ancestor handler stealing its events. The last block
 * dispatches real bubbling events at the status bar and at a banner through the whole mounted App.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Activity, type Agent, type HostStatus, type Id, type Layout, type Project, type SessionState, type WorkspaceSnapshot,
} from '../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const PROJECT: Project = { id: 'p1', name: 'hangar', repoPath: '/repos/hangar', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO };

const agent = (id: string, name: string): Agent => ({
  id, name, slug: name, folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

const AGENTS: Agent[] = [agent('a1', 'alpha'), agent('a2', 'beta')];

const host = (patch: Partial<HostStatus> = {}): HostStatus => ({
  connected: true, version: '1', sessions: 2, socketPath: '/h/run/host.sock', nodeBin: '/usr/local/bin/node', lastError: null, ...patch,
});

/** A session in a given activity. No `as unknown as SessionState`: the real initial state, patched. */
const session = (id: Id, activity: Activity, patch: Partial<SessionState> = {}): SessionState => ({ ...initialSessionState(id), activity, ...patch });

function snapshotWith(patch: Partial<WorkspaceSnapshot> = {}, layout: Partial<Layout> = {}): WorkspaceSnapshot {
  return {
    workspace: { ...emptyWorkspace(), projects: [PROJECT], agents: AGENTS, layout: { ...defaultLayout(), panes: [null], focusedIndex: 0, ...layout } },
    sessions: {},
    runtime: {},
    host: host(),
    profile: { home: '/h', isDefault: true },
    ...patch,
  };
}

interface Call { channel: IpcRequestKey; payload: unknown }

interface Stub<K extends IpcRequestKey> { reply: IpcReply<IpcRequests[K]['res']> }
type Stubs = { [K in IpcRequestKey]?: Stub<K> };

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — the `vi.resetModules()` dance every renderer test in this project uses.
 * It also gives each test FRESH stores, which is what keeps them independent.
 */
async function load(stubs: Stubs) {
  const calls: Call[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const stub = stubs[channel];
      if (stub === undefined) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return Promise.resolve(stub.reply);
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      const erased = handler as (payload: never) => void;
      const list = listeners.get(channel) ?? [];
      list.push(erased);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [statusBar, banners, hostPanel, { App }, workspace, sessionsStore, layout, ui] = await Promise.all([
    import('./StatusBar.tsx'),
    import('./Banners.tsx'),
    import('./HostPanel.tsx'),
    import('../App.tsx'),
    import('../stores/workspace.ts'),
    import('../stores/sessions.ts'),
    import('../stores/layout.ts'),
    import('../stores/ui.ts'),
  ]);
  const emit = <K extends IpcEventKey>(channel: K, payload: IpcEvents[K]): void => {
    act(() => {
      for (const h of listeners.get(channel) ?? []) (h as (p: IpcEvents[K]) => void)(payload);
    });
  };
  return { ...statusBar, ...banners, ...hostPanel, App, workspace, sessionsStore, layout, ui, calls, emit };
}

/** The common case: a snapshot already in the stores, no `App`, no bootstrap. */
async function withSnapshot(stubs: Stubs = {}, snap: WorkspaceSnapshot = snapshotWith()) {
  const t = await load(stubs);
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.sessionsStore.useSessions.getState().setAll(snap.sessions);
  t.layout.layoutStore.getState().hydrate(snap.workspace.layout);
  return t;
}

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
  // Both after the unmounts, and in this hook rather than a later one: a root torn down under a
  // fake clock still has to run its `clearInterval` cleanup against the clock that created the
  // timer, and `StatusBar`'s cleanup also removes a listener from the patched `document`.
  vi.useRealTimers();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

/** Mounts `node` and returns the host element plus a live count of subtree COMMITS. */
function mount(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => n, node);
}

/**
 * The same under `<StrictMode>` — a separate helper rather than `mount(<StrictMode>…</StrictMode>)`,
 * because StrictMode only double-invokes EFFECTS when it is the OUTERMOST element handed to
 * `root.render()` (G65). Measured on React 19.2.8 by `components/strict-mode-nesting.test.tsx`,
 * which re-runs the comparison on every suite run:
 *
 *   root.render(<StrictMode><Profiler><P/></Profiler></StrictMode>)  → effects 2, updaters 2
 *   root.render(<Profiler><StrictMode><P/></StrictMode></Profiler>)  → effects 1, updaters 2
 *
 * The second line is the spelling this file used until the G65 correction. Render and state
 * updaters stayed doubled either way, so the allocating-selector detection below was doing its
 * stated job throughout; what was switched off was the double-MOUNT half — the one that catches
 * double-subscribe, double-fetch and double-attach. `FilesTab.test.tsx`'s `mountStrict` is the
 * reference shape.
 */
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => <StrictMode>{n}</StrictMode>, node);
}

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — that placement is what decides whether effects double-invoke at all.
  act(() => root.render(shell(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>)));
  return { el, commits: () => commits };
}

const flush = async (): Promise<void> => { await act(async () => undefined); };

/** The fake-clock equivalent, for the 60 s disk poll. */
const tick = async (ms = 0): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

const WORKTREES = '/h/worktrees';
const diskStub = (freeBytes: number, path: string = WORKTREES): Stub<'app:diskFree'> => ({ reply: { ok: true, value: { freeBytes, path } } });

const diskCalls = (calls: Call[]): unknown[] => payloadsFor(calls, 'app:diskFree');

/**
 * jsdom answers `visible` and has no way to change it, so the property is replaced on the document
 * instance (the real one is a prototype getter, so an own property shadows it and `delete` in
 * `afterEach` puts it back). The event is the real bubbling `visibilitychange` the component listens
 * for — nothing here calls the handler directly.
 */
const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};
const emitVisibility = async (state: 'visible' | 'hidden'): Promise<void> => {
  setVisibility(state);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('nothing to click');
  act(() => (el as HTMLElement).click());
};

const button = (el: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}" in: ${[...el.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return found;
};

const payloadsFor = (calls: Call[], channel: IpcRequestKey): unknown[] => calls.filter((c) => c.channel === channel).map((c) => c.payload);

/** The value cell of one `HostPanel` row, by its label. */
const row = (el: HTMLElement, label: string): string => {
  const found = [...el.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === label);
  if (!found) throw new Error(`no row "${label}"`);
  return found.children[1]?.textContent ?? '';
};

const bannerEls = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="status"]')];

// ────────────────────────────────────────────────────────────────────────────────────────────

describe('sessionCounts', () => {
  it('counts running sessions, skipping the undefined values the snapshot record really holds', async () => {
    const t = await load({});
    // `absent = stopped` (§6.5), and `WorkspaceSnapshot['sessions']` types its values
    // `SessionState | undefined` for exactly that reason.
    expect(t.sessionCounts({})).toEqual({ running: 0, attention: 0 });
    expect(t.sessionCounts({ a1: undefined })).toEqual({ running: 0, attention: 0 });
    expect(t.sessionCounts({
      a1: session('a1', 'working'),
      a2: session('a2', 'idle'),
      a3: session('a3', 'stopped'),
      a4: session('a4', 'exited'),
      a5: session('a5', 'shell'),
    })).toMatchObject({ running: 3 });
  });

  it('counts a needs-permission or unread session as needing attention', async () => {
    const t = await load({});
    expect(t.sessionCounts({ a1: session('a1', 'needs-permission') })).toEqual({ running: 1, attention: 1 });
    expect(t.sessionCounts({ a1: session('a1', 'working', { unread: true }) })).toEqual({ running: 1, attention: 1 });
    // Counted once, not twice, when both are true.
    expect(t.sessionCounts({ a1: session('a1', 'needs-permission', { unread: true }) })).toEqual({ running: 1, attention: 1 });
    // An agent that exited with something unread still needs the user, even though it is not running.
    expect(t.sessionCounts({ a1: session('a1', 'exited', { unread: true }) })).toEqual({ running: 0, attention: 1 });
  });

  it('agrees with isRunning rather than keeping its own copy of the predicate', async () => {
    const t = await load({});
    const actions = await import('../lib/agent-actions.ts');
    for (const activity of ['working', 'idle', 'waiting', 'needs-permission', 'starting', 'shell', 'stopped', 'exited'] as Activity[]) {
      const s = session('a1', activity);
      expect(t.sessionCounts({ a1: s }).running, activity).toBe(actions.isRunning(s) ? 1 : 0);
    }
  });
});

describe('hostLabel', () => {
  /**
   * Four states, not three. `connected: true` WITH a `lastError` is the protocol-mismatch case in
   * `src/main/index.ts` — the socket is up and the app is in read-only territory — and the plan's
   * `host.connected ? 'connected' : …` painted it green.
   */
  it('separates connected, outdated, failed and connecting', async () => {
    const t = await load({});
    expect(t.hostLabel(host())).toEqual({ text: 'connected', dot: 'green', detail: null });
    expect(t.hostLabel(host({ lastError: 'speaks protocol 3' }))).toEqual({ text: 'outdated', dot: 'amber', detail: 'speaks protocol 3' });
    expect(t.hostLabel(host({ connected: false, lastError: 'Node.js not found' }))).toEqual({ text: 'failed', dot: 'red', detail: 'Node.js not found' });
    expect(t.hostLabel(host({ connected: false }))).toEqual({ text: 'connecting…', dot: 'amber', detail: null });
  });
});

describe('nodeLabel', () => {
  it('shows a version when the path carries one and the path itself when it does not', async () => {
    const t = await load({});
    expect(t.nodeLabel('/Users/m/.nvm/versions/node/v24.15.0/bin/node')).toBe('v24.15.0');
    expect(t.nodeLabel('/Users/m/.local/share/fnm/node-versions/v22.11.0/installation/bin/node')).toBe('v22.11.0');
    // The plan's `split('/').slice(-3, -2)[0]` answered "homebrew" and "local" for these two.
    expect(t.nodeLabel('/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin/node');
    expect(t.nodeLabel('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(t.nodeLabel(null)).toBeNull();
    expect(t.nodeLabel('')).toBeNull();
  });
});

describe('StatusBar', () => {
  it('holds its height and offers no controls before the first snapshot', async () => {
    const t = await load({});
    const { el } = mount(<t.StatusBar />);
    expect(el.querySelector('button')).toBeNull();
    // The strip is the same 24px tall either way, so the pane grid does not resize under the user
    // when `workspace:get` answers.
    expect(el.firstElementChild?.className).toContain('h-6');
  });

  it('reports the host, the session counts and the node version', async () => {
    const t = await withSnapshot({}, snapshotWith({
      host: host({ nodeBin: '/Users/m/.nvm/versions/node/v24.15.0/bin/node' }),
      sessions: { a1: session('a1', 'working'), a2: session('a2', 'needs-permission') },
    }));
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).toContain('host: connected');
    expect(el.textContent).toContain('2 running · 1 need attention');
    expect(el.textContent).toContain('node: v24.15.0');
  });

  it('drops the attention clause when nothing needs attention', async () => {
    const t = await withSnapshot({}, snapshotWith({ sessions: { a1: session('a1', 'idle') } }));
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).toContain('1 running');
    expect(el.textContent).not.toContain('need attention');
  });

  it('names the profile only when it is not the default one', async () => {
    const t = await withSnapshot({}, snapshotWith({ profile: { home: '/h', isDefault: true } }));
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).not.toContain('profile:');
    const dev = await withSnapshot({}, snapshotWith({ profile: { home: '/Users/m/.hangar-dev', isDefault: false } }));
    const devEl = mount(<dev.StatusBar />).el;
    expect(devEl.textContent).toContain('profile: /Users/m/.hangar-dev');
  });

  it('says outdated, with the reason in the tooltip, when the host is connected but mismatched', async () => {
    const t = await withSnapshot({}, snapshotWith({ host: host({ lastError: 'host speaks protocol 3, this app speaks 4' }) }));
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).toContain('host: outdated');
    expect(el.querySelector('button')?.title).toBe('host speaks protocol 3, this app speaks 4');
  });

  it('opens the host panel when the host chip is clicked', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.StatusBar />);
    click(el.querySelector('button'));
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'host-panel' });
  });

  it('tracks a session that starts and one that stops', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).toContain('0 running');
    act(() => t.sessionsStore.useSessions.getState().setOne('a1', session('a1', 'working')));
    expect(el.textContent).toContain('1 running');
    act(() => t.sessionsStore.useSessions.getState().setOne('a1', session('a1', 'exited')));
    expect(el.textContent).toContain('0 running');
  });
});

/**
 * §12.8's `9.1 GB free` and §12.7's low-disk banner — the pair Plan 03 Task 9 left out because
 * nothing in main measured a disk. `app:diskFree` is that source now, and every number below is
 * INJECTED through the stub: filling a volume to reach a threshold is an outage, not a test.
 *
 * The decisions themselves (thresholds, hysteresis, the dismissal latch) are pure and live in
 * `shared/disk.test.ts`. What this block is for is the wiring the pure tests cannot see: that the
 * poll starts, that it STOPS, and that a reply landing after unmount writes nothing.
 */
describe('disk free', () => {
  it('shows nothing until the first reply, then the figure and the measured path', async () => {
    const t = await withSnapshot({ 'app:diskFree': diskStub(9.14e9) });
    const { el } = mount(<t.StatusBar />);
    expect(el.textContent).not.toContain('free');
    await flush();
    expect(el.textContent).toContain('9.1 GB free');
    const span = [...el.querySelectorAll('span')].find((x) => x.textContent === '9.1 GB free');
    expect(span?.title).toBe(`Free space on the volume holding ${WORKTREES}`);
    expect(span?.className).not.toContain('text-amber');
  });

  it('goes amber at the same edge the banner uses, and not at the boundary itself', async () => {
    const low = await withSnapshot({ 'app:diskFree': diskStub(4.2e9) });
    const lowEl = mount(<low.StatusBar />).el;
    await flush();
    expect([...lowEl.querySelectorAll('span')].find((x) => x.textContent === '4.2 GB free')?.className).toContain('text-amber');
    // Exactly 5 GB is not low — §12.7 says "< 5 GB".
    const edge = await withSnapshot({ 'app:diskFree': diskStub(5e9) });
    const edgeEl = mount(<edge.StatusBar />).el;
    await flush();
    expect([...edgeEl.querySelectorAll('span')].find((x) => x.textContent === '5.0 GB free')?.className).not.toContain('text-amber');
  });

  it('raises §12.7s banner below 5 GB, quoting the figure the preflight will refuse below', async () => {
    const t = await withSnapshot({ 'app:diskFree': diskStub(4.2e9) });
    const { el } = mount(<><t.Banners /><t.StatusBar /></>);
    await flush();
    expect(bannerEls(el)).toHaveLength(1);
    expect(bannerEls(el)[0]?.textContent).toContain('Low disk space: 4.2 GB free on the volume holding worktrees. New agents need at least 2.0 GB.');
    expect(bannerEls(el)[0]?.className).toContain('text-amber');
  });

  it('raises no banner when there is room', async () => {
    const t = await withSnapshot({ 'app:diskFree': diskStub(50e9) });
    const { el } = mount(<><t.Banners /><t.StatusBar /></>);
    await flush();
    expect(bannerEls(el)).toHaveLength(0);
    expect(t.ui.useUi.getState().banners).toEqual([]);
  });

  it('polls every 60 s and keeps the figure current', async () => {
    vi.useFakeTimers();
    const stubs: Stubs = { 'app:diskFree': diskStub(9e9) };
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.StatusBar />);
    await tick();
    expect(diskCalls(t.calls)).toHaveLength(1);
    expect(el.textContent).toContain('9.0 GB free');
    stubs['app:diskFree'] = diskStub(4e9);
    await tick(59_000);
    expect(diskCalls(t.calls)).toHaveLength(1);
    await tick(1_000);
    expect(diskCalls(t.calls)).toHaveLength(2);
    expect(el.textContent).toContain('4.0 GB free');
  });

  /**
   * The Diff tab's lesson (Plan 04 Task 5), and the reason the timer is armed inside the effect: a
   * `setInterval` with no cleanup keeps calling main from a component that no longer exists.
   */
  it('stops polling when the status bar unmounts', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot({ 'app:diskFree': diskStub(9e9) });
    const el = document.createElement('div');
    container.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<t.StatusBar />));
    await tick();
    expect(diskCalls(t.calls)).toHaveLength(1);
    act(() => root.unmount());
    await tick(600_000);
    expect(diskCalls(t.calls)).toHaveLength(1);
    // …and the `visibilitychange` listener went with it. Without the `removeEventListener` the
    // handler below re-arms an interval owned by a component that no longer exists — a leak the
    // 600 s above cannot see, because a stopped timer and a removed listener are different bugs.
    await emitVisibility('hidden');
    await emitVisibility('visible');
    await tick(600_000);
    expect(diskCalls(t.calls)).toHaveLength(1);
  });

  /**
   * …and the half that actually bites in this app: `StatusBar` is mounted for the whole life of the
   * window, so unmount cleanup alone would be a guard that never runs outside its own test. Ten
   * minutes of a hidden window is ten polls saved.
   */
  it('stops polling while the window is hidden and re-polls the moment it comes back', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot({ 'app:diskFree': diskStub(9e9) });
    mount(<t.StatusBar />);
    await tick();
    expect(diskCalls(t.calls)).toHaveLength(1);
    await emitVisibility('hidden');
    await tick(600_000);
    expect(diskCalls(t.calls)).toHaveLength(1);
    await emitVisibility('visible');
    // Immediately, not 60 s later: the figure must not be ten minutes stale on return.
    await tick();
    expect(diskCalls(t.calls)).toHaveLength(2);
    await tick(60_000);
    expect(diskCalls(t.calls)).toHaveLength(3);
  });

  it('does not stack a second interval when visibility says visible twice', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot({ 'app:diskFree': diskStub(9e9) });
    mount(<t.StatusBar />);
    await tick();
    // macOS fires `visibilitychange` on occlusion changes that do not always alternate; an
    // unguarded `start()` would arm a second interval and orphan the first, doubling the poll rate
    // for the rest of the launch and leaking a timer no cleanup knows about.
    await emitVisibility('visible');
    await emitVisibility('visible');
    expect(diskCalls(t.calls)).toHaveLength(1);
    await tick(60_000);
    expect(diskCalls(t.calls)).toHaveLength(2);
  });

  it('never starts a poll when the window is already hidden at mount', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    const t = await withSnapshot({ 'app:diskFree': diskStub(9e9) });
    mount(<t.StatusBar />);
    await tick(600_000);
    expect(diskCalls(t.calls)).toHaveLength(0);
  });

  /**
   * A reply outlives the interval that asked for it. Without the `live` flag this writes a banner
   * from a torn-down component — a state change with no owner, and the shape React used to warn
   * about before it stopped warning.
   */
  it('writes no banner from a reply that lands after unmount', async () => {
    let resolve: ((r: IpcReply<{ freeBytes: number; path: string }>) => void) | null = null;
    const t = await load({});
    // A stub cannot defer, so the deferral is installed on the store side of the reply: the
    // component's own `run` is already in flight when the root goes away.
    const pending = new Promise<IpcReply<{ freeBytes: number; path: string }>>((r) => { resolve = r; });
    const el = document.createElement('div');
    container.appendChild(el);
    const root = createRoot(el);
    const bridge = (window as Window & { hangar: HangarBridge }).hangar;
    const real = bridge.invoke.bind(bridge);
    bridge.invoke = ((channel: IpcRequestKey, ...args: unknown[]) =>
      channel === 'app:diskFree' ? pending : real(channel as 'workspace:get', ...(args as []))) as HangarBridge['invoke'];
    act(() => root.render(<t.StatusBar />));
    act(() => root.unmount());
    await act(async () => { (resolve as unknown as (r: IpcReply<{ freeBytes: number; path: string }>) => void)({ ok: true, value: { freeBytes: 1e9, path: WORKTREES } }); await pending; });
    expect(t.ui.useUi.getState().banners).toEqual([]);
  });

  /**
   * A failing `statfs` must not become a toast every 60 s. Asserted against `lib/api.ts`'s error
   * SINK rather than the ui store's toast list: `load()` does not run `bootstrap`, so nothing has
   * pointed the sink at the store and an unsilenced failure would leave `toasts` empty anyway —
   * the weaker assertion passes whether or not the guard exists.
   */
  it('does not toast once a minute when the measurement fails', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot({ 'app:diskFree': { reply: { ok: false, error: { code: 'EIO', message: 'no' } } } });
    const api = await import('../lib/api.ts');
    const sink = vi.fn();
    api.setErrorSink(sink);
    try {
      const { el } = mount(<t.StatusBar />);
      await tick(180_000);
      expect(diskCalls(t.calls)).toHaveLength(4);
      expect(sink).not.toHaveBeenCalled();
      expect(t.ui.useUi.getState().toasts).toEqual([]);
      expect(el.textContent).not.toContain('free');
    } finally {
      api.resetErrorSink();
    }
  });

  /**
   * §12.7's "dismissable per launch", end to end through the real close button — the only path that
   * removes this banner from the store, which is what makes `showing && !present` a dismissal.
   */
  it('never brings the banner back after the user closes it', async () => {
    vi.useFakeTimers();
    const stubs: Stubs = { 'app:diskFree': diskStub(4e9) };
    const t = await withSnapshot(stubs);
    const { el } = mount(<><t.Banners /><t.StatusBar /></>);
    await tick();
    expect(bannerEls(el)).toHaveLength(1);
    click(el.querySelector('[role="status"] button[aria-label="Dismiss"]'));
    expect(bannerEls(el)).toHaveLength(0);
    stubs['app:diskFree'] = diskStub(1e9);
    await tick(600_000);
    expect(bannerEls(el)).toHaveLength(0);
    // …while the strip, which is not dismissable, keeps telling the truth.
    expect(el.textContent).toContain('1.0 GB free');
  });

  /** The flap, through the component: readings that cross 5 GB four times raise once and stay. */
  it('does not flap the banner while free space hovers at the threshold', async () => {
    vi.useFakeTimers();
    const stubs: Stubs = { 'app:diskFree': diskStub(4.9e9) };
    const t = await withSnapshot(stubs);
    const { el } = mount(<><t.Banners /><t.StatusBar /></>);
    await tick();
    for (const free of [5.05e9, 4.95e9, 5.1e9, 4.8e9, 5.2e9]) {
      stubs['app:diskFree'] = diskStub(free);
      await tick(60_000);
      expect(bannerEls(el), `${free}`).toHaveLength(1);
    }
    // Clear of the band: gone.
    stubs['app:diskFree'] = diskStub(9e9);
    await tick(60_000);
    expect(bannerEls(el)).toHaveLength(0);
  });
});

describe('Banners', () => {
  const banner = { id: 'host', level: 'warn' as const, text: 'Reconnecting to session host…' };

  it('renders nothing at all when there are none', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Banners />);
    expect(el.innerHTML).toBe('');
  });

  it('shows a banner and dismisses it on the close button', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Banners />);
    act(() => t.ui.useUi.getState().setBanner(banner));
    expect(bannerEls(el)).toHaveLength(1);
    expect(el.textContent).toContain('Reconnecting to session host…');
    click(el.querySelector('button[aria-label="Dismiss"]'));
    expect(bannerEls(el)).toHaveLength(0);
    expect(t.ui.useUi.getState().banners).toEqual([]);
  });

  /** The lifecycle the host status depends on: same id in, one banner out, with the new text. */
  it('replaces a banner with the same id instead of stacking a second one', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Banners />);
    act(() => t.ui.useUi.getState().setBanner(banner));
    act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'error', text: 'Session host: boom' }));
    expect(bannerEls(el)).toHaveLength(1);
    expect(el.textContent).toContain('Session host: boom');
    expect(el.textContent).not.toContain('Reconnecting');
    expect(bannerEls(el)[0]?.className).toContain('text-red');
  });

  it('stacks banners with different ids, and clearing one leaves the other', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Banners />);
    act(() => t.ui.useUi.getState().setBanner(banner));
    act(() => t.ui.useUi.getState().setBanner({ id: 'disk', level: 'info', text: 'Low disk space' }));
    expect(bannerEls(el).map((b) => b.textContent)).toHaveLength(2);
    act(() => t.ui.useUi.getState().clearBanner('host'));
    expect(bannerEls(el)).toHaveLength(1);
    expect(el.textContent).toContain('Low disk space');
    // Clearing an id that is not there is a no-op, not a throw or a wipe.
    act(() => t.ui.useUi.getState().clearBanner('nothing-like-this'));
    expect(bannerEls(el)).toHaveLength(1);
  });

  /**
   * Pinning `setBanner`'s replace, which filters then APPENDS: a replaced banner moves to the
   * bottom of the stack. Invisible today (only `bootstrap.ts` writes banners, and it writes one
   * id), and worth knowing before a second writer exists.
   */
  it('moves a replaced banner to the end of the list', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Banners />);
    act(() => t.ui.useUi.getState().setBanner(banner));
    act(() => t.ui.useUi.getState().setBanner({ id: 'disk', level: 'info', text: 'Low disk space' }));
    act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'error', text: 'Session host: boom' }));
    expect(bannerEls(el).map((b) => b.textContent?.slice(0, 4))).toEqual(['Low ', 'Sess']);
  });

  it('runs a banner action without dismissing the banner', async () => {
    const t = await withSnapshot();
    const onClick = vi.fn();
    const { el } = mount(<t.Banners />);
    act(() => t.ui.useUi.getState().setBanner({ ...banner, action: { label: 'Details', onClick } }));
    click(button(el, 'Details'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(bannerEls(el)).toHaveLength(1);
  });
});

describe('HostPanel', () => {
  /**
   * The host panel opens through the same `ui/Dialog.tsx` as spec §12.6's four dialogs, so it
   * inherits their focus trap: `showModal()` runs the HTML dialog focusing steps and lands on the
   * first focusable descendant, which was the header's Close `IconButton`. Measured in Chrome 152,
   * a single Space there fires its click and closes the dialog.
   *
   * jsdom implements no `HTMLDialogElement` methods (`test-setup.ts`), so its `showModal` stub does
   * not move focus and cannot reproduce that on its own — this test installs the focusing step.
   * What it proves is only where focus lands, not that a Space would activate it: jsdom has no
   * keyboard activation behaviour at all. See `dialogs.test.tsx` for the fuller account.
   *
   * This panel is read-only diagnostics. Its first focusable control is a row's `copy` button and
   * its danger zone arms `Restart host`, which kills every running session, so the footer's own
   * Close is the right place for focus to start.
   */
  it('starts focus on Close, not on a copy button or the restart acknowledgement', async () => {
    const real = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function patched(this: HTMLDialogElement): void {
      real.call(this);
      this.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]),button:not([disabled])')?.focus();
    };
    try {
      const t = await withSnapshot();
      const { el } = mount(<t.HostPanel />);
      expect(document.activeElement).toBe(button(el, 'Close'));
      expect(document.activeElement).not.toBe(el.querySelector('button[aria-label="Close"]'));
    } finally {
      HTMLDialogElement.prototype.showModal = real;
    }
  });

  it('lists the socket, node and log paths', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.HostPanel />);
    expect(row(el, 'Status')).toBe('connected (protocol v1)');
    expect(row(el, 'Socket')).toBe('/h/run/host.sock');
    expect(row(el, 'Node')).toBe('/usr/local/bin/node');
    expect(row(el, 'App log')).toBe('/h/logs/app.log');
    expect(row(el, 'Host log')).toBe('/h/logs/host.log');
    expect(row(el, 'Host stdio log')).toBe('/h/logs/host-stdio.log');
  });

  it('counts this app\'s running sessions apart from the host\'s own', async () => {
    const t = await withSnapshot({}, snapshotWith({
      host: host({ sessions: 5 }),
      sessions: { a1: session('a1', 'working'), a2: session('a2', 'stopped') },
    }));
    const { el } = mount(<t.HostPanel />);
    expect(row(el, 'Sessions')).toContain('1 running in this app');
    expect(row(el, 'Sessions')).toContain('5 known to the host');
  });

  /**
   * The banner's "Details" action can be clicked before `workspace:get` answers — `bootstrap.ts`
   * holds a `pendingHost` precisely because a `host:status` can arrive first — so returning null
   * for a missing snapshot would make that button do nothing in the one situation the panel exists
   * for. Measured by putting the plan's `if (!snapshot) return null` back: this test fails on the
   * missing `<h2>` ("expected undefined to be 'Session host'"), 2 failed of 38.
   */
  it('still opens, with placeholders, before the first snapshot arrives', async () => {
    const t = await load({});
    const { el } = mount(<t.HostPanel />);
    expect(el.querySelector('h2')?.textContent).toBe('Session host');
    expect(row(el, 'Status')).toBe('connecting…');
    expect(row(el, 'Socket')).toBe('—');
    expect(row(el, 'App log')).toBe('—');
  });

  it('shows the failure reason when the host never came up', async () => {
    const t = await withSnapshot({}, snapshotWith({ host: host({ connected: false, lastError: 'Node.js not found' }) }));
    const { el } = mount(<t.HostPanel />);
    expect(row(el, 'Status')).toBe('Node.js not found');
  });

  it('keeps Restart host disabled until the kill warning is acknowledged', async () => {
    const t = await withSnapshot({ 'host:restart': { reply: { ok: true, value: undefined } } });
    const { el } = mount(<t.HostPanel />);
    expect(button(el, 'Restart host').disabled).toBe(true);
    click(el.querySelector('input[type="checkbox"]'));
    expect(button(el, 'Restart host').disabled).toBe(false);
    click(button(el, 'Restart host'));
    await flush();
    expect(payloadsFor(t.calls, 'host:restart')).toEqual([{ killSessions: true }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /** A failed restart toasts through the error sink; closing the panel would hide the one surface that explains the host. */
  it('stays open when the restart fails', async () => {
    const t = await withSnapshot();
    act(() => t.ui.useUi.getState().openDialog({ kind: 'host-panel' }));
    const { el } = mount(<t.HostPanel />);
    click(el.querySelector('input[type="checkbox"]'));
    click(button(el, 'Restart host'));
    await flush();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'host-panel' });
    expect(button(el, 'Restart host').disabled).toBe(false);
  });

  it('copies a path through the IPC clipboard rather than the DOM one', async () => {
    const t = await withSnapshot({ 'app:copyToClipboard': { reply: { ok: true, value: undefined } } });
    const { el } = mount(<t.HostPanel />);
    const socketRow = [...el.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === 'Socket');
    click(socketRow?.querySelector('button'));
    await flush();
    expect(payloadsFor(t.calls, 'app:copyToClipboard')).toEqual([{ text: '/h/run/host.sock' }]);
  });

  it('offers no copy button for a row it has no value for', async () => {
    const t = await load({});
    const { el } = mount(<t.HostPanel />);
    // `row` throws when the row is missing, so this cannot pass by the row simply not existing.
    expect(row(el, 'Socket')).toBe('—');
    const socketRow = [...el.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === 'Socket');
    expect(socketRow?.querySelector('button')).toBeNull();
  });
});

/**
 * G59/G61. A status bar counts sessions and a host panel counts them again; both are one
 * `Object.values(...).filter(...)` away from an infinite render loop that `tsc`, `eslint` and every
 * pure test above stay green through.
 */
describe('render counts', () => {
  const cases: [string, (t: Awaited<ReturnType<typeof withSnapshot>>) => ReactNode][] = [
    ['status bar', (t) => <t.StatusBar />],
    ['banners', (t) => <t.Banners />],
    ['host panel', (t) => <t.HostPanel />],
  ];

  for (const [label, render] of cases) {
    it(`commits once for the ${label}, and does not loop under StrictMode`, async () => {
      const t = await withSnapshot({}, snapshotWith({ sessions: { a1: session('a1', 'working'), a2: session('a2', 'needs-permission') } }));
      act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'warn', text: 'Reconnecting to session host…' }));
      const plain = mount(render(t));
      expect(plain.commits()).toBe(1);
      const strict = mountStrict(render(t));
      expect(strict.commits()).toBeLessThanOrEqual(2);
      await flush();
      expect(plain.commits()).toBeLessThanOrEqual(2);
    });
  }

  /**
   * The G61 case, and the one a populated test provably cannot reach: no snapshot, no sessions,
   * no banners.
   *
   * Two mutations measured on this file, both restored afterwards:
   *   - an ALWAYS-allocating session selector (`useSessions((s) => Object.fromEntries(
   *     Object.entries(s.sessions).filter(([, v]) => v !== undefined)))`, the natural way to write
   *     a count) fails 15 of these 38 tests, this one among them. A loud bug; any of them catches it.
   *   - the LATENT `?? []` shape allocates only on its nullish path, so it is invisible with a
   *     snapshot loaded: the control two tests below throws "Maximum update depth exceeded" from
   *     `load({})` and, switched to `withSnapshot()`, does not throw at all — "expected [Function]
   *     to throw an error", 1 failed of 38. That is the whole reason this test mounts with nothing
   *     in the stores.
   */
  it('commits once with no snapshot, no sessions and no banners at all', async () => {
    const t = await load({});
    for (const [label, render] of cases) {
      const { commits } = mount(render(t));
      expect(commits(), label).toBe(1);
    }
  });

  it('costs the status bar nothing when an unrelated ui change lands', async () => {
    const t = await withSnapshot();
    const { commits } = mount(<t.StatusBar />);
    const before = commits();
    act(() => t.ui.useUi.getState().toast({ level: 'info', title: 'hello' }));
    act(() => t.ui.useUi.getState().setSearch('alpha'));
    expect(commits() - before).toBe(0);
  });

  /**
   * The control. Without it, "commits === 1" above could mean the probe is blind rather than the
   * components being stable — Task 4 and Task 5 both shipped selector loops past green suites.
   * This is the exact shape a status bar invites: count the sessions inside the selector.
   */
  it('catches a counting selector — exactly what a status bar must not do', async () => {
    const t = await withSnapshot({}, snapshotWith({ sessions: { a1: session('a1', 'working') } }));
    const Looping = (): ReactNode => {
      const running = t.sessionsStore.useSessions((s) => Object.values(s.sessions).filter((x) => x !== undefined && x.activity !== 'stopped'));
      return <span>{running.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });

  /** …and the latent half of the same hazard: a `?? []` that only allocates with no snapshot (G61). */
  it('catches a `?? []` selector in the state where it allocates', async () => {
    const t = await load({});
    const Looping = (): ReactNode => {
      const agents = t.workspace.useWorkspace((s) => s.snapshot?.workspace.agents ?? []);
      return <span>{agents.length}</span>;
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
 * G60. Task 4 shipped with right-click broken on every sidebar row while 633 tests stayed green,
 * because not one dispatched a REAL bubbling event through the real tree.
 *
 * Measured for this task: `StatusBar` is a SIBLING of the row that holds the sidebar, the pane
 * column and the drawer, and App's root `<div>` carries no handlers; `Banners` sits inside
 * `<main>`, whose only other children are the empty drag bar and `PaneGrid` — and `Pane`'s
 * `onMouseDownCapture` is on the pane element itself, not on `<main>`. So nothing above either
 * component handles `contextmenu`, `mousedown` or `click`, and NEITHER adds a `stopPropagation()`
 * guard: there is nothing to stop, and an untested guard here would be the blind capture-phase
 * pair Task 6 found and deleted.
 *
 * These tests are what keeps that true, and they were measured by moving the status bar (both
 * moves restored afterwards):
 *   - into `<main>`: the placement test below fails, 1 of 38.
 *   - into `Sidebar`'s `<aside>`: the placement test AND the borrowed-menu test fail, 2 of 38 —
 *     the sidebar's own `onContextMenu` really does steal a right-click on the host chip, which is
 *     what says the borrowed-menu probe is not blind.
 */
describe('event routing through the real App', () => {
  async function mountApp(layout: Partial<Layout> = {}) {
    const t = await load({
      'workspace:get': { reply: { ok: true, value: snapshotWith({ sessions: { a1: session('a1', 'working') } }, layout) } },
      'config:get': { reply: { ok: true, value: defaultAppConfig('/bin/zsh') } },
      'layout:set': { reply: { ok: true, value: undefined } },
      'app:windowFocused': { reply: { ok: true, value: undefined } },
      'agent:markOpened': { reply: { ok: true, value: undefined } },
    });
    const { el } = mount(<t.App />);
    await flush();
    return { t, el };
  }

  it('puts the status bar outside the pane column and the sidebar, and the banners inside it', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'warn', text: 'Reconnecting to session host…' }));
    const main = el.querySelector('main') as HTMLElement;
    const aside = el.querySelector('aside') as HTMLElement;
    const bar = [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('host: ')) as HTMLElement;
    expect(main.contains(bar)).toBe(false);
    expect(aside.contains(bar)).toBe(false);
    // §12.7: banners belong to the top of the pane grid, not the window — inside `<main>`, above
    // the grid rather than in it.
    const banner = bannerEls(el)[0] as HTMLElement;
    expect(main.contains(banner)).toBe(true);
    expect(aside.contains(banner)).toBe(false);
    expect((main.querySelector('.grid') as HTMLElement | null)?.contains(banner) ?? false).toBe(false);
  });

  it('does not borrow the sidebar background menu on a right-click in the status bar or a banner', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'warn', text: 'Reconnecting to session host…' }));
    for (const target of [[...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('host: ')), bannerEls(el)[0]]) {
      act(() => void (target as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      expect(t.ui.useUi.getState().contextMenu).toBeNull();
    }
  });

  it('opens the host panel from the real status bar, through the whole tree', async () => {
    const { t, el } = await mountApp({ panes: ['a1'], focusedIndex: 0 });
    const bar = [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('host: ')) as HTMLElement;
    act(() => bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'host-panel' });
    expect(el.querySelector('dialog')?.querySelector('h2')?.textContent).toBe('Session host');
    expect(row(el.querySelector('dialog') as HTMLElement, 'Sessions')).toContain('1 running in this app');
  });

  it('dismisses a banner on a real bubbling click without moving pane focus', async () => {
    const { t, el } = await mountApp({ panes: ['a1', 'a2'], focusedIndex: 1 });
    act(() => t.ui.useUi.getState().setBanner({ id: 'host', level: 'warn', text: 'Reconnecting to session host…' }));
    const dismiss = el.querySelector('[role="status"] button[aria-label="Dismiss"]') as HTMLElement;
    act(() => {
      dismiss.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(t.ui.useUi.getState().banners).toEqual([]);
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });

  it('shows the host banner and the matching status-bar chip when the host drops', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    expect(el.textContent).toContain('host: connected');
    t.emit('host:status', host({ connected: false, lastError: null }));
    expect(el.textContent).toContain('host: connecting…');
    expect(bannerEls(el)[0]?.textContent).toContain('Reconnecting to session host…');
    // …and the banner's own action reaches the panel it names.
    click(button(bannerEls(el)[0] as HTMLElement, 'Details'));
    expect(el.querySelector('dialog')?.querySelector('h2')?.textContent).toBe('Session host');
    t.emit('host:status', host({ connected: true }));
    expect(bannerEls(el)).toHaveLength(0);
    expect(el.textContent).toContain('host: connected');
  });
});
