// The preload is the last thing between `HangarBridge` and the renderer, and P2-18b rewrote it last
// and late with neither a test nor a type assertion. The assertion now lives beside the code; this
// covers the behaviour, which is entirely about what the allow-lists do with a channel that is not
// on them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_EVENT_KEYS, IPC_REQUEST_KEYS } from '../../shared/ipc-contract.ts';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (channel: string, payload: unknown) => ({ ok: true, value: [channel, payload] }));
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => (exposed[key] = api) },
  ipcRenderer: {
    invoke: (channel: string, payload: unknown) => invoke(channel, payload),
    on: (channel: string, listener: unknown) => on(channel, listener),
    removeListener: (channel: string, listener: unknown) => removeListener(channel, listener),
  },
}));

type Api = {
  invoke(channel: string, payload?: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  on(channel: string, handler: (payload: unknown) => void): () => void;
};

let api: Api;
beforeEach(async () => {
  vi.clearAllMocks();
  await import('./index.ts');
  api = exposed.hangar as Api;
});

describe('preload bridge', () => {
  it('exposes exactly invoke and on under window.hangar', () => {
    expect(Object.keys(exposed)).toEqual(['hangar']);
    expect(Object.keys(api).sort()).toEqual(['invoke', 'on']);
  });

  it('forwards an allow-listed request and its payload', async () => {
    await expect(api.invoke('agent:stop', { id: 'a1' })).resolves.toEqual({ ok: true, value: ['agent:stop', { id: 'a1' }] });
    expect(invoke).toHaveBeenCalledWith('agent:stop', { id: 'a1' });
    // A `req: void` key is called with no payload at all — the arity `HangarBridge` describes.
    await api.invoke('workspace:get');
    expect(invoke).toHaveBeenLastCalledWith('workspace:get', undefined);
  });

  it('answers an unknown channel with an error REPLY rather than throwing or forwarding', async () => {
    const r = await api.invoke('agent:selfDestruct', {});
    expect(r).toEqual({ ok: false, error: { code: 'BAD_CHANNEL', message: 'unknown IPC channel: agent:selfDestruct' } });
    expect(invoke).not.toHaveBeenCalled();
    // An event key is not a request key: the two allow-lists are separate on purpose.
    expect((await api.invoke('toast', {})).ok).toBe(false);
  });

  it('subscribes to an allow-listed event, unwraps the IpcRendererEvent, and removes on dispose', () => {
    const seen: unknown[] = [];
    const dispose = api.on('toast', (p) => seen.push(p));
    const [channel, listener] = on.mock.calls[0] as [string, (e: unknown, p: unknown) => void];
    expect(channel).toBe('toast');
    listener({ sender: 'ignored' }, { level: 'info', title: 'hi' });
    expect(seen).toEqual([{ level: 'info', title: 'hi' }]);
    dispose();
    expect(removeListener).toHaveBeenCalledWith('toast', listener);
  });

  it('throws on an unknown event, because there is no reply channel to report it on', () => {
    expect(() => api.on('agent:progres', () => {})).toThrow(/unknown IPC event/);
    expect(on).not.toHaveBeenCalled();
  });

  it('passes every contract key through both allow-lists', async () => {
    for (const k of IPC_REQUEST_KEYS) expect(await api.invoke(k, undefined)).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(IPC_REQUEST_KEYS.length);
    for (const k of IPC_EVENT_KEYS) expect(() => api.on(k, () => {})).not.toThrow();
    expect(on).toHaveBeenCalledTimes(IPC_EVENT_KEYS.length);
  });
});
