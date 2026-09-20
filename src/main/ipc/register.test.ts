// `registerIpc` is the authorisation choke point: every renderer call enters main through it, and
// it decides what is validated, what reaches a service, and what is told back. `contract.test.ts`
// checks the keys, schemas and handlers AGREE with each other; nothing checked that this function
// actually wires them, or that a failure reply cannot leak a main-process stack.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_REQUEST_KEYS } from '../../../shared/ipc-contract.ts';
import type { Logger } from '../services/logger.ts';
import { IpcError } from './errors.ts';
import type { Handlers } from './handlers.ts';

type Bound = (event: unknown, payload: unknown) => Promise<unknown>;
const { registered } = vi.hoisted(() => ({ registered: new Map<string, Bound>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, fn: Bound) {
      if (registered.has(channel)) throw new Error(`ipcMain.handle called twice for ${channel}`);
      registered.set(channel, fn);
    },
  },
}));

const { describeIssues, registerIpc } = await import('./register.ts');

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; detail?: string } };

let logged: string[];
const log = (): Logger => ({
  info: (l) => logged.push(`INFO ${l}`),
  warn: (l) => logged.push(`WARN ${l}`),
  error: (l) => logged.push(`ERROR ${l}`),
  close: () => undefined,
});

const calls: { key: string; req: unknown }[] = [];
let behaviour: (key: string) => unknown = () => 'ok';
const fakeHandlers = (): Handlers =>
  Object.fromEntries(
    IPC_REQUEST_KEYS.map((k) => [
      k,
      async (req: unknown) => {
        calls.push({ key: k, req });
        return behaviour(k);
      },
    ]),
  ) as unknown as Handlers;

const call = (channel: string, payload: unknown): Promise<Reply> => registered.get(channel)!(null, payload) as Promise<Reply>;

beforeEach(() => {
  registered.clear();
  calls.length = 0;
  logged = [];
  behaviour = () => 'ok';
  registerIpc(fakeHandlers(), log());
});

describe('registerIpc wiring', () => {
  it('registers exactly IPC_REQUEST_KEYS — no channel more, no channel less', () => {
    expect([...registered.keys()].sort()).toEqual([...IPC_REQUEST_KEYS].sort());
  });

  /**
   * The payload the Files tab sends FIRST: `relPath: ''` is the worktree root.
   *
   * This test exists because the bug it covers lived in the seam and neither side could see it.
   * `contract.test.ts` checks schemas, `handlers.test.ts` calls `createHandlers` directly, and
   * `tsc` compares `string` with `string` — so a `.min(1)` shared by all three path keys turned the
   * tab's opening request into a `BAD_REQUEST` reply that never reached a handler, with all three
   * gates green. Only a payload driven through `registerIpc`, the way the renderer drives it, shows
   * whether validation and the handler agree about what a legal request is.
   */
  it('lets the Files tab open on the worktree root, and still refuses it where it is meaningless', async () => {
    expect(await call('fs:list', { agentId: 'ag', workspaceId: 'w', relPath: '' })).toEqual({ ok: true, value: 'ok' });
    expect(calls).toEqual([{ key: 'fs:list', req: { agentId: 'ag', workspaceId: 'w', relPath: '' } }]);
    // The root is not a file and not a diffable path: refused by the schema, before any handler.
    for (const key of ['fs:read', 'git:fileDiff'] as const) {
      expect(await call(key, { agentId: 'ag', workspaceId: 'w', relPath: '' }), key).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
    expect(calls.map((c) => c.key)).toEqual(['fs:list']);
  });
  it('registers every channel exactly once', () => {
    // The mocked ipcMain throws on a duplicate, and a real one would too ("second handler").
    expect(registered.size).toBe(IPC_REQUEST_KEYS.length);
  });
});

describe('validation happens before the handler', () => {
  it('rejects a malformed payload with BAD_REQUEST and NEVER calls the handler', async () => {
    const reply = await call('project:add', { repoPath: 42 });
    expect(reply).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: 'invalid payload for project:add', detail: 'repoPath: Invalid input: expected string, received number' } });
    expect(calls).toEqual([]);
  });
  it('rejects a payload on a void channel — a renderer may not smuggle one past z.void()', async () => {
    const reply = (await call('workspace:get', { evil: true })) as { ok: false; error: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('BAD_REQUEST');
    expect(calls).toEqual([]);
  });
  it('accepts undefined on a void channel and forwards the parsed data to the handler', async () => {
    await expect(call('workspace:get', undefined)).resolves.toEqual({ ok: true, value: 'ok' });
    expect(calls).toEqual([{ key: 'workspace:get', req: undefined }]);
  });
  it('forwards the PARSED payload, not the raw one', async () => {
    await call('project:add', { repoPath: '/r', extra: 'stripped by zod' });
    expect(calls).toEqual([{ key: 'project:add', req: { repoPath: '/r' } }]);
  });
  it('logs the offending field rather than zod 4 pretty-print noise', async () => {
    await call('project:add', { repoPath: 42 });
    expect(logged).toEqual(['WARN project:add: invalid payload: repoPath: Invalid input: expected string, received number']);
    expect(logged[0]).not.toContain('[');
  });
});

