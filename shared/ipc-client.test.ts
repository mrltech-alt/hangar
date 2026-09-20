import { describe, expect, it, vi } from 'vitest';
import { createHangarApi, IpcCallError } from './ipc-client.ts';
import type { HangarBridge, IpcReply } from './ipc-contract.ts';

const bridgeOf = (reply: IpcReply<unknown>, calls: unknown[][] = []): HangarBridge =>
  ({
    invoke: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(reply);
    },
    on: () => () => undefined,
  }) as unknown as HangarBridge;

describe('createHangarApi', () => {
  it('unwraps a successful reply to its value', async () => {
    const api = createHangarApi(bridgeOf({ ok: true, value: { workspace: 'x' } }));
    await expect(api.invoke('workspace:get')).resolves.toEqual({ workspace: 'x' });
  });

  it('forwards the channel and payload verbatim, and passes NO payload argument for a void request', async () => {
    const calls: unknown[][] = [];
    const api = createHangarApi(bridgeOf({ ok: true, value: null }, calls));
    await api.invoke('project:add', { repoPath: '/r' });
    await api.invoke('workspace:get');
    expect(calls).toEqual([['project:add', { repoPath: '/r' }], ['workspace:get']]);
  });

  it('rejects with an Error that KEEPS code and detail — the property contextBridge strips', async () => {
    const api = createHangarApi(bridgeOf({ ok: false, error: { code: 'PATH_EXISTS', message: 'already there', detail: '/tmp/x' } }));
    const e = await api.invoke('project:add', { repoPath: '/r' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IpcCallError);
    expect(e).toBeInstanceOf(Error);
    const err = e as IpcCallError;
    expect(err.code).toBe('PATH_EXISTS');
    expect(err.detail).toBe('/tmp/x');
    expect(err.message).toBe('already there');
    // The point of the whole file: these survive as OWN properties on a main-world Error.
    expect(Object.hasOwn(err, 'code')).toBe(true);
  });

  it('leaves detail undefined when the reply omits it, rather than inventing a string', async () => {
    const api = createHangarApi(bridgeOf({ ok: false, error: { code: 'HOST_DOWN', message: 'no host' } }));
    const err = (await api.invoke('agent:stop', { id: 'a' }).catch((x: unknown) => x)) as IpcCallError;
    expect(err.detail).toBeUndefined();
    expect(err.code).toBe('HOST_DOWN');
  });

  it('passes `on` straight through and returns the bridge unsubscribe function', () => {
    const off = vi.fn();
    const on = vi.fn(() => off);
    const api = createHangarApi({ invoke: () => Promise.resolve({ ok: true, value: null }), on } as unknown as HangarBridge);
    const handler = (): void => undefined;
    expect(api.on('toast', handler)).toBe(off);
    expect(on).toHaveBeenCalledWith('toast', handler);
  });
});
