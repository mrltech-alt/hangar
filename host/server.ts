// Session host server — spec §8.2. Owns sessions and clients; knows nothing about agents' names or git.
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EVENT_QUEUE_LIMIT, KILL_GRACE_MS } from '../shared/constants.ts';
import {
  ClientMessageSchema,
  MAX_LINE_CHARS,
  PROTOCOL_VERSION,
  assertSocketPathLength,
  createLineParser,
  encode,
  type ClientMessage,
  type HostErrorCode,
  type HostMessage,
  type SessionInfo,
} from '../shared/host-protocol.ts';
import { ensureSpawnHelperExecutable } from './pty-fix.ts';
import { Session } from './session.ts';

export interface HostOptions {
  socketPath: string;
  log: (line: string) => void;
  onShutdownRequest?: (killSessions: boolean) => void;
  /** Test seam: how many CLI events are queued per agent while no app client is connected. */
  queueLimit?: number;
  /** Test seam: bytes a client may have queued for writing before it is cut. See `send`. */
  writeBufferLimit?: number;
}

export interface HostHandle {
  socketPath: string;
  sessionCount(): number;
  clientCount(): number;
  close(killSessions: boolean): Promise<void>;
}

interface Client {
  id: number;
  socket: net.Socket;
  role: 'app' | 'cli' | null;
  attached: Set<string>;
}

