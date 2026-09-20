// zod schema mirroring shared/types.ts — used to validate workspace.json on load and `layout:set` from the renderer.
import { z } from 'zod';
// The panel bounds live with the pure geometry that repairs to them, so the strict schema below and
// `normalizeLayout` cannot drift into disagreeing about what a legal rect is.
import { PANEL_MAX, PANEL_MIN_H, PANEL_MIN_W } from './layout.ts';
import type { WorkspaceFile } from './types.ts'; // for the compile-time equality guard at the bottom
import { ACTION_COMMAND_MAX, ACTION_LABEL_MAX, AGENT_NAME_MAX, AGENT_WORKSPACES_MAX, PROJECT_ACTIONS_MAX, PROJECT_NAME_MAX } from './constants.ts';

/**
 * Ids are `randomUUID()` in practice, but they also become FILENAMES (`state/agents/<id>.json`) and
 * path segments, so the charset is constrained rather than trusted. Verified before this refine: a
 * full agent with `id: '../../pwned'` passed `AgentSchema`, and `join(dir, `${id}.json`)` then wrote
 * outside `state/agents/` entirely. Reachable only from a hand-edited or imported `workspace.json`,
 * which is exactly the input the load path is written to survive.
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'must contain only letters, digits, dot, underscore or hyphen')
  .refine((v) => v !== '.' && v !== '..', 'must not be a path traversal segment');

/** A single directory segment. `Project.name` becomes one (spec §6.2), so it must not escape. */
export const DirSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_NAME_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !v.includes('/') && v !== '.' && v !== '..' && !/[\u0000-\u001f\u007f:]/.test(v),
    'must be a single directory segment');

export const ProjectSetupSchema = z.object({
  fetchBeforeBranch: z.boolean(),
  copyPatterns: z.array(z.string()),
  cloneDirs: z.array(z.string()),
  postCreate: z.string().nullable(),
});

/**
 * One project action (spec §15.4). Strict, and reused verbatim by `ipc-schemas.ts` so the bounds
 * cannot drift between what the dialog may send and what the file may hold.
 *
 * Control characters are REFUSED rather than stripped, in both fields. A transform here would make
 * the value on disk differ from the value in memory until the next write, and the point of the
 * refusal is that a hostile command never becomes a stored one: `\r` would submit the line the
 * user was supposed to review, and U+0003/U+0015 are eaten by the line editor before any parser
 * runs (G33). The strip in `actionKeystrokes` is the second, independent guard — see the header of
 * `shared/project-actions.ts` for why both exist.
 *
 * `.trim()` on `label` and NOT on `command`: leading whitespace in a command is meaningful to a
 * shell with `HIST_IGNORE_SPACE`, and the settings dialog already trims what it sends.
 */
export const ProjectActionSchema = z.object({
  // eslint-disable-next-line no-control-regex
  label: z.string().trim().min(1).max(ACTION_LABEL_MAX).regex(/^[^\u0000-\u001f\u007f]+$/, 'label must not contain control characters'),
  // eslint-disable-next-line no-control-regex
  command: z.string().min(1).max(ACTION_COMMAND_MAX).regex(/^[^\u0000-\u001f\u007f]+$/, 'command must not contain control characters'),
});

