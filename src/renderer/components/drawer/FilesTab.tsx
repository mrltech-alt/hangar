import { useEffect, useState } from 'react';
import type { Agent, Workspace } from '../../../../shared/types.ts';
import { Resizer } from '../ui/Resizer.tsx';
import { FileTree } from './FileTree.tsx';
import { FileViewer } from './FileViewer.tsx';

/** Spec §12.5 starts the tree at 220 px. The bounds keep both columns usable at the drawer's own
 *  420 px minimum: 480 + a viewer would not fit, and below 140 the tree shows indentation only. */
export const TREE_DEFAULT_WIDTH = 220;
export const TREE_MIN_WIDTH = 140;
export const TREE_MAX_WIDTH = 480;

/**
 * Spec §12.5's two columns: the lazy tree and the viewer.
 *
 * The `key` on `FileTree` is load-bearing. Its expansion set and per-directory cache describe ONE
 * worktree; switching the workspace switcher (or the focused pane) while it stayed mounted would
 * leave the previous worktree's directories expanded and its listings on screen until each one
 * happened to be re-fetched. Remounting throws all of that away in one move, which is both simpler
 * and cheaper than an effect that resets three pieces of state. `FilesTab.test.tsx` switches
 * workspaces and asserts the tree re-lists from the root.
 *
 * The tree width is deliberately NOT persisted: §12.5 persists the DRAWER width and says nothing
 * about this split, and `layout:set` has no field for it. Local state, reset with the drawer.
 */
export function FilesTab({ agent, workspace }: { agent: Agent; workspace: Workspace }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH);
  // The file the user was reading does not exist in the workspace they just switched to (and if the
  // path happens to exist there, it is a different file). Clearing is the honest answer.
  useEffect(() => setSelected(null), [agent.id, workspace.id]);
  return (
    <div className="flex h-full min-h-0">
      <div className="relative shrink-0 border-r border-line" style={{ width: treeWidth }}>
        <FileTree
          key={`${agent.id}:${workspace.id}`}
          agentId={agent.id}
          workspaceId={workspace.id}
          selected={selected}
          onSelect={setSelected}
        />
        {/* `onResize` reports one INCREMENTAL delta per mousemove, so each is added to the width
            this render holds — the shape `Resizer`'s own comment records after a 300 px drag moved
            the drawer 100 px. `onDone` has nothing to do: nothing here is persisted. */}
        <Resizer
          side="right"
          onResize={(d) => setTreeWidth((w) => Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, w + d)))}
          onDone={() => undefined}
        />
      </div>
      <div className="min-w-0 flex-1">
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-[12px] text-muted">Select a file</div>
        ) : (
          <FileViewer agentId={agent.id} workspaceId={workspace.id} worktreePath={workspace.worktreePath} relPath={selected} />
        )}
      </div>
    </div>
  );
}
