import { describe, expect, it } from 'vitest';
import { ACTION_COMMAND_MAX, ACTION_LABEL_MAX, AGENT_WORKSPACES_MAX, PROJECT_ACTIONS_MAX } from './constants.ts';
import { IPC_EVENT_KEYS, IPC_REQUEST_KEYS, type IpcRequestKey } from './ipc-contract.ts';
import { IpcSchemas } from './ipc-schemas.ts';
import { TICKET_DESCRIPTION_MAX, TICKET_TITLE_MAX } from './linear-issues.ts';

describe('IPC contract', () => {
  it('every request key has exactly one zod schema', () => {
    expect(Object.keys(IpcSchemas).sort()).toEqual([...IPC_REQUEST_KEYS].sort());
  });
  it('schemas reject bad payloads and accept good ones', () => {
    expect(IpcSchemas['agent:create'].safeParse({ name: '', folderId: null, workspaces: [], permissionMode: null, startNow: true }).success).toBe(false);
    expect(IpcSchemas['agent:create'].safeParse({ name: 'X', folderId: null, workspaces: [{ projectId: 'p', baseBranch: null }], permissionMode: 'plan', startNow: true }).success).toBe(true);
    expect(IpcSchemas['session:attach'].safeParse({ agentId: 'a', paneIndex: 0, cols: 80, rows: 24 }).success).toBe(true);
    expect(IpcSchemas['session:attach'].safeParse({ agentId: 'a', paneIndex: 9, cols: 80, rows: 24 }).success).toBe(false);
    expect(IpcSchemas['workspace:get'].safeParse(undefined).success).toBe(true);
    expect(IpcSchemas['fs:read'].safeParse({ agentId: 'a', workspaceId: 'w', relPath: '../etc/passwd' }).success).toBe(false);
  });
  /**
   * The create-time half of AGENT_WORKSPACES_MAX. It is the same number the persisted
   * `AgentSchema.workspaces` and `agent-service.addWorkspace` use, and only a runtime parse can see
   * it: both DeepRequired mirror pairs are structurally blind to bounds (Plan 04 Task 3 measured
   * that), so `tsc` stays green with the `.max()` removed.
   */
  it('caps agent:create workspaces at AGENT_WORKSPACES_MAX, with the boundary inside', () => {
    const create = (n: number): boolean => IpcSchemas['agent:create'].safeParse({
      name: 'X', folderId: null, permissionMode: null, startNow: false,
      workspaces: Array.from({ length: n }, (_, i) => ({ projectId: `p${i}`, baseBranch: null })),
    }).success;
    expect(create(AGENT_WORKSPACES_MAX)).toBe(true);
    expect(create(AGENT_WORKSPACES_MAX + 1)).toBe(false);
    expect(create(0)).toBe(false);
  });
  /**
   * The empty relPath is the worktree ROOT, and `FileTree`'s very first call is `fs:list` on it.
   * Under one shared `.min(1)` schema that was a BAD_REQUEST reply before any handler ran, so the
   * Files tab would have opened empty. Neither `handlers.test.ts` (which calls `createHandlers`
   * directly, never `IpcSchemas`) nor `tsc` (both sides of the compile-time guard in
   * `ipc-schemas.ts` are plain `string`) can see a bound like this — only a runtime parse can, so
   * the three keys are asserted here with the answers that differ between them.
   */
  it("accepts '' as the worktree root on fs:list only", () => {
    expect(IpcSchemas['fs:list'].safeParse({ agentId: 'a', workspaceId: 'w', relPath: '' }).success).toBe(true);
    // Still a real path everywhere else: the root is not a file, and it is not a diffable path.
    expect(IpcSchemas['fs:read'].safeParse({ agentId: 'a', workspaceId: 'w', relPath: '' }).success).toBe(false);
    expect(IpcSchemas['git:fileDiff'].safeParse({ agentId: 'a', workspaceId: 'w', relPath: '' }).success).toBe(false);
    // The relaxation is ONLY the length floor — `fs:list` keeps every other rule of the chain.
    for (const bad of ['../etc', '/abs', 'a/../../b', 'ok/.. /x']) {
      expect(IpcSchemas['fs:list'].safeParse({ agentId: 'a', workspaceId: 'w', relPath: bad }).success, bad).toBe(false);
    }
  });
  it('event keys are unique', () => {
    expect(new Set(IPC_EVENT_KEYS).size).toBe(IPC_EVENT_KEYS.length);
  });
});

