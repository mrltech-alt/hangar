import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpcSchemas } from '../../../shared/ipc-schemas.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { AppConfigFieldSchemas, createConfigStore } from './config-store.ts';

describe('createConfigStore', () => {
  it('starts with defaults, persists patches, survives a corrupt file', () => {
    const dir = tempDir('cfg');
    const file = join(dir, 'config.json');
    const cfg = createConfigStore(file, '/bin/zsh');
    expect(cfg.get()).toMatchObject({ version: 1, shellPath: '/bin/zsh', nodeBin: null, notifications: 'attention' });
    cfg.set({ nodeBin: '/n/node', terminal: { fontSize: 14, fontFamily: 'Menlo', scrollback: 5000 } });
    expect(JSON.parse(readFileSync(file, 'utf8')).nodeBin).toBe('/n/node');
    expect(createConfigStore(file, '/bin/zsh').get().terminal.fontSize).toBe(14);
    writeFileSync(file, '{ broken');
    expect(createConfigStore(file, '/bin/bash').get().shellPath).toBe('/bin/bash');
  });

  it('merges a partial terminal patch instead of replacing the object', () => {
    const dir = tempDir('cfg-partial');
    const file = join(dir, 'config.json');
    const cfg = createConfigStore(file, '/bin/zsh');
    const before = cfg.get().terminal;
    // What a settings UI sends when the user drags only the font-size slider.
    const after = cfg.set({ terminal: { fontSize: 20 } }).terminal;
    expect(after).toEqual({ fontSize: 20, fontFamily: before.fontFamily, scrollback: before.scrollback });
    expect(JSON.parse(readFileSync(file, 'utf8')).terminal).toEqual(after);
    // …and a patch that touches nothing nested leaves terminal alone.
    expect(cfg.set({ notifications: 'off' }).terminal).toEqual(after);
  });

  it('validates every field on load and falls back per field, keeping the valid siblings', () => {
    const dir = tempDir('cfg-types');
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        nodeBin: 42,
        shellPath: { a: 1 },
        notifications: 'BOGUS',
        terminal: { 0: 'h', 1: 'i', fontSize: -5, fontFamily: 'Courier', scrollback: 1000000000 },
      }),
    );
    const lines: string[] = [];
    const cfg = createConfigStore(file, '/bin/zsh', { log: (l) => lines.push(l) }).get();
    expect(cfg).toEqual({
      version: 1,
      nodeBin: null,
      shellPath: '/bin/zsh',
      notifications: 'attention',
      // the one valid field in the object survives its bad siblings
      terminal: { fontSize: 13, fontFamily: 'Courier', scrollback: 10_000 },
      claudeDefaultArgs: [],
      reposDir: null,
      triageModel: 'sonnet',
      defaultPermissionMode: null,
    });
    expect(lines.filter((l) => l.includes('is invalid')).length).toBe(5);
    expect(lines.some((l) => l.includes('terminal.scrollback'))).toBe(true);
  });

  it('rejects a non-object file and a non-object terminal wholesale', () => {
    const dir = tempDir('cfg-shape');
    const arrayFile = join(dir, 'array.json');
    writeFileSync(arrayFile, '[1,2,3]');
    const arrayLines: string[] = [];
    // Previously the array spread into the defaults, leaving "0"/"1"/"2" keys on the config object.
    expect(createConfigStore(arrayFile, '/bin/zsh', { log: (l) => arrayLines.push(l) }).get()).toEqual({
      version: 1, nodeBin: null, shellPath: '/bin/zsh', notifications: 'attention',
      terminal: { fontSize: 13, fontFamily: "Menlo, 'SF Mono', monospace", scrollback: 10_000 },
      claudeDefaultArgs: [], reposDir: null, triageModel: 'sonnet', defaultPermissionMode: null,
    });
    expect(arrayLines.some((l) => l.includes('not a JSON object'))).toBe(true);

    const termFile = join(dir, 'term.json');
    writeFileSync(termFile, JSON.stringify({ notifications: 'off', terminal: 'nope' }));
    const termLines: string[] = [];
    const cfg = createConfigStore(termFile, '/bin/zsh', { log: (l) => termLines.push(l) }).get();
    expect(cfg.notifications).toBe('off');
    expect(cfg.terminal.fontSize).toBe(13);
    expect(termLines.some((l) => l.includes('terminal is not an object'))).toBe(true);
  });

  it('preserves a corrupt file rather than overwriting it, and says so', () => {
    const dir = tempDir('cfg-corrupt');
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ broken');
    const lines: string[] = [];
    const cfg = createConfigStore(file, '/bin/zsh', { log: (l) => lines.push(l), now: () => new Date('2026-09-08T10:00:00.000Z') });
    expect(existsSync(file)).toBe(false); // moved aside on load, before anything can overwrite it
    cfg.set({ notifications: 'off' });
    const preserved = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(preserved.length).toBe(1);
    expect(readFileSync(join(dir, preserved[0]!), 'utf8')).toBe('{ broken');
    expect(lines.some((l) => l.includes('corrupt') && l.includes('preserved as'))).toBe(true);
    // the fresh file is a real config, not the corrupt bytes
    expect(JSON.parse(readFileSync(file, 'utf8')).notifications).toBe('off');
  });

  it('reports a failed write instead of throwing, and keeps memory and disk reconcilable', () => {
    const dir = tempDir('cfg-write');
    const file = join(dir, 'no-such-dir', 'config.json'); // the parent does not exist: ENOENT on write
    const lines: string[] = [];
    const cfg = createConfigStore(file, '/bin/zsh', { log: (l) => lines.push(l) });
    expect(() => cfg.set({ notifications: 'all' })).not.toThrow();
    expect(cfg.get().notifications).toBe('all');
    expect(cfg.lastWriteError()).toBeInstanceOf(Error);
    expect(cfg.flush()).toBe(false); // still dirty, still failing — not silently "saved"
    expect(lines.some((l) => l.includes('config write to') && l.includes('failed'))).toBe(true);
    // A write failure is live state, not a load-time report: it belongs to `lastWriteError()`, and
    // must not leak into the `problems()` the caller toasts as "your settings were reset".
    expect(cfg.problems()).toEqual([]);
  });

  // Why this exists: `workspace.json` returns a `LoadResult` whose `problems` become a sticky toast,
  // and this store — same profile, same recovery, same `.corrupt-<ts>` rename — reported nothing at
  // all, so a hand-edited config silently reverted to defaults.
  it('reports what was wrong with the file so the caller can tell the user', () => {
    const dir = tempDir('cfg-problems');
    const file = join(dir, 'config.json');
    expect(createConfigStore(file, '/bin/zsh').problems()).toEqual([]); // absent file is not a problem

    writeFileSync(file, JSON.stringify({ version: 1, notifications: 'BOGUS', terminal: { fontSize: 4 } }));
    const bad = createConfigStore(file, '/bin/zsh');
    expect(bad.problems()).toHaveLength(2);
    expect(bad.problems().join('\n')).toContain('notifications is invalid');
    expect(bad.problems().join('\n')).toContain('terminal.fontSize is invalid');
    // A copy, so a caller cannot mutate the store's record of them.
    bad.problems().push('nonsense');
    expect(bad.problems()).toHaveLength(2);

    writeFileSync(file, '{ broken');
    const corrupt = createConfigStore(file, '/bin/zsh');
    expect(corrupt.problems().join('\n')).toMatch(/corrupt .* preserved as .*\.corrupt-/);
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  // Plan 06. Same per-field "repair, never reject" rule as every other field: a hand-edited typo in
  // one of these must not cost the user the rest of config.json.
  it('persists the Plan 06 fields and falls back per field when one is bad', () => {
    const dir = tempDir('cfg-linear');
    const file = join(dir, 'config.json');
    const cfg = createConfigStore(file, '/bin/zsh');
    expect(cfg.get()).toMatchObject({ claudeDefaultArgs: [], reposDir: null, triageModel: 'sonnet', defaultPermissionMode: null });
    cfg.set({ claudeDefaultArgs: ['--model', 'claude-opus-5[1m]', '--effort', 'xhigh'], reposDir: '/Users/me/code', triageModel: 'haiku', defaultPermissionMode: 'bypassPermissions' });
    expect(createConfigStore(file, '/bin/zsh').get()).toMatchObject({
      claudeDefaultArgs: ['--model', 'claude-opus-5[1m]', '--effort', 'xhigh'],
      reposDir: '/Users/me/code',
      triageModel: 'haiku',
      defaultPermissionMode: 'bypassPermissions',
    });

    // A string where a list belongs, a relative folder, a "model" that is really a flag, and a mode
    // Claude Code does not have.
    writeFileSync(file, JSON.stringify({ version: 1, notifications: 'off', claudeDefaultArgs: '--model opus', reposDir: 'code', triageModel: '-p', defaultPermissionMode: 'yolo' }));
    const lines: string[] = [];
    const bad = createConfigStore(file, '/bin/zsh', { log: (l) => lines.push(l) }).get();
    expect(bad).toMatchObject({ notifications: 'off', claudeDefaultArgs: [], reposDir: null, triageModel: 'sonnet', defaultPermissionMode: null });
    expect(lines.filter((l) => l.includes('is invalid'))).toHaveLength(4);
    expect(lines.join('\n')).toContain('reposDir is invalid');
    expect(lines.join('\n')).toContain('defaultPermissionMode is invalid');
  });
});

