import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FsFile } from '../../../../shared/ipc-contract.ts';
import { copyText, openExternal } from '../../lib/agent-actions.ts';
import { runResult } from '../../lib/api.ts';
import { createViewer } from '../../lib/codemirror.ts';
import { IconButton } from '../ui/Button.tsx';

/** KB below a megabyte, MB above it. `(12_582_912 / 1024).toFixed(1)` is "12288.0 KB", which is a
 *  number nobody reads — and the oversize-image case below is always in that range. */
export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file, read through `fs:read` and shown according to what main decided it is (spec §12.5).
 *
 * `FsFile`'s four shapes and the ONE that is not obvious:
 *   - text                     → `binary:false`, CodeMirror
 *   - text over 1.5 MB         → `binary:false, truncated:true`, CodeMirror + the banner
 *   - binary, or an image ≤10MB → `binary:true` (with `image` set for the image)
 *   - an image OVER 10 MB      → `binary:true, truncated:true, image:null`
 * The last one is why the banner is gated on `!binary`: `readFileForViewer` reuses `truncated` to
 * mean "there is more here than we are willing to send", so an 12 MB PNG would otherwise be
 * announced as "the first 1.5 MB of this file" — a number that never existed. `binary && truncated
 * && image === null` is unique to that case, so it gets its own line and needs no second copy of
 * main's image-extension list to recognise itself.
 */
export function FileViewer({
  agentId,
  workspaceId,
  worktreePath,
  relPath,
}: {
  agentId: string;
  workspaceId: string;
  worktreePath: string;
  relPath: string;
}) {
  const [file, setFile] = useState<FsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    // Inline, not a toast: the message belongs next to the file it is about, and clicking through a
    // tree of deleted files would otherwise stack toasts. Same reasoning as `FileTree`'s.
    void runResult('fs:read', { agentId, workspaceId, relPath }, () => undefined).then((r) => {
      if (cancelled) return;
      if (r.ok) setFile(r.value);
      else setError(r.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, workspaceId, relPath]);

  useEffect(() => {
    const el = host.current;
    if (el === null || file === null || file.binary) return;
    // `createViewer` awaits the language chunk, so the view arrives AFTER this effect returns and
    // possibly after its cleanup — hence the flag as well as the handle. Destroying only through
    // `view?.destroy()` would leak an editor into a detached div for every file clicked faster than
    // its grammar loads.
    let view: { destroy(): void } | null = null;
    let cancelled = false;
    void createViewer(el, file.content, relPath, file.language).then((v) => {
      if (cancelled) v.destroy();
      else view = v;
    });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [file, relPath]);

  const crumbs = relPath.split('/');
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 px-2 text-[11px] text-fg-2">
        <span className="min-w-0 flex-1 truncate" title={relPath}>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join('/')}>
              {i > 0 ? <span className="text-muted"> / </span> : null}
              {c}
            </span>
          ))}
        </span>
        {file !== null ? <span className="shrink-0 text-muted">{formatSize(file.size)}</span> : null}
        <IconButton title="Copy path" onClick={() => void copyText(`${worktreePath}/${relPath}`)}>
          <Copy size={12} />
        </IconButton>
        {/* The worktree, not the file: `app:openExternal` takes a workspace and nothing finer, so
            the title says worktree rather than implying VS Code opens on this file. */}
        <IconButton title="Open worktree in VS Code" onClick={() => void openExternal(agentId, workspaceId, 'vscode')}>
          <ExternalLink size={12} />
        </IconButton>
      </div>
      {file !== null && file.truncated && !file.binary ? (
        <div className="shrink-0 bg-amber/15 px-2 py-1 text-[11px] text-amber">Showing the first 1.5 MB of this file.</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error !== null ? (
          <div className="p-3 text-[12px] text-red">{error}</div>
        ) : file === null ? (
          <div className="p-3 text-[12px] text-muted">loading…</div>
        ) : file.image !== null ? (
          <div className="flex h-full items-center justify-center overflow-auto p-3">
            {/* `img-src 'self' data:` is already in `shared/csp.ts`, so the data URL main builds
                renders without a policy change. */}
            <img src={file.image} alt={relPath} className="max-h-full max-w-full" />
          </div>
        ) : file.binary ? (
          <div className="p-3 text-[12px] text-muted">
            {file.truncated ? `Too large to preview (${formatSize(file.size)}).` : `Binary file (${formatSize(file.size)})`}
          </div>
        ) : (
          <div ref={host} className="h-full" />
        )}
      </div>
    </div>
  );
}