export const ProjectSchema = z.object({
  id: IdSchema,
  // A directory segment (spec §6.2), not just a string: it becomes a path component under
  // HANGAR_HOME/worktrees, so `../../../Desktop` would put worktrees outside the profile and make
  // delete and reconcile operate on paths the user never chose.
  name: DirSegmentSchema,
  repoPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  setup: ProjectSetupSchema,
  claudeArgs: z.array(z.string()),
  // `.catch(undefined)` — the ONLY recovering field on this schema, and deliberately so. Every
  // other field here is load-bearing, so rejecting it is right: a bad `name` or `repoPath` means the
  // file really is unusable. `actions` is a row of buttons. A hand-edited `workspace.json` with one
  // malformed action would otherwise class the WHOLE file corrupt — `workspace-store.load()` moves
  // it to `.corrupt-<timestamp>` and starts empty, costing the user every project and every agent
  // (the same reasoning `LayoutSchema` records for its three `.catch()` enums). Dropping the
  // project's actions is the repair, and it is the SAFE direction: the value discarded is the one
  // that failed the control-character refusal above, so recovery can only ever remove a hostile
  // action, never admit one. It is all-or-nothing per project — zod cannot skip one bad element of
  // an array without a fallback value for it, and inventing an action is worse than dropping the row.
  actions: z.array(ProjectActionSchema).max(PROJECT_ACTIONS_MAX).optional().catch(undefined),
  // §11.9. Plain `.optional()`, no `.catch()`: a boolean has nothing to recover from that
  // `.optional()` does not already cover, and unlike `actions` there is no bounded structure here
  // whose one bad element could cost the whole file.
  shareClaudeMemory: z.boolean().optional(),
  createdAt: z.string(),
});

/** A folder's display name (spec §6.3): 1-80 chars. Exported so `ipc-schemas.ts`
 * (`folder:create`, `folder:update`) can reuse it instead of hand-rolling the same bounds twice. */
export const FolderNameSchema = z.string().min(1).max(80);

export const FolderSchema = z.object({
  id: IdSchema,
  name: FolderNameSchema,
  parentId: IdSchema.nullable(),
  sortKey: z.number(),
  collapsed: z.boolean(),
});

export const WorkspaceSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  baseRef: z.string(),
  createdAt: z.string(),
});

export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);

export const AgentClaudeConfigSchema = z.object({
  sessionId: z.string().min(1),
  hasStartedOnce: z.boolean(),
  permissionMode: PermissionModeSchema.nullable(),
  extraArgs: z.array(z.string()),
});

/**
 * An agent's display name (spec §6.4): trimmed, 1-80 chars, no control characters. Exported so
 * `ipc-schemas.ts` (`agent:create`, `agent:update`) doesn't hand-roll this regex a second and
 * third time — a copy there once added `.trim()` while this definition didn't, so a name was
 * normalised via IPC but persisted verbatim via a hand-edited `workspace.json`.
 */
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_NAME_MAX)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'name must not contain control characters');

export const AgentSchema = z.object({
  id: IdSchema,
  name: AgentNameSchema,
  slug: z.string().min(1),
  folderId: IdSchema.nullable(),
  sortKey: z.number(),
  // `.max` as well as `.min`: `agent:create` has capped this at AGENT_WORKSPACES_MAX since Plan 02,
  // but the PERSISTED schema had no upper bound and neither did `agent:addWorkspace`, so an agent
  // created at the cap could be grown past it one project at a time and a hand-edited
  // `workspace.json` could hold any number. One constant, three enforcement points (here, the
  // create schema, and `agent-service.addWorkspace`).
  workspaces: z.array(WorkspaceSchema).min(1).max(AGENT_WORKSPACES_MAX),
  notes: z.string(),
  claude: AgentClaudeConfigSchema,
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable(),
});

/**
 * The layout as PERSISTED — deliberately lenient. `normalizeLayout` exists to repair a bad layout,
 * and it runs *after* this schema, so bounds here would make a repairable `workspace.json` throw:
 * `load()` would then class the file as corrupt, move it aside, and fall back to empty — losing every
 * project and agent because six panes were on disk. Verified against zod 4.5.4.
 *
 * `LayoutInputSchema` below keeps the strict bounds for `layout:set`, where the payload is a fresh
 * value from the renderer rather than history worth recovering.
 */
// Single source of truth for the three enum fields below, shared by the lenient (persisted) and
// strict (renderer) layout schemas so they cannot enumerate different value sets by accident.
const ARRANGEMENTS = ['single', 'split-h', 'split-v', 'triple', 'grid'] as const;
const SPLIT_ORIENTATIONS = ['split-h', 'split-v'] as const;
const DRAWER_TABS = ['files', 'diff', 'notes'] as const;

