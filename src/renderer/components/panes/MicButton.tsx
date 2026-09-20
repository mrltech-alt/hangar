import { LoaderCircle, Mic } from 'lucide-react';
import { DICTATION_IDLE, dictationMessage, MIC_BUTTON_TITLES, toggleRequest, type DictationPhase, type DictationState } from '../../../../shared/dictation.ts';
import type { Id } from '../../../../shared/types.ts';
import { toggleDictation } from '../../lib/dictation.ts';
import { withShortcut, type KeymapAction } from '../../lib/keymap.ts';
import { focusTerminal } from '../../lib/terminal-registry.ts';
import { dictatingElsewhere, dictationFor, useDictation } from '../../stores/dictation.ts';
import { IconButton } from '../ui/Button.tsx';

const DICTATE: KeymapAction = { kind: 'dictate' };

/**
 * One state per phase, for `toggleRequest` — which reads nothing but the phase. The button selects
 * the PHASE (a string) rather than the state so that a partial, arriving several times a second,
 * does not re-render it; this table turns the phase back into something `toggleRequest` takes,
 * without re-deriving its answers here. Hoisted, so nothing is allocated per render.
 */
const BY_PHASE: Readonly<Record<DictationPhase, DictationState>> = {
  idle: DICTATION_IDLE,
  starting: { phase: 'starting' },
  preparing: { phase: 'preparing' },
  recording: { phase: 'recording', partial: '' },
  finalizing: { phase: 'finalizing', partial: '' },
};

/**
 * How the button looks in each phase. `!` because `IconButton` already sets `text-fg-2`, and two
 * colour utilities on one element are settled by the order Tailwind emits them, not the order they
 * are written in — the important flag is what makes the phase colour win whichever that is.
 *
 * `recording` pulses (theme.css's `.pulse`, the status dot's own animation) and `preparing` — the
 * first-use model download, which can take a while — swaps the mic for a spinner, so the two can
 * never be mistaken for each other: one is listening, the other is not yet.
 */
const LOOK: Record<DictationPhase, string> = {
  idle: '',
  starting: '!text-amber',
  preparing: '!text-amber',
  recording: 'pulse bg-red/15 !text-red',
  finalizing: '!text-red',
};

/**
 * What the button is, for one pane: pure, so every case is a table row in the test rather than a
 * render. `phase` is THIS agent's (`dictationFor`), never the app's.
 *
 * Disabled in exactly three cases, each with its own reason on hover:
 *  - idle with no running session — `NOT_RUNNING` (spec §4's last row);
 *  - idle while ANOTHER agent's run is alive — `ELSEWHERE`. One run app-wide (main refuses a second
 *    start with `DICTATION_BUSY`), and a button that could only be refused is disabled, not pressed
 *    and toasted. ⌘D, which cannot be disabled, says the same sentence as a toast instead;
 *  - finalizing, where `toggleRequest` asks for nothing: the stop is sent and the words are coming.
 * A run that is already this agent's is never disabled by the session ending under it — the press
 * that stops or cancels it must stay reachable.
 */
export function micButtonState(phase: DictationPhase, running: boolean, elsewhere: boolean, focused: boolean): { disabled: boolean; title: string } {
  if (phase === 'idle' && !running) return { disabled: true, title: dictationMessage('NOT_RUNNING') };
  if (phase === 'idle' && elsewhere) return { disabled: true, title: dictationMessage('ELSEWHERE') };
  const request = toggleRequest(BY_PHASE[phase]);
  if (request === null) return { disabled: true, title: MIC_BUTTON_TITLES[phase] };
  // The key only on the FOCUSED pane's button, where it does the same thing as the button: ⌘D acts
  // on the focused pane, so on any other header it would dictate somewhere else (the drawer
  // buttons' rule, `PaneHeader.tsx`). `(⌘D)` goes where a press is start or stop; a cancel is the
  // button's second meaning and says so in words.
  const title = MIC_BUTTON_TITLES[phase];
  return { disabled: false, title: focused && request !== 'cancel' ? withShortcut(title, DICTATE) : title };
}

/**
 * Spec §4.1–2: press to start, press again to stop; pulsing while recording.
 *
 * Every selector returns a primitive — a phase string and a boolean — so neither a partial arriving
 * (several a second while recording) nor another pane's run can re-render this through a fresh
 * object (G59/G61). The phase is only this agent's: an event for another agent reads as `idle` here
 * and lights `elsewhere` instead (G89).
 */
export function MicButton({ agentId, running, focused }: { agentId: Id; running: boolean; focused: boolean }) {
  const phase = useDictation((s) => dictationFor(s, agentId).phase);
  const elsewhere = useDictation((s) => dictatingElsewhere(s, agentId));
  const { disabled, title } = micButtonState(phase, running, elsewhere, focused);
  return (
    // The wrapper carries the tooltip too, and it is not decoration: `IconButton` is
    // `disabled:pointer-events-none`, so a DISABLED button is never hit-tested and its own `title`
    // never shows — the pointer lands on this span instead, whose `title` does. Spec §4 wants the
    // disabled button to say why; without the span it could not. jsdom has no tooltips, so the test
    // asserts the attribute on both and says so.
    <span className="inline-flex" title={title} data-testid="mic">
      <IconButton
        title={title}
        disabled={disabled}
        aria-pressed={phase === 'recording'}
        data-dictation={phase}
        className={LOOK[phase]}
        // The keyboard stays in (or goes to) the TERMINAL, never this button: Escape — the cancel —
        // is handled by the terminal's own key handler and nowhere else, and the rest of the gesture
        // is reading the words at the prompt and pressing Enter there. `preventDefault` on
        // mousedown stops the button taking focus in the first place (Pane's capture handler still
        // sees the mousedown and focuses the pane); `focusTerminal` covers a keyboard that was
        // somewhere else entirely, as a project action does.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          toggleDictation(agentId);
          focusTerminal(agentId);
        }}
      >
        {phase === 'preparing' ? <LoaderCircle size={13} className="animate-spin" /> : <Mic size={13} />}
      </IconButton>
    </span>
  );
}
