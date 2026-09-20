import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

// The thresholds moved to `shared/disk.ts` — the renderer's low-disk banner (§12.7) needs the same
// numbers and cannot import this file, which reaches for `node:fs`. Measuring stays here.

/**
 * Free bytes on the volume holding `path` (or its nearest existing ancestor).
 *
 * `statfsSync`, not `df`: parsing `df` means guessing at a header that varies by platform, at `-k`
 * vs `-h` units, and at a "Mounted on" column that can contain spaces — and Rule 1 would make it an
 * `execFile` with an argv array anyway, so there is no shell-quoting saving either. `statfsSync`
 * returns the numbers `df` prints, from the same `statfs(2)`.
 *
 * Checked against the tool it replaces, on this machine's `$HOME`: `bavail * bsize` =
 * 280,497,721,344 B, `df -k` Available = 273,923,552 KiB = 280,497,717,248 B — one 4 KiB block
 * apart, which is two `statfs` calls milliseconds apart on a live volume. `df -h` printed `261Gi`
 * for the same volume: GiB, not GB, which is the unit trap a parser walks into and this does not.
 *
 * `bavail`, not `bfree`: POSIX `bavail` is what is available to a non-privileged process, `bfree`
 * includes root's reserve. (They were equal on this APFS volume when measured, so the choice is
 * made on the definition rather than on an observed gap.)
 *
 * Walking up to an existing ancestor is what makes this answerable BEFORE `ensureDirs` has run, and
 * for a worktrees dir that does not exist yet. It reports the ancestor's volume, which is the same
 * volume unless a mount point sits between the two.
 */
export function freeBytes(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return s.bavail * s.bsize;
}

/** 2 dp, not 1: at 1 dp a refusal at 1.96 GB reads "only 2.0 GB free … at least 2.0 GB is
 *  required", and spec §10.2 promises the exact numbers. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
