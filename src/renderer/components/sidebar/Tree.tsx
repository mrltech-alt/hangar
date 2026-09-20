import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { run } from '../../lib/api.ts';
import { DND_MIME, dropPosition, resolveDrop, type DragItem, type DropPosition } from '../../lib/dnd.ts';
import { ancestorsOf, buildRows, type Row } from '../../lib/tree.ts';
import { useSessions } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { AgentRow } from './AgentRow.tsx';
import { FolderRow } from './FolderRow.tsx';

/** How long a collapsed folder must be hovered before it springs open under a drag (spec §12.2). */
const SPRING_OPEN_MS = 600;

export function Tree() {
  // `buildRows` returns a FRESH array on every call, so `useWorkspace((s) => buildRows(...))` — the
  // obvious way to write this — is an infinite render loop, not a wasted allocation. zustand 5 hands
  // the selector straight to `useSyncExternalStore`, which re-runs it after each commit and commits
  // again whenever the result differs by identity. Task 2 measured that exact shape in `useSession`
  // at 55 renders before React threw "Maximum update depth exceeded", alongside React's own "The
  // result of getSnapshot should be cached to avoid an infinite loop". So: subscribe to the STABLE
  // values (a stored object reference and a string), then derive. `Sidebar.test.tsx` mounts this
  // component on a real React root and counts commits, which is the only gate that catches it —
  // tsc, eslint and the pure `tree.test.ts` unit tests all stayed green while that loop was live.
  const snapshot = useWorkspace((s) => s.snapshot);
  const search = useUi((s) => s.search);
  const sessions = useSessions((s) => s.sessions);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [target, setTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const expandTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const rows = useMemo(() => (snapshot ? buildRows(snapshot.workspace, search) : []), [snapshot, search]);
  const cancelExpand = (): void => {
    if (expandTimer.current !== null) {
      clearTimeout(expandTimer.current.timer);
      expandTimer.current = null;
    }
  };
  // A spring-open still pending when the sidebar unmounts would expand a folder nobody is looking
  // at. Reads a ref, so the stale closure an empty dep array creates is harmless.
  useEffect(() => cancelExpand, []);
  if (!snapshot) return null;
  const ws = snapshot.workspace;

  const unreadIn = (folderId: string): number => ws.agents.filter((a) => sessions[a.id]?.unread && ancestorsOf(ws, a.folderId).includes(folderId)).length;

  const canDrop = (item: DragItem, row: Row, position: DropPosition): boolean => {
    if (item.kind === 'agent') return true;
    // G30: moving a folder into itself or into one of its own descendants corrupts the tree. Main
    // rejects it too, but refusing the drop here is what stops the row highlighting as a valid one.
    if (row.kind === 'folder' && row.id === item.id) return false;
    const destFolder = position === 'into' ? row.id : row.kind === 'folder' ? row.folder.parentId : row.agent.folderId;
    if (destFolder === null) return true;
    return destFolder !== item.id && !ancestorsOf(ws, destFolder).includes(item.id);
  };

  const onDragOver = (e: DragEvent, row: Row) => {
    if (!drag) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position = dropPosition(row, (e.clientY - rect.top) / rect.height);
    // The row has now decided, ACCEPT OR REFUSE, and the container's own `onDragOver` below must not
    // overturn it. Same shape as the contextmenu bug in AgentRow/FolderRow, found by sweeping for it:
    // a refusal here used to bubble to the container, which calls `preventDefault()` for any drag in
    // progress, so the cursor read "drop allowed" over a row that would reject the drop and no
    // indicator line was drawn. `onDrop` re-checks `canDrop`, so no wrong move was ever committed —
    // the damage was a lying cursor, not corruption. The container keeps handling the genuine
    // background (the flex-1 filler below the last row), which is what makes "drop on empty space =
    // move to root" work.
    e.stopPropagation();
    if (!canDrop(drag, row, position)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (target?.id !== row.id || target.position !== position) setTarget({ id: row.id, position });
    // The timer is keyed by row id and cancelled the moment the pointer moves off that row or out
    // of its "into" band. Guarding only on `expandTimer.current === null` (no key, no cancel) meant
    // brushing past a collapsed folder still expanded it 600 ms later, from wherever the pointer
    // had got to — and pinned the timer so no other folder could spring open until it fired.
    const wantExpand = row.kind === 'folder' && row.folder.collapsed && position === 'into';
    if (!wantExpand || expandTimer.current?.id !== row.id) cancelExpand();
    if (wantExpand && expandTimer.current === null) {
      const id = row.id;
      expandTimer.current = {
        id,
        timer: setTimeout(() => {
          expandTimer.current = null;
          void run('folder:update', { id, patch: { collapsed: false } });
        }, SPRING_OPEN_MS),
      };
    }
  };

  const clear = () => {
    setTarget(null);
    setDrag(null);
    cancelExpand();
  };

  const onDrop = (e: DragEvent, row: Row | null) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DND_MIME);
    const position = target?.position ?? 'after';
    clear();
    if (!raw) return;
    // Anything can claim a MIME type on a cross-application drag, and a `JSON.parse` throwing
    // inside a drop handler is an unhandled React error, not a no-op.
    let item: DragItem;
    try {
      item = JSON.parse(raw) as DragItem;
    } catch {
      return;
    }
    if (row !== null && !canDrop(item, row, position)) return;
    const dest = row === null ? { parentId: null, beforeId: null } : resolveDrop(rows, row, position);
    if (item.kind === 'agent') void run('agent:move', { id: item.id, folderId: dest.parentId, beforeId: dest.beforeId });
    else void run('folder:move', { id: item.id, parentId: dest.parentId, beforeId: dest.beforeId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={(e) => onDrop(e, null)}>
      {rows.map((row) => (
        <div
          key={row.id}
          // Reordering is meaningless while a search is filtering the tree into a flat, name-sorted
          // list: there are no siblings on screen to be "before".
          draggable={search.length === 0}
          onDragStart={(e) => {
            const item: DragItem = { kind: row.kind, id: row.id };
            e.dataTransfer.setData(DND_MIME, JSON.stringify(item));
            e.dataTransfer.effectAllowed = 'move';
            setDrag(item);
          }}
          onDragEnd={clear}
          onDragOver={(e) => onDragOver(e, row)}
          onDragLeave={() => { if (target?.id === row.id) setTarget(null); }}
          onDrop={(e) => { e.stopPropagation(); onDrop(e, row); }}
        >
          {row.kind === 'folder' ? (
            <FolderRow folder={row.folder} depth={row.depth} agentCount={row.agentCount} unreadCount={unreadIn(row.id)} dropHint={target?.id === row.id ? target.position : null} />
          ) : (
            <AgentRow agent={row.agent} depth={row.depth} dropHint={target?.id === row.id && target.position !== 'into' ? target.position : null} />
          )}
        </div>
      ))}
      {/* Drop zone for "move to root": the flex-1 filler is what makes the empty space below the
          last row a legal drop target rather than dead pixels. */}
      <div className="min-h-6 flex-1" />
    </div>
  );
}
