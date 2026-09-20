import { useState } from 'react';
import { focusedAgent } from '../../../../shared/layout.ts';
import type { DrawerTab, Id } from '../../../../shared/types.ts';
import { withShortcut } from '../../lib/keymap.ts';
import { useLayout } from '../../stores/layout.ts';
import { useAgent } from '../../stores/workspace.ts';
import { Resizer } from '../ui/Resizer.tsx';
import { DiffTab } from './DiffTab.tsx';
import { FilesTab } from './FilesTab.tsx';
import { NotesTab } from './NotesTab.tsx';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';

/**
 * `title` carries the KEY, which is the one thing the visible label does not say — and it is built
 * by `withShortcut` off `SHORTCUTS`, so ⌘⇧G moving would move this caption with it. These three
 * buttons are the only place in the app where the drawer tabs are named without their shortcut
 * being nearby, and they do exactly what ⌘⇧F/G/M do: `setDrawer({ tab })` on the drawer that is
 * already open.
 */
const TABS: { id: DrawerTab; label: string; title: string }[] = [
  { id: 'files', label: 'Files', title: withShortcut('Files', { kind: 'drawer-tab', tab: 'files' }) },
  { id: 'diff', label: 'Diff', title: withShortcut('Diff', { kind: 'drawer-tab', tab: 'diff' }) },
  { id: 'notes', label: 'Notes', title: withShortcut('Notes', { kind: 'drawer-tab', tab: 'notes' }) },
];

/**
 * The same bounds `normalizeLayout` clamps a loaded layout to AND `LayoutInputSchema` enforces on
 * `layout:set`. The upper one is not decoration: the store pushes every layout change to main, and
 * a width past 4000 is rejected there — the drag would keep working on screen and then die as an
 * error toast, with the width silently un-persisted. `Drawer.test.tsx` parses a dragged-out layout
 * through the real schema so the two cannot drift.
 */
export const DRAWER_MIN_WIDTH = 420;
export const DRAWER_MAX_WIDTH = 4000;

export function Drawer() {
  // `s.layout` is the stored object itself — stable by identity, so this cannot loop React (G59).
  // Deriving anything here (`s.layout.panes.map(...)`, `{ open, tab }`) allocates per call and is
  // the infinite-render bug, not a wasted allocation.
  const layout = useLayout((s) => s.layout);
  const setDrawer = useLayout((s) => s.setDrawer);
  const agent = useAgent(focusedAgent(layout));
  const [workspaceId, setWorkspaceId] = useState<Id | null>(null);
  if (!layout.drawerOpen) return null;
  // Falls back to the primary workspace, which also covers a selection made for a different agent:
  // ids are unique per workspace, so a stale one simply fails to match.
  const activeWorkspace = agent?.workspaces.find((w) => w.id === workspaceId) ?? agent?.workspaces[0] ?? null;
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-bg-1" style={{ width: layout.drawerWidth }}>
      {/* Dragging LEFT widens the drawer, hence the minus. `onResize` reports one INCREMENTAL
          delta per mousemove, so the width it is added to must be this render's — `Resizer` reads
          its callbacks through a ref for exactly that reason, and `Drawer.test.tsx` drags three
          steps to prove the whole 300 px arrives. The store debounces its `layout:set` push by
          100 ms, so a drag is one write rather than one per mousemove — `onDone` has nothing left
          to do, the same as the sidebar's. */}
      <Resizer
        side="left"
        onResize={(d) => setDrawer({ width: Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, layout.drawerWidth - d)) })}
        onDone={() => undefined}
      />
      <div className="drag-region flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.title}
            className={`no-drag rounded px-2.5 py-1 text-[12px] ${layout.drawerTab === t.id ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg'}`}
            onClick={() => setDrawer({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto truncate pl-2 text-[11px] text-muted">{agent?.name ?? 'No agent focused'}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {agent === undefined || activeWorkspace === null ? (
          <div className="flex h-full items-center justify-center text-center text-[12px] text-muted">Focus a pane with an agent to use the drawer.</div>
        ) : (
          <>
            <WorkspaceSwitcher agent={agent} value={activeWorkspace.id} onChange={setWorkspaceId} />
            {layout.drawerTab === 'notes' ? (
              // `key`: switching panes must give the new agent a FRESH NotesTab, not one whose
              // debounce timer and "last saved" ref still belong to the previous agent. See the
              // header comment in NotesTab.tsx.
              <NotesTab key={agent.id} agent={agent} />
            ) : layout.drawerTab === 'files' ? (
              // No `key` here: `FilesTab` keys the TREE itself, so switching agents keeps the
              // column split the user dragged while still throwing away the previous worktree's
              // expansion state. See FilesTab.tsx.
              <FilesTab agent={agent} workspace={activeWorkspace} />
            ) : (
              // No `key` here either: `DiffTab`'s own effects are keyed on the agent and workspace
              // ids, and remounting would throw away the column split the user dragged. The one
              // piece of per-agent state that must not leak across a switch — the "last hook seen"
              // marker that drives auto-refresh — carries its agent id with it.
              <DiffTab agent={agent} workspace={activeWorkspace} />
            )}
          </>
        )}
      </div>
    </aside>
  );
}
