import { useEffect, useMemo, useRef, useState } from 'react';
import { primaryWorkspace } from '../../../../shared/types.ts';
import { openAgent } from '../../lib/agent-actions.ts';
import { matchesSearch } from '../../lib/tree.ts';
import { useSessions } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { Kbd } from '../ui/Kbd.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';

/**
 * Spec §12.3's ⌘K: jump to an agent by typing part of its name, its branch or its project.
 *
 * **Not a `<dialog>`, deliberately.** Every other member of `DialogState` goes through
 * `ui/Dialog.tsx` (a `showModal()` dialog with a title bar and a header Close button), and both of
 * those are wrong here: a command palette has no title and no Close button, and that Close button
 * is the exact element G62 measured stealing focus from the field the user is about to type into.
 * A plain overlay also gives this component the ordering G62's fix is about for free — `showModal()`
 * is what overwrites an earlier `.focus()`, and nothing here calls it, so the mount effect's
 * `input.focus()` is the last word.
 *
 * Modality is not lost by dropping the `<dialog>`: `installKeymap` stands the shortcut table down
 * while `ui.dialog !== null` (`keymap.test.ts` → "stands down completely while a dialog no
 * shortcut opens is up"), so no Hangar shortcut fires behind this overlay. The single exception is
 * ⌘K itself, which `OPENS_DIALOG` makes a toggle: a second press closes this rather than being
 * swallowed. Escape is handled below rather than by `<dialog>`'s `cancel` event, and is still the
 * other way out — the toggle does not replace it.
 *
 * **Why the second ⌘K closes rather than re-focusing the query.** A palette is the one place the
 * "re-press re-focuses the field" reading is tempting, and it is empty here: the mount effect below
 * puts focus in the input, the backdrop closes on any mousedown outside the panel, and the panel
 * itself contains nothing focusable that a keyboard user reaches without leaving — so at the moment
 * a second ⌘K arrives the input already holds focus (`QuickSwitcher.test.tsx` → `initial focus`
 * asserts the mount effect; where focus really lands in Chromium is a CDP question, G66) and
 * re-focusing it
 * would be the same do-nothing the bug already was. The one real alternative is VS Code's ⌘P,
 * where a second press steps
 * through the MRU list; that is a different feature (this list is already recency-ordered and
 * arrow-navigable) and it is deliberately not built.
 *
 * **G59/G61.** A filtered, ranked list derived from the workspace is the worst possible shape for
 * zustand 5's stable-snapshot requirement: `useSyncExternalStore` re-runs the selector after every
 * commit and commits again when the identity differs, so `s.snapshot?.workspace.agents.filter(…)`
 * in a selector is an infinite loop (measured ~55 renders on this project before React throws).
 * All three selectors here return a STORED reference or a store action, and every derivation
 * happens below the subscription in a `useMemo`. `QuickSwitcher.test.tsx` counts commits on a real
 * root — including one mount with no snapshot at all, which is the only shape that can see G61's
 * `?? []` variant, and a deliberately-allocating control proving the counter is not blind.
 */