/**
 * `AppConfigFieldSchemas` deliberately restates `IpcSchemas['config:set']` rather than importing it
 * (that schema is erased to `z.ZodType` at its export, so its per-field shape is not reachable). This
 * is the guard that makes the restatement safe: if either side's bounds move, these disagree.
 */
describe('AppConfigFieldSchemas', () => {
  const accepted = (patch: Record<string, unknown>): boolean => {
    const S = AppConfigFieldSchemas;
    if (patch.nodeBin !== undefined && !S.nodeBin.safeParse(patch.nodeBin).success) return false;
    if (patch.shellPath !== undefined && !S.shellPath.safeParse(patch.shellPath).success) return false;
    if (patch.notifications !== undefined && !S.notifications.safeParse(patch.notifications).success) return false;
    if (patch.claudeDefaultArgs !== undefined && !S.claudeDefaultArgs.safeParse(patch.claudeDefaultArgs).success) return false;
    if (patch.reposDir !== undefined && !S.reposDir.safeParse(patch.reposDir).success) return false;
    if (patch.triageModel !== undefined && !S.triageModel.safeParse(patch.triageModel).success) return false;
    if (patch.defaultPermissionMode !== undefined && !S.defaultPermissionMode.safeParse(patch.defaultPermissionMode).success) return false;
    if (patch.terminal !== undefined) {
      const t = patch.terminal as Record<string, unknown>;
      if (typeof t !== 'object' || t === null || Array.isArray(t)) return false;
      // Per present field: `config:set`'s `terminal` is `.partial()`, because a settings UI sends
      // only the control the user touched and `set()` merges it. Checking all three unconditionally
      // would have this helper disagree with the schema on exactly that patch.
      if (t.fontSize !== undefined && !S.terminal.fontSize.safeParse(t.fontSize).success) return false;
      if (t.fontFamily !== undefined && !S.terminal.fontFamily.safeParse(t.fontFamily).success) return false;
      if (t.scrollback !== undefined && !S.terminal.scrollback.safeParse(t.scrollback).success) return false;
    }
    return true;
  };

  const term = (over: Record<string, unknown>): Record<string, unknown> => ({ fontSize: 13, fontFamily: 'Menlo', scrollback: 5000, ...over });

  it('agrees with IpcSchemas[config:set] on every bound', () => {
    const samples: Record<string, unknown>[] = [
      {},
      { nodeBin: null }, { nodeBin: '/n/node' }, { nodeBin: 42 }, { nodeBin: {} },
      { shellPath: '/bin/zsh' }, { shellPath: '' }, { shellPath: { a: 1 } },
      { notifications: 'off' }, { notifications: 'attention' }, { notifications: 'BOGUS' }, { notifications: 3 },
      { terminal: term({}) },
      { terminal: term({ fontSize: 7 }) }, { terminal: term({ fontSize: 8 }) }, { terminal: term({ fontSize: 32 }) }, { terminal: term({ fontSize: 33 }) }, { terminal: term({ fontSize: -5 }) },
      { terminal: term({ scrollback: 99 }) }, { terminal: term({ scrollback: 100 }) }, { terminal: term({ scrollback: 100_000 }) }, { terminal: term({ scrollback: 100_001 }) },
      { terminal: term({ scrollback: 5000.5 }) }, { terminal: term({ scrollback: 1000000000 }) },
      { terminal: term({ fontFamily: '' }) },
      { terminal: { fontSize: 13, scrollback: 5000 } }, // partial: what a settings UI sends
      { terminal: {} }, { terminal: { fontSize: 20 } }, { terminal: { fontSize: 33 } }, { terminal: { fontFamily: '' } },
      { terminal: 'nope' },
      { nodeBin: '/n/node', shellPath: '/bin/zsh', notifications: 'all', terminal: term({}) },
      { claudeDefaultArgs: [] }, { claudeDefaultArgs: ['--model', 'claude-opus-5[1m]', '--effort', 'xhigh'] }, { claudeDefaultArgs: '--model opus' }, { claudeDefaultArgs: [1] },
      { reposDir: null }, { reposDir: '/Users/me/code' }, { reposDir: '' }, { reposDir: 'relative/dir' }, { reposDir: 5 },
      { triageModel: 'sonnet' }, { triageModel: 'claude-opus-5[1m]' }, { triageModel: '' }, { triageModel: '--dangerously-skip-permissions' }, { triageModel: 3 },
      // Each of these is accepted by a check loosened on ONE side, so the table fails on that drift.
      { triageModel: '-p' }, { triageModel: ' ' }, { triageModel: ' sonnet' }, { triageModel: 'sonnet\n' },
      { reposDir: '~/code' },
      { claudeDefaultArgs: [''] }, { claudeDefaultArgs: ['--effort', ''] },
      { defaultPermissionMode: null }, { defaultPermissionMode: 'bypassPermissions' }, { defaultPermissionMode: 'plan' }, { defaultPermissionMode: 'yolo' }, { defaultPermissionMode: '' }, { defaultPermissionMode: true },
    ];
    for (const patch of samples) {
      expect({ patch, ok: accepted(patch) }).toEqual({ patch, ok: IpcSchemas['config:set'].safeParse(patch).success });
    }
  });

  // The agreement table above only proves the two sides MATCH; this pins what they both decide. A
  // padded model name is a hand-edit typo that `claude --model` would not resolve, and an empty
  // element in claudeDefaultArgs becomes a literal '' argument on every agent launch.
  it('rejects a whitespace-padded triageModel and an empty claudeDefaultArgs element, on both sides', () => {
    const S = AppConfigFieldSchemas;
    const ipc = IpcSchemas['config:set'];
    for (const m of [' ', ' sonnet', 'sonnet ', 'sonnet\n', '\tsonnet']) {
      expect({ m, ok: S.triageModel.safeParse(m).success }).toEqual({ m, ok: false });
      expect({ m, ok: ipc.safeParse({ triageModel: m }).success }).toEqual({ m, ok: false });
    }
    expect(S.triageModel.safeParse('claude-opus-5[1m]').success).toBe(true);
    for (const args of [[''], ['--effort', '']]) {
      expect({ args, ok: S.claudeDefaultArgs.safeParse(args).success }).toEqual({ args, ok: false });
      expect({ args, ok: ipc.safeParse({ claudeDefaultArgs: args }).success }).toEqual({ args, ok: false });
    }
    expect(S.claudeDefaultArgs.safeParse(['--effort', 'xhigh']).success).toBe(true);

    // And on load, each falls back to its default rather than reaching a launch.
    const file = join(tempDir('cfg-tight'), 'config.json');
    writeFileSync(file, JSON.stringify({ version: 1, triageModel: 'haiku ', claudeDefaultArgs: ['--effort', ''] }));
    const lines: string[] = [];
    expect(createConfigStore(file, '/bin/zsh', { log: (l) => lines.push(l) }).get()).toMatchObject({ triageModel: 'sonnet', claudeDefaultArgs: [] });
    expect(lines.join('\n')).toContain('triageModel is invalid');
    expect(lines.join('\n')).toContain('claudeDefaultArgs is invalid');
  });
});
