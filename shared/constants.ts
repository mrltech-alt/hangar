/** Limits shared by the session host, the CLI and the app. Keep in sync with spec §8, §11.4, §12.4. */
export const SCROLLBACK_LINES = 10_000;
export const OUTPUT_FLUSH_MS = 16;
export const MAX_FRAME_CHARS = 256 * 1024;
export const KILL_GRACE_MS = 3_000;
export const CLI_REPLY_TIMEOUT_MS = 2_000;
export const HOOK_REPLY_TIMEOUT_MS = 300;
/** How long `hangar event` waits for a hook payload on stdin before giving up (see cli/commands/event.ts). */
export const HOOK_STDIN_TIMEOUT_MS = 2_000;
/** Cap on any single string the CLI relays or stores — notes, hook messages, titles. */
export const NOTE_MAX = 100_000;
export const EVENT_QUEUE_LIMIT = 200;
export const MAX_SOCKET_PATH_LEN = 100; // macOS sun_path is 104 bytes; keep margin
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const AGENT_NAME_MAX = 80;
export const SLUG_MAX = 40;
/** Max length of `Project.name` (spec §6.2): it becomes a directory segment under HANGAR_HOME/worktrees.
 * Shared so `shared/workspace-schema.ts` (DirSegmentSchema) and `workspace-ops.ts` (uniqueProjectName's
 * dedupe suffix) cannot drift apart — a name that fits one but not the other makes a generated name
 * fail WorkspaceFileSchema on the very next load. */
export const PROJECT_NAME_MAX = 80;

/** Max length of a project action's button label (spec §15.4). It is rendered in a context menu
 * item, so the bound is about the menu staying readable, not about safety. */
export const ACTION_LABEL_MAX = 40;
/** Max length of a project action's command. The command is TYPED into the agent's PTY, so this is
 * also the slice `actionKeystrokes` applies — see `shared/project-actions.ts`. */
export const ACTION_COMMAND_MAX = 500;
/** Max number of actions on one project: the ⋯ menu is a flat list with no scrolling. */
export const PROJECT_ACTIONS_MAX = 20;

/**
 * Max workspaces (projects) on one agent, spec §11.8. The number lives here because three places
 * enforce it and they must not drift: `agent:create`'s payload schema, the PERSISTED
 * `AgentSchema.workspaces`, and `agent-service.addWorkspace` — the add path is the one a create-time
 * cap alone cannot see, since it grows an already-valid agent one project at a time.
 * Every workspace past the first becomes an `--add-dir` on the launch command (§11.1).
 */
export const AGENT_WORKSPACES_MAX = 8;
