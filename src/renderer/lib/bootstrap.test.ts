// Covers the four failures the Task 2 review found in `bootstrap()`, none of which any test
// touched: a rejected `workspace:get` reaching nobody, a slow reply clobbering a newer pushed
// snapshot, a `host:status` arriving before the first snapshot being dropped, and a disposed
// bootstrap still writing to the stores.
//
// Same loading dance as api.test.ts: `lib/api.ts` reads `window.hangar` at module-evaluation time,
// so the bridge is installed first and every module is then imported dynamically, after
// `vi.resetModules()`, so the stores under test are the same instances `bootstrap()` closes over.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcReply } from '../../../shared/ipc-contract.ts';
import { defaultLayout, emptyWorkspace, type HostStatus, type WorkspaceSnapshot } from '../../../shared/types.ts';

const host = (patch: Partial<HostStatus> = {}): HostStatus => ({ connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null, ...patch });

const snapshot = (patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  workspace: { ...emptyWorkspace(), layout: defaultLayout() },
  sessions: {},
  runtime: {},
  host: host(),
  profile: { home: '/h', isDefault: true },
  ...patch,
});

async function load() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  let settleGet: ((reply: IpcReply<unknown>) => void) | null = null;
  const getReply = new Promise<IpcReply<unknown>>((resolve) => {
    settleGet = resolve;
  });
  const calls: string[] = [];
  const bridge = {
    invoke: (channel: string) => {
      calls.push(channel);
      return channel === 'workspace:get' ? getReply : Promise.resolve({ ok: true as const, value: undefined });
    },
    on: (channel: string, handler: (payload: unknown) => void) => {
      const list = listeners.get(channel) ?? [];
      list.push(handler);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
    },
  } as unknown as HangarBridge;
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [{ bootstrap, hostBanner }, ui, workspace, layout, api] = await Promise.all([
    import('./bootstrap.ts'),
    import('../stores/ui.ts'),
    import('../stores/workspace.ts'),
    import('../stores/layout.ts'),
    import('./api.ts'),
  ]);
  return {
    bootstrap,
    hostBanner,
    ui,
    workspace,
    layout,
    api,
    calls,
    emit: (channel: string, payload: unknown) => {
      for (const h of listeners.get(channel) ?? []) h(payload);
    },
    resolveGet: (value: WorkspaceSnapshot) => settleGet?.({ ok: true, value }),
    failGet: (code: string, message: string) => settleGet?.({ ok: false, error: { code, message } }),
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('bootstrap', () => {
  it('routes a failed workspace:get to the error sink as a sticky toast (C2)', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    t.failGet('HOST_DOWN', 'host is down');
    await t.flush();
    const toasts = t.ui.useUi.getState().toasts;
    // Before the fix this was `void api.invoke(...).then(...)`: 0 toasts, snapshot left null, and
    // an unhandled IpcCallError. `HOST_DOWN` is exactly the code the sink makes sticky, so the
    // one failure that most needs saying was the one silently swallowed.
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toMatchObject({ level: 'error', title: 'host is down', sticky: true });
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    dispose();
  });

  it('does not let a slow workspace:get overwrite a newer pushed snapshot (C3)', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    const pushed = snapshot();
    pushed.workspace.layout = { ...defaultLayout(), sidebarWidth: 999 };
    t.emit('workspace:changed', pushed);
    // The reply main assembled BEFORE that push now lands.
    t.resolveGet(snapshot());
    await t.flush();
    expect(t.workspace.useWorkspace.getState().snapshot?.workspace.layout.sidebarWidth).toBe(999);
    dispose();
  });

  it('keeps a host:status that arrived before the first snapshot (I4)', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    t.emit('host:status', host({ connected: false, lastError: 'boom' }));
    // The snapshot main built before that status carries the stale `connected: true`.
    t.resolveGet(snapshot());
    await t.flush();
    const state = t.workspace.useWorkspace.getState().snapshot;
    expect(state?.host.connected).toBe(false);
    expect(state?.host.lastError).toBe('boom');
    expect(t.ui.useUi.getState().banners).toMatchObject([{ id: 'host', level: 'error' }]);
    dispose();
  });

  it('clears the host banner when the host reconnects', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    t.resolveGet(snapshot());
    await t.flush();
    t.emit('host:status', host({ connected: false, lastError: null }));
    expect(t.ui.useUi.getState().banners).toMatchObject([{ id: 'host', level: 'warn' }]);
    t.emit('host:status', host({ connected: true }));
    expect(t.ui.useUi.getState().banners).toEqual([]);
    dispose();
  });

  it('applies a host:status arriving after the first snapshot', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    t.resolveGet(snapshot());
    await t.flush();
    t.emit('host:status', host({ connected: false, lastError: 'later' }));
    expect(t.workspace.useWorkspace.getState().snapshot?.host.lastError).toBe('later');
    dispose();
  });

  it('writes nothing to the stores after dispose, and restores the error sink (I8)', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    dispose();
    // StrictMode's double-invoke makes bootstrap -> dispose -> bootstrap the expected dev path, so
    // a disposed instance settling its in-flight `workspace:get` must not write.
    t.resolveGet(snapshot());
    t.emit('workspace:changed', snapshot());
    t.emit('session:state', { agentId: 'a1', state: { agentId: 'a1', activity: 'working' } });
    t.emit('toast', { level: 'info', title: 'late' });
    await t.flush();
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    expect(t.ui.useUi.getState().toasts).toEqual([]);
    // And the sink no longer points into the torn-down closure: a failure now goes to console,
    // not to a ui store this bootstrap no longer owns.
    await t.api.run('agent:stop', { id: 'x' });
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  it('opens the agent a notification click names, and stops after dispose', async () => {
    // Plan 05 Task 2. Main raises the window itself; `agent:focus` is the half only the renderer
    // can do — it owns the layout. This is the whole renderer side of the feature: everything about
    // WHICH agent and WHETHER to notify is decided in `src/main/services/notifications.ts`.
    const t = await load();
    const dispose = t.bootstrap();
    t.emit('agent:focus', { agentId: 'a7' });
    expect(t.layout.layoutStore.getState().layout.panes[0]).toBe('a7');
    expect(t.calls).toContain('agent:markOpened');
    dispose();
    t.emit('agent:focus', { agentId: 'a9' });
    expect(t.layout.layoutStore.getState().layout.panes[0]).toBe('a7');
  });

  /**
   * Plan 09. The subscription is the whole renderer side of an outcome: it lands in the store WITH
   * its agent, and only the events that end a run say anything. `write` is silent (main has typed it
   * into the session already) and so is `cancelled`.
   */
  it('takes dictation:event into the store with its agent, and says only nothing and errors', async () => {
    const t = await load();
    const dictation = await import('../stores/dictation.ts');
    const dispose = t.bootstrap();
    t.emit('dictation:event', { agentId: 'a1', state: { phase: 'recording', partial: 'hi' }, outcome: null });
    expect(dictation.useDictation.getState()).toMatchObject({ agentId: 'a1', state: { phase: 'recording', partial: 'hi' } });
    const titles = () => t.ui.useUi.getState().toasts.map((x) => x.title);
    for (const outcome of [{ kind: 'write', text: 'hi' }, { kind: 'cancelled' }] as const) {
      t.emit('dictation:event', { agentId: 'a1', state: { phase: 'idle', outcome }, outcome });
    }
    expect(titles()).toEqual([]);
    const nothing = { kind: 'nothing', message: 'Nothing heard.' } as const;
    t.emit('dictation:event', { agentId: 'a1', state: { phase: 'idle', outcome: nothing }, outcome: nothing });
    const error = { kind: 'error', code: 'NO_INPUT', message: 'No audio from the microphone. Check the input device in System Settings → Sound.' } as const;
    t.emit('dictation:event', { agentId: 'a2', state: { phase: 'idle', outcome: error }, outcome: error });
    expect(titles()).toEqual(['Nothing heard.', 'No audio from the microphone. Check the input device in System Settings → Sound.']);
    expect(t.ui.useUi.getState().toasts.map((x) => x.level)).toEqual(['info', 'error']);
    expect(dictation.useDictation.getState().agentId).toBe('a2');
    dispose();
    t.emit('dictation:event', { agentId: 'a3', state: { phase: 'starting' }, outcome: null });
    expect(dictation.useDictation.getState().agentId).toBe('a2');
  });

  it('hydrates the layout once, from the first snapshot only', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    const first = snapshot();
    first.workspace.layout = { ...defaultLayout(), sidebarWidth: 321 };
    t.emit('workspace:changed', first);
    expect(t.layout.layoutStore.getState().hydrated).toBe(true);
    expect(t.layout.layoutStore.getState().layout.sidebarWidth).toBe(321);
    // A later snapshot must not stomp a layout the user has since changed locally.
    const second = snapshot();
    second.workspace.layout = { ...defaultLayout(), sidebarWidth: 200 };
    t.emit('workspace:changed', second);
    expect(t.layout.layoutStore.getState().layout.sidebarWidth).toBe(321);
    dispose();
  });
});

