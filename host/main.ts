// Session host daemon entry — spec §8.3. Usage: HANGAR_HOME=/path node host/main.ts
//
// Exit codes: 0 clean shutdown, 1 the host could not start or could not shut down cleanly
// (details in host.log), 2 invalid HANGAR_HOME.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSocketPathLength } from '../shared/host-protocol.ts';
import { createFileLogger } from './log.ts';
import type { HostHandle } from './server.ts';

function readPid(pidFile: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  const text = raw.trim();
  // Digits only. `Number()` read '1e3' as pid 1000 and '0x10' as 16, so a corrupt pidfile could
  // name a real, unrelated process — and the guard below would then refuse to start forever.
  // Kept identical to `readPid` in src/main/services/host-launcher.ts; change both together.
  if (!/^\d+$/.test(text)) return null;
  const n = parseInt(text, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `pid` look like a session host, as opposed to merely existing? A `kill -9`'d host leaves its
 * pidfile behind, and after enough pid churn it names an innocent stranger — at which point the
 * incumbent guard below refuses to start this host on every launch, forever.
 *
 * The needle is the trailing `host/main.ts`, not an absolute path: `npm run host` starts the daemon
 * by a relative path, so `ps` reports `node --disable-warning=… host/main.ts`.
 *
 * Mirrors `isHostProcess` in src/main/services/host-launcher.ts. It cannot be shared: `host/` must
 * not import from `src/main/`, and `shared/` source may not import `node:*`. Change both together.
 */
function isHostProcess(pid: number): boolean {
  const self = fileURLToPath(import.meta.url);
  const needle = `${basename(dirname(self))}/${basename(self)}`;
  try {
    return execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 }).includes(needle);
  } catch {
    // Unsure => treat it as a host. A wrong "no" here starts a second host over a live one; a wrong
    // "yes" costs a refusal whose message names the pidfile to delete.
    return true;
  }
}

