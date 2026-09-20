// Turns the preload's Result-returning bridge back into the throwing API §7 describes.
// Lives in shared/ (and is therefore Node-free and unit-testable) because it must run in the MAIN
// world: an Error constructed on the preload side of `contextBridge` arrives with `code` and
// `detail` stripped off, which is the whole reason this file exists.
import type { HangarApi, HangarBridge, IpcErrorShape, IpcReply, IpcRequestKey, IpcRequests } from './ipc-contract.ts';

/** The rejection every failed `invoke` produces. `code` is the string §14's behaviour keys off. */
export class IpcCallError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  constructor(shape: IpcErrorShape) {
    super(shape.message);
    this.name = 'IpcCallError';
    this.code = shape.code;
    this.detail = shape.detail;
  }
}

export function createHangarApi(bridge: HangarBridge): HangarApi {
  return {
    invoke<K extends IpcRequestKey>(
      channel: K,
      ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]
    ): Promise<IpcRequests[K]['res']> {
      // `bridge.invoke` carries the identical conditional rest tuple, but TS will not prove two
      // conditional types equal, so it is widened once here instead of at every call site.
      const call = bridge.invoke as (channel: K, ...rest: unknown[]) => Promise<IpcReply<IpcRequests[K]['res']>>;
      return call(channel, ...args).then((reply) => {
        if (reply.ok) return reply.value;
        throw new IpcCallError(reply.error);
      });
    },
    on: (channel, handler) => bridge.on(channel, handler),
  };
}
