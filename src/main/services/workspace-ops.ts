// Pure operations on WorkspaceFile — spec §6.2 (invariants) and §6.3 (ordering). Every function
// never mutates its input. (The spreads are shallow, so a result can share nested references —
// `workspaces`, `claude`, `setup` — with its input; that is safe only because every caller today
// passes fresh literals. Do not "fix" that into deep copies on the strength of this comment.)
import { AGENT_NAME_MAX, PROJECT_NAME_MAX } from '../../../shared/constants.ts';
import { normalizeLayout, removeAgent as removeAgentFromLayout } from '../../../shared/layout.ts';
import type { Agent, AgentClaudeConfig, Folder, Id, Layout, Project, Workspace, WorkspaceFile } from '../../../shared/types.ts';

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// Imported and re-exported, not redefined: `siblings` moved to shared/ so the renderer's sidebar
// can import the SAME function instead of keeping a verbatim copy of it (spec §6.3, §13). Both
// halves are needed — a bare `export … from` re-export does not bind the names in this module's
// own scope, and the twenty-odd uses below are local. Every call site here and in
// workspace-ops.test.ts keeps working unchanged.
import { childId, childKey, siblings, type TreeChild } from '../../../shared/tree.ts';
export { childId, childKey, siblings, type TreeChild };

export function nextSortKey(ws: WorkspaceFile, parentId: Id | null): number {
  const s = siblings(ws, parentId);
  return s.length === 0 ? 0 : childKey(s[s.length - 1]!) + 1;
}

/** sortKey placing an item before `beforeId` among `parentId`'s children (excluding `movingId`); null → after the last. */
export function sortKeyBefore(ws: WorkspaceFile, parentId: Id | null, beforeId: Id | null, movingId: Id): number {
  const s = siblings(ws, parentId).filter((c) => childId(c) !== movingId);
  if (beforeId === null) return s.length === 0 ? 0 : childKey(s[s.length - 1]!) + 1;
  const idx = s.findIndex((c) => childId(c) === beforeId);
  if (idx === -1) throw new StoreError('NOT_FOUND', `no sibling ${beforeId} under ${parentId ?? 'root'}`);
  const next = childKey(s[idx]!);
  if (idx === 0) return next - 1;
  return (childKey(s[idx - 1]!) + next) / 2;
}

export function needsRenumber(ws: WorkspaceFile, parentId: Id | null): boolean {
  const s = siblings(ws, parentId);
  for (let i = 1; i < s.length; i++) if (childKey(s[i]!) - childKey(s[i - 1]!) < 1e-6) return true;
  return false;
}

export function normalizeOrder(ws: WorkspaceFile, parentId: Id | null): WorkspaceFile {
  const order = new Map<Id, number>();
  siblings(ws, parentId).forEach((c, i) => order.set(childId(c), i));
  return {
    ...ws,
    folders: ws.folders.map((f) => (order.has(f.id) ? { ...f, sortKey: order.get(f.id)! } : f)),
    agents: ws.agents.map((a) => (order.has(a.id) ? { ...a, sortKey: order.get(a.id)! } : a)),
  };
}

const renumberIfNeeded = (ws: WorkspaceFile, parentId: Id | null): WorkspaceFile => (needsRenumber(ws, parentId) ? normalizeOrder(ws, parentId) : ws);

// ---- projects ----

export function requireProject(ws: WorkspaceFile, id: Id): Project {
  const p = ws.projects.find((x) => x.id === id);
  if (!p) throw new StoreError('NOT_FOUND', `no project ${id}`);
  return p;
}

export function uniqueProjectName(ws: WorkspaceFile, name: string, ignoreId?: Id): string {
  const taken = (candidate: string) => ws.projects.some((p) => p.id !== ignoreId && p.name.toLowerCase() === candidate.toLowerCase());
  // `DirSegmentSchema` caps Project.name at PROJECT_NAME_MAX, and `name` here is a caller-supplied
  // basename that never passed through that schema — so bound it up front, and re-bound on every
  // retry: appending `-${n}` to an already-80-char base would produce an 82-char name that fails
  // WorkspaceFileSchema on the very next load (classing the whole file as corrupt).
  const base = name.slice(0, PROJECT_NAME_MAX);
  let candidate = base;
  let n = 2;
  while (taken(candidate)) {
    const suffix = `-${n++}`;
    candidate = `${base.slice(0, PROJECT_NAME_MAX - suffix.length)}${suffix}`;
  }
  return candidate;
}

