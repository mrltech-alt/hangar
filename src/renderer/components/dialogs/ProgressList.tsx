import type { ProgressEvent } from '../../../../shared/ipc-contract.ts';
import { PROGRESS_GLYPH } from './logic.ts';

/**
 * Spec §12.6's live step list — "spinner / ✓ / ⚠ / ✗", with each step's captured log behind a
 * disclosure. Shared by the two dialogs that provision a worktree (New agent, Add project), which
 * watch the same `agent:progress` stream and must read identically while it runs.
 *
 * The `data-step` / `data-status` attributes are not decoration: they are how the dialog tests
 * assert on a step's outcome without matching the glyph or the class, both of which are styling.
 */
const STATUS_CLASS: Record<ProgressEvent['status'], string> = {
  running: 'text-fg',
  done: 'text-fg-2',
  warn: 'text-amber',
  error: 'text-red',
};

export function ProgressList({ items }: { items: readonly ProgressEvent[] }) {
  return (
    <ul className="space-y-1 font-mono text-[11.5px]">
      {items.map((p) => (
        <li key={`${p.opId}-${p.step}`} className={STATUS_CLASS[p.status]} data-step={p.step} data-status={p.status}>
          <span className="inline-block w-4">{PROGRESS_GLYPH[p.status]}</span>
          <span className="font-semibold">{p.step}</span> — {p.message}
          {p.log ? (
            <details className="ml-4">
              <summary className="cursor-pointer text-muted">log</summary>
              <pre className="max-h-40 overflow-auto text-muted select-text whitespace-pre-wrap">{p.log}</pre>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
