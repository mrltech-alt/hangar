import { PILL_ESCAPE_HINT, pillText } from '../../../../shared/dictation.ts';
import type { Id } from '../../../../shared/types.ts';
import { partialFor, useDictation } from '../../stores/dictation.ts';

/**
 * Spec §4.2: while this pane's agent is recording (or finalizing), a pill above the pane's bottom
 * edge shows the live partial, so you can see it is hearing you.
 *
 * **It never takes focus, and that is the design rather than a detail.** The terminal keeps the
 * keyboard for the whole run: Escape cancels through the terminal's OWN key handler
 * (`terminal-registry.ts`), and the gesture ends with the user reading the words at the prompt and
 * pressing Enter there. So the pill has nothing focusable in it — no `tabindex`, no control — and
 * `pointer-events-none`, which is what keeps a click on it from focusing anything either: a
 * mousedown on a non-focusable element still moves focus to the body, but a mousedown the pill
 * never receives lands on the terminal beneath it instead. `role="status"` lets a screen reader
 * hear the words without the pill ever being a focus target.
 *
 * An overlay, positioned against `Pane`'s `relative` body wrapper like the find bar, so the terminal
 * box never changes size and xterm never re-fits when it appears (G8). It covers the last rows —
 * the prompt — while it is up; nothing is written there until the run ends, and it is gone by then.
 *
 * The selector returns a string or null — a primitive (G59/G61) — and only this agent's: another
 * agent's partial reads as null here (G89).
 *
 * `escapeCancels` says whether this pane has a TERMINAL mounted, because that is where Escape is
 * handled. Over the exit card (the session has ended) or the missing-worktree card there is no
 * terminal and so no key handler, and a pill promising `Esc cancels` there would promise a key that
 * does nothing. Main cancels a run whose session ends (`handlers.ts`), so the pill does not outlive
 * the moment by much — but that cancel arrives after the session state that swapped the terminal
 * for the card, and the hint must not be drawn in between either.
 */
export function DictationPill({ agentId, escapeCancels }: { agentId: Id; escapeCancels: boolean }) {
  const partial = useDictation((s) => partialFor(s, agentId));
  if (partial === null) return null;
  return (
    <div
      role="status"
      data-testid="dictation-pill"
      // `z-20`, the rail's layer: above xterm's own (up to 11), under panels (30), toasts (40) and
      // menus (50).
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3"
    >
      <div className="flex max-w-full items-center gap-2 rounded-2xl border border-red/40 bg-bg-2/95 px-3 py-1 text-[12px] text-fg shadow-xl">
        <span aria-hidden className="pulse h-2 w-2 shrink-0 rounded-full bg-red" />
        <span className="min-w-0 break-words" data-testid="dictation-partial">{pillText(partial)}</span>
        {escapeCancels ? <span className="shrink-0 text-[10.5px] text-muted">{PILL_ESCAPE_HINT}</span> : null}
      </div>
    </div>
  );
}
