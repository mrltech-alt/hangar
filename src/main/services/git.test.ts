import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { addOrigin, commitFile, createRepo, git, testGitEnv } from '../../../test/fixtures/git-repo.ts';
import { exec, type Exec } from '../util/exec.ts';
import { GitError, createGitService } from './git.ts';

const svc = (repo: string) => createGitService({ exec, env: testGitEnv(repo) });

describe('isToplevel / detectDefaultBranch', () => {
  it('accepts the repo root, rejects subdirectories and non-repos', async () => {
    const repo = createRepo({ files: { 'sub/a.txt': 'a' } });
    const g = svc(repo);
    expect(await g.isToplevel(repo)).toEqual({ ok: true });
    const sub = await g.isToplevel(join(repo, 'sub'));
    expect(sub.ok).toBe(false);
    expect(sub.ok === false && sub.toplevel).toBeTruthy();
    expect((await g.isToplevel('/tmp')).ok).toBe(false);
    expect((await g.isToplevel(join(repo, 'does-not-exist'))).ok).toBe(false);
  });

  it('uses origin/HEAD over the current branch', async () => {
    // The repo's OWN current branch must differ from origin/HEAD's target, or a mutant that makes
    // the origin/HEAD lookup throw leaves the last-resort fallback returning the same answer and
    // the test green regardless (G14). `checkout -b other` guarantees they diverge.
    const repo = createRepo({ branch: 'develop' });
    addOrigin(repo, 'develop');
    git(repo, 'checkout', '-q', '-b', 'other');
    expect(await svc(repo).detectDefaultBranch(repo)).toBe('develop');
  });

  it('prefers main over master when both exist, and falls back to master when main is absent', async () => {
    const both = createRepo({ branch: 'main' });
    git(both, 'branch', 'master');
    expect(await svc(both).detectDefaultBranch(both)).toBe('main');

    // Checked out to a THIRD branch, not 'master' itself — otherwise the last-resort
    // current-branch fallback would return 'master' by coincidence even if the explicit
    // main/master detection never ran (the same vacuous-test trap as origin/HEAD above, G14).
    const masterOnly = createRepo({ branch: 'other' });
    git(masterOnly, 'branch', 'master');
    expect(await svc(masterOnly).detectDefaultBranch(masterOnly)).toBe('master');
  });

  it('falls back to the current branch when there is no origin/HEAD or main/master', async () => {
    const trunk = createRepo({ branch: 'trunk' });
    expect(await svc(trunk).detectDefaultBranch(trunk)).toBe('trunk');
  });

  it('throws a typed error on a detached HEAD instead of returning the literal string "HEAD"', async () => {
    // No origin/HEAD and no main/master branch (createRepo's default branch is 'main', which would
    // satisfy the main/master fallback regardless of what HEAD is checked out to) — otherwise the
    // detach is invisible to detectDefaultBranch and the final guard is never reached.
    const repo = createRepo({ branch: 'trunk' });
    git(repo, 'checkout', '-q', '--detach', 'HEAD');
    await expect(svc(repo).detectDefaultBranch(repo)).rejects.toBeInstanceOf(GitError);
  });
});

