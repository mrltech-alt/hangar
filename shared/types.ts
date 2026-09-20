// Normative data model — spec §6. The inline comments are part of the spec: they carry
// invariants (uniqueness, bounds, immutability, which id a Record is keyed by) that the
// types themselves cannot express. Keep them in sync with §6 when either side changes.

export type Id = string;      // crypto.randomUUID()
export type IsoDate = string; // new Date().toISOString()

// ---- persisted in HANGAR_HOME/workspace.json ----

export interface WorkspaceFile {
  version: 1;
  projects: Project[];
  folders: Folder[];
  agents: Agent[];
  layout: Layout;
}

export interface Project {
  id: Id;
  name: string;              // default basename(repoPath); editable; unique case-insensitively (it is a worktree dir segment)
  repoPath: string;          // absolute path to the main checkout (must contain .git)
  defaultBranch: string;     // detected on add (§10.1); editable
  setup: ProjectSetup;
  claudeArgs: string[];      // extra args appended to every claude launch for this project
  // Optional so every workspace.json written before spec §15.4 stays valid, and so every existing
  // Project fixture keeps compiling. Absent and empty mean the same thing to the UI.
  actions?: ProjectAction[]; // §15.4 command buttons, typed into the agent's PTY (never executed)
  // §11.9, opt-in. Optional for the same reason `actions` is: every workspace.json written before
  // it, and every existing Project fixture, stays valid. Absent and `false` mean the same thing.
  shareClaudeMemory?: boolean;
  createdAt: IsoDate;
}

/**
 * A user-authored command button (spec §15.4).
 *
 * `command` is USER-AUTHORED, like `ProjectSetup.postCreate` — but unlike `postCreate` it is never
 * handed to a shell by Hangar. Clicking the button TYPES it at the agent's prompt and stops; the
 * user reads what appeared and presses Enter themselves. That is the whole security model, and it
 * only holds while the typed bytes cannot submit themselves, so nothing may write `command` to a
 * PTY directly — `actionKeystrokes` in `shared/project-actions.ts` is the only legal route.
 */
export interface ProjectAction {
  label: string;   // shown in the pane header's ⋯ menu; 1..ACTION_LABEL_MAX after trim
  command: string; // 1..ACTION_COMMAND_MAX; no control characters (they would submit or eat the line)
}

export interface ProjectSetup {
  fetchBeforeBranch: boolean; // `git fetch origin <defaultBranch>` before creating a worktree
  copyPatterns: string[];     // gitignored files to copy into new worktrees (spec G13)
  cloneDirs: string[];        // dirs to APFS-clone (cp -c) from the main checkout (spec G12, G28)
  postCreate: string | null;  // shell command run in the new worktree via `$SHELL -ilc`
}

export interface Folder {
  id: Id;
  name: string;
  parentId: Id | null;       // null = root; must never form a cycle (spec G30)
  sortKey: number;           // ordering among siblings; agents and folders share one space per parent (§6.3)
  collapsed: boolean;
}