export function addProject(ws: WorkspaceFile, project: Project): WorkspaceFile {
  // Unreachable while ids are `randomUUID()`, but `createFolder` and `createAgent` both reject a
  // duplicate id outright — matching that here is a one-line consistency fix, not new behavior.
  if (ws.projects.some((p) => p.id === project.id)) throw new StoreError('PROJECT_ID_EXISTS', `project ${project.id} exists`);
  if (ws.projects.some((p) => p.repoPath === project.repoPath)) throw new StoreError('PROJECT_EXISTS', `project already added: ${project.repoPath}`);
  return { ...ws, projects: [...ws.projects, { ...project, name: uniqueProjectName(ws, project.name) }] };
}

export function updateProject(ws: WorkspaceFile, id: Id, patch: Partial<Omit<Project, 'id' | 'repoPath' | 'createdAt'>>): WorkspaceFile {
  const p = requireProject(ws, id);
  const name = patch.name !== undefined ? patch.name.trim() : p.name;
  if (name.length === 0) throw new StoreError('INVALID', 'project name is required');
  if (ws.projects.some((o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase())) throw new StoreError('NAME_TAKEN', `project name already used: ${name}`);
  return { ...ws, projects: ws.projects.map((o) => (o.id === id ? { ...o, ...patch, name } : o)) };
}

const NAMES_SHOWN_MAX = 10;

export function removeProject(ws: WorkspaceFile, id: Id): WorkspaceFile {
  requireProject(ws, id);
  const users = ws.agents.filter((a) => a.workspaces.some((w) => w.projectId === id));
  if (users.length > 0) {
    const names = users.map((a) => a.name);
    const shown = names.slice(0, NAMES_SHOWN_MAX).join(', ');
    const rest = names.length > NAMES_SHOWN_MAX ? ` and ${names.length - NAMES_SHOWN_MAX} more` : '';
    throw new StoreError('PROJECT_IN_USE', `project is used by ${users.length} agent(s): ${shown}${rest}`);
  }
  return { ...ws, projects: ws.projects.filter((p) => p.id !== id) };
}

// ---- folders ----

export function requireFolder(ws: WorkspaceFile, id: Id): Folder {
  const f = ws.folders.find((x) => x.id === id);
  if (!f) throw new StoreError('NOT_FOUND', `no folder ${id}`);
  return f;
}

function requireParent(ws: WorkspaceFile, parentId: Id | null): void {
  if (parentId !== null) requireFolder(ws, parentId);
}

function cleanName(name: string, what: string): string {
  const t = name.trim();
  if (t.length === 0 || t.length > AGENT_NAME_MAX) throw new StoreError('INVALID', `${what} name must be 1–${AGENT_NAME_MAX} characters`);
  return t;
}

export function isDescendantFolder(ws: WorkspaceFile, ancestorId: Id, folderId: Id): boolean {
  // Cycle guard: `WorkspaceFileSchema` does not reject a cyclic folder graph (repair belongs to
  // Task 7's load path, not this pure file), and a hand-edited or bug-written workspace.json can
  // contain one. A naive parent walk over such data never terminates — measured: it blew a
  // 100,000-step budget with no error, hanging Electron main on the first `moveFolder`. A repeated
  // id means the walk found a cycle before finding `ancestorId`, so the honest answer is "false" —
  // the graph cannot be trusted enough to say "true" — rather than spinning forever.
  //
  // The `visited.size` check is a second, independent bound: this loop is synchronous, so neither a
  // vitest per-test timeout nor vitest's own can interrupt it if some future edit reintroduces an
  // unbounded walk — measured, that dies the whole run as a SIGKILLed worker, not a failing
  // assertion. `ws.folders.length` is a hard ceiling on distinct folder ids that can ever be visited,
  // independent of whether the `visited.has` check above still works correctly.
  const visited = new Set<Id>();
  let cur = ws.folders.find((f) => f.id === folderId);
  while (cur) {
    if (visited.has(cur.id) || visited.size > ws.folders.length) return false;
    visited.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    const next = cur.parentId;
    cur = next === null ? undefined : ws.folders.find((f) => f.id === next);
  }
  return false;
}

export function createFolder(ws: WorkspaceFile, input: { id: Id; name: string; parentId: Id | null }): WorkspaceFile {
  if (ws.folders.some((f) => f.id === input.id)) throw new StoreError('FOLDER_EXISTS', `folder ${input.id} exists`);
  requireParent(ws, input.parentId);
  const folder: Folder = { id: input.id, name: cleanName(input.name, 'folder'), parentId: input.parentId, sortKey: nextSortKey(ws, input.parentId), collapsed: false };
  return { ...ws, folders: [...ws.folders, folder] };
}

export function updateFolder(ws: WorkspaceFile, id: Id, patch: { name?: string; collapsed?: boolean }): WorkspaceFile {
  requireFolder(ws, id);
  const name = patch.name !== undefined ? cleanName(patch.name, 'folder') : undefined;
  return { ...ws, folders: ws.folders.map((f) => (f.id === id ? { ...f, ...(name !== undefined ? { name } : {}), ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}) } : f)) };
}

