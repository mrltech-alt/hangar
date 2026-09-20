// Renderer ↔ main contract — spec §7. Types here; runtime validation in ipc-schemas.ts; handlers in src/main/ipc/handlers.ts.
import type {
  Agent, AgentClaudeConfig, AppConfig, Folder, HostStatus, Id, Layout, PermissionMode, Project, SessionState, Workspace, WorkspaceSnapshot,
} from './types.ts';
import type { DictationOutcome, DictationState } from './dictation.ts';
import type { TicketDraft } from './linear-draft.ts';
import type { DraftedTicketFields, LinearCycle, LinearIssue, LinearTeam, TicketFields } from './linear-issues.ts';

export interface CreateAgentInput {
  name: string;
  folderId: Id | null;
  workspaces: { projectId: Id; baseBranch: string | null }[];
  permissionMode: PermissionMode | null;
  startNow: boolean;
}

export interface DeleteAgentOptions {
  removeWorktrees: boolean;
  deleteBranches: boolean;
  force: boolean;
}

export interface DeleteInspection {
  workspaces: {
    workspaceId: Id;
    branch: string;
    worktreePath: string;
    dirtyFiles: number;
    unmergedCommits: number;
    worktreeMissing: boolean;
    /**
     * A count above could not be established — git refused, or the project is gone from the
     * workspace — so `dirtyFiles`/`unmergedCommits` are 0 for want of an answer, not because there
     * is nothing to lose. The delete dialog's typed-name force gate is the ONLY gate on this
     * operation, and it arms off those counts, so a workspace with this set must never be offered
     * as a safe delete: a broken `.git` link makes the directory exist (`worktreeMissing` false)
     * while every count reads 0 and real files sit inside it.
     */
    inspectionFailed: boolean;
  }[];
}

export type StartMode = 'auto' | 'fresh' | 'resume' | 'shell-only';

export interface FsEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  ignored: boolean;
  size: number | null;
}

export interface FsFile {
  content: string;
  language: string | null;
  truncated: boolean;
  binary: boolean;
  size: number;
  image: string | null;
}

export interface ChangeSet {
  mergeBase: string;
  aheadCommits: number;
  /**
   * Spec §12.5's `+A −D` header. Tracked changes come from `git diff --shortstat` against the merge
   * base; untracked files are counted separately by `diff-service.ts`, because `git diff` cannot
   * see them at all and the header would otherwise read "+0 −0" for an agent that has only added
   * files.
   */
  stats: { insertions: number; deletions: number };
  files: { relPath: string; status: 'A' | 'M' | 'D' | 'R' | 'U'; committed: boolean; uncommitted: boolean; untracked: boolean }[];
}

/**
 * One file's two texts, for `@codemirror/merge`'s `unifiedMergeView` — not a unified-diff string.
 *
 * An empty side is a legitimate answer, so each flag says WHY a side is empty rather than leaving
 * the viewer to guess: `oldMissing` = added since the base, `newMissing` = deleted from the working
 * tree, `binary` = there is no text to show, `tooLarge` = one side is over the viewer's size limit
 * and neither is shown (truncating both would render a fabricated deletion at the cut). Anything
 * that could not be READ throws instead of arriving as an empty string.
 */
export interface FileDiff {
  oldText: string;
  newText: string;
  oldMissing: boolean;
  newMissing: boolean;
  binary: boolean;
  tooLarge: boolean;
}

/**
 * Two `ProgressEvent.step` names the RENDERER switches on rather than merely displays, named here
 * so the switch is a compile-checked reference to the emitter instead of a copied string literal.
 * `agent-service.ts` emits both; `components/dialogs/logic.ts` reads them.
 *
 * - `rollback` appears only when a create/addWorkspace failed **and** its worktrees were torn down
 *   again, so its presence is what makes a Retry safe: nothing the failed attempt made survives.
 * - `saved` is emitted once the agent record is committed to the workspace. A create that fails
 *   AFTER this line (`startNow` and the host is down — `createAgent` awaits `startAgent` with no
 *   catch) has left a real agent behind, and retrying it would create a second one.
 */
export const PROGRESS_STEP_ROLLBACK = 'rollback';
export const PROGRESS_STEP_SAVED = 'saved';

export interface ProgressEvent {
  agentId: Id | null;
  opId: Id;
  step: string;
  status: 'running' | 'done' | 'warn' | 'error';
  message: string;
  log?: string;
}

