import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { cleanEnv, exec, ExecError } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';
import { cloneDirs, copyPatterns, runPostCreate } from './worktree-setup.ts';

function repoWith(files: Record<string, string>): string {
  const dir = tempDir('setup');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/**
 * A small HFS+ RAM disk: a real filesystem boundary for testing cross-device behaviour (G28) without
 * mocks. **Opt-in via `HANGAR_TEST_RAMDISK=1`**, and skipped by default.
 *
 * The cleanup runs in a `finally`, which does not survive a Ctrl-C or a killed vitest worker — and a
 * detached RAM disk then survives until reboot, holding its memory. That already happened once on
 * this machine (a 64 MB orphan left by a review probe), and this test would otherwise run on every
 * `npm test`. The behaviour it guards is a single `statSync(...).dev` comparison, which the sibling
 * test pins deterministically by injecting a fake `stat`; this one exists to prove the real
 * filesystem behaves as G28 now claims, so running it deliberately is enough.
 */
function createRamDisk(): { path: string; cleanup: () => void } | null {
  if (process.env.HANGAR_TEST_RAMDISK !== '1') return null;
  try {
    const dev = execFileSync('hdiutil', ['attach', '-nomount', 'ram://4096'], { encoding: 'utf8' }).trim().split(/\s+/)[0] as string;
    const vol = `hangartest${process.pid}`;
    execFileSync('diskutil', ['eraseVolume', 'HFS+', vol, dev], { encoding: 'utf8' });
    return {
      path: `/Volumes/${vol}`,
      cleanup: () => {
        try {
          execFileSync('hdiutil', ['detach', dev, '-force']);
        } catch {
          // best-effort; a leftover ram disk is harmless and gone on reboot
        }
      },
    };
  } catch {
    return null; // no hdiutil/diskutil (non-macOS) or no permission to create one — caller skips
  }
}

describe('copyPatterns', () => {
  it('copies matching files (dotfiles, nested), skips .git/node_modules and missing patterns', () => {
    const repo = repoWith({ '.env': 'A', '.env.local': 'B', '.claude/settings.local.json': '{}', 'node_modules/.env': 'NO', '.git/.env': 'NO', 'src/x.ts': '' });
    const wt = tempDir('setup-wt');
    const log: string[] = [];
    const copied = copyPatterns(repo, wt, ['.env', '.env.*', '.claude/settings.local.json', 'missing.file'], (l) => log.push(l));
    expect(copied.sort()).toEqual(['.claude/settings.local.json', '.env', '.env.local']);
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('B');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(log.length).toBe(3);
  });

  it('excludes .git and node_modules even for a recursive pattern (I5)', () => {
    // The test above never actually exercises the exclude filter: none of its patterns are
    // recursive, so `node_modules/.env` could never match `.env` or `.env.*` regardless of
    // whether EXCLUDED_SEGMENTS exists at all. `**/.env` traverses, and is what actually proves
    // exclude does something — deleting it from copyPatterns still passes the test above unchanged.
    const repo = repoWith({ '.env': 'A', 'node_modules/.env': 'NO', '.git/.env': 'NO', 'nested/.env': 'C' });
    const wt = tempDir('setup-wt');
    const copied = copyPatterns(repo, wt, ['**/.env'], () => {});
    expect(copied.sort()).toEqual(['.env', 'nested/.env']);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });

  it('never reads or writes outside the repo/worktree for a pattern that resolves elsewhere (C1)', () => {
    const repo = repoWith({ 'src/x.ts': '' });
    const wt = tempDir('setup-wt');
    const secret = tempDir('setup-secret');
    writeFileSync(join(secret, 'id_rsa'), 'DECOY-PRIVATE-KEY');
    const escapePattern = `../${basename(secret)}/id_rsa`;
    const log: string[] = [];
    const copied = copyPatterns(repo, wt, [escapePattern, '../../../../../../etc/hosts'], (l) => log.push(l));
    expect(copied).toEqual([]);
    expect(log.filter((l) => l.includes('escapes')).length).toBe(2);
    expect(readFileSync(join(secret, 'id_rsa'), 'utf8')).toBe('DECOY-PRIVATE-KEY'); // untouched
  });

  it('skips an unreadable file and continues copying the rest of the batch (I4)', () => {
    const repo = repoWith({ 'noread.txt': 'secret', '.env': 'A' });
    chmodSync(join(repo, 'noread.txt'), 0o000);
    const wt = tempDir('setup-wt');
    const log: string[] = [];
    let copied: string[] = [];
    try {
      copied = copyPatterns(repo, wt, ['noread.txt', '.env'], (l) => log.push(l));
    } finally {
      chmodSync(join(repo, 'noread.txt'), 0o644); // restore so tempDir cleanup can remove it
    }
    expect(copied).toEqual(['.env']);
    expect(log.some((l) => l.startsWith('skip noread.txt'))).toBe(true);
  });

  it('throws rather than fabricating a phantom worktree directory for a wrong path (M3)', () => {
    const repo = repoWith({ '.env': 'A' });
    expect(() => copyPatterns(repo, '/tmp/hangar-nonexistent-worktree-for-test', ['.env'], () => {})).toThrow();
  });

  it('follows an in-repo symlink to copy its target content; the write side still stays inside the worktree (M1, documented)', () => {
    const repo = repoWith({});
    const outside = tempDir('setup-outside');
    writeFileSync(join(outside, 'real.txt'), 'OUTSIDE-CONTENT');
    symlinkSync(join(outside, 'real.txt'), join(repo, '.env'));
    const wt = tempDir('setup-wt');
    const copied = copyPatterns(repo, wt, ['.env'], () => {});
    expect(copied).toEqual(['.env']);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('OUTSIDE-CONTENT');
  });
});

describe('cloneDirs', () => {
  it('clones existing dirs with cp -c, skips missing and already-present ones', async () => {
    const repo = repoWith({ 'node_modules/pkg/index.js': 'x', 'billingr/keep.txt': 'y' });
    const wt = tempDir('setup-wt');
    mkdirSync(join(wt, 'billingr'));
    const log: string[] = [];
    const r = await cloneDirs(repo, wt, ['node_modules', 'billingr', 'absent'], exec, (l) => log.push(l));
    expect(r).toEqual({ cloned: ['node_modules'], skipped: ['billingr', 'absent'] });
    expect(readFileSync(join(wt, 'node_modules/pkg/index.js'), 'utf8')).toBe('x');
    expect(log.find((l) => l.includes('already exists'))).toBeTruthy();
    // Distinguishes the "never existed" branch from the catch-all "cp failed" branch (I5): dropping
    // the early existsSync(src) check would still land `absent` in `skipped`, just via a different
    // log message (the `warn: could not clone` one from the try/catch below it).
    expect(log.find((l) => l.includes('skip absent: not present in'))).toBeTruthy();
  });

  it('always passes -c (clone) to cp, never silently falling back to a full copy (I5)', async () => {
    const repo = repoWith({ 'node_modules/pkg/index.js': 'x' });
    const wt = tempDir('setup-wt');
    let capturedArgs: string[] = [];
    const fakeExec: Exec = async (_file, args) => {
      capturedArgs = args;
      return { stdout: '', stderr: '', code: 0 };
    };
    await cloneDirs(repo, wt, ['node_modules'], fakeExec, () => {});
    expect(capturedArgs).toContain('-c');
  });

  it('removes a partial clone left behind by a failed cp, instead of leaving it for a retry to skip over (I3)', async () => {
    const repo = repoWith({ 'partial/ok/a.txt': 'x' });
    const wt = tempDir('setup-wt');
    const fakeExec: Exec = async (_file, args) => {
      // Simulate `cp -c -R` having partially written the tree before failing.
      const dst = args[args.length - 1] as string;
      mkdirSync(join(dst, 'ok'), { recursive: true });
      writeFileSync(join(dst, 'ok', 'a.txt'), 'x');
      throw new ExecError('/bin/cp', args, 1, 'cp: fake failure', 'fake failure');
    };
    const log: string[] = [];
    const r = await cloneDirs(repo, wt, ['partial'], fakeExec, (l) => log.push(l));
    expect(r).toEqual({ cloned: [], skipped: ['partial'] });
    expect(existsSync(join(wt, 'partial'))).toBe(false);
    // A retry with the real `cp` must actually clone — not skip because "already exists".
    const r2 = await cloneDirs(repo, wt, ['partial'], exec, (l) => log.push(l));
    expect(r2).toEqual({ cloned: ['partial'], skipped: [] });
  });

  // The deterministic half of G28, run on every suite: `cp -c` silently degrades to a full byte copy
  // and exits 0 across filesystems, so the exit code cannot be trusted and the device check is the
  // only thing standing between a 2 GB preflight and a filled disk. The RAM-disk test below proves
  // the real filesystem behaves this way; this one proves we act on it.
  it('refuses to clone when the devices differ, without trusting cp', async () => {
    const repo = repoWith({ 'node_modules/pkg/index.js': 'x' });
    const wt = tempDir('setup-wt');
    const log: string[] = [];
    let ranCp = false;
    const spyExec: typeof exec = async (file, args, opts) => { ranCp = true; return exec(file, args, opts); };
    const deviceOf = (p: string) => (p === wt ? 42 : 7);
    const r = await cloneDirs(repo, wt, ['node_modules'], spyExec, (l) => log.push(l), deviceOf);
    expect(r).toEqual({ cloned: [], skipped: ['node_modules'] });
    expect(ranCp).toBe(false); // refused BEFORE spawning cp, not after inspecting its exit code
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(log.some((l) => l.includes('different filesystems'))).toBe(true);
  });

  it('refuses to clone across filesystems rather than silently full-copying (I2/G28)', async () => {
    const ram = createRamDisk();
    if (ram === null) return; // not opted in (HANGAR_TEST_RAMDISK=1), or no hdiutil/diskutil here
    try {
      const repo = repoWith({ 'node_modules/pkg/index.js': 'x' });
      const log: string[] = [];
      const r = await cloneDirs(repo, ram.path, ['node_modules'], exec, (l) => log.push(l));
      expect(r).toEqual({ cloned: [], skipped: ['node_modules'] });
      expect(existsSync(join(ram.path, 'node_modules'))).toBe(false);
      expect(log.some((l) => l.includes('different filesystems'))).toBe(true);
    } finally {
      ram.cleanup();
    }
  });
});

describe('runPostCreate', () => {
  const env = cleanEnv(process.env);

  it('streams output lines and reports success', async () => {
    const log: string[] = [];
    const r = await runPostCreate({ shell: '/bin/sh', command: 'echo one; echo two >&2; exit 0', cwd: '/tmp', env, log: (l) => log.push(l) });
    expect(r).toEqual({ ok: true, code: 0, timedOut: false });
    expect(log).toContain('one');
    expect(log).toContain('stderr: two');
  });

  it('reports failure codes, and enforces the timeout within its own budget rather than the command\'s (C2)', async () => {
    const r = await runPostCreate({ shell: '/bin/sh', command: 'exit 3', cwd: '/tmp', env, log: () => {} });
    expect(r).toEqual({ ok: false, code: 3, timedOut: false });

    const start = Date.now();
    const t = await runPostCreate({ shell: '/bin/sh', command: 'sleep 5', cwd: '/tmp', env, log: () => {}, timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(t).toEqual({ ok: false, code: null, timedOut: true });
    // Must resolve near timeoutMs (200ms), not wait out the full 5s sleep — this is exactly how
    // the original process-group kill hid its own failure (it "resolved" only once the 5s finished).
    expect(elapsed).toBeLessThan(2000);
  });

  it('reports a spawn failure distinctly from a timeout (M4)', async () => {
    const r = await runPostCreate({ shell: '/nonexistent/hangar-test-shell', command: 'echo hi', cwd: '/tmp', env, log: () => {} });
    expect(r).toEqual({ ok: false, code: null, timedOut: false });
  });

  it('runs the command in an interactive shell, not just a login one (G4/G5)', async () => {
    const log: string[] = [];
    const r = await runPostCreate({
      shell: '/bin/sh',
      command: 'case $- in *i*) echo interactive;; *) echo not-interactive;; esac',
      cwd: '/tmp',
      env,
      log: (l) => log.push(l),
    });
    expect(r.ok).toBe(true);
    expect(log).toContain('interactive');
  });

  it('kills every process in the tree, not just the shell — a backgrounded job cannot survive the timeout kill (C2/G38)', async () => {
    const dir = tempDir('postcreate-marker');
    const marker = join(dir, 'marker');
    const r = await runPostCreate({
      shell: '/bin/sh',
      command: `(sleep 1; touch ${marker}) & sleep 30`,
      cwd: '/tmp',
      env,
      log: () => {},
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    // Long enough for the backgrounded job's own sleep to finish if it survived the kill.
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(marker)).toBe(false);
  });

  it('caps its internal line buffer instead of growing it without bound on newline-free output (I1)', async () => {
    const log: string[] = [];
    const size = 200_000;
    const r = await runPostCreate({ shell: '/bin/sh', command: `head -c ${size} /dev/zero | tr '\\0' 'x'`, cwd: '/tmp', env, log: (l) => log.push(l) });
    expect(r.ok).toBe(true);
    // Excludes stderr lines: an interactive shell run without a controlling TTY prints its own
    // "no job control in this shell" notice there, unrelated to what this test measures.
    const stdoutChars = log.filter((l) => !l.startsWith('stderr: ')).join('').length;
    expect(stdoutChars).toBe(size); // nothing lost
    expect(log.length).toBeGreaterThan(1); // forced mid-stream emission(s), not one unbounded buffer
  });

  it('flushes a trailing line with no newline instead of silently discarding it (I1)', async () => {
    const log: string[] = [];
    const r = await runPostCreate({ shell: '/bin/sh', command: "printf 'FINAL-LINE-NO-NEWLINE'", cwd: '/tmp', env, log: (l) => log.push(l) });
    expect(r.ok).toBe(true);
    expect(log).toContain('FINAL-LINE-NO-NEWLINE');
  });
});
