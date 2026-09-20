import type { Arrangement } from '../../../../shared/types.ts';
import { useLayout } from '../../stores/layout.ts';
import { Pane } from './Pane.tsx';

/** The CSS grid shape per arrangement (§12.3). `triple` and `grid` share a 2x2; `paneSpanClass` separates them. */
export const GRID: Record<Arrangement, string> = {
  single: 'grid-cols-1 grid-rows-1',
  'split-h': 'grid-cols-2 grid-rows-1',
  'split-v': 'grid-cols-1 grid-rows-2',
  triple: 'grid-cols-2 grid-rows-2',
  grid: 'grid-cols-2 grid-rows-2',
};

/**
 * The span a pane needs to fill a 2x2 grid that holds only three panes.
 *
 * **This is where the plan and the spec disagreed, and the spec wins.** Plan 03 Task 5 wrote
 * `arrangement === 'triple' && i === 0 ? 'row-span-2'` — pane 0 as a full-height left column with
 * 1 and 2 stacked beside it. Spec §12.3 draws the opposite:
 *
 *     3 (triple): [A][B]
 *                 [ C  ]
 *
 * A and B share the top row and C spans the bottom. `row-span-2` on pane 0 also puts the *third*
 * pane top-right and the *second* bottom-right, so the reading order the layout reducer maintains
 * (`openInNewPane` appends, `closePane` shifts, ⌘1…⌘4 index by position) would not match what the
 * user sees. Tested in `PaneGrid.test.tsx` against every (arrangement, index) pair.
 *
 * Laid out in Electron 44's own Blink over the real emitted CSS, three panes in a 1000x400 box —
 * the spec's diagram, to the pixel (the 1px offsets are `gap-px`):
 *
 *     pane 1  x=0    y=0      499.5 x 199.5
 *     pane 2  x=500.5 y=0     499.5 x 199.5
 *     pane 3  x=0    y=200.5  1000  x 199.5
 */
export function paneSpanClass(arrangement: Arrangement, index: number): string {
  return arrangement === 'triple' && index === 2 ? 'col-span-2' : '';
}

export function PaneGrid() {
  // `s.layout` is the STORED reference, so this selector is referentially stable across the commits
  // `useSyncExternalStore` triggers (G59). `s.layout.panes.map(...)` — the obvious way to write this
  // — allocates a fresh array per call and is an infinite render loop; the `.map` below runs after
  // the subscription, in the render body, where allocating is free. Measured at 55 renders then
  // "Maximum update depth exceeded" twice on this project; `PaneGrid.test.tsx` counts commits.
  const layout = useLayout((s) => s.layout);
  return (
    <div className={`grid min-h-0 flex-1 gap-px bg-line ${GRID[layout.arrangement]}`}>
      {layout.panes.map((agentId, i) => (
        // Keyed by index, deliberately. A pane is a SLOT, not an agent: `swapPanes` exchanges two
        // agents between slots and `closePane` shifts the rest down, and keying by agent id would
        // make React move the DOM subtree — which in Task 6 means tearing down and re-attaching a
        // live xterm and its PTY subscription for what is a purely visual reshuffle.
        <div key={i} className={`min-h-0 min-w-0 ${paneSpanClass(layout.arrangement, i)}`}>
          <Pane index={i} agentId={agentId} focused={layout.focusedIndex === i} />
        </div>
      ))}
    </div>
  );
}
