// Pane grid reducer — spec §12.3. Pure functions over Layout; all return new objects.
import type { Arrangement, Id, Layout, PanelRect } from './types.ts';

export const MAX_PANES = 4;

/**
 * Clamp that also repairs a non-finite value, instead of passing it through.
 *
 * `Math.min(Math.max(NaN, lo), hi)` is `NaN`, so a bare chain blesses the one value that poisons
 * every later comparison — and this file is the last line of defence before a layout read off disk
 * reaches the UI. Hoisted out of `normalizeLayout` when the panel geometry started needing it too;
 * it was already written this way there for exactly this reason.
 */
function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo;
}

/**
 * The smallest a floating panel may be dragged to.
 *
 * A resize that can reach zero is unrecoverable by the same logic that makes an off-screen position
 * unrecoverable: the handle you would need to grab is the thing that vanished. 240x140 keeps the
 * title bar, the Close button and two or three rows of the cheatsheet visible.
 */
export const PANEL_MIN_W = 240;
export const PANEL_MIN_H = 140;
/**
 * The size/coordinate ceiling `normalizeLayout` repairs to, and the one `LayoutInputSchema`
 * enforces on `layout:set`. It is NOT a viewport clamp — this file cannot see the window — it is
 * "no plausible display is this big", so a garbage rect on disk becomes a usable one rather than
 * classing the whole workspace file corrupt.
 */
export const PANEL_MAX = 10_000;

/** The window, in the frame `PanelRect` uses. `{ w: innerWidth, h: innerHeight }` at the call site. */
export interface Viewport {
  w: number;
  h: number;
}

/**
 * The owner's words, read literally: "the width of the sidebar, starting from the 50% point
 * vertically". So the panel opens as the sidebar's LOWER HALF — the sidebar's width, its left edge,
 * a top edge at half the window height, and the rest of the window below it.
 *
 * `sidebarWidth` is passed in rather than defaulted to 260 because the user resizes the sidebar and
 * a default that ignored that would be wrong the moment they did. If "vertically centred" turns out
 * to be what was meant, it is `y = round((viewport.h - h) / 2)` and nothing else changes.
 */
export function defaultShortcutsRect(viewport: Viewport, sidebarWidth: number): PanelRect {
  const y = Math.round(viewport.h / 2);
  return clampPanelRect({ x: 0, y, w: sidebarWidth, h: viewport.h - y }, viewport);
}

/**
 * Keeps a panel wholly inside the window, at or above the minimum size.
 *
 * "Wholly inside" rather than the looser "some of the title bar is visible", because the property
 * worth having is the one that is trivially checkable: if the rect is inside the viewport then the
 * title bar is on screen, so the panel can always be dragged back — and a saved position from a
 * larger display is repaired by the same arithmetic with no special case for it.
 *
 * Order matters: the size is clamped FIRST and the position is then clamped against the clamped
 * size, or a panel wider than the window would be pushed to a negative x. A window narrower than
 * `PANEL_MIN_W` is the one case that cannot be satisfied — the minimum wins and the panel overhangs
 * the right edge, which keeps the drag handle reachable at x=0 rather than shrinking the panel to
 * nothing.
 */
export function clampPanelRect(rect: PanelRect, viewport: Viewport): PanelRect {
  const w = clamp(rect.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, viewport.w));
  const h = clamp(rect.h, PANEL_MIN_H, Math.max(PANEL_MIN_H, viewport.h));
  return { x: clamp(rect.x, 0, Math.max(0, viewport.w - w)), y: clamp(rect.y, 0, Math.max(0, viewport.h - h)), w, h };
}

/**
 * A drag, as TOTAL displacement from where the pointer went down against the rect it went down on —
 * never an accumulation of per-move deltas.
 *
 * That is the difference from `ui/Resizer.tsx`, and it is deliberate. `Resizer` reports incremental
 * deltas, so its caller has to add each one to the width it is holding; from Plan 03 Task 4 until
 * Task 7 the caller was holding the width from the render current at mousedown, and a 300 px drag
 * moved the panel 100 px. Its fix is a ref that always calls the newest callback. Taking the total
 * delta from a rect captured at mousedown removes the failure instead of guarding it: the base is
 * immutable for the life of the drag, so no closure can be stale, and dragging off the edge and
 * back returns to where the pointer is rather than drifting by everything the clamp swallowed.
 */
export function movePanelRect(start: PanelRect, dx: number, dy: number, viewport: Viewport): PanelRect {
  return clampPanelRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport);
}

