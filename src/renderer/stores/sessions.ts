import { create } from 'zustand';
import { reduceSession } from '../../../shared/status.ts';
import { initialSessionState, type Id, type SessionState } from '../../../shared/types.ts';

interface SessionsState {
  // `| undefined` mirrors `WorkspaceSnapshot['sessions']` exactly (shared/types.ts): the snapshot
  // is the only thing that ever calls `setAll`, and `Record<Id, SessionState>` made that a TS2345.
  // Every reader below already copes — indexing goes through `?.` or `??`, and the three
  // `Object.values(...)` counters in Task 9 filter `undefined` out first.
  sessions: Record<Id, SessionState | undefined>;
  setAll: (sessions: Record<Id, SessionState | undefined>) => void;
  setOne: (agentId: Id, state: SessionState) => void;
  /**
   * Spec §13: "plus the 1 s ticker that dispatches `tick` locally for the heuristic display (main is
   * the source of truth; the renderer applies the same reducer optimistically so dots stay live)".
   *
   * This is the renderer half of a contract Plan 02 only half-built. Main throttles `session:state`
   * to changes the user can see, so between broadcasts nothing here ages — and the heuristic that
   * decays `working` to `idle` after 3 s of silence is exactly the thing that must age. Plan 02's
   * P2-15 fixed the main side (its own `tick()` now also broadcasts when `lastOutputAt` advances);
   * without this half a dot stays green for as long as main has nothing else to say.
   *
   * Returns the existing state object unchanged when no session moved, so zustand skips the
   * re-render — a 1 s interval that re-rendered the whole sidebar would be worse than the bug.
   * Verified with a real React root: five no-op ticks produced 0 listener calls and 0 re-renders,
   * because zustand's `setState` compares with `Object.is` before notifying.
   *
   * Takes no `windowFocused`: `reduceSession`'s `tick` branch never reads `ctx`. Checked
   * exhaustively — 256 state combinations reduced under `tick` with `windowFocused` true and
   * false, 0 differing — so the parameter could only mislead. `ctx` exists for the attention
   * events (`Stop`, `Notification`, `bell`) that decide whether something counts as unread, and
   * those arrive from main, which owns the authoritative focus flag.
   */
  tick: (at: number) => void;
}

export const useSessions = create<SessionsState>((set) => ({
  sessions: {},
  setAll: (sessions) => set({ sessions }),
  setOne: (agentId, state) => set((s) => ({ sessions: { ...s.sessions, [agentId]: state } })),
  tick: (at) =>
    set((s) => {
      let changed = false;
      const next: Record<Id, SessionState | undefined> = {};
      for (const [id, cur] of Object.entries(s.sessions)) {
        if (cur === undefined) continue;
        const after = reduceSession(cur, { kind: 'tick', at });
        if (after !== cur) changed = true;
        next[id] = after;
      }
      return changed ? { sessions: next } : s;
    }),
}));

/**
 * The stand-in for an agent with no entry in `sessions`, memoised PER ID.
 *
 * zustand 5 hands the selector straight to `useSyncExternalStore`, which requires a referentially
 * stable snapshot: React re-runs the selector after each commit and, when the result differs by
 * identity, commits again. A fresh `initialSessionState(...)` on every call is therefore an
 * infinite render loop, not merely a wasted allocation. Measured with a real React 19 root in
 * jsdom before this memo:
 *   missing session -> 55 renders, then "Maximum update depth exceeded", with React logging
 *                      "The result of getSnapshot should be cached to avoid an infinite loop"
 *   present session -> 1 render
 * Both inputs that reach it are ordinary, not edge cases: an empty pane (`agentId === null`, a
 * first-class state per §12.3) and an agent absent from the record ("absent = stopped", §6.5).
 * Same guard as `EMPTY_PROJECTS` / `EMPTY_FOLDERS` in workspace.ts.
 *
 * The map only ever grows by one entry per agent id the UI asks about, so it is bounded by the
 * workspace; there is nothing to evict.
 */
const missing = new Map<Id, SessionState>();
function missingSession(agentId: Id): SessionState {
  let state = missing.get(agentId);
  if (state === undefined) {
    state = initialSessionState(agentId);
    missing.set(agentId, state);
  }
  return state;
}

export const useSession = (agentId: Id | null): SessionState => useSessions((s) => (agentId === null ? missingSession('') : (s.sessions[agentId] ?? missingSession(agentId))));