describe('branches', () => {
  it('lists local and remote branches; branchExists/refExists', async () => {
    const repo = createRepo();
    addOrigin(repo);
    git(repo, 'branch', 'feature/x');
    const g = svc(repo);
    expect(await g.listBranches(repo)).toEqual({ local: ['feature/x', 'main'], remote: ['origin/main'] });
    expect(await g.branchExists(repo, 'feature/x')).toBe(true);
    expect(await g.branchExists(repo, 'nope')).toBe(false);
    expect(await g.refExists(repo, 'refs/remotes/origin/main')).toBe(true);
    expect(await g.refExists(repo, 'refs/heads/nope')).toBe(false);
    await g.fetch(repo, 'main');
  });

  it('fetch does not execute a command smuggled via option injection (C1)', async () => {
    // Originally: `git fetch origin <branch>` with no separator reads a `branch` beginning with `-`
    // as an option — `--upload-pack=<shell command>` ran the command as the (fake) upload-pack
    // process and RESOLVED, no error, nothing in a log, because the injected command ran before the
    // now-malformed fetch failed on its own terms. Verified against unpatched code on git 2.50.1.
    // Now this is rejected at the service boundary before git ever runs, so the error is the
    // synthetic `assertNotOptionLike` GitError (exitCode: null — no git process ran at all), not
    // git's own "invalid refspec" from the `--end-of-options` defence-in-depth layer underneath.
    const repo = createRepo();
    addOrigin(repo);
    const g = svc(repo);
    const marker = join(tempDir('c1-marker'), 'PWNED');
    const err = await g.fetch(repo, `--upload-pack=touch ${marker}; git-upload-pack`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('fetch actually updates the remote-tracking ref, rather than being a no-op', async () => {
    const repo = createRepo();
    const bare = addOrigin(repo);
    const g = svc(repo);
    const before = git(repo, 'rev-parse', 'origin/main');

    // Advance the bare remote from an independent clone, simulating someone else pushing.
    const other = tempDir('clone');
    git(other, 'clone', '-q', bare, '.');
    git(other, 'config', 'user.email', 'test@hangar.local');
    git(other, 'config', 'user.name', 'Hangar Test');
    git(other, 'config', 'commit.gpgsign', 'false');
    const after = commitFile(other, 'elsewhere.txt', 'x');
    git(other, 'push', '-q', 'origin', 'HEAD:main');

    expect(before).not.toBe(after);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before); // stale until fetched
    await g.fetch(repo, 'main');
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(after);
  });
});

describe('worktrees', () => {
  it('add, list, dirty/unmerged counts, merge-base, remove (refusing dirty unless forced), branch delete', async () => {
    const repo = createRepo();
    const g = svc(repo);
    const wt = tempDir('wt');
    await g.worktreeAdd(repo, { branch: 'agent/one', path: wt, baseRef: 'main' });
    expect(existsSync(join(wt, 'README.md'))).toBe(true);
    expect((await g.worktreeList(repo)).map((w) => w.branch)).toEqual(['main', 'agent/one']);
    expect(await g.branchExists(repo, 'agent/one')).toBe(true);

    expect(await g.dirtyCount(wt)).toBe(0);
    writeFileSync(join(wt, 'new.txt'), 'x');
    expect(await g.dirtyCount(wt)).toBe(1);

    expect(await g.unmergedCount(wt, 'main')).toBe(0);
    const mainHead = await g.head(repo);
    commitFile(wt, 'feature.txt', 'f');
    expect(await g.unmergedCount(wt, 'main')).toBe(1);
    expect(await g.mergeBase(wt, 'main')).toBe(mainHead);

    // Same answer from the repo, by ref — and, unlike `unmergedCount`, it survives the worktree
    // directory going away, which is the whole reason it exists (see its docstring).
    expect(await g.branchAheadCount(repo, 'main', 'agent/one')).toBe(1);

    // `git worktree remove` refuses on a DIRTY WORKING TREE, not on an unmerged branch — verified on
    // git 2.50.1: a clean worktree whose branch is unmerged removes with exit 0. `commitFile` above
    // ran `git add -A`, which committed `new.txt` too and left the tree clean, so dirty it again.
    writeFileSync(join(wt, 'still-dirty.txt'), 'x');
    expect(await g.dirtyCount(wt)).toBe(1);
    await expect(g.worktreeRemove(repo, wt, false)).rejects.toBeInstanceOf(GitError);
    await g.worktreeRemove(repo, wt, true);
    expect(existsSync(wt)).toBe(false);
    await g.worktreePrune(repo);

    await expect(g.branchDelete(repo, 'agent/one', false)).rejects.toBeInstanceOf(GitError);
    await g.branchDelete(repo, 'agent/one', true);
    expect(await g.branchExists(repo, 'agent/one')).toBe(false);
  });

  it('worktreeAdd fails when the branch already exists', async () => {
    const repo = createRepo();
    git(repo, 'branch', 'agent/dup');
    const g = svc(repo);
    const err = await g.worktreeAdd(repo, { branch: 'agent/dup', path: tempDir('wt-dup'), baseRef: 'main' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    // Matched against the raw `.stderr` field, not the composed `.message` (git gives no dedicated
    // machine-readable code for "branch already exists" — exit 255 here vs. 128 for other worktree
    // add failures is undocumented git behaviour, not a stable contract to assert on).
    expect((err as GitError).stderr).toMatch(/already exists/);
  });

  it('worktreePrune removes a stale entry after its directory is deleted out from under git', async () => {
    const repo = createRepo();
    const g = svc(repo);
    const wt = tempDir('wt-prune');
    await g.worktreeAdd(repo, { branch: 'agent/prune', path: wt, baseRef: 'main' });
    rmSync(wt, { recursive: true, force: true }); // deleted directly, not via `worktree remove`
    expect((await g.worktreeList(repo)).map((w) => w.branch)).toContain('agent/prune');
    await g.worktreePrune(repo);
    expect((await g.worktreeList(repo)).map((w) => w.branch)).not.toContain('agent/prune');
  });
});

describe('GitError / run() internals', () => {
  it('GitError preserves the failing command, stderr, exit code, syscall code and timeout flag', () => {
    const err = new GitError(['status'], 'boom\n', 1, { syscallCode: 'ENOENT', timedOut: true });
    expect(err.args).toEqual(['status']);
    expect(err.stderr).toBe('boom\n');
    expect(err.exitCode).toBe(1);
    expect(err.syscallCode).toBe('ENOENT');
    expect(err.timedOut).toBe(true);
  });

  it('run() strips exactly one trailing newline from stdout', async () => {
    const fakeExec: Exec = async () => ({ stdout: 'a\n\n', stderr: '', code: 0 });
    const g = createGitService({ exec: fakeExec, env: {} });
    expect(await g.run('/x', ['x'])).toBe('a\n');
  });

  it('worktreeAdd requests a 5-minute timeout, not exec\'s 60s default', async () => {
    const calls: Array<{ file: string; args: string[]; opts?: { timeoutMs?: number } }> = [];
    const fakeExec: Exec = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: '', stderr: '', code: 0 };
    };
    const g = createGitService({ exec: fakeExec, env: {} });
    await g.worktreeAdd('/repo', { branch: 'b', path: '/p', baseRef: 'main' });
    expect(calls[0]?.opts?.timeoutMs).toBe(300_000);
  });
});

describe('option-shaped input is rejected at the boundary, before git ever runs', () => {
  // Per-subcommand separators (`--`, `--end-of-options`) turned out to be a game of whack-a-mole
  // against git's own argument parsing — lost twice in this module (worktree add's internal
  // branch-creation step, and rev-list's composed range). These tests assert the boundary guard
  // itself: a dash-led value throws a GitError and the fake exec is never called at all, which
  // proves both "throws" and "no side effect" in one assertion — nothing downstream of the guard
  // ever runs.
  function spyExec(): { exec: Exec; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const fakeExec: Exec = async (file, args, opts) => {
      calls.push([file, args, opts]);
      return { stdout: '', stderr: '', code: 0 };
    };
    return { exec: fakeExec, calls };
  }

  it('fetch rejects a dash-led branch', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.fetch('/repo', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('worktreeAdd rejects a dash-led branch, path, or baseRef', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.worktreeAdd('/repo', { branch: '-evil', path: '/p', baseRef: 'main' })).rejects.toBeInstanceOf(GitError);
    await expect(g.worktreeAdd('/repo', { branch: 'ok', path: '-evil', baseRef: 'main' })).rejects.toBeInstanceOf(GitError);
    await expect(g.worktreeAdd('/repo', { branch: 'ok', path: '/p', baseRef: '-evil' })).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('worktreeRemove rejects a dash-led path', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.worktreeRemove('/repo', '-evil', true)).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('branchDelete rejects a dash-led name', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.branchDelete('/repo', '-evil', true)).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('branchExists rejects a dash-led name', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.branchExists('/repo', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('refExists rejects a dash-led ref', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.refExists('/repo', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('unmergedCount rejects a dash-led baseRef', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.unmergedCount('/wt', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('branchAheadCount rejects a dash-led baseRef or branch', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.branchAheadCount('/repo', '-evil', 'agent/x')).rejects.toBeInstanceOf(GitError);
    await expect(g.branchAheadCount('/repo', 'main', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('mergeBase rejects a dash-led ref', async () => {
    const { exec: fakeExec, calls } = spyExec();
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.mergeBase('/wt', '-evil')).rejects.toBeInstanceOf(GitError);
    expect(calls).toEqual([]);
  });

  it('detectDefaultBranch rejects a dash-led origin/HEAD target instead of returning it', async () => {
    // A hostile remote can point origin/HEAD at a branch literally named "-evil"; the symref
    // resolves fine, and only the guard on the STRIPPED result stops it from being handed back.
    const { calls } = spyExec();
    const fakeExec: Exec = async (file, args, opts) => {
      calls.push([file, args, opts]);
      return { stdout: 'origin/-evil\n', stderr: '', code: 0 };
    };
    const g = createGitService({ exec: fakeExec, env: {} });
    await expect(g.detectDefaultBranch('/repo')).rejects.toBeInstanceOf(GitError);
    // Only the origin/HEAD lookup itself ran; the guard fired before falling through to main/master.
    expect(calls.length).toBe(1);
  });

  it('still accepts origin/main, a raw SHA, and HEAD as baseRef (the guard must not overreach)', async () => {
    const repo = createRepo();
    addOrigin(repo);
    const g = svc(repo);
    const sha = await g.head(repo);

    const wtOrigin = tempDir('wt-baseref-origin');
    await g.worktreeAdd(repo, { branch: 'agent/base-origin', path: wtOrigin, baseRef: 'origin/main' });
    expect(existsSync(join(wtOrigin, 'README.md'))).toBe(true);

    const wtSha = tempDir('wt-baseref-sha');
    await g.worktreeAdd(repo, { branch: 'agent/base-sha', path: wtSha, baseRef: sha });
    expect(existsSync(join(wtSha, 'README.md'))).toBe(true);

    const wtHead = tempDir('wt-baseref-head');
    await g.worktreeAdd(repo, { branch: 'agent/base-head', path: wtHead, baseRef: 'HEAD' });
    expect(existsSync(join(wtHead, 'README.md'))).toBe(true);
  });
});