/**
 * The floating cheatsheet panel's geometry. Bounds live on the STRICT side only (below): a rect on
 * disk that is off-screen or three pixels tall is `normalizeLayout`'s to repair, and refusing it
 * here would class the whole `workspace.json` corrupt over a panel position.
 */
const PanelRectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const LayoutSchema = z.object({
  panes: z.array(IdSchema.nullable()),
  focusedIndex: z.number(),
  // `normalizeLayout` recomputes `arrangement` unconditionally from the pane count, so the
  // persisted value is never actually read — a junk value has no way to reach behavior, only to
  // fail this schema and (per the file's own philosophy above) class the whole file corrupt.
  arrangement: z.enum(ARRANGEMENTS).catch('single'),
  // The user's remembered h/v choice. Persisted separately from `arrangement`, which is derived
  // from the pane count and so cannot hold a preference across a close (Plan 02 Task 2).
  splitOrientation: z.enum(SPLIT_ORIENTATIONS).catch('split-h'),
  sidebarWidth: z.number(),
  sidebarVisible: z.boolean(),
  drawerWidth: z.number(),
  drawerOpen: z.boolean(),
  // `defaultLayout()`'s own default ('notes' — see shared/types.ts) is the natural fallback, and
  // costs nothing: a junk value here is cosmetic (which drawer tab is selected), not a lost pane.
  drawerTab: z.enum(DRAWER_TABS).catch('notes'),
  // `.default(null)` is the MIGRATION, and it is the reason this field is not a plain object.
  // Every `workspace.json` written before this field existed — the owner's `~/.hangar` included —
  // has no `shortcutsPanel`, and a required key would fail the parse, class the file corrupt and
  // lose every project and agent. `.default(null)` makes the key optional on the way IN while
  // `z.infer` still reports it required on the way OUT, so the hand-maintained mirror at the bottom
  // of this file still holds. `.catch(null)` then covers a malformed rect the same way: "never
  // moved" is a lossless recovery for a panel position.
  shortcutsPanel: PanelRectSchema.nullable().catch(null).default(null),
});

/**
 * The layout as ACCEPTED from the renderer (`layout:set`). Strict — nothing to recover here: the
 * three enum fields lose their `.catch()` fallback (a bad value from the renderer is a rejected
 * request, not a silently-rewritten one — `.catch()` on the persisted schema above is a recovery
 * mechanism for history on disk, not a validation bypass to inherit) and `drawerWidth` gets the
 * same upper bound `normalizeLayout` already enforces (`shared/layout.ts`:
 * `clamp(layout.drawerWidth, 420, 4000)`), matching `sidebarWidth` which already had both bounds.
 */
export const LayoutInputSchema = LayoutSchema.extend({
  panes: z.array(IdSchema.nullable()).min(1).max(4),
  focusedIndex: z.number().int().min(0),
  arrangement: z.enum(ARRANGEMENTS),
  splitOrientation: z.enum(SPLIT_ORIENTATIONS),
  sidebarWidth: z.number().min(200).max(480),
  drawerWidth: z.number().min(420).max(4000),
  drawerTab: z.enum(DRAWER_TABS),
  // Strict, and REQUIRED: the renderer holds a full `Layout` and always sends the field, so the
  // `.default(null)` migration above has no business here. The bounds are the ones
  // `normalizeLayout` repairs to (`PANEL_MIN_W/H`, `PANEL_MAX` in shared/layout.ts) — the renderer
  // clamps before every write, so anything outside them is a bug on this side of the wire and
  // should be a rejected request rather than a silently-rewritten one.
  //
  // Plan 04 Task 3 measured that this file's two `DeepRequired` guard pairs are structurally blind
  // to bounds and refinements: they compare KEYS and optionality, so `z.number()` and
  // `z.number().min(240)` are indistinguishable to them. Only a runtime `safeParse` can see this,
  // which is what `layout-schema.test.ts` does.
  shortcutsPanel: z.object({
    x: z.number().min(0).max(PANEL_MAX),
    y: z.number().min(0).max(PANEL_MAX),
    w: z.number().min(PANEL_MIN_W).max(PANEL_MAX),
    h: z.number().min(PANEL_MIN_H).max(PANEL_MAX),
  }).nullable(),
});

