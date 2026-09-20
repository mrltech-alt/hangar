import { describe, expect, it } from 'vitest';
import { EDGE_GAP, LIST_CHROME_H, MENU_W, ROW_H, SEPARATOR_H, clampMenuPosition, menuHeight } from './menu-position.ts';

// A 1440x900 viewport is roomy enough that nothing below clamps by accident.
const V = { viewportWidth: 1440, viewportHeight: 900 };

describe('menuHeight', () => {
  it('sums measured rows, separators and list chrome', () => {
    expect(menuHeight(1, 0)).toBeCloseTo(ROW_H + LIST_CHROME_H, 5);
    expect(menuHeight(3, 1)).toBeCloseTo(3 * ROW_H + SEPARATOR_H + LIST_CHROME_H, 5);
  });

  it('matches the height Chromium laid out for the real markup', () => {
    // Measured: the four-row list in the smoke page (3 buttons + 1 separator) reported
    // getBoundingClientRect().height === 99.25. 3*27.75 + 7.5 + 8.5 = 99.25.
    expect(menuHeight(3, 1)).toBeCloseTo(99.25, 5);
  });
});

describe('clampMenuPosition', () => {
  it('leaves a menu that fits where the cursor put it', () => {
    expect(clampMenuPosition({ x: 300, y: 200, itemCount: 4, separatorCount: 0, ...V })).toEqual({ left: 300, top: 200 });
  });

  it('clamps horizontally when the menu would run off the right edge', () => {
    const { left, top } = clampMenuPosition({ x: 1400, y: 100, itemCount: 4, separatorCount: 0, ...V });
    expect(left).toBe(1440 - MENU_W);
    expect(top).toBe(100);
  });

  it('clamps vertically when the menu would run off the bottom edge', () => {
    // 6 rows + 1 separator = 6*27.75 + 7.5 + 8.5 = 182.5. 900 - 182.5 = 717.5.
    const { left, top } = clampMenuPosition({ x: 100, y: 880, itemCount: 6, separatorCount: 1, ...V });
    expect(left).toBe(100);
    expect(top).toBeCloseTo(717.5, 5);
  });

  it('clamps both axes at once', () => {
    expect(clampMenuPosition({ x: 1430, y: 890, itemCount: 2, separatorCount: 0, ...V })).toEqual({
      left: 1440 - MENU_W,
      top: 900 - menuHeight(2, 0),
    });
  });

  it('never returns a position inside the edge gap on either axis', () => {
    // A viewport narrower and shorter than the menu itself: both `viewport - size` terms go
    // negative, and the floor is the only thing keeping the menu on screen.
    expect(clampMenuPosition({ x: 0, y: 0, itemCount: 1, separatorCount: 0, viewportWidth: 190, viewportHeight: 30 })).toEqual({
      left: EDGE_GAP,
      top: EDGE_GAP,
    });
    // The plan's arithmetic had `Math.max(8, y)` on the vertical axis but nothing on the
    // horizontal one, so `Math.min(x, 190 - 200)` returned left: -10 — the menu's own left edge
    // off-screen, with no way to reach the labels.
    expect(clampMenuPosition({ x: 0, y: 0, itemCount: 1, separatorCount: 0, viewportWidth: 190, viewportHeight: 30 }).left).toBeGreaterThan(0);
  });

  it('pins a menu taller than the viewport to the top gap rather than scrolling it off', () => {
    // 40 rows = 40*27.75 + 8.5 = 1118.5, well past a 900px viewport. The bottom overflows either
    // way; anchoring the top is what keeps the first item clickable.
    const { top } = clampMenuPosition({ x: 100, y: 400, itemCount: 40, separatorCount: 0, ...V });
    expect(menuHeight(40, 0)).toBeGreaterThan(900);
    expect(top).toBe(EDGE_GAP);
  });

  it('treats a missing separatorCount as zero', () => {
    expect(clampMenuPosition({ x: 10, y: 880, itemCount: 6, ...V }).top).toBeCloseTo(900 - menuHeight(6, 0), 5);
  });
});
