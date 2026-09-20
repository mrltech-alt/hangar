import { describe, expect, it } from 'vitest';
import { ExecError, type ExecOptions, type ExecResult } from '../util/exec.ts';
import {
  KEYCHAIN_SERVICE, LINEAR_MCP_URL, LINEAR_MESSAGES, LINEAR_TOOLS, LinearError, MCP_PROTOCOL_VERSION,
  createLinearMcp, findLinearToken, parseMcpBody, toolText, type HttpResponse,
} from './linear-mcp.ts';

const ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/Users/me' };

/** The shape the keychain item really has (measured): `claudeAiOauth` beside an `mcpOAuth` map. */
const keychain = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'NOT-THE-LINEAR-ONE', subscriptionType: 'max' },
    mcpOAuth: {
      'github|abc': { serverName: 'github', serverUrl: 'https://api.githubcopilot.com/mcp/', accessToken: 'gh-token', expiresAt: 4_000_000_000_000 },
      'linear|deadbeef': {
        serverName: 'linear', serverUrl: LINEAR_MCP_URL, accessToken: 'lin-token', refreshToken: 'lin-refresh',
        expiresAt: 2_000_000_000_000, clientId: 'cid', redirectUri: 'http://localhost:1/callback',
        issuer: 'https://mcp.linear.app', scope: 'read write', ...patch,
      },
    },
  });

const ok = (body: unknown): HttpResponse => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const status = (code: number, body = ''): HttpResponse => ({ ok: false, status: code, text: async () => body });

/** A JSON-RPC success carrying a tool result, the way `tools/call` answers. */
const toolReply = (id: number, text: string): unknown => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

interface Post { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function setup(opts: { replies?: HttpResponse[]; keychainText?: string; execFails?: boolean; now?: number } = {}) {
  const posts: Post[] = [];
  const logs: string[] = [];
  const replies = [...(opts.replies ?? [])];
  const execCalls: { file: string; args: string[]; opts: ExecOptions | undefined }[] = [];
  const linear = createLinearMcp({
    env: ENV,
    exec: async (file, args, o): Promise<ExecResult> => {
      execCalls.push({ file, args, opts: o });
      if (opts.execFails === true) throw new ExecError(file, args, 44, 'SecKeychainSearchCopyNext: not found', '44');
      return { stdout: opts.keychainText ?? keychain(), stderr: '', code: 0 };
    },
    fetch: async (url, init) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      const next = replies.shift();
      if (next === undefined) throw new Error('no reply queued');
      return next;
    },
    now: () => opts.now ?? 1_700_000_000_000,
    log: (l) => logs.push(l),
  });
  return { linear, posts, logs, execCalls };
}

/** Every call sends the handshake first, so a test that wants ONE tool answer queues two replies. */
const handshake = (): HttpResponse => ok({ jsonrpc: '2.0', id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'linear', version: '1' } } });

describe('findLinearToken', () => {
  it('picks the mcpOAuth entry by serverUrl, never claudeAiOauth or another server', () => {
    expect(findLinearToken(keychain())).toEqual({ accessToken: 'lin-token', expiresAt: 2_000_000_000_000 });
  });

  it('is null for a missing entry, a wrong URL, malformed JSON, a non-object and an empty token', () => {
    expect(findLinearToken(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }))).toBeNull();
    expect(findLinearToken(JSON.stringify({ mcpOAuth: { 'linear|x': { serverUrl: 'https://mcp.linear.app/sse', accessToken: 't' } } }))).toBeNull();
    expect(findLinearToken('not json at all')).toBeNull();
    expect(findLinearToken('[]')).toBeNull();
    expect(findLinearToken(JSON.stringify({ mcpOAuth: { 'linear|x': { serverUrl: LINEAR_MCP_URL, accessToken: '' } } }))).toBeNull();
  });

  it('accepts an entry with no expiresAt, and refuses one whose expiresAt is not a number', () => {
    expect(findLinearToken(keychain({ expiresAt: undefined }))).toEqual({ accessToken: 'lin-token', expiresAt: null });
    expect(findLinearToken(keychain({ expiresAt: 'soon' }))).toEqual({ accessToken: 'lin-token', expiresAt: null });
  });
});

