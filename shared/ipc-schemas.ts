// Runtime validation for every IPC request payload — spec §16. Keys must match IPC_REQUEST_KEYS exactly (contract.test.ts).
import { z } from 'zod';
import { AGENT_WORKSPACES_MAX, NOTE_MAX, PROJECT_ACTIONS_MAX } from './constants.ts';
import type { IpcRequestKey, IpcRequests } from './ipc-contract.ts';
import { CURSOR_MAX, TEAM_ID_MAX, TICKET_TITLE_MAX, TicketFieldsSchema } from './linear-issues.ts';
import {
  AgentClaudeConfigSchema, AgentNameSchema, DirSegmentSchema, FolderNameSchema, IdSchema, LayoutInputSchema, PermissionModeSchema, ProjectActionSchema, ProjectSetupSchema, type DeepRequired,
} from './workspace-schema.ts';

// Rejects control characters (a NUL byte reaching Node's fs layer throws ERR_INVALID_ARG_VALUE
// instead of failing this validation cleanly) and any '..' segment, including one padded with
// whitespace (`'.split('/').includes('..')` alone missed `'.. '`, a distinct string from `'..'`).
const relPath = z
  .string()
  .min(1)
  .max(4096)
  // eslint-disable-next-line no-control-regex
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'relPath must not contain control characters')
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').some((seg) => seg.trim() === '..'),
    'relPath must be relative and must not contain ..',
  );

/**
 * The same path, plus the worktree ROOT, which the Files tab addresses as the empty string.
 *
 * This is not cosmetic. `FileTree` opens on the root and its very first call is
 * `fs:list({ relPath: '' })`; under the single `.min(1)` schema that was BAD_REQUEST before any
 * handler ran, so the tab would have been empty and the only clue a line in `app.log`. Nothing in
 * the suite could see it: `handlers.test.ts` calls `createHandlers` directly and never touches
 * `IpcSchemas`, `contract.test.ts`'s case table listed `''` for `fs:read` (where it IS invalid —
 * the root is not a file) and never tried it on `fs:list`, and the compile-time pairs at the
 * bottom of this file compare `string` with `string`: a zod refinement has no type to disagree
 * with. Bounds on this file's schemas are reachable ONLY from a runtime parse, which is why the
 * case table exists and why `''` is now in it for both keys, with opposite expectations.
 *
 * A union rather than a second `.min(0)` copy of the chain above: one refinement chain, so the
 * control-character and `..` rules cannot drift between the two keys.
 */
const dirRelPath = z.union([z.literal(''), relPath]);

const geometry = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000) };

