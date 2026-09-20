import { Plus } from 'lucide-react';
import { rootMenuItems } from '../../lib/agent-actions.ts';
import { useUi } from '../../stores/ui.ts';
import { IconButton } from '../ui/Button.tsx';

export function SidebarHeader() {
  const show = useUi((s) => s.showContextMenu);
  return (
    // `pl-[78px]` leaves room for the macOS traffic lights: the window is `titleBarStyle:
    // 'hiddenInset'`, so the buttons float over the sidebar's own first 78px with nothing under
    // them to push this title aside.
    <div className="drag-region flex h-10 shrink-0 items-center justify-between pr-2 pl-[78px]">
      <span className="text-[11px] font-semibold tracking-wider text-muted">AGENTS</span>
      <IconButton
        title="New agent, folder or project"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          show(r.left, r.bottom + 4, rootMenuItems());
        }}
      >
        <Plus size={14} />
      </IconButton>
    </div>
  );
}