describe('parseMcpBody / toolText', () => {
  it('reads a plain JSON body and an SSE body whose payload is on a data: line', () => {
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toEqual({ jsonrpc: '2.0', id: 1, result: { a: 1 } });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
    expect(parseMcpBody(sse)).toEqual({ jsonrpc: '2.0', id: 2, result: { b: 2 } });
  });

  it('skips SSE lines that are not the answer, and is null for a body with neither result nor error', () => {
    const sse = ': keep-alive\ndata: {"note":"ignored"}\ndata: {"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad"}}\n';
    expect(parseMcpBody(sse)).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'bad' } });
    expect(parseMcpBody('data: {"note":"ignored"}\n')).toBeNull();
    expect(parseMcpBody('')).toBeNull();
  });

  it('joins the data: lines of one SSE event when no single line is the answer', () => {
    // The measured server puts its whole answer on ONE data: line, but the transport allows a payload
    // to be split across several — joined with a newline, and with CRLF endings.
    const split = 'event: message\r\ndata: {"jsonrpc":"2.0","id":4,\r\ndata: "result":{"c":3}}\r\n\r\n';
    expect(parseMcpBody(split)).toEqual({ jsonrpc: '2.0', id: 4, result: { c: 3 } });
    // Fragments of two DIFFERENT events are never joined across the blank line that separates them.
    expect(parseMcpBody('data: {"jsonrpc":"2.0",\n\ndata: "id":5,"result":{}}\n')).toBeNull();
  });

  it('pulls the first text block out of a tool result and is null for anything else', () => {
    expect(toolText({ content: [{ type: 'text', text: '{"issues":[]}' }] })).toBe('{"issues":[]}');
    expect(toolText({ content: [{ type: 'image', data: 'x' }, { type: 'text', text: 'second' }] })).toBe('second');
    expect(toolText({ content: [] })).toBeNull();
    expect(toolText(null)).toBeNull();
  });
});

