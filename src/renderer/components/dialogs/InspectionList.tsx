import type { DeleteInspection } from '../../../../shared/ipc-contract.ts';

/**
 * One line per workspace: branch, worktree path, and the two counts the typed-name gate arms on — or
 * why a count is unknown. Shared by the Delete and Remove project dialogs (spec 2026-09-15 §11.1: "the
 * same per-workspace line the Delete dialog shows"), so the two cannot come to disagree about what is
 * at risk. Moved verbatim out of `DeleteAgentDialog.tsx`.
 */
export function InspectionList({ workspaces }: { workspaces: DeleteInspection['workspaces'] }) {
  return (
    <ul className="mb-3 space-y-2">
      {workspaces.map((w) => (
        <li key={w.workspaceId} className="rounded-md border border-line p-2 font-mono text-[11px]">
          <div className="text-fg">{w.branch}</div>
          <div className="truncate text-muted">{w.worktreePath}</div>
          <div className="mt-1 flex gap-3">
            <span className={w.inspectionFailed || w.worktreeMissing || w.dirtyFiles > 0 ? 'text-amber' : 'text-fg-2'}>
              {w.inspectionFailed ? 'could not be inspected' : w.worktreeMissing ? 'directory missing' : `${w.dirtyFiles} uncommitted change(s)`}
            </span>
            <span className={w.inspectionFailed || w.unmergedCommits > 0 ? 'text-amber' : 'text-fg-2'}>
              {w.inspectionFailed ? 'unmerged commits unknown' : `${w.unmergedCommits} unmerged commit(s)`}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