describe('handler failures become structured replies', () => {
  it('keeps the code of an IpcError', async () => {
    behaviour = () => {
      throw new IpcError('PATH_EXISTS', 'already there', '/tmp/x');
    };
    expect(await call('project:add', { repoPath: '/r' })).toEqual({ ok: false, error: { code: 'PATH_EXISTS', message: 'already there', detail: '/tmp/x' } });
  });
  it('keeps the code of any error carrying a string `code` (StoreError, GitError, HostRequestError)', async () => {
    behaviour = () => {
      throw Object.assign(new Error('no host'), { code: 'HOST_DOWN' });
    };
    expect(await call('agent:stop', { id: 'a' })).toEqual({ ok: false, error: { code: 'HOST_DOWN', message: 'no host' } });
  });
  it('turns a plain Error into INTERNAL', async () => {
    behaviour = () => {
      throw new Error('boom');
    };
    expect(await call('agent:stop', { id: 'a' })).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'boom' } });
  });
  it('stringifies a non-Error throw instead of replying with undefined', async () => {
    behaviour = () => {
      throw 'just a string';
    };
    expect(await call('agent:stop', { id: 'a' })).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'just a string' } });
  });
  // Spec §8: a cancelled Linear look-up is the user's choice. Same reply and same line, but not a warning.
  it('logs a CANCELLED failure at info and every other failure at warn, with the same reply shape', async () => {
    behaviour = () => {
      throw Object.assign(new Error('The look-up was cancelled.'), { code: 'CANCELLED' });
    };
    expect(await call('linear:triage', { requestId: 'r1', ref: 'AC-3461' })).toEqual({ ok: false, error: { code: 'CANCELLED', message: 'The look-up was cancelled.' } });
    behaviour = () => {
      throw Object.assign(new Error('took too long'), { code: 'TIMEOUT' });
    };
    await call('linear:triage', { requestId: 'r2', ref: 'AC-3461' });
    expect(logged).toEqual(['INFO linear:triage failed: CANCELLED The look-up was cancelled.', 'WARN linear:triage failed: TIMEOUT took too long']);
  });
  it('never lets a rejection escape ipcMain.handle', async () => {
    behaviour = () => {
      throw new Error('boom');
    };
    await expect(call('agent:stop', { id: 'a' })).resolves.toBeDefined();
  });
});

describe('replies never carry a main-process stack', () => {
  it('omits `stack` for a thrown Error, a validation failure and a success alike', async () => {
    const replies: Reply[] = [];
    behaviour = () => {
      throw new Error('deliberate failure');
    };
    replies.push(await call('agent:stop', { id: 'a' }));
    replies.push(await call('project:add', { repoPath: 42 }));
    behaviour = () => ({ fine: true });
    replies.push(await call('workspace:get', undefined));
    for (const r of replies) {
      expect(JSON.stringify(r)).not.toMatch(/stack|register\.test\.ts|at Object|\.ts:\d+/);
      if (!r.ok) expect(Object.keys(r.error).sort()).toEqual(r.error.detail === undefined ? ['code', 'message'] : ['code', 'detail', 'message']);
    }
  });
});

describe('describeIssues', () => {
  it('names the path, joins multiple issues, and coerces symbol segments instead of throwing', () => {
    expect(describeIssues([{ path: ['a', 'b'], message: 'bad' }])).toBe('a.b: bad');
    expect(describeIssues([{ path: [], message: 'top level' }])).toBe('top level');
    expect(describeIssues([{ path: ['a'], message: 'x' }, { path: [0], message: 'y' }])).toBe('a: x; 0: y');
    expect(describeIssues([{ path: [Symbol('s')], message: 'z' }])).toBe('Symbol(s): z');
    expect(describeIssues([])).toBe('invalid');
  });
});
