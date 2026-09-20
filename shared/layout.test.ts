import { describe, expect, it } from 'vitest';
import { defaultLayout, type Layout } from './types.ts';
import {
  MAX_PANES, PANEL_MAX, PANEL_MIN_H, PANEL_MIN_W, addEmptyPane, clampPanelRect, closePane, defaultArrangement,
  defaultShortcutsRect, focusPane, movePanelRect, normalizeLayout, openInFocused, openInNewPane,
  focusedAgent, paneOf, removeAgent, resizePanelRect, setArrangement, swapPanes, type Viewport,
} from './layout.ts';

const L = (panes: (string | null)[], focusedIndex = 0): Layout => normalizeLayout({ ...defaultLayout(), panes, focusedIndex });

describe('layout reducer', () => {
  it('openInFocused replaces the focused pane, or focuses an existing pane holding the agent', () => {
    expect(openInFocused(L([null]), 'a').panes).toEqual(['a']);
    const two = openInFocused(L(['a', 'b'], 1), 'a');
    expect(two.panes).toEqual(['a', 'b']);
    expect(two.focusedIndex).toBe(0);
  });

  it('openInNewPane appends and focuses, returns null when full', () => {
    const l = openInNewPane(L(['a']), 'b');
    expect(l?.panes).toEqual(['a', 'b']);
    expect(l?.focusedIndex).toBe(1);
    expect(l?.arrangement).toBe('split-h');
    expect(openInNewPane(L(['a', 'b', 'c', 'd']), 'e')).toBeNull();
    const dup = openInNewPane(L(['a', 'b']), 'a');
    expect(dup?.panes).toEqual(['a', 'b']);
    expect(dup?.focusedIndex).toBe(0);
  });

  it('addEmptyPane respects the cap', () => {
    expect(addEmptyPane(L(['a']))?.panes).toEqual(['a', null]);
    expect(addEmptyPane(L(['a', 'b', 'c', 'd']))).toBeNull();
  });

  it('closePane never drops below one pane and moves focus to the nearest', () => {
    expect(closePane(L(['a']), 0).panes).toEqual([null]);
    const l = closePane(L(['a', 'b', 'c'], 2), 2);
    expect(l.panes).toEqual(['a', 'b']);
    expect(l.focusedIndex).toBe(1);
    expect(l.arrangement).toBe('split-h');
    const m = closePane(L(['a', 'b', 'c'], 0), 0);
    expect(m.panes).toEqual(['b', 'c']);
    expect(m.focusedIndex).toBe(0);
  });

  it('focus, swap, setArrangement', () => {
    expect(focusPane(L(['a', 'b']), 1).focusedIndex).toBe(1);
    expect(focusPane(L(['a', 'b']), 7).focusedIndex).toBe(0);
    const s = swapPanes(L(['a', 'b'], 0), 0, 1);
    expect(s.panes).toEqual(['b', 'a']);
    expect(s.focusedIndex).toBe(1);
    expect(setArrangement(L(['a', 'b']), 'split-v').arrangement).toBe('split-v');
    expect(setArrangement(L(['a', 'b', 'c']), 'split-v').arrangement).toBe('triple');
  });

  // The second argument is the remembered `splitOrientation`, not the current arrangement — the
  // arrangement is derived, so a preference stored there is lost whenever the pane count changes.
  it('defaultArrangement by count, honouring the remembered split orientation for two', () => {
    expect(defaultArrangement(1, 'split-v')).toBe('single');
    expect(defaultArrangement(2, 'split-v')).toBe('split-v');
    expect(defaultArrangement(2, 'split-h')).toBe('split-h');
    expect(defaultArrangement(3, 'split-v')).toBe('triple');
    expect(defaultArrangement(4, 'split-v')).toBe('grid');
  });

  // The sequence that used to lose the user's choice: two panes vertical, close one, open another.
  it('remembers the vertical choice across leaving and re-entering the two-pane case', () => {
    let l = openInNewPane(openInFocused(defaultLayout(), 'a'), 'b') as Layout;
    expect(l.arrangement).toBe('split-h');
    l = setArrangement(l, 'split-v');
    expect(l).toMatchObject({ arrangement: 'split-v', splitOrientation: 'split-v' });

    l = openInNewPane(l, 'c') as Layout;
    expect(l.arrangement).toBe('triple');
    l = closePane(l, 2);
    expect(l.arrangement, 'back to two panes — the choice must survive').toBe('split-v');

    l = closePane(l, 1);
    expect(l.arrangement).toBe('single');
    l = openInNewPane(l, 'd') as Layout;
    expect(l.arrangement, 'and survive a trip through one pane').toBe('split-v');
    // It also survives a reload, because normalizeLayout recomputes from splitOrientation.
    expect(normalizeLayout(l).arrangement).toBe('split-v');
  });

  // The ternary in closePane's focus arithmetic could be inverted or deleted and every other test
  // would still pass — yet this is what stops focus jumping to a different agent on every close.
  it('keeps focus on the same agent when an earlier pane closes', () => {
    const l = closePane(L(['a', 'b', 'c', 'd'], 3), 1);
    expect(l.panes).toEqual(['a', 'c', 'd']);
    expect(l.panes[l.focusedIndex], 'still focused on d').toBe('d');
    expect(focusedAgent(l)).toBe('d');
  });

  // The ⌘⇧D-then-click-an-agent path: fill the empty slot rather than appending a fifth pane.
  it('openInNewPane fills an existing empty slot before appending', () => {
    const l = openInNewPane(L(['a', null]), 'b') as Layout;
    expect(l.panes).toEqual(['a', 'b']);
    expect(l.focusedIndex).toBe(1);
  });

  // A bare `i < 0 || i >= n` guard lets NaN and fractions through: swapPanes(l, 0, 1.5) destroyed
  // an agent, and focusPane(l, NaN) made the pane unaddressable forever.
  it('rejects non-integer indices instead of corrupting the layout', () => {
    const l = L(['a', 'b']);
    expect(focusPane(l, Number.NaN)).toBe(l);
    expect(swapPanes(l, 0, 1.5)).toBe(l);
    expect(closePane(l, 1.5)).toBe(l);
  });

  it('removeAgent blanks the slot; paneOf finds it', () => {
    expect(paneOf(L(['a', 'b']), 'b')).toBe(1);
    expect(paneOf(L(['a']), 'zz')).toBeNull();
    expect(removeAgent(L(['a', 'b']), 'a').panes).toEqual([null, 'b']);
  });

  it('normalizeLayout repairs bad input', () => {
    const l = normalizeLayout({ ...defaultLayout(), panes: ['a', 'a', 'b', 'c', 'd', 'e'], focusedIndex: 99, arrangement: 'single' });
    expect(l.panes).toEqual(['a', null, 'b', 'c']);
    expect(l.panes.length).toBe(MAX_PANES);
    expect(l.focusedIndex).toBe(3);
    expect(l.arrangement).toBe('grid');
    expect(normalizeLayout({ ...defaultLayout(), panes: [] }).panes).toEqual([null]);
  });
  // normalizeLayout is the only thing between a slightly-wrong layout on disk and total data loss:
  // Task 6's persisted schema is deliberately lenient so this function owns the repair.
  it('repairs every malformed shape rather than letting it through', () => {
    const inv = (l: Layout): void => {
      expect(l.panes.length).toBeGreaterThanOrEqual(1);
      expect(l.panes.length).toBeLessThanOrEqual(MAX_PANES);
      const ids = l.panes.filter((p): p is string => p !== null);
      expect(new Set(ids).size, 'no duplicate agent (spec §6.2)').toBe(ids.length);
      expect(Number.isInteger(l.focusedIndex)).toBe(true);
      expect(l.focusedIndex).toBeGreaterThanOrEqual(0);
      expect(l.focusedIndex).toBeLessThan(l.panes.length);
      expect(l.sidebarWidth).toBeGreaterThanOrEqual(200);
      expect(l.sidebarWidth).toBeLessThanOrEqual(480);
      expect(l.drawerWidth).toBeGreaterThanOrEqual(420);
    };
    const base = defaultLayout();
    const cases: Layout[] = [
      { ...base, panes: [] },
      { ...base, panes: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...base, panes: ['a', 'a', 'a', 'a'] },
      { ...base, panes: [null, 'a', null, 'a'] },
      { ...base, panes: ['a', 'b'], focusedIndex: 99 },
      { ...base, panes: ['a', 'b'], focusedIndex: -5 },
      { ...base, panes: ['a', 'b'], focusedIndex: 1.7 },
      { ...base, panes: ['a', 'b'], focusedIndex: Number.NaN },
      { ...base, sidebarWidth: 0 },
      { ...base, sidebarWidth: 1e9 },
      { ...base, sidebarWidth: Number.NaN },
      { ...base, drawerWidth: Number.POSITIVE_INFINITY },
      { ...base, panes: ['a', 'b', 'c', 'd'], arrangement: 'single' },
      { ...base, shortcutsPanel: { x: -900, y: -900, w: 0, h: 0 } },
      { ...base, shortcutsPanel: { x: Number.NaN, y: 1e9, w: Number.NaN, h: Number.POSITIVE_INFINITY } },
    ];
    for (const c of cases) {
      const once = normalizeLayout(c);
      inv(once);
      expect(normalizeLayout(once), 'idempotent').toEqual(once); // a second pass must change nothing
    }
  });
});