/**
 * The same, from the bottom-right corner — and the ORIGIN STAYS PUT, which is why the size is
 * capped at what fits from `start.x/y` before `clampPanelRect` sees it.
 *
 * Handing an oversized rect straight to `clampPanelRect` would also produce a legal rect, but the
 * legal rect it produces slides the panel UP the screen while the user drags its bottom edge DOWN.
 * Capping first makes the panel stop growing instead, which is what every other resizable panel
 * does. Both spellings satisfy "wholly inside the viewport", so no test of the clamp alone can tell
 * them apart — `keeps the origin still when a resize hits the bottom edge` is the one that can.
 */
export function resizePanelRect(start: PanelRect, dx: number, dy: number, viewport: Viewport): PanelRect {
  const maxW = Math.max(PANEL_MIN_W, viewport.w - start.x);
  const maxH = Math.max(PANEL_MIN_H, viewport.h - start.y);
  return clampPanelRect({ ...start, w: Math.min(start.w + dx, maxW), h: Math.min(start.h + dy, maxH) }, viewport);
}

/**
 * The viewport-free half of the repair, for `normalizeLayout`. Fixes NaN, a negative origin and an
 * absurd size; cannot fix "off the right of THIS display", which is `clampPanelRect`'s job in the
 * renderer. A `null` stays null — that means "never moved", not "broken".
 */
function normalizePanelRect(rect: PanelRect | null): PanelRect | null {
  // `typeof` rather than `!== null`: this runs on data from disk, where the zod schema's
  // `.catch(null)` is the first line of defence and this is the second. A hand-edited
  // `"shortcutsPanel": 3` reaches here as a number if that ever changes.
  if (rect === null || typeof rect !== 'object') return null;
  return {
    x: clamp(rect.x, 0, PANEL_MAX),
    y: clamp(rect.y, 0, PANEL_MAX),
    w: clamp(rect.w, PANEL_MIN_W, PANEL_MAX),
    h: clamp(rect.h, PANEL_MIN_H, PANEL_MAX),
  };
}

/** True for an index that can actually address a pane. A bare `i < 0 || i >= n` lets NaN and
 *  fractions straight through — `swapPanes(l, 0, 1.5)` destroyed an agent. */
function validIndex(layout: Layout, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < layout.panes.length;
}

/** The focused agent, or null. One clamped implementation, because `panes[focusedIndex]` is about to
 *  be written by hand in the drawer, the pane header, the status bar and several keyboard actions. */
export function focusedAgent(layout: Layout): Id | null {
  return layout.panes[Math.min(Math.max(0, layout.focusedIndex), layout.panes.length - 1)] ?? null;
}

/**
 * `arrangement` is a pure function of the pane count and the user's remembered h/v preference.
 * It reads `splitOrientation`, NOT the current arrangement: the arrangement is overwritten every
 * time the count changes, so a preference stored there is gone the moment you close a pane.
 */
export function defaultArrangement(count: number, splitOrientation: Layout['splitOrientation']): Arrangement {
  if (count <= 1) return 'single';
  if (count === 2) return splitOrientation;
  if (count === 3) return 'triple';
  return 'grid';
}

/** Repairs anything loaded from disk: 1..4 panes, no duplicate agents, valid focus, arrangement matching the count. */
export function normalizeLayout(layout: Layout): Layout {
  const seen = new Set<Id>();
  const panes: (Id | null)[] = [];
  for (const p of layout.panes.slice(0, MAX_PANES)) {
    // `typeof p === 'string'`, not `p !== null`: a sparse array's hole reads as `undefined`, which
    // would otherwise be added to `seen` as if it were an agent id and survive a second pass.
    if (typeof p === 'string' && seen.has(p)) {
      panes.push(null);
    } else {
      if (typeof p === 'string') seen.add(p);
      panes.push(typeof p === 'string' ? p : null);
    }
  }
  if (panes.length === 0) panes.push(null);
  // Widths and focusedIndex are clamped here rather than in the persisted schema, so an
  // out-of-range value on disk is repaired instead of classifying the whole workspace file as
  // corrupt — which would move it aside and lose every project and agent. (`clamp` is now at module
  // scope, because the floating panel's geometry needs the same NaN-repairing behaviour.)
  //
  // Through `clamp` too: a bare Math.min/max chain passes NaN straight through, and this function
  // documents itself as repairing *anything* loaded from disk. JSON cannot express NaN and the zod
  // schema rejects it, so it is unreachable today — but the guard is free and this is the last line
  // of defence before data loss.
  const focusedIndex = clamp(Math.floor(layout.focusedIndex), 0, panes.length - 1);
  return {
    ...layout,
    panes,
    focusedIndex,
    sidebarWidth: clamp(layout.sidebarWidth, 200, 480),
    drawerWidth: clamp(layout.drawerWidth, 420, 4000),
    // Shape only — this function cannot see the window, so "off the right of the display" is
    // repaired by `clampPanelRect` where the panel is drawn. See `PanelRect`'s own comment.
    shortcutsPanel: normalizePanelRect(layout.shortcutsPanel),
    arrangement: defaultArrangement(panes.length, layout.splitOrientation),
  };
}

