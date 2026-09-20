import { useEffect, useRef } from 'react';
import { api, run, type IpcFailure } from '../../lib/api.ts';
import { cancelDictationOnEscape } from '../../lib/dictation.ts';
import { createTerminal, terminals } from '../../lib/terminal-registry.ts';
import { useConfig } from '../../stores/config.ts';
import { useTerminalSearch } from '../../stores/terminal-search.ts';
import { TerminalSearch } from './TerminalSearch.tsx';

/**
 * Failures on the channels the user drives with their hands go to the console, not to a toast.
 *
 * `run`'s default sink is the one `bootstrap()` installs, which raises a toast per failure. That is
 * right for `session:attach` — it happens once and its failure means this pane shows nothing — and
 * wrong for `session:write`, which fires once per KEYSTROKE: with the host down, holding a key
 * would stack a toast per repeat, on top of the sticky HOST_DOWN toast that already says the same
 * thing once. Same for `session:resize` (once per settled resize frame), `agent:markViewed` (once
 * per mousedown in a terminal, i.e. per selection drag) and `session:detach` (cleanup, and the
 * main-side handler deliberately does not even require a host).
 *
 * This is not `void api.invoke(...)`: `api` is the WRAPPED client and it THROWS, so the bare
 * `void` the plan wrote handles no rejection at all and every failure becomes an unhandled promise
 * rejection. Third time this exact correction has been made on this project.
 */
const quiet = (e: IpcFailure): void => console.error('terminal ipc failed', e.code, e.message, e.detail ?? '');

/**
 * Long enough to coalesce a window drag-resize into one PTY resize, short enough that letting go of
 * the mouse feels instant. Each resize is a full SIGWINCH + redraw in Claude's TUI, so the point is
 * to send one, not sixty.
 */
const RESIZE_DEBOUNCE_MS = 60;

/** A chunk waiting for the attach snapshot to be written first. `reset` is a host-pushed respawn. */
type Chunk = { kind: 'data' | 'reset'; data: string };

