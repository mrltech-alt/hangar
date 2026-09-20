import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectSetup, type Project } from '../../../shared/types.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { HINT_MAX, HINT_READ_BYTES, REPO_CANDIDATES_MAX, discoverRepos, mergeCandidates, repoHint } from './repo-discovery.ts';

/**
 * Whether `/tmp` is on a case-insensitive volume (APFS's default), where `/TMP/X` and `/tmp/x` are one
 * file. The case tests below only mean something there: on a case-sensitive volume the upper-cased
 * spelling names nothing, so they are skipped rather than failed.
 */
const CASE_INSENSITIVE_TMP = ((): boolean => {
  const probe = mkdtempSync('/tmp/hangar-case-probe-');
  try {
    return statSync(probe.toUpperCase()).ino === statSync(probe).ino;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** A fake checkout: a `.git` directory, or a linked worktree's `.git` FILE. No real git needed. */
function repo(parent: string, name: string, opts: { gitFile?: boolean; files?: Record<string, string> } = {}): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (opts.gitFile) writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
  else mkdirSync(join(dir, '.git'));
  for (const [file, content] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, file), content);
  return dir;
}

const NO_HOME = '/nonexistent/hangar-home';

describe('discoverRepos', () => {
  it('lists direct children holding a .git directory or file, sorted by name, and nothing else', () => {
    const dir = tempDir('disc');
    repo(dir, 'acme-frontend');
    repo(dir, 'AcmeApi', { gitFile: true });
    mkdirSync(join(dir, 'notes'));                 // a directory, but not a repo
    writeFileSync(join(dir, 'README.md'), 'x');    // not a directory
    repo(join(dir, 'nested'), 'deep');             // a grandchild — no recursion
    repo(dir, '.dotfiles');                        // hidden
    const found = discoverRepos(dir, { excludeUnder: NO_HOME });
    expect(found.error).toBeNull();
    expect(found.repos).toEqual([
      { path: join(dir, 'AcmeApi'), name: 'AcmeApi', hint: '', projectId: null },
      { path: join(dir, 'acme-frontend'), name: 'acme-frontend', hint: '', projectId: null },
    ]);
  });

  // Hangar's own worktrees are git checkouts too. Offering one as a candidate would give an agent a
  // worktree of another agent's worktree.
  it('skips anything under HANGAR_HOME, including through a symlink', () => {
    const dir = tempDir('disc-home');
    const home = join(dir, 'hangar-profile');
    mkdirSync(join(home, '.git'), { recursive: true });
    const worktree = repo(join(home, 'worktrees', 'AcmeApi'), 'fix-it', { gitFile: true });
    symlinkSync(worktree, join(dir, 'linked-worktree'));
    repo(dir, 'real');
    expect(discoverRepos(dir, { excludeUnder: home }).repos.map((r) => r.name)).toEqual(['real']);
  });

  it('does not count a sibling whose name merely starts with HANGAR_HOME’s as under it', () => {
    const dir = tempDir('disc-sibling');
    const home = repo(dir, 'hangar-profile');
    repo(dir, 'hangar-profile-2');
    repo(dir, 'real');
    expect(discoverRepos(dir, { excludeUnder: home }).repos.map((r) => r.name)).toEqual(['hangar-profile-2', 'real']);
  });

  // Node's JS `realpathSync` keeps the case the path was typed in; only `.native` returns the case on
  // disk. Without it, a HANGAR_HOME spelled differently from how the repo is reached is not excluded.
  it.skipIf(!CASE_INSENSITIVE_TMP)('skips HANGAR_HOME spelled in a different case (needs a case-insensitive /tmp)', () => {
    const dir = tempDir('disc-case');
    const home = join(dir, 'hangar-profile');
    mkdirSync(join(home, '.git'), { recursive: true });
    const worktree = repo(join(home, 'worktrees', 'AcmeApi'), 'fix-it', { gitFile: true });
    symlinkSync(worktree, join(dir, 'linked-worktree'));
    repo(dir, 'real');
    expect(discoverRepos(dir, { excludeUnder: home.toUpperCase() }).repos.map((r) => r.name)).toEqual(['real']);
  });

  it(`caps at REPO_CANDIDATES_MAX (${REPO_CANDIDATES_MAX}), keeping the first by name`, () => {
    const dir = tempDir('disc-cap');
    for (let i = 0; i < REPO_CANDIDATES_MAX + 5; i += 1) repo(dir, `repo-${String(i).padStart(3, '0')}`);
    const found = discoverRepos(dir, { excludeUnder: NO_HOME });
    expect(found.repos).toHaveLength(REPO_CANDIDATES_MAX);
    expect(found.repos.at(-1)?.name).toBe('repo-199');
  });

  it('reports a folder it cannot read instead of throwing', () => {
    const dir = tempDir('disc-missing');
    const missing = discoverRepos(join(dir, 'nope'), { excludeUnder: NO_HOME });
    expect(missing.repos).toEqual([]);
    expect(missing.error).toContain('ENOENT');
    writeFileSync(join(dir, 'file'), 'x');
    expect(discoverRepos(join(dir, 'file'), { excludeUnder: NO_HOME }).error).toContain('ENOTDIR');
  });
});

describe('repoHint', () => {
  it('prefers package.json’s description, then the first prose line of README.md', () => {
    const dir = tempDir('hint');
    expect(repoHint(repo(dir, 'both', { files: { 'package.json': JSON.stringify({ description: '  The API  ' }), 'README.md': 'Readme line\n' } }))).toBe('The API');
    expect(repoHint(repo(dir, 'readme', { files: { 'package.json': JSON.stringify({ name: 'x' }), 'README.md': '# Title\n\n## Sub\n\n  First real line.  \nSecond\n' } }))).toBe('First real line.');
    expect(repoHint(repo(dir, 'broken', { files: { 'package.json': '{ not json', 'README.md': 'Readme wins' } }))).toBe('Readme wins');
    expect(repoHint(repo(dir, 'none'))).toBe('');
  });

  it(`truncates to HINT_MAX (${HINT_MAX}) characters and flattens control characters`, () => {
    const dir = tempDir('hint-long');
    expect(repoHint(repo(dir, 'long', { files: { 'README.md': `${'y'.repeat(HINT_MAX + 50)}\n` } }))).toBe('y'.repeat(HINT_MAX));
    expect(repoHint(repo(dir, 'ctl', { files: { 'package.json': JSON.stringify({ description: 'a\u0007b\nc' }) } }))).toBe('a b c');
  });

  // A hint comes from someone else's repository and is shown to the triage model (and possibly the
  // user), so it loses what a terminal or text renderer acts on, not just the C0 class.
  it('strips C1 controls and invisible format characters from untrusted README and package.json text', () => {
    const dir = tempDir('hint-untrusted');
    expect(repoHint(repo(dir, 'pkg', { files: { 'package.json': JSON.stringify({ description: 'Pay\u202ements\u009b2J\u200b API' }) } }))).toBe('Payments 2J API');
    expect(repoHint(repo(dir, 'readme', { files: { 'README.md': 'Hidden\u{E0041}\u{E0042} text\u2066\u0085here\n' } }))).toBe('Hidden text here');
  });

  // The hint goes into the claude prompt. A README that is a symlink to `~/.netrc` must not put the
  // user's credentials there.
  it('reads a hint only from a regular file inside the repository, never through a symlink out of it', () => {
    const dir = tempDir('hint-confined');
    writeFileSync(join(dir, 'netrc'), 'machine github.com login me password ghp_SECRET\n');
    writeFileSync(join(dir, 'evil.json'), JSON.stringify({ description: 'ghp_SECRET' }));

    const out = repo(dir, 'out');
    symlinkSync(join(dir, 'netrc'), join(out, 'README.md'));
    expect(repoHint(out)).toBe('');
    const relOut = repo(dir, 'rel-out');
    symlinkSync('../netrc', join(relOut, 'README.md'));
    expect(repoHint(relOut)).toBe('');
    const pkgOut = repo(dir, 'pkg-out', { files: { 'README.md': 'Own readme' } });
    symlinkSync(join(dir, 'evil.json'), join(pkgOut, 'package.json'));
    expect(repoHint(pkgOut)).toBe('Own readme');

    // Inside the repository a link is fine, and so is reaching the repository itself through one.
    const inside = repo(dir, 'inside', { files: { 'intro.md': 'Linked intro' } });
    symlinkSync('intro.md', join(inside, 'README.md'));
    expect(repoHint(inside)).toBe('Linked intro');
    symlinkSync(repo(dir, 'target', { files: { 'README.md': 'Through a link' } }), join(dir, 'via-link'));
    expect(repoHint(join(dir, 'via-link'))).toBe('Through a link');

    const dirReadme = repo(dir, 'dir-readme');
    mkdirSync(join(dirReadme, 'README.md'));
    expect(repoHint(dirReadme)).toBe('');
  });

  // Run in a child: a blocking open() of a FIFO with no writer never returns, and vitest cannot time
  // out synchronous code — a regression would hang the whole unit run instead of failing this test.
  it('does not block on a FIFO, and moves on to the next source', () => {
    const dir = tempDir('hint-fifo');
    const piped = repo(dir, 'piped', { files: { 'README.md': 'After the pipe' } });
    execFileSync('mkfifo', [join(piped, 'package.json')]);
    const readmePipe = repo(dir, 'readme-pipe');
    execFileSync('mkfifo', [join(readmePipe, 'README.md')]);
    const moduleUrl = new URL('./repo-discovery.ts', import.meta.url).href;
    const script = [
      `const m = await import(${JSON.stringify(moduleUrl)});`,
      'const t = performance.now();',
      `const hints = ${JSON.stringify([piped, readmePipe])}.map((d) => m.repoHint(d));`,
      'console.log(JSON.stringify({ hints, ms: performance.now() - t }));',
    ].join(' ');
    const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      // Captured, not inherited: Node warns that `package.json` has no "type" when it loads the .ts
      // module. On a failure the thrown error still carries it.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    const result = JSON.parse(stdout) as { hints: string[]; ms: number };
    expect(result.hints).toEqual(['After the pipe', '']);
    expect(result.ms).toBeLessThan(1000);
  }, 15_000);

  it(`reads at most HINT_READ_BYTES (${HINT_READ_BYTES}) of each file`, () => {
    const dir = tempDir('hint-bound');
    const late = repo(dir, 'late', { files: { 'package.json': JSON.stringify({ padding: 'z'.repeat(HINT_READ_BYTES), description: 'Too late' }), 'README.md': 'Readme instead' } });
    expect(repoHint(late)).toBe('Readme instead');
    const deep = repo(dir, 'deep', { files: { 'README.md': `# Title\n${'\n'.repeat(HINT_READ_BYTES)}Beyond the bound\n` } });
    expect(repoHint(deep)).toBe('');
  });

  it('ignores a leading byte-order mark, and README lines that are markup rather than prose', () => {
    const dir = tempDir('hint-markup');
    const BOM = String.fromCharCode(0xfeff);
    const ZWSP = String.fromCharCode(0x200b);
    expect(repoHint(repo(dir, 'bom-pkg', { files: { 'package.json': `${BOM}${JSON.stringify({ description: 'With a BOM' })}` } }))).toBe('With a BOM');
    expect(repoHint(repo(dir, 'bom-readme', { files: { 'README.md': `${BOM}# Title\nProse after a BOM\n` } }))).toBe('Prose after a BOM');
    const markup = [
      '<p align="center">',
      '  <img src="logo.png">',
      '[![CI](https://ci.example/badge.svg)](https://ci.example)',
      '![logo](logo.png)',
      '---',
      '===',
      `${ZWSP}# A heading behind a zero-width space`,
      ZWSP,
      'The real description.',
    ].join('\r\n');
    expect(repoHint(repo(dir, 'markup', { files: { 'README.md': markup } }))).toBe('The real description.');
    // A description that cleans to nothing is no description.
    expect(repoHint(repo(dir, 'blank-desc', { files: { 'package.json': JSON.stringify({ description: ZWSP }), 'README.md': 'Readme it is' } }))).toBe('Readme it is');
  });

  it('returns an empty hint for a file it cannot read, rather than throwing', () => {
    const dir = tempDir('hint-locked');
    const locked = repo(dir, 'locked', { files: { 'README.md': 'secret' } });
    chmodSync(join(locked, 'README.md'), 0o000);
    try {
      expect(repoHint(locked)).toBe('');
    } finally {
      chmodSync(join(locked, 'README.md'), 0o644);
    }
  });
});

describe('mergeCandidates', () => {
  const projectAt = (id: string, repoPath: string): Project => ({ id, name: id, repoPath, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: 'x' });

  it('makes every registered project a candidate, first, even one outside the repos folder', () => {
    const dir = tempDir('merge');
    const outside = repo(tempDir('merge-out'), 'Elsewhere', { files: { 'README.md': 'Out of tree' } });
    repo(dir, 'fresh');
    expect(mergeCandidates(discoverRepos(dir, { excludeUnder: NO_HOME }).repos, [projectAt('p1', outside)])).toEqual([
      { path: outside, name: 'p1', hint: 'Out of tree', projectId: 'p1' },
      { path: join(dir, 'fresh'), name: 'fresh', hint: '', projectId: null },
    ]);
  });

  it('treats a discovered repo whose REAL path is a registered project as that project', () => {
    const dir = tempDir('merge-real');
    const checkout = repo(dir, 'AcmeApi');
    // `/tmp` → `/private/tmp` on macOS: one repository under two spellings, which is exactly what a
    // string comparison would count twice.
    const registered = realpathSync(checkout);
    expect(registered).not.toBe(checkout);
    expect(mergeCandidates(discoverRepos(dir, { excludeUnder: NO_HOME }).repos, [projectAt('p1', registered)])).toEqual([
      { path: registered, name: 'p1', hint: '', projectId: 'p1' },
    ]);
  });

  it.skipIf(!CASE_INSENSITIVE_TMP)('treats a registered path spelled in a different case as the same repository (needs a case-insensitive /tmp)', () => {
    const dir = tempDir('merge-case');
    const checkout = repo(dir, 'AcmeApi');
    const registered = checkout.toUpperCase();
    expect(mergeCandidates(discoverRepos(dir, { excludeUnder: NO_HOME }).repos, [projectAt('p1', registered)])).toEqual([
      { path: registered, name: 'p1', hint: '', projectId: 'p1' },
    ]);
  });

  it('reads hints once, for the merged list — discovery leaves them empty', () => {
    const dir = tempDir('merge-hints');
    repo(dir, 'fresh', { files: { 'README.md': 'Fresh repo' } });
    const discovered = discoverRepos(dir, { excludeUnder: NO_HOME }).repos;
    expect(discovered.map((r) => r.hint)).toEqual(['']);
    expect(mergeCandidates(discovered, [])).toEqual([{ path: join(dir, 'fresh'), name: 'fresh', hint: 'Fresh repo', projectId: null }]);
  });
});
