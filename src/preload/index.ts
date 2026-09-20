// Exposes exactly two functions as window.hangar (spec §7, §16). Channels are allow-listed.
// `invoke` RESOLVES with a Result and never rejects on a handler error: `contextBridge` copies
// values between worlds and strips a thrown Error down to `message` + `stack`, so `code` and
// `detail` would die here. shared/ipc-client.ts rebuilds the Error in the main world instead.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_EVENT_KEYS, IPC_REQUEST_KEYS, type HangarBridge, type IpcEventKey, type IpcRequestKey } from '../../shared/ipc-contract.ts';

const requestKeys = new Set<string>(IPC_REQUEST_KEYS);
const eventKeys = new Set<string>(IPC_EVENT_KEYS);

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; detail?: string } };

const api = {
  // `...args`, not `payload: unknown`: this is the ARITY half of `HangarBridge.invoke`, whose
  // parameter list is a conditional rest tuple (empty for the four `req: void` keys). A fixed second
  // parameter made `typeof api` unassignable to the contract on arity alone, which is why the
  // assertion at the bottom of this file could not exist before.
  async invoke(channel: string, ...args: unknown[]): Promise<Reply> {
    const payload = args[0];
    // An error reply, not a throw, so an unknown channel reaches the renderer's single error
    // handler with a code like every other failure rather than as a bare stack.
    if (!requestKeys.has(channel)) return { ok: false, error: { code: 'BAD_CHANNEL', message: `unknown IPC channel: ${channel}` } };
    return (await ipcRenderer.invoke(channel, payload)) as Reply;
  },
  on(channel: string, handler: (payload: unknown) => void): () => void {
    if (!eventKeys.has(channel)) throw new Error(`unknown IPC event: ${channel}`);
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('hangar', api);

/**
 * Compile-time guard on the boundary the renderer actually meets — this file is the LAST thing
 * between `HangarBridge` and the renderer, and it had neither a test nor an assertion.
 *
 * A blanket `const _: HangarBridge = api` cannot work: `invoke` here resolves `{ value: unknown }`
 * and the contract promises a per-key `res`, which is the one cast this file is entitled to make
 * (see the header), and for the same reason it cannot check the payload `on` hands a listener.
 * Everything else is: `invoke`'s channel type and its arity, `on`'s channel type and its disposer
 * return, and — via the key-parity pair below — a member appearing on or disappearing from either
 * side. That is the half P2-18b could have broken silently.
 *
 * Restated rather than derived with `Omit<HangarBridge, 'invoke'>`: the mapped type turns `on` into
 * a function PROPERTY, whose `handler` parameter is then compared strictly contravariantly, and no
 * preload `on` taking `unknown` can satisfy the contract's per-event payload under that rule.
 */
interface PreloadShape {
  invoke(channel: IpcRequestKey, ...args: never[]): Promise<unknown>;
  on(channel: IpcEventKey, handler: (payload: unknown) => void): () => void;
}
const _apiMatchesBridge: PreloadShape = api;
void _apiMatchesBridge;
const _bridgeMembersCovered: keyof PreloadShape = null as unknown as keyof HangarBridge;
const _preloadMembersCovered: keyof HangarBridge = null as unknown as keyof PreloadShape;
void _bridgeMembersCovered;
void _preloadMembersCovered;
