import { create } from 'zustand';
import { DICTATION_IDLE, isActive, type DictationState } from '../../../shared/dictation.ts';
import type { DictationBroadcast } from '../../../shared/ipc-contract.ts';
import type { Id } from '../../../shared/types.ts';

/**
 * Plan 09 — the dictation run as the renderer last heard of it, from `dictation:event`.
 *
 * **One run, and whose it is.** Main allows one helper at a time, app-wide, so there is exactly one
 * run to hold — but `dictation:event` is a BROADCAST, and a listener that took the state without the
 * agent would light every pane's mic for one agent's run (G89). So the store keeps the pair, and
 * nothing reads `state` without first asking whether `agentId` is the agent it is drawing:
 * `dictationFor` is the one place that asks, and every selector below goes through it.
 *
 * **Selectors return primitives or stored references** (G59/G61): `dictationFor` hands back either
 * the stored `state` object or the module constant `DICTATION_IDLE`, never a fresh one, and the
 * component selectors narrow further to a phase string, a partial string or a boolean.
 *
 * Nothing here writes a transcript: main has already typed a `write` outcome into the session by
 * the time its event arrives (`handlers.ts`). The renderer only draws, and says the outcome's
 * sentence (`lib/dictation.ts`).
 */
export interface DictationSnapshot {
  /** The agent the newest event belongs to — null before the first event of the app run. */
  agentId: Id | null;
  /** THAT agent's run; `idle`, carrying its outcome, once the run has ended. */
  state: DictationState;
}

interface DictationStore extends DictationSnapshot {
  receive: (event: DictationBroadcast) => void;
}

export const useDictation = create<DictationStore>((set) => ({
  agentId: null,
  state: DICTATION_IDLE,
  // Both fields from the SAME event, in one `set`, so no reader can ever see one agent's id beside
  // another agent's state.
  receive: ({ agentId, state }) => set({ agentId, state }),
}));

/**
 * The run as `agentId`'s pane should draw it: the stored state if the run is that agent's, idle
 * otherwise. The correlation, in one place. An empty pane (`null`) is never the run's.
 */
export function dictationFor(s: DictationSnapshot, agentId: Id | null): DictationState {
  return agentId !== null && s.agentId === agentId ? s.state : DICTATION_IDLE;
}

/** The live partial for `agentId`'s pill, or null when that agent is not recording or finalizing. */
export function partialFor(s: DictationSnapshot, agentId: Id | null): string | null {
  const state = dictationFor(s, agentId);
  return state.phase === 'recording' || state.phase === 'finalizing' ? state.partial : null;
}

/**
 * Is a run for some OTHER agent alive? Then `agentId` cannot start one: main refuses a second start
 * (`DICTATION_BUSY`), and the renderer says so before asking.
 */
export function dictatingElsewhere(s: DictationSnapshot, agentId: Id | null): boolean {
  return s.agentId !== null && s.agentId !== agentId && isActive(s.state);
}