export function moveFolder(ws: WorkspaceFile, id: Id, parentId: Id | null, beforeId: Id | null): WorkspaceFile {
  requireFolder(ws, id);
  if (parentId === id || (parentId !== null && isDescendantFolder(ws, id, parentId))) throw new StoreError('FOLDER_CYCLE', 'cannot move a folder into itself or its descendants (cycle)');
  requireParent(ws, parentId);
  const sortKey = sortKeyBefore(ws, parentId, beforeId, id);
  const next = { ...ws, folders: ws.folders.map((f) => (f.id === id ? { ...f, parentId, sortKey } : f)) };
  return renumberIfNeeded(next, parentId);
}

export function deleteFolder(ws: WorkspaceFile, id: Id): WorkspaceFile {
  const folder = requireFolder(ws, id);
  // The two-loop version (folders re-parented, THEN agents, each via `nextSortKey` — i.e. appended
  // to the end) iterated `ws.folders` and `ws.agents` in creation order, not `siblings()` order, and
  // always dropped children at the END of the destination — every folder ended up sorted above every
  // agent regardless of how they were interleaved under the deleted folder, and children landed at
  // the end of `folder.parentId`'s children instead of where the deleted folder itself sat.
  //
  // A since-reverted fix inserted each child one at a time via `sortKeyBefore`, always "before the
  // sibling that originally followed the deleted folder" — correct in isolation, but n inserts against
  // one fixed anchor each halve the remaining gap, and past ~53 children in a single deleted folder
  // that exhausts double precision: children start landing at or past the anchor, the folders-first
  // tie-break jumps the anchor ahead of them, and `renumberIfNeeded` then bakes that wrong order into
  // integers PERMANENTLY — there is no later state from which to recover the original order. Measured:
  // correct through N=52, first divergence at N=60. Deleting a folder is rare, user-initiated, and
  // already rewrites the destination parent's whole ordering, so there is no reason to approximate it
  // n times over: splice the deleted folder's children (in their own `siblings()` order) into the
  // position it occupied among ITS siblings, then assign 0..n-1 across the combined list in one pass.
  // O(n), exact at any size, no float reasoning, and `renumberIfNeeded` becomes redundant.
  const parentSiblings = siblings(ws, folder.parentId);
  const folderIndex = parentSiblings.findIndex((c) => childId(c) === id);
  const children = siblings(ws, id);
  const combined = [...parentSiblings.slice(0, folderIndex), ...children, ...parentSiblings.slice(folderIndex + 1)];
  const order = new Map<Id, number>();
  combined.forEach((c, i) => order.set(childId(c), i));
  return {
    ...ws,
    folders: ws.folders.filter((f) => f.id !== id).map((f) => (order.has(f.id) ? { ...f, parentId: folder.parentId, sortKey: order.get(f.id)! } : f)),
    agents: ws.agents.map((a) => (order.has(a.id) ? { ...a, folderId: folder.parentId, sortKey: order.get(a.id)! } : a)),
  };
}

// ---- agents ----

export function requireAgent(ws: WorkspaceFile, id: Id): Agent {
  const a = ws.agents.find((x) => x.id === id);
  if (!a) throw new StoreError('NOT_FOUND', `no agent ${id}`);
  return a;
}