/**
 * The floating cheatsheet panel's geometry (X5-3), as PURE functions — which is the whole reason
 * they live here rather than in the component. jsdom has no layout engine and every element's box
 * reads zero (G66), so drag arithmetic asserted through the DOM would be asserting nothing; these
 * tests are the ones that actually pin the numbers, and `ShortcutsPanel.test.tsx` pins that the
 * component calls them and stores what they return.
 */
describe('floating panel geometry', () => {
  const VIEW: Viewport = { w: 1400, h: 900 };

  /**
   * The owner's words read literally: "the width of the sidebar, starting from the 50% point
   * vertically". So: the sidebar's width, the sidebar's left edge, and the lower half of the
   * window. If "vertically centred" was what was meant, only `y` changes.
   */
  it('opens at the sidebar width, filling the lower half of the window', () => {
    expect(defaultShortcutsRect(VIEW, 260)).toEqual({ x: 0, y: 450, w: 260, h: 450 });
    // The CURRENT sidebar width, not a hardcoded 260 — the user resizes the sidebar.
    expect(defaultShortcutsRect(VIEW, 420).w).toBe(420);
    expect(defaultShortcutsRect(VIEW, 200).w).toBe(240); // …but never below the minimum
    // An odd height still lands on the 50% point, and the panel still reaches the bottom edge.
    const odd = defaultShortcutsRect({ w: 1400, h: 901 }, 300);
    expect(odd.y).toBe(451);
    expect(odd.y + odd.h).toBe(901);
  });

  /**
   * **The failure this exists to prevent**: a position saved on a bigger display, or a window
   * resized smaller, putting the panel where the title bar cannot be reached — and dragging it back
   * needs the title bar. The clamp is "wholly inside the viewport" rather than the looser "some of
   * the title bar shows", because that is the version whose consequence is trivially checkable.
   */
  it('drags a saved position back on screen from a larger display', () => {
    const fromBigDisplay = { x: 3400, y: 2000, w: 500, h: 600 };
    const fixed = clampPanelRect(fromBigDisplay, VIEW);
    expect(fixed).toEqual({ x: 900, y: 300, w: 500, h: 600 });
    expect(fixed.x + fixed.w).toBeLessThanOrEqual(VIEW.w);
    expect(fixed.y + fixed.h).toBeLessThanOrEqual(VIEW.h);
    expect(fixed.y).toBeGreaterThanOrEqual(0); // the title bar is on screen, so it can be dragged
  });

  it('refuses a size that would make the panel unusable, and one bigger than the window', () => {
    expect(clampPanelRect({ x: 0, y: 0, w: 1, h: 1 }, VIEW)).toEqual({ x: 0, y: 0, w: PANEL_MIN_W, h: PANEL_MIN_H });
    expect(clampPanelRect({ x: 0, y: 0, w: 9999, h: 9999 }, VIEW)).toEqual({ x: 0, y: 0, w: 1400, h: 900 });
    expect(clampPanelRect({ x: 5, y: 5, w: Number.NaN, h: Number.NaN }, VIEW)).toEqual({ x: 5, y: 5, w: PANEL_MIN_W, h: PANEL_MIN_H });
  });

  /**
   * A window narrower than the minimum is the one case the clamp cannot satisfy. The minimum wins
   * and the panel overhangs the right edge: x stays 0, so the drag handle is still reachable.
   * Shrinking the panel to the window instead would be the unrecoverable answer.
   */
  it('keeps the origin reachable in a window narrower than the minimum', () => {
    const tiny = clampPanelRect({ x: 400, y: 400, w: 300, h: 300 }, { w: 100, h: 100 });
    expect(tiny).toEqual({ x: 0, y: 0, w: PANEL_MIN_W, h: PANEL_MIN_H });
  });

  /**
   * TOTAL displacement from the rect the pointer went down on, never an accumulation — the
   * difference from `ui/Resizer.tsx`, whose incremental deltas were added to a stale base from Plan
   * 03 Task 4 to Task 7 and turned a 300 px drag into 100 px. The consequence tested on the last
   * two lines: dragging past the edge and back returns to the pointer instead of drifting by
   * everything the clamp swallowed.
   */
  it('moves by the total delta, and does not drift when dragged past an edge and back', () => {
    const start = { x: 100, y: 100, w: 400, h: 300 };
    expect(movePanelRect(start, 300, 0, VIEW)).toEqual({ ...start, x: 400 });
    expect(movePanelRect(start, 3, 3, VIEW)).toEqual({ ...start, x: 103, y: 103 });
    // Off the right edge…
    expect(movePanelRect(start, 5000, 0, VIEW).x).toBe(1000);
    // …and back to where the pointer actually is, from the SAME start rect.
    expect(movePanelRect(start, 50, 0, VIEW).x).toBe(150);
    // Off the top-left, too: a title bar dragged above the window is the unrecoverable one.
    expect(movePanelRect(start, -9999, -9999, VIEW)).toEqual({ ...start, x: 0, y: 0 });
  });

  /**
   * The corner handle grows the panel and NEVER moves it. Both spellings of the cap keep the rect
   * legal; only this can tell them apart — feeding an oversized rect to `clampPanelRect` slides the
   * panel up the screen while the user drags its bottom edge down.
   */
  it('keeps the origin still when a resize hits the bottom edge', () => {
    const start = { x: 900, y: 700, w: 400, h: 180 };
    const grown = resizePanelRect(start, 1000, 1000, VIEW);
    expect(grown).toEqual({ x: 900, y: 700, w: 500, h: 200 });
    expect(resizePanelRect(start, 60, 10, VIEW)).toEqual({ x: 900, y: 700, w: 460, h: 190 });
    expect(resizePanelRect(start, -9999, -9999, VIEW)).toEqual({ x: 900, y: 700, w: PANEL_MIN_W, h: PANEL_MIN_H });
  });

  /**
   * `normalizeLayout` repairs the SHAPE and cannot repair the position: it is pure over `Layout`
   * and there is no window in a `Layout`. So a rect from a 6K display survives the load intact and
   * is corrected by `clampPanelRect` where the panel is drawn — asserted here in the same order the
   * app runs them, because "which layer catches this" is the part that is easy to get wrong.
   */
  it('normalizeLayout fixes the shape and leaves the viewport clamp to the renderer', () => {
    const loaded = normalizeLayout({ ...defaultLayout(), shortcutsPanel: { x: 3400, y: 2000, w: 500, h: 600 } });
    expect(loaded.shortcutsPanel).toEqual({ x: 3400, y: 2000, w: 500, h: 600 }); // still off-screen here
    expect(clampPanelRect(loaded.shortcutsPanel as { x: number; y: number; w: number; h: number }, VIEW).x).toBe(900);
    // What it DOES fix: absurd numbers, a sub-minimum size, a negative origin, and NaN.
    expect(normalizeLayout({ ...defaultLayout(), shortcutsPanel: { x: -5, y: 1e9, w: 2, h: Number.NaN } }).shortcutsPanel)
      .toEqual({ x: 0, y: PANEL_MAX, w: PANEL_MIN_W, h: PANEL_MIN_H });
    // `null` means "never moved" and is not a defect: it must survive.
    expect(normalizeLayout(defaultLayout()).shortcutsPanel).toBeNull();
  });
});
