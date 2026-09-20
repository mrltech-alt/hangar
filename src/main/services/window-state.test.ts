import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { describeWindowState, fitToDisplays, foldWindowSample, loadWindowState, saveWindowState, type WindowState } from './window-state.ts';

// A laptop display: menu bar 25 px, Dock 38 px. `workArea` is what a window may cover; `bounds` is the whole screen.
const MAIN = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 919 } };
// An external display to its right, top-aligned, with a menu bar and no Dock.
const EXTERNAL = { bounds: { x: 1512, y: 0, width: 2560, height: 1440 }, workArea: { x: 1512, y: 25, width: 2560, height: 1415 } };
// Displays arranged LEFT of and ABOVE the primary have negative coordinates.
const LEFT = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 25, width: 1920, height: 1055 } };
const ABOVE = { bounds: { x: 0, y: -1080, width: 1920, height: 1080 }, workArea: { x: 0, y: -1055, width: 1920, height: 1055 } };
const DEFAULTS = { width: 1400, height: 900, minWidth: 1024, minHeight: 640 };
const state = (bounds: WindowState['bounds'], extra: Partial<WindowState> = {}): WindowState =>
  ({ version: 1, bounds, maximized: false, fullScreen: false, ...extra });
const inside = (b: WindowState['bounds'], area: WindowState['bounds']): void => {
  expect(b.x).toBeGreaterThanOrEqual(area.x);
  expect(b.y).toBeGreaterThanOrEqual(area.y);
  expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width);
  expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height);
};

describe('fitToDisplays', () => {
  it('keeps a rectangle that is fully on a connected display', () => {
    const s = state({ x: 1600, y: 40, width: 1800, height: 1100 });
    expect(fitToDisplays(s, [MAIN, EXTERNAL], DEFAULTS)).toEqual(s);
  });

  it('keeps a visible window where it was even though it overlaps the Dock', () => {
    // Bottom edge 30 px into the Dock (work area ends at 944): the title bar is reachable, so it is not moved up.
    const s = state({ x: 100, y: 74, width: 1200, height: 900 });
    expect(fitToDisplays(s, [MAIN], DEFAULTS)).toEqual(s);
  });

  it('keeps a window straddling two connected displays instead of snapping it onto one', () => {
    const s = state({ x: 1000, y: 100, width: 1400, height: 800 });
    expect(fitToDisplays(s, [MAIN, EXTERNAL], DEFAULTS)).toEqual(s);
    // …whichever display holds more of it, and whichever the title bar starts on.
    const mostlyRight = state({ x: 1300, y: 100, width: 1400, height: 800 });
    expect(fitToDisplays(mostlyRight, [MAIN, EXTERNAL], DEFAULTS)).toEqual(mostlyRight);
  });

  it('keeps windows on displays left of and above the primary (negative coordinates)', () => {
    const left = state({ x: -1700, y: 60, width: 1400, height: 900 });
    expect(fitToDisplays(left, [MAIN, LEFT], DEFAULTS)).toEqual(left);
    const above = state({ x: 200, y: -1000, width: 1400, height: 900 });
    expect(fitToDisplays(above, [MAIN, ABOVE], DEFAULTS)).toEqual(above);
  });

  it('fits a window whose top edge is just above the Dock, with no room for the title bar', () => {
    // Top edge 1 px inside MAIN's work area (which ends at 944): the title bar itself is behind the Dock.
    const s = state({ x: 100, y: 943, width: 1200, height: 800 });
    expect(fitToDisplays(s, [MAIN], DEFAULTS)).not.toEqual(s);
    // With a display below, most of the window IS on screen, so only the title-bar rule stops it being kept.
    const BELOW = { bounds: { x: 0, y: 982, width: 1920, height: 1080 }, workArea: { x: 0, y: 1007, width: 1920, height: 1055 } };
    expect(fitToDisplays(s, [MAIN, BELOW], DEFAULTS)!.bounds).toEqual({ x: 100, y: 1007, width: 1200, height: 800 });
  });

  it('fits a window whose title bar is under the menu bar', () => {
    const fitted = fitToDisplays(state({ x: 100, y: 0, width: 1200, height: 800 }), [MAIN], DEFAULTS)!.bounds;
    expect(fitted).toEqual({ x: 100, y: 25, width: 1200, height: 800 });
  });

  it('fits a window that is mostly off every display even if a sliver of title bar shows', () => {
    // 112 px of a 1400 px window left on the laptop after the external display went away.
    const fitted = fitToDisplays(state({ x: 1400, y: 100, width: 1400, height: 800 }), [MAIN], DEFAULTS)!.bounds;
    inside(fitted, MAIN.workArea);
    expect(fitted).toEqual({ x: 112, y: 100, width: 1400, height: 800 });
  });

  it('moves a window from an unplugged display onto the nearest remaining one', () => {
    const fitted = fitToDisplays(state({ x: 1600, y: 40, width: 1400, height: 900 }), [MAIN], DEFAULTS);
    expect(fitted).not.toBeNull();
    inside(fitted!.bounds, MAIN.workArea);
  });

  it('picks the nearest of the remaining displays, not the first one listed', () => {
    // A third display far to the right was unplugged; EXTERNAL is nearer than MAIN, and listed second.
    const fitted = fitToDisplays(state({ x: 4500, y: 300, width: 1400, height: 900 }), [MAIN, EXTERNAL], DEFAULTS)!.bounds;
    inside(fitted, EXTERNAL.workArea);
    expect(fitted.x).toBe(EXTERNAL.workArea.x + EXTERNAL.workArea.width - 1400);
    expect(fitted.y).toBe(300);
  });

  it('clamps from the left and from above, onto displays at negative coordinates', () => {
    const fromLeft = fitToDisplays(state({ x: -5000, y: 200, width: 1400, height: 800 }), [MAIN, LEFT], DEFAULTS)!.bounds;
    expect(fromLeft).toEqual({ x: LEFT.workArea.x, y: 200, width: 1400, height: 800 });
    const fromAbove = fitToDisplays(state({ x: 300, y: -4000, width: 1400, height: 900 }), [MAIN, ABOVE], DEFAULTS)!.bounds;
    expect(fromAbove).toEqual({ x: 300, y: ABOVE.workArea.y, width: 1400, height: 900 });
  });

  it('shrinks a window larger than the display it lands on, but never below the minimums', () => {
    const b = fitToDisplays(state({ x: 0, y: 0, width: 3000, height: 2000 }), [MAIN], DEFAULTS)!.bounds;
    expect(b).toEqual(MAIN.workArea);
    const tiny = fitToDisplays(state({ x: 10, y: 30, width: 200, height: 100 }), [MAIN], DEFAULTS)!.bounds;
    expect(tiny.width).toBe(DEFAULTS.minWidth);
    expect(tiny.height).toBe(DEFAULTS.minHeight);
  });

  it('keeps maximized and fullScreen flags', () => {
    const s = state({ x: 10, y: 30, width: 1200, height: 800 }, { maximized: true, fullScreen: true });
    expect(fitToDisplays(s, [MAIN], DEFAULTS)).toMatchObject({ maximized: true, fullScreen: true });
    const moved = state({ x: 9000, y: 30, width: 1200, height: 800 }, { maximized: true, fullScreen: true });
    expect(fitToDisplays(moved, [MAIN], DEFAULTS)).toMatchObject({ maximized: true, fullScreen: true });
  });

  it('returns null when there is nothing usable', () => {
    expect(fitToDisplays(null, [MAIN], DEFAULTS)).toBeNull();
    expect(fitToDisplays(state({ x: 0, y: 0, width: 1400, height: 900 }), [], DEFAULTS)).toBeNull();
  });
});

