// Where the main window was, so a relaunch reopens it there (spec §13). Main-owned and kept out of
// `Layout` on purpose: `Layout` is written by the renderer through `layout:set`, and a main-side
// write into it could be overwritten by a renderer holding an older copy.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicWriteJson } from '../util/atomic-write.ts';

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState { version: 1; bounds: Rect; maximized: boolean; fullScreen: boolean }
export interface WindowDefaults { width: number; height: number; minWidth: number; minHeight: number }
/** One connected display, as `screen.getAllDisplays()` reports it: the whole screen and the part a window may cover. */
export interface DisplayArea { bounds: Rect; workArea: Rect }
/** What the window reports about itself at one moment, read from `BrowserWindow`'s getters. */
export interface WindowSample { bounds: Rect; maximized: boolean; fullScreen: boolean; minimized: boolean }

/** Far beyond any real desktop, so a garbage coordinate is rejected rather than "fitted". */
const COORD_MAX = 100_000;
const coord = z.number().int().min(-COORD_MAX).max(COORD_MAX);
const size = z.number().int().min(1).max(COORD_MAX);
const WindowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({ x: coord, y: coord, width: size, height: size }),
  maximized: z.boolean(),
  fullScreen: z.boolean(),
});

export function loadWindowState(file: string): WindowState | null {
  try {
    const parsed = WindowStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  atomicWriteJson(file, state);
}

/**
 * Fold what the window reports now into the state to save. `bounds` is only ever taken from a
 * window that is neither maximized, full screen nor minimized — the rectangle the owner last chose
 * by hand, which is what un-maximising returns to after a relaunch. That is spec §13's "normal
 * bounds" without calling `getNormalBounds()`: its docs promise the normal rectangle in every state,
 * but whether macOS keeps it current for a title-bar double-click or the green button in Electron 44
 * has not been measured, and a rectangle seen while the window was normal needs no such trust.
 *
 * The caller must only pass SETTLED samples (index.ts: `move`, `resized`, `maximize`, …, or a
 * `resize` after 500 ms of quiet). Measured on Electron 44.2.0: an animated `maximize()` fires ~40
 * `resize` events over ~400 ms, each reporting not-maximized with an intermediate size, and folding
 * one of those would save a frame of the animation as the owner's rectangle.
 *
 * `maximized` is left alone while full screen: a full-screen window reports `isMaximized()` false
 * (measured), which says nothing about the state it will leave full screen into — so the flag from
 * before full screen stands. Minimized is not restored (§13 names only the other two) and cannot
 * coexist with full screen; a minimized window reports its normal size, but it is not sampled.
 */
export function foldWindowSample(prev: WindowState, sample: WindowSample): WindowState {
  if (sample.fullScreen) return { ...prev, fullScreen: true };
  if (sample.minimized) return { ...prev, fullScreen: false };
  if (sample.maximized) return { ...prev, maximized: true, fullScreen: false };
  return { version: 1, bounds: { ...sample.bounds }, maximized: false, fullScreen: false };
}

/** `1300x850 at 100,60, maximized, full screen` — for app.log's launch line. */
export function describeWindowState(s: WindowState): string {
  const { x, y, width, height } = s.bounds;
  return [`${width}x${height} at ${x},${y}`, ...(s.maximized ? ['maximized'] : []), ...(s.fullScreen ? ['full screen'] : [])].join(', ');
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const distance = (a: Rect, b: Rect): number => {
  const ax = a.x + a.width / 2; const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2; const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
};

/** A title bar needs at least this much of its width on a work area to be grabbed and dragged. */
const TITLE_GRAB = 100;
/**
 * How much of the window's top must fit inside the work area, not just its top edge: a top edge 1 px
 * above the Dock leaves the title bar behind the Dock, where it cannot be grabbed. About the height
 * of a standard macOS title bar; Hangar's `hiddenInset` window puts its traffic lights 14 px from the
 * top (`window.ts`), so they end at about 28 px. An estimate, not a measured value for this window.
 */
const TITLE_BAR_HEIGHT = 28;
/** A kept window must have at least this share of its area on some display. */
const MIN_VISIBLE_SHARE = 0.5;

const horizontalOverlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));

/**
 * Whether a window at `r` is usable where it is, so restoring it must not move it: its whole
 * title-bar row (top edge plus `TITLE_BAR_HEIGHT`) lies inside some display's work area with at
 * least `TITLE_GRAB` px of its width there, and at least half of it is on screen, counting every display's FULL bounds. Full bounds rather
 * than work areas, so a window whose bottom sits behind the Dock is kept, not nudged up; summed over
 * displays, so a window straddling two is kept instead of being snapped onto one of them.
 */
function isUsableWhereItIs(r: Rect, displays: DisplayArea[]): boolean {
  const titleReachable = displays.some(({ workArea: wa }) =>
    r.y >= wa.y && r.y + TITLE_BAR_HEIGHT <= wa.y + wa.height && horizontalOverlap(r, wa) >= TITLE_GRAB);
  const onScreen = displays.reduce((sum, d) => sum + overlap(r, d.bounds), 0);
  return titleReachable && onScreen >= MIN_VISIBLE_SHARE * r.width * r.height;
}

/**
 * Fit a saved window onto the displays that are connected NOW. The size is first raised to the
 * window's minimums. A window that is usable where it is (`isUsableWhereItIs`) is returned at
 * exactly its saved position. Otherwise — a monitor was unplugged, the resolution changed, the title
 * bar ended up under the menu bar — the work area it overlaps most wins, or the nearest one if it
 * overlaps none; the size is clamped to that work area and the rectangle moved fully inside it.
 * `null` when there is nothing to restore.
 *
 * On a work area smaller than the minimums this returns the work area's size, but the window does
 * not come out that small: Electron applies `minWidth`/`minHeight` when it creates the window
 * (measured: an 800x500 request with 1024x640 minimums comes out 1024x640), so there the window
 * overhangs the display's right and bottom edges. Not clamped to a smaller size here on purpose —
 * Electron would undo it — and a display under 1024x640 is not one Hangar is used on.
 */
export function fitToDisplays(saved: WindowState | null, displays: DisplayArea[], defaults: WindowDefaults): WindowState | null {
  if (saved === null || displays.length === 0) return null;
  const raised: Rect = {
    ...saved.bounds,
    width: Math.max(saved.bounds.width, defaults.minWidth),
    height: Math.max(saved.bounds.height, defaults.minHeight),
  };
  if (isUsableWhereItIs(raised, displays)) return { ...saved, bounds: raised };
  const areas = displays.map((d) => d.workArea);
  const byOverlap = [...areas].sort((a, b) => overlap(raised, b) - overlap(raised, a));
  const target = overlap(raised, byOverlap[0]!) > 0
    ? byOverlap[0]!
    : [...areas].sort((a, b) => distance(raised, a) - distance(raised, b))[0]!;
  const width = Math.min(raised.width, target.width);
  const height = Math.min(raised.height, target.height);
  const x = Math.min(Math.max(raised.x, target.x), target.x + target.width - width);
  const y = Math.min(Math.max(raised.y, target.y), target.y + target.height - height);
  return { ...saved, bounds: { x, y, width, height } };
}
