// config.json — spec §6.7. Validated on load, because this is the file users edit by hand.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import type { IpcRequests } from '../../../shared/ipc-contract.ts';
import { defaultAppConfig, type AppConfig } from '../../../shared/types.ts';
import { PermissionModeSchema } from '../../../shared/workspace-schema.ts';
import { atomicWriteJson } from '../util/atomic-write.ts';

/**
 * The same constraints `IpcSchemas['config:set']` puts on the renderer, applied to the file on disk.
 *
 * Without this the on-disk path was strictly weaker than the IPC path it feeds: `fontSize: -5`,
 * `notifications: 'BOGUS'` and `shellPath: {}` are all rejected from the renderer and were all
 * accepted from the file, then handed back by `config:get` and — for `shellPath`/`nodeBin` — used to
 * spawn the PTY and the host. §6.7 documents `nodeBin` as hand-edited, which is exactly where a
 * typo lands. `workspace.json`, the sibling file, has had a full schema all along.
 *
 * Held here rather than in `shared/`: this is the only consumer, and `shared/` is bundled into the
 * renderer. The cost is that the two definitions could drift, so `config-store.test.ts` asserts
 * agreement with `IpcSchemas['config:set']` over a table of values rather than trusting the comment.
 */
export const AppConfigFieldSchemas = {
  nodeBin: z.string().nullable(),
  shellPath: z.string().min(1),
  notifications: z.enum(['attention', 'all', 'off']),
  terminal: {
    fontSize: z.number().min(8).max(32),
    fontFamily: z.string().min(1),
    scrollback: z.number().int().min(100).max(100_000),
  },
  // `.min(1)` per element: an empty string would reach every launch as a literal '' argument.
  claudeDefaultArgs: z.array(z.string().min(1)),
  // Absolute, because a relative folder would resolve against whatever cwd Electron was launched
  // with — a Finder launch and a terminal launch would read different directories.
  reposDir: z.string().refine((p) => p.startsWith('/'), 'must be an absolute path').nullable(),
  // It is handed to `claude` as the value of `--model`. A leading `-` is rejected so the value cannot
  // be read as a flag instead of a model name — a guard only; how `claude` would actually parse such a
  // value was not measured. Surrounding whitespace is rejected as a hand-edit typo.
  triageModel: z.string().min(1).refine((m) => m.trim() === m && !m.startsWith('-'), 'must be a model name: not a flag, no surrounding whitespace'),
  // The schema the persisted `agent.claude.permissionMode` and `agent:create` already use, so a mode
  // this file accepts is one an agent can actually be created with.
  defaultPermissionMode: PermissionModeSchema.nullable(),
};

/**
 * What `set()` actually accepts. `Partial<AppConfig>` was too narrow to describe it: `terminal` is a
 * nested object, so `Partial` still demanded all three of its fields, while the merge below has
 * always been written to take a subset. A settings UI changing only the font size sends exactly that
 * subset, and the type forbade it — so the merge went untested and three mutations to it survived.
 * `version` is excluded for the reason `ipc-contract.ts` gives: it is the on-disk migration marker.
 */
export type ConfigPatch = Partial<Omit<AppConfig, 'version' | 'terminal'>> & { terminal?: Partial<AppConfig['terminal']> };

export interface ConfigStore {
  get(): AppConfig;
  set(patch: ConfigPatch): AppConfig;
  /** Writes any pending change now. False only if a write was attempted and failed; never throws. */
  flush(): boolean;
  /** The most recent write failure, or null if the last attempted write succeeded. */
  lastWriteError(): Error | null;
  /**
   * What was wrong with `config.json` at load: a corrupt file that was preserved and reset, or a
   * field that failed validation and fell back to its default. Empty when the file was clean or
   * absent.
   *
   * This exists so the caller can TELL THE USER. `workspace.json`'s loader returns a `LoadResult`
   * whose `problems` become a sticky toast; this store does its load in the constructor and
   * returned nothing, so the identical recovery on the identical kind of file — both preserved as
   * `.corrupt-<ts>`, both reset — was invisible unless the user went looking in `app.log`.
   *
   * Load-time only: a write failure is `lastWriteError()`, which is live state rather than a
   * one-off report.
   */
  problems(): string[];
}

export interface ConfigStoreOptions {
  log?: (line: string) => void;
  now?: () => Date;
}

/** A failed write is retried on a timer rather than spun on: EACCES and ENOSPC clear on a human timescale. */
const RETRY_MS = 2_000;