/**
 * Plan 09 (spec 2026-09-18 §4). One change in a dictation run, BROADCAST to every listener.
 *
 * `agentId` is the agent the run was started for — main binds it to the service's run at
 * `dictation:start` and stamps it on every event of that run, and on no other. A listener draws only
 * the events whose `agentId` is its own pane's agent: a broadcast carries everyone's events, and a
 * listener that did not correlate took someone else's result (G89).
 *
 * `outcome` is non-null on exactly ONE event per run — the one that ended it — and main has already
 * acted on it by then: a `write` outcome's text has been typed into that agent's session (never
 * submitted), a `copied` one's is on the clipboard instead (the agent was waiting on a permission
 * prompt, where typed text is a menu choice), and nothing has been written for the rest. `state` on
 * that event is `idle` carrying the same outcome, so the renderer can keep drawing its sentence
 * afterwards.
 */
export interface DictationBroadcast {
  agentId: Id;
  state: DictationState;
  outcome: DictationOutcome | null;
}

export interface ToastEvent {
  level: 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
  sticky?: boolean;
}

export interface IpcRequests {
  'workspace:get': { req: void; res: WorkspaceSnapshot };
  'config:get': { req: void; res: AppConfig };
  // Omit 'version': it's config.json's own on-disk migration marker (mirrors WorkspaceFile's),
  // and the renderer has no business setting it — narrowed here rather than just left unvalidated
  // by ipc-schemas.ts, since the two are checked against each other for exact agreement.
  // `terminal` is spelled out rather than left to `Partial`: `Partial` stops at the top level, so
  // it still demanded all three nested fields, and a settings UI moving only the font-size slider
  // sends exactly one. `ConfigStore.set` has always merged a subset (and `config-store.ts` holds a
  // compile-time assertion that these two stay the same type).
  'config:set': { req: Partial<Omit<AppConfig, 'version' | 'terminal'>> & { terminal?: Partial<AppConfig['terminal']> }; res: AppConfig };

  'project:add': { req: { repoPath: string }; res: Project };
  'project:update': { req: { id: Id; patch: Partial<Omit<Project, 'id' | 'repoPath' | 'createdAt'>> }; res: Project };
  'project:remove': { req: { id: Id }; res: void };
  'project:listBranches': { req: { id: Id }; res: { local: string[]; remote: string[] } };

  'folder:create': { req: { name: string; parentId: Id | null }; res: Folder };
  'folder:update': { req: { id: Id; patch: { name?: string; collapsed?: boolean } }; res: Folder };
  'folder:move': { req: { id: Id; parentId: Id | null; beforeId: Id | null }; res: void };
  'folder:delete': { req: { id: Id }; res: void };

  'agent:create': { req: CreateAgentInput; res: Agent };
  'agent:update': { req: { id: Id; patch: { name?: string; notes?: string; claude?: Partial<AgentClaudeConfig> } }; res: Agent };
  'agent:move': { req: { id: Id; folderId: Id | null; beforeId: Id | null }; res: void };
  'agent:delete': { req: { id: Id; options: DeleteAgentOptions }; res: void };
  'agent:inspectDelete': { req: { id: Id }; res: DeleteInspection };
  'agent:start': { req: { id: Id; mode: StartMode }; res: void };
  'agent:stop': { req: { id: Id }; res: void };
  'agent:markOpened': { req: { id: Id }; res: void };
  'agent:markViewed': { req: { id: Id }; res: void };
  'agent:addWorkspace': { req: { id: Id; projectId: Id; baseBranch: string | null }; res: Workspace };
  // Spec 2026-09-15 §11.2. The inspection has exactly one entry; the renderer reuses the delete gate on it.
  'agent:inspectRemoveWorkspace': { req: { id: Id; workspaceId: Id }; res: DeleteInspection };
  'agent:removeWorkspace': { req: { id: Id; workspaceId: Id; options: DeleteAgentOptions }; res: void };

  'layout:set': { req: Layout; res: void };

  'session:attach': { req: { agentId: Id; paneIndex: number; cols: number; rows: number }; res: { snapshot: string; title: string } };
  'session:detach': { req: { agentId: Id }; res: void };
  'session:write': { req: { agentId: Id; data: string }; res: void };
  'session:resize': { req: { agentId: Id; cols: number; rows: number }; res: void };