const schemas = {
  'workspace:get': z.void(),
  'config:get': z.void(),
  'config:set': z.object({
    nodeBin: z.string().nullable().optional(),
    shellPath: z.string().min(1).optional(),
    notifications: z.enum(['attention', 'all', 'off']).optional(),
    // `.partial()`: a settings UI sends only the field the user changed, and `ConfigStore.set`
    // merges it over the current values. Requiring all three made the store's documented merge
    // unreachable from the renderer.
    terminal: z.object({ fontSize: z.number().min(8).max(32), fontFamily: z.string().min(1), scrollback: z.number().int().min(100).max(100_000) }).partial().optional(),
    // Plan 06. The same bounds as `AppConfigFieldSchemas` in config-store.ts; `config-store.test.ts`
    // asserts the two agree over a table of values.
    claudeDefaultArgs: z.array(z.string().min(1)).optional(),
    reposDir: z.string().refine((p) => p.startsWith('/'), 'must be an absolute path').nullable().optional(),
    triageModel: z.string().min(1).refine((m) => m.trim() === m && !m.startsWith('-'), 'must be a model name: not a flag, no surrounding whitespace').optional(),
    defaultPermissionMode: PermissionModeSchema.nullable().optional(),
  }),

  'project:add': z.object({ repoPath: z.string().min(1) }),
  'project:update': z.object({
    id: IdSchema,
    patch: z.object({
      name: DirSegmentSchema.optional(), // see ProjectSchema — this is the live rename path

      defaultBranch: z.string().min(1).optional(),
      setup: ProjectSetupSchema.optional(),
      claudeArgs: z.array(z.string()).optional(),
      // Strict — no `.catch()`, unlike the persisted `ProjectSchema.actions`. Same split as
      // `LayoutSchema`/`LayoutInputSchema`: recovery on the persisted side exists to save a
      // hand-edited file's other contents, and inheriting it here would turn a renderer bug (or a
      // compromised renderer) into a silently-dropped field rather than a rejected request.
      actions: z.array(ProjectActionSchema).max(PROJECT_ACTIONS_MAX).optional(),
      shareClaudeMemory: z.boolean().optional(), // §11.9
    }),
  }),
  'project:remove': z.object({ id: IdSchema }),
  'project:listBranches': z.object({ id: IdSchema }),

  'folder:create': z.object({ name: FolderNameSchema, parentId: IdSchema.nullable() }),
  'folder:update': z.object({ id: IdSchema, patch: z.object({ name: FolderNameSchema.optional(), collapsed: z.boolean().optional() }) }),
  'folder:move': z.object({ id: IdSchema, parentId: IdSchema.nullable(), beforeId: IdSchema.nullable() }),
  'folder:delete': z.object({ id: IdSchema }),

  'agent:create': z.object({
    name: AgentNameSchema,
    folderId: IdSchema.nullable(),
    // AGENT_WORKSPACES_MAX, not a literal 8: `AgentSchema.workspaces` carries the same bound, and a
    // hand-written second copy was the drift that let an agent be grown past the create-time cap.
    workspaces: z.array(z.object({ projectId: IdSchema, baseBranch: z.string().min(1).nullable() })).min(1).max(AGENT_WORKSPACES_MAX),
    permissionMode: PermissionModeSchema.nullable(),
    startNow: z.boolean(),
  }),
  'agent:update': z.object({
    id: IdSchema,
    patch: z.object({
      name: AgentNameSchema.optional(),
      // NOTE_MAX, the same constant the CLI relay caps to. Two different caps meant a note grown
      // past the smaller one could no longer be edited from the drawer at all — the drawer would
      // reject on save what the CLI had been allowed to write.
      notes: z.string().max(NOTE_MAX).optional(),
      claude: AgentClaudeConfigSchema.partial().optional(),
    }),
  }),
  'agent:move': z.object({ id: IdSchema, folderId: IdSchema.nullable(), beforeId: IdSchema.nullable() }),
  'agent:delete': z.object({ id: IdSchema, options: z.object({ removeWorktrees: z.boolean(), deleteBranches: z.boolean(), force: z.boolean() }) }),
  'agent:inspectDelete': z.object({ id: IdSchema }),
  'agent:start': z.object({ id: IdSchema, mode: z.enum(['auto', 'fresh', 'resume', 'shell-only']) }),
  'agent:stop': z.object({ id: IdSchema }),
  'agent:markOpened': z.object({ id: IdSchema }),
  'agent:markViewed': z.object({ id: IdSchema }),
  'agent:addWorkspace': z.object({ id: IdSchema, projectId: IdSchema, baseBranch: z.string().min(1).nullable() }),
  'agent:inspectRemoveWorkspace': z.object({ id: IdSchema, workspaceId: IdSchema }),
  'agent:removeWorkspace': z.object({ id: IdSchema, workspaceId: IdSchema, options: z.object({ removeWorktrees: z.boolean(), deleteBranches: z.boolean(), force: z.boolean() }) }),

  // LayoutInputSchema, not LayoutSchema: the persisted one is deliberately lenient so a bad
  // layout on disk is repaired rather than treated as corruption. A renderer payload is not
  // history worth recovering, so it gets the strict bounds.
  'layout:set': LayoutInputSchema,

  'session:attach': z.object({ agentId: IdSchema, paneIndex: z.number().int().min(0).max(3), ...geometry }),
  'session:detach': z.object({ agentId: IdSchema }),
  'session:write': z.object({ agentId: IdSchema, data: z.string().max(1_000_000) }),
  'session:resize': z.object({ agentId: IdSchema, ...geometry }),

  // `dirRelPath`, not `relPath`: '' is the worktree root and the first thing the tab asks for.
  'fs:list': z.object({ agentId: IdSchema, workspaceId: IdSchema, relPath: dirRelPath }),
  'fs:read': z.object({ agentId: IdSchema, workspaceId: IdSchema, relPath }),
  'git:changes': z.object({ agentId: IdSchema, workspaceId: IdSchema }),
  'git:fileDiff': z.object({ agentId: IdSchema, workspaceId: IdSchema, relPath }),

  // Plan 06. `ref` is only bounded here: `linear-triage.ts` parses it with `parseLinearRef` and refuses
  // it with INVALID before any process starts, which is the gate that matters.
  'linear:triage': z.object({ requestId: IdSchema, ref: z.string().min(1).max(2048) }),
  'linear:cancel': z.object({ requestId: IdSchema }),

  // Plan 07. Both fields optional: the dialog's first call is `{}`. The cursor is opaque to the
  // renderer and only BOUNDED here; `parseStampedCursor` in the handler is what reads it, and a
  // cursor it cannot read (or one from an abandoned page chain) is ignored rather than refused.
  'linear:myIssues': z.object({ cursor: z.string().min(1).max(CURSOR_MAX).optional(), refresh: z.boolean().optional() }),
  'linear:teams': z.void(),
  // The title is INTERPOLATED into the draft prompt (`buildDraftPrompt`), so its length is decided
  // here rather than in the form: the form is a courtesy and the wire is the guarantee. Capped at the
  // same `TICKET_TITLE_MAX` `TicketFieldsSchema` puts on the title that will eventually be saved, so
  // a title that can be drafted for is always a title that can be filed.
  'linear:draftTicket': z.object({ requestId: IdSchema, title: z.string().min(1).max(TICKET_TITLE_MAX) }),
  // `TicketFieldsSchema` is the shared one the renderer builds against, so the wire and the form
  // cannot disagree about what a ticket is — including the two literals that keep every ticket this
  // feature files assigned to the owner and in Backlog.
  'linear:createTicket': z.object({ fields: TicketFieldsSchema }),
  // Plan 08. Both reads. `cycleId` is a Linear id, bounded by the same `TEAM_ID_MAX` every other id
  // in this feature is bounded by — it goes out as a `cycle` argument and nowhere near a path.
  'linear:cycles': z.object({ refresh: z.boolean().optional() }),
  'linear:cycleIssues': z.object({ cycleId: z.string().min(1).max(TEAM_ID_MAX) }),

  // Plan 09. The agent id is the only thing the renderer names: the text that ends up in a session
  // comes from the helper through main and never crosses this boundary inbound.
  'dictation:start': z.object({ agentId: IdSchema }),
  'dictation:stop': z.void(),
  'dictation:cancel': z.void(),

  'app:pickFolder': z.object({ title: z.string().min(1).max(200).optional() }).optional(),
  'app:openExternal': z.object({ agentId: IdSchema, workspaceId: IdSchema, target: z.enum(['vscode', 'finder', 'terminal']) }),
  'app:copyToClipboard': z.object({ text: z.string().max(1_000_000) }),
  'app:windowFocused': z.object({ focused: z.boolean() }),
  'app:diskFree': z.void(),
  'host:status': z.void(),
  'host:restart': z.object({ killSessions: z.boolean() }),
  // Every schema above strips unknown keys (zod's default) rather than rejecting them — the right
  // call for §16 forward-compat if renderer and main were ever versioned independently. They are
  // not: this is one Electron binary, so there is no actual compat need, and `.strict()` here
  // would have turned the `config:set`/`version` gap below into a loud parse failure the moment it
  // fired instead of a silent drop. Not changed per review — the bidirectional guard below is the
  // intended defense — but worth knowing this is a choice, not an oversight.
} satisfies { [K in IpcRequestKey]: z.ZodType<IpcRequests[K]['req']> };

