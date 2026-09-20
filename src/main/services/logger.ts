import { createFileLogger } from '../../../host/log.ts';

export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  close(): void;
}

/**
 * Wraps `host/log.ts`'s logger rather than repeating it. That file is the only place the rotation
 * rules live: rotate on open AND mid-run, rename with the fd still open so a failed rotation cannot
 * brick the descriptor, and keep N generations.
 *
 * Main's crash policy is NOT the host's, and Task 18's `index.ts` must not copy the wrong one:
 *   - `uncaughtException` — spec §14 ("Main crash (uncaught)"): log the stack to `app.log`, then the
 *     **process exits**. Host and sessions are unaffected and the next launch reattaches, which is
 *     exactly why exiting is affordable here and is not in the host.
 *   - `unhandledRejection` — spec §17 step 2: log and toast, **no exit**.
 * "Log and do not exit" is the host's policy for both (`host/main.ts`), and it is the reason
 * `host/log.ts` rotates mid-run at all. Main wants that rotation, just not that lifetime.
 *
 * `keep: 3` per spec §5.2 (`app.log` … rotated at 5 MB, keep 3); the host's `host.log` keeps 1.
 *
 * It lives under `host/` and not `shared/` because `shared/` may not import `node:*` (spec §5.1) —
 * the renderer bundles `shared/`. Importing it here is safe: it pulls in `node:fs` only, never a
 * native module, so the ABI split in G2 does not apply.
 */
export function createLogger(file: string, echoToConsole: boolean): Logger {
  const inner = createFileLogger(file, { keep: 3 });
  // The inner logger holds one long-lived fd, so a write after close — or a second close — throws
  // EBADF. Unreachable today, but both land where a throw is unrecoverable: `host/log.ts` makes the
  // point itself ("a throw from `close()` in `shutdown()` skips `process.exit(0)`"), and Task 18
  // writes main's quit path next, where the last call is a `close()` that must not be able to take
  // the exit down with it. So: idempotent close, and write-after-close is a silent no-op.
  let closed = false;
  const write = (level: string, line: string): void => {
    if (closed) return;
    inner.write(`${level} ${line}`);
    if (echoToConsole) console.log(`${new Date().toISOString()} ${level} ${line}`);
  };
  return {
    info: (l) => write('INFO', l),
    warn: (l) => write('WARN', l),
    error: (l) => write('ERROR', l),
    close: () => {
      if (closed) return;
      closed = true;
      inner.close();
    },
  };
}