  'fs:list': { req: { agentId: Id; workspaceId: Id; relPath: string }; res: FsEntry[] };
  'fs:read': { req: { agentId: Id; workspaceId: Id; relPath: string }; res: FsFile };
  'git:changes': { req: { agentId: Id; workspaceId: Id }; res: ChangeSet };
  'git:fileDiff': { req: { agentId: Id; workspaceId: Id; relPath: string }; res: FileDiff };

  /**
   * Plan 06 (spec 2026-09-15 §5.6): read a Linear ticket with a headless `claude -p` and answer with a
   * DRAFT for the New Agent dialog. Nothing is created. `requestId` is the renderer's, so
   * `linear:cancel` can name the run; errors carry `code` and a `detail` hint (`TriageError`).
   */
  'linear:triage': { req: { requestId: string; ref: string }; res: TicketDraft };
  'linear:cancel': { req: { requestId: string }; res: void };

  /**
   * Plan 07 (spec 2026-09-16 §3.3, §4). The owner's own tickets, straight from the Linear MCP server
   * with **no model** — nothing here spends Claude usage. `issues` is the whole accumulated list, not
   * the page just fetched: `cursor` appends a page to main's app-run cache and `refresh` replaces it,
   * so the renderer renders what it is given and accumulates nothing.
   */
  'linear:myIssues': { req: { cursor?: string; refresh?: boolean }; res: { issues: LinearIssue[]; nextCursor: string | null } };
  /** The teams the create form can file a ticket into. Cached for the app run, like the list. */
  'linear:teams': { req: void; res: { teams: LinearTeam[] } };
  /**
   * Plan 08 (spec 2026-09-17 §3). The cycles of the teams the owner's tickets are in, newest first,
   * with the team stamped on each row so a picker can tell two teams' "cycle 3" apart.
   *
   * Read-only and model-free: `list_cycles` is already in `LINEAR_TOOLS`, addressed by `{teamId}` and
   * nothing else (a `limit` is REFUSED — measured). Cached for the app run beside the ticket list, and
   * dropped by the same `refresh` that drops it.
   *
   * **A Retry after a failure MUST send `refresh: true`.** This is a contract, not an optimisation:
   * a team whose `list_cycles` failed keeps its (resolved) entry in main's per-team memo for the app
   * run, so a bare `{}` rethrows the same error without asking Linear anything at all, and the button
   * does nothing for ever. `refresh` is what drops the memo and the remembered failure with it.
   *
   * The teams come from the CACHED FIRST PAGE of the owner's tickets and only that page — a team
   * whose only assigned ticket sits behind a `Load more` is not asked about, and its cycles are not
   * offered.
   */
  'linear:cycles': { req: { refresh?: boolean }; res: { cycles: LinearCycle[] } };
  /**
   * Plan 08. One cycle's tickets assigned to the owner — `list_issues` with `cycle` and
   * `assignee: 'me'`, every page of it.
   *
   * The WHOLE cycle in one answer, not a page: the tick boxes, `Select all` and the count in the
   * button are all statements about a complete list, and a `Load more` inside a step that is about to
   * spend minutes of usage would make the count a guess. Not cached — picking a cycle is the owner
   * pressing something (§2), and the run is about to re-check against this exact snapshot.
   */
  'linear:cycleIssues': { req: { cycleId: string }; res: { issues: LinearIssue[] } };
  /**
   * Plan 07 (§5). The one model run this feature makes, and only on `Draft with Claude`. It answers
   * with the five fields it may fill — not a whole `TicketFields` — because the merge happens where
   * the owner's own typed values are, and main was never given a title to hand back.
   *
   * The fields come back already cleaned and bounded (`mergeTicketFields`, run at the handler): the
   * `description` is the one thing in this feature a MODEL wrote, and no reply may carry raw model
   * text across this boundary on the promise that the receiver will clean it.
   */
  'linear:draftTicket': { req: { requestId: string; title: string }; res: DraftedTicketFields };
  /**
   * The ONLY write this application makes to Linear. Reached from the create form's Save button and
   * nowhere else: no model can call it, nothing calls it on open, and no test in this repo lets it
   * reach the real server. Creates because `save_issue` is given no `id` (measured).
   *
   * It is sent exactly once per press. It is never retried — not by `linear-mcp.ts` (writes are
   * outside its `RETRYABLE_TOOLS`) and not by the handler — and a timeout comes back as
   * `LINEAR_CREATE_UNCONFIRMED` rather than an error inviting another press.
   */
  'linear:createTicket': { req: { fields: TicketFields }; res: { identifier: string; url: string } };

