// Main's connection to the session host — spec §8.3. Requests correlate by seq/re; unsolicited messages become events.
import net from 'node:net';
import {
  PROTOCOL_VERSION,
  createLineParser,
  encode,
  type CliCommand,
  type ClientMessage,
  type HostErrorCode,
  type HostMessage,
  type RequestMessage,
  type SessionInfo,
} from '../../../shared/host-protocol.ts';

export interface HelloInfo {
  /** The host's protocol version. Compared against PROTOCOL_VERSION by the launcher (§8.3 step 4),
   *  deliberately NOT enforced here: shared/host-protocol.ts skips schema validation on host frames
   *  precisely because that handshake is assumed to have run, so the check must live in the caller. */
  version: number;
  hostPid: number;
  sessions: SessionInfo[];
}

export interface HostClientEvents {
  data: (id: string, data: string) => void;
  title: (id: string, title: string) => void;
  bell: (id: string) => void;
  exit: (id: string, exitCode: number, signal: number | null) => void;
  /**
   * An UNSOLICITED snapshot (no `re`). The host pushes one to still-attached clients when an
   * exited session id is respawned — the Restart path — because the renderer does not re-attach
   * (its effect is keyed on agent and pane). The receiver must reset the terminal before writing
   * it, or the new session's screen is painted onto the dead one's.
   */
  snapshot: (id: string, data: string, title: string) => void;
  agentEvent: (agentId: string, cmd: CliCommand, payload: unknown, at: string) => void;
  /**
   * An UNCORRELATED error — one the host volunteered rather than a reply to our request. The code
   * is the only way to distinguish "cut off for backpressure" (`CLIENT_TOO_SLOW`, §8.2, which a
   * resync fixes) from a host that is failing, so it must reach the consumer and not just the log.
   */
  hostError: (code: HostErrorCode, message: string, id: string | undefined) => void;
  connected: (hello: HelloInfo) => void;
  disconnected: (reason: string) => void;
}

/**
 * Every code a `HostRequestError` can carry: the host's own `HostErrorCode`, plus the three the
 * CLIENT mints. Named once, because declaring it inline on both the field and the constructor is how
 * they drifted apart — the field was narrowed to the union and the parameter was left as `string`,
 * which then hid `BAD_HELLO` not being a member of it at all.
 *
 * `BAD_HELLO` is deliberately its own code rather than reusing `BAD_MESSAGE`: the host says
 * `BAD_MESSAGE` when it rejects our schema, whereas this is the client refusing the host's answer to
 * the handshake. Tasks 15 and 16 branch on `.code`, so conflating them would be lossy.
 */
export type HostClientErrorCode = HostErrorCode | 'TIMEOUT' | 'DISCONNECTED' | 'BAD_HELLO' | 'ALREADY_CONNECTED';

