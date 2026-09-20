import { ChevronDown, ChevronRight, File, Folder, Link2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FsEntry } from '../../../../shared/ipc-contract.ts';
import { runResult } from '../../lib/api.ts';
import { IconButton } from '../ui/Button.tsx';

/**
 * The lazy worktree tree of spec §12.5: one `fs:list` per directory, on expand.
 *
 * Everything main already decided is left alone here. `listDir` hides `.git`, marks `ignored` with
 * the real `git check-ignore`, and sorts dirs-first / ignored-last / case-insensitive; re-sorting or
 * re-filtering in the renderer would only create a second opinion that can disagree with the first.
 * This component's job is expansion state, one fetch per directory, and the click targets.
 *
 * It takes no zustand selector at all — everything arrives as props from `FilesTab`, which reads
 * the agent and workspace the drawer already resolved. That is why G59/G61 cannot bite HERE, and
 * `FilesTab.test.tsx` still counts commits on a real root (with an allocating control beside it),
 * because "no selector today" is a fact about this revision, not a property the file enforces.
 */
export function FileTree({
  agentId,
  workspaceId,
  selected,
  onSelect,
}: {
  agentId: string;
  workspaceId: string;
  selected: string | null;
  onSelect: (relPath: string) => void;
}) {
  const [dirs, setDirs] = useState<Map<string, FsEntry[]>>(() => new Map());
  const [failed, setFailed] = useState<Map<string, string>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  // Which directories have a request in the air. A ref, not state: nothing renders from it, and it
  // must survive React 19 StrictMode's mount → unmount → mount without a second `fs:list` for the
  // root (the instance is the same, so the ref is too, while the effect runs twice).
  const inFlight = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (relPath: string): Promise<void> => {
      if (inFlight.current.has(relPath)) return;
      inFlight.current.add(relPath);
      try {
        // The third argument suppresses the error TOAST. A worktree mutates under the drawer
        // constantly — the agent deletes the directory the user has open — and `Refresh` re-lists
        // every expanded directory at once, so the default sink would fire a burst of toasts for a
        // condition the tree can state in place. The row says it instead, and stays clickable to
        // retry.
        const r = await runResult('fs:list', { agentId, workspaceId, relPath }, () => undefined);
        if (r.ok) {
          setDirs((m) => new Map(m).set(relPath, r.value));
          setFailed((m) => {
            if (!m.has(relPath)) return m;
            const next = new Map(m);
            next.delete(relPath);
            return next;
          });
        } else {
          setFailed((m) => new Map(m).set(relPath, r.error.message));
        }
      } finally {
        inFlight.current.delete(relPath);
      }
    },
    [agentId, workspaceId],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  /**
   * Expand or collapse, and fetch on the first expand only.
   *
   * The fetch is deliberately OUTSIDE the `setExpanded` updater. React may call an updater twice
   * for one event — StrictMode does it on purpose, measured here as 2 invocations for one click —
   * and an updater that also fires IPC therefore sends the request twice.
   *
   * On its own this placement is not observable, because `load`'s in-flight set already dedupes the
   * doubled call; the two guards mask each other, and `FilesTab.test.tsx`'s StrictMode test fails
   * only when both are removed. It stays because "updaters are pure" is the rule React actually
   * enforces, and the in-flight set is a cache, not a promise about correctness.
   */
  const toggle = (relPath: string): void => {
    const open = expanded.has(relPath);
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
    if (!open && !dirs.has(relPath)) void load(relPath);
  };

  /** Spec §12.5: "re-lists the expanded directories" — including the root, which is always in the set. */
  const refresh = (): void => {
    for (const dir of expanded) void load(dir);
  };

  const row = (depth: number, key: string, content: ReactNode): ReactNode => (
    <div key={key} role="none" className="py-1 text-[11px] text-muted" style={{ paddingLeft: 8 + depth * 12 }}>
      {content}
    </div>
  );

  const render = (dir: string, depth: number): ReactNode => {
    const entries = dirs.get(dir);
    if (entries === undefined) {
      const error = failed.get(dir);
      if (error !== undefined) {
        return row(
          depth,
          `${dir}!`,
          <button type="button" className="text-left text-red hover:underline" onClick={() => void load(dir)} title={error}>
            couldn&rsquo;t read this folder — retry
          </button>,
        );
      }
      return row(depth, `${dir}?`, 'loading…');
    }
    if (entries.length === 0) return row(depth, `${dir}~`, 'empty');
    return entries.map((e) => {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      const isDir = e.kind === 'dir';
      const open = expanded.has(rel);
      const Icon = isDir ? Folder : e.kind === 'symlink' ? Link2 : File;
      return (
        // `role="none"` on the wrapper so the `treeitem`s below still read as children of the
        // `tree`/`group` above them: this div exists only to keep a row and its subtree together.
        <div key={rel} role="none">
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected === rel}
            aria-expanded={isDir ? open : undefined}
            // `ignored` is main's `git check-ignore` answer, so `node_modules` dims itself without
            // this file knowing the name (spec §12.5).
            className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12px] hover:bg-bg-2 ${selected === rel ? 'bg-bg-3 text-fg' : e.ignored ? 'text-muted' : 'text-fg-2'}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            // A symlink is a leaf that is deliberately NOT followed (spec §14): main lists it and
            // refuses to read through it, so clicking one must do nothing rather than raise EACCES.
            onClick={() => (isDir ? toggle(rel) : e.kind === 'file' ? onSelect(rel) : undefined)}
            title={e.kind === 'symlink' ? `${rel} — symlink (not followed)` : rel}
          >
            {isDir ? (
              open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <Icon size={12} className="shrink-0" />
            <span className="truncate">{e.name}</span>
          </button>
          {isDir && open ? (
            <div role="group" aria-label={e.name}>
              {render(rel, depth + 1)}
            </div>
          ) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between px-1 text-[11px] font-medium text-muted">
        FILES
        <IconButton title="Refresh" onClick={refresh}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      <div role="tree" aria-label="Worktree files" className="min-h-0 flex-1 overflow-auto">
        {render('', 0)}
      </div>
    </div>
  );
}
