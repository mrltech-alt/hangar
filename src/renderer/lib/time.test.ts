import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clockTime, useNow } from './time.ts';

afterEach(() => {
  vi.useRealTimers();
});

function mount(probe: () => null): ReturnType<typeof createRoot> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(probe)));
  return root;
}

describe('useNow', () => {
  it('re-renders with a fresh timestamp once per interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const seen: number[] = [];
    const root = mount(() => {
      seen.push(useNow(1_000));
      return null;
    });
    expect(seen).toEqual([1_000]);
    // No setSystemTime alongside these: advanceTimersByTime moves the mocked clock too, so setting
    // it as well double-counts (2_000 + 1_000 = 3_000, which is what the first draft asserted at).
    act(() => vi.advanceTimersByTime(1_000));
    expect(seen.at(-1)).toBe(2_000);
    act(() => vi.advanceTimersByTime(1_000));
    expect(seen.at(-1)).toBe(3_000);
    act(() => root.unmount());
  });

  // The cleanup is the whole reason this hook exists rather than a bare setInterval: every sidebar
  // row mounts one, so a leaked interval per unmounted row would accumulate for the app's lifetime.
  it('clears its interval on unmount', () => {
    vi.useFakeTimers();
    const root = mount(() => {
      useNow(1_000);
      return null;
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to a 30 s interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const seen: number[] = [];
    const root = mount(() => {
      seen.push(useNow());
      return null;
    });
    act(() => vi.advanceTimersByTime(29_999));
    expect(seen.at(-1)).toBe(1_000); // not yet
    act(() => vi.advanceTimersByTime(1));
    expect(seen.at(-1)).toBe(31_000); // 1_000 start + the 30 s default
    act(() => root.unmount());
  });
});

describe('clockTime', () => {
  it('renders a zero-padded 24-hour hh:mm', () => {
    expect(clockTime(Date.UTC(2026, 8, 7, 9, 5))).toBe('09:05');
    expect(clockTime(Date.UTC(2026, 8, 7, 23, 59))).toBe('23:59');
    expect(clockTime(Date.UTC(2026, 8, 7, 0, 0))).toBe('00:00');
  });

  // G54's catcher. Under the suite's TZ=UTC pin, local and UTC minutes always agree, so a
  // `getHours()`/`getUTCMinutes()` mix is invisible. In a HALF-HOUR zone it is not: 09:05Z is
  // 14:35 in Asia/Kolkata, and the mixed pair renders 14:05. Node 24 re-reads process.env.TZ on
  // the next Date operation, so this needs no subprocess (verified: 14/35 from a mid-process set).
  it('uses local time for both halves, which only a half-hour zone can show', () => {
    // `vi.stubEnv`, not `process.env.TZ = …`: `tsconfig.web.json` gives the renderer no node types
    // (rule 9), so naming `process` here is a TS2591 that vitest itself would never catch — it
    // does not typecheck. Node re-reads TZ on the next Date operation, so no subprocess is needed.
    try {
      vi.stubEnv('TZ', 'Asia/Kolkata');
      expect(clockTime(Date.UTC(2026, 8, 7, 9, 5))).toBe('14:35');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(clockTime(Date.UTC(2026, 8, 7, 9, 5))).toBe('09:05');
  });
});