export interface Workspace {
  id: Id;
  projectId: Id;
  branch: string;            // unique within its project across agents (a branch lives in one worktree)
  worktreePath: string;      // absolute; under HANGAR_HOME/worktrees/<project.name>/<slug>
  baseRef: string;           // ref the branch was cut from; informational (diffs use merge-base)
  createdAt: IsoDate;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

export interface AgentClaudeConfig {
  sessionId: string;         // UUID made at agent creation; --session-id on first start, --resume after
  hasStartedOnce: boolean;   // false → next start uses --session-id; true → --resume
  permissionMode: PermissionMode | null; // null → don't pass --permission-mode
  extraArgs: string[];       // per-agent extra claude args
}

export interface Agent {
  id: Id;                    // also the session id in the host
  name: string;              // display name; 1–80 chars after trim
  slug: string;              // slugify(name) at creation; IMMUTABLE (worktree dir + branch use it)
  folderId: Id | null;
  sortKey: number;
  workspaces: Workspace[];   // length >= 1; [0] is primary (the PTY's cwd); rest are --add-dir
  notes: string;             // free text; autosaved
  claude: AgentClaudeConfig;
  createdAt: IsoDate;
  lastOpenedAt: IsoDate | null; // set when the agent is placed in a pane or its pane gains focus
}

export type Arrangement = 'single' | 'split-h' | 'split-v' | 'triple' | 'grid';

export type DrawerTab = 'files' | 'diff' | 'notes';

/**
 * A floating panel's remembered geometry, in CSS px from the top-left of the WINDOW (the same frame
 * `position: fixed` and `MouseEvent.clientX/Y` use, so no coordinate conversion happens anywhere).
 *
 * Persisted, and therefore untrustworthy: it can come off disk from a larger display, or from
 * before the window was resized smaller, and either puts the panel somewhere unreachable — with no
 * way back, because dragging it needs a title bar you cannot see. Two layers repair that and they
 * answer different questions. `normalizeLayout` (shared/layout.ts) runs on load and knows nothing
 * about the window, so it can only fix the SHAPE: finite numbers, a size no smaller than the
 * minimum and no larger than any plausible display. The clamp against the actual viewport is the
 * renderer's, because only the renderer knows `window.innerWidth/innerHeight` — `clampPanelRect`
 * is applied to what is DRAWN, not only to what is stored, so a rect that was already on disk when
 * the display changed is corrected on the first render rather than on the first drag.
 */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  panes: (Id | null)[];      // agentIds by pane index; length 1..4; null = empty; never the same agent twice
  focusedIndex: number;      // 0..panes.length-1
  arrangement: Arrangement;  // DERIVED from pane count (§12.3); never set it directly, use splitOrientation
  /**
   * The user's horizontal/vertical choice for the two-pane case, remembered independently of
   * `arrangement`. `arrangement` is recomputed from the pane count on every operation and on load,
   * so storing the preference there loses it the moment the count leaves 2 — the common
   * two-panes-vertical, close one, open another sequence silently reverted to horizontal.
   */
  splitOrientation: 'split-h' | 'split-v';
  sidebarWidth: number;      // px, default 260, min 200, max 480
  sidebarVisible: boolean;
  drawerWidth: number;       // px, default 560, min 420
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  /**
   * The ⌘/ cheatsheet panel's position and size, or `null` for "never moved".
   *
   * `null` is not a placeholder for a default that could have been written here: the default is the
   * SIDEBAR'S WIDTH at the top of the lower half of the window, and neither the sidebar width nor
   * the window height is a constant. So an untouched panel keeps following the sidebar as the user
   * resizes it, and only a drag or a resize freezes a rect. `defaultShortcutsRect` in
   * shared/layout.ts is that derivation.
   *
   * Whether the panel is OPEN is deliberately not here — see `ui.shortcutsOpen`. Position survives
   * a restart; a reference sheet reappearing over your terminals on every launch does not.
   */
  shortcutsPanel: PanelRect | null;
}

// ---- runtime-only (never persisted) ----

export type Activity =
  | 'stopped'          // no PTY
  | 'starting'         // spawn requested, no data yet
  | 'shell'            // PTY alive, claude not running (SessionEnd seen or never started)
  | 'working'          // claude is processing (UserPromptSubmit, or recent-output heuristic)
  | 'waiting'          // claude finished its turn (Stop) or sent a non-permission Notification
  | 'needs-permission' // Notification with permission_prompt
  | 'idle'             // claude running, no hook signal, no output for > 3 s
  | 'exited';          // PTY exited (exitCode retained) until restarted or dismissed

export interface SessionState {
  agentId: Id;
  activity: Activity;
  pid: number | null;
  exitCode: number | null;
  title: string;             // last OSC 0/2 title from the terminal ('' if none)
  lastOutputAt: number | null;   // epoch ms
  lastHookAt: number | null;
  hooksSeen: boolean;        // true once any hook event arrived this session -> heuristics off
  unread: boolean;           // attention event arrived while not visible/focused
  attachedPane: number | null;   // pane index if attached in this app instance
}

export interface WorkspaceRuntime {
  workspaceId: Id;
  worktreeMissing: boolean;  // dir does not exist -> agent shown with a warning; start disabled
}

export interface HostStatus {
  connected: boolean;
  version: string | null;
  sessions: number;
  socketPath: string;
  nodeBin: string | null;
  lastError: string | null;
}

