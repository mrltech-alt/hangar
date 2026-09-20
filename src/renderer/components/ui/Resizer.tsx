import { useRef } from 'react';

export function Resizer({ side, onResize, onDone }: { side: 'right' | 'left'; onResize: (deltaPx: number) => void; onDone: () => void }) {
  const start = useRef<number | null>(null);
  // The callbacks are read through refs because `move` and `up` below are created ONCE per drag,
  // inside the mousedown handler, and would otherwise close over the props from the render that
  // was current when the drag began. `onResize` reports INCREMENTAL deltas, so its caller adds
  // each one to the width it is holding — a width frozen at mousedown, which makes every step
  // recompute from the same base. Measured through the drawer: a 300 px drag in three steps moved
  // `drawerWidth` from 560 to 660 instead of 860, i.e. the panel snapped once and then refused to
  // follow the pointer. The sidebar's call site has the identical shape.
  const latest = useRef({ onResize, onDone });
  latest.current = { onResize, onDone };
  return (
    // `0.75` is not on Tailwind 3's spacing scale, so `-right-0.75` would have been dropped there
    // and the handle would sit flush against the edge with half the hit area. Tailwind 4 computes
    // spacing, and the built CSS confirms it: `.-right-0\.75 { right: calc(var(--spacing) * -.75) }`
    // is emitted. Measured in headless Chromium against `out/renderer/assets/*.css` — theme.css puts
    // `font-size: 13px` on html, so `--spacing: .25rem` is 3.25px — the handle resolves to
    // `right: -2.4375px; width: 4.875px`, i.e. it straddles the edge with ~2.44px either side.
    <div
      className={`absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 ${side === 'right' ? '-right-0.75' : '-left-0.75'}`}
      onMouseDown={(e) => {
        start.current = e.clientX;
        const move = (ev: MouseEvent) => {
          if (start.current === null) return;
          latest.current.onResize(ev.clientX - start.current);
          start.current = ev.clientX;
        };
        const up = () => {
          start.current = null;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          latest.current.onDone();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
      }}
    />
  );
}
