import { closeSync, existsSync, fstatSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { LOG_ROTATE_BYTES } from '../shared/constants.ts';

export interface FileLogger {
  write(line: string): void;
  close(): void;
}

export interface FileLoggerOptions {
  /** Injected clock, so tests can assert an exact timestamp. */
  now?: () => Date;
  limitBytes?: number;
  /** How many rotated generations to keep: `<file>.1` … `<file>.<keep>`. Default 1. */
  keep?: number;
}

/**
 * Rotate `file` if it exceeds `limitBytes`, keeping `keep` generations: `.N` shifts to `.N+1`,
 * the oldest is dropped, and `file` becomes `.1`. Returns true if it rotated.
 *
 * `host.log` keeps 1 (spec §8.2 sets no retention); `app.log` keeps 3 (spec §5.2).
 */
export function rotateIfLarge(file: string, limitBytes: number = LOG_ROTATE_BYTES, keep = 1): boolean {
  if (!existsSync(file)) return false;
  if (statSync(file).size <= limitBytes) return false;
  for (let n = keep - 1; n >= 1; n--) {
    if (existsSync(`${file}.${n}`)) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
  }
  renameSync(file, `${file}.1`);
  return true;
}

/**
 * Appending logger over one long-lived fd (sync on purpose: a daemon that is killed must not lose
 * its last lines, and the volumes are tiny — spec §8.2 forbids logging PTY data).
 *
 * Rotates on open AND while running. At-open-only would be enough for normal use — the host logs a
 * few lines per session — but the host is detached and outlives app restarts, and `host/main.ts`
 * logs a full stack on every `uncaughtException` *without exiting*. A repeating fault would then
 * grow `host.log` without bound for the life of the process. (If Task 11 ever changes to exit on
 * uncaught exceptions, this rationale weakens — but the rotation is still correct.)
 *
 * The rotation sequence renames with the fd still open, which POSIX allows, and only drops the old
 * descriptor once the replacement exists. Closing first would mean that any failure in between —
 * EACCES on the rename, or the logs directory removed under a running daemon — leaves `fd` closed
 * forever, so every later `write()` and `close()` throws EBADF. That is not survivable where this
 * is used: a throw inside an `uncaughtException` handler kills the process, and a throw from
 * `close()` in `shutdown()` skips `process.exit(0)` after the pidfile has already been removed,
 * orphaning a daemon that still holds the socket.
 *
 * Not in `shared/` despite Plan 02's main-process logger wanting the same core: `shared/` may not
 * import `node:*` (spec §5.1) because the renderer bundles it. `src/main` imports this instead.
 */
export function createFileLogger(file: string, options: FileLoggerOptions = {}): FileLogger {
  const now = options.now ?? (() => new Date());
  const limitBytes = options.limitBytes ?? LOG_ROTATE_BYTES;
  const keep = options.keep ?? 1;

  rotateIfLarge(file, limitBytes, keep);
  let fd = openSync(file, 'a');
  let size = fstatSync(fd).size;
  return {
    write(line: string) {
      size += writeSync(fd, `${now().toISOString()} ${line}\n`);
      if (size <= limitBytes) return;
      try {
        rotateIfLarge(file, limitBytes, keep);
        const next = openSync(file, 'a');
        closeSync(fd);
        fd = next;
        size = fstatSync(fd).size;
      } catch {
        // Rotation is unavailable (read-only dir, logs dir removed). Keep the working fd and
        // retry after another limit's worth of output rather than bricking the logger.
        size = 0;
      }
    },
    close() {
      closeSync(fd);
    },
  };
}
