import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  createLineParser,
  encode,
  type ClientMessage,
  type HostMessage,
} from './host-protocol.ts';

/** One minimal valid message per client type — the wire contract Tasks 7-13 are built on. */
const ONE_OF_EACH: ClientMessage[] = [
  { t: 'hello', role: 'app', version: PROTOCOL_VERSION, clientId: 'app-1' },
  { t: 'spawn', id: 'a1', cwd: '/tmp', file: '/bin/sh', args: [], env: {}, cols: 80, rows: 24 },
  { t: 'attach', id: 'a1', cols: 80, rows: 24 },
  { t: 'detach', id: 'a1' },
  { t: 'write', id: 'a1', data: 'x' },
  { t: 'resize', id: 'a1', cols: 80, rows: 24 },
  { t: 'kill', id: 'a1' },
  { t: 'dispose', id: 'a1' },
  { t: 'list' },
  { t: 'cli', agentId: 'a1', cmd: 'note', payload: {} },
  { t: 'shutdown', killSessions: true },
  { t: 'ping' },
];

describe('encode', () => {
  it('produces one JSON line', () => {
    const msg: HostMessage = { t: 'pong', re: 3 };
    expect(encode(msg)).toBe('{"t":"pong","re":3}\n');
  });
  it('keeps control characters inside JSON strings', () => {
    const line = encode({ t: 'data', id: 'a', data: 'x\u001b[31m\r\ny' });
    expect(line.split('\n').length).toBe(2); // exactly one trailing newline
    expect(JSON.parse(line).data).toBe('x\u001b[31m\r\ny');
  });
});

describe('createLineParser', () => {
  it('splits on newlines across chunks and skips empty lines', () => {
    const lines: string[] = [];
    const p = createLineParser({ onLine: (l) => lines.push(l), onOverflow: () => lines.push('OVERFLOW') });
    p.push('{"a":1}\n{"b"');
    p.push(':2}\n\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    p.push('\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it('reports overflow and resets when a line exceeds the limit', () => {
    const lines: string[] = [];
    const p = createLineParser({ onLine: (l) => lines.push(l), onOverflow: () => lines.push('OVERFLOW') }, 10);
    p.push('x'.repeat(11));
    expect(lines).toEqual(['OVERFLOW']);
    p.push('ok\n');
    expect(lines).toEqual(['OVERFLOW', 'ok']);
  });
});

describe('ClientMessageSchema', () => {
  it('accepts a valid spawn', () => {
    const r = ClientMessageSchema.safeParse({
      t: 'spawn', id: 'a1', cwd: '/tmp', file: '/bin/sh', args: ['-i'], env: { PATH: '/usr/bin' }, cols: 80, rows: 24, seq: 1,
    });
    expect(r.success).toBe(true);
  });
  it('rejects unknown types and bad geometry', () => {
    expect(ClientMessageSchema.safeParse({ t: 'nope' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ t: 'resize', id: 'a', cols: 0, rows: 5 }).success).toBe(false);
  });
  it('exposes the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  // Without this, dropping a variant from the union fails nothing here and surfaces as a
  // runtime BAD_MESSAGE somewhere in Task 11. This is the guard for Tasks 7-13 and Plan 02.
  it('accepts every message type in spec §8.1, and exactly those', () => {
    for (const msg of ONE_OF_EACH) {
      expect(ClientMessageSchema.safeParse(msg), `${msg.t} should parse`).toMatchObject({ success: true });
    }
    expect(new Set(ONE_OF_EACH.map((m) => m.t))).toEqual(
      new Set(['hello', 'spawn', 'attach', 'detach', 'write', 'resize', 'kill', 'dispose', 'list', 'cli', 'shutdown', 'ping']),
    );
  });

  // `payload` is REQUIRED: z.unknown() does not make the key optional. zod is pinned with a
  // caret range, and this is exactly the behaviour a minor bump could flip.
  it('requires cli.payload to be present, even as null', () => {
    expect(ClientMessageSchema.safeParse({ t: 'cli', agentId: 'a', cmd: 'note' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ t: 'cli', agentId: 'a', cmd: 'note', payload: null }).success).toBe(true);
  });

  // spawn.env is the only untrusted field that becomes a real object handed to pty.spawn,
  // and any process running as this user can reach the socket.
  it('does not let a hostile spawn.env pollute Object.prototype', () => {
    const parsed = ClientMessageSchema.safeParse(
      JSON.parse('{"t":"spawn","id":"a","cwd":"/tmp","file":"/bin/sh","args":[],"env":{"__proto__":{"polluted":1}},"cols":80,"rows":24}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.success).toBe(true);
  });
});

// encode and createLineParser are each tested alone above; this is the composition every
// caller actually performs, including the one-character-at-a-time case a socket can produce.
describe('encode -> createLineParser -> ClientMessageSchema round trip', () => {
  it.each([
    ['one chunk', (s: string) => [s]],
    ['one character at a time', (s: string) => s.split('')],
  ])('survives %s', (_label, chunk) => {
    const wire = ONE_OF_EACH.map(encode).join('');
    const parsed: ClientMessage[] = [];
    const p = createLineParser({
      onLine: (l) => {
        const r = ClientMessageSchema.safeParse(JSON.parse(l));
        if (r.success) parsed.push(r.data);
      },
      onOverflow: () => expect.unreachable('no line here is anywhere near the cap'),
    });
    for (const c of chunk(wire)) p.push(c);
    expect(parsed.map((m) => m.t)).toEqual(ONE_OF_EACH.map((m) => m.t));
  });
});
