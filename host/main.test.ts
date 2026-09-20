import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLineParser, encode } from '../shared/host-protocol.ts';
import { tempDir } from '../test/fixtures/tmp.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function waitFor(pred: () => boolean, ms = 8000, what = 'condition', detail = () => ''): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}${detail() === '' ? '' : `; host stderr: ${detail()}`}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function pingOnce(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.setEncoding('utf8');
    const p = createLineParser({ onLine: (l) => { resolve(JSON.parse(l).t); s.destroy(); }, onOverflow: () => {} });
    s.on('data', (c: string) => p.push(c));
    s.on('connect', () => s.write(encode({ t: 'ping', seq: 1 })));
    s.on('error', reject);
  });
}

describe('host/main.ts', () => {
  // Reap both, and in this order. A leaked directory per run is untidy; leaking a real daemon —
  // which every failure before the shutdown message used to do — is worse, especially with its
  // HANGAR_HOME then deleted out from under it.
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });

  function startHost(env: NodeJS.ProcessEnv): { child: ChildProcess; stderr: () => string } {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(repoRoot, 'host/main.ts')], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    let err = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { err += c; });
    return { child, stderr: () => err };
  }

  function newHome(): string {
    const home = tempDir('main');
    return home;
  }

  it('starts, writes a pidfile, answers on the socket, and cleans up on shutdown', async () => {
    const home = newHome();
    const { child, stderr } = startHost({ ...process.env, HANGAR_HOME: home });
    const socketPath = join(home, 'run', 'host.sock');
    const pidFile = join(home, 'run', 'host.pid');
    await waitFor(() => existsSync(socketPath) && existsSync(pidFile), 8000, 'startup', stderr);
    expect(Number(readFileSync(pidFile, 'utf8').trim())).toBe(child.pid);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700); // §16: run/ is the access boundary
    expect(await pingOnce(socketPath)).toBe('pong');

    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const s = net.createConnection(socketPath);
    s.on('connect', () => s.write(encode({ t: 'shutdown', killSessions: true, seq: 2 })));
    expect(await exited).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(readFileSync(join(home, 'logs', 'host.log'), 'utf8')).toContain('host started');
  });

  it('rejects a missing HANGAR_HOME with exit 2 and a named error', async () => {
    const env = { ...process.env };
    delete env.HANGAR_HOME;
    const { child, stderr } = startHost(env);
    expect(await new Promise<number | null>((r) => child.on('exit', r))).toBe(2);
    expect(stderr()).toContain('HANGAR_HOME is required');
  });

  it('ignores SIGHUP and shuts down cleanly on SIGTERM (spec §8.2 Signals, G11)', async () => {
    const home = newHome();
    const { child, stderr } = startHost({ ...process.env, HANGAR_HOME: home });
    const socketPath = join(home, 'run', 'host.sock');
    const pidFile = join(home, 'run', 'host.pid');
    await waitFor(() => existsSync(socketPath) && existsSync(pidFile), 8000, 'startup', stderr);

    child.kill('SIGHUP'); // G11: a detached child receives this when its launching terminal closes
    expect(await pingOnce(socketPath)).toBe('pong');
    expect(child.exitCode).toBeNull();

    const exited = new Promise<number | null>((r) => child.on('exit', r));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('refuses a second host on a live HANGAR_HOME without disturbing the first', async () => {
    const home = newHome();
    const first = startHost({ ...process.env, HANGAR_HOME: home });
    const socketPath = join(home, 'run', 'host.sock');
    const pidFile = join(home, 'run', 'host.pid');
    await waitFor(() => existsSync(socketPath) && existsSync(pidFile), 8000, 'first host', first.stderr);

    const second = startHost({ ...process.env, HANGAR_HOME: home });
    expect(await new Promise<number | null>((r) => second.child.on('exit', r))).toBe(1);
    expect(second.stderr()).toMatch(/already (listening|using)/);
    // The loser must not have stolen the socket or removed the winner's pidfile — see the
    // two-hosts-on-one-socket warning in host/server.ts.
    expect(await pingOnce(socketPath)).toBe('pong');
    expect(Number(readFileSync(pidFile, 'utf8').trim())).toBe(first.child.pid);
  });
});
