import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_SEP } from '../../../shared/shell-probe.ts';
import { cleanEnv, exec, type Exec } from '../util/exec.ts';
import { pickNodeBin, resolveShellEnv } from './shell-env.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';

/** A stub shell that answers with one already-framed payload. The nonce is read off the script. */
function fakeShell(payload: (begin: string, end: string) => string): Exec {
  return async (_file, args) => {
    const script = args[1] ?? '';
    const begin = /__HANGAR_[0-9a-f]+_BEGIN__/.exec(script)?.[0] ?? '';
    const end = /__HANGAR_[0-9a-f]+_END__/.exec(script)?.[0] ?? '';
    return { stdout: payload(begin, end), stderr: '', code: 0 };
  };
}

const f = (...fields: string[]) => fields.join(FIELD_SEP);

describe('resolveShellEnv', () => {
  it('parses PATH, node, claude and version from the shell output', async () => {
    const fake = fakeShell((b, e) => `nvm loaded\n${b}${f('/nvm/bin:/usr/bin', '/nvm/bin/node', '/nvm/bin/claude', '2.1.128 (Claude Code)')}${e}`);
    const env = await resolveShellEnv({ shell: '/bin/zsh', exec: fake, fallbackPath: '/usr/bin:/bin' });
    expect(env).toEqual({ path: '/nvm/bin:/usr/bin', nodeBin: '/nvm/bin/node', claudeBin: '/nvm/bin/claude', claudeVersion: '2.1.128 (Claude Code)', shell: '/bin/zsh', source: 'shell', reason: null });
  });

  // Every degraded branch has to say WHY. `catch { return fallback }` discarded the timedOut and
  // syscallCode that ExecError carries for exactly this, and §8.3 puts the result in Host status,
  // where a bare "fallback" tells the person trying to fix their machine nothing.
  it('reports a reason on every degraded branch', async () => {
    const boom = (extra: object): Exec => async () => { throw Object.assign(new Error('boom'), extra); };
    const cases: [Exec, string][] = [
      [boom({ timedOut: true }), 'timeout'],
      [boom({ syscallCode: 'ENOENT' }), 'ENOENT'],
      [boom({}), 'exec-failed'],
      [async () => ({ stdout: 'nothing useful', stderr: '', code: 0 }), 'no-sentinel'],
      // M1: a stray separator, or a printf that mishandles `\037`, shears the payload. Without a
      // field-count check a 2-field split silently yielded `claudeBin: null` under source 'shell'.
      [fakeShell((b, e) => `${b}${f('/usr/bin', '/usr/bin/node')}${e}`), 'bad-field-count'],
      // An empty PATH means the fallback path is used, so `source` must not still say 'shell'.
      [fakeShell((b, e) => `${b}${f('', '/usr/bin/node', '/usr/bin/claude', '2.1.128')}${e}`), 'empty-path'],
    ];
    for (const [stub, reason] of cases) {
      const env = await resolveShellEnv({ shell: '/bin/zsh', exec: stub, fallbackPath: '/usr/bin:/bin' });
      expect({ reason: env.reason, source: env.source, path: env.path }).toEqual({ reason, source: 'fallback', path: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' });
      expect(env.nodeBin).toBeNull();
    }
  });

  // `|` is legal in a PATH entry, and with `|` as the separator this exact input parsed as
  // path=/we, nodeBin=ird:…, claudeBin=/nvm/bin/node, claudeVersion=a path — silently wrong, and
  // still reported as source: 'shell'.
  it('survives a `|` inside PATH', async () => {
    const weird = '/we|ird:/opt/homebrew/bin:/usr/bin';
    const fake = fakeShell((b, e) => `${b}${f(weird, '/nvm/bin/node', '/nvm/bin/claude', '2.1.128 (Claude Code)')}${e}`);
    const env = await resolveShellEnv({ shell: '/bin/zsh', exec: fake, fallbackPath: '/usr/bin:/bin' });
    expect(env).toEqual({ path: weird, nodeBin: '/nvm/bin/node', claudeBin: '/nvm/bin/claude', claudeVersion: '2.1.128 (Claude Code)', shell: '/bin/zsh', source: 'shell', reason: null });
  });

  // `command -v` prints a BARE NAME for a shell function — the standard lazy-nvm wrapper; verified
  // in both zsh and bash. Accepted as a path it became `nodeBin: 'node'`, pickNodeBin fell through
  // to /usr/local/bin/node v22, and the host died on a `.ts` file it cannot parse.
  it('rejects a non-absolute node or claude, and says so', async () => {
    const fake = fakeShell((b, e) => `${b}${f('/nvm/bin:/usr/bin', 'node', 'claude', '2.1.128 (Claude Code)')}${e}`);
    const env = await resolveShellEnv({ shell: '/bin/zsh', exec: fake, fallbackPath: '/usr/bin:/bin' });
    expect(env.nodeBin).toBeNull();
    expect(env.claudeBin).toBeNull();
    // PATH itself is still perfectly good, so this is not a fallback — but it is not silent either.
    expect(env.path).toBe('/nvm/bin:/usr/bin');
    expect(env.source).toBe('shell');
    expect(env.reason).toBe('not-absolute:node,claude');
  });

  // `$SHELL -ilc` is a LOGIN shell: `.zlogout` runs AFTER the command, so its output follows ours.
  // Against fixed sentinels this beat `lastIndexOf` exactly as `.zshrc` beat `indexOf` — measured,
  // it returned /evil/node, 9.9.9 and source: 'shell'. The literals below are the sentinels the
  // code used to hard-code; a per-invocation nonce is what makes them inert.
  it('cannot be hijacked by an rc file that prints sentinels, before OR after', async () => {
    const zdotdir = tempDir('shellenv-forge');
    const forged = `__HANGAR_BEGIN__${f('/evil/path', '/evil/node', '/evil/claude', '9.9.9')}__HANGAR_END__`;
    writeFileSync(join(zdotdir, '.zshrc'), `print -r -- '${forged}'\n`);
    writeFileSync(join(zdotdir, '.zlogout'), `print -r -- '${forged}'\n`);
    const env = await resolveShellEnv({
      shell: '/bin/zsh',
      exec: (file, args, o) => exec(file, args, { ...o, env: cleanEnv(process.env, { ZDOTDIR: zdotdir }) }),
      fallbackPath: '/usr/bin:/bin',
    });
    expect(env.nodeBin).not.toBe('/evil/node');
    expect(env.claudeVersion).not.toBe('9.9.9');
    expect(env.path).not.toContain('/evil/path');
  }, 30_000);

  it('works against the real interactive login shell on this machine', async () => {
    const env = await resolveShellEnv({ shell: '/bin/zsh', exec, fallbackPath: '/usr/bin:/bin' });
    expect(env).toMatchObject({ source: 'shell', reason: null });
    expect(env.path).toContain('/bin');
    // `/node$/` also matches the useless bare string `node`, so it could not tell a working machine
    // from the lazy-nvm one this probe exists to survive. Assert the path is a path.
    expect(isAbsolute(env.nodeBin ?? '')).toBe(true);
    expect(env.nodeBin).toMatch(/^\/.*\/node$/);
    // A machine without the `claude` CLI — CI, or a fresh checkout — still exercises everything
    // above, which is the probe itself. Only the two assertions about what it found are skipped.
    if (env.claudeBin !== null) {
      expect(env.claudeBin).toMatch(/^\/.*\/claude$/);
      expect(env.claudeVersion).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/);
    }
  }, 30_000);
});

describe('pickNodeBin', () => {
  // The rung matters as much as the path: §8.3 both writes this to config.json and shows it in Host
  // status, where "you configured this" and "nothing else existed, so /usr/local/bin/node" are very
  // different things to tell someone.
  it('prefers the configured path, then the shell, then well-known locations, and says which', () => {
    const exists = (p: string) => p === '/cfg/node' || p === '/shell/node' || p === '/opt/homebrew/bin/node';
    expect(pickNodeBin({ configured: '/cfg/node', fromShell: '/shell/node', exists })).toEqual({ path: '/cfg/node', from: 'config' });
    expect(pickNodeBin({ configured: '/gone/node', fromShell: '/shell/node', exists })).toEqual({ path: '/shell/node', from: 'shell' });
    expect(pickNodeBin({ configured: null, fromShell: null, exists })).toEqual({ path: '/opt/homebrew/bin/node', from: 'well-known' });
    expect(pickNodeBin({ configured: null, fromShell: null, exists: () => false })).toBeNull();
  });
});
