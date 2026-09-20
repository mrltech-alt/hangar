import { addProjectFlow, rootMenuItems } from '../../lib/agent-actions.ts';
import type { KeymapAction } from '../../lib/keymap.ts';
import { useLayout } from '../../stores/layout.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { ShortcutKbd } from '../ui/Kbd.tsx';
import { Resizer } from '../ui/Resizer.tsx';
import { SearchBox } from './SearchBox.tsx';
import { SidebarHeader } from './SidebarHeader.tsx';
import { Tree } from './Tree.tsx';

const NEW_AGENT: KeymapAction = { kind: 'new-agent' };

export function Sidebar() {
  // `s.snapshot` is the stored reference; the two counts are derived after subscribing, because
  // `s.snapshot?.workspace.projects.length ?? 0` inside the selector would be fine (a number) but
  // `?? []` around an array would not — see the note at the top of Tree.tsx.
  const snapshot = useWorkspace((s) => s.snapshot);
  const width = useLayout((s) => s.layout.sidebarWidth);
  const setSidebar = useLayout((s) => s.setSidebar);
  const showMenu = useUi((s) => s.showContextMenu);
  const openDialog = useUi((s) => s.openDialog);
  const projects = snapshot?.workspace.projects.length ?? 0;
  const agents = snapshot?.workspace.agents.length ?? 0;
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-line bg-bg-1" style={{ width }} onContextMenu={(e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, rootMenuItems()); }}>
      <SidebarHeader />
      <SearchBox />
      {projects === 0 ? (
        <div className="m-3 rounded-md border border-dashed border-line p-4 text-center text-[12px] text-fg-2">
          <div className="mb-2">Add a git repository to get started.</div>
          <Button variant="primary" onClick={() => void addProjectFlow()}>Add project…</Button>
        </div>
      ) : agents === 0 ? (
        <div className="m-3 rounded-md border border-dashed border-line p-4 text-center text-[12px] text-fg-2">
          <div className="mb-2">Create your first agent.</div>
          <Button variant="primary" onClick={() => openDialog({ kind: 'new-agent', folderId: null })}>New agent <ShortcutKbd action={NEW_AGENT} /></Button>
        </div>
      ) : (
        <Tree />
      )}
      {/* Clamped to §6's 200…480. The store debounces the `layout:set` push by 100 ms, so a drag is
          one write, not one per mousemove — hence `onDone` has nothing left to do. */}
      <Resizer side="right" onResize={(d) => setSidebar({ width: Math.min(480, Math.max(200, width + d)) })} onDone={() => undefined} />
    </aside>
  );
}
