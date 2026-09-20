import { createHangarApi } from '../../../shared/ipc-client.ts';
import type { HangarApi, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';

// Wrapped exactly once, here, in the main world — the only side of contextBridge where an Error
// keeps its own properties. `isIpcFailure` below is what reads the `.code` this preserves.
export const api: HangarApi = createHangarApi(window.hangar);

export interface IpcFailure extends Error {
  code: string;
  detail?: string;
}

export function isIpcFailure(e: unknown): e is IpcFailure {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string';
}

/**
 * `run`'s outcome, kept separate from the value so a caller can tell "the call failed" from "the
 * call succeeded and the answer is null". `run` below flattens this to `T | null` because that is
 * what almost every call site wants, but the flattening is genuinely lossy for the one request
 * whose own result type includes null — `app:pickFolder` is `res: string | null`, where `null`
 * means "the user cancelled the picker". Reach for `runResult` when the difference matters.
 */
export type RunResult<T> = { ok: true; value: T } | { ok: false; error: IpcFailure };

/** Invoke and route failures to a toast (registered by the ui store in Task 2), without flattening. */
export async function runResult<K extends IpcRequestKey>(channel: K, payload?: IpcRequests[K]['req'], onError?: (e: IpcFailure) => void): Promise<RunResult<IpcRequests[K]['res']>> {
  // `HangarApi.invoke`'s payload is a CONDITIONAL rest tuple (empty for the four `req: void`
  // keys — `workspace:get`, `config:get`, `app:pickFolder`, `host:status`), and TS will not
  // evaluate that conditional for an unresolved `K`: `api.invoke(channel, payload)` is a TS2345
  // here and nowhere else. Widened once, exactly as `createHangarApi` widens the bridge
  // internally, so every `run(...)` call site keeps its per-key payload checking. The extra
  // `undefined` this passes for a `req: void` key is harmless — the preload takes `...args` and
  // those keys validate with `z.void()`; `api.test.ts` asserts both halves of that sentence.
  const call = api.invoke as (channel: K, ...rest: unknown[]) => Promise<IpcRequests[K]['res']>;
  try {
    return { ok: true, value: await call(channel, payload) };
  } catch (e) {
    const error: IpcFailure = isIpcFailure(e) ? e : Object.assign(new Error(String(e)), { code: 'INTERNAL' });
    (onError ?? errorSink)(error);
    return { ok: false, error };
  }
}

/**
 * Invoke and route failures to a toast. Returns null on failure.
 *
 * `payload` is OPTIONAL rather than required so the four `req: void` keys keep the call shape the
 * contract's conditional rest tuple exists to give them: `run('workspace:get')`, not
 * `run('workspace:get', undefined)`. The widening cast above erases the conditional, so without
 * the `?` every one of those call sites would be a TS2554. Per-key payload checking survives the
 * widening — `run('agent:stop', { nope: 1 })` is still a TS2353.
 */
export async function run<K extends IpcRequestKey>(channel: K, payload?: IpcRequests[K]['req'], onError?: (e: IpcFailure) => void): Promise<IpcRequests[K]['res'] | null> {
  const result = await runResult(channel, payload, onError);
  return result.ok ? result.value : null;
}

const DEFAULT_ERROR_SINK = (e: IpcFailure): void => console.error(e);
let errorSink: (e: IpcFailure) => void = DEFAULT_ERROR_SINK;
export function setErrorSink(sink: (e: IpcFailure) => void): void {
  errorSink = sink;
}

/**
 * Hands a failure to the sink `run` would have used. For an `onError` that explains SOME codes itself
 * and must pass every other one on exactly as `run` would have (`dictationRefused` is one).
 */
export function reportError(e: IpcFailure): void {
  errorSink(e);
}

/**
 * Puts the sink back to `console.error`. `bootstrap()` installs a sink that writes into the ui
 * store and must be able to undo that on dispose: React 19 StrictMode double-invokes effects in
 * dev, so bootstrap -> dispose -> bootstrap is the EXPECTED path, and a sink left pointing at a
 * torn-down bootstrap's closure is a leak that outlives it.
 */
export function resetErrorSink(): void {
  errorSink = DEFAULT_ERROR_SINK;
}
