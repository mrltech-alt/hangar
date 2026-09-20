// Find-or-spawn the session host — spec §8.3 and G10/G11. The host outlives the app on purpose.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname } from 'node:path';

export interface LauncherDeps {
  socketPath: string;
  pidFile: string;
  hostLog: string;
  hostStdioLog: string;
  hostEntry: string;
  nodeBin: string;
  env: Record<string, string>;
  log: (line: string) => void;
  probeIntervalMs?: number;
  startTimeoutMs?: number;
}

export class HostStartError extends Error {
  readonly logTail: string;
  constructor(message: string, logTail: string) {
    super(message);
    this.name = 'HostStartError';
    this.logTail = logTail;
  }
}

/**
 * Bounded on purpose. `ensureHost` awaits this at three points, and its `while (Date.now() <
 * deadline)` cannot re-evaluate while a probe is pending — so a `connect` that never completes
 * makes `ensureHost` outlive its own `startTimeoutMs` and hang Electron startup with no toast and
 * no error. Defensive rather than observed: a Unix-socket connect resolves in microseconds here,
 * and 1 s is ~1000x that.
 */
export function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    s.setTimeout(1_000, () => {
      s.destroy();
      resolve(false);
    });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      s.destroy();
      resolve(false);
    });
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Does `pid` look like a session host, as opposed to merely existing?
 *
 * `isPidAlive` answers "does this pid exist", never "is this pid ours", and the gap between those
 * two wedges the launcher permanently. A `kill -9`'d host leaves BOTH its pidfile and its socket
 * behind; after enough pid churn that pidfile names an innocent stranger, and the (correct) refusal
 * to unlink a live host's socket then fires on every launch forever. Measured: a pidfile pointing
 * at pid 1 (launchd) or at a live `/bin/sleep` produced a `HostStartError` after ~2 s on every
 * attempt. The never-unlink-a-live-host rule is right; it was just resting on an identity check too
 * weak to carry it.
 *
 * The needle is the trailing `host/main.ts`, NOT the absolute `hostEntry`. `npm run host` starts
 * the daemon by a relative path, so `ps` reports `node --disable-warning=… host/main.ts`; an
 * absolute-path comparison would classify a genuinely live host as a stranger and go on to unlink
 * the socket every one of its PTYs is attached to. Verified against a running host.
 */
export function isHostProcess(pid: number, hostEntry: string): boolean {
  const needle = `${basename(dirname(hostEntry))}/${basename(hostEntry)}`;
  try {
    // Argument array, no shell (spec §16). `-ww` because macOS `ps` truncates to terminal width
    // when stdout is a tty, and the launcher's own command line is already 127 bytes.
    const out = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
    return out.includes(needle);
  } catch {
    // `ps` exits non-zero for a pid that no longer exists, but it fails the same way if `ps` itself
    // cannot be run, and the two are indistinguishable here. Answer "yes, a host" when unsure: a
    // wrong "no" unlinks a live host's socket and strands every PTY on it, while a wrong "yes"
    // costs a refusal the user clears by deleting the pidfile — which the error now names.
    // (Unreachable for a dead pid in practice: callers check `isPidAlive` first.)
    return true;
  }
}