function assertWorkspaces(ws: WorkspaceFile, agentId: Id, workspaces: Workspace[]): void {
  if (workspaces.length === 0) throw new StoreError('INVALID', 'an agent needs at least one workspace');
  // `o.id !== agentId` below only rules out clashes against OTHER agents; it says nothing about the
  // incoming `workspaces` array clashing with itself. Two worktrees on the same (projectId, branch)
  // is something git refuses at provision time, far from this validation; a reused workspace id would
  // let one array element silently collide with another wherever code keys off `Workspace.id`.
  const seenIds = new Set<Id>();
  const seenBranches = new Set<string>();
  for (const w of workspaces) {
    requireProject(ws, w.projectId);
    if (seenIds.has(w.id)) throw new StoreError('DUPLICATE_WORKSPACE_ID', `workspace id ${w.id} is used twice on the same agent`);
    seenIds.add(w.id);
    // JSON, not a delimiter: a composite key joined by any single character is ambiguous the
    // moment either half can contain it. Not reachable today (git branches cannot contain
    // spaces and ids are generated).
    const branchKey = JSON.stringify([w.projectId, w.branch]);
    if (seenBranches.has(branchKey)) throw new StoreError('DUPLICATE_WORKSPACE_BRANCH', `branch ${w.branch} is assigned to this agent twice`);
    seenBranches.add(branchKey);
    const clash = ws.agents.find((o) => o.id !== agentId && o.workspaces.some((x) => x.projectId === w.projectId && x.branch === w.branch));
    if (clash) throw new StoreError('BRANCH_IN_USE', `branch ${w.branch} is already used by agent "${clash.name}"`);
  }
}

export function createAgent(ws: WorkspaceFile, agent: Agent): WorkspaceFile {
  if (ws.agents.some((a) => a.id === agent.id)) throw new StoreError('AGENT_EXISTS', `agent ${agent.id} exists`);
  const name = cleanName(agent.name, 'agent');
  requireParent(ws, agent.folderId);
  assertWorkspaces(ws, agent.id, agent.workspaces);
  return { ...ws, agents: [...ws.agents, { ...agent, name, sortKey: nextSortKey(ws, agent.folderId) }] };
}

export interface AgentPatch {
  name?: string;
  notes?: string;
  claude?: Partial<AgentClaudeConfig>;
  lastOpenedAt?: string | null;
  workspaces?: Workspace[];
}

export function updateAgent(ws: WorkspaceFile, id: Id, patch: AgentPatch): WorkspaceFile {
  const a = requireAgent(ws, id);
  const name = patch.name !== undefined ? cleanName(patch.name, 'agent') : a.name;
  if (patch.workspaces !== undefined) assertWorkspaces(ws, id, patch.workspaces);
  const updated: Agent = {
    ...a,
    name,
    notes: patch.notes ?? a.notes,
    claude: patch.claude ? { ...a.claude, ...patch.claude } : a.claude,
    lastOpenedAt: patch.lastOpenedAt !== undefined ? patch.lastOpenedAt : a.lastOpenedAt,
    workspaces: patch.workspaces ?? a.workspaces,
  };
  return { ...ws, agents: ws.agents.map((x) => (x.id === id ? updated : x)) };
}

export function moveAgent(ws: WorkspaceFile, id: Id, folderId: Id | null, beforeId: Id | null): WorkspaceFile {
  requireAgent(ws, id);
  requireParent(ws, folderId);
  const sortKey = sortKeyBefore(ws, folderId, beforeId, id);
  const next = { ...ws, agents: ws.agents.map((a) => (a.id === id ? { ...a, folderId, sortKey } : a)) };
  return renumberIfNeeded(next, folderId);
}

export function deleteAgent(ws: WorkspaceFile, id: Id): WorkspaceFile {
  requireAgent(ws, id);
  return { ...ws, agents: ws.agents.filter((a) => a.id !== id), layout: removeAgentFromLayout(ws.layout, id) };
}

/** Accepts a layout from the renderer: unknown agent ids become empty panes; invariants repaired. */
export function setLayout(ws: WorkspaceFile, layout: Layout): WorkspaceFile {
  const known = new Set(ws.agents.map((a) => a.id));
  const panes = layout.panes.map((p) => (p !== null && known.has(p) ? p : null));
  return { ...ws, layout: normalizeLayout({ ...layout, panes }) };
}
