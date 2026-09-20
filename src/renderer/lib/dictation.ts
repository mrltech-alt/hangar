// Plan 09 — what a press of the mic, ⌘D and Escape ask main for, and what a finished run says.
// Nothing here holds state: it reads the stores with `getState()` at the moment of the press, so a
// button rendered a frame ago cannot act on a phase that has since moved on.
//
// The renderer never writes a transcript. Main types a `write` outcome into the session itself
// (`handlers.ts`), before it broadcasts the event that ends the run; the text appearing at the prompt
// IS the confirmation, so a `write` is drawn and not announced.
import { dictationMessage, dictationRefusal, isAllowed, outcomeNotice, toggleRequest } from '../../../shared/dictation.ts';
import type { DictationBroadcast } from '../../../shared/ipc-contract.ts';
import type { Id } from '../../../shared/types.ts';
import { dictatingElsewhere, dictationFor, useDictation } from '../stores/dictation.ts';
import { useSessions } from '../stores/sessions.ts';
import { useUi } from '../stores/ui.ts';
import { isRunning } from './agent-actions.ts';
import { reportError, run, type IpcFailure } from './api.ts';

/**
 * The error path of EVERY dictation request (`start`, `stop`, `cancel` — here and in `bootstrap.ts`).
 *
 * Main refuses a start with a code AND a sentence written for its log, and the ordinary error sink
 * toasts the sentence: `DICTATION_BUSY` said `Dictation is still running. Wait for it to finish.` and
 * `NOT_RUNNING` said `the agent has no running session to dictate into`. Every sentence this feature
 * shows lives in `shared/dictation.ts`, so a code it has words for is said from there
 * (`dictationRefusal`), as a warning like the button's own refusals. Any other code goes to the
 * ordinary sink exactly as `run` would have sent it — `HOST_DOWN` keeps the app's one sentence for a
 * lost host, sticky, with its banner.
 */
export function dictationRefused(e: IpcFailure): void {
  const sentence = dictationRefusal(e.code);
  if (sentence === null) reportError(e);
  else useUi.getState().toast({ level: 'warn', title: sentence });
}

/**
 * One `dictation:event`, from `bootstrap.ts`'s subscription. The store takes the pair; the outcome,
 * on the one event per run that carries it, is said through the ordinary toast — `Nothing heard.`,
 * every error's sentence, and `COPIED` (sticky) when main put the words on the clipboard because the
 * agent was waiting on a permission prompt — from `outcomeNotice` (the table, never the event's own
 * `message`).
 *
 * Here and not in a component: a pane can be closed while its agent is still being dictated to, and
 * the outcome must still be said exactly once — not once per mounted pane, and not zero times.
 */
export function receiveDictation(event: DictationBroadcast): void {
  useDictation.getState().receive(event);
  if (event.outcome === null) return;
  const notice = outcomeNotice(event.outcome);
  if (notice !== null) useUi.getState().toast({ level: notice.level, title: notice.text, sticky: notice.sticky === true });
}

/**
 * The mic button's press and ⌘D, for ONE agent's pane: `toggleRequest` of that agent's run, sent.
 *
 * Two refusals are decided here, before main is asked, and said with the button's own tooltip
 * sentences — the button is disabled in both cases, so in practice only ⌘D, which cannot be
 * disabled, ever reaches them:
 *  - another agent's run is alive (`ELSEWHERE`): one run app-wide, and a second start would only
 *    come back `DICTATION_BUSY`;
 *  - this agent has no running session (`NOT_RUNNING`): main would refuse it too, in words meant
 *    for a log.
 * A stop or a cancel is never refused for either reason: a run that is already this agent's must
 * always be stoppable, even after its session has ended underneath it.
 */
export function toggleDictation(agentId: Id): void {
  const s = useDictation.getState();
  if (dictatingElsewhere(s, agentId)) {
    useUi.getState().toast({ level: 'warn', title: dictationMessage('ELSEWHERE') });
    return;
  }
  const request = toggleRequest(dictationFor(s, agentId));
  switch (request) {
    case null:
      // Finalizing: the stop is sent and the transcript is on its way. Escape still cancels.
      return;
    case 'start': {
      // Absent from the record means stopped (§6.5).
      const session = useSessions.getState().sessions[agentId];
      if (session === undefined || !isRunning(session)) {
        useUi.getState().toast({ level: 'warn', title: dictationMessage('NOT_RUNNING') });
        return;
      }
      void run('dictation:start', { agentId }, dictationRefused);
      return;
    }
    case 'stop':
      void run('dictation:stop', undefined, dictationRefused);
      return;
    case 'cancel':
      void run('dictation:cancel', undefined, dictationRefused);
      return;
  }
}

/**
 * Escape, as `TerminalView` hands it to the terminal's own key handler (`terminal-registry.ts`).
 * True — and the cancel sent — only while THIS agent's run is alive; false at every other time, and
 * the terminal then gets its Escape untouched: Claude Code uses it to interrupt, and a keymap that
 * ate it would break the agent.
 *
 * "Alive" is every phase that takes a cancel (`isAllowed`), not `recording` alone: during
 * `starting`/`preparing` a press of the button is already a cancel, and during `finalizing` Escape is
 * what drops a transcript on its way in (`toggleRequest`'s note in `shared/dictation.ts`).
 */
export function cancelDictationOnEscape(agentId: Id): boolean {
  if (!isAllowed(dictationFor(useDictation.getState(), agentId), 'cancel')) return false;
  void run('dictation:cancel', undefined, dictationRefused);
  return true;
}
