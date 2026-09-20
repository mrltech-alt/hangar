import type { ChangeSet } from '../../../../shared/ipc-contract.ts';

export type ChangeFile = ChangeSet['files'][number];

/**
 * The status letter's colour, in §6.5's status quartet rather than a palette of its own.
 *
 * `A` and `U` share green on purpose: both mean "this file is new", and the only difference is
 * whether git has been told about it yet — a distinction the letter already carries and the colour
 * does not need to repeat. `R` is amber because a rename is the one row whose diff is currently
 * approximate (see `DiffView`'s rename banner), so it reads as "look closer".
 */
const COLOR: Record<ChangeFile['status'], string> = {
  A: 'text-green',
  M: 'text-blue',
  D: 'text-red',
  R: 'text-amber',
  U: 'text-green',
};

/**
 * Spec §12.5's two groups: *Uncommitted* (staged/unstaged/untracked) then *Committed since base*.
 *
 * A file that is BOTH — committed since the base and then edited again in the working tree — is
 * listed once, under Uncommitted, because that is the version the diff shows: `git:fileDiff`
 * compares the merge base against the **working tree**, so a second row under "Committed since
 * base" would open the identical diff under a heading that misdescribes it.
 *
 * Exported and pure so the grouping rule can be tested without a React root; `DiffTab` renders
 * whatever this returns, in this order, and adds nothing.
 */
export function groupChanges(files: ChangeSet['files']): { title: string; files: ChangeSet['files'] }[] {
  return [
    { title: 'Uncommitted', files: files.filter((f) => f.uncommitted) },
    { title: 'Committed since base', files: files.filter((f) => f.committed && !f.uncommitted) },
  ].filter((g) => g.files.length > 0);
}

/**
 * The change list. Every row is a `role="option"` button, so a test can find the rows without
 * matching on class names and a screen reader gets a single-select list rather than a pile of
 * buttons.
 */
export function DiffList({ set, selected, onSelect }: { set: ChangeSet; selected: string | null; onSelect: (relPath: string) => void }) {
  const groups = groupChanges(set.files);
  return (
    <div className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label="Changed files">
      {set.files.length === 0 ? <div className="p-3 text-[12px] text-muted">No changes vs the base branch.</div> : null}
      {groups.map((g) => (
        <div key={g.title}>
          <div className="px-2 py-1 text-[10.5px] font-semibold tracking-wider text-muted">
            {g.title.toUpperCase()} · {g.files.length}
          </div>
          {g.files.map((f) => (
            <button
              key={f.relPath}
              type="button"
              role="option"
              aria-selected={selected === f.relPath}
              className={`flex w-full items-center gap-2 px-2 py-[3px] text-left font-mono text-[11.5px] hover:bg-bg-2 ${selected === f.relPath ? 'bg-bg-3 text-fg' : 'text-fg-2'}`}
              onClick={() => onSelect(f.relPath)}
              // The `R` row's tooltip says what its diff will actually show. `git diff -M` emits a
              // single `R100` record and `diff-service.ts` keeps only the NEW path (P4-2h/P4-3e), so
              // the base side has no file there and the diff reads as an addition. `DiffView`
              // banners the same fact once the row is open; this is so the row is not misleading
              // before it is clicked.
              title={f.status === 'R' ? `${f.relPath} — renamed; the diff shows the new path as an addition` : f.relPath}
            >
              <span className={`w-3 shrink-0 font-bold ${COLOR[f.status]}`}>{f.status}</span>
              <span className="truncate">{f.relPath}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