describe('createLinearMcp', () => {
  it('reads the keychain with security -w -s, handshakes once per app run, then calls the tool', async () => {
    const s = setup({ replies: [handshake(), ok(toolReply(2, '{"issues":[]}')), ok(toolReply(3, '{"teams":[]}'))] });
    expect(await s.linear.call('list_issues', { assignee: 'me', limit: 50 })).toBe('{"issues":[]}');
    expect(await s.linear.call('list_teams', {})).toBe('{"teams":[]}');

    expect(s.execCalls.map((c) => [c.file, c.args])).toEqual([
      ['/usr/bin/security', ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE]],
      ['/usr/bin/security', ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE]],
    ]);
    // Three posts, not four: the handshake is cached, the token read is not.
    expect(s.posts).toHaveLength(3);
    expect(s.posts[0]?.url).toBe(LINEAR_MCP_URL);
    expect(s.posts[0]?.body).toMatchObject({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(s.posts[1]?.body).toMatchObject({ method: 'tools/call', params: { name: 'list_issues', arguments: { assignee: 'me', limit: 50 } } });
    expect(s.posts[2]?.body).toMatchObject({ method: 'tools/call', params: { name: 'list_teams' } });
    expect(s.posts[1]?.headers).toEqual({
      Authorization: 'Bearer lin-token',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
  });

  it('never lets the token reach a log line or a request body', async () => {
    const s = setup({ replies: [handshake(), ok(toolReply(2, '{}'))] });
    await s.linear.call('list_issues', {});
    expect(s.logs.join('\n')).not.toContain('lin-token');
    expect(s.logs.join('\n')).not.toContain('lin-refresh');
    // The token belongs in the Authorization header and nowhere else — never in a body Hangar composes.
    expect(JSON.stringify(s.posts.map((p) => p.body))).not.toContain('lin-token');
  });

  it('never lets the token reach an error message, on any failure path', async () => {
    const messages: string[] = [];
    const grab = async (run: Promise<unknown>): Promise<void> => {
      try {
        await run;
        throw new Error('expected a rejection');
      } catch (e) {
        const detail = (e as { detail?: unknown }).detail;
        messages.push(`${e instanceof Error ? e.message : String(e)} ${typeof detail === 'string' ? detail : ''}`);
      }
    };
    await grab(setup({ now: 2_000_000_000_001 }).linear.call('list_issues', {}));
    await grab(setup({ execFails: true }).linear.call('list_issues', {}));
    await grab(setup({ replies: [status(401, 'unauthorized')] }).linear.call('list_issues', {}));
    await grab(setup({ replies: [handshake(), status(503, 'upstream down')] }).linear.call('list_issues', {}));
    await grab(setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad request' } })] }).linear.call('list_issues', {}));
    await grab(setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'no such team' }] } })] }).linear.call('list_issues', {}));
    expect(messages).toHaveLength(6);
    expect(messages.join('\n')).not.toContain('lin-token');
    expect(messages.join('\n')).not.toContain('lin-refresh');
  });

  it('bounds the BODY read with the request timeout, not just the headers', async () => {
    // The bug this pins: `clearTimeout` ran before `response.text()`, so headers that arrived and a body
    // that never did hung for ever. The fake models a real fetch, whose pending body read rejects once
    // the signal aborts.
    let bodyReads = 0;
    const linear = createLinearMcp({
      env: ENV,
      exec: async () => ({ stdout: keychain(), stderr: '', code: 0 }),
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          bodyReads += 1;
          init.signal.addEventListener('abort', () => { reject(new Error('body aborted')); }, { once: true });
        }),
      }),
      now: () => 1_700_000_000_000,
      log: () => undefined,
      timeoutMs: 40,
    });
    await expect(linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    expect(bodyReads).toBeGreaterThan(0);
  });

  it('sends nothing at all when the caller signal is already aborted', async () => {
    const s = setup({ replies: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(s.linear.call('list_issues', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    // Not the handshake, not the request — and not even the keychain read.
    expect(s.posts).toEqual([]);
    expect(s.execCalls).toEqual([]);
  });

  it('retries a lost READ but never a lost save_issue, which would create a second ticket', async () => {
    // Only the handshake is answered; the tool call then hits the fake's "no reply queued", which is a
    // transport failure rather than an answer from Linear.
    const write = setup({ replies: [handshake()] });
    await expect(write.linear.call('save_issue', { title: 'x' })).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    expect(write.posts).toHaveLength(2);
    expect(write.posts.filter((p) => p.body['method'] === 'tools/call')).toHaveLength(1);

    const read = setup({ replies: [handshake()] });
    await expect(read.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    expect(read.posts).toHaveLength(3);
    expect(read.posts.filter((p) => p.body['method'] === 'tools/call')).toHaveLength(2);
  });

  it('does not let one caller cancelling poison the cached handshake for the next', async () => {
    const controller = new AbortController();
    const replies: HttpResponse[] = [handshake(), ok(toolReply(2, '{"issues":[]}'))];
    let calls = 0;
    const linear = createLinearMcp({
      env: ENV,
      exec: async () => ({ stdout: keychain(), stderr: '', code: 0 }),
      fetch: async (_url, init) => {
        calls += 1;
        // The first caller gives up while the handshake POST is in flight. A real fetch rejects once
        // ITS OWN signal aborts — which is what poisoned the cached handshake before the fix.
        if (calls === 1) {
          controller.abort();
          if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        const next = replies.shift();
        if (next === undefined) throw new Error('no reply queued');
        return next;
      },
      now: () => 1_700_000_000_000,
      log: () => undefined,
    });
    // Caller 1 is cancelled, so its own tool call never goes out.
    await expect(linear.call('list_issues', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    // Caller 2 finds the handshake cached and SUCCEEDED.
    expect(await linear.call('list_issues', {})).toBe('{"issues":[]}');
    expect(calls).toBe(2);
  });

  it('refuses a handshake that came back as a refusal, and logs a protocol version it did not ask for', async () => {
    const refused = setup({ replies: [ok({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'server is not ready' }] } })] });
    await expect(refused.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_FAILED', message: 'Linear rejected that: server is not ready' });
    expect(refused.posts).toHaveLength(1);

    // A version we did not ask for is logged, not fatal: the call still goes through.
    const other = setup({ replies: [ok({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'linear', version: '1' } } }), ok(toolReply(2, '{"issues":[]}'))] });
    expect(await other.linear.call('list_issues', {})).toBe('{"issues":[]}');
    expect(other.logs.join('\n')).toContain('2024-11-05');
  });

  it('refuses a tool outside the allow-list before any request', async () => {
    const s = setup({ replies: [] });
    await expect(s.linear.call('list_projects' as (typeof LINEAR_TOOLS)[number], {})).rejects.toMatchObject({ code: 'LINEAR_FAILED' });
    expect(s.posts).toEqual([]);
    expect(s.execCalls).toEqual([]);
  });

  it('LINEAR_NOT_CONNECTED when security fails or the entry is missing, with no request sent', async () => {
    const failing = setup({ execFails: true });
    await expect(failing.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_NOT_CONNECTED', message: LINEAR_MESSAGES.LINEAR_NOT_CONNECTED });
    expect(failing.posts).toEqual([]);

    const empty = setup({ keychainText: JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }) });
    await expect(empty.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_NOT_CONNECTED' });
    expect(empty.posts).toEqual([]);
  });

  it('LINEAR_REAUTH before the request when expiresAt has passed, and on a 401 after it', async () => {
    const expired = setup({ now: 2_000_000_000_001 });
    await expect(expired.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_REAUTH', message: LINEAR_MESSAGES.LINEAR_REAUTH });
    expect(expired.posts).toEqual([]);

    const unauthorised = setup({ replies: [status(401, 'token expired')] });
    await expect(unauthorised.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_REAUTH' });
  });

  it('retries once on a network error and succeeds', async () => {
    let calls = 0;
    const posts: unknown[] = [];
    const linear = createLinearMcp({
      env: ENV,
      exec: async () => ({ stdout: keychain(), stderr: '', code: 0 }),
      fetch: async (_url, init) => {
        posts.push(init.body);
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return calls === 2 ? handshake() : ok(toolReply(2, '{"issues":[]}'));
      },
      now: () => 1_700_000_000_000,
      log: () => undefined,
    });
    expect(await linear.call('list_issues', {})).toBe('{"issues":[]}');
    expect(calls).toBe(3);
  });

  it('gives up with LINEAR_TIMEOUT when both attempts fail', async () => {
    const linear = createLinearMcp({
      env: ENV,
      exec: async () => ({ stdout: keychain(), stderr: '', code: 0 }),
      fetch: async () => { throw new TypeError('fetch failed'); },
      now: () => 1_700_000_000_000,
      log: () => undefined,
    });
    await expect(linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT', message: LINEAR_MESSAGES.LINEAR_TIMEOUT });
  });

  it('aborts on the caller signal without retrying', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const linear = createLinearMcp({
      env: ENV,
      exec: async () => ({ stdout: keychain(), stderr: '', code: 0 }),
      fetch: async (_url, init) => {
        attempts += 1;
        // The handshake is deliberately NOT the caller's to cancel (it is cached for every later
        // caller), so the abort is landed on the tool call, which is.
        if (attempts === 1) return handshake();
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal });
      },
      now: () => 1_700_000_000_000,
      log: () => undefined,
    });
    await expect(linear.call('list_issues', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'LINEAR_TIMEOUT' });
    // The handshake and exactly ONE tool attempt: a cancelled call is never retried.
    expect(attempts).toBe(2);
  });

  it('turns a JSON-RPC error, an isError result and a non-2xx into LINEAR_FAILED, sanitised and capped', async () => {
    const rpc = setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'title is required' } })] });
    await expect(rpc.linear.call('save_issue', { title: '' })).rejects.toMatchObject({ code: 'LINEAR_FAILED', message: 'Linear rejected that: title is required' });

    // A tool-level refusal: HTTP 200, a normal `result`, `isError` inside it — never a JSON-RPC error.
    // This is the shape measured from `list_cycles` with an unrecognised argument.
    const isError = setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: `no such team${String.fromCodePoint(7)}` }] } })] });
    await expect(isError.linear.call('save_issue', {})).rejects.toMatchObject({ code: 'LINEAR_FAILED', message: 'Linear rejected that: no such team' });

    const rejectedArgs = setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool list_cycles: Unrecognized key: "limit"' }] } })] });
    await expect(rejectedArgs.linear.call('list_cycles', { teamId: 't1', limit: 3 })).rejects.toMatchObject({ code: 'LINEAR_FAILED', message: expect.stringContaining('Unrecognized key') as unknown as string });

    const http = setup({ replies: [handshake(), status(503, 'upstream down')] });
    await expect(http.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_FAILED', message: "Couldn't reach Linear (HTTP 503)." });

    const empty = setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, result: { content: [] } })] });
    await expect(empty.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_FAILED' });
  });

  it('retries the handshake after it failed, rather than replaying the rejection', async () => {
    const s = setup({ replies: [status(500, 'nope'), handshake(), ok(toolReply(3, '{"issues":[]}'))] });
    await expect(s.linear.call('list_issues', {})).rejects.toMatchObject({ code: 'LINEAR_FAILED' });
    expect(await s.linear.call('list_issues', {})).toBe('{"issues":[]}');
  });

  /**
   * Plan 07 Task 6 review. `LINEAR_FAILED` was one code covering two opposite facts: "Linear said no"
   * and "Linear may well have done it, and the answer was lost". For the three READS the difference is
   * invisible — ask again either way — but `linear:createTicket` is a WRITE, and it is the one caller
   * that has to decide whether the owner may press Save a second time. A 502 answered as a plain
   * refusal invites exactly the press that files a duplicate ticket.
   */
  it('marks a failure by whether the request may have taken effect', async () => {
    const call = async (replies: HttpResponse[]): Promise<unknown> =>
      setup({ replies }).linear.call('list_issues', {}).catch((e: unknown) => e);

    // SENT, outcome unknown: the POST reached Linear and what came back cannot be read as an answer.
    expect(await call([handshake(), status(502, 'bad gateway')])).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'unknown' });
    expect(await call([handshake(), ok('<html>proxy error</html>')])).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'unknown' });
    expect(await call([handshake(), ok({ jsonrpc: '2.0', id: 2, result: { content: [] } })])).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'unknown' });

    // REFUSED: Linear's own answer saying it did not accept the request, so nothing happened.
    const refusal = { jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'no such team' }] } };
    expect(await call([handshake(), ok(refusal)])).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'refused' });
    // And the two that are refused before anything is sent at all.
    expect(await call([handshake(), status(401)])).toMatchObject({ code: 'LINEAR_REAUTH', outcome: 'refused' });
    expect(await setup({ execFails: true }).linear.call('list_issues', {}).catch((e: unknown) => e)).toMatchObject({ code: 'LINEAR_NOT_CONNECTED', outcome: 'refused' });
  });

  /**
   * A JSON-RPC `error` is split by its own code rather than treated as one thing, because the two
   * halves of that member mean opposite things to a write. The four codes below are decided BEFORE
   * the method runs — the request could not be parsed, was not a request, named no such method, or
   * carried arguments the server would not take — so nothing happened and Save is safe. `-32603`
   * (internal error) and the server-defined `-32000`..`-32099` range are raised BY the method, which
   * for `save_issue` can be after the issue was written and while the answer was being built.
   */
  it('splits a JSON-RPC error by whether its code is decided before the method ran', async () => {
    const rpc = async (error: Record<string, unknown>): Promise<unknown> =>
      setup({ replies: [handshake(), ok({ jsonrpc: '2.0', id: 2, error })] }).linear.call('list_issues', {}).catch((e: unknown) => e);

    for (const code of [-32700, -32600, -32601, -32602]) {
      expect(await rpc({ code, message: 'bad params' }), `JSON-RPC ${code}`).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'refused' });
    }
    for (const code of [-32603, -32000, -32050, -32099]) {
      expect(await rpc({ code, message: 'internal error' }), `JSON-RPC ${code}`).toMatchObject({ code: 'LINEAR_FAILED', outcome: 'unknown' });
    }
    // No code at all, or one this classification does not recognise: unknown, the safe direction.
    expect(await rpc({ message: 'it would not say' })).toMatchObject({ outcome: 'unknown' });
    expect(await rpc({ code: 1234, message: 'who knows' })).toMatchObject({ outcome: 'unknown' });
    // The message still reaches the owner unchanged, whichever half it fell in.
    expect(await rpc({ code: -32602, message: 'title is required' })).toMatchObject({ message: 'Linear rejected that: title is required' });
  });

  /**
   * The one rule the constructor keeps rather than trusting its callers with: there is no timeout
   * that PROVES the request was not sent, and a `LINEAR_TIMEOUT` written by a future edit must not be
   * able to read as safe-to-retry by leaving an argument off.
   */
  it('always treats a timeout as an unknown outcome, whoever constructed it', () => {
    expect(new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT).outcome).toBe('unknown');
    expect(new LinearError('LINEAR_TIMEOUT', 'x', undefined, 'refused').outcome).toBe('unknown');
    // Everything else keeps the safe default, so only a site that has thought about it says otherwise.
    expect(new LinearError('LINEAR_FAILED', 'x').outcome).toBe('refused');
  });

  it('the injected fetch type accepts the real global fetch', () => {
    // A compile-time assertion with a run-time body, so `tsc` is the thing under test: if the
    // structural `Fetch` type ever stops accepting the platform's own fetch, this line fails to build.
    const f: Parameters<typeof createLinearMcp>[0]['fetch'] = globalThis.fetch;
    expect(typeof f).toBe('function');
  });
});