export function TerminalView({ agentId, paneIndex, focused }: { agentId: string; paneIndex: number; focused: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // G59: `open.has(agentId)` is a boolean — nothing is allocated on either path, so this cannot be
  // the selector that loops. The store is keyed by agent id rather than held here as `useState`
  // because `PaneGrid` keys its panes by SLOT; see `stores/terminal-search.ts`.
  const searchOpen = useTerminalSearch((s) => s.open.has(agentId));
  const closeSearch = useTerminalSearch((s) => s.close);
  // Written in the render body on purpose. The attach below finishes AFTER an await, and by then
  // the `focused` captured in the effect's closure may be stale; the effect keyed on `focused`
  // cannot help, because it does not re-run when only `paneIndex` changes and that is exactly the
  // remount (close pane 0, everything shifts up) where the keyboard would otherwise be lost. This
  // component has no other render-phase side effect and does not suspend.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // `getState()`, not `useConfig(...)`: a font-size change should not tear down a live PTY
    // attachment, which is what putting `config` in this effect's dependency list would do.
    // Re-styling an existing terminal in place is Phase 3's Settings problem.
    const cfg = useConfig.getState().config.terminal;
    const handle = createTerminal({
      fontFamily: cfg.fontFamily,
      fontSize: cfg.fontSize,
      scrollback: cfg.scrollback,
      // G19: xterm sends a bare `\r` for Shift+Enter, which Claude reads as submit. `\n` is Ctrl-J,
      // the newline every terminal documents.
      onShiftEnter: () => void run('session:write', { agentId, data: '\n' }, quiet),
      // `window.open`, deliberately not a second URL test here: `src/main/window.ts`'s
      // `setWindowOpenHandler` already routes this through `externalUrlToOpen` (http/https/mailto
      // only) and always denies the navigation. `setWindowOpenHandler` keeps only its most recent
      // registration, so adding one here would REPLACE the hardened one.
      onOpenLink: (url) => void window.open(url),
      // Plan 09: Escape cancels a dictation into THIS agent, and is the terminal's at every other
      // moment. Read from the store at key time, so a run that started after this terminal was
      // built is still seen — and one that has ended is not.
      onEscape: () => cancelDictationOnEscape(agentId),
    });
    handle.term.open(el);
    handle.enableWebgl();
    terminals.set(agentId, handle);

    let disposed = false;
    let attached = false;
    const cleanups: (() => void)[] = [];
    // `() => sub.dispose()`, not `sub.dispose` unbound: xterm's disposables happen to be closures
    // today, and a method that starts needing `this` would fail here at teardown, silently leaking
    // a keystroke listener onto a disposed terminal.
    const onData = handle.term.onData((data) => void run('session:write', { agentId, data }, quiet));
    cleanups.push(() => onData.dispose());

    /**
     * Chunks that arrived before the attach snapshot was written.
     *
     * Subscribing BEFORE the request, not after it. Main emits `session:data` for every known
     * agent whether or not this pane has attached (`session-registry.ts`'s data relay checks
     * `knownAgent` and nothing else), and the host serialises its snapshot before the reply travels
     * host → main → renderer. Subscribing after the await therefore drops whatever the PTY produced
     * inside that window — a few milliseconds, against a host that frames output every 16 ms, and
     * the loss is permanent because nothing re-sends it. Buffering keeps both the bytes and the
     * ordering.
     */
    let pending: Chunk[] | null = [];
    const applyChunk = (chunk: Chunk): void => {
      if (chunk.kind === 'reset') handle.term.reset();
      handle.term.write(chunk.data);
    };
    const push = (chunk: Chunk): void => {
      if (pending === null) applyChunk(chunk);
      else pending.push(chunk);
    };
    cleanups.push(api.on('session:data', (p) => {
      if (p.agentId === agentId) push({ kind: 'data', data: p.data });
    }));
    // Restart respawns over the exited id, and this effect does not re-run (it is keyed on
    // agentId + paneIndex), so the host pushes a snapshot instead. Reset first, or the new
    // session's screen is painted onto the dead one's. A reconnect re-attach arrives the same way
    // (`session-registry.ts`'s `reattach`).
    cleanups.push(api.on('session:snapshot', (p) => {
      if (p.agentId === agentId) push({ kind: 'reset', data: p.data });
    }));

    // The size main was last told. Also the de-duplicator: a ResizeObserver fires for every pixel,
    // and most pixels do not cross a character cell.
    let sent: { cols: number; rows: number } | null = null;
    const pushSize = (): void => {
      if (!attached || disposed) return;
      const size = handle.fitIfVisible(el);
      if (size === null) return;
      if (sent !== null && sent.cols === size.cols && sent.rows === size.rows) return;
      sent = size;
      void run('session:resize', { agentId, cols: size.cols, rows: size.rows }, quiet);
    };

    const attach = async (): Promise<void> => {
      // The fallback is what gets sent when the pane has not been laid out yet (G8 — see
      // `MIN_FIT_PX`). 120x40 is a plausible pane, not a real measurement, which is precisely why
      // `pushSize()` runs immediately after the reply rather than waiting for the next resize:
      // without it a terminal that mounted at 0x0 would keep the guessed PTY size until the user
      // happened to drag the window.
      const size = handle.fitIfVisible(el) ?? { cols: 120, rows: 40 };
      const res = await run('session:attach', { agentId, paneIndex, cols: size.cols, rows: size.rows });
      if (!res || disposed) {
        // Stop buffering either way. A failed attach that left `pending` an array would grow it for
        // as long as the pane stayed mounted — main broadcasts `session:data` to the renderer
        // whether or not this pane attached, so the queue would never stop filling and never be
        // drained. Writing straight through instead gives a screen with no scrollback history,
        // which is what a pane with no snapshot has anyway.
        pending = null;
        return;
      }
      const queued = pending ?? [];
      pending = null;
      handle.term.write(res.snapshot);
      // In order, snapshot first. A host-pushed `session:snapshot` that beat the reply is in here
      // as a `reset` chunk, so replaying it clears the older attach snapshot rather than being
      // painted under it.
      for (const chunk of queued) applyChunk(chunk);
      attached = true;
      sent = size;
      pushSize();
      if (focusedRef.current) handle.term.focus();
      void run('agent:markViewed', { id: agentId }, quiet);
    };

    // A ResizeObserver on the container, never a `resize` listener on `window`: a pane changes size
    // when a SIBLING pane opens, closes or swaps and when the sidebar or drawer moves, none of
    // which resize the window (G8's mitigation names the observer for this reason).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushSize();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);
    void attach();

    return () => {
      disposed = true;
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      for (const c of cleanups) c();
      if (attached) void run('session:detach', { agentId }, quiet);
      // Guarded rather than an unconditional delete, and honestly: measured on React 19.2.8, a
      // pane swap runs BOTH cleanups before BOTH setups, so the guard never fires today and
      // removing it leaves all 26 tests in TerminalView.test.tsx green. It stays because the
      // invariant is what matters — only the owner clears the entry — and any interleaving of one
      // pane's setup with another's cleanup would otherwise leave the keymap unable to find a live
      // terminal for an agent that has one. One map read on unmount.
      if (terminals.get(agentId) === handle) terminals.delete(agentId);
      handle.dispose();
    };
  }, [agentId, paneIndex]);

  useEffect(() => {
    if (!focused) return;
    terminals.get(agentId)?.term.focus();
    // Also mark it viewed. `unread` is set-only in the reducer, and its other clearing paths are
    // attach (which does not re-run — the effect above is keyed on agentId + paneIndex) and the
    // mousedown below. xterm keeps DOM focus across a window blur/focus cycle, so a user who
    // cmd-tabs back and simply types would never clear the badge — while Claude's ~60 s
    // `idle_prompt` Notification keeps re-arming it. Pane focus is what "looking at this" means.
    void run('agent:markViewed', { id: agentId }, quiet);
  }, [focused, agentId]);

  /**
   * The find bar belongs to a LIVE terminal view, so it closes when this view is torn down.
   *
   * Deliberately its own effect rather than a line in the mount effect above. That effect owns the
   * PTY attachment, and `TerminalView`'s missing StrictMode test (G26/G65, recorded as owed in
   * PROGRESS.md) is owed precisely because a double-invoked mount would run it twice — so nothing
   * new goes in it. `close` is idempotent by construction (`stores/terminal-search.ts` returns
   * early when the agent is not open), which is what makes running this cleanup twice a no-op.
   *
   * Keyed on `[agentId, paneIndex]`, matching the mount effect, so it fires exactly when the
   * terminal it belongs to is disposed. That means a pane MOVE closes the bar: React reconciles
   * panes by slot, so a move either unmounts this view or changes its `agentId`, and neither is
   * distinguishable in a cleanup from a genuine close. Closing is the honest end of that — the
   * `Terminal`, its `SearchAddon` and every decoration are rebuilt from scratch by the re-attach,
   * so a bar left open would be showing highlights that no longer exist.
   */
  useEffect(() => () => closeSearch(agentId), [agentId, paneIndex, closeSearch]);

  return (
    <>
      {/* An OVERLAY, positioned against `Pane.tsx`'s `relative` wrapper, and that is a decision.
          It takes no space in the layout, so the container box never changes, the ResizeObserver
          below never fires and the terminal does not re-fit when the bar appears — which keeps
          G17/G8's stale-80x24 fit path off this route entirely. The trade-off it buys is that the
          bar covers the top-right corner of live output rather than shrinking the terminal to sit
          above it; for a find bar the user has just summoned and will dismiss with Esc, hiding a
          few cells beats reflowing Claude's TUI twice. */}
      {searchOpen ? <TerminalSearch agentId={agentId} onClose={() => closeSearch(agentId)} /> : null}
      <div
        ref={containerRef}
        className="absolute inset-0 px-2 pt-1"
        // CAPTURE, for the same reason `Pane` uses it one level up (G60). xterm's own mouse
        // listeners sit on `.xterm`, a DESCENDANT of this div; React attaches at the root and
        // replays down its own tree, so anything a descendant stops never reaches a bubbling handler
        // here — and this element covers the entire terminal, which is most of the pane.
        //
        // Measured on xterm 6.0.0 in jsdom, so the honest version: xterm does NOT currently stop
        // propagation of mousedown, and a bubbling `onMouseDown` passes the plain
        // "click the terminal" test. It fails the moment anything between here and the root consumes
        // the event — which is what `Pane.tsx`'s comment describes and what a selection gesture in a
        // future xterm would do — and `TerminalView.test.tsx` pins that case with an ancestor that
        // does consume it. Reverting to `onMouseDown` fails that one test alone.
        onMouseDownCapture={() => void run('agent:markViewed', { id: agentId }, quiet)}
      />
    </>
  );
}