/**
 * Plan 09. The mic button and Escape both live in the agent's PANE, so a run whose agent no pane shows
 * any more has nothing on screen that can stop it. `bootstrap()` cancels such a run — once — and
 * leaves every run whose agent is still in SOME pane alone.
 *
 * Every test starts from a hydrated layout of three panes, `a1 | a2 | (empty)`, with the focus on
 * `a1`'s, and counts `dictation:cancel` requests — the only thing this feature ever sends.
 */
describe('a dictation run with no pane left', () => {
  const RECORDING = { phase: 'recording', partial: 'so far' } as const;

  async function dictating(opts: { hydrate?: boolean } = {}) {
    const t = await load();
    const dispose = t.bootstrap();
    const layout = () => t.layout.layoutStore.getState();
    if (opts.hydrate !== false) layout().hydrate({ ...defaultLayout(), panes: ['a1', 'a2', null], focusedIndex: 0, arrangement: 'triple' });
    const heard = (agentId: string, state: unknown, outcome: unknown = null) => t.emit('dictation:event', { agentId, state, outcome });
    const ended = (agentId: string, outcome: unknown) => heard(agentId, { phase: 'idle', outcome }, outcome);
    const cancels = () => t.calls.filter((c) => c === 'dictation:cancel').length;
    return { ...t, dispose, layout, heard, ended, cancels };
  }

  it("closing the recording agent's pane cancels the run exactly once", async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    expect(t.cancels()).toBe(0);
    t.layout().closePane(0);
    expect(t.layout().layout.panes).not.toContain('a1');
    expect(t.cancels()).toBe(1);
    // Everything that can happen before the run's own `idle` arrives — more partials, the stop's
    // `finalizing`, further layout changes — sends nothing more.
    t.heard('a1', { phase: 'recording', partial: 'so far and more' });
    t.heard('a1', { phase: 'finalizing', partial: 'so far and more' });
    t.layout().setSidebar({ width: 300 });
    t.layout().closePane(0);
    expect(t.cancels()).toBe(1);
    t.ended('a1', { kind: 'cancelled' });
    expect(t.cancels()).toBe(1);
    t.dispose();
  });

  it("replacing that pane's agent with another cancels the run", async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    t.layout().openInFocused('a3');
    expect(t.layout().layout.panes).toEqual(['a3', 'a2', null]);
    expect(t.cancels()).toBe(1);
    t.dispose();
  });

  it('moving the agent to another pane does not cancel it', async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    t.layout().swapPanes(0, 1);
    expect(t.layout().layout.panes).toEqual(['a2', 'a1', null]);
    t.layout().swapPanes(1, 2);
    expect(t.layout().layout.panes).toEqual(['a2', null, 'a1']);
    expect(t.cancels()).toBe(0);
    t.dispose();
  });

  it('closing a pane that shows some other agent does not cancel it', async () => {
    // Dictating into `a2`, the SECOND pane, so closing the first one also shifts the run's pane down
    // an index: the agent is what is watched, not a slot.
    const t = await dictating();
    t.heard('a2', RECORDING);
    t.layout().closePane(0);
    expect(t.layout().layout.panes).toEqual(['a2', null]);
    t.layout().closePane(1);
    expect(t.layout().layout.panes).toEqual(['a2']);
    expect(t.cancels()).toBe(0);
    t.dispose();
  });

  it('sends nothing when no run is active', async () => {
    const t = await dictating();
    t.layout().closePane(0);
    t.layout().closePane(0);
    expect(t.layout().layout.panes).toEqual([null]);
    expect(t.cancels()).toBe(0);
    t.dispose();
  });

  it('does not cancel a run that has already ended', async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    t.ended('a1', { kind: 'write', text: 'so far' });
    t.layout().closePane(0);
    expect(t.cancels()).toBe(0);
    t.dispose();
  });

  it("cancels a run whose first event lands after its agent's pane has gone", async () => {
    // The press, then ⌘W before `starting` arrives: no layout change is left to notice it, so the
    // dictation store's own change has to.
    const t = await dictating();
    t.layout().closePane(0);
    expect(t.cancels()).toBe(0);
    t.heard('a1', { phase: 'starting' });
    expect(t.cancels()).toBe(1);
    t.dispose();
  });

  it('cancels each orphaned run once, not once ever', async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    t.layout().closePane(0);
    t.ended('a1', { kind: 'cancelled' });
    expect(t.cancels()).toBe(1);
    // The next run, for the agent that now has the pane, is its own run.
    t.heard('a2', { phase: 'starting' });
    t.heard('a2', RECORDING);
    expect(t.cancels()).toBe(1);
    t.layout().openInFocused('a4');
    expect(t.cancels()).toBe(2);
    t.dispose();
  });

  it('waits for the layout: a run heard before it hydrates is not cancelled for the default empty pane', async () => {
    // A renderer reloaded mid-run hears the run's partials before `workspace:get` answers, while the
    // store still holds `defaultLayout()`'s one empty pane. The real layout, once it lands, shows the agent.
    const t = await dictating({ hydrate: false });
    t.heard('a1', RECORDING);
    t.heard('a1', { phase: 'recording', partial: 'so far and more' });
    expect(t.cancels()).toBe(0);
    t.layout().hydrate({ ...defaultLayout(), panes: ['a2', 'a1'], arrangement: 'split-h' });
    expect(t.cancels()).toBe(0);
    t.layout().closePane(1);
    expect(t.cancels()).toBe(1);
    t.dispose();
  });

  it('stops watching after dispose', async () => {
    const t = await dictating();
    t.heard('a1', RECORDING);
    t.dispose();
    t.layout().closePane(0);
    expect(t.cancels()).toBe(0);
  });
});