export function createConfigStore(file: string, shellPath: string, options: ConfigStoreOptions = {}): ConfigStore {
  const logLine = options.log ?? ((): void => {});
  const problems: string[] = [];
  /**
   * Load-time complaints go to the log AND to `problems()`, so the user sees them. Everything below
   * that reports on the FILE uses this; runtime write failures keep using `logLine` directly, since
   * those are reported through `lastWriteError()` instead.
   */
  const log = (line: string): void => {
    problems.push(line);
    logLine(line);
  };
  const now = options.now ?? ((): Date => new Date());
  const defaults = defaultAppConfig(shellPath);

  let cfg = defaults;
  let dirty = false;
  let writeError: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = (): boolean => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return true;
    try {
      atomicWriteJson(file, cfg);
    } catch (e) {
      // `set()` is called straight from an IPC handler and this also runs from a `setTimeout`, where
      // a throw is an uncaught exception — an app crash with no dialog. Stay dirty, retry, and let
      // the caller see the failure through `lastWriteError()`. Same reasoning as `workspace-store`.
      writeError = e instanceof Error ? e : new Error(String(e));
      logLine(`config write to ${file} failed: ${writeError.message}`);
      timer = setTimeout(write, RETRY_MS);
      // A retry that never succeeds must not be the only thing holding the process open.
      timer.unref?.();
      return false;
    }
    dirty = false;
    writeError = null;
    return true;
  };

  const reason = (e: z.ZodError): string => e.issues[0]?.message ?? 'invalid value';

  /**
   * Per field, not per file: one bad value must not cost the user the rest of their settings. This is
   * the same "repair, never reject" rule `workspace-store.repairTree` follows, and for the same
   * reason — whole-file rejection over a single typo is the destructive answer.
   */
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T, label: string): T => {
    if (value === undefined) return fallback;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    log(`${file}: ${label} is invalid (${reason(parsed.error)}); using the default`);
    return fallback;
  };

  const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

  const coerce = (raw: unknown): AppConfig => {
    if (!isPlainObject(raw)) {
      // An array spread into the defaults, producing "0", "1", … keys alongside real ones.
      log(`${file}: is not a JSON object; using defaults`);
      return defaults;
    }
    let terminal: Record<string, unknown> = {};
    if (raw.terminal !== undefined) {
      if (isPlainObject(raw.terminal)) terminal = raw.terminal;
      else log(`${file}: terminal is not an object; using the defaults for it`);
    }
    const S = AppConfigFieldSchemas;
    return {
      // Not read from the file: this build writes and reads version 1 only. A `version` bump needs a
      // migration ladder like `workspace-store`'s, and inventing one here would be worse than not.
      version: 1,
      nodeBin: pick(S.nodeBin, raw.nodeBin, defaults.nodeBin, 'nodeBin'),
      shellPath: pick(S.shellPath, raw.shellPath, defaults.shellPath, 'shellPath'),
      notifications: pick(S.notifications, raw.notifications, defaults.notifications, 'notifications'),
      terminal: {
        fontSize: pick(S.terminal.fontSize, terminal.fontSize, defaults.terminal.fontSize, 'terminal.fontSize'),
        fontFamily: pick(S.terminal.fontFamily, terminal.fontFamily, defaults.terminal.fontFamily, 'terminal.fontFamily'),
        scrollback: pick(S.terminal.scrollback, terminal.scrollback, defaults.terminal.scrollback, 'terminal.scrollback'),
      },
      claudeDefaultArgs: pick(S.claudeDefaultArgs, raw.claudeDefaultArgs, defaults.claudeDefaultArgs, 'claudeDefaultArgs'),
      reposDir: pick(S.reposDir, raw.reposDir, defaults.reposDir, 'reposDir'),
      triageModel: pick(S.triageModel, raw.triageModel, defaults.triageModel, 'triageModel'),
      defaultPermissionMode: pick(S.defaultPermissionMode, raw.defaultPermissionMode, defaults.defaultPermissionMode, 'defaultPermissionMode'),
    };
  };

  /** `<file>.corrupt-<timestamp>`, suffixed if taken — clobbering it would lose the earlier copy. */
  const uniqueCorruptName = (): string => {
    const base = `${file}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    let target = base;
    for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;
    return target;
  };

  if (existsSync(file)) {
    let text: string | null = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      // An I/O failure is not corruption, and the difference is destructive: `rename` needs only
      // directory permission, so a healthy config that merely could not be OPENED would be moved
      // aside. Run on defaults and leave the file alone.
      log(`${file}: cannot be read (${e instanceof Error ? e.message : String(e)}); using defaults`);
    }
    if (text !== null) {
      let raw: unknown;
      let corrupt: string | null = null;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        corrupt = e instanceof Error ? e.message : String(e);
      }
      if (corrupt === null) {
        cfg = coerce(raw);
      } else {
        // §5.2 gives config.json no `.bak`, so defaults are the only recovery — but the user's file
        // must not simply vanish under the next `set()`, which is what a bare `catch {}` here meant.
        const target = uniqueCorruptName();
        try {
          renameSync(file, target);
          log(`${file}: corrupt (${corrupt}); preserved as ${target} and reset to defaults`);
        } catch (e) {
          log(`${file}: corrupt (${corrupt}) and could not be preserved (${e instanceof Error ? e.message : String(e)}); it will be overwritten on the next change`);
        }
      }
    }
  }

  return {
    get: () => cfg,
    set(patch) {
      cfg = { ...cfg, ...patch, terminal: { ...cfg.terminal, ...(patch.terminal ?? {}) }, version: 1 };
      dirty = true;
      write();
      return cfg;
    },
    flush: write,
    lastWriteError: () => writeError,
    problems: () => [...problems],
  };
}

/**
 * Compile-time guard: the renderer-facing contract for `config:set` must be exactly what the store
 * accepts. It drifted once already — `ConfigPatch` was widened here so a settings UI could send a
 * partial `terminal`, `IpcRequests['config:set']['req']` was not, and `handlers.ts` (typed by the
 * contract) could no longer express the very patch this store was widened to take.
 *
 * `ipc-schemas.ts` has a pair like this for `IpcRequests` ↔ `IpcSchemas`; nothing checked either
 * against the SERVICE the handler delegates to, which is the gap this closes. Both directions:
 * assignability alone is one-way. Named, not inlined, so the error points at the mismatch.
 */
type ContractConfigPatch = IpcRequests['config:set']['req'];
const _contractMatchesStore: ConfigPatch = {} as ContractConfigPatch;
const _storeMatchesContract: ContractConfigPatch = {} as ConfigPatch;
void _contractMatchesStore;
void _storeMatchesContract;
