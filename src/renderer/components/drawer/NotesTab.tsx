import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types.ts';
import { run } from '../../lib/api.ts';
import { clockTime } from '../../lib/time.ts';
import { Button } from '../ui/Button.tsx';

export const NOTES_DEBOUNCE_MS = 500;

/**
 * The Notes tab (spec §12.5): a plain textarea, autosaved 500 ms after the last keystroke, that
 * has to share one string with the agent running inside the pane — `hangar note` writes the same
 * field while the human is typing into it.
 *
 * Five rules, and each one is a test in `Drawer.test.tsx`:
 *
 * 1. **Debounce.** Typing schedules; a later keystroke reschedules; only the final value is sent.
 * 2. **Focus guard.** A snapshot carrying someone else's `notes` is adopted only while the
 *    textarea is NOT focused. Focus is read from `document.activeElement` rather than tracked in a
 *    ref through `onFocus`/`onBlur`, because that ref is a second copy of a fact the DOM already
 *    holds and the two drift the moment focus moves without React seeing it.
 * 3. **The chip.** While focused, an external value raises "Notes changed by the agent"; Reload
 *    adopts `agent.notes` as it is AT CLICK TIME, not the value that raised the chip, so a second
 *    external write in between is not reverted.
 * 4. **Whose notes.** `Drawer` gives this component `key={agent.id}`, so switching panes REMOUNTS
 *    it and every ref below belongs to exactly one agent. The unmount flush then sends the pending
 *    edit to the agent it was typed for. The plan kept one instance and reset it in an effect on
 *    `agent.id`, which leaves a scheduled save holding the OLD text and the NEW `lastSaved` — it
 *    then either writes agent A's text after comparing it against agent B's notes, or (when they
 *    happen to be equal) drops the edit entirely.
 *
 * 5. **A failed write is not a save.** `mine` is optimistic, so it is rolled back when
 *    `agent:update` fails — otherwise the very next snapshot, still carrying the old note because
 *    nothing was written, reads as an external edit and adopts over the user's text.
 *
 * `mine` is the value we believe the store holds because we put it there (or read it at mount).
 * An incoming `agent.notes` equal to it is the echo of our own `agent:update` — main broadcasts a
 * fresh snapshot after every write — not an external edit. `inFlight`/`timer` guard the other
 * order: a snapshot that lands while our own write is in flight, or 500 ms from being sent, is
 * about to be overwritten by it, and adopting it would revert the textarea under the user.
 *
 * Every one of those was mutation-tested: each guard was removed in turn and the test named above
 * for it failed. One that did not — a `alive` ref suppressing the post-unmount `setSavedAt` — was
 * deleted rather than left as decoration: React 19 makes that update a silent no-op.
 */
export function NotesTab({ agent }: { agent: Agent }) {
  // Captured once per instance. `key={agent.id}` upstream is what makes that sound; if that key is
  // ever removed, this id goes stale rather than following the pane, so the two belong together.
  const agentId = agent.id;
  const [text, setText] = useState(agent.notes);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const mine = useRef(agent.notes);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(0);
  const [failed, setFailed] = useState(false);

  const send = useCallback((value: string) => {
    const previous = mine.current;
    mine.current = value;
    inFlight.current += 1;
    // `run`, never `api.invoke`: the wrapped client throws, and `void api.invoke(...).then(...)`
    // handles no rejection — three separate call sites on this project have been fixed for exactly
    // that. `run` routes a failure to the toast sink and resolves null, which is why the stamp
    // below is only written on a non-null reply: a failed save must not read "Saved".
    void run('agent:update', { id: agentId, patch: { notes: value } }).then((updated) => {
      inFlight.current -= 1;
      if (updated === null) {
        // The write did not land (`run` has already toasted it). Put `mine` back, or the next
        // snapshot — still carrying the OLD notes, because nothing was written — reads as an
        // external edit and adopts straight over the text the user is looking at. Guarded on
        // still being the newest send, so a failed save cannot rewind a later successful one.
        if (mine.current === value) mine.current = previous;
        // `setFailed` is also the re-render that gets the indicator off "Unsaved…": `mine` is a
        // ref, so putting it back changes nothing on screen by itself.
        setFailed(true);
        return;
      }
      setFailed(false);
      setSavedAt(clockTime(Date.now()));
    });
    // Our write supersedes whatever the agent wrote, so a chip still pointing at it would offer to
    // reload a value the store no longer has.
    setExternal(false);
  }, [agentId]);

  const fire = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    pending.current = null;
    if (value !== null && value !== mine.current) send(value);
  }, [send]);

  const schedule = useCallback((value: string) => {
    pending.current = value;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(fire, NOTES_DEBOUNCE_MS);
  }, [fire]);

  // Flush on unmount — a pane switch, the drawer closing, the agent being deleted. Without it the
  // last half-second of typing is lost, and `key={agent.id}` makes a pane switch an unmount.
  // `fire` is stable per `agentId`, so this effect runs exactly once per instance. The `setFailed`
  // / `setSavedAt` that may follow the flush land on an unmounted component and are a no-op in
  // React 19 (the "state update on an unmounted component" warning was removed in 18): measured
  // here with the drawer closed mid-edit — no warning, no error, the write still goes out.
  useEffect(() => () => fire(), [fire]);

  useEffect(() => {
    const incoming = agent.notes;
    if (incoming === mine.current) return; // the echo of our own save
    // Ours is newer: either it is on the wire or it is 500 ms from being sent. Adopting here would
    // revert the textarea under the user; the pending save overwrites `incoming` anyway.
    if (inFlight.current > 0 || timer.current !== null) return;
    if (document.activeElement === area.current && area.current !== null) {
      setExternal(true);
      return;
    }
    mine.current = incoming;
    setText(incoming);
    setExternal(false);
  }, [agent.notes]);

  const dirty = text !== mine.current;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {external ? (
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2 rounded-md bg-amber/15 px-2 py-1 text-[11px] text-amber">
          <span className="truncate">Notes changed by the agent</span>
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              // `agent.notes`, read here rather than captured when the chip was raised.
              mine.current = agent.notes;
              setText(agent.notes);
              setExternal(false);
              pending.current = null;
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = null;
            }}
          >
            Reload
          </Button>
        </div>
      ) : null}
      <textarea
        ref={area}
        value={text}
        placeholder="Why is this agent open? What is it waiting on?"
        className="min-h-0 flex-1 resize-none rounded-md border border-line bg-bg-0 p-3 font-mono text-[12px] leading-relaxed text-fg outline-none select-text focus:border-accent"
        onChange={(e) => {
          setText(e.target.value);
          schedule(e.target.value);
        }}
        // A real flush, not the plan's `clearTimeout` followed by `save(text)` — `save` re-arms the
        // same 500 ms timer, so that version does not flush on blur, it postpones.
        onBlur={fire}
      />
      <div className="mt-1 shrink-0 text-right text-[10.5px] text-muted">
        {dirty ? (failed ? 'Save failed' : 'Unsaved…') : savedAt !== null ? `Saved · ${savedAt}` : ''}
      </div>
    </div>
  );
}
