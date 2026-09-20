import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { HOOK_STDIN_TIMEOUT_MS } from '../shared/constants.ts';
import { runCli, splitGlobalOptions } from './run.ts';
import { fakeIo, startAppListener, startTestHost } from './test-util.ts';
import type { HostHandle } from '../host/server.ts';
import { tempDir } from '../test/fixtures/tmp.ts';


const hosts: HostHandle[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close(true);
});

describe('runCli', () => {
  it('prints usage and exits 1 with no command; 0 with --help', async () => {
    const io = fakeIo();
    expect(await runCli([], {}, io)).toBe(1);
    expect(io.out()).toContain('usage: hangar');
    const io2 = fakeIo();
    expect(await runCli(['--help'], {}, io2)).toBe(0);
  });

  it('rename relays to the app and prints confirmation', async () => {
    const { socketPath, host } = await startTestHost();
    hosts.push(host);
    const app = startAppListener(socketPath);
    await app.ready;
    const io = fakeIo();
    const code = await runCli(['rename', 'New', 'Name'], { HANGAR_AGENT_ID: 'ag-1', HANGAR_SOCKET: socketPath }, io);
    expect(code).toBe(0);
    expect(io.out()).toBe('renamed to: New Name\n');
    const ev = await app.waitFor((m) => m.t === 'agentEvent');
    expect(ev).toMatchObject({ agentId: 'ag-1', cmd: 'rename', payload: { name: 'New Name' } });
    app.close();
  });

  it('rename fails clearly without an agent id or without a host', async () => {
    const io = fakeIo();
    expect(await runCli(['rename', 'x'], {}, io)).toBe(1);
    expect(io.err()).toContain('HANGAR_AGENT_ID');
    const io2 = fakeIo();
    expect(await runCli(['rename', 'x'], { HANGAR_AGENT_ID: 'a', HANGAR_SOCKET: '/tmp/hangar-nope.sock' }, io2)).toBe(1);
    expect(io2.err()).toContain('not reachable');
  });

  it('note supports append (default), --replace and --clear', async () => {
    const { socketPath, host } = await startTestHost();
    hosts.push(host);
    const app = startAppListener(socketPath);
    await app.ready;
    const env = { HANGAR_AGENT_ID: 'ag-2', HANGAR_SOCKET: socketPath };
    expect(await runCli(['note', 'blocked', 'on', 'review'], env, fakeIo())).toBe(0);
    expect(await runCli(['note', '--replace', 'fresh'], env, fakeIo())).toBe(0);
    expect(await runCli(['note', '--clear'], env, fakeIo())).toBe(0);
    await app.waitFor((m) => m.t === 'agentEvent' && (m.payload as { mode: string }).mode === 'clear');
    const payloads = app.events.filter((m) => m.t === 'agentEvent').map((m) => (m.t === 'agentEvent' ? m.payload : null));
    expect(payloads).toEqual([
      { mode: 'append', text: 'blocked on review' },
      { mode: 'replace', text: 'fresh' },
      { mode: 'clear', text: '' },
    ]);
    const io = fakeIo();
    expect(await runCli(['note'], env, io)).toBe(1);
    expect(io.err()).toContain('usage: hangar note');
    app.close();
  });

  it('event forwards the hook payload fields and always exits 0', async () => {
    const { socketPath, host } = await startTestHost();
    hosts.push(host);
    const app = startAppListener(socketPath);
    await app.ready;
    const hook = { session_id: 's', cwd: '/w', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs you', secret: 'drop-me' };
    const io = fakeIo(JSON.stringify(hook));
    expect(await runCli(['event'], { HANGAR_AGENT_ID: 'ag-3', HANGAR_SOCKET: socketPath }, io)).toBe(0);
    const ev = await app.waitFor((m) => m.t === 'agentEvent');
    expect(ev).toMatchObject({ agentId: 'ag-3', cmd: 'event', payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs you', session_id: 's', cwd: '/w' } });
    expect((ev.t === 'agentEvent' ? (ev.payload as Record<string, unknown>) : {}).secret).toBeUndefined();
    app.close();
  });

  it('event exits 0 quickly when the host is unreachable or stdin is not JSON', async () => {
    const started = Date.now();
    expect(await runCli(['event'], { HANGAR_AGENT_ID: 'a', HANGAR_SOCKET: '/tmp/hangar-nope.sock' }, fakeIo('{"hook_event_name":"Stop"}'))).toBe(0);
    expect(await runCli(['event'], { HANGAR_AGENT_ID: 'a', HANGAR_SOCKET: '/tmp/hangar-nope.sock' }, fakeIo('not json'))).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('--agent and --home override the environment', async () => {
    const home = tempDir('clihome');
    mkdirSync(join(home, 'state', 'agents'), { recursive: true });
    writeFileSync(join(home, 'state', 'agents', 'ag-9.json'), JSON.stringify({ id: 'ag-9', name: 'Nine', slug: 'nine', notes: '', workspaces: [], updatedAt: 'x' }));
    const io = fakeIo();
    expect(await runCli(['status', '--agent', 'ag-9', '--home', home], {}, io)).toBe(0);
    expect(io.out()).toContain('Nine');
  });
});

// G16 is the sharpest requirement in the CLI: a hook that fails loudly, or slowly, delays Claude's
// turn for no user benefit. Eleven modes were verified by hand during review; these pin the ones
// that can regress silently.
describe('hangar event always exits 0 (spec G16)', () => {
  const stdinCases: [string, string][] = [
    ['empty', ''],
    ['whitespace', '   '],
    ['not json', 'not json at all'],
    ['json null', 'null'],
    ['json array', '[1,2,3]'],
    ['json string', '"a string"'],
    ['no hook_event_name', '{"session_id":"s"}'],
    ['wrong type for hook_event_name', '{"hook_event_name":123}'],
    ['valid, but no host listening', '{"hook_event_name":"Stop","session_id":"s"}'],
  ];

  it.each(stdinCases)('exits 0 with %s on stdin', async (_label, text) => {
    const io = fakeIo(text);
    const code = await runCli(['event'], { HANGAR_AGENT_ID: 'a1', HANGAR_SOCKET: '/tmp/hangar-nonexistent.sock' }, io);
    expect(code).toBe(0);
  });

  it('exits 0 when HANGAR_AGENT_ID is unset', async () => {
    const io = fakeIo('{"hook_event_name":"Stop"}');
    expect(await runCli(['event'], {}, io)).toBe(0);
  });

  // HANGAR_SOCKET="" is what an unset variable expands to in a shell wrapper. It used to reach
  // net.createConnection(''), which throws SYNCHRONOUSLY and made the whole CLI exit 1 with a stack.
  it('exits 0 when HANGAR_SOCKET is an empty string', async () => {
    const io = fakeIo('{"hook_event_name":"Stop"}');
    expect(await runCli(['event'], { HANGAR_AGENT_ID: 'a1', HANGAR_SOCKET: '' }, io)).toBe(0);
  });

  // The regression test for the stdin leak: readAll used to leave its listeners attached, so the
  // process stayed alive until stdin EOF — measured 8 s against a 2 s cap, past the hook's own
  // timeout: 5. A pipe that is written but never ended must still resolve on the cap.
  it('gives up on a stdin that never ends, rather than waiting for EOF', async () => {
    const stream = new PassThrough();
    stream.write('{"hook_event_name":"Stop"}');
    const started = Date.now();
    const code = await runCli(['event'], { HANGAR_AGENT_ID: 'a1', HANGAR_SOCKET: '/tmp/hangar-nonexistent.sock' }, {
      stdin: stream,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOOK_STDIN_TIMEOUT_MS - 100);
    expect(Date.now() - started).toBeLessThan(HOOK_STDIN_TIMEOUT_MS + 1500);
    stream.end();
  });
});

describe('splitGlobalOptions leaves free text alone', () => {
  it('does not treat a flag inside note/rename text as an option', () => {
    // This used to lose two words from the note AND repoint the socket at `support/run/host.sock`.
    expect(splitGlobalOptions(['note', 'Blocked', 'on', '--home', 'support'])).toEqual({
      rest: ['note', 'Blocked', 'on', '--home', 'support'],
      agent: undefined,
      home: undefined,
    });
    expect(splitGlobalOptions(['rename', 'Fix', '--home', 'resolution', 'bug']).rest).toEqual(['rename', 'Fix', '--home', 'resolution', 'bug']);
  });

  it('still reads options before the command, and for commands with no free text', () => {
    expect(splitGlobalOptions(['--home', '/tmp/h', 'status'])).toEqual({ rest: ['status'], agent: undefined, home: '/tmp/h' });
    expect(splitGlobalOptions(['status', '--agent', 'ag-9', '--home', '/tmp/h'])).toEqual({ rest: ['status'], agent: 'ag-9', home: '/tmp/h' });
    expect(splitGlobalOptions(['note', '--clear']).rest).toEqual(['note', '--clear']);
  });

  it('honours -- and removes it', () => {
    expect(splitGlobalOptions(['note', '--', '--home', 'literal']).rest).toEqual(['note', '--home', 'literal']);
  });
});
