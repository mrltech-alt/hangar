import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MenuItem } from '../../stores/ui.ts';
import { useUi } from '../../stores/ui.ts';
import { clampMenuPosition } from './menu-position.ts';

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <ul className="min-w-[180px] rounded-md border border-line bg-bg-2 py-1 text-[12px] shadow-xl">
      {items.map((item, i) =>
        item.separator ? (
          <li key={i} className="my-1 border-t border-line" />
        ) : (
          // A disabled entry opens no submenu: "Remove project from this agent" on a one-project agent
          // carries `children: []`, and hovering it drew an empty box beside the greyed-out row.
          <li key={i} className="relative" onMouseEnter={() => setOpenSub(item.children && !item.disabled ? i : null)}>
            <button
              type="button"
              disabled={item.disabled}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-bg-3 disabled:opacity-40 ${item.danger ? 'text-red' : 'text-fg'}`}
              onClick={() => {
                if (item.children) return;
                item.onSelect?.();
                onDone();
              }}
            >
              <span>{item.label}</span>
              {item.children ? <ChevronRight size={12} className="text-muted" /> : null}
            </button>
            {item.children && openSub === i ? (
              <div className="absolute top-0 left-full pl-1">
                <MenuList items={item.children} onDone={onDone} />
              </div>
            ) : null}
          </li>
        ),
      )}
    </ul>
  );
}

/** Renders the store's context menu, clamped to the viewport; closes on outside click, Escape or blur. */
export function ContextMenuHost() {
  // Both selectors read a STORED reference. zustand 5 passes the selector to `useSyncExternalStore`,
  // which re-runs it after each commit and commits again whenever the identity differs; Task 2
  // measured a selector that built a fresh object per call at 55 renders before React threw
  // "Maximum update depth exceeded". Deriving anything here (`s.contextMenu?.items.filter(...)`)
  // would be that loop, so the derivation happens below, after the subscription.
  const menu = useUi((s) => s.contextMenu);
  const hide = useUi((s) => s.hideContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, [menu, hide]);
  if (!menu) return null;
  // The arithmetic lives in `menu-position.ts` with its measurements written down; separators are
  // counted apart from button rows because they are 7.5px tall, not 27.75px.
  const separatorCount = menu.items.filter((i) => i.separator).length;
  const { left, top } = clampMenuPosition({
    x: menu.x,
    y: menu.y,
    itemCount: menu.items.length - separatorCount,
    separatorCount,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  return (
    <div ref={ref} className="fixed z-50" style={{ left, top }}>
      <MenuList items={menu.items} onDone={hide} />
    </div>
  );
}