describe('foldWindowSample', () => {
  const prev = state({ x: 100, y: 60, width: 1300, height: 850 });
  const sample = (bounds: WindowState['bounds'], flags: { maximized?: boolean; fullScreen?: boolean; minimized?: boolean } = {}) =>
    ({ bounds, maximized: false, fullScreen: false, minimized: false, ...flags });
  const SCREEN = { x: 0, y: 0, width: 1512, height: 982 };

  it('takes bounds from a normal window', () => {
    const b = { x: 200, y: 80, width: 1100, height: 700 };
    expect(foldWindowSample(prev, sample(b))).toEqual(state(b));
  });

  it('keeps the last normal bounds while maximized, so un-maximising returns to them', () => {
    expect(foldWindowSample(prev, sample(SCREEN, { maximized: true }))).toEqual({ ...prev, maximized: true });
  });

  it('keeps the last normal bounds and the maximized flag while in full screen', () => {
    // A full-screen window reports isMaximized() false, which says nothing about the state it will leave
    // full screen into: the flag from before full screen stands, whichever way the sample reads.
    expect(foldWindowSample(prev, sample(SCREEN, { fullScreen: true, maximized: true }))).toEqual({ ...prev, fullScreen: true });
    const maxed = { ...prev, maximized: true };
    expect(foldWindowSample(maxed, sample(SCREEN, { fullScreen: true }))).toEqual({ ...maxed, fullScreen: true });
  });

  it('keeps bounds and maximized while minimized, and is no longer full screen', () => {
    const was = { ...prev, maximized: true, fullScreen: true };
    expect(foldWindowSample(was, sample({ x: 0, y: 0, width: 10, height: 10 }, { minimized: true }))).toEqual({ ...prev, maximized: true });
  });
});

describe('describeWindowState', () => {
  it('names the rectangle and the flags for the launch log line', () => {
    expect(describeWindowState(state({ x: 100, y: 60, width: 1300, height: 850 }))).toBe('1300x850 at 100,60');
    expect(describeWindowState(state({ x: -20, y: 0, width: 1300, height: 850 }, { maximized: true, fullScreen: true })))
      .toBe('1300x850 at -20,0, maximized, full screen');
  });
});

describe('loadWindowState / saveWindowState', () => {
  it('round-trips', () => {
    const file = join(tempDir('winstate'), 'window-state.json');
    const s = state({ x: 100, y: 60, width: 1300, height: 850 }, { maximized: true });
    saveWindowState(file, s);
    expect(loadWindowState(file)).toEqual(s);
  });

  it('treats a missing, corrupt, wrong-version or out-of-range file as no saved state', () => {
    const dir = tempDir('winstate');
    expect(loadWindowState(join(dir, 'absent.json'))).toBeNull();
    const file = join(dir, 'window-state.json');
    for (const body of [
      '{not json',
      JSON.stringify({ version: 2, bounds: { x: 0, y: 0, width: 1400, height: 900 }, maximized: false, fullScreen: false }),
      JSON.stringify({ version: 1, bounds: { x: 0, y: 0, width: -5, height: 900 }, maximized: false, fullScreen: false }),
      JSON.stringify({ version: 1, bounds: { x: 'a', y: 0, width: 1400, height: 900 }, maximized: false, fullScreen: false }),
      JSON.stringify({ version: 1, bounds: { x: 1e12, y: 0, width: 1400, height: 900 }, maximized: false, fullScreen: false }),
    ]) {
      writeFileSync(file, body);
      expect(loadWindowState(file)).toBeNull();
    }
    // load never rewrites the file (`JSON.stringify(1e12)` is `1000000000000`, not `1e+12`)
    expect(readFileSync(file, 'utf8')).toContain('"x":1000000000000');
  });
});
