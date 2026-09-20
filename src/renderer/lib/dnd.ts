// Drag-and-drop geometry for the sidebar — spec §12.2. Pure; the Tree component owns the DOM events.
import type { Id } from '../../../shared/types.ts';
import type { Row } from './tree.ts';

export type DropPosition = 'before' | 'after' | 'into';
export interface DragItem {
  kind: 'folder' | 'agent';
  id: Id;
}

/** `ratio` = pointer y within the row, 0 (top) … 1 (bottom). */
export function dropPosition(row: Row, ratio: number): DropPosition {
  if (row.kind === 'folder') return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
  return ratio < 0.5 ? 'before' : 'after';
}

function parentOf(row: Row): Id | null {
  return row.kind === 'folder' ? row.folder.parentId : row.agent.folderId;
}

/** Turns a drop on `target` into the (parentId, beforeId) pair the move APIs expect. */
export function resolveDrop(rows: Row[], target: Row, position: DropPosition): { parentId: Id | null; beforeId: Id | null } {
  if (position === 'into' && target.kind === 'folder') return { parentId: target.folder.id, beforeId: null };
  const parentId = parentOf(target);
  if (position === 'before') return { parentId, beforeId: target.id };
  // "after X" means "before X's next SIBLING", which is not `rows[idx + 1]`: an expanded folder's
  // children sit between them. Skipping rows deeper than the target is what makes dropping under
  // the last child of a folder land at the end of the PARENT rather than inside that folder.
  const idx = rows.indexOf(target);
  for (let i = idx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.depth < target.depth) break;
    if (r.depth === target.depth && parentOf(r) === parentId) return { parentId, beforeId: r.id };
  }
  return { parentId, beforeId: null };
}

export const DND_MIME = 'application/x-hangar-item';
