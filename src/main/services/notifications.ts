// macOS notifications for attention events — spec §5 Phase 3. Electron-only API, so per CLAUDE.md
// rule 9 this lives in `src/main` and the renderer never imports it.
//
// The seam: everything that DECIDES — whether to notify, for which agent, with what text, and
// whether this is a repeat — is pure or injectable and is tested exhaustively below. The single
// native call (`new Notification({…}).show()`) is the `present` dependency, supplied by
// `src/main/index.ts`. Nothing in-process can observe macOS drawing a banner, so the decision layer
// must never need one to be tested.
import { initialSessionState, type Activity, type AppConfig, type Id, type SessionState } from '../../../shared/types.ts';

export type NotifyMode = AppConfig['notifications'];

/**
 * The body text for an activity worth interrupting the user for, or null for one that is not.
 *
 * A `switch` with no `default` and a return type that excludes `undefined`: a ninth `Activity`
 * fails to compile here rather than silently never notifying. Same shape, and the same reason, as
 * `statusVisual` in shared/status.ts.
 */
export function attentionBody(activity: Activity): string | null {
  switch (activity) {
    case 'needs-permission':
      return 'Needs permission';
    case 'waiting':
      return 'Finished — waiting for you';
    case 'stopped':
    case 'starting':
    case 'shell':
    case 'working':
    case 'idle':
    case 'exited':
      return null;
  }
}

/**
 * Returns the notification body, or null when nothing should be shown.
 *
 * Three conditions, in order:
 *
 * 1. `mode === 'off'` — the user turned them off (§6.7 `notifications`).
 * 2. **No transition, no notification.** An agent that sits in `needs-permission` broadcasts
 *    `session:state` again whenever any other rendered field moves (`unread`, `title`, `pid`,
 *    `attachedPane` — see `session-registry.ts`'s `changed` list, and `tick()`, which rebroadcasts
 *    on a stale `lastOutputAt` alone). Keying on the activity TRANSITION is what makes one
 *    condition produce one banner instead of one per broadcast.
 * 3. `mode === 'attention'` and the user is already looking at this agent.
 *
 * "Looking" is `windowFocused && attachedPane !== null` — the same predicate `reduceSession`'s
 * `flag()` uses for §12's unread badge, so the banner and the badge cannot disagree about what the
 * user can see. Note it is deliberately NOT `next.unread`, which is a near-miss: `flag()` is
 * `s.unread || s.attachedPane === null || !ctx.windowFocused`, so unread STICKS once set. Measured
 * in `notifications.test.ts` ("unread is not a substitute…"): an agent with `unread: true` from an
 * earlier bell, attached to pane 0, taking a `Stop` hook with `windowFocused: true` reduces to
 * `unread: true` — a banner keyed on unread would fire for a turn the user watched finish.
 */
export function shouldNotify(prev: SessionState, next: SessionState, mode: NotifyMode, windowFocused: boolean): string | null {
  if (mode === 'off') return null;
  if (prev.activity === next.activity) return null;
  const looking = windowFocused && next.attachedPane !== null;
  if (mode === 'attention' && looking) return null;
  return attentionBody(next.activity);
}

/** One banner to show. `onClick` is what the native notification's `click` listener must call. */
export interface NotificationRequest {
  agentId: Id;
  title: string;
  body: string;
  onClick: () => void;
}

export interface NotifierDeps {
  /** The native edge: `new Notification({ title, body })`, `.on('click', onClick)`, `.show()`. */
  present: (n: NotificationRequest) => void;
  /** Read at decision time, not captured: the user can change it from settings between events. */
  mode: () => NotifyMode;
  /** Main's authoritative flag — `session-registry.ts` owns it; window focus/blur and `app:windowFocused` both write it. */
  windowFocused: () => boolean;
  /** The agent's display name, or null once it is no longer in the workspace. */
  agentName: (id: Id) => string | null;
  /** Raise and focus the app window. */
  showWindow: () => void;
  /** Ask the renderer to put this agent in a pane (`agent:focus`). */
  focusAgent: (id: Id) => void;
  log: (line: string) => void;
}

export interface Notifier {
  /** Feed every `session:state` broadcast through this. */
  observe: (agentId: Id, state: SessionState) => void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const previous = new Map<Id, SessionState>();
  return {
    observe: (agentId, state) => {
      const name = deps.agentName(agentId);
      if (name === null) {
        // A deleted agent. Drop the remembered state too, or this map keeps one entry per agent
        // ever deleted for the life of the process — `session-registry.ts`'s `tick()` prunes its
        // own map on exactly this condition and this one has to match it.
        previous.delete(agentId);
        return;
      }
      const prev = previous.get(agentId) ?? initialSessionState(agentId);
      // Recorded BEFORE the decision and on every path, including the suppressed ones. Recording
      // only when a banner is shown would leave `prev` frozen at the last notified activity, so a
      // transition the user watched happen (or that landed while notifications were off) would fire
      // a banner on the next unrelated broadcast.
      previous.set(agentId, state);
      const body = shouldNotify(prev, state, deps.mode(), deps.windowFocused());
      if (body === null) return;
      deps.present({
        agentId,
        title: name,
        body,
        onClick: () => {
          // Always raise the window: a banner that does nothing when clicked is worse than no
          // banner. The agent is looked up AGAIN here rather than captured, because a banner can
          // sit in Notification Center for days — the agent may have been deleted, and
          // `openAgent` in the renderer would put a dead id into a pane, which renders as an
          // EmptyPane the user cannot explain and which `layout:set` then persists.
          deps.showWindow();
          if (deps.agentName(agentId) === null) {
            deps.log(`clicked notification for ${agentId}, which is no longer in the workspace`);
            return;
          }
          deps.focusAgent(agentId);
        },
      });
    },
  };
}