// One valid + one invalid payload per request key. The test above only exercises four of the
// request keys — every other schema could be replaced with `z.any()` and both `contract.test.ts`
// and `tsc` would stay green, since `satisfies` only checks types, never runs a schema. This is a
// `Record<IpcRequestKey, ...>`, not a plain object: TypeScript itself refuses to compile if a key is
// missing here, so a newly added IPC_REQUEST_KEYS entry with no case fails the build rather than
// silently skipping the runtime assertion below.
const casesByKey: Record<IpcRequestKey, { valid: unknown; invalid: unknown }> = {
  'workspace:get': { valid: undefined, invalid: 'not-void' },
  'config:get': { valid: undefined, invalid: 'not-void' },
  'config:set': { valid: { nodeBin: '/usr/local/bin/node' }, invalid: { notifications: 'loud' } },

  'project:add': { valid: { repoPath: '/repo' }, invalid: { repoPath: '' } },
  'project:update': { valid: { id: 'p1', patch: { name: 'proj' } }, invalid: { id: 'p1', patch: { name: '' } } },
  'project:remove': { valid: { id: 'p1' }, invalid: { id: '..' } },
  'project:listBranches': { valid: { id: 'p1' }, invalid: { id: '..' } },

  'folder:create': { valid: { name: 'Folder', parentId: null }, invalid: { name: '', parentId: null } },
  'folder:update': { valid: { id: 'f1', patch: { name: 'New' } }, invalid: { id: 'f1', patch: { name: '' } } },
  'folder:move': { valid: { id: 'f1', parentId: null, beforeId: null }, invalid: { id: '..', parentId: null, beforeId: null } },
  'folder:delete': { valid: { id: 'f1' }, invalid: { id: '..' } },

  'agent:create': {
    valid: { name: 'X', folderId: null, workspaces: [{ projectId: 'p', baseBranch: null }], permissionMode: 'plan', startNow: true },
    invalid: { name: '', folderId: null, workspaces: [], permissionMode: null, startNow: true },
  },
  'agent:update': { valid: { id: 'a1', patch: { name: 'New' } }, invalid: { id: 'a1', patch: { name: '' } } },
  'agent:move': { valid: { id: 'a1', folderId: null, beforeId: null }, invalid: { id: '..', folderId: null, beforeId: null } },
  'agent:delete': {
    valid: { id: 'a1', options: { removeWorktrees: true, deleteBranches: false, force: false } },
    invalid: { id: 'a1', options: { removeWorktrees: 'yes', deleteBranches: false, force: false } },
  },
  'agent:inspectDelete': { valid: { id: 'a1' }, invalid: { id: '..' } },
  'agent:start': { valid: { id: 'a1', mode: 'auto' }, invalid: { id: 'a1', mode: 'bogus' } },
  'agent:stop': { valid: { id: 'a1' }, invalid: { id: '..' } },
  'agent:markOpened': { valid: { id: 'a1' }, invalid: { id: '..' } },
  'agent:markViewed': { valid: { id: 'a1' }, invalid: { id: '..' } },
  'agent:addWorkspace': { valid: { id: 'a1', projectId: 'p1', baseBranch: null }, invalid: { id: 'a1', projectId: 'p1', baseBranch: '' } },
  'agent:inspectRemoveWorkspace': { valid: { id: 'a1', workspaceId: 'w2' }, invalid: { id: 'a1', workspaceId: '..' } },
  'agent:removeWorkspace': {
    valid: { id: 'a1', workspaceId: 'w2', options: { removeWorktrees: true, deleteBranches: false, force: false } },
    invalid: { id: 'a1', workspaceId: 'w2', options: { removeWorktrees: true, deleteBranches: 'no', force: false } },
  },

  'layout:set': {
    valid: { panes: [null], focusedIndex: 0, arrangement: 'single', splitOrientation: 'split-h', sidebarWidth: 260, sidebarVisible: true, drawerWidth: 560, drawerOpen: false, drawerTab: 'notes', shortcutsPanel: null },
    invalid: { panes: [null], focusedIndex: 0, arrangement: 'bogus', splitOrientation: 'split-h', sidebarWidth: 260, sidebarVisible: true, drawerWidth: 560, drawerOpen: false, drawerTab: 'notes', shortcutsPanel: null },
  },

  'session:attach': { valid: { agentId: 'a', paneIndex: 0, cols: 80, rows: 24 }, invalid: { agentId: 'a', paneIndex: 0, cols: 1, rows: 24 } },
  'session:detach': { valid: { agentId: 'a' }, invalid: { agentId: '..' } },
  'session:write': { valid: { agentId: 'a', data: 'hello' }, invalid: { agentId: 'a', data: 12345 } },
  'session:resize': { valid: { agentId: 'a', cols: 80, rows: 24 }, invalid: { agentId: 'a', cols: 80, rows: 0 } },

  // The root, deliberately: it is the payload the tab sends first, and the one a `.min(1)` broke.
  'fs:list': { valid: { agentId: 'a', workspaceId: 'w', relPath: '' }, invalid: { agentId: 'a', workspaceId: 'w', relPath: '../etc' } },
  'fs:read': { valid: { agentId: 'a', workspaceId: 'w', relPath: 'src/index.ts' }, invalid: { agentId: 'a', workspaceId: 'w', relPath: '' } },
  'git:changes': { valid: { agentId: 'a', workspaceId: 'w' }, invalid: { agentId: 'a', workspaceId: '..' } },
  'git:fileDiff': { valid: { agentId: 'a', workspaceId: 'w', relPath: 'src/index.ts' }, invalid: { agentId: 'a', workspaceId: 'w', relPath: '/abs' } },

  'linear:triage': { valid: { requestId: 'triage-mf1a2b3c-1', ref: 'AC-3461' }, invalid: { requestId: '../escape', ref: 'AC-3461' } },
  'linear:cancel': { valid: { requestId: 'triage-mf1a2b3c-1' }, invalid: { requestId: '' } },
  'linear:myIssues': { valid: { refresh: true }, invalid: { cursor: 5 } },
  'linear:teams': { valid: undefined, invalid: 'not-void' },
  'linear:draftTicket': { valid: { requestId: 'draft-mf1a2b3c-1', title: 'Zero click payments' }, invalid: { requestId: 'draft-1', title: '' } },
  'linear:createTicket': {
    valid: { fields: { title: 'Zero click payments', description: '', estimate: null, priority: null, teamId: 't1', projectId: null, assigneeSelf: true, state: 'Backlog' } },
    invalid: { fields: { title: 'Zero click payments', description: '', estimate: null, priority: null, teamId: 't1', projectId: null, assigneeSelf: true, state: 'Done' } },
  },
  'linear:cycles': { valid: { refresh: true }, invalid: { refresh: 'yes' } },
  'linear:cycleIssues': { valid: { cycleId: 'cy-33' }, invalid: { cycleId: '' } },

  'dictation:start': { valid: { agentId: 'a1' }, invalid: { agentId: '..' } },
  'dictation:stop': { valid: undefined, invalid: 'not-void' },
  'dictation:cancel': { valid: undefined, invalid: 'not-void' },

  'app:pickFolder': { valid: { title: 'Choose your repos folder' }, invalid: 'not-void' },
  'app:openExternal': { valid: { agentId: 'a', workspaceId: 'w', target: 'vscode' }, invalid: { agentId: 'a', workspaceId: 'w', target: 'browser' } },
  'app:copyToClipboard': { valid: { text: 'hi' }, invalid: { text: 123 } },
  'app:windowFocused': { valid: { focused: true }, invalid: { focused: 'yes' } },
  'app:diskFree': { valid: undefined, invalid: 'not-void' },
  'host:status': { valid: undefined, invalid: 'not-void' },
  'host:restart': { valid: { killSessions: true }, invalid: { killSessions: 'true' } },
};

