import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { encode } from '../../../shared/host-protocol.ts';
import { cleanEnv } from '../util/exec.ts';
import { HostStartError, checkProtocolVersion, ensureHost, isHostProcess, isPidAlive, probeSocket, readPid } from './host-launcher.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const hostMain = join(repoRoot, 'host', 'main.ts');

function deps(home: string, hostEntry = hostMain) {
  mkdirSync(join(home, 'run'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  return {
    socketPath: join(home, 'run', 'host.sock'),
    pidFile: join(home, 'run', 'host.pid'),
    hostLog: join(home, 'logs', 'host.log'),
    hostStdioLog: join(home, 'logs', 'host-stdio.log'),
    hostEntry,
    nodeBin: process.execPath,
    env: cleanEnv(process.env, { HANGAR_HOME: home }),
    log: () => {},
  };
}

async function stopHost(socketPath: string) {
  await new Promise<void>((resolve) => {
    const s = net.createConnection(socketPath);
    // `resume()` is load-bearing (G52). The host replies `{"t":"ok"}` and then destroys its side; a
    // socket with no 'data' listener stays PAUSED, so with buffered unread data it never emits
    // 'end', and with allowHalfOpen:false the auto-destroy that fires 'close' is driven by 'end'.
    // The await below then hangs forever — measured as a 20 s vitest timeout, not a flake.
    s.resume();
    s.on('connect', () => s.write(encode({ t: 'shutdown', killSessions: true })));
    s.on('close', () => resolve());
    s.on('error', () => resolve());
  });
  const start = Date.now();
  while (existsSync(socketPath) && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ensureHost', () => {
  // Anything this file starts, this file reaps — including on a failing assertion, which is when a
  // detached daemon would otherwise outlive the run with its HANGAR_HOME deleted out from under it.
  const strays: ChildProcess[] = [];
  const straySockets: string[] = [];
  afterEach(async () => {
    for (const s of straySockets.splice(0)) if (existsSync(s)) await stopHost(s);
    for (const c of strays.splice(0)) if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });

  // Spec §8.3 step 4 was implemented NOWHERE until this task — `PROTOCOL_VERSION` appeared only as
  // the value the client sends. All four quadrants, because an earlier draft branched on the version
  // direction and would have restarted an older host with live agents on it — the one thing §14
  // says must never be automatic.
  it('decides on live sessions, not on which side is newer', () => {
    expect(checkProtocolVersion(1, 1, 0)).toEqual({ action: 'ok' });
    expect(checkProtocolVersion(1, 1, 7)).toEqual({ action: 'ok' });

    const olderIdle = checkProtocolVersion(1, 2, 0);
    expect(olderIdle.action).toBe('restart');
    expect(olderIdle.action === 'restart' && olderIdle.reason).toMatch(/v1.*v2/);
    const newerIdle = checkProtocolVersion(3, 2, 0);
    expect(newerIdle.action).toBe('restart');

    const olderBusy = checkProtocolVersion(1, 2, 3);
    expect(olderBusy.action).toBe('read-only');
    expect(olderBusy.action === 'read-only' && olderBusy.reason).toContain('Session host is outdated (3 live sessions)');
    expect(olderBusy.action === 'read-only' && olderBusy.reason).toContain('running agents will be stopped');
    expect(olderBusy.action === 'read-only' && olderBusy.reason).toMatch(/v1.*v2/);
    const newerBusy = checkProtocolVersion(3, 2, 1);
    expect(newerBusy.action).toBe('read-only');
    expect(newerBusy.action === 'read-only' && newerBusy.reason).toContain('(1 live session)');
  });

  it('reads only a plain decimal pid', () => {
    const home = tempDir('launch-pid');
    const f = join(home, 'host.pid');
    writeFileSync(f, '4321\n');
    expect(readPid(f)).toBe(4321);
    // `Number()` accepted all of these: '1e3' read as pid 1000 and '0x10' as 16, either of which can
    // name a real, unrelated process — precisely the input the isHostProcess guard then has to
    // survive. A corrupt pidfile should read as no pidfile.
    for (const bad of ['1e3', '0x10', '', '-5', 'nope', '12.5', ' 7 7 ']) {
      writeFileSync(f, bad);
      expect(readPid(f)).toBeNull();
    }
    expect(readPid(join(home, 'absent.pid'))).toBeNull();
  });

  // Everything thrown out of ensureHost should be a HostStartError, so callers need one catch.
  // A socketPath that is a directory makes unlinkSync throw a raw EPERM.
  it('wraps a filesystem failure during cleanup in HostStartError', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    mkdirSync(d.socketPath);
    const err = await ensureHost(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect((err as HostStartError).message).toContain('could not clear the stale socket or pidfile');
  });

  it('spawns a detached host once, then finds it', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    straySockets.push(d.socketPath);
    expect(await ensureHost(d)).toEqual({ started: true });
    expect(await probeSocket(d.socketPath)).toBe(true);
    // The fast-path probe, not the retry loop: without the probe before the pidfile branch this
    // still returns {started:false}, but only 250 ms later. Measured at ~1 ms.
    const t0 = Date.now();
    expect(await ensureHost(d)).toEqual({ started: false });
    expect(Date.now() - t0).toBeLessThan(200);
    await stopHost(d.socketPath);
  });

  it('replaces a stale socket file and dead pidfile', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    straySockets.push(d.socketPath);
    writeFileSync(d.socketPath, 'stale');
    writeFileSync(d.pidFile, '999999');
    expect(isPidAlive(999999)).toBe(false);
    expect(await ensureHost(d)).toEqual({ started: true });
    await stopHost(d.socketPath);
  });

  // G10 credits the LAUNCHER with clearing a stale socket and pidfile, but deleting the unlink loop
  // entirely left the suite green: `createHost` probes-then-unlinks and host/main.ts overwrites a
  // dead incumbent's pidfile, so the host was quietly doing the launcher's job. Failing the spawn
  // means no host exists to cover for it, which pins the cleanup where G10 says it happens.
  it('clears the stale socket and pidfile itself, not via the host', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    writeFileSync(d.socketPath, 'stale');
    writeFileSync(d.pidFile, '999999');
    await expect(ensureHost({ ...d, nodeBin: '/nonexistent/node' })).rejects.toBeInstanceOf(HostStartError);
    expect(existsSync(d.socketPath)).toBe(false);
    expect(existsSync(d.pidFile)).toBe(false);
  });

  // A kill -9'd host leaves both files behind, and after enough pid churn the pidfile names an
  // innocent stranger. `isPidAlive` cannot tell the difference, so the (correct) refusal to unlink a
  // live host's socket used to fire forever — measured at ~2 s per launch, every launch.
  it('treats a pidfile naming a live non-host process as stale', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    straySockets.push(d.socketPath);
    const bystander = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    strays.push(bystander);
    await waitFor(() => bystander.pid !== undefined, 2000, 'bystander pid');
    const bystanderPid = bystander.pid as number;
    expect(isPidAlive(bystanderPid)).toBe(true);
    expect(isHostProcess(bystanderPid, d.hostEntry)).toBe(false);

    writeFileSync(d.socketPath, 'stale');
    writeFileSync(d.pidFile, `${bystanderPid}`);
    expect(await ensureHost(d)).toEqual({ started: true });
    expect(bystander.exitCode).toBeNull(); // and it did not touch the stranger
    await stopHost(d.socketPath);
  });

  // The other half of the same guard: a pid that really is a host must still be left alone, however
  // unresponsive. This one owns a different profile, so it never answers on ours.
  it('refuses rather than racing a live host, and names the pidfile', async () => {
    const other = tempDir('launch-other');
    const od = deps(other);
    straySockets.push(od.socketPath);
    expect(await ensureHost(od)).toEqual({ started: true });
    const livePid = parseInt(readFileSync(od.pidFile, 'utf8').trim(), 10);
    expect(isHostProcess(livePid, hostMain)).toBe(true);

    const home = tempDir('launch');
    const d = deps(home);
    writeFileSync(d.pidFile, `${livePid}`);
    const err = await ensureHost(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect((err as HostStartError).message).toContain(`pid ${livePid}`);
    expect((err as HostStartError).message).toContain(d.pidFile);
    expect(existsSync(od.socketPath)).toBe(true); // the incumbent is untouched
    await stopHost(od.socketPath);
  });

  // The retry branch (§8.3 step 2: "host may be starting — wait 250 ms, up to 8x"). Nothing
  // exercised it at all. The delay makes the first probe miss deterministically; the pidfile names
  // the starting process, which really is a host, so it reads as one.
  //
  // The delay is a top-level await in an `--import` module rather than a dynamic `import()` of the
  // entry, because host/main.ts's G6 entry guard (`import.meta.main ?? argv[1] === …`) deliberately
  // does NOT start a daemon when the file is merely imported. `--import` leaves argv[1] alone, so
  // the guard still fires — measured: no socket at 300 ms, socket at 1100 ms.
  it('waits for a host that is still starting instead of spawning a second one', async () => {
    const home = tempDir('launch');
    const d = deps(home);
    straySockets.push(d.socketPath);
    const slow = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--import', 'data:text/javascript,await new Promise((r) => setTimeout(r, 600));', hostMain],
      { env: d.env, stdio: 'ignore' },
    );
    strays.push(slow);
    const slowPid = slow.pid as number;
    writeFileSync(d.pidFile, `${slowPid}`);
    expect(isHostProcess(slowPid, hostMain)).toBe(true);
    expect(existsSync(d.socketPath)).toBe(false);
    expect(await ensureHost(d)).toEqual({ started: false });
    await stopHost(d.socketPath);
  });

  // G11 is the headline gotcha for this file, and deleting `child.unref()` OR flipping
  // `detached: true` to `false` both left the suite green. `unref` is what lets the launcher's
  // process exit while the host runs on; `detached` is what puts the host in its own process group,
  // so a signal aimed at the launcher's group misses it. This asserts both.
  it('leaves a host that outlives the process which started it', async () => {
    const home = tempDir('launch-outlive');
    const d = deps(home);
    straySockets.push(d.socketPath);
    const { log: _log, env: _env, ...serialisable } = d;
    const source = [
      `const { ensureHost } = await import(${JSON.stringify(join(repoRoot, 'src/main/services/host-launcher.ts'))});`,
      `const d = ${JSON.stringify(serialisable)};`,
      'd.log = () => {};',
      'd.env = { ...process.env };',
      'await ensureHost(d);',
    ].join('\n');
    const launcher = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], {
      env: d.env,
      stdio: 'ignore',
      detached: true,
    });
    strays.push(launcher);
    const launcherPid = launcher.pid as number;

    // Exits on its own => the child handle is unref'd. Without unref() it waits on the host forever.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('launcher did not exit; child.unref() missing?')), 10_000);
      launcher.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(await probeSocket(d.socketPath)).toBe(true);

    // The launcher was spawned detached, so its pid is its own process group id. A host spawned
    // with detached:true has left that group; one spawned with detached:false has not.
    try {
      process.kill(-launcherPid, 'SIGKILL');
    } catch {
      // ESRCH: the group is already empty, which is itself the detached-host outcome.
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(await probeSocket(d.socketPath)).toBe(true);
    await stopHost(d.socketPath);
  });

  it('reports a nodeBin that cannot be run, instead of crashing the process', async () => {
    const home = tempDir('launch-badnode');
    const err = await ensureHost({
      ...deps(home),
      nodeBin: '/nonexistent/node',
      startTimeoutMs: 3_000,
    }).then(() => null, (e: unknown) => e as HostStartError);
    expect(err).toBeInstanceOf(HostStartError);
    expect(err?.message).toContain('ENOENT');
    expect(err?.message).toContain('/nonexistent/node');
  });

  it('throws HostStartError with the log tail when the host cannot start', async () => {
    const home = tempDir('launch');
    const d = deps(home, join(home, 'missing-entry.ts'));
    const err = await ensureHost({ ...d, startTimeoutMs: 3000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect((err as HostStartError).logTail).toContain('missing-entry');
  });

  // The two sinks are a whole spec paragraph — createFileLogger RENAMES host.log on rotation, so a
  // launcher fd pointing there would silently write into host.log.1 from then on — yet the failure
  // path concatenates both tails, so pointing stdio at hostLog changed nothing the suite could see.
  it('sends the daemon stdio to host-stdio.log, never to host.log', async () => {
    const home = tempDir('launch');
    const d = deps(home, join(home, 'missing-entry.ts'));
    await expect(ensureHost({ ...d, startTimeoutMs: 3000 })).rejects.toBeInstanceOf(HostStartError);
    expect(existsSync(d.hostStdioLog)).toBe(true);
    expect(readFileSync(d.hostStdioLog, 'utf8')).toContain('missing-entry');
    expect(existsSync(d.hostLog)).toBe(false);
  });
});
