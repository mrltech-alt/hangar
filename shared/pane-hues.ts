/**
 * One colour per pane — spec §3, "the pane link: a colour spine".
 *
 * The hue belongs to the PANE, not to the agent: pane index 0–3 maps to a fixed entry here, so the
 * colours never repeat and never shuffle while you work, and moving an agent to another pane changes
 * its colour. The sidebar rail, the pane rail and both `⧉N` chips all read this file, because a
 * sidebar row and its terminal agreeing on a colour is the entire feature — two palettes that drift
 * by one entry would be worse than no colour at all.
 *
 * Deliberately clear of the status-dot palette, which already means agent activity.
 */
import { MAX_PANES } from './layout.ts';

/** Violet, teal, rose, gold — in pane order, one per slot up to `MAX_PANES`. */
export const PANE_HUES = ['#a78bfa', '#5eead4', '#fb7185', '#fcd34d'] as const satisfies readonly string[];

/**
 * The hue for a pane index, or `null` outside `0..MAX_PANES-1`.
 *
 * **Never a modulo.** Wrapping would hand pane 4 — which cannot exist — pane 0's colour, and the two
 * rails would then claim a link that is not there. An out-of-range index is a bug at the call site,
 * and `null` is what makes it read as one: the caller draws no rail rather than a lying one.
 *
 * Non-integers are rejected for the same reason `shared/layout.ts` rejects them: `PANE_HUES[1.5]`
 * is `undefined`, and a bare `i < 0 || i >= n` lets NaN through as if it addressed a pane.
 *
 * The bound is `MAX_PANES` rather than `PANE_HUES.length` because the range this answers for is "an
 * index that can address a pane", which is the layout's number; the test that the palette is exactly
 * `MAX_PANES` long is what keeps the two from parting.
 */
export function paneHue(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PANES) return null;
  return PANE_HUES[index];
}

/**
 * The `⧉N` chip's text — ONE-BASED, because the number a user reads here is the ⌘1–⌘4 key they press
 * to reach that pane, not the array index. It is what keeps the feature legible without colour.
 *
 * A formatter, not a gate: `paneHue` is the one that says whether an index addresses a pane, and
 * every caller draws the chip and the rail together from the same index.
 */
export function paneChipLabel(index: number): string {
  return `⧉${index + 1}`;
}
