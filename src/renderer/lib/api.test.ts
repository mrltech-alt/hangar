// @vitest-environment jsdom
//
// jsdom because `lib/api.ts` reads `window.hangar` at MODULE-EVALUATION time (`export const api =
// createHangarApi(window.hangar)`), so under vitest.config.ts's `environment: 'node'` merely
// importing it throws `ReferenceError: window is not defined`. That is also why every test here
// installs its bridge and then `await import(...)`s the module: a top-level static import would be
// hoisted above the setup and bind the wrong `window.hangar`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcSchemas } from '../../../shared/ipc-schemas.ts';
import type { HangarBridge, IpcReply } from '../../../shared/ipc-contract.ts';

type InvokeCall = [channel: string, ...rest: unknown[]];

/** Installs a fake `window.hangar` and returns a freshly evaluated `lib/api.ts` bound to it. */
async function loadApi(reply: (channel: string) => IpcReply<unknown>): Promise<{
  mod: typeof import('./api.ts');
  calls: InvokeCall[];
  emit: (payload: unknown) => void;
}> {
  const calls: InvokeCall[] = [];
  let listener: ((payload: unknown) => void) | null = null;
  const bridge = {
    invoke: (channel: string, ...rest: unknown[]) => {
      calls.push([channel, ...rest]);
      return Promise.resolve(reply(channel));
    },
    on: (_channel: string, handler: (payload: unknown) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
  } as unknown as HangarBridge;
  // The one cast in this file, and it is on the FAKE's shape, not on a real interface: `invoke`
  // here resolves `IpcReply<unknown>` where the bridge promises a per-key `res`, which is exactly
  // the widening `createHangarApi` and `src/preload/index.ts` each make for the same reason.
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const mod = await import('./api.ts');
  return { mod, calls, emit: (payload: unknown) => listener?.(payload) };
}

const ok = (value: unknown) => ({ ok: true as const, value });
const fail = (code: string, message = 'boom', detail?: string) => ({ ok: false as const, error: { code, message, detail } });

beforeEach(() => {
  vi.resetModules();
});

describe('the `undefined` that run() passes for a `req: void` key', () => {
  // api.ts's widening comment asserts this is "harmless — the preload takes `...args` and those
  // keys validate with `z.void()`". Both halves were unverified; these two tests are that claim.
  it('is forwarded as a real argument, which the preload accepts as `...args`', async () => {
    const { mod, calls } = await loadApi(() => ok(null));
    await mod.run('workspace:get');
    expect(calls).toEqual([['workspace:get', undefined]]);
  });

  it('passes the zod schema the main-process handler validates with', () => {
    expect(() => IpcSchemas['workspace:get'].parse(undefined)).not.toThrow();
    // Not vacuous — the same schema rejects a payload, so `parse` is really running.
    expect(() => IpcSchemas['workspace:get'].parse({ nope: 1 })).toThrow();
  });
});

describe('run()', () => {
  it('returns the value on success', async () => {
    const { mod } = await loadApi(() => ok({ agents: [] }));
    expect(await mod.run('workspace:get')).toEqual({ agents: [] });
  });

  it('returns null on failure and does not reject', async () => {
    const { mod } = await loadApi(() => fail('NO_PROJECT'));
    const onError = vi.fn();
    await expect(mod.run('agent:stop', { id: 'a1' }, onError)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('passes the per-key payload through untouched', async () => {
    const { mod, calls } = await loadApi(() => ok(undefined));
    await mod.run('agent:stop', { id: 'a1' });
    expect(calls).toEqual([['agent:stop', { id: 'a1' }]]);
  });

  it('gives the failure a `.code` the toast layer can switch on', async () => {
    const { mod } = await loadApi(() => fail('NO_PROJECT', 'no project x', 'detail here'));
    const onError = vi.fn();
    await mod.run('agent:stop', { id: 'a1' }, onError);
    const error = onError.mock.calls[0]?.[0] as Error & { code: string; detail?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NO_PROJECT');
    expect(error.detail).toBe('detail here');
    expect(error.message).toBe('no project x');
  });

  it('prefers the per-call onError over the sink, and uses the sink when none is given', async () => {
    const { mod } = await loadApi(() => fail('NO_PROJECT'));
    const sink = vi.fn();
    const onError = vi.fn();
    mod.setErrorSink(sink);

    await mod.run('agent:stop', { id: 'a1' }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();

    await mod.run('agent:stop', { id: 'a1' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('wraps a non-Error rejection as code INTERNAL rather than letting it escape', async () => {
    const { mod } = await loadApi(() => {
      throw 'a bare string';
    });
    const onError = vi.fn();
    await expect(mod.run('workspace:get', undefined, onError)).resolves.toBeNull();
    const error = onError.mock.calls[0]?.[0] as Error & { code: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('a bare string');
  });
});

describe('runResult()', () => {
  // `run`'s `null` cannot distinguish "IPC failed" from a channel whose own result is null —
  // `app:pickFolder` is `res: string | null`, where null means the user cancelled.
  it('separates a successful null from a failure', async () => {
    const cancelled = await loadApi(() => ok(null));
    await expect(cancelled.mod.runResult('app:pickFolder')).resolves.toEqual({ ok: true, value: null });
    expect(await cancelled.mod.run('app:pickFolder')).toBeNull();

    const broken = await loadApi(() => fail('INTERNAL'));
    const result = await broken.mod.runResult('app:pickFolder', undefined, () => {});
    expect(result.ok).toBe(false);
    expect(await broken.mod.run('app:pickFolder', undefined, () => {})).toBeNull();
  });
});

describe('isIpcFailure()', () => {
  it('accepts an Error carrying a string code', async () => {
    const { mod } = await loadApi(() => ok(null));
    expect(mod.isIpcFailure(Object.assign(new Error('x'), { code: 'NO_PROJECT' }))).toBe(true);
  });

  it('rejects a plain object that merely carries a code', async () => {
    const { mod } = await loadApi(() => ok(null));
    expect(mod.isIpcFailure({ code: 'NO_PROJECT', message: 'x' })).toBe(false);
  });

  it('rejects an Error with no code, and a non-object', async () => {
    const { mod } = await loadApi(() => ok(null));
    expect(mod.isIpcFailure(new Error('x'))).toBe(false);
    expect(mod.isIpcFailure(Object.assign(new Error('x'), { code: 500 }))).toBe(false);
    expect(mod.isIpcFailure('NO_PROJECT')).toBe(false);
    expect(mod.isIpcFailure(null)).toBe(false);
  });
});

describe('api.on()', () => {
  it('subscribes through the bridge and returns its disposer', async () => {
    const { mod, emit } = await loadApi(() => ok(null));
    const seen: unknown[] = [];
    const off = mod.api.on('workspace:changed', (s) => seen.push(s));
    emit({ tick: 1 });
    off();
    emit({ tick: 2 });
    expect(seen).toEqual([{ tick: 1 }]);
  });
});
