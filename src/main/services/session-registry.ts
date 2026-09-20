// Runtime session state per agent — spec §6.1, §11.4, §11.5. Owns the reducer; broadcasts to the renderer.
import { NOTE_MAX } from '../../../shared/constants.ts';
import type { SessionInfo } from '../../../shared/host-protocol.ts';
import type { IpcEvents } from '../../../shared/ipc-contract.ts';
import { isHookName, reduceSession, type SessionEvent } from '../../../shared/status.ts';
import { cleanAgentName, stripControlCharsKeepNewlines } from '../../../shared/agent-name.ts';
import { initialSessionState, type Id, type SessionState } from '../../../shared/types.ts';
import type { HostClient } from './host-client.ts';
import { updateAgent } from './workspace-ops.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/** What claude accepts for `--session-id`/`--resume`; anything else fails "Invalid session ID" at launch. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRegistry {
  get(agentId: Id): SessionState;
  all(): Record<Id, SessionState>;
  apply(agentId: Id, ev: SessionEvent): SessionState;
  setWindowFocused(focused: boolean): void;
  /**
   * The authoritative "is the user looking at Hangar" flag. Both writers — the window's own
   * focus/blur handlers and the renderer's `app:windowFocused` — go through `setWindowFocused`, so
   * this is the one place anything else (notifications) may read it from rather than keeping a
   * second copy that can drift.
   */
  isWindowFocused(): boolean;
  resetFromHello(sessions: SessionInfo[]): void;
  tick(): void;
  /** Drops every host-client listener. One instance lives for the app's lifetime, so this is for tests. */
  dispose(): void;
}

export interface RegistryDeps {
  hostClient: HostClient;
  store: WorkspaceStore;
  emit: <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => void;
  log: (line: string) => void;
  /**
   * Every `session:state` this registry broadcasts, handed over as typed arguments.
   *
   * A dedicated dep rather than the plan's "wrap `emit`": `emit` is generic over `keyof IpcEvents`,
   * and TypeScript cannot narrow a generic payload from `event === 'session:state'`, so an
   * interception there needs an `as` cast on the one value whose shape actually matters. This is
   * also the honest home for it — state transitions are decided here, not on the IPC path.
   */
  onState?: (agentId: Id, state: SessionState) => void;
  now?: () => number;
  clock?: () => Date;
}

export function formatNoteLine(text: string, at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `- [${hh}:${mm}] ${text}`;
}

/**
 * The `cli` payload is typed `z.unknown()` in the host protocol, so the host relays it unvalidated
 * and THIS module is the only boundary before it reaches disk. Two independent limits:
 *
 * - Length. `hangar note` does not truncate (unlike `hangar event`, which slices to NOTE_MAX), and
 *   `WorkspaceFileSchema` types `notes` as an unbounded `z.string()` — so without this any process
 *   running as this user could write a MAX_LINE_CHARS (4 MB) note per call, and `mode: 'append'`
 *   would grow `workspace.json` without bound. Past ~200 kB the user also loses the ability to edit
 *   their own notes from the drawer, because `agent:update` rejects a longer `notes` than it will
 *   accept back.
 * - Control characters, for the same reason `rename` is cleaned: `hangar status` prints notes
 *   straight into the user's terminal, where an ESC sequence in a note is executed, not shown.
 *   Newlines are KEPT: `hangar note --replace "$(cat plan.md)"` is a legitimate multi-line write and
 *   flattening it would be a silent data change. `\r` is not kept — a lone CR would let a note
 *   rewrite the current line when `hangar status` echoes it. Applied to the INCOMING text only,
 *   never to `notes` already on disk, so the drawer's multi-line notes survive an append.
 */
export function cleanNoteText(raw: string): string {
  return stripControlCharsKeepNewlines(raw).slice(0, NOTE_MAX);
}

export function applyNote(notes: string, payload: { mode: 'append' | 'replace' | 'clear'; text: string }, at: Date): string {
  switch (payload.mode) {
    case 'clear':
      return '';
    case 'replace':
      return cleanNoteText(payload.text);
    case 'append': {
      const line = formatNoteLine(cleanNoteText(payload.text), at);
      const joined = notes.trim().length === 0 ? line : `${notes.replace(/\s+$/, '')}\n${line}`;
      // Cap the ACCUMULATED result too: bounding each call alone still lets repeated appends grow
      // the file without limit. NOTE_MAX is the right constant — its own comment calls it the cap on
      // any single string the CLI "relays or stores".
      return joined.length <= NOTE_MAX ? joined : joined.slice(0, NOTE_MAX);
    }
  }
}

