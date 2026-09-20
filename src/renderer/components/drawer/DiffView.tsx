import { useEffect, useRef, useState } from 'react';
import type { FileDiff } from '../../../../shared/ipc-contract.ts';
import { runResult } from '../../lib/api.ts';
import { createUnifiedDiff } from '../../lib/codemirror.ts';
import type { ChangeFile } from './DiffList.tsx';

/**
 * Are these two answers the same file, byte for byte and flag for flag?
 *
 * The Diff tab re-reads every 30 s (spec §12.5) and the open file is usually unchanged. Replacing
 * the state object anyway would destroy and rebuild the CodeMirror view on that timer, throwing
 * away the user's scroll position, selection and any open search panel twice a minute — while they
 * are reading. Keeping the previous object when nothing moved keeps the editor alive, because the
 * mounting effect below is keyed on the object's identity.
 */
export function sameDiff(a: FileDiff, b: FileDiff): boolean {
  return (
    a.oldText === b.oldText &&
    a.newText === b.newText &&
    a.oldMissing === b.oldMissing &&
    a.newMissing === b.newMissing &&
    a.binary === b.binary &&
    a.tooLarge === b.tooLarge
  );
}

/**
 * The one-word state in the header.
 *
 * `FileDiff`'s four flags are deliberately distinguishable in `diff-service.ts` and must stay that
 * way here — an empty side means something different in each case:
 *   - `oldMissing`            → added since the base
 *   - `newMissing`            → deleted from the working tree
 *   - both                    → committed as new and then deleted again; nothing to show either side
 *   - `binary`                → both texts blank because there is no text
 *   - `tooLarge`              → both texts blank because showing them would LIE (see `diffNotice`)
 *   - `oldText: ''`, no flags → the file really was empty at the base
 * Collapsing any of those into "empty" is the failure this label exists to prevent.
 *
 * `status` comes from the row the user clicked. Only `R` changes the wording: `git diff -M` reports
 * a rename as one record under the new path, so the diff is honestly an addition — but calling it
 * "added" would hide the rename the list just showed. See the banner in `DiffView`.
 */
export function diffLabel(d: FileDiff, status: ChangeFile['status']): string {
  const base = status === 'R' ? 'renamed' : d.oldMissing && d.newMissing ? 'gone' : d.oldMissing ? 'added' : d.newMissing ? 'deleted' : 'modified';
  if (d.binary) return `${base} · binary`;
  if (d.tooLarge) return `${base} · too large`;
  return base;
}

/**
 * The message that REPLACES the editor, or null to render the diff.
 *
 * `tooLarge` is the one that matters most and the one the plan did not have. `diff-service.ts`
 * blanks BOTH sides when either is over 1.5 MB, precisely because handing `unifiedMergeView` two
 * independently truncated texts renders a fabricated deletion of everything past the cut — a change
 * the agent never made, drawn in red, indistinguishable from a real one. With both sides blank and
 * no notice, the same file would instead render as an unchanged empty document, which is a quieter
 * lie but still a lie. Hence an explicit line saying which of the two it is.
 *
 * "gone from both sides" is the other blank-both case, and it is ordinary rather than exotic: a
 * file the agent committed and then deleted is in the change set (status `D`), absent at the merge
 * base, and absent from the working tree.
 */
export function diffNotice(d: FileDiff): string | null {
  if (d.binary) return 'Binary file — there is no text to diff.';
  if (d.tooLarge) return 'Too large to diff: one side is over 1.5 MB. Showing both sides truncated would draw a deletion at the cut that nobody made.';
  if (d.oldMissing && d.newMissing) return 'Not at the base branch and not in the working tree — added and then deleted again.';
  return null;
}

/**
 * One file's diff (spec §12.5): `@codemirror/merge`'s unified view, `newText` as the document with
 * `oldText` merged in as deletions.
 *
 * `refreshKey` is bumped by `DiffTab` on every successful `git:changes`, which is what makes the
 * open file re-read on the 30 s timer and on a `Stop` hook. It is a key rather than a payload
 * because the base commit is resolved in MAIN (`mergeBaseFor`), so there is nothing for the
 * renderer to pass through.
 */
