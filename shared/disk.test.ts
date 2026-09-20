/**
 * The low-disk banner's decisions — spec §12.7's "low disk (< 5 GB, dismissable per launch)".
 *
 * Every case here is an INJECTED number. Filling a real volume to test a threshold is not a test,
 * it is an outage, and the measuring half (`src/main/util/disk.ts`) is covered separately against
 * the real `statfs`.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_DISK_BANNER, LOW_DISK_CLEAR, LOW_DISK_WARN, MIN_FREE_FOR_WORKTREE,
  diskBannerStep, formatFreeGb, lowDiskText, type DiskBannerState,
} from './disk.ts';

/** Feeds a sequence of readings through the machine, mimicking the poll loop's own bookkeeping. */
function poll(readings: number[], opts: { dismissAfter?: number } = {}): { effects: string[]; texts: (string | null)[]; final: DiskBannerState } {
  let state = INITIAL_DISK_BANNER;
  let present = false;
  const effects: string[] = [];
  const texts: (string | null)[] = [];
  readings.forEach((free, i) => {
    const step = diskBannerStep(state, free, present);
    state = step.state;
    effects.push(step.effect.kind);
    texts.push(step.effect.kind === 'raise' ? step.effect.text : null);
    if (step.effect.kind === 'raise') present = true;
    if (step.effect.kind === 'clear') present = false;
    // The user pressing the banner's close button, between this poll and the next.
    if (opts.dismissAfter === i) present = false;
  });
  return { effects, texts, final: state };
}

describe('thresholds', () => {
  it('warns at the number §12.7 names, and clears above it', () => {
    expect(LOW_DISK_WARN).toBe(5e9);
    expect(MIN_FREE_FOR_WORKTREE).toBe(2e9);
    // The clear point is hysteresis, and it may only ever make the banner stickier — never quieter
    // than the spec's edge.
    expect(LOW_DISK_CLEAR).toBeGreaterThan(LOW_DISK_WARN);
  });

  it('formats to §12.8s single decimal', () => {
    expect(formatFreeGb(9.14e9)).toBe('9.1 GB');
    expect(formatFreeGb(0)).toBe('0.0 GB');
    expect(formatFreeGb(280.4e9)).toBe('280.4 GB');
  });

  it('quotes the real preflight figure in the banner, so the two cannot drift', () => {
    // If `MIN_FREE_FOR_WORKTREE` moves, this sentence moves with it — the banner's whole claim is
    // that the number it names is the one `agent-service.create` will refuse below.
    expect(lowDiskText(4.2e9)).toBe('Low disk space: 4.2 GB free on the volume holding worktrees. New agents need at least 2.0 GB.');
  });
});

describe('diskBannerStep', () => {
  it('raises strictly BELOW 5 GB — the boundary itself is not low', () => {
    expect(diskBannerStep(INITIAL_DISK_BANNER, LOW_DISK_WARN, false).effect.kind).toBe('none');
    expect(diskBannerStep(INITIAL_DISK_BANNER, LOW_DISK_WARN - 1, false).effect).toMatchObject({ kind: 'raise' });
    expect(diskBannerStep(INITIAL_DISK_BANNER, LOW_DISK_WARN + 1, false).effect.kind).toBe('none');
  });

  it('re-raises on every low poll, so the figure in the banner tracks the one in the strip', () => {
    const r = poll([4e9, 3e9, 3e9]);
    expect(r.effects).toEqual(['raise', 'raise', 'raise']);
    expect(r.texts[0]).toContain('4.0 GB free');
    expect(r.texts[1]).toContain('3.0 GB free');
  });

  it('clears when the disk recovers, and only once', () => {
    const r = poll([4e9, 9e9, 9e9]);
    expect(r.effects).toEqual(['raise', 'clear', 'none']);
    expect(r.final).toEqual({ showing: false, dismissed: false });
  });

  /**
   * The flap. Free space on a machine running several agents moves by hundreds of MB between polls,
   * so a single edge at 5 GB makes the banner appear and vanish on a 60 s cycle for anyone resting
   * near it. Measured here as the difference between the two spellings: the readings below cross
   * 5 GB four times.
   */
  it('does not flap while free space hovers at the threshold', () => {
    const hovering = [4.9e9, 5.05e9, 4.95e9, 5.1e9, 4.8e9, 5.2e9];
    const r = poll(hovering);
    expect(r.effects).toEqual(['raise', 'raise', 'raise', 'raise', 'raise', 'raise']);
    // …and the control: with no hysteresis (clear edge == warn edge) the same readings flap.
    let state = INITIAL_DISK_BANNER;
    const naive = hovering.map((free) => {
      const raise = free < LOW_DISK_WARN;
      const effect = raise ? 'raise' : state.showing ? 'clear' : 'none';
      state = { showing: raise, dismissed: false };
      return effect;
    });
    expect(naive).toEqual(['raise', 'clear', 'raise', 'clear', 'raise', 'clear']);
  });

  it('clears once free space is genuinely clear of the band', () => {
    expect(poll([4e9, LOW_DISK_CLEAR - 1]).effects).toEqual(['raise', 'raise']);
    expect(poll([4e9, LOW_DISK_CLEAR]).effects).toEqual(['raise', 'clear']);
  });

  /** §12.7: "dismissable per launch". */
  it('never raises again after the user dismisses it', () => {
    const r = poll([4e9, 3e9, 2e9], { dismissAfter: 0 });
    expect(r.effects).toEqual(['raise', 'none', 'none']);
    expect(r.final.dismissed).toBe(true);
  });

  it('keeps the dismissal latched across a recovery and a second fall', () => {
    // Dismissed at 4 GB; the disk recovers to 20 GB and falls back to 1 GB. "Per launch", not
    // "until the condition clears" — the strip's own figure carries the number in the meantime.
    const r = poll([4e9, 20e9, 1e9], { dismissAfter: 0 });
    expect(r.effects).toEqual(['raise', 'none', 'none']);
  });

  it('does not mistake a banner it never raised for a dismissal', () => {
    // `showing` false and no banner present is the ordinary healthy state, polled forever.
    const r = poll([9e9, 9e9, 9e9]);
    expect(r.effects).toEqual(['none', 'none', 'none']);
    expect(r.final.dismissed).toBe(false);
  });
});
