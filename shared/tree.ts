// The §6.3 sibling ordering, in ONE place. This is also §13's `childrenOf(parentId)` selector:
// the renderer's sidebar and main's sortKey arithmetic need the identical answer, so they share
// the identical function.
//
// It lived in `src/main/services/workspace-ops.ts` and was copied verbatim — tie strings and all —
// into `src/renderer/lib/tree.ts`, whose header said "same rule as workspace-ops.siblings" rather
// than importing it. Two implementations, one test: mutating either tie string in the renderer
// copy left the whole suite green, while the same mutation in workspace-ops was caught by
// `workspace-ops.test.ts` ("siblings are folders and agents interleaved by sortKey, ties
// folders-first"). The renderer cannot import from `src/main/**` (spec §16), so `shared/` is where
// the single copy has to live.
import type { Agent, Folder, Id, WorkspaceFile } from './types.ts';

export type TreeChild = { kind: 'folder'; folder: Folder } | { kind: 'agent'; agent: Agent };

export const childId = (c: TreeChild): Id => (c.kind === 'folder' ? c.folder.id : c.agent.id);
export const childKey = (c: TreeChild): number => (c.kind === 'folder' ? c.folder.sortKey : c.agent.sortKey);

/** Children of a parent (null = root), folders and agents interleaved by sortKey; ties: folders first, then name / createdAt. */
export function siblings(ws: WorkspaceFile, parentId: Id | null): TreeChild[] {
  const items: { key: number; tie: string; child: TreeChild }[] = [];
  for (const f of ws.folders) if (f.parentId === parentId) items.push({ key: f.sortKey, tie: `0${f.name}`, child: { kind: 'folder', folder: f } });
  for (const a of ws.agents) if (a.folderId === parentId) items.push({ key: a.sortKey, tie: `1${a.createdAt}`, child: { kind: 'agent', agent: a } });
  items.sort((x, y) => x.key - y.key || x.tie.localeCompare(y.tie));
  return items.map((i) => i.child);
}
