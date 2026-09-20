import { api, resetErrorSink, run, setErrorSink } from './api.ts';
import { openAgent } from './agent-actions.ts';
import { dictationRefused, receiveDictation } from './dictation.ts';
import { isActive } from '../../../shared/dictation.ts';
import { focusedAgent } from '../../../shared/layout.ts';
import type { HostStatus, WorkspaceSnapshot } from '../../../shared/types.ts';
import { useConfig } from '../stores/config.ts';
import { useDictation } from '../stores/dictation.ts';
import { layoutStore } from '../stores/layout.ts';
import { useSessions } from '../stores/sessions.ts';
import { useUi, type Banner } from '../stores/ui.ts';
import { useWorkspace } from '../stores/workspace.ts';

export const HOST_BANNER_ID = 'host';

/**
 * Spec §12.7's banner condition: "host disconnected/outdated".
 *
 * The `outdated` half was unreachable until Task 9. `src/main/index.ts` reports a protocol
 * mismatch as `connected: true` WITH a `lastError` — the socket is up, the app just may not drive
 * that host (§8.3 step 4) — and the old mapping here was `if (h.connected) clearBanner('host')`,
 * so the one status that says "you are attached to a host you cannot use" cleared the banner
 * instead of raising one. Main's sticky toast was the only surviving signal, and a toast is
 * dismissable in one click.
 *
 * Exported and pure so `bootstrap.test.ts` can walk all four states without an event round trip.
 * The action opens the panel that carries the socket path, the log paths and the restart button —
 * which is why `HostPanel` renders with a null snapshot: this banner can exist before the first
 * one arrives.
 */
export function hostBanner(h: HostStatus): Banner | null {
  const action = { label: 'Details', onClick: () => useUi.getState().openDialog({ kind: 'host-panel' }) };
  if (h.lastError !== null) {
    return h.connected
      ? { id: HOST_BANNER_ID, level: 'warn', text: `Session host is outdated: ${h.lastError}`, action }
      : { id: HOST_BANNER_ID, level: 'error', text: `Session host: ${h.lastError}`, action };
  }
  if (h.connected) return null;
  return { id: HOST_BANNER_ID, level: 'warn', text: 'Reconnecting to session host…', action };
}

/**
 * Plan 09. A dictation run whose agent no pane shows any more is cancelled, once.
 *
 * The mic button and Escape both live in the agent's PANE. Close that pane mid-run, or show another
 * agent in it, and nothing on screen can stop the run: the microphone stays open until the helper's
 * 120 s cap, and the transcript is then typed into a prompt nobody is looking at. So one watcher,
 * here and not in `Pane` (a closed pane has no component left to notice that it closed), cancels the
 * run the moment its agent is in NO pane. Being in some pane is the whole test: moving the agent to
 * another pane keeps the run, and closing a pane that shows a different agent is not the run's
 * business. `finalizing` counts as alive too — cancelling there drops the transcript on its way in,
 * which is the point.
 *
 * Both stores feed the same check, because either can orphan a run: the layout when a pane is closed
 * or re-pointed, and the dictation store when a run's first event lands after its pane has already
 * gone (a press, then ⌘W, before `starting` arrives).
 *
 * Cheap. A vanilla `subscribe`, not a hook, so there is no selector and no render (G59/G61 cannot
 * arise), and the first question is `isActive`, which is false for almost every call — the layout
 * store `set`s on every mousemove of a sidebar or drawer drag. Only while a run is alive does it read
 * the layout, and then it scans at most four panes.
 *
 * At most once per run. `sent` latches on the cancel and only a state that is NOT active releases it:
 * the run's own ending `idle`, which main broadcasts for every run and before the next run's first
 * event (one helper at a time, app-wide). Without the latch, every partial between the cancel and its
 * `idle` would send another.
 *
 * Not before the layout has hydrated. Until the first snapshot lands the store holds
 * `defaultLayout()`'s single empty pane, in which EVERY agent is in no pane, so an active run seen
 * then would be cancelled for a pane that has simply not been read yet. Today no run can be active at
 * that moment: `index.ts` cancels every run on `did-start-loading`, so a reloaded renderer's first
 * dictation event is that run's own ending `idle` (queued, and delivered on `did-finish-load`), which
 * is not active and sends nothing; and a new run can only start from a mic button, which needs the
 * layout. The guard is kept so the watcher is right on its own terms rather than by leaning on that.
 */