export function createHost(opts: HostOptions): Promise<HostHandle> {
  assertSocketPathLength(opts.socketPath);
  ensureSpawnHelperExecutable();

  const sessions = new Map<string, Session>();
  const queues = new Map<string, HostMessage[]>();
  const clients = new Set<Client>();
  const queueLimit = opts.queueLimit ?? EVENT_QUEUE_LIMIT;
  // 8 MB is ~32 batched 256 KB frames: generous for a briefly busy renderer, far below
  // the hundreds of megabytes an unread client accumulates in seconds.
  const writeBufferLimit = opts.writeBufferLimit ?? 8 * 1024 * 1024;
  let nextClientId = 1;

  const send = (c: Client, msg: HostMessage): void => {
    if (c.socket.destroyed) return;
    // Defence in depth: budgetedSerialize keeps snapshots under the cap, but an over-cap line is
    // unrecoverable from the client side (its parser overflows, destroys the socket, reconnects,
    // re-attaches and receives the same frame again — forever). Never put one on the wire.
    const line = encode(msg);
    if (line.length > MAX_LINE_CHARS) {
      opts.log(`dropped oversized ${msg.t} frame (${line.length} chars > ${MAX_LINE_CHARS})`);
      c.socket.write(encode({ t: 'error', code: 'FRAME_TOO_LARGE', message: `${msg.t} frame exceeded the protocol line limit`, re: 're' in msg ? msg.re : undefined }));
      return;
    }
    c.socket.write(line);
    // Backpressure. A client that stops reading — a renderer stalled by a big paint, a reload, or a
    // loaded machine — lets Node queue writes in host memory without bound: measured ~55 MB/s for
    // one unread client attached to a chatty PTY. The host dying of OOM takes every agent with it.
    // Dropping `data` frames silently would corrupt the pane with no signal, so cut the client
    // instead: §8.3 step 5 already defines the recovery, and reconnect + re-attach replaces the
    // screen from the snapshot. A stalled renderer costs one resync rather than the host.
    if (c.socket.writableLength > writeBufferLimit) {
      opts.log(`client ${c.id} too slow (${c.socket.writableLength} bytes queued); disconnecting`);
      // `end()`, not `destroy()`: destroy discards queued writes, and by construction this socket has
      // at least writeBufferLimit bytes queued — so the client would never receive the code it is
      // being told to branch on. `end()` still tears the connection down; §8.3 step 5's reconnect
      // does the rest.
      c.socket.end(encode({ t: 'error', code: 'CLIENT_TOO_SLOW', message: 'client stopped reading; reconnect and re-attach' }));
    }
  };
  const toAttached = (id: string, msg: HostMessage): void => {
    for (const c of clients) if (c.attached.has(id)) send(c, msg);
  };
  const toAppsAndAttached = (id: string, msg: HostMessage): void => {
    for (const c of clients) if (c.role === 'app' || c.attached.has(id)) send(c, msg);
  };
  const infoOf = (s: Session): SessionInfo => {
    let attached = 0;
    for (const c of clients) if (c.attached.has(s.id)) attached++;
    return s.info(attached);
  };
  const allInfo = (): SessionInfo[] => [...sessions.values()].map(infoOf);
  const error = (c: Client, code: HostErrorCode, message: string, id?: string, re?: number): void => {
    opts.log(`error ${code}${id === undefined ? '' : ` ${id}`}: ${message}`); // spec §8.2 lists error among the logged events
    send(c, { t: 'error', id, code, message, re });
  };

  const sessionEvents = {
    onData: (id: string, data: string) => toAttached(id, { t: 'data', id, data }),
    onTitle: (id: string, title: string) => toAppsAndAttached(id, { t: 'title', id, title }),
    onBell: (id: string) => toAppsAndAttached(id, { t: 'bell', id }),
    onExit: (id: string, exitCode: number, signal: number | null) => {
      opts.log(`exit ${id} code=${exitCode} signal=${signal ?? '-'}`);
      toAppsAndAttached(id, { t: 'exit', id, exitCode, signal });
    },
    onLog: (message: string) => opts.log(message),
  };

  // Async because `attach` must wait for the headless mirror to drain before serialising it.
  // Ordering is preserved where it matters: the snapshot is serialised and the client marked
  // attached in the same synchronous step, so no output can slip between them.
  async function handle(c: Client, msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case 'hello': {
        c.role = msg.role;
        opts.log(`hello role=${msg.role} clientId=${msg.clientId} v=${msg.version}`);
        send(c, { t: 'hello', version: PROTOCOL_VERSION, hostPid: process.pid, sessions: allInfo(), re: msg.seq });
        if (msg.role === 'app') {
          for (const q of queues.values()) for (const m of q) send(c, m);
          queues.clear();
        }
        return;
      }
      case 'spawn': {
        const existing = sessions.get(msg.id);
        if (existing && !existing.exited) {
          error(c, 'EXISTS', `session ${msg.id} is already running`, msg.id, msg.seq);
          return;
        }
        // Clients attached to the OLD generation stay in `attached` on purpose: clearing them
        // would leave the renderer believing it is attached to a pane that never updates again.
        // They are re-snapshotted below instead — see the respawn note after `spawned`.
        const reattaching = existing ? [...clients].filter((x) => x.attached.has(msg.id)) : [];
        if (existing) {
          existing.dispose();
          sessions.delete(msg.id);
        }
        try {
          const s = new Session(
            { id: msg.id, cwd: msg.cwd, file: msg.file, args: msg.args, env: msg.env, cols: msg.cols, rows: msg.rows, startupCommand: msg.startupCommand },
            sessionEvents,
          );
          sessions.set(msg.id, s);
          opts.log(`spawn ${msg.id} pid=${s.pid} cwd=${msg.cwd} file=${msg.file}`);
          send(c, { t: 'spawned', id: msg.id, pid: s.pid, re: msg.seq });
          // Spec §8.2 lets a spawn reuse an exited id, and the app's Restart button does exactly
          // that. Without this, a still-attached client keeps the dead session's final screen and
          // the new session's output is appended onto it — no snapshot, no clear. The renderer
          // does not re-attach on restart (its effect is keyed on agentId + pane), so the host has
          // to push the reset. Unsolicited snapshot: no `re`.
          const respawnSnapshot = await s.snapshot();
          for (const other of reattaching) {
            send(other, { t: 'snapshot', id: msg.id, data: respawnSnapshot, title: s.title });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          opts.log(`spawn ${msg.id} failed: ${message}`);
          error(c, 'SPAWN_FAILED', message, msg.id, msg.seq);
        }
        return;
      }
      case 'attach': {
        const s = sessions.get(msg.id);
        if (!s) {
          error(c, 'NOT_FOUND', `no session ${msg.id}`, msg.id, msg.seq);
          return;
        }
        opts.log(`attach ${msg.id} ${msg.cols}x${msg.rows}`); // spec §8.2 lists attach among the logged events
        // Resize BEFORE snapshotting so the snapshot matches the client's geometry and the
        // resulting SIGWINCH makes full-screen apps redraw (spec §8.2). Snapshot before marking
        // attached, so a throwing snapshot cannot leave a client attached but never painted.
        s.resize(msg.cols, msg.rows);
        const data = await s.snapshot();
        c.attached.add(msg.id);
        send(c, { t: 'snapshot', id: msg.id, data, title: s.title, re: msg.seq });
        return;
      }
      case 'detach': {
        c.attached.delete(msg.id);
        send(c, { t: 'ok', re: msg.seq });
        return;
      }
      case 'write': {
        sessions.get(msg.id)?.write(msg.data);
        return;
      }
      case 'resize': {
        sessions.get(msg.id)?.resize(msg.cols, msg.rows);
        return;
      }
      case 'kill': {
        const s = sessions.get(msg.id);
        if (!s) {
          error(c, 'NOT_FOUND', `no session ${msg.id}`, msg.id, msg.seq);
          return;
        }
        opts.log(`kill ${msg.id} ${msg.signal ?? 'SIGHUP'}`);
        s.kill(msg.signal ?? 'SIGHUP');
        send(c, { t: 'ok', re: msg.seq });
        return;
      }
      case 'dispose': {
        const s = sessions.get(msg.id);
        if (s) {
          s.dispose();
          sessions.delete(msg.id);
          queues.delete(msg.id); // otherwise a deleted agent's queued events are held for the host's life
          for (const cl of clients) cl.attached.delete(msg.id);
        }
        send(c, { t: 'ok', re: msg.seq });
        return;
      }
      case 'list': {
        send(c, { t: 'sessions', sessions: allInfo(), re: msg.seq });
        return;
      }
      case 'cli': {
        const ev: HostMessage = { t: 'agentEvent', agentId: msg.agentId, cmd: msg.cmd, payload: msg.payload, at: new Date().toISOString() };
        let delivered = false;
        for (const a of clients) {
          if (a.role === 'app') {
            send(a, ev);
            delivered = true;
          }
        }
        if (!delivered) {
          const q = queues.get(msg.agentId) ?? [];
          q.push(ev);
          while (q.length > queueLimit) q.shift();
          queues.set(msg.agentId, q);
        }
        send(c, { t: 'ok', re: msg.seq });
        return;
      }
      case 'ping': {
        send(c, { t: 'pong', re: msg.seq });
        return;
      }
      case 'shutdown': {
        send(c, { t: 'ok', re: msg.seq });
        opts.log(`shutdown requested killSessions=${msg.killSessions}`);
        opts.onShutdownRequest?.(msg.killSessions);
        return;
      }
      default: {
        // Exhaustiveness: adding a message type to ClientMessageSchema without a case here is a
        // compile error, not a silent no-op that surfaces as a 5 s client timeout.
        const unhandled: never = msg;
        error(c, 'UNSUPPORTED', `unhandled message ${JSON.stringify(unhandled)}`);
        return;
      }
    }
  }

  const server = net.createServer((socket) => {
    const c: Client = { id: nextClientId++, socket, role: null, attached: new Set() };
    clients.add(c);
    socket.setEncoding('utf8');
    const parser = createLineParser({
      onLine: (line) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          error(c, 'BAD_JSON', 'invalid JSON line');
          return;
        }
        const parsed = ClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          const seqValue = typeof raw === 'object' && raw !== null ? (raw as { seq?: unknown }).seq : undefined;
          // One line, not zod's pretty-printed message: `opts.log` assumes one line per entry, and a
          // single malformed message produced 30 unprefixed lines — enough to push a "host failed to
          // start" line out of the last-20 window that `hangar doctor` greps to diagnose a host that
          // will not come up.
          const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          error(c, 'BAD_MESSAGE', detail, undefined, typeof seqValue === 'number' ? seqValue : undefined);
          return;
        }
        void handle(c, parsed.data).catch((e: unknown) => {
          const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
          opts.log(`handler for ${parsed.data.t} threw: ${message}`);
          error(c, 'INTERNAL', message, undefined, 'seq' in parsed.data ? parsed.data.seq : undefined);
        });
      },
      onOverflow: () => {
        error(c, 'LINE_TOO_LONG', 'line exceeds limit');
        socket.destroy();
      },
    });
    socket.on('data', (chunk: string) => parser.push(chunk));
    socket.on('close', () => clients.delete(c));
    socket.on('error', (e) => opts.log(`client ${c.id} error: ${e.message}`));
  });

  const close = async (killSessions: boolean): Promise<void> => {
    if (killSessions) {
      const live = [...sessions.values()].filter((s) => !s.exited);
      for (const s of live) s.kill('SIGHUP');
      const deadline = Date.now() + KILL_GRACE_MS + 1000;
      while (live.some((s) => !s.exited) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
    }
    for (const c of clients) c.socket.destroy();
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  };

  return new Promise((resolve, reject) => {
    const bind = (): void => {
      server.once('error', reject);
      server.listen(opts.socketPath, () => {
        chmodSync(opts.socketPath, 0o600);
        server.off('error', reject);
        server.on('error', (e) => opts.log(`server error: ${e.message}`));
        resolve({
          socketPath: opts.socketPath,
          sessionCount: () => sessions.size,
          clientCount: () => clients.size,
          close,
        });
      });
    };

    mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
    if (!existsSync(opts.socketPath)) {
      bind();
      return;
    }

    // A socket file may be stale — G10: a crashed host leaves one behind, and connecting to it
    // gives ECONNREFUSED rather than ENOENT — or it may belong to a LIVE host. Unlinking
    // unconditionally lets a second host silently steal the path: the first host's sessions become
    // unreachable and unkillable except by pid, and whichever host exits last unlinks the other's
    // socket. So probe before removing.
    const probe = net.createConnection(opts.socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`a session host is already listening on ${opts.socketPath}`));
    });
    probe.once('error', () => {
      probe.destroy();
      try {
        unlinkSync(opts.socketPath);
      } catch {
        // raced with another cleanup; listen() will report it if it still matters
      }
      bind();
    });
  });
}