export const WorkspaceFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectSchema),
  folders: z.array(FolderSchema),
  agents: z.array(AgentSchema),
  layout: LayoutSchema,
});

/**
 * Strips optionality at every level (arrays included, recursing into their element type rather than
 * being mapped as objects themselves). Plain `-?` on a pair of assignments is not enough on its own:
 * a target optional property is satisfied by a source that omits the key entirely, so an optional
 * field added to only one side of the mirror — `pinned?: boolean` on `Folder` alone, or
 * `pinned: z.boolean().optional()` on `FolderSchema` alone — type-checked clean in both directions.
 * `Required<WorkspaceFile>` would not fix this either: it is shallow, and the realistic case is a
 * field nested inside `Folder`/`Agent`/`Project`, not on `WorkspaceFile` itself.
 *
 * This is complementary to, not a replacement for, the plain pair below: `-?` normalises away
 * optionality on BOTH operands, so this pair cannot see a field that exists on both sides but is
 * optional on only one — e.g. `notes: z.string().optional()` on `AgentSchema` while `Agent.notes`
 * stays required. Verified: that drift compiles clean under this pair alone.
 *
 * Exported so `ipc-schemas.ts` can port the same two-pair guard for `IpcRequests`/`IpcSchemas` —
 * the `satisfies` clause there is one-way (covariant in zod's Output parameter), so it catches a
 * schema that's missing or narrows a contract field but not the reverse: an extra schema field, an
 * optional contract field the schema drops, or a schema that's stricter than the contract allows.
 */
export type DeepRequired<T> = T extends (infer U)[] ? DeepRequired<U>[] : T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;

// Compile-time guard: this file is a hand-maintained mirror of shared/types.ts, and zod
// SILENTLY STRIPS keys it does not know. Without this, adding a field to `Agent` and
// forgetting it here writes the field to workspace.json and then drops it on the next
// load — data loss with no error and no failing test. Two complementary pairs, because neither
// alone catches everything a hand-maintained mirror can drift on (both verified: each of the
// two failure modes below compiles clean under the other pair by itself).

// Plain pair: catches a field present on BOTH sides whose optionality differs (`notes?: string` on
// one side, `notes: string` on the other) — a required target property is not satisfied by a source
// that may omit it. Names the offending property directly, which is also a far better error than the
// DeepRequired pair produces. Misses a field that is optional and present on only ONE side (see above).
const _schemaMatchesType: WorkspaceFile = {} as z.infer<typeof WorkspaceFileSchema>;
const _typeMatchesSchema: z.infer<typeof WorkspaceFileSchema> = {} as WorkspaceFile;
void _schemaMatchesType;
void _typeMatchesSchema;

// DeepRequired pair: catches a field present on only one side, including when it is optional there —
// which the plain pair above misses, since an optional target key is satisfied by a source that omits
// it entirely. These two assignments fail to compile if either side gains or loses a key, required or
// optional.
const _deepSchemaMatchesType: DeepRequired<WorkspaceFile> = {} as DeepRequired<z.infer<typeof WorkspaceFileSchema>>;
const _deepTypeMatchesSchema: DeepRequired<z.infer<typeof WorkspaceFileSchema>> = {} as DeepRequired<WorkspaceFile>;
void _deepSchemaMatchesType;
void _deepTypeMatchesSchema;
