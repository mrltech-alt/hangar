// Temp git repositories for tests. HOME is pointed at the repo, and GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM
// are set, so the developer's global and system git config cannot interfere. `GIT_CONFIG_NOSYSTEM` alone
// is not enough: git reads `$XDG_CONFIG_HOME/git/config` before `$HOME/.gitconfig`, and NOSYSTEM only
// suppresses `/etc/gitconfig` — a hostile `status.showUntrackedFiles=no` there silently zeroes dirtyCount,
// and a hostile `core.excludesFile` can stop `createRepo()` from ever committing. `GIT_CONFIG_GLOBAL=/dev/null`
// (git >= 2.32) overrides both XDG and `~/.gitconfig` outright. Verified on git 2.50.1.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './tmp.ts';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd } }).trim();
}

export function createRepo(opts: { branch?: string; files?: Record<string, string> } = {}): string {
  const dir = tempDir('git');
  git(dir, 'init', '-q', '-b', opts.branch ?? 'main');
  git(dir, 'config', 'user.email', 'test@hangar.local');
  git(dir, 'config', 'user.name', 'Hangar Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const files = opts.files ?? { 'README.md': '# test\n' };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commitFile(dir: string, name: string, content: string, message = `update ${name}`): string {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Adds a bare "origin" remote, pushes the current branch, and sets origin/HEAD. Returns the bare path. */
export function addOrigin(dir: string, branch = 'main'): string {
  const bare = tempDir('origin');
  git(bare, 'init', '-q', '--bare', '-b', branch);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  git(dir, 'remote', 'set-head', 'origin', '-a');
  return bare;
}

/** Environment for the GitService under test: isolated from the developer's global config. */
export function testGitEnv(repoDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Strip ambient GIT_* vars too, not just ELECTRON_*: a leaked GIT_DIR (or GIT_WORK_TREE, GIT_INDEX_FILE, …)
  // from the outer shell made `head()` read a completely different repository in review testing.
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('ELECTRON_') && !k.startsWith('GIT_')) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.HOME = repoDir;
  return env;
}
