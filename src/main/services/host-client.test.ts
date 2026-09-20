import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type HostHandle } from '../../../host/server.ts';
import { createLineParser, encode } from '../../../shared/host-protocol.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { HostRequestError, createHostClient, type HostClient } from './host-client.ts';

let n = 0;
const sock = () => `/tmp/hangar-hc-${process.pid}-${++n}.sock`;
const envStrings = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
const hosts: HostHandle[] = [];
const clients: HostClient[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close(true);
  for (const s of servers.splice(0)) s.close();
});

/**
 * A hand-rolled host that answers `hello` and otherwise sends exactly the frames a test asks for.
 * The real host cannot produce a reply with an unknown `re`, so reproducing that hazard needs a
 * server that will emit malformed correlation on demand.
 */
function rawHost(opts: { answerHello?: boolean } = {}): Promise<{
  path: string;
  send: (m: Record<string, unknown>) => void;
  drop: () => void;
  connections: () => number;
}> {
  const socketPath = sock();
  const answerHello = opts.answerHello !== false;
  let count = 0;
  return new Promise((resolve) => {
    let conn: net.Socket | null = null;
    const server = net.createServer((c) => {
      conn = c;
      count += 1;
      c.setEncoding('utf8');
      const parser = createLineParser({
        onLine: (line) => {
          const m = JSON.parse(line) as { t: string; seq?: number };
          if (m.t === 'hello' && answerHello) c.write(JSON.stringify({ t: 'hello', version: 1, hostPid: process.pid, sessions: [], re: m.seq }) + '\n');
        },
        onOverflow: () => {},
      });
      c.on('data', (chunk: string) => parser.push(chunk));
      c.on('error', () => {});
    });
    servers.push(server);
    server.listen(socketPath, () =>
      resolve({
        path: socketPath,
        send: (m) => void conn?.write(JSON.stringify(m) + '\n'),
        drop: () => conn?.destroy(),
        connections: () => count,
      }),
    );
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `label` is required: a bare 'timeout' in CI names neither the condition nor the test. */
async function until(pred: () => boolean, label: string, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for: ${label}`);
    await sleep(15);
  }
}

describe('createHostClient', () => {
  it('connects, says hello, correlates requests and streams events', async () => {
    const socketPath = sock();
    hosts.push(await createHost({ socketPath, log: () => {} }));
    const client = createHostClient({ socketPath, clientId: 't', log: () => {} });
    clients.push(client);
    const connectedEvents: number[] = [];
    client.on('connected', (h) => connectedEvents.push(h.sessions.length));
    const hello = await client.connect();
    expect(hello.version).toBe(1);
    expect(connectedEvents).toEqual([0]);
    expect(client.isConnected()).toBe(true);

    const data: string[] = [];
    const exits: number[] = [];
    client.on('data', (_id, d) => data.push(d));
    client.on('exit', (_id, code) => exits.push(code));
    const spawned = await client.request({ t: 'spawn', id: 'x', cwd: '/tmp', file: '/bin/sh', args: ['-c', 'echo HI; sleep 10'], env: envStrings(), cols: 80, rows: 24 });
    expect(spawned.t).toBe('spawned');
    const snap = await client.request({ t: 'attach', id: 'x', cols: 80, rows: 24 });
    expect(snap.t).toBe('snapshot');
    // Either sink, because which one carries `HI` is a race the test cannot win: `host/server.ts`
    // routes `onData` through `toAttached`, so anything the PTY printed BEFORE this attach landed
    // is in the snapshot and is never replayed as a `data` frame. `echo HI` beats the attach by
    // ~20 ms of scheduling, which the suite provides under load — measured: at delay=0 the byte is
    // in `data` and not the snapshot, at delay=20 ms the reverse. Asserting on `data` alone timed
    // out about once in fifteen full-suite runs.
    const snapshotText = snap.t === 'snapshot' ? snap.data : '';
    await until(() => (snapshotText + data.join('')).includes('HI'), 'pty output to reach the client');
    await client.request({ t: 'kill', id: 'x', signal: 'SIGKILL' });
    await until(() => exits.length === 1, 'the kill to report an exit');
  });

  it('rejects with HostRequestError on host errors and timeouts', async () => {
    const socketPath = sock();
    hosts.push(await createHost({ socketPath, log: () => {} }));
    const client = createHostClient({ socketPath, clientId: 't', log: () => {} });
    clients.push(client);
    await client.connect();
    const err = await client.request({ t: 'attach', id: 'ghost', cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRequestError);
    expect((err as HostRequestError).code).toBe('NOT_FOUND');

    const silentPath = sock();
    const silent = net.createServer(() => {});
    servers.push(silent);
    silent.listen(silentPath);
    const quiet = createHostClient({ socketPath: silentPath, clientId: 't', log: () => {}, reconnect: false });
    clients.push(quiet);
    const t = await quiet.connect().catch((e: unknown) => e); // hello never answered → timeout
    expect((t as HostRequestError).code).toBe('TIMEOUT');
    silent.close();
  }, 15_000);

  it('relays agent events and reconnects after the host restarts', async () => {
    const socketPath = sock();
    const first = await createHost({ socketPath, log: () => {} });
    hosts.push(first);
    const client = createHostClient({ socketPath, clientId: 't', log: () => {}, backoffMs: { min: 20, max: 100 } });
    clients.push(client);
    const events: string[] = [];
    client.on('agentEvent', (agentId, cmd) => events.push(`${agentId}:${cmd}`));
    client.on('disconnected', () => events.push('disconnected'));
    client.on('connected', () => events.push('connected'));
    await client.connect();

    const cli = net.createConnection(socketPath);
    cli.on('connect', () => cli.write(encode({ t: 'cli', agentId: 'ag', cmd: 'rename', payload: { name: 'N' } })));
    await until(() => events.includes('ag:rename'), 'the cli agent event to be relayed');
    cli.destroy();

    await first.close(true);
    hosts.splice(hosts.indexOf(first), 1);
    await until(() => events.includes('disconnected'), 'the client to notice the host died');
    expect(client.isConnected()).toBe(false);
    hosts.push(await createHost({ socketPath, log: () => {} }));
    await until(() => events.filter((e) => e === 'connected').length === 2, 'the client to reconnect to the new host');
    expect(client.isConnected()).toBe(true);
  });

  it('never treats a correlated snapshot as an unsolicited event', async () => {
    const raw = await rawHost();
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: () => {}, reconnect: false });
    clients.push(client);
    await client.connect();
    const snapshots: string[] = [];
    const datas: string[] = [];
    client.on('snapshot', (id) => snapshots.push(id));
    client.on('data', (_id, d) => datas.push(d));

    // A reply correlating to a seq we do not hold — a duplicate, or one we already settled. The
    // renderer resets the terminal before writing a snapshot (spec §7), so emitting this as
    // unsolicited would wipe a live pane.
    raw.send({ t: 'snapshot', id: 'x', data: 'WIPE', title: 'T', re: 9996 });
    // Ordering barrier: NDJSON on one socket is ordered, so once this arrives the snapshot above
    // has already been handled. Cheaper and steadier than sleeping.
    raw.send({ t: 'data', id: 'x', data: 'sentinel' });
    await until(() => datas.includes('sentinel'), 'the ordering barrier after the bogus snapshot');
    expect(snapshots).toEqual([]);

    // A genuinely unsolicited snapshot — no `re` — is still the Restart push and must get through.
    raw.send({ t: 'snapshot', id: 'y', data: 'D', title: 'T' });
    await until(() => snapshots.includes('y'), 'the unsolicited restart snapshot');
  });

  it('blames a throwing listener rather than the host, and still runs later listeners', async () => {
    const raw = await rawHost();
    const logs: string[] = [];
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: (l) => logs.push(l), reconnect: false });
    clients.push(client);
    await client.connect();
    const seen: string[] = [];
    const bells: string[] = [];
    client.on('data', () => {
      throw new Error('listener boom');
    });
    client.on('data', (_id, d) => seen.push(d));
    client.on('bell', (id) => bells.push(id));

    raw.send({ t: 'data', id: 'x', data: 'payload' });
    raw.send({ t: 'bell', id: 'x' });
    await until(() => bells.length === 1, 'dispatch to continue past the throwing listener');
    // The second listener must still see the event: `emit` iterates a Set, so an unguarded throw
    // aborts dispatch part-way through.
    expect(seen).toEqual(['payload']);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
    // The throw came from our own listener; reporting it as a host framing fault sends anyone
    // debugging it to the wrong process.
    expect(logs.some((l) => l.includes('invalid JSON'))).toBe(false);
  });

  it('does not hold a process open with nothing but a pending reconnect timer', async () => {
    const dir = tempDir('hc-unref');
    const probe = path.join(dir, 'probe.mjs');
    const clientPath = fileURLToPath(new URL('./host-client.ts', import.meta.url));
    writeFileSync(
      probe,
      `import { createHostClient } from ${JSON.stringify(clientPath)};\n` +
        `const c = createHostClient({ socketPath: '/tmp/hangar-absent-${process.pid}.sock', clientId: 'p', log: () => {}, backoffMs: { min: 50, max: 100 } });\n` +
        `c.connect().catch(() => {});\n`,
    );
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', probe], { stdio: 'ignore' });
      const killer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.on('exit', (code) => {
        clearTimeout(killer);
        resolve(code);
      });
    });
    // null means we had to SIGKILL it: a self-rescheduling retry timer was the only thing left.
    expect(exitCode).toBe(0);
  }, 15_000);

  it('rejects a second connect() rather than churning the live connection', async () => {
    const socketPath = sock();
    hosts.push(await createHost({ socketPath, log: () => {} }));
    const client = createHostClient({ socketPath, clientId: 't', log: () => {} });
    clients.push(client);
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));
    await client.connect();

    const err = await client.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRequestError);
    expect((err as HostRequestError).code).toBe('ALREADY_CONNECTED');
    // The live connection must be untouched: replacing it rejected in-flight work on the NEW
    // socket and emitted a spurious disconnect.
    const pong = await client.request({ t: 'ping' });
    expect(pong.t).toBe('pong');
    expect(events).toEqual(['connected']);
  });

  it('settles connect() when close() lands in the pre-connect window', async () => {
    const raw = await rawHost();
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: () => {} });
    clients.push(client);
    // close() between createConnection and the `connect` event: destroy() emits `close` but no
    // `error`, so nothing else in connect() can ever settle the promise.
    const p = client.connect();
    client.close();
    const outcome: unknown = await Promise.race([p.catch((e: unknown) => e), sleep(2_000).then(() => 'UNSETTLED')]);
    expect(outcome).toBeInstanceOf(HostRequestError);
    expect((outcome as HostRequestError).code).toBe('DISCONNECTED');
  });

  it('rejects with the raw socket errno when no host is listening', async () => {
    // The first-run path: no host has ever started, so the socket file does not exist. §8.3 step 2
    // branches on this errno, so it must arrive unwrapped.
    const client = createHostClient({ socketPath: sock(), clientId: 't', log: () => {}, reconnect: false });
    clients.push(client);
    const err = await client.connect().catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('stops reconnecting after close(), and connect() re-arms it', async () => {
    const raw = await rawHost({ answerHello: false });
    const client = createHostClient({
      socketPath: raw.path,
      clientId: 't',
      log: () => {},
      requestTimeoutMs: 60,
      backoffMs: { min: 20, max: 30 },
    });
    clients.push(client);
    await client.connect().catch(() => {}); // hello never answered → TIMEOUT, retry scheduled
    await until(() => raw.connections() >= 2, 'the client to start retrying');
    client.close();
    const settled = raw.connections();
    await sleep(300); // many backoff periods
    expect(raw.connections()).toBe(settled);

    // close() must not be permanently terminal: §8.3's launcher closes, restarts the host, and
    // reconnects, and nothing types close() as one-shot.
    const live = await rawHost();
    const client2 = createHostClient({ socketPath: live.path, clientId: 't', log: () => {}, backoffMs: { min: 20, max: 40 } });
    clients.push(client2);
    await client2.connect();
    client2.close();
    await client2.connect();
    expect(client2.isConnected()).toBe(true);
    const seen: string[] = [];
    client2.on('connected', () => seen.push('connected'));
    live.drop();
    await until(() => seen.length === 1, 'automatic reconnect to work again after close()+connect()');
  });

  it('drops a reply that arrives after its timeout instead of emitting it', async () => {
    const raw = await rawHost();
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: () => {}, requestTimeoutMs: 80, reconnect: false });
    clients.push(client);
    await client.connect();
    const snapshots: string[] = [];
    const datas: string[] = [];
    client.on('snapshot', (id) => snapshots.push(id));
    client.on('data', (_id, d) => datas.push(d));

    const err = await client.request({ t: 'attach', id: 'x', cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect((err as HostRequestError).code).toBe('TIMEOUT');
    // The host finally answers, long after we gave up. seq 2: hello was seq 1.
    raw.send({ t: 'snapshot', id: 'x', data: 'LATE', title: 'T', re: 2 });
    raw.send({ t: 'data', id: 'x', data: 'sentinel' });
    await until(() => datas.includes('sentinel'), 'the ordering barrier after the late reply');
    expect(snapshots).toEqual([]);
  });

  it('does not leave a retry timer stacking against a live connection', async () => {
    const raw = await rawHost();
    const logs: string[] = [];
    const client = createHostClient({
      socketPath: raw.path,
      clientId: 't',
      log: (l) => logs.push(l),
      backoffMs: { min: 20, max: 400 },
    });
    clients.push(client);
    await client.connect();
    raw.drop();
    await until(() => !client.isConnected(), 'the client to notice the server-side cut');
    // The consumer reconnects itself — the natural "reconnect on disconnected" pattern — racing
    // the retry timer already queued.
    await client.connect().catch(() => {});
    await until(() => client.isConnected(), 'the consumer-initiated reconnect');

    // Counting scheduled retries, not timing a reconnect: an unguarded timer fires against the
    // live connection, is rejected ALREADY_CONNECTED, and reschedules — so the count climbs
    // forever. A timing assertion here only measures where in the backoff window the drop landed.
    const scheduled = () => logs.filter((l) => l.startsWith('reconnecting')).length;
    const at = scheduled();
    await sleep(300); // several backoff doublings' worth
    expect(scheduled()).toBe(at);
    expect(client.isConnected()).toBe(true);
  });

  it('surfaces an uncorrelated host error as an event, not just a log line', async () => {
    const raw = await rawHost();
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: () => {}, reconnect: false });
    clients.push(client);
    await client.connect();
    const errors: string[] = [];
    client.on('hostError', (code) => errors.push(code));
    // §8.2 backpressure: the host cuts a client that stopped reading. Task 15 must be able to tell
    // that from a host that died, and only the code carries the difference.
    raw.send({ t: 'error', code: 'CLIENT_TOO_SLOW', message: 'write buffer over cap' });
    await until(() => errors.length === 1, 'the uncorrelated host error to reach a listener');
    expect(errors).toEqual(['CLIENT_TOO_SLOW']);
  });

  it('fails in-flight requests when the connection drops instead of hanging to timeout', async () => {
    const raw = await rawHost();
    const client = createHostClient({ socketPath: raw.path, clientId: 't', log: () => {}, reconnect: false });
    clients.push(client);
    await client.connect();
    // The raw host never answers `attach`, so this is genuinely in flight when the socket dies.
    const inFlight = client.request({ t: 'attach', id: 'x', cols: 80, rows: 24 });
    await sleep(30);
    raw.drop();
    const err = await inFlight.catch((e: unknown) => e);
    // DISCONNECTED promptly, not TIMEOUT five seconds later: the renderer is waiting on this.
    expect(err).toBeInstanceOf(HostRequestError);
    expect((err as HostRequestError).code).toBe('DISCONNECTED');
  });
});