export function readPid(pidFile: string): number | null {
  let raw: string;
  try {
    // try/catch, not just `existsSync`: its twin in host/main.ts has one and this did not, so two
    // copies of one function disagreed about failure. A pidfile can vanish between the check and
    // the read, or be unreadable (EACCES on a restored profile), and an errno thrown from here
    // escapes `ensureHost` as something no caller is typed to catch.
    raw = readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  const text = raw.trim();
  // `Number()` accepted far more than pids: '1e3' became 1000 and '0x10' became 16, so a corrupt
  // pidfile could silently name a real, unrelated process. Only digits are a pid.
  if (!/^\d+$/.test(text)) return null;
  const n = parseInt(text, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function tailOf(file: string, lines = 20): string {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export type VersionVerdict =
  | { action: 'ok' }
  | { action: 'restart'; reason: string }
  | { action: 'read-only'; reason: string };

/**
 * Spec §8.3 step 4. The host **outlives the app on purpose**, so an app that has just been upgraded
 * routinely meets a host from the previous version — the normal case, not an error.
 *
 * The discriminator is the **live session count, not the version direction**. Spec §8.3 step 4: on
 * a mismatch, 0 live sessions → `shutdown{killSessions:true}`, wait for exit, respawn; otherwise
 * keep the connection read-only and show the restart banner. §14 is blunt about why — *"Host
 * protocol version mismatch with live sessions | Banner with explicit restart action (kills
 * sessions). **Never automatic.**"* An earlier draft of this function decided on the version
 * direction instead (older host → restart, newer host → read-only), which reads plausibly and is
 * wrong: an *older* host with running agents is the overwhelmingly common upgrade case, and
 * returning `restart` for it hands Task 18 a verdict whose only honest implementation kills live
 * agents with no prompt. Sessions are the user's work regardless of which build started them.
 *
 * The version numbers stay in `reason` because they are the useful thing in a log, but they must
 * never drive the branch.
 *
 * This is a decision, not an action: `ensureHost` only probes the socket, so it never sees a
 * handshake and cannot know either the version or the session count. The caller holds the `hello` —
 * Task 18's bootstrap acts on the verdict. Keeping the policy here, pure and greppable, is what
 * stops it being reinvented differently in the launcher and the registry.
 */
export function checkProtocolVersion(hostVersion: number, appVersion: number, liveSessions: number): VersionVerdict {
  if (hostVersion === appVersion) return { action: 'ok' };
  const versions = `host protocol v${hostVersion}, app v${appVersion}`;
  if (liveSessions === 0) {
    return { action: 'restart', reason: `the session host speaks a different protocol (${versions}) and has no live sessions, so it can be restarted without losing work` };
  }
  // Spec §8.3 step 4's banner text, verbatim apart from pluralising "session" — the branch is
  // reachable with exactly one.
  const plural = liveSessions === 1 ? 'session' : 'sessions';
  return {
    action: 'read-only',
    reason: `Session host is outdated (${liveSessions} live ${plural}). Restart it from Hangar → Restart Session Host; running agents will be stopped. (${versions})`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureHost(deps: LauncherDeps): Promise<{ started: boolean }> {
  if (await probeSocket(deps.socketPath)) return { started: false };

  const pid = readPid(deps.pidFile);
  // Both halves matter. `isPidAlive` alone let a recycled pid wedge every future launch; see
  // `isHostProcess`. A pid that is alive but is not a host means the pidfile is stale in the only
  // way that matters here, so it falls through to the cleanup below.
  if (pid !== null && isPidAlive(pid) && isHostProcess(pid, deps.hostEntry)) {
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      if (await probeSocket(deps.socketPath)) return { started: false };
    }
    // Do NOT unlink and respawn over a host that is still alive. A transient probe failure
    // (EMFILE, a momentarily full accept backlog) would otherwise leave the incumbent holding an
    // unlinked-inode socket with every PTY on it — unreachable and unkillable except by pid — and
    // removing its pidfile defeats host/main.ts's own incumbent guard. This is exactly the failure
    // createHost's pre-bind probe exists to prevent; surface it instead of racing it.
    if (isPidAlive(pid)) {
      throw new HostStartError(
        // Name the pidfile, not just the socket: deleting it is the user's way out, and an error
        // that mentions only the socket gives them no way to know that.
        `another session host (pid ${pid}) owns this profile but is not answering on ${deps.socketPath}; if that process is gone, delete ${deps.pidFile}`,
        tailOf(deps.hostLog),
      );
    }
    deps.log(`host pid ${pid} died while starting; cleaning up and respawning`);
  } else if (pid !== null && isPidAlive(pid)) {
    deps.log(`pidfile names live pid ${pid}, which is not a session host; treating ${deps.pidFile} as stale`);
  }
  // Only reached when no live host owns the profile, so these are genuinely stale (G10).
  try {
    for (const f of [deps.socketPath, deps.pidFile]) if (existsSync(f)) unlinkSync(f);
  } catch (e) {
    // Everything thrown out of ensureHost is a HostStartError, so callers need one catch. Reachable:
    // a socketPath that is a directory gives EPERM, a read-only run/ gives EACCES.
    throw new HostStartError(`could not clear the stale socket or pidfile: ${e instanceof Error ? e.message : String(e)}`, tailOf(deps.hostLog));
  }

  let logFd: number;
  try {
    logFd = openSync(deps.hostStdioLog, 'a'); // not hostLog — see paths.ts
  } catch (e) {
    throw new HostStartError(`could not open ${deps.hostStdioLog}: ${e instanceof Error ? e.message : String(e)}`, tailOf(deps.hostLog));
  }
  // cwd is the host directory, where spec §8.3 step 2 writes repoRoot. It makes no difference to
  // the host — it resolves HANGAR_HOME itself and every PTY carries an explicit cwd — and the only
  // thing cwd could reach is a relative HANGAR_HOME, which the launcher never passes.
  const child = spawn(deps.nodeBin, ['--disable-warning=ExperimentalWarning', deps.hostEntry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: deps.env,
    cwd: dirname(deps.hostEntry),
  });
  // This listener is not optional. Without it a bad `nodeBin` emits an unhandled 'error' that
  // TERMINATES the process — measured: `spawn('/nonexistent/node')` exits 1 with
  // `Error: spawn /nonexistent/node ENOENT` and nothing after it runs. In Electron main that is the
  // whole app gone, with no dialog, caused by a stale `config.nodeBin` — the very value Task 5's
  // `pickNodeBin` writes back and Task 18 reads.
  //
  // It also has to be recorded rather than merely swallowed: on a spawn failure `child.exitCode`
  // stays `null`, so the probe loop below would spin the full startTimeoutMs before giving up, and
  // the error that actually explains it would never reach the user.
  //
  // A formatted string, not `ErrnoException | null`: TypeScript's control-flow analysis narrows a
  // `let` from its initializer and does NOT account for an assignment made inside a callback, so the
  // union version narrows to `never` at the read below and fails `tsc` while running perfectly.
  // Keeping the reason pre-formatted sidesteps that entirely and confines the cast to one place.
  let spawnError = '';
  child.on('error', (e) => {
    const err = e as NodeJS.ErrnoException;
    spawnError = err.code ?? err.message;
  });
  // `detached` + `unref()` together, and both are load-bearing (G11): `detached` gives the host its
  // own process group so a signal aimed at the app's group misses it, and `unref()` stops the
  // child's handle holding the app's event loop open. Removing either used to leave the suite green.
  child.unref();
  closeSync(logFd); // spawn dup'd it into the child; the parent's copy is a leak, once per call
  deps.log(`spawned session host pid=${child.pid ?? '?'} node=${deps.nodeBin} entry=${deps.hostEntry}`);

  const deadline = Date.now() + (deps.startTimeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (await probeSocket(deps.socketPath)) return { started: true };
    if (spawnError !== '') {
      throw new HostStartError(`could not run ${deps.nodeBin}: ${spawnError}`, tailOf(deps.hostStdioLog));
    }
    if (child.exitCode !== null) break;
    await sleep(deps.probeIntervalMs ?? 50);
  }
  // Both files: a failure before host/main.ts opens its own logger — a wrong-ABI node, a Node 22
  // that cannot run .ts at all, a missing entry — writes only to the stdio sink, and §14's
  // documented recovery ("read host.log for NODE_MODULE_VERSION, suggest npm rebuild node-pty")
  // depends on being able to see it.
  const tail = [tailOf(deps.hostLog), tailOf(deps.hostStdioLog)].filter((t) => t.length > 0).join('\n---\n');
  throw new HostStartError(`session host did not start (exit code ${child.exitCode ?? 'none'}); see ${deps.hostLog}`, tail);
}