export function DiffView({
  agentId,
  workspaceId,
  relPath,
  status,
  refreshKey,
}: {
  agentId: string;
  workspaceId: string;
  relPath: string;
  status: ChangeFile['status'];
  refreshKey: number;
}) {
  // Keyed by the file it describes, and read back through a render-time comparison rather than
  // cleared by an effect. The difference is one commit long and it matters: on a path change, an
  // effect that blanks the state runs AFTER the render that already has the new `relPath` — so the
  // previous file's text is handed to `createUnifiedDiff` under the new file's name, built, and
  // destroyed again on the next commit. Measured with a stubbed factory: three editors built for two
  // files, the middle one carrying `src/edited.ts`'s text under the name `README.md`. Deriving
  // instead means a stale pair is never rendered at all, and there is no second mechanism to keep in
  // step with the first.
  const [loaded, setLoaded] = useState<{ key: string; diff: FileDiff } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const key = `${agentId}\u0000${workspaceId}\u0000${relPath}`;
  const diff = loaded !== null && loaded.key === key ? loaded.diff : null;
  const error = failed !== null && failed.key === key ? failed.message : null;

  useEffect(() => {
    let cancelled = false;
    // Inline, not a toast: the message belongs next to the file it is about, and the 30 s timer
    // would otherwise stack a toast per tick for a file the agent has just deleted. Same reasoning
    // as `FileViewer`'s and `FileTree`'s.
    void runResult('git:fileDiff', { agentId, workspaceId, relPath }, () => undefined).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setFailed(null);
        setLoaded((cur) => (cur !== null && cur.key === key && sameDiff(cur.diff, r.value) ? cur : { key, diff: r.value }));
      } else {
        setFailed({ key, message: r.error.message });
      }
    });
    return () => {
      cancelled = true;
    };
    // `key` is exactly the other three joined; it is listed because the effect reads it, and the
    // three are listed because the effect reads them too. `refreshKey` is what makes the OPEN file
    // re-read on `DiffTab`'s 30 s timer.
  }, [agentId, workspaceId, relPath, key, refreshKey]);

  const notice = diff === null ? null : diffNotice(diff);

  useEffect(() => {
    const el = host.current;
    if (el === null || diff === null || diffNotice(diff) !== null) return;
    // `createUnifiedDiff` awaits the language chunk, so the view arrives AFTER this effect returns
    // and possibly after its cleanup — hence the flag as well as the handle. Destroying only
    // through `view?.destroy()` would leak an editor into a detached div for every file clicked
    // faster than its grammar loads.
    let view: { destroy(): void } | null = null;
    let cancelled = false;
    void createUnifiedDiff(el, diff.oldText, diff.newText, relPath).then((v) => {
      if (cancelled) v.destroy();
      else view = v;
    });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [diff, relPath]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2 font-mono text-[11px] text-fg-2">
        <span className="min-w-0 flex-1 truncate" title={relPath}>
          {relPath}
        </span>
        {diff !== null ? <span className="shrink-0 text-muted">{diffLabel(diff, status)}</span> : null}
      </div>
      {/* The rename banner. It sits ABOVE the diff rather than replacing it, because the diff is
          real — it is the new path against a base that has no file there. What it is not is a
          rename diff, and saying nothing would let the reader take a whole-file addition for the
          agent's actual work. Carrying the pre-rename path through needs `ChangeSet['files'][]
          .origPath` and an optional `git:fileDiff.origPath`, both strictly additive; deferred on
          purpose in P4-2h/P4-3e, not overlooked. */}
      {diff !== null && status === 'R' && diff.oldMissing && notice === null ? (
        <div className="shrink-0 bg-amber/15 px-2 py-1 text-[11px] text-amber">
          Renamed. The base branch has no file at this path, so the whole file reads as an addition; the pre-rename text is not carried through yet.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error !== null ? (
          <div className="p-3 text-[12px] text-red">{error}</div>
        ) : diff === null ? (
          <div className="p-3 text-[12px] text-muted">loading…</div>
        ) : notice !== null ? (
          <div className="p-3 text-[12px] text-muted">{notice}</div>
        ) : (
          <div ref={host} className="h-full" />
        )}
      </div>
    </div>
  );
}
