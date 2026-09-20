import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { Folder } from '../../../../shared/types.ts';
import { folderMenuItems } from '../../lib/agent-actions.ts';
import { run } from '../../lib/api.ts';
import { useUi } from '../../stores/ui.ts';
import { InlineRename } from './InlineRename.tsx';

export function FolderRow({ folder, depth, agentCount, unreadCount, dropHint }: { folder: Folder; depth: number; agentCount: number; unreadCount: number; dropHint: 'before' | 'after' | 'into' | null }) {
  // A boolean and two stored function references — nothing allocated in a selector (see AgentRow).
  const renaming = useUi((s) => s.renamingId === folder.id);
  const setRenaming = useUi((s) => s.setRenaming);
  const showMenu = useUi((s) => s.showContextMenu);
  const Chevron = folder.collapsed ? ChevronRight : ChevronDown;
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    // See AgentRow: `Sidebar`'s `<aside>` has its own `onContextMenu`, and a bubbling contextmenu
    // event let it overwrite this menu with the root one. A row that opens a menu owns the event.
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, folderMenuItems(folder.id));
  };
  return (
    <div
      className={`relative flex h-7 cursor-default items-center gap-1 pr-2 text-[12px] hover:bg-bg-2 ${dropHint === 'into' ? 'bg-accent/20' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={() => void run('folder:update', { id: folder.id, patch: { collapsed: !folder.collapsed } })}
      onContextMenu={onContext}
    >
      {dropHint === 'before' || dropHint === 'after' ? <div className={`pointer-events-none absolute right-2 left-2 h-0.5 bg-accent ${dropHint === 'before' ? 'top-0' : 'bottom-0'}`} /> : null}
      <Chevron size={13} className="shrink-0 text-muted" />
      {renaming ? (
        <InlineRename value={folder.name} onCancel={() => setRenaming(null)} onCommit={(name) => { setRenaming(null); void run('folder:update', { id: folder.id, patch: { name } }); }} />
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-fg-2" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(folder.id); }}>
          {folder.name}
        </span>
      )}
      {unreadCount > 0 ? <span className="rounded-full bg-amber px-1.5 text-[10px] font-semibold text-bg-0">{unreadCount}</span> : null}
      <span className="text-[10.5px] text-muted">{agentCount}</span>
    </div>
  );
}