  /**
   * Plan 09 (spec 2026-09-18 §4). Dictate into ONE agent's session. Refused with `HOST_DOWN` when the
   * session host is not connected, `NOT_FOUND` for an agent that is not in the workspace and
   * `NOT_RUNNING` for one with no live session — nothing is spawned in any of the three. The
   * service's own `DICTATION_BUSY` (a helper is still alive; a second start is refused, never queued)
   * and `DICTATION_DISPOSED` (quitting) come through with their codes.
   *
   * Everything after the start arrives as `dictation:event`, stamped with this `agentId`.
   */
  'dictation:start': { req: { agentId: Id }; res: void };
  /**
   * Finalize: the helper is told to stop and the transcript is written when it arrives. Only one run
   * is ever alive, so neither this nor cancel names an agent. A no-op when the run's phase does not
   * take a stop (before `ready`, the request is cancel — `toggleRequest` says which).
   */
  'dictation:stop': { req: void; res: void };
  /** End the run now; nothing is written. A no-op with no run active. */
  'dictation:cancel': { req: void; res: void };

  // `| undefined`, not a required object: `addProjectFlow` calls it with no payload at all.
  'app:pickFolder': { req: { title?: string } | undefined; res: string | null };
  'app:openExternal': { req: { agentId: Id; workspaceId: Id; target: 'vscode' | 'finder' | 'terminal' }; res: void };
  'app:copyToClipboard': { req: { text: string }; res: void };
  'app:windowFocused': { req: { focused: boolean }; res: void };
  /**
   * Free bytes on the volume that holds the worktrees (§12.8's `9.1 GB free`, and the source for
   * §12.7's low-disk banner). `path` is the directory that was measured, so the strip can name it
   * in a tooltip and a test can assert WHICH volume was chosen rather than only that a number came
   * back — every path on one machine usually returns the same figure.
   */
  'app:diskFree': { req: void; res: { freeBytes: number; path: string } };
  'host:status': { req: void; res: HostStatus };
  'host:restart': { req: { killSessions: boolean }; res: void };
}

export interface IpcEvents {
  'workspace:changed': WorkspaceSnapshot;
  'session:data': { agentId: Id; data: string };
  /** Host pushed a reset (respawn over an exited id, §8.2): reset the terminal, then write. */
  'session:snapshot': { agentId: Id; data: string; title: string };
  'session:title': { agentId: Id; title: string };
  'session:state': { agentId: Id; state: SessionState };
  'agent:progress': ProgressEvent;
  /**
   * Put this agent in a pane and make it the focused one. Sent by main when the user clicks a
   * macOS notification (`src/main/services/notifications.ts`) — main can raise the window, but only
   * the renderer owns the layout. Main sends it only for an agent still in the workspace.
   */
  'agent:focus': { agentId: Id };
  /** Plan 09. A broadcast: correlate on `agentId` — see `DictationBroadcast`. */
  'dictation:event': DictationBroadcast;
  'host:status': HostStatus;
  'toast': ToastEvent;
}

export const IPC_REQUEST_KEYS = [
  'workspace:get', 'config:get', 'config:set',
  'project:add', 'project:update', 'project:remove', 'project:listBranches',
  'folder:create', 'folder:update', 'folder:move', 'folder:delete',
  'agent:create', 'agent:update', 'agent:move', 'agent:delete', 'agent:inspectDelete', 'agent:start', 'agent:stop', 'agent:markOpened', 'agent:markViewed', 'agent:addWorkspace',
  'agent:inspectRemoveWorkspace', 'agent:removeWorkspace',
  'layout:set',
  'session:attach', 'session:detach', 'session:write', 'session:resize',
  'fs:list', 'fs:read', 'git:changes', 'git:fileDiff',
  'linear:triage', 'linear:cancel', 'linear:myIssues', 'linear:teams', 'linear:draftTicket', 'linear:createTicket', 'linear:cycles', 'linear:cycleIssues',
  'dictation:start', 'dictation:stop', 'dictation:cancel',
  'app:pickFolder', 'app:openExternal', 'app:copyToClipboard', 'app:windowFocused', 'app:diskFree', 'host:status', 'host:restart',
] as const satisfies readonly (keyof IpcRequests)[];

