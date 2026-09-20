import net from 'node:net';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LINE_CHARS, PROTOCOL_VERSION, createLineParser, encode, type ClientMessage, type HostMessage } from '../shared/host-protocol.ts';
import { createHost, type HostHandle } from './server.ts';

let counter = 0;
const socketPathFor = () => `/tmp/hangar-test-${process.pid}-${++counter}.sock`;

function envStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function client(socketPath: string) {
  const socket = net.createConnection(socketPath);
  const received: HostMessage[] = [];
  const waiters: { pred: (m: HostMessage) => boolean; resolve: (m: HostMessage) => void }[] = [];
  socket.setEncoding('utf8');
  const parser = createLineParser({
    onLine: (line) => {
      const m = JSON.parse(line) as HostMessage;
      const w = waiters.find((x) => x.pred(m));
      if (w) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      } else {
        received.push(m);
      }
    },
    onOverflow: () => {},
  });
  socket.on('data', (c: string) => parser.push(c));
  let closed = false;
  socket.on('close', () => (closed = true));
  const ready = new Promise<void>((r) => socket.on('connect', () => r()));
  return {
    ready,
    send: (m: ClientMessage) => socket.write(encode(m)),
    /** Writes bytes verbatim — for testing malformed input, which `send` would JSON-encode. */
    raw: (text: string) => socket.write(text),
    /** Resolves with the first (buffered or future) message matching pred, removing it from the buffer. */
    take: (pred: (m: HostMessage) => boolean, ms = 5000) =>
      new Promise<HostMessage>((resolve, reject) => {
        const i = received.findIndex(pred);
        if (i !== -1) return resolve(received.splice(i, 1)[0]!);
        const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    isClosed: () => closed,
    /** Stop reading, so the kernel buffer fills and the host's write queue grows. */
    pause: () => socket.pause(),
    close: () => socket.destroy(),
  };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const spawnMsg = (id: string, script: string, extra: Partial<Extract<ClientMessage, { t: 'spawn' }>> = {}): ClientMessage => ({
  t: 'spawn', id, cwd: '/tmp', file: '/bin/sh', args: ['-c', script], env: envStrings(), cols: 80, rows: 24, ...extra,
});

const hosts: HostHandle[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close(true);
});

async function startHost(extra: Partial<Parameters<typeof createHost>[0]> = {}) {
  const socketPath = socketPathFor();
  const host = await createHost({ socketPath, log: () => {}, ...extra });
  hosts.push(host);
  return { socketPath, host };
}

describe('createHost', () => {
  it('answers hello with the protocol version and current sessions', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send({ t: 'hello', role: 'app', version: 1, clientId: 'test', seq: 1 });
    const hello = await c.take((m) => m.t === 'hello');
    expect(hello).toMatchObject({ t: 'hello', version: 1, sessions: [], re: 1 });
    c.close();
  });

  it('spawns, streams data to attached clients, reports exit, lists and disposes', async () => {
    const { socketPath, host } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send(spawnMsg('a1', 'echo READY; read l; echo GOT:$l; exit 3', { seq: 2 }));
    expect(await c.take((m) => m.t === 'spawned')).toMatchObject({ id: 'a1', re: 2 });
    c.send({ t: 'attach', id: 'a1', cols: 80, rows: 24, seq: 3 });
    expect(await c.take((m) => m.t === 'snapshot')).toMatchObject({ id: 'a1', re: 3 });
    await c.take((m) => m.t === 'data' && m.data.includes('READY'));
    c.send({ t: 'write', id: 'a1', data: 'hi\r' });
    await c.take((m) => m.t === 'data' && m.data.includes('GOT:hi'));
    const exitMsg = await c.take((m) => m.t === 'exit');
    expect(exitMsg).toMatchObject({ id: 'a1', exitCode: 3 });
    // `signal` must be present on the wire, not dropped: JSON.stringify omits undefined,
    // and the HostMessage type declares the field required.
    expect('signal' in (exitMsg as object)).toBe(true);
    c.send({ t: 'list', seq: 4 });
    const list = await c.take((m) => m.t === 'sessions');
    expect(list).toMatchObject({ sessions: [{ id: 'a1', exited: true, exitCode: 3 }] });
    c.send({ t: 'dispose', id: 'a1', seq: 5 });
    await c.take((m) => m.t === 'ok' && m.re === 5);
    expect(host.sessionCount()).toBe(0);
    c.close();
  });

  it('a later attach receives earlier output in its snapshot', async () => {
    const { socketPath } = await startHost();
    const a = client(socketPath);
    await a.ready;
    a.send(spawnMsg('b1', 'echo HELLO_SNAPSHOT; sleep 10'));
    await a.take((m) => m.t === 'spawned');
    a.send({ t: 'attach', id: 'b1', cols: 80, rows: 24 });
    await a.take((m) => m.t === 'snapshot');
    await a.take((m) => m.t === 'data' && m.data.includes('HELLO_SNAPSHOT'));

    const b = client(socketPath);
    await b.ready;
    b.send({ t: 'attach', id: 'b1', cols: 100, rows: 30, seq: 9 });
    const snap = await b.take((m) => m.t === 'snapshot');
    expect(snap.t === 'snapshot' && snap.data.includes('HELLO_SNAPSHOT')).toBe(true);
    b.send({ t: 'list', seq: 10 });
    const list = await b.take((m) => m.t === 'sessions');
    expect(list).toMatchObject({ sessions: [{ id: 'b1', cols: 100, rows: 30, attached: 2 }] });
    a.close();
    b.close();
  });

  it('runs startupCommand and rejects duplicate spawn while running', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send({ t: 'spawn', id: 'c1', cwd: '/tmp', file: '/bin/sh', args: ['-i'], env: envStrings(), cols: 80, rows: 24, startupCommand: 'echo BOOT_$((1+1)); sleep 10' });
    await c.take((m) => m.t === 'spawned');
    c.send({ t: 'attach', id: 'c1', cols: 80, rows: 24 });
    await c.take((m) => m.t === 'snapshot');
    await c.take((m) => m.t === 'data' && m.data.includes('BOOT_2'));
    c.send(spawnMsg('c1', 'true', { seq: 7 }));
    expect(await c.take((m) => m.t === 'error')).toMatchObject({ code: 'EXISTS', id: 'c1', re: 7 });
    c.close();
  });

  it('relays cli messages to app clients, queues them when none is connected, and bounds the queue', async () => {
    const { socketPath } = await startHost({ queueLimit: 2 });
    const cli = client(socketPath);
    await cli.ready;
    for (const n of [1, 2, 3]) {
      cli.send({ t: 'cli', agentId: 'ag1', cmd: 'note', payload: { n }, seq: n });
      await cli.take((m) => m.t === 'ok' && m.re === n);
    }
    const app = client(socketPath);
    await app.ready;
    app.send({ t: 'hello', role: 'app', version: 1, clientId: 'app' });
    await app.take((m) => m.t === 'hello');
    const q1 = await app.take((m) => m.t === 'agentEvent');
    const q2 = await app.take((m) => m.t === 'agentEvent');
    expect([q1, q2].map((m) => (m.t === 'agentEvent' ? (m.payload as { n: number }).n : -1))).toEqual([2, 3]);

    cli.send({ t: 'cli', agentId: 'ag1', cmd: 'rename', payload: { name: 'New' }, seq: 4 });
    await cli.take((m) => m.t === 'ok' && m.re === 4);
    expect(await app.take((m) => m.t === 'agentEvent')).toMatchObject({ agentId: 'ag1', cmd: 'rename', payload: { name: 'New' } });
    cli.close();
    app.close();
  });

  it('reports protocol errors without dropping the connection', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send({ t: 'ping', seq: 1 });
    await c.take((m) => m.t === 'pong');
    // An invalid `attach`, not an invalid `resize`: `resize` is one of the two messages §8.1 says
    // carries no `seq` at all, so using it here would contradict the contract being tested. The
    // point is that `re` is recovered from the RAW json when the schema rejects the message,
    // turning a 5 s client timeout into an immediate rejection.
    (c as unknown as { send: (m: unknown) => void }).send({ t: 'attach', id: 'x', cols: 0, rows: 0, seq: 2 });
    expect(await c.take((m) => m.t === 'error')).toMatchObject({ code: 'BAD_MESSAGE', re: 2 });
    c.raw('not json at all\n');
    expect(await c.take((m) => m.t === 'error')).toMatchObject({ code: 'BAD_JSON' });
    c.send({ t: 'ping', seq: 3 });
    await c.take((m) => m.t === 'pong' && m.re === 3);
    c.close();
  });

  it('drops the connection on an oversize line', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    // No newline: the parser accumulates until it passes the cap.
    c.raw('x'.repeat(MAX_LINE_CHARS + 1));
    expect(await c.take((m) => m.t === 'error')).toMatchObject({ code: 'LINE_TOO_LONG' });
    await waitFor(() => c.isClosed());
    expect(c.isClosed()).toBe(true);
  });

  it('re-snapshots still-attached clients when an exited id is respawned', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send(spawnMsg('r1', 'echo GEN1; exit 0'));
    await c.take((m) => m.t === 'spawned');
    c.send({ t: 'attach', id: 'r1', cols: 80, rows: 24, seq: 10 });
    await c.take((m) => m.t === 'snapshot' && m.re === 10);
    await c.take((m) => m.t === 'exit');

    // The app's Restart button respawns over the exited id, and the renderer does NOT re-attach
    // (its effect is keyed on agentId + pane). Without a pushed snapshot the pane would keep the
    // dead session's final screen and append the new session's output onto it.
    c.send(spawnMsg('r2-unused', 'true'));
    await c.take((m) => m.t === 'spawned');
    c.send(spawnMsg('r1', 'echo GEN2; sleep 5'));
    await c.take((m) => m.t === 'spawned' && m.id === 'r1');
    const snap = await c.take((m) => m.t === 'snapshot' && m.id === 'r1' && m.re === undefined);
    expect(snap).toMatchObject({ t: 'snapshot', id: 'r1' });
    c.close();
  });

  it('keeps a session running when the client attached to it disappears', async () => {
    const { socketPath, host } = await startHost();
    const a = client(socketPath);
    const b = client(socketPath);
    await a.ready;
    await b.ready;
    a.send(spawnMsg('s-live', 'while :; do echo tick; sleep 0.05; done'));
    await a.take((m) => m.t === 'spawned');
    b.send({ t: 'attach', id: 's-live', cols: 80, rows: 24, seq: 1 });
    await b.take((m) => m.t === 'snapshot');
    expect(host.clientCount()).toBe(2);

    b.close();
    await waitFor(() => host.clientCount() === 1);
    expect(host.sessionCount()).toBe(1);
    a.send({ t: 'list', seq: 2 });
    const list = (await a.take((m) => m.t === 'sessions')) as Extract<HostMessage, { t: 'sessions' }>;
    expect(list.sessions[0]).toMatchObject({ id: 's-live', exited: false, attached: 0 });
    a.close();
  });

  // node-pty does NOT throw for a bad cwd or a missing binary — verified on this machine, for
  // both. It reports success and the failure arrives asynchronously as a non-zero exit. So a
  // client cannot treat `spawned` as proof the shell is running, and the `SPAWN_FAILED` branch
  // only covers synchronous throws (out of pty slots, bad arguments).
  it('reports a doomed spawn as spawned-then-exited, and keeps serving', async () => {
    const { socketPath, host } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send({ t: 'hello', role: 'app', version: PROTOCOL_VERSION, clientId: 'test', seq: 0 });
    await c.take((m) => m.t === 'hello');
    c.send(spawnMsg('bad', 'true', { file: '/no/such/binary' }));
    await c.take((m) => m.t === 'spawned' && m.id === 'bad');
    const exit = (await c.take((m) => m.t === 'exit' && m.id === 'bad')) as Extract<HostMessage, { t: 'exit' }>;
    expect(exit.exitCode).not.toBe(0);
    expect(host.sessionCount()).toBe(1); // retained with exited:true, per §8.2
    c.send({ t: 'ping', seq: 9 });
    await c.take((m) => m.t === 'pong' && m.re === 9);
    c.close();
  });

  it('kill answers ok then exit, and reports NOT_FOUND for an unknown id', async () => {
    const { socketPath } = await startHost();
    const c = client(socketPath);
    await c.ready;
    c.send(spawnMsg('k', 'sleep 30'));
    await c.take((m) => m.t === 'spawned');
    c.send({ t: 'attach', id: 'k', cols: 80, rows: 24, seq: 3 });
    await c.take((m) => m.t === 'snapshot');
    c.send({ t: 'kill', id: 'k', seq: 4 });
    expect(await c.take((m) => m.t === 'ok' && m.re === 4)).toBeTruthy();
    expect(await c.take((m) => m.t === 'exit')).toMatchObject({ id: 'k' });

    c.send({ t: 'kill', id: 'ghost', seq: 5 });
    expect(await c.take((m) => m.t === 'error')).toMatchObject({ code: 'NOT_FOUND', id: 'ghost', re: 5 });
    c.close();
  });

  // The one failure mode that takes down every agent at once: an unread client grew host memory at
  // ~55 MB/s (+337 MB in 6 s, still linear) before this guard existed. `writeBufferLimit` is a seam
  // added expressly so this test could exist. The two short waits matter — the PTY has to be
  // producing before the client stops reading, or the write queue never grows.
  it('disconnects a client that stops reading, leaving the session and the host serving', async () => {
    const { socketPath, host } = await startHost({ writeBufferLimit: 64 * 1024 });
    const staller = client(socketPath);
    await staller.ready;
    // Enough volume to overrun the kernel's own socket buffers (hundreds of KB) as well as the cap.
    staller.send({ t: 'spawn', id: 'chatty', cwd: '/tmp', file: '/bin/sh',
      // `sleep 0.02` between bursts: still ~10 MB/s, far more than the 64 KB cap needs, but it does
      // not peg a core for the whole test. A spin loop here starved sibling PTY tests' timeouts when
      // the machine was busy and produced an intermittent failure elsewhere in this file.
      args: ['-c', 'while :; do head -c 200000 /dev/zero | tr "\\0" x; sleep 0.02; done'],
      env: envStrings(), cols: 200, rows: 50, seq: 1 });
    // Deliberately NOT awaiting `spawned`/`snapshot` here: at this limit the guard is aggressive
    // enough to cut a client that is merely slow to drain the handshake, and awaiting would race it.
    // The fixed waits let the PTY get going, which is what makes the write queue grow once we pause.
    await new Promise((r) => setTimeout(r, 400));
    staller.send({ t: 'attach', id: 'chatty', cols: 200, rows: 50, seq: 2 });
    await new Promise((r) => setTimeout(r, 400));
    staller.pause(); // stop reading, exactly like a renderer stalled on a paint

    await waitFor(() => staller.isClosed(), 20000);
    expect(staller.isClosed()).toBe(true);

    // The session survives the client being cut, and the host keeps serving new clients.
    expect(host.sessionCount()).toBe(1);
    const fresh = client(socketPath);
    await fresh.ready;
    fresh.send({ t: 'ping', seq: 9 });
    await fresh.take((m) => m.t === 'pong' && m.re === 9);
    fresh.send({ t: 'kill', id: 'chatty', seq: 10 });
    await fresh.take((m) => m.t === 'ok' && m.re === 10);
    fresh.close();
  }, 40000);

  it('calls onShutdownRequest and close(true) kills sessions and removes the socket', async () => {
    let requested: boolean | null = null;
    const { socketPath, host } = await startHost({ onShutdownRequest: (k) => (requested = k) });
    const c = client(socketPath);
    await c.ready;
    c.send(spawnMsg('d1', 'sleep 30'));
    await c.take((m) => m.t === 'spawned');
    c.send({ t: 'shutdown', killSessions: true, seq: 1 });
    await c.take((m) => m.t === 'ok');
    expect(requested).toBe(true);
    await host.close(true);
    hosts.splice(hosts.indexOf(host), 1);
    expect(host.sessionCount()).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  });
});