function cancelDictationWithoutPane(): () => void {
  let sent = false;
  const check = (): void => {
    const { agentId, state } = useDictation.getState();
    if (!isActive(state)) {
      sent = false;
      return;
    }
    if (sent || agentId === null) return;
    const { hydrated, layout } = layoutStore.getState();
    if (!hydrated || layout.panes.includes(agentId)) return;
    sent = true;
    void run('dictation:cancel', undefined, dictationRefused);
  };
  const offDictation = useDictation.subscribe(check);
  const offLayout = layoutStore.subscribe(check);
  return () => {
    offDictation();
    offLayout();
  };
}

/** Subscribes the stores to main's events. Returns an unsubscribe function. */
export function bootstrap(): () => void {
  // React 19 StrictMode double-invokes effects in dev, so bootstrap -> dispose -> bootstrap is the
  // expected path, not an error case. Everything below that can land after teardown — the awaited
  // `workspace:get`, the interval, any event still in flight — checks this first, so a disposed
  // bootstrap can never write to a store the live one now owns.
  let disposed = false;
  // Stops a slow initial `workspace:get` from overwriting a newer pushed snapshot with an older
  // one. Carried across from Task 1's App.tsx, which predicted this exact task: "harmless in a
  // shell with one piece of state; a real bug the moment Task 2's stores hang off this". Measured
  // without it: a `workspace:changed` carrying `sidebarWidth: 999` and `host.connected: true` was
  // reverted to 260 / false when the slower reply landed.
  let pushed = false;
  // A `host:status` can arrive before the first snapshot exists to patch. Dropping it (the old
  // `if (snap)`) lost it, and the reply to `workspace:get` — assembled by main BEFORE that status
  // — then wrote the stale value over it. Held here and applied to the first snapshot instead.
  let pendingHost: HostStatus | null = null;

  const applySnapshot = (snapshot: WorkspaceSnapshot): void => {
    if (disposed) return;
    const merged = pendingHost === null ? snapshot : { ...snapshot, host: pendingHost };
    pendingHost = null;
    useWorkspace.getState().setSnapshot(merged);
    useSessions.getState().setAll(merged.sessions);
    if (!layoutStore.getState().hydrated) layoutStore.getState().hydrate(merged.workspace.layout);
  };

  setErrorSink((e) => useUi.getState().toast({ level: 'error', title: e.message, detail: e.detail ?? e.code, sticky: e.code === 'HOST_DOWN' }));
  // AFTER the sink, not as the plan's "first line inside bootstrap()". `load()` routes its failures
  // through `run`, so firing it before the sink is installed would send a failed `config:get`
  // straight to `console.error` instead of a toast. It happens to be safe today — `run` awaits, so
  // the catch cannot run before this synchronous line — but that is an accident of microtask
  // ordering, not something this file should depend on.
  //
  // Not gated on `disposed`: `config` is app-wide and idempotent, not per-bootstrap state, so a
  // reply landing after teardown (React 19 StrictMode makes bootstrap -> dispose -> bootstrap the
  // expected path) writes the same value the next bootstrap would fetch anyway.
  void useConfig.getState().load();
  const offs = [
    api.on('workspace:changed', (snapshot) => {
      pushed = true;
      applySnapshot(snapshot);
    }),
    api.on('session:state', ({ agentId, state }) => {
      if (!disposed) useSessions.getState().setOne(agentId, state);
    }),
    api.on('toast', (t) => {
      if (!disposed) useUi.getState().toast(t);
    }),
    // The user clicked a macOS notification. Main raises the window itself and sends this only for
    // an agent that is still in the workspace (`src/main/services/notifications.ts` re-checks at
    // click time, because a banner can sit in Notification Center for days) — so there is no second
    // existence check here, and `Pane` renders `EmptyPane` for an id it cannot resolve anyway.
    //
    // `openAgent(id, false)`, matching a sidebar click: the focused pane, not a fifth pane that
    // does not exist. It marks the agent opened for the §12.2 sort, which is right — the user did
    // open it.
    //
    // The `!disposed` check is UNREACHABLE today and is kept for consistency with its two siblings
    // above, not because a test covers it: `dispose()` calls the bridge's unsubscribe
    // synchronously (`ipcRenderer.removeListener` in the preload, an array filter in the test
    // bridge), so no `api.on` listener can fire afterwards. Measured — removing it from this
    // handler, from `session:state` and from `toast` in turn each left all 1125 tests green. Only
    // `applySnapshot`'s check is reachable, because the awaited `workspace:get` can settle late.
    api.on('agent:focus', ({ agentId }) => {
      if (!disposed) openAgent(agentId, false);
    }),
    // Plan 09. A BROADCAST carrying the agent its run belongs to (G89): the store keeps the pair and
    // every pane correlates on it, and the one event per run that carries an outcome says its
    // sentence here — once, whether or not a pane for that agent is still open. Main has already
    // typed a `write` into the session; nothing on this side writes anything.
    api.on('dictation:event', (event) => {
      if (!disposed) receiveDictation(event);
    }),
    // …and the run that has lost its pane, whichever of the two stores lost it.
    cancelDictationWithoutPane(),
    api.on('host:status', (h) => {
      if (disposed) return;
      const ui = useUi.getState();
      const banner = hostBanner(h);
      if (banner === null) ui.clearBanner(HOST_BANNER_ID);
      else ui.setBanner(banner);
      const snap = useWorkspace.getState().snapshot;
      if (snap === null) pendingHost = h;
      else useWorkspace.getState().setSnapshot({ ...snap, host: h });
    }),
  ];
  // `run`, not `api.invoke`. `api` is the WRAPPED client, which throws; `void api.invoke(...).then(...)`
  // handles no rejection, it only silences the lint rule that would have pointed at it. Measured on
  // a `HOST_DOWN` failure with the old line: 0 toasts, snapshot left null, and an
  // `Unhandled Rejection: IpcCallError` in the console — a permanently blank first run, and blank
  // precisely when the sink above would have made the error sticky. `run` funnels it to that sink.
  void run('workspace:get').then((snapshot) => {
    if (snapshot !== null && !pushed) applySnapshot(snapshot);
  });
  const onFocus = () => {
    void run('app:windowFocused', { focused: true });
    // Returning to the window clears the focused pane's badge. `unread` is set-only in the reducer,
    // so without this a user who cmd-tabs back to an agent they are already looking at keeps a bold
    // name and a folder count for it.
    // `focusedAgent`, not `panes[focusedIndex]`: it clamps an out-of-range index and collapses a
    // sparse-array hole to null in one place (shared/layout.ts), which is why it exists.
    const agentId = focusedAgent(layoutStore.getState().layout);
    if (agentId !== null) void run('agent:markViewed', { id: agentId });
  };
  const onBlur = () => void run('app:windowFocused', { focused: false });
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  // Spec §13's 1 s ticker. No focus argument: `reduceSession`'s `tick` branch never reads `ctx`
  // (checked exhaustively — 256 combinations, 0 differing on `windowFocused`), so passing
  // `document.hasFocus()` here would have implied the renderer and main keep their two focus
  // sources in agreement when nothing checks that, and main's flag starts `true` while
  // `document.hasFocus()` can be false on an unfocused launch.
  const ticker = setInterval(() => {
    if (!disposed) useSessions.getState().tick(Date.now());
  }, 1000);
  return () => {
    disposed = true;
    resetErrorSink();
    clearInterval(ticker);
    for (const off of offs) off();
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}