/** stderr is asynchronous when it is a pipe, and `process.exit` does not flush it. */
function fail(message: string, code: number): never {
  writeSync(2, `hangar host: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const raw = process.env.HANGAR_HOME;
  if (!raw) fail('HANGAR_HOME is required', 2);
  // Resolved, not raw: a relative HANGAR_HOME would otherwise be interpreted against the launcher's
  // cwd here and against the agent's cwd in the CLI, and the two would disagree about where the
  // socket is with no error anywhere.
  const home = resolve(raw);

  const runDir = join(home, 'run');
  const logsDir = join(home, 'logs');
  const socketPath = join(runDir, 'host.sock');
  const pidFile = join(runDir, 'host.pid');

  // Before creating anything, so a doomed home leaves nothing behind. G9: macOS caps sun_path at
  // 104 bytes; `assertSocketPathLength` checks the real byte length against the shared limit —
  // don't second-guess it with a character count on HANGAR_HOME, which rejects working homes
  // (a 78-character home yields a 92-byte socket path, comfortably under the limit).
  try {
    assertSocketPathLength(socketPath);
  } catch (e) {
    fail(`HANGAR_HOME is too long — ${e instanceof Error ? e.message : String(e)}`, 2);
  }

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // Mode applies only on creation, so repair an existing run/ too: §16's same-uid guarantee rests
  // on this directory (there is no getpeereid check), and a profile restored by rsync/unzip/cloud
  // sync arrives at 0755 and keeps it.
  chmodSync(runDir, 0o700);
  mkdirSync(logsDir, { recursive: true });
  const logger = createFileLogger(join(logsDir, 'host.log'));
  const log = (line: string): void => logger.write(line);

  let host: HostHandle | null = null;
  let shuttingDown = false;

  /** Only remove a pidfile we still own — a failing second host must not delete a live host's. */
  function removeOwnPidfile(): void {
    try {
      if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
    } catch {
      // already gone, or replaced by a newer host — either way, not ours to remove
    }
  }

  async function shutdown(killSessions: boolean): Promise<void> {
    if (shuttingDown) {
      log(`shutdown already in progress; ignoring (killSessions=${killSessions})`);
      return;
    }
    shuttingDown = true;
    log(`shutdown killSessions=${killSessions}`);
    // Belt and braces: close() is internally bounded, but an operator who sees nothing happen
    // should not be left with a wedged daemon. The timer keeps the loop alive deliberately —
    // every path out of this function calls process.exit.
    const watchdog = setTimeout(() => {
      log('shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    let closeFailed = false;
    try {
      await host?.close(killSessions);
    } catch (e) {
      closeFailed = true;
      log(`close error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    clearTimeout(watchdog);
    removeOwnPidfile();
    logger.close();
    // Exiting 0 after a failed close would be indistinguishable from a clean shutdown, and a
    // failed close may have left PTYs alive or the socket in place.
    process.exit(closeFailed ? 1 : 0);
  }

  process.on('SIGHUP', () => log('ignoring SIGHUP'));
  process.on('SIGTERM', () => void shutdown(true));
  process.on('SIGINT', () => void shutdown(true));
  process.on('uncaughtException', (e) => log(`uncaughtException: ${e.stack ?? String(e)}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

  // Pidfile BEFORE listen, not after: §8.3 step 2's "a pidfile exists and the pid is alive, so the
  // host may be starting — wait and retry" branch is the only defence against two launchers racing
  // for one socket. Written after listen() it cannot fire during the ~300 ms of startup, which is
  // exactly the window that matters.
  //
  // But claiming it early means we must not clobber a live host's: refuse first. This also gives a
  // better diagnosis than the socket probe inside createHost, because it fires even in the window
  // before the incumbent has finished binding.
  const incumbent = readPid(pidFile);
  if (incumbent !== null && incumbent !== process.pid && isAlive(incumbent)) {
    // `isAlive` alone answers "does this pid exist", never "is this pid a host". Without the second
    // check a recycled pid in a crashed host's leftover pidfile refuses every future start, forever.
    if (isHostProcess(incumbent)) {
      log(`refusing to start: pid ${incumbent} already owns ${home}`);
      logger.close();
      fail(`another session host (pid ${incumbent}) is already using ${home}; if that process is gone, delete ${pidFile}`, 1);
    }
    log(`pidfile names live pid ${incumbent}, which is not a session host; treating ${pidFile} as stale`);
  }
  writeFileSync(pidFile, `${process.pid}\n`);

  try {
    // Dynamic import on purpose: server.ts -> session.ts -> node-pty is a native load, and an ABI
    // mismatch (Electron's 149 vs the system Node's 137, spec G2) throws during module evaluation.
    // A static import would throw before the logger exists, so §14's documented recovery — the
    // launcher reads host.log for NODE_MODULE_VERSION and suggests `npm rebuild node-pty` — would
    // have nothing to read.
    const { createHost } = await import('./server.ts');
    host = await createHost({ socketPath, log, onShutdownRequest: (kill) => void shutdown(kill) });
  } catch (e) {
    // The stack, not just the message: for a dlopen failure the stack is the part that names the file.
    log(`host failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    removeOwnPidfile();
    // Never unlink socketPath here: in the "already listening" case it belongs to a LIVE host.
    logger.close();
    fail(`failed to start: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  log(`host started pid=${process.pid} socket=${socketPath} node=${process.version}`);
}

// Entry guard (spec G6, Plan 01 Task 14): `shared/module-load.test.ts` imports every file under
// host/, cli/ and shared/ in a child Node process. Without this, importing this file STARTS A
// DAEMON — verified — and inside a Hangar agent session HANGAR_HOME is set, so that daemon would
// land on the user's real profile and outlive the test that started it.
// `import.meta.main` needs Node >= 24.2 and is experimental; §8.3's nodeBin fallback chain can end
// at the /usr/local/bin Node 22 of G4, where it is undefined — hence the argv[1] fallback.
const entryPath = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
if (import.meta.main ?? entryPath === import.meta.filename) await main();
