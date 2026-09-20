/**
 * `config.ts` is three lines of store, but two of them decide what the app does when `config:get`
 * or `config:set` FAILS — and the plan's version got that wrong in the same way Plan 02 got
 * `layout:set` and Task 2 got `workspace:get` wrong: `void api.invoke(...)` on the wrapped client,
 * which throws, so a failure is an unhandled rejection and nothing else.
 *
 * Same loading dance as `api.test.ts` and `bootstrap.test.ts`: `lib/api.ts` reads `window.hangar`
 * at module-evaluation time, so the bridge is installed first and every module imported
 * dynamically after `vi.resetModules()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcReply } from '../../../shared/ipc-contract.ts';
import { defaultAppConfig, type AppConfig } from '../../../shared/types.ts';

const REAL: AppConfig = { ...defaultAppConfig('/bin/fish'), notifications: 'off', terminal: { fontSize: 15, fontFamily: 'Iosevka', scrollback: 50_000 } };

async function load(reply: IpcReply<unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  const bridge = {
    invoke: (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      return Promise.resolve(reply);
    },
    on: () => () => undefined,
  } as unknown as HangarBridge;
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [{ useConfig }, api] = await Promise.all([import('./config.ts'), import('../lib/api.ts')]);
  return { useConfig, api, calls };
}

beforeEach(() => {
  vi.resetModules();
});

describe('config store', () => {
  it('starts on the defaults, with shellPath left empty rather than guessed', async () => {
    const { useConfig } = await load({ ok: true, value: REAL });
    // The renderer cannot know the user's shell — main injects it from `process.env.SHELL` (§9) —
    // so the placeholder says "not loaded" instead of asserting a plausible-looking `/bin/zsh`.
    expect(useConfig.getState().config.shellPath).toBe('');
    expect(useConfig.getState().config.terminal.fontSize).toBe(13);
  });

  it('load() replaces the defaults with what main sends', async () => {
    const { useConfig, calls } = await load({ ok: true, value: REAL });
    await useConfig.getState().load();
    expect(useConfig.getState().config).toEqual(REAL);
    expect(calls.map((c) => c.channel)).toEqual(['config:get']);
  });

  it('set() sends the patch and stores the config main sends back', async () => {
    const { useConfig, calls } = await load({ ok: true, value: REAL });
    await useConfig.getState().set({ terminal: { fontSize: 15 } });
    expect(calls[0]).toEqual({ channel: 'config:set', payload: { terminal: { fontSize: 15 } } });
    expect(useConfig.getState().config).toEqual(REAL);
  });

  // The bug the plan's `void api.invoke(...)` would have shipped. `api` is the WRAPPED client: it
  // REJECTS on a failed reply. Before the correction this was an unhandled rejection in the
  // console; now it lands in the error sink `bootstrap()` points at the toast store.
  it('routes a failed load to the error sink instead of rejecting', async () => {
    const { useConfig, api } = await load({ ok: false, error: { code: 'HOST_DOWN', message: 'host is down' } });
    const seen: string[] = [];
    api.setErrorSink((e) => void seen.push(e.code));
    await expect(useConfig.getState().load()).resolves.toBeUndefined();
    expect(seen).toEqual(['HOST_DOWN']);
  });

  // `run` returns null on failure, and `set({ config: null })` would replace a usable default with
  // a value whose every field access throws — in `TerminalView`, on the next render.
  it('keeps the existing config when a call fails', async () => {
    const { useConfig, api } = await load({ ok: false, error: { code: 'HOST_DOWN', message: 'host is down' } });
    api.setErrorSink(() => undefined);
    const before = useConfig.getState().config;
    await useConfig.getState().load();
    await useConfig.getState().set({ notifications: 'off' });
    expect(useConfig.getState().config).toBe(before);
  });
});