export const IpcSchemas: { [K in IpcRequestKey]: z.ZodType<IpcRequests[K]['req']> } = schemas;

// Compile-time guard, ported from `shared/workspace-schema.ts`'s WorkspaceFileSchema guard: the
// `satisfies` clause above only checks that each schema's inferred output EXTENDS the contract's
// `req` type (zod's `ZodType<Output>` is covariant in `Output`), so it catches a schema missing a
// required contract field, or one that's too loose — but not the reverse. Measured against this
// file: an extra field added to a schema but not the contract, an optional contract field a schema
// drops entirely, a contract-optional field a schema makes required, and a schema that narrows a
// contract type (e.g. `Id | null` -> `Id`) all compiled clean under `satisfies` alone. Two
// complementary pairs, because neither alone catches everything (see the DeepRequired comment in
// workspace-schema.ts for why the plain pair alone misses an optional field absent on one side).
type SchemaReqShape = { [K in IpcRequestKey]: z.infer<(typeof schemas)[K]> };
type ContractReqShape = { [K in IpcRequestKey]: IpcRequests[K]['req'] };

const _schemaMatchesContract: ContractReqShape = {} as SchemaReqShape;
const _contractMatchesSchema: SchemaReqShape = {} as ContractReqShape;
void _schemaMatchesContract;
void _contractMatchesSchema;

const _deepSchemaMatchesContract: DeepRequired<ContractReqShape> = {} as DeepRequired<SchemaReqShape>;
const _deepContractMatchesSchema: DeepRequired<SchemaReqShape> = {} as DeepRequired<ContractReqShape>;
void _deepSchemaMatchesContract;
void _deepContractMatchesSchema;
