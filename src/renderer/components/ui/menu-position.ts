/**
 * Where a context menu has to sit so all of it is on screen.
 *
 * Extracted from `ContextMenuHost` so it can be tested without a DOM: this is not presentational,
 * it decides whether the menu is reachable at all, and spec §19 keeps jsdom for the reducers and
 * stores precisely because pure arithmetic does not need a browser.
 *
 * The constants are MEASURED, not assumed. `npm run build` was run with a temporary re-export of
 * `components/ui` from `App.tsx` (Tailwind only emits classes it finds in imported source, and
 * nothing imports this directory yet), and the emitted `out/renderer/assets/*.css` was loaded into
 * headless Chromium — the same Blink that Electron 44 ships — over a static copy of `MenuList`'s
 * exact markup. What that showed:
 *
 *   - `theme.css` sets `font-size: 13px` on `html`, so Tailwind 4's `--spacing: .25rem` resolves to
 *     3.25px here, not the 4px a 16px root would give. Every spacing utility in this file inherits
 *     that.
 *   - A `px-3 py-1.5 text-[12px]` row measured **27.75px** (an 18px line box — `text-[12px]` sets
 *     font-size only and inherits preflight's `line-height: 1.5` — plus 2 x 4.875px padding).
 *   - A `my-1 border-t` separator measured **7.5px** (1px rule + 2 x 3.25px margin).
 *   - The `py-1` + `border` list chrome measured **8.5px** (2 x 3.25px padding + 2 x 1px border).
 *   - The whole 3-row + 1-separator list measured **99.25px**, which is exactly the sum above.
 *
 * The plan's `40 * menu.items.length` therefore over-reserved 12.25px per row: a ten-item menu was
 * lifted 114px higher than it needed to be (400 reserved against a real 286.0), which reads as the
 * menu detaching from the cursor near the bottom of the window.
 */

/** Height of one `px-3 py-1.5 text-[12px]` item row. Measured: 27.75px. */
export const ROW_H = 27.75;

/** Height a `my-1 border-t` separator row adds. Measured: 7.5px. */
export const SEPARATOR_H = 7.5;

/** The `<ul>`'s own `py-1` padding plus its 1px border, top and bottom. Measured: 8.5px. */
export const LIST_CHROME_H = 8.5;

/**
 * Width to reserve for the list. `min-w-[180px]` measured at exactly 180px, but the list is
 * shrink-to-fit inside a `fixed` box with no width constraint, so a label longer than the floor
 * makes it wider. The 20px over-reserve is deliberate: reserving too much only slides a menu left
 * by up to 20px at the extreme right edge, while reserving too little clips the labels off-screen.
 */
export const MENU_W = 200;

/** Minimum gap kept between the menu and the viewport edge. */
export const EDGE_GAP = 8;

export interface MenuPositionInput {
  /** Cursor position, viewport coordinates (`MouseEvent.clientX` / `clientY`). */
  x: number;
  y: number;
  /** Items that render a button row. */
  itemCount: number;
  /** Items that render a separator rule instead. Defaults to 0. */
  separatorCount?: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Estimated rendered height of a `MenuList` with this many button rows and separators. */
export function menuHeight(itemCount: number, separatorCount: number): number {
  return itemCount * ROW_H + separatorCount * SEPARATOR_H + LIST_CHROME_H;
}

/**
 * Clamps a cursor position to somewhere the whole menu fits, falling back to the edge gap when it
 * does not fit at all. The `Math.max(EDGE_GAP, …)` floor applies to BOTH axes; the plan had it on
 * the vertical axis only, so a viewport narrower than `MENU_W` produced a negative `left`
 * (`Math.min(0, 190 - 200)` → `-10`) and put the menu's own left edge off-screen.
 */
export function clampMenuPosition(input: MenuPositionInput): { left: number; top: number } {
  const height = menuHeight(input.itemCount, input.separatorCount ?? 0);
  return {
    left: Math.max(EDGE_GAP, Math.min(input.x, input.viewportWidth - MENU_W)),
    top: Math.max(EDGE_GAP, Math.min(input.y, input.viewportHeight - height)),
  };
}