export function paneOf(layout: Layout, agentId: Id): number | null {
  const i = layout.panes.indexOf(agentId);
  return i === -1 ? null : i;
}

export function focusPane(layout: Layout, index: number): Layout {
  if (!validIndex(layout, index)) return layout;
  return { ...layout, focusedIndex: index };
}

export function openInFocused(layout: Layout, agentId: Id): Layout {
  const existing = paneOf(layout, agentId);
  if (existing !== null) return focusPane(layout, existing);
  const panes = [...layout.panes];
  // Clamped, not guarded: writing past the end produced a SPARSE array, and `normalizeLayout`
  // then turned the hole into `undefined` and blessed it (it tested `p !== null`). A guard would
  // instead make a sidebar click silently do nothing, which is the worse failure.
  const target = Math.min(Math.max(0, layout.focusedIndex), panes.length - 1);
  panes[target] = agentId;
  // `focusedIndex` follows the clamp, or an out-of-range value would persist and every later
  // operation would keep working on a pane that does not exist.
  if (layout.focusedIndex !== target) return { ...layout, panes, focusedIndex: target };
  return { ...layout, panes };
}

/** Returns null when all MAX_PANES slots are taken. */
export function openInNewPane(layout: Layout, agentId: Id): Layout | null {
  const existing = paneOf(layout, agentId);
  if (existing !== null) return focusPane(layout, existing);
  const empty = layout.panes.indexOf(null);
  if (empty !== -1) {
    const panes = [...layout.panes];
    panes[empty] = agentId;
    return { ...layout, panes, focusedIndex: empty };
  }
  if (layout.panes.length >= MAX_PANES) return null;
  const panes = [...layout.panes, agentId];
  return { ...layout, panes, focusedIndex: panes.length - 1, arrangement: defaultArrangement(panes.length, layout.splitOrientation) };
}

export function addEmptyPane(layout: Layout): Layout | null {
  if (layout.panes.length >= MAX_PANES) return null;
  const panes = [...layout.panes, null];
  return { ...layout, panes, focusedIndex: panes.length - 1, arrangement: defaultArrangement(panes.length, layout.splitOrientation) };
}

/** Removes the slot (never below one pane; a lone pane is blanked instead). Focus moves to the nearest slot. */
export function closePane(layout: Layout, index: number): Layout {
  if (!validIndex(layout, index)) return layout;
  if (layout.panes.length === 1) return { ...layout, panes: [null], focusedIndex: 0, arrangement: 'single' };
  const panes = layout.panes.filter((_, i) => i !== index);
  const focusedIndex = Math.min(layout.focusedIndex > index ? layout.focusedIndex - 1 : layout.focusedIndex, panes.length - 1);
  return { ...layout, panes, focusedIndex, arrangement: defaultArrangement(panes.length, layout.splitOrientation) };
}

export function swapPanes(layout: Layout, i: number, j: number): Layout {
  if (i === j || !validIndex(layout, i) || !validIndex(layout, j)) return layout;
  const panes = [...layout.panes];
  const tmp = panes[i] ?? null;
  panes[i] = panes[j] ?? null;
  panes[j] = tmp;
  const focusedIndex = layout.focusedIndex === i ? j : layout.focusedIndex === j ? i : layout.focusedIndex;
  return { ...layout, panes, focusedIndex };
}

/** Only the two-pane orientation is a free choice; other counts are fixed. */
/** The only way a user changes the split. Records the preference so it survives the pane count. */
export function setArrangement(layout: Layout, arrangement: Arrangement): Layout {
  // Records the PREFERENCE as well as the derived value, so it survives the pane count changing.
  // Storing it only in `arrangement` meant the common sequence — two panes vertical, close one,
  // open another — silently reverted to horizontal, and a restart lost it unless the app happened
  // to close at exactly two panes.
  if (arrangement === 'split-h' || arrangement === 'split-v') {
    return { ...layout, splitOrientation: arrangement, arrangement: defaultArrangement(layout.panes.length, arrangement) };
  }
  return { ...layout, arrangement: defaultArrangement(layout.panes.length, layout.splitOrientation) };
}

export function removeAgent(layout: Layout, agentId: Id): Layout {
  if (paneOf(layout, agentId) === null) return layout;
  return { ...layout, panes: layout.panes.map((p) => (p === agentId ? null : p)) };
}
