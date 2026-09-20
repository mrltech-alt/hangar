import { create } from 'zustand';
import type { IpcRequests } from '../../../shared/ipc-contract.ts';
import { defaultAppConfig, type AppConfig } from '../../../shared/types.ts';
import { run } from '../lib/api.ts';

/**
 * The `config:set` payload, taken from the contract rather than re-typed.
 *
 * The plan wrote `Partial<AppConfig>`, which is NOT what `shared/ipc-contract.ts` declares:
 * `Partial<Omit<AppConfig, 'version' | 'terminal'>> & { terminal?: Partial<AppConfig['terminal']> }`.
 * The difference is real in both directions — `version` is main's to migrate, not the renderer's to
 * write, and a caller must be able to send `{ terminal: { fontSize: 14 } }` without restating
 * `fontFamily` and `scrollback`. `Partial<AppConfig>` forbids the second and permits the first.
 * Aliasing the contract means a change there fails here instead of drifting.
 */
export type ConfigPatch = IpcRequests['config:set']['req'];

interface ConfigState {
  config: AppConfig;
  load: () => Promise<void>;
  set: (patch: ConfigPatch) => Promise<void>;
}

/**
 * `config.json` (§6.7), mirrored into the renderer. Read by `TerminalView` for font and scrollback
 * (Task 6) and by Settings (Phase 3); `bootstrap()` loads it once at startup.
 *
 * `shellPath: ''` in the placeholder, not the plan's `'/bin/zsh'`. Main injects the real value from
 * `process.env.SHELL` (§9 — `shared/` cannot read env), so the renderer has no way to know it and
 * inventing a plausible-looking one makes a wrong value indistinguishable from a right one in the
 * window between mount and the first reply. Nothing in the renderer reads `shellPath`; the empty
 * string says "not loaded yet" out loud.
 */
export const useConfig = create<ConfigState>((setState) => ({
  config: defaultAppConfig(''),
  // `run`, not `api.invoke`. `api` is the WRAPPED client, which THROWS; `void api.invoke(...)` — the
  // plan's shape — handles no rejection, so a `config:get` that fails (host down, a rejected
  // payload) is an unhandled promise rejection in the console and nothing else. `run` funnels it to
  // the error sink `bootstrap()` installs, which is what turns it into a toast. Same correction
  // Plan 02 made to `layout:set` and Task 2 made to `workspace:get`.
  //
  // The guard is not defensive noise: `run` returns `null` on failure, and writing that over
  // `config` would replace a usable default with a value whose every field access throws. A failed
  // load leaves the defaults in place, which is exactly what a renderer with no config should show.
  load: async () => {
    const config = await run('config:get');
    if (config) setState({ config });
  },
  set: async (patch) => {
    const config = await run('config:set', patch);
    if (config) setState({ config });
  },
}));