export class HostRequestError extends Error {
  /** `HostClientErrorCode`, not `string`: shared/host-protocol.ts added that union specifically so
   *  the codes clients branch on cannot drift silently. */
  readonly code: HostClientErrorCode;
  constructor(code: HostClientErrorCode, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

export interface HostClient {
  /**
   * Rejects with `HostRequestError` — or, when the socket itself fails, with a raw Node
   * `ErrnoException` (`ENOENT` when no host is running, `ECONNREFUSED` for a stale socket file).
   * Those two are the §8.3 step 2 branch points, so they are passed through rather than wrapped;
   * a caller shaped `if (e instanceof HostRequestError)` will miss the most common failure.
   */
  connect(): Promise<HelloInfo>;
  /** RequestMessage, not ClientMessage: `write` and `resize` get no reply, so awaiting one
   *  would silently strip the seq and reject with TIMEOUT 5 s later. Now a compile error. */
  request(msg: RequestMessage, timeoutMs?: number): Promise<HostMessage>;
  send(msg: ClientMessage): void;
  on<K extends keyof HostClientEvents>(event: K, fn: HostClientEvents[K]): () => void;
  isConnected(): boolean;
  close(): void;
}

export interface HostClientOptions {
  socketPath: string;
  clientId: string;
  log: (line: string) => void;
  reconnect?: boolean;
  backoffMs?: { min: number; max: number };
  requestTimeoutMs?: number;
}

type Pending = { resolve: (m: HostMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export function createHostClient(opts: HostClientOptions): HostClient {
  const minBackoff = opts.backoffMs?.min ?? 200;
  const maxBackoff = opts.backoffMs?.max ?? 5_000;
  const listeners: { [K in keyof HostClientEvents]: Set<HostClientEvents[K]> } = {
    data: new Set(),
    title: new Set(),
    bell: new Set(),
    exit: new Set(),
    snapshot: new Set(),
    agentEvent: new Set(),
    hostError: new Set(),
    connected: new Set(),
    disconnected: new Set(),
  };
  const emit = <K extends keyof HostClientEvents>(event: K, ...args: Parameters<HostClientEvents[K]>): void => {
    // Guarded individually, like `workspace-store`'s `update()`: `listeners` is a Set, so an
    // unguarded throw from one listener aborts dispatch and every later listener for this event
    // silently misses it.
    for (const fn of listeners[event]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (e) {
        // One line, not a raw stack: `opts.log` assumes one entry per line, and unprefixed stack
        // frames push earlier entries out of the last-20 window `hangar doctor` greps (server.ts).
        const detail = e instanceof Error ? `${e.message} @ ${(e.stack ?? '').split('\n')[1]?.trim() ?? 'no frame'}` : String(e);
        opts.log(`host client ${event} listener threw: ${detail}`);
      }
    }
  };

  let socket: net.Socket | null = null;
  let connected = false;
  let connecting = false;
  let closedByUser = false;
  let seq = 0;
  let backoff = minBackoff;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, Pending>();

  const failPending = (reason: string): void => {
    for (const [s, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new HostRequestError('DISCONNECTED', reason));
      pending.delete(s);
    }
  };

  const handleMessage = (m: HostMessage): void => {
    // The PRESENCE of `re` decides this, not whether we still hold the seq. Anything correlated is
    // a reply; only an uncorrelated message is an event. Matching on `pending` instead let a
    // duplicate, late or unknown `re` fall through to the switch below, where a `snapshot` would
    // be emitted as the unsolicited respawn push — and §7 has the renderer reset the terminal
    // before writing one, so that wipes a live pane.
    if ('re' in m && typeof m.re === 'number') {
      const p = pending.get(m.re);
      if (p === undefined) {
        opts.log(`dropping uncorrelated reply: ${m.t} re=${m.re}`);
        return;
      }
      pending.delete(m.re);
      clearTimeout(p.timer);
      if (m.t === 'error') p.reject(new HostRequestError(m.code, m.message));
      else p.resolve(m);
      return;
    }
    switch (m.t) {
      case 'data':
        emit('data', m.id, m.data);
        return;
      case 'title':
        emit('title', m.id, m.title);
        return;
      case 'bell':
        emit('bell', m.id);
        return;
      case 'exit':
        emit('exit', m.id, m.exitCode, m.signal);
        return;
      case 'snapshot':
        // Genuinely unsolicited: anything carrying `re` returned above. This is the Restart push.
        emit('snapshot', m.id, m.data, m.title);
        return;
      case 'agentEvent':
        emit('agentEvent', m.agentId, m.cmd, m.payload, m.at);
        return;
      case 'error':
        opts.log(`host error: ${m.code} ${m.message}`);
        emit('hostError', m.code, m.message, m.id);
        return;
      default:
        return;
    }
  };

  const scheduleReconnect = (): void => {
    if (closedByUser || opts.reconnect === false || reconnectTimer !== null) return;
    // Checked when scheduling AND when firing: a consumer that calls connect() itself on
    // `disconnected` (or from a Reconnect button) otherwise leaves this timer to fire against a
    // live connection, reject ALREADY_CONNECTED, and reschedule itself for the life of the app.
    if (connected || connecting) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (connected || connecting) return;
      connect().catch(() => scheduleReconnect());
    }, backoff);
    opts.log(`reconnecting to the session host in ${backoff} ms`);
    // A retry that never succeeds must not be the only thing keeping a process alive — the same
    // reasoning as `workspace-store`'s retry timer. The socket is left ref'd: relaying session
    // output is real work, and the pre-hello window is bounded by the hello request's timeout.
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  const request = (msg: RequestMessage, timeoutMs: number = opts.requestTimeoutMs ?? 5_000): Promise<HostMessage> =>
    new Promise((resolve, reject) => {
      const s = socket;
      if (s === null || s.destroyed) {
        reject(new HostRequestError('DISCONNECTED', 'not connected to the session host'));
        return;
      }
      const mySeq = ++seq;
      const timer = setTimeout(() => {
        // Dropping it from `pending` is now enough to make a late reply inert: handleMessage
        // discards every correlated message it cannot match, so no seq bookkeeping survives here.
        pending.delete(mySeq);
        reject(new HostRequestError('TIMEOUT', `session host did not reply to ${msg.t} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(mySeq, { resolve, reject, timer });
      s.write(encode({ ...msg, seq: mySeq }));
    });

  const connect = (): Promise<HelloInfo> =>
    new Promise((resolve, reject) => {
      // Explicit failure rather than silently replacing a working socket. Resolving with the
      // previous hello would be worse than rejecting: its `sessions` list is a stale snapshot and
      // Task 15 builds SessionState from it.
      if (connected || connecting) {
        reject(new HostRequestError('ALREADY_CONNECTED', 'already connected to the session host'));
        return;
      }
      let settled = false;
      const s = net.createConnection(opts.socketPath);
      // Both set below the constructor: `net.createConnection` throws synchronously on a malformed
      // path (cli/socket.ts guards the same call), which would wedge `connecting` true forever.
      connecting = true;
      // A deliberate connect re-arms automatic reconnection. Nothing types close() as terminal, and
      // §8.3's launcher — retry, restart the host, reconnect — is exactly the caller that needs it.
      closedByUser = false;
      socket = s;
      s.setEncoding('utf8');
      const parser = createLineParser({
        onLine: (line) => {
          // Only the parse is guarded. Wrapping the dispatch too meant any throw from a consumer's
          // listener was reported as a host framing fault, pointing whoever debugs it at the wrong
          // process entirely.
          let parsed: HostMessage;
          try {
            parsed = JSON.parse(line) as HostMessage;
          } catch {
            opts.log('session host sent an invalid JSON line');
            return;
          }
          handleMessage(parsed);
        },
        onOverflow: () => {
          opts.log('session host line overflow; reconnecting');
          s.destroy();
        },
      });
      s.on('connect', () => {
        request({ t: 'hello', role: 'app', version: PROTOCOL_VERSION, clientId: opts.clientId })
          .then((m) => {
            if (m.t !== 'hello') throw new HostRequestError('BAD_HELLO', `unexpected reply ${m.t}`);
            connected = true;
            connecting = false;
            backoff = minBackoff;
            // Invariant: while connected, no retry is queued.
            if (reconnectTimer !== null) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            const hello: HelloInfo = { version: m.version, hostPid: m.hostPid, sessions: m.sessions };
            settled = true;
            emit('connected', hello);
            resolve(hello);
          })
          .catch((e: Error) => {
            settled = true;
            connecting = false;
            s.destroy();
            reject(e);
          });
      });
      s.on('data', (chunk: string) => parser.push(chunk));
      s.on('error', (e) => {
        opts.log(`session host socket error: ${e.message}`);
        if (!settled) {
          settled = true;
          connecting = false;
          reject(e);
        }
      });
      s.on('close', () => {
        // Settled FIRST, before the ownership guard below. A close() landing between
        // `createConnection` and `connect` destroys this socket without emitting `error`, and the
        // guard would return early — leaving connect()'s promise pending forever, with no timeout
        // to save it because the 5 s timer belongs to a `hello` that was never sent.
        if (!settled) {
          settled = true;
          connecting = false;
          reject(new HostRequestError('DISCONNECTED', 'connection closed before the session host said hello'));
        }
        // A socket we no longer own must not run the disconnect path: `failPending` is shared, so
        // a superseded socket closing would reject requests issued on its replacement.
        if (socket !== s) return;
        const wasConnected = connected;
        connected = false;
        connecting = false;
        socket = null;
        failPending('session host connection closed');
        if (wasConnected) emit('disconnected', 'connection closed');
        scheduleReconnect();
      });
    });

  return {
    connect,
    request,
    send(msg) {
      if (socket !== null && !socket.destroyed) {
        socket.write(encode(msg));
        return;
      }
      // Logged, not silent: `write` carries keystrokes, and a reconnect gap otherwise discards
      // user input with no trace of where it went.
      opts.log(`dropping ${msg.t} for ${'id' in msg ? msg.id : '-'}: not connected to the session host`);
    },
    on(event, fn) {
      listeners[event].add(fn as never);
      return () => {
        listeners[event].delete(fn as never);
      };
    },
    isConnected: () => connected,
    close() {
      closedByUser = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failPending('client closed');
      socket?.destroy();
      socket = null;
      connected = false;
      // Cleared too, or a close() landing mid-handshake would leave the flag stuck and every later
      // connect() would reject ALREADY_CONNECTED on a client that holds no socket at all.
      connecting = false;
    },
  };
}