/**
 * Spec §12.7's banner condition, "host disconnected/outdated" — and the `outdated` half was
 * unreachable before Task 9. `src/main/index.ts` reports a protocol mismatch as `connected: true`
 * WITH a `lastError`, and the old mapping cleared the banner on any connected status, so the one
 * state that says "attached to a host this app may not drive" showed nothing at all: `StatusBar`
 * would have painted it green and said "connected".
 */
describe('hostBanner', () => {
  it('maps all four host states', async () => {
    const t = await load();
    expect(t.hostBanner(host())).toBeNull();
    expect(t.hostBanner(host({ lastError: 'speaks protocol 3' }))).toMatchObject({ id: 'host', level: 'warn', text: 'Session host is outdated: speaks protocol 3' });
    expect(t.hostBanner(host({ connected: false, lastError: 'boom' }))).toMatchObject({ id: 'host', level: 'error', text: 'Session host: boom' });
    expect(t.hostBanner(host({ connected: false }))).toMatchObject({ id: 'host', level: 'warn', text: 'Reconnecting to session host…' });
  });

  it('gives every banner a Details action that opens the host panel', async () => {
    const t = await load();
    const banner = t.hostBanner(host({ connected: false }));
    expect(banner?.action?.label).toBe('Details');
    banner?.action?.onClick();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'host-panel' });
  });

  it('raises the outdated banner from a real host:status, and clears it when the mismatch goes away', async () => {
    const t = await load();
    const dispose = t.bootstrap();
    t.resolveGet(snapshot());
    await t.flush();
    t.emit('host:status', host({ lastError: 'host speaks protocol 3, this app speaks 4' }));
    expect(t.ui.useUi.getState().banners).toMatchObject([{ id: 'host', level: 'warn' }]);
    // …and the snapshot still carries the status, so the status bar can say "outdated" too.
    expect(t.workspace.useWorkspace.getState().snapshot?.host.lastError).toBe('host speaks protocol 3, this app speaks 4');
    t.emit('host:status', host());
    expect(t.ui.useUi.getState().banners).toEqual([]);
    dispose();
  });
});
