import { describe, expect, it } from 'vitest';
import { RENDERER_CRASH_LIMIT, RENDERER_CRASH_WINDOW_MS, createRendererCrashHandler } from './renderer-crash.ts';

/** A handler on a clock of the test's own, recording every call in one ordered list. */
function harness(start = 1_000_000) {
  let clock = start;
  const calls: string[] = [];
  const logs: string[] = [];
  const onGone = createRendererCrashHandler({
    abandonRendererWork: () => calls.push('abandon'),
    reload: () => calls.push('reload'),
    giveUp: (crashes, reason) => calls.push(`give-up ${crashes} ${reason}`),
    log: (l) => logs.push(l),
    now: () => clock,
  });
  return { onGone, calls, logs, advance: (ms: number) => { clock += ms; } };
}

describe('createRendererCrashHandler', () => {
  it('reloads each crash up to the limit, abandoning the dead window’s work first each time', () => {
    const t = harness();
    for (let i = 0; i < RENDERER_CRASH_LIMIT; i += 1) t.onGone('crashed');
    expect(RENDERER_CRASH_LIMIT).toBe(3);
    expect(t.calls).toEqual(['abandon', 'reload', 'abandon', 'reload', 'abandon', 'reload']);
    expect(t.logs).toEqual(['renderer gone: crashed (1 in the last minute)', 'renderer gone: crashed (2 in the last minute)', 'renderer gone: crashed (3 in the last minute)']);
  });

  /**
   * The case this module exists for. The crash past the limit is never reloaded, so the reload's own
   * `did-start-loading` — which was the only thing that cancelled a dictation — never fires, and a
   * run alive at that moment kept the microphone open behind a window that would not paint again.
   */
  it('abandons the work on the crash it gives up on too — the one no reload will ever follow', () => {
    const t = harness();
    for (let i = 0; i <= RENDERER_CRASH_LIMIT; i += 1) t.onGone('oom');
    expect(t.calls.slice(-2)).toEqual(['abandon', 'give-up 4 oom']);
    expect(t.calls.filter((c) => c === 'reload')).toHaveLength(RENDERER_CRASH_LIMIT);
    expect(t.calls.filter((c) => c === 'abandon')).toHaveLength(RENDERER_CRASH_LIMIT + 1);
    expect(t.logs.at(-1)).toBe('renderer crashed repeatedly; not reloading again');
    // And every later crash in the same minute: abandoned, never reloaded.
    t.onGone('oom');
    expect(t.calls.slice(-2)).toEqual(['abandon', 'give-up 5 oom']);
  });

  it('counts crashes within a minute of the first, and starts again after that', () => {
    const t = harness();
    for (let i = 0; i < RENDERER_CRASH_LIMIT; i += 1) t.onGone('crashed');
    t.advance(RENDERER_CRASH_WINDOW_MS + 1);
    t.onGone('crashed');
    expect(t.calls.slice(-2)).toEqual(['abandon', 'reload']);
    expect(t.logs.at(-1)).toBe('renderer gone: crashed (1 in the last minute)');
  });
});