export function createSessionRegistry(deps: RegistryDeps): SessionRegistry {
  const now = deps.now ?? (() => Date.now());
  const clock = deps.clock ?? (() => new Date());
  const states = new Map<Id, SessionState>();
  // `lastOutputAt` as of the last `session:state` we actually sent, per agent. See `tick()`.
  const broadcastOutputAt = new Map<Id, number | null>();
  let windowFocused = true;

  const knownAgent = (id: Id): boolean => deps.store.get().agents.some((a) => a.id === id);
  const get = (id: Id): SessionState => states.get(id) ?? initialSessionState(id);

  const broadcast = (id: Id, state: SessionState): void => {
    broadcastOutputAt.set(id, state.lastOutputAt);
    deps.emit('session:state', { agentId: id, state });
    // After the emit, deliberately: the renderer's update must not be behind anything an observer
    // does (today, a macOS notification).
    deps.onState?.(id, state);
  };

  const apply = (id: Id, ev: SessionEvent): SessionState => {
    const prev = get(id);
    const next = reduceSession(prev, ev, { windowFocused });
    states.set(id, next);
    // Only when something RENDERED changed. `lastOutputAt` ticks on every 16 ms host frame, so
    // emitting unconditionally would send a full SessionState alongside every `session:data` —
    // roughly 240 extra IPC messages a second across four busy panes, against §18's no-polling
    // budget. A stale `lastOutputAt` in the renderer is NOT harmless, though — see `tick()`.
    const changed = next.activity !== prev.activity || next.unread !== prev.unread
      || next.pid !== prev.pid || next.exitCode !== prev.exitCode
      || next.title !== prev.title || next.attachedPane !== prev.attachedPane
      || next.hooksSeen !== prev.hooksSeen;
    if (changed) broadcast(id, next);
    return next;
  };

  /**
   * Spec §12. Claude Code switches session id without exiting (`/clear`, `/resume`, plan mode's
   * "clear context"), and `SessionStart` is the only hook that reports the new one. Resume launches
   * `--resume <agent.claude.sessionId>`, so that field must follow the conversation the user is in.
   * Measured 2026-09-15: an agent launched with `--session-id f7c7f5ff…` had its conversation in
   * `d070c671….jsonl` and no transcript at all for `f7c7f5ff…`.
   *
   * Read before writing: `store.update` broadcasts `workspace:changed` on every call, and
   * `SessionStart` also fires on every ordinary launch with the id Hangar just chose.
   */
  const adoptSessionId = (agentId: Id, reported: unknown): void => {
    if (typeof reported !== 'string' || !SESSION_ID.test(reported)) return;
    // Accepted in either case, compared and stored lowercase — the form claude and `uuid()` write —
    // so an uppercase copy of the current id is not a switch that writes and broadcasts.
    const sessionId = reported.toLowerCase();
    const agent = deps.store.get().agents.find((a) => a.id === agentId);
    if (!agent || agent.claude.sessionId === sessionId) return;
    deps.log(`session id for ${agentId}: ${agent.claude.sessionId} → ${sessionId} (SessionStart)`);
    deps.store.update((ws) => updateAgent(ws, agentId, { claude: { sessionId, hasStartedOnce: true } }));
  };

  const handleAgentEvent = (agentId: Id, cmd: string, payload: unknown): void => {
    // Logged, not silently dropped. `hangar rename`/`note`/`event` reach us from ANY process running
    // as this user, and an unknown id is the ordinary shape of a stale `HANGAR_AGENT_ID` — a shell
    // still open in a deleted agent's worktree, or a hook firing after the agent was removed. The
    // CLI reports success either way (it only relays), so with no line here the event vanishes with
    // no trace anywhere, which is exactly what Plan 02's completion checklist asks not to happen.
    if (!knownAgent(agentId)) {
      deps.log(`ignoring ${cmd} for unknown agent ${agentId}`);
      return;
    }
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    if (cmd === 'event') {
      const name = p.hook_event_name;
      // Not `typeof name === 'string'`: `reduceSession`'s `case 'hook'` deliberately has no trailing
      // return, so an unrecognised name falls THROUGH to `case 'bell'` and raises an unread badge.
      if (!isHookName(name)) return;
      if (name === 'SessionStart') adoptSessionId(agentId, p.session_id);
      apply(agentId, {
        kind: 'hook',
        name,
        notificationType: typeof p.notification_type === 'string' ? p.notification_type : undefined,
        message: typeof p.message === 'string' ? p.message : undefined,
        at: now(),
      });
      return;
    }
    if (cmd === 'rename') {
      if (typeof p.name !== 'string') return;
      // cleanAgentName, not a local trim+slice: this relay does NOT re-run the agent-name zod
      // schema, so without it a control-character name from any process running as this user
      // persists to workspace.json and then fails validation on the next load — which classifies
      // the whole file as corrupt. It also clamps, so `updateAgent`'s cleanName cannot throw a
      // StoreError into the relay for a long name.
      const name = cleanAgentName(p.name);
      if (name.length === 0) return;
      deps.store.update((ws) => updateAgent(ws, agentId, { name }));
      return;
    }
    if (cmd === 'note') {
      const mode = p.mode === 'replace' || p.mode === 'clear' ? p.mode : 'append';
      const text = typeof p.text === 'string' ? p.text : '';
      deps.store.update((ws) => {
        const agent = ws.agents.find((a) => a.id === agentId);
        return agent ? updateAgent(ws, agentId, { notes: applyNote(agent.notes, { mode, text }, clock()) }) : ws;
      });
    }
  };

  // §8.3 step 5, "attached panes re-attach automatically (snapshot replaces screen)". Carrying
  // `attachedPane` across is NOT enough: the HOST forgets its attachments when the socket drops —
  // `hello` reports `attached: 0` for a still-live session — so a pane that still looks attached
  // here silently stops receiving `data`. Nothing else re-issues it: `session:attach` is sent only
  // from the IPC handler, which the renderer calls from an effect keyed on [agentId, paneIndex]
  // that does not re-run on reconnect.
  //
  // The REPLY must be delivered, not discarded: `host/server.ts` answers `attach` with the full
  // budgeted `snapshot` of the mirror, and that is the only copy the pane will ever be offered —
  // the unsolicited `snapshot` push fires only on respawn-over-an-exited-id. Drop it and the pane
  // keeps its pre-drop screen and appends new output onto it, a permanent visual seam. §8.2's
  // backpressure design leans on this directly: it cuts a slow client *because* "reconnect and
  // re-attach already replaces the screen from the snapshot", so without the reply the cut
  // corrupts the pane instead of costing one resync.
  const reattach = (agent: { id: Id; name: string }, info: SessionInfo): void => {
    void deps.hostClient
      .request({ t: 'attach', id: agent.id, cols: info.cols, rows: info.rows })
      .then((m) => {
        // `session:snapshot` is already contracted as "reset the terminal, then write".
        if (m.t === 'snapshot') deps.emit('session:snapshot', { agentId: agent.id, data: m.data, title: m.title });
        else deps.log(`re-attach for ${agent.id} answered with ${m.t}, not a snapshot`);
      })
      .catch((e: unknown) => {
        // There may be no next reconnect to retry on: NOT_FOUND (the session died between `hello`
        // and this request) or TIMEOUT on an otherwise healthy socket both leave the pane blank
        // forever. Silence is the one thing this must not be.
        const detail = e instanceof Error ? e.message : String(e);
        deps.log(`re-attach failed for ${agent.id}: ${detail}`);
        deps.emit('toast', { level: 'warn', title: `${agent.name} could not re-attach`, detail });
      });
  };

  const resetFromHello = (sessions: SessionInfo[]): void => {
    const live = new Map(sessions.map((s) => [s.id, s]));
    // A host session whose agent has been deleted is invisible here, since this iterates the store.
    // Reaping those orphans is §10.5's job, not this module's.
    for (const agent of deps.store.get().agents) {
      const info = live.get(agent.id);
      const previous = get(agent.id);
      let next: SessionState;
      if (info === undefined) next = initialSessionState(agent.id);
      // `unread` carries across on BOTH live and exited paths: rebuilding from `hello` on every
      // reconnect (§8.3 step 5) would otherwise silently clear the user's attention badges, and an
      // agent that raised one and then exited — "it crashed while I was away" — is the case most
      // worth keeping. It also matches the live path, where `reduceSession`'s `exit` case preserves
      // `unread`. `attachedPane` is the deliberate asymmetry: an exited session has nothing to
      // attach to, so it is dropped here and only the live branch carries it.
      else if (info.exited) next = { ...initialSessionState(agent.id), activity: 'exited', exitCode: info.exitCode, title: info.title, unread: previous.unread };
      // `hooksSeen` carries too: whether this agent's Claude has hooks wired is a property of the
      // agent's session, which a socket drop between US and the host did not touch. Resetting it
      // switches the output heuristic back on for a hook-instrumented session, and every output
      // burst then re-flips it to `working` before decaying again.
      else next = { ...initialSessionState(agent.id), activity: 'idle', pid: info.pid, title: info.title, attachedPane: previous.attachedPane, unread: previous.unread, hooksSeen: previous.hooksSeen };
      states.set(agent.id, next);
      broadcast(agent.id, next);

      if (info !== undefined && !info.exited && next.attachedPane !== null) reattach(agent, info);
    }
  };

  const unsubscribes: (() => void)[] = [
    deps.hostClient.on('data', (id, data) => {
      if (!knownAgent(id)) return;
      deps.emit('session:data', { agentId: id, data });
      apply(id, { kind: 'output', at: now() });
    }),
    deps.hostClient.on('snapshot', (id, data, title) => {
      if (!knownAgent(id)) return;
      // Unsolicited: the host respawned over an exited id and is telling attached panes to reset.
      deps.emit('session:snapshot', { agentId: id, data, title });
    }),
    deps.hostClient.on('title', (id, title) => {
      if (!knownAgent(id)) return;
      apply(id, { kind: 'title', title });
      deps.emit('session:title', { agentId: id, title });
    }),
    deps.hostClient.on('bell', (id) => {
      if (knownAgent(id)) apply(id, { kind: 'bell', at: now() });
    }),
    deps.hostClient.on('exit', (id, exitCode) => {
      if (knownAgent(id)) apply(id, { kind: 'exit', exitCode, at: now() });
    }),
    deps.hostClient.on('agentEvent', (agentId, cmd, payload) => handleAgentEvent(agentId, cmd, payload)),
    deps.hostClient.on('connected', (hello) => resetFromHello(hello.sessions)),
  ];

  return {
    get,
    all: () => Object.fromEntries(deps.store.get().agents.map((a) => [a.id, get(a.id)])),
    apply,
    setWindowFocused: (focused) => {
      windowFocused = focused;
    },
    isWindowFocused: () => windowFocused,
    resetFromHello,
    tick: () => {
      const at = now();
      for (const [id, state] of states) {
        // A deleted agent's state would otherwise be kept forever and keep broadcasting
        // `session:state` for an agent the renderer's workspace no longer contains.
        if (!knownAgent(id)) {
          states.delete(id);
          broadcastOutputAt.delete(id);
          continue;
        }
        const next = reduceSession(state, { kind: 'tick', at }, { windowFocused });
        states.set(id, next);
        // Two reasons to send. The decay itself, obviously — but also a `lastOutputAt` that has
        // advanced since our last broadcast, because §13's renderer keeps its OWN SessionState fed
        // only by `session:state` and runs this same reducer on a local 1 s tick. `apply()`'s
        // throttle means its `lastOutputAt` freezes at the last rendered change, so a streaming
        // agent with `hooksSeen === false` decays to `idle` in the renderer while main still reads
        // `working` — and main never corrects it, because main's own tick uses the fresh timestamp,
        // produces no decay, and so broadcasts nothing. Bounded at one message per second per
        // agent, three orders of magnitude inside §18's budget.
        const stale = next.lastOutputAt !== null && next.lastOutputAt !== broadcastOutputAt.get(id);
        if (next !== state || stale) broadcast(id, next);
      }
    },
    dispose: () => {
      for (const un of unsubscribes) un();
      unsubscribes.length = 0;
    },
  };
}