export const IPC_EVENT_KEYS = [
  'workspace:changed', 'session:data', 'session:snapshot', 'session:title', 'session:state', 'agent:progress', 'agent:focus', 'dictation:event', 'host:status', 'toast',
] as const satisfies readonly (keyof IpcEvents)[];

// Compile-time completeness guard: `satisfies` above constrains MEMBERSHIP (no entry that isn't a
// real IpcEvents key) but not COVERAGE — dropping 'session:title' from the array while it stays in
// IpcEvents compiles clean and leaves contract.test.ts's uniqueness check green too, since that
// test only checks the array has no duplicates. IPC_REQUEST_KEYS doesn't need this: dropping a
// request key fails contract.test.ts's `Object.keys(IpcSchemas)` equality directly. This line
// fails to compile if any IpcEvents key is missing from the array above.
type _MissingEventKeys = Exclude<keyof IpcEvents, (typeof IPC_EVENT_KEYS)[number]>;
const _allIpcEventKeysListed: _MissingEventKeys extends never ? true : false = true;
void _allIpcEventKeysListed;

export type IpcRequestKey = keyof IpcRequests;
export type IpcEventKey = keyof IpcEvents;

/** Serialisable error thrown across IPC. */
export interface IpcErrorShape {
  code: string;
  message: string;
  detail?: string;
}

/**
 * Plan 07. `linear:createTicket` timed out, and the ticket MAY EXIST.
 *
 * `linear-mcp.ts` already refuses to retry a write, for the reason its own comment gives: a transport
 * failure says the answer was lost, not that the request was. But "did not answer" and "did not
 * happen" look identical from the renderer, and the plain `LINEAR_TIMEOUT` this would otherwise be
 * reads exactly like the timeouts everywhere else in this feature, where pressing the button again is
 * the right answer. Here it is the one thing that files the ticket twice.
 *
 * So the create handler gives that single case a code of its own, and Task 7's form offers "check
 * Linear" rather than another Save. It is defined here, on the wire contract both sides import,
 * because main is where it is raised and the renderer is where it is read — a literal spelled out
 * twice is one typo away from the form quietly falling back to its retry path.
 */
export const LINEAR_CREATE_UNCONFIRMED = 'LINEAR_CREATE_UNCONFIRMED';

/**
 * What actually crosses `contextBridge`. It is a plain object rather than a thrown Error because
 * `contextBridge` copies values between worlds and **strips a thrown Error down to `message` and
 * `stack`** — every own property, `code` and `detail` included, is dropped. §7 specifies errors as
 * `{ code, message, detail? }` "rendered as toasts by a single renderer error handler", and that
 * handler has nothing to switch on if the code dies at the boundary. Plain objects survive intact,
 * so the reply is returned and `createHangarApi` (shared/ipc-client.ts) reconstructs the Error in
 * the main world, where its own properties are nobody's to strip.
 */
export type IpcReply<T> = { ok: true; value: T } | { ok: false; error: IpcErrorShape };

/**
 * The raw preload bridge, exposed as `window.hangar`. Still exactly the two functions §16 allows —
 * `invoke` simply resolves with a Result instead of rejecting, because it cannot construct a
 * main-world Error. Renderer code should not use this directly: wrap it once with
 * `createHangarApi` and consume `HangarApi` below.
 */
export interface HangarBridge {
  invoke<K extends IpcRequestKey>(
    channel: K,
    ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]
  ): Promise<IpcReply<IpcRequests[K]['res']>>;
  on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void;
}

/** The wrapped API renderer code uses: `invoke` rejects with an Error carrying `.code`/`.detail`. */
export interface HangarApi {
  // A conditional rest tuple, not a plain `payload: IpcRequests[K]['req']`: four request keys have
  // `req: void` (spec §7's own prose calls these "no payload"), and a plain required parameter of
  // type `void` still has to be satisfied with an explicit `undefined` at every call site —
  // `invoke('workspace:get')` would not compile. This makes the payload argument disappear
  // entirely for those keys instead.
  invoke<K extends IpcRequestKey>(
    channel: K,
    ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]
  ): Promise<IpcRequests[K]['res']>;
  on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void;
}
