// Free-space thresholds and the low-disk banner's state machine — spec §12.7 and §12.8, G12.
//
// Here rather than in `src/main/util/disk.ts` because BOTH sides need the numbers and they must not
// drift: main refuses to create an agent under `MIN_FREE_FOR_WORKTREE`, and the renderer's banner
// text quotes that same figure as the reason the warning matters. This file imports nothing (Rule
// 9) — the measuring half, which needs `node:fs`, stays in main.

/**
 * Preflight floor for provisioning a worktree (`agent-service.create`). A copied `node_modules` and
 * a checkout have to fit; G12's re-measurement (279 GB free on this machine, not the 9 GB the
 * original note claimed) is why this is a floor and not a budget.
 */
export const MIN_FREE_FOR_WORKTREE = 2e9;

/**
 * §12.7: "low disk (< 5 GB, dismissable per launch)". STRICTLY below — exactly 5 GB is not low, and
 * `diskBannerStep` has a test at the boundary.
 */
export const LOW_DISK_WARN = 5e9;

/**
 * The banner's *clear* point, and the only number here the spec does not name.
 *
 * Not hysteresis for its own sake: the status bar re-measures every 60 s forever, and free space on
 * a machine running several agents moves by hundreds of MB between polls (a `npm ci`, a build, a
 * Spotlight reindex). With a single edge at 5 GB, free space resting anywhere near it makes the
 * banner appear and vanish on a 60 s cycle — a flap the user cannot act on. Raising at < 5 GB keeps
 * §12.7's promise exactly; the banner then stays until there is a real 500 MB of headroom above it.
 *
 * The asymmetry is deliberate and one-directional: this can only ever make the banner *stickier*
 * than the spec, never quieter.
 */
export const LOW_DISK_CLEAR = 5.5e9;

/**
 * 1 dp, matching §12.8's `9.1 GB free`.
 *
 * Deliberately NOT `formatGb` from `src/main/util/disk.ts`, which is 2 dp: that one renders a
 * REFUSAL ("only 1.96 GB free … at least 2.00 GB is required"), where rounding both numbers to
 * 2.0 makes the sentence read as a contradiction. A status bar has no such pairing and a second
 * decimal in a strip this dense is noise.
 */
export function formatFreeGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function lowDiskText(freeBytes: number): string {
  return `Low disk space: ${formatFreeGb(freeBytes)} free on the volume holding worktrees. New agents need at least ${formatFreeGb(MIN_FREE_FOR_WORKTREE)}.`;
}

/** The banner id, so the raiser and the "is it still there?" probe cannot disagree. */
export const DISK_BANNER_ID = 'disk';

export interface DiskBannerState {
  /** We raised the banner and have not cleared it ourselves since. */
  showing: boolean;
  /** The user dismissed it. Latched for the rest of the launch — §12.7's "dismissable per launch". */
  dismissed: boolean;
}

export const INITIAL_DISK_BANNER: DiskBannerState = { showing: false, dismissed: false };

export type DiskBannerEffect = { kind: 'none' } | { kind: 'raise'; text: string } | { kind: 'clear' };

/**
 * One poll's worth of banner decision, as a pure function so the caller is a two-line effect.
 *
 * `bannerPresent` is what makes "dismissable per launch" implementable without a new store concept:
 * the only way the disk banner leaves the ui store while we still think it is showing is the user
 * pressing its close button, because nothing else writes that id. So `showing && !bannerPresent`
 * IS the dismissal, observed one poll later, and it latches.
 *
 * The latch survives the disk recovering and filling again, which is the reading §12.7 asks for:
 * "per launch", not "until the condition clears". A user who has been told once and closed it does
 * not get told again until the app restarts — the status-bar figure, which is not dismissable,
 * carries the number in the meantime.
 */
export function diskBannerStep(state: DiskBannerState, freeBytes: number, bannerPresent: boolean): { state: DiskBannerState; effect: DiskBannerEffect } {
  const dismissed = state.dismissed || (state.showing && !bannerPresent);
  // Hysteresis: the edge to test against depends on which side we are already on.
  const low = state.showing ? freeBytes < LOW_DISK_CLEAR : freeBytes < LOW_DISK_WARN;
  // `bannerPresent`, not just `state.showing`: a banner the user has already closed does not need
  // clearing, and emitting one anyway would make the recovery path indistinguishable from the
  // dismissal path in a test that watches effects.
  if (!low) return { state: { showing: false, dismissed }, effect: state.showing && bannerPresent ? { kind: 'clear' } : { kind: 'none' } };
  if (dismissed) return { state: { showing: false, dismissed: true }, effect: { kind: 'none' } };
  // Re-raised on every low poll, not just the first: `setBanner` replaces by id, so this is what
  // keeps the GB figure in the banner as current as the one in the strip.
  return { state: { showing: true, dismissed: false }, effect: { kind: 'raise', text: lowDiskText(freeBytes) } };
}
