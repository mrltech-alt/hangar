import net from 'node:net';
import { createLineParser, encode, type HostMessage, type RequestMessage } from '../shared/host-protocol.ts';

const REPLY_TYPES = new Set<HostMessage['t']>(['ok', 'error', 'hello', 'sessions', 'pong', 'spawned', 'snapshot']);

/**
 * Connect, send one message, resolve with the first reply-type message; null on timeout, missing
 * socket or ANY error. This function never rejects — `hangar event` must always exit 0 (spec G16),
 * and that guarantee has to live in the code's shape rather than in an audit of the call graph.
 * `net.createConnection('')` throws synchronously, so even constructing the socket is inside the try.
 */
export function requestOnce(socketPath: string, msg: RequestMessage, timeoutMs: number): Promise<HostMessage | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: net.Socket;
    try {
      socket = net.createConnection(socketPath);
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: HostMessage | null): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding('utf8');
    const parser = createLineParser({
      onLine: (line) => {
        try {
          const m = JSON.parse(line) as HostMessage;
          if (REPLY_TYPES.has(m.t)) finish(m);
        } catch {
          /* ignore malformed lines */
        }
      },
      onOverflow: () => finish(null),
    });
    socket.on('connect', () => socket.write(encode(msg)));
    socket.on('data', (chunk: string) => parser.push(chunk));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}
