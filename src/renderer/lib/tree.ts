// Pure sidebar row builder — spec §12.2. Folders and agents interleave by sortKey, using the ONE
// copy of that rule (shared/tree.ts). This file used to carry a verbatim duplicate of
// `workspace-ops.siblings`, tie strings and all; both tie mutants survived the suite because the
// only test of the ordering was main's.
import { siblings } from '../../../shared/tree.ts';
import type { Agent, Folder, Id, WorkspaceFile } from '../../../shared/types.ts';

export type Row =
  | { kind: 'folder'; id: Id; depth: number; folder: Folder; agentCount: number }
  | { kind: 'agent'; id: Id; depth: number; agent: Agent };

export function matchesSearch(ws: WorkspaceFile, agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (agent.name.toLowerCase().includes(q)) return true;
  for (const w of agent.workspaces) {
    if (w.branch.toLowerCase().includes(q)) return true;
    const p = ws.projects.find((x) => x.id === w.projectId);
    if (p && p.name.toLowerCase().includes(q)) return true;
  }
  return false;
}

function countAgents(ws: WorkspaceFile, folderId: Id): number {
  let n = ws.agents.filter((a) => a.folderId === folderId).length;
  for (const f of ws.folders) if (f.parentId === folderId) n += countAgents(ws, f.id);
  return n;
}

export function buildRows(ws: WorkspaceFile, query: string): Row[] {
  if (query.trim().length > 0) {
    return ws.agents
      .filter((a) => matchesSearch(ws, a, query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({ kind: 'agent', id: agent.id, depth: 0, agent }));
  }
  const rows: Row[] = [];
  const walk = (parentId: Id | null, depth: number): void => {
    for (const c of siblings(ws, parentId)) {
      if (c.kind === 'folder') {
        rows.push({ kind: 'folder', id: c.folder.id, depth, folder: c.folder, agentCount: countAgents(ws, c.folder.id) });
        if (!c.folder.collapsed) walk(c.folder.id, depth + 1);
      } else {
        rows.push({ kind: 'agent', id: c.agent.id, depth, agent: c.agent });
      }
    }
  };
  walk(null, 0);
  return rows;
}

/** Folder ids of an agent's ancestors (nearest first). */
export function ancestorsOf(ws: WorkspaceFile, folderId: Id | null): Id[] {
  const out: Id[] = [];
  let cur = folderId;
  while (cur !== null) {
    out.push(cur);
    const f = ws.folders.find((x) => x.id === cur);
    cur = f ? f.parentId : null;
  }
  return out;
}