describe('IPC schemas — every request key', () => {
  it.each(IPC_REQUEST_KEYS)('%s has a case and accepts its valid payload', (key) => {
    const cases = casesByKey[key];
    expect(cases, `no case table entry for ${key}`).toBeDefined();
    expect(IpcSchemas[key].safeParse(cases.valid).success, `expected valid ${key} payload to parse`).toBe(true);
  });
  it.each(IPC_REQUEST_KEYS)('%s rejects its invalid payload', (key) => {
    const cases = casesByKey[key];
    expect(IpcSchemas[key].safeParse(cases.invalid).success, `expected invalid ${key} payload to be rejected`).toBe(false);
  });
});

/**
 * Spec §15.4. The one-case-per-key table above covers `project:update` through its `name`, so these
 * are here rather than replacing that case. This is the wire boundary for a value that ends up being
 * TYPED into a live interactive shell, and unlike the persisted `ProjectSchema.actions` it is strict:
 * a bad action here is a rejected request, not a silently-dropped field (the `LayoutSchema` /
 * `LayoutInputSchema` split, for the same reason).
 *
 * Control characters are written as escapes, never as literal bytes (G48).
 */
describe('project:update actions (spec §15.4)', () => {
  const patch = (actions: unknown): unknown => ({ id: 'p1', patch: { actions } });
  const accepts = (actions: unknown): boolean => IpcSchemas['project:update'].safeParse(patch(actions)).success;

  it('accepts a well-formed list, and an absent one', () => {
    expect(accepts([{ label: 'Tests', command: 'npm test' }])).toBe(true);
    expect(accepts([])).toBe(true);
    expect(IpcSchemas['project:update'].safeParse({ id: 'p1', patch: {} }).success).toBe(true);
  });

  // §11.9's field on the same patch: optional, boolean, and not coerced from a truthy string.
  it('accepts shareClaudeMemory as a boolean only', () => {
    for (const v of [true, false]) expect(IpcSchemas['project:update'].safeParse({ id: 'p1', patch: { shareClaudeMemory: v } }).success).toBe(true);
    for (const v of ['true', 1, null]) expect(IpcSchemas['project:update'].safeParse({ id: 'p1', patch: { shareClaudeMemory: v } }).success).toBe(false);
  });

  it('refuses a control character in either half — the byte the line editor eats before any parser (G33)', () => {
    for (const ch of ['\u0000', '\u0003', '\u0015', '\u001b', '\r', '\n', '\u007f']) {
      expect(accepts([{ label: 'Tests', command: `npm test${ch}` }]), `command with U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
      expect(accepts([{ label: `Te${ch}sts`, command: 'npm test' }]), `label with U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
    }
  });

  it('refuses an empty half, an over-long half and too many actions', () => {
    expect(accepts([{ label: '', command: 'npm test' }])).toBe(false);
    expect(accepts([{ label: '  ', command: 'npm test' }])).toBe(false);
    expect(accepts([{ label: 'Tests', command: '' }])).toBe(false);
    expect(accepts([{ label: 'x'.repeat(ACTION_LABEL_MAX + 1), command: 'npm test' }])).toBe(false);
    expect(accepts([{ label: 'Tests', command: 'y'.repeat(ACTION_COMMAND_MAX + 1) }])).toBe(false);
    expect(accepts(Array.from({ length: PROJECT_ACTIONS_MAX + 1 }, () => ({ label: 'a', command: 'npm test' })))).toBe(false);
    // And the boundary itself is inside, not outside — an off-by-one in either direction fails here.
    expect(accepts([{ label: 'x'.repeat(ACTION_LABEL_MAX), command: 'y'.repeat(ACTION_COMMAND_MAX) }])).toBe(true);
    expect(accepts(Array.from({ length: PROJECT_ACTIONS_MAX }, () => ({ label: 'a', command: 'npm test' })))).toBe(true);
  });
});

/**
 * Plan 06. `addProjectFlow` still calls `run('app:pickFolder')` with no payload, which sends
 * `undefined` — a schema that only accepted `{ title }` would turn "Add project…" into BAD_REQUEST.
 */
describe('app:pickFolder title (Plan 06)', () => {
  it('accepts no payload, an empty object and a title; refuses a title that is not a short string', () => {
    for (const ok of [undefined, {}, { title: 'Choose your repos folder' }]) expect(IpcSchemas['app:pickFolder'].safeParse(ok).success).toBe(true);
    for (const bad of [{ title: '' }, { title: 5 }, { title: 'x'.repeat(201) }]) expect(IpcSchemas['app:pickFolder'].safeParse(bad).success).toBe(false);
  });
});

/** Plan 06. The wire bound on `ref` is only a size cap (`parseLinearRef` is the real gate), so pin its boundary. */
describe('linear:triage ref bound (Plan 06)', () => {
  it('accepts a ref at 2048 characters and refuses one at 2049', () => {
    const triage = (ref: string): boolean => IpcSchemas['linear:triage'].safeParse({ requestId: 'r1', ref }).success;
    expect(triage('x'.repeat(2048))).toBe(true);
    expect(triage('x'.repeat(2049))).toBe(false);
  });
});

/** Plan 07. Both fields are optional — the dialog's first call is `run('linear:myIssues', {})`. */
describe('linear:myIssues payload (Plan 07)', () => {
  it('accepts an empty object, a cursor and a refresh; refuses an empty or over-long cursor', () => {
    for (const ok of [{}, { cursor: 'c2' }, { refresh: true }, { cursor: 'c2', refresh: false }]) {
      expect(IpcSchemas['linear:myIssues'].safeParse(ok).success).toBe(true);
    }
    for (const bad of [{ cursor: '' }, { cursor: 'x'.repeat(4097) }, { refresh: 'yes' }, undefined]) {
      expect(IpcSchemas['linear:myIssues'].safeParse(bad).success).toBe(false);
    }
  });
});

/**
 * Plan 07. The title the draft prompt is built from is the owner's own typing, but it is
 * INTERPOLATED into that prompt, and the form that collects it is a renderer a bug (or a compromise)
 * does not have to run — so the wire is where its length is decided. `buildDraftPrompt` bounds it a
 * second time, on its own line, which is the right shape for a prompt and not a reason for the
 * boundary to trust its caller. `TICKET_TITLE_MAX` is the same bound `TicketFieldsSchema` puts on the
 * title that will eventually be saved, so a title that can be drafted for is always one that can be
 * filed.
 */
describe('linear:draftTicket payload (Plan 07)', () => {
  const draft = (payload: unknown): boolean => IpcSchemas['linear:draftTicket'].safeParse(payload).success;

  it('caps the title at TICKET_TITLE_MAX, with the boundary inside, and needs a request id', () => {
    expect(draft({ requestId: 'draft-mf1a2b3c-1', title: 'x'.repeat(TICKET_TITLE_MAX) })).toBe(true);
    expect(draft({ requestId: 'draft-mf1a2b3c-1', title: 'x'.repeat(TICKET_TITLE_MAX + 1) })).toBe(false);
    expect(draft({ requestId: 'draft-mf1a2b3c-1', title: '' })).toBe(false);
    expect(draft({ requestId: '../escape', title: 'A title' })).toBe(false);
    expect(draft({ title: 'A title' })).toBe(false);
  });
});

/**
 * Plan 07. The two fixed fields are the wire's own guarantee: this feature files tickets for the
 * owner, in Backlog, and a renderer bug (or a compromised renderer) cannot spell anything else.
 */
describe('linear:createTicket fixed fields (Plan 07)', () => {
  const fields = (patch: Record<string, unknown>): unknown => ({
    fields: { title: 'T', description: '', estimate: null, priority: null, teamId: 't1', projectId: null, assigneeSelf: true, state: 'Backlog', ...patch },
  });
  const accepts = (patch: Record<string, unknown>): boolean => IpcSchemas['linear:createTicket'].safeParse(fields(patch)).success;

  it('pins assignee and state, and bounds the rest', () => {
    expect(accepts({})).toBe(true);
    expect(accepts({ assigneeSelf: false })).toBe(false);
    expect(accepts({ state: 'Todo' })).toBe(false);
    expect(accepts({ title: '' })).toBe(false);
    expect(accepts({ priority: 5 })).toBe(false);
    expect(accepts({ estimate: -1 })).toBe(false);
    // And no `id` can ride along: the schema strips unknown keys, so a create can never become an edit.
    const parsed = IpcSchemas['linear:createTicket'].safeParse(fields({ id: 'AC-3461' }));
    expect(parsed.success && 'id' in parsed.data.fields).toBe(false);
  });

  /**
   * The two length bounds, at their boundaries. `ticketFieldsProblem` checks the same two so the form
   * can say what is wrong inline, but that is a courtesy running in the renderer; THIS is the check
   * that decides what main will hand to `save_issue`, and only a runtime parse can see it.
   */
  it('caps the title and the description, with both boundaries inside', () => {
    expect(accepts({ title: 'x'.repeat(TICKET_TITLE_MAX) })).toBe(true);
    expect(accepts({ title: 'x'.repeat(TICKET_TITLE_MAX + 1) })).toBe(false);
    expect(accepts({ description: 'y'.repeat(TICKET_DESCRIPTION_MAX) })).toBe(true);
    expect(accepts({ description: 'y'.repeat(TICKET_DESCRIPTION_MAX + 1) })).toBe(false);
  });
});
