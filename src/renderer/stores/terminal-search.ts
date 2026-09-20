import { create } from 'zustand';
import type { Id } from '../../../shared/types.ts';

/**
 * Which agents have the terminal find bar (⌘F) open.
 *
 * Keyed by AGENT ID, and that is the whole reason this store exists rather than a `useState` inside
 * `TerminalView`. `PaneGrid.tsx` renders its panes with `key={i}`, so React reconciles a pane by
 * SLOT, not by agent: closing pane 0 of two shifts the surviving agent into slot 0, where it reuses
 * slot 0's component instance and every piece of state hanging off it. A flag stored there belongs
 * to the slot, so agent B arriving in slot 0 would inherit whatever agent A left behind — a find bar
 * that follows a pane instead of the terminal it was opened on. Keying by id cannot express that.
 *
 * It also has to be reachable from OUTSIDE the React tree. `keymap.ts` handles ⌘F on a
 * window-capture listener and has only an agent id to work with, exactly as `focusTerminal` does.
 *
 * G59/G61: `open` is a `Set` and every consumer selects `open.has(id)` — a boolean, allocated on
 * neither path, so there is no `?? []`-shaped fallback here to sit latent until the empty case is
 * reached. `terminal-search.test.ts` still mounts a real root against the EMPTY store as well as a
 * populated one, because a populated-only render-count test cannot see that class of bug.
 */
interface TerminalSearchState {
  open: ReadonlySet<Id>;
  toggle: (agentId: Id) => void;
  close: (agentId: Id) => void;
}

export const useTerminalSearch = create<TerminalSearchState>((set, get) => ({
  open: new Set<Id>(),
  toggle: (agentId) => {
    const open = new Set(get().open);
    // `delete` reports whether it removed anything, so this is the toggle without a second lookup.
    if (!open.delete(agentId)) open.add(agentId);
    set({ open });
  },
  /**
   * Two things depend on the early return, so it is not a micro-optimisation.
   *
   * It keeps the call IDEMPOTENT — closing an agent that is already closed produces no state change
   * at all — which is what lets it sit in an effect cleanup that React StrictMode invokes twice
   * (G26/G65). And it keeps the common case free: every terminal teardown calls this, almost none
   * of them ever opened a find bar, and an unconditional `set` with a fresh `Set` would re-render
   * every subscribed pane in the grid for nothing.
   */
  close: (agentId) => {
    if (!get().open.has(agentId)) return;
    const open = new Set(get().open);
    open.delete(agentId);
    set({ open });
  },
}));