export interface WorkspaceSnapshot {
  workspace: WorkspaceFile;
  // `| undefined` is deliberate: tsconfig has noUncheckedIndexedAccess off, so without it
  // `sessions[id].activity` would compile and then crash. Absent = stopped (§6.5).
  sessions: Record<Id, SessionState | undefined>;       // keyed by AGENT id
  runtime: Record<Id, WorkspaceRuntime | undefined>;    // keyed by WORKSPACE id
  host: HostStatus;
  profile: { home: string; isDefault: boolean };
}

// ---- persisted outside workspace.json ----

/** HANGAR_HOME/config.json (§6.7). Has its own `version`: migrate it like the workspace file. */
export interface AppConfig {
  version: 1;
  nodeBin: string | null;        // resolved path used to run the host; null = re-detect at startup
  shellPath: string;             // injected by main from process.env.SHELL (§9); shared/ cannot read env
  notifications: 'attention' | 'all' | 'off';   // Phase 3
  terminal: { fontSize: number; fontFamily: string; scrollback: number };
  // Plan 06 (spec 2026-09-15 §5.1). Flat on purpose: `config:set`'s merge is shallow except for `terminal`.
  // Appended to EVERY agent launch, before the project's claudeArgs and the agent's extraArgs. Hangar
  // itself owns `--name`, `--session-id`, `--resume`, `--settings`, `--append-system-prompt-file` and
  // `--add-dir` — do not put those here. Do not put `--permission-mode` here either: `defaultPermissionMode`
  // is the supported way to set a mode. The Linear triage run does NOT use this field.
  claudeDefaultArgs: string[];
  reposDir: string | null;       // absolute folder whose direct children are Linear triage candidates; null = not chosen yet
  triageModel: string;           // `--model` for the Linear triage run
  // The New Agent dialog's INITIAL permission-mode selection, for manual creates and ticket drafts;
  // null = the dialog's "Default (ask for permissions)". A dialog default, never a launch argument.
  defaultPermissionMode: PermissionMode | null;
}

/** HANGAR_HOME/state/agents/<agentId>.json (§6.6) — the mirror `hangar status` reads with the app down. */
export interface AgentMirror {
  id: Id;
  name: string;
  slug: string;
  notes: string;
  workspaces: { projectName: string; repoPath: string; branch: string; worktreePath: string }[];
  updatedAt: IsoDate;
}

// ---- defaults ----

export function defaultProjectSetup(): ProjectSetup {
  return {
    fetchBeforeBranch: true,
    copyPatterns: ['.env', '.env.*', '.claude/settings.local.json'],
    cloneDirs: ['node_modules'],
    postCreate: null,
  };
}

export function defaultLayout(): Layout {
  return {
    panes: [null],
    focusedIndex: 0,
    arrangement: 'single',
    splitOrientation: 'split-h',
    sidebarWidth: 260,
    sidebarVisible: true,
    drawerWidth: 560,
    drawerOpen: false,
    // 'notes' because Phase 1 renders a placeholder for 'files' and 'diff' (§3);
    // do not "fix" this to 'files' before Plan 04 ships them.
    drawerTab: 'notes',
    // Not a rect: the default geometry is derived from the live window and sidebar width, so it
    // cannot be written down here. See `Layout.shortcutsPanel`.
    shortcutsPanel: null,
  };
}

export function emptyWorkspace(): WorkspaceFile {
  return { version: 1, projects: [], folders: [], agents: [], layout: defaultLayout() };
}

export function defaultAppConfig(shellPath: string): AppConfig {
  return {
    version: 1,
    nodeBin: null,
    shellPath,
    notifications: 'attention',
    terminal: { fontSize: 13, fontFamily: "Menlo, 'SF Mono', monospace", scrollback: 10_000 },
    claudeDefaultArgs: [],
    reposDir: null,
    triageModel: 'sonnet',
    defaultPermissionMode: null,
  };
}

export function initialSessionState(agentId: Id): SessionState {
  return {
    agentId,
    activity: 'stopped',
    pid: null,
    exitCode: null,
    title: '',
    lastOutputAt: null,
    lastHookAt: null,
    hooksSeen: false,
    unread: false,
    attachedPane: null,
  };
}

/** `workspaces[0]` is the primary by invariant (§6); this makes that a code fact, not a comment. */
export function primaryWorkspace(agent: Agent): Workspace {
  const first = agent.workspaces[0];
  if (first === undefined) throw new Error(`agent ${agent.id} (${agent.name}) has no workspaces`);
  return first;
}