export function QuickSwitcher() {
  const close = useUi((s) => s.closeDialog);
  const snapshot = useWorkspace((s) => s.snapshot);
  // The whole record, not a derived lookup: it is one stored object, and `tick` returns the SAME
  // object when no session moved (sessions.ts), so the 1 s ticker does not re-render this.
  const sessions = useSessions((s) => s.sessions);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Explicit, not `autoFocus`: React's prop is a `.focus()` during commit, and CLAUDE.md's
    // dialog recipe bans it for the `<dialog>` case. Here there is no `showModal()` to overwrite
    // it, so a mount effect is the whole story.
    input.current?.focus();
  }, []);
  const items = useMemo(() => {
    // A plain `[]`, not a hoisted module constant. Measured with the mutation harness for this
    // task: hoisting it changes nothing, because `useMemo` caches across renders and this value
    // never reaches `useSyncExternalStore`. G61's hazard lives in SELECTORS — the three above,
    // which return stored references — so a hoist here would look like the fix and bite nothing.
    if (snapshot === null) return [];
    const ws = snapshot.workspace;
    return ws.agents
      .filter((a) => matchesSearch(ws, a, query))
      // Most recently opened first — the thing a switcher is for. `matchesSearch` is the sidebar's
      // own matcher (lib/tree.ts) so the two cannot disagree about what a query means; the ORDER
      // deliberately differs from `buildRows`' alphabetical search results, because a palette
      // ranks by recency and a tree lists by name.
      //
      // `lastOpenedAt` is `null` for an agent never opened (§6), and `''` sorts last against any
      // ISO date. The name is an explicit tiebreak rather than a reliance on sort stability, so
      // the order is a property of this function and not of V8.
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name))
      .slice(0, MAX_ITEMS);
  }, [snapshot, query]);
  // Clamped rather than trusted: `items` also shrinks when a snapshot arrives with an agent
  // deleted, which no `[query]` reset can see.
  const active = items.length === 0 ? 0 : Math.min(index, items.length - 1);
  useEffect(() => {
    setIndex(0);
  }, [query]);
  const choose = (i: number, newPane: boolean): void => {
    const a = items[i];
    if (a === undefined) return;
    // Close FIRST: `openAgent` puts the agent in a pane, and `TerminalView`'s `[focused, agentId]`
    // effect focuses that terminal — which is where the keyboard should end up, and it cannot
    // while this overlay still owns it.
    close();
    openAgent(a.id, newPane);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={close} data-testid="quick-switcher-backdrop">
      {/*
        The one guard in this component, and it bites: without it a mousedown anywhere in the panel
        — including in the search field — bubbles to the backdrop above and closes the switcher
        mid-click. G60's lesson in the other direction: here the ancestor is ours and stopping it
        is the point, so the test asserts BOTH halves (panel stays open, backdrop still closes).
      */}
      <div role="dialog" aria-modal="true" aria-label="Jump to agent" className="w-[560px] overflow-hidden rounded-lg border border-line bg-bg-1 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Jump to agent"
          placeholder="Jump to agent…  (↵ opens here, ⌘↵ in a new pane)"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[13px] text-fg outline-none placeholder:text-muted"
          onKeyDown={(e) => {
            // `preventDefault` on all four: the arrows would otherwise move the caret inside the
            // field (and scroll the list container), and Enter in a field is a form submit in any
            // browser that decides this input is in one.
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              // Bounded, and NOT redundant with the clamp below even though the clamp would hide
              // an over-run today: `index` is what survives a snapshot that GROWS the list, so an
              // unbounded value parked past the end here reappears as a highlight that jumps to
              // the last row the moment another agent matches. Measured — that is the one thing
              // the clamp cannot cover, and it is the test named in `keyboard` below.
              setIndex(Math.min(items.length - 1, active + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex(Math.max(0, active - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(active, e.metaKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <ul className="max-h-[50vh] overflow-auto py-1">
          {items.length === 0 ? <li className="px-4 py-3 text-[12px] text-muted">No agents match.</li> : null}
          {items.map((a, i) => (
            <li key={a.id}>
              <button
                type="button"
                aria-selected={i === active}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left ${i === active ? 'bg-bg-3' : 'hover:bg-bg-2'}`}
                onMouseEnter={() => setIndex(i)}
                onClick={(e) => choose(i, e.metaKey)}
              >
                <StatusDot activity={sessions[a.id]?.activity ?? 'stopped'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-fg">{a.name}</span>
                  <span className="block truncate text-[11px] text-muted">{primaryWorkspace(a).branch}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-3 border-t border-line px-4 py-1.5 text-[10.5px] text-muted">
          <span><Kbd>↑↓</Kbd> move</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>⌘↵</Kbd> new pane</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/** Spec §12.3 does not give a number; 12 is what fits `max-h-[50vh]` without scrolling on this display. */
const MAX_ITEMS = 12;
