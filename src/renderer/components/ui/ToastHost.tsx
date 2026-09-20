import { X } from 'lucide-react';
import { useUi } from '../../stores/ui.ts';
import { IconButton } from './Button.tsx';

const COLORS = { info: 'border-line', warn: 'border-amber', error: 'border-red' } as const;

export function ToastHost() {
  // Both selectors return the STORED reference, never a fresh array. zustand 5 hands the selector
  // straight to `useSyncExternalStore`, which re-runs it after every commit and commits again when
  // the identity differs; Task 2 measured a fresh-object selector at 55 renders before React threw
  // "Maximum update depth exceeded". A `.filter(...)` or `.map(...)` here would be that same loop.
  // Auto-dismiss belongs to the store's `toast()` action (6 s unless `sticky`), so there is
  // deliberately no timer in this component.
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-8 z-40 flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto rounded-md border-l-4 bg-bg-2 p-3 shadow-xl ${COLORS[t.level]}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold">{t.title}</div>
              {t.detail ? <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-fg-2 select-text">{t.detail}</pre> : null}
            </div>
            <IconButton title="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={12} />
            </IconButton>
          </div>
        </div>
      ))}
    </div>
  );
}
