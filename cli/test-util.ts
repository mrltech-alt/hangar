// Test-only: an in-process session host plus an "app" listener that records relayed agent events.
import net from 'node:net';
import { Readable } from 'node:stream';
import { createLineParser, encode, type HostMessage } from '../shared/host-protocol.ts';
import { createHost, type HostHandle } from '../host/server.ts';
import type { CliIo } from './context.ts';

let counter = 0;

export async function startTestHost(): Promise<{ socketPath: string; host: HostHandle }> {
  const socketPath = `/tmp/hangar-cli-${process.pid}-${++counter}.sock`;
  const host = await createHost({ socketPath, log: () => {} });
  return { socketPath, host };
}

export function startAppListener(socketPath: string) {
  const socket = net.createConnection(socketPath);
  const events: HostMessage[] = [];
  socket.setEncoding('utf8');
  const parser = createLineParser({ onLine: (l) => events.push(JSON.parse(l) as HostMessage), onOverflow: () => {} });
  socket.on('data', (c: string) => parser.push(c));
  const ready = new Promise<void>((r) =>
    socket.on('connect', () => {
      socket.write(encode({ t: 'hello', role: 'app', version: 1, clientId: 'test-app' }));
      r();
    }),
  );
  return {
    ready,
    events,
    async waitFor(pred: (m: HostMessage) => boolean, ms = 3000): Promise<HostMessage> {
      const start = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - start > ms) throw new Error('timeout waiting for app event');
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    close: () => socket.destroy(),
  };
}

export function fakeIo(stdinText = ''): CliIo & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    stdin: Readable.from([stdinText]),
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    out: () => out,
    err: () => err,
  };
}
