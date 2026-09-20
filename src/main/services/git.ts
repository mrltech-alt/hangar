// Typed git operations — spec §10. Every call is execFile('git', [args]) in a given cwd; no shell.
import { existsSync, realpathSync } from 'node:fs';
import { ExecError, type Exec } from '../util/exec.ts';

export class GitError extends Error {
  /** 'GIT', not the exit status: `toIpcError` only forwards a string `code`, so a numeric one is
   *  dropped and every git failure reaches the renderer as INTERNAL (spec §10, §14). */
  readonly code = 'GIT' as const;
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Node's string code (`ENOENT`, …) forwarded from `ExecError`, so "git not installed" and "git
   *  timed out" stop being indistinguishable (both have `exitCode: null`) without grepping `message`. */
  readonly syscallCode: string | null;
  /** Killed by our own timeout, forwarded from `ExecError`, for the same reason. */
  readonly timedOut: boolean;
  constructor(args: string[], stderr: string, exitCode: number | null, extra: { syscallCode?: string | null; timedOut?: boolean } = {}) {
    super(`git ${args.join(' ')} failed (${exitCode ?? 'error'}): ${stderr.trim().split('\n').slice(0, 10).join('\n')}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.syscallCode = extra.syscallCode ?? null;
    this.timedOut = extra.timedOut ?? false;
  }
}

/**
 * Refuses any ref, branch or path value beginning with `-` before git ever sees it.
 *
 * Per-subcommand separators (`--`, `--end-of-options`) are a game of whack-a-mole against git's own
 * argument parsing, and this module lost it twice while adding them: `worktree add`'s internal
 * branch-creation step still misreads a dash-led `baseRef` even behind `--` (verified separately —
 * `--` protects the path argument but not this), and `rev-list`'s composed `baseRef..HEAD` range
 * cannot be separator-protected at all — the whole token is scanned for option-likeness before any
 * separator takes effect. Closing the class at the boundary instead of chasing it per subcommand:
 * no legitimate Hangar value starts with `-`. Branches are `agent/<slug>`, worktree paths are
 * absolute under HANGAR_HOME, and a baseRef is `main`, `origin/main`, a SHA or `HEAD`. A leading
 * dash means either a corrupt `workspace.json` or a hostile remote value, and both should fail
 * loudly here rather than being passed to git in the hope that this particular subcommand honours
 * a separator. The per-call separators stay anyway — defence in depth, and what makes this guard
 * safe to relax later if a real leading-dash value is ever legitimately needed.
 */
function assertNotOptionLike(value: string, what: string): void {
  if (value.startsWith('-')) {
    throw new GitError([what], `refusing to pass ${what} to git: it begins with '-' (${JSON.stringify(value)})`, null);
  }
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export interface GitService {
  run(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<string>;
  isToplevel(path: string): Promise<{ ok: true } | { ok: false; reason: string; toplevel?: string }>;
  detectDefaultBranch(repo: string): Promise<string>;
  listBranches(repo: string): Promise<{ local: string[]; remote: string[] }>;
  branchExists(repo: string, name: string): Promise<boolean>;
  refExists(repo: string, ref: string): Promise<boolean>;
  fetch(repo: string, branch: string): Promise<void>;
  worktreeAdd(repo: string, opts: { branch: string; path: string; baseRef: string }): Promise<void>;
  worktreeRemove(repo: string, path: string, force: boolean): Promise<void>;
  worktreePrune(repo: string): Promise<void>;
  /** Paths are as git reports them, which on macOS is the `realpath`'d form (`/private/tmp/…`, not
   *  a `/tmp/…` symlink) — resolve both sides (or compare `realpathSync`) before matching a caller's
   *  own path string against `.path`. Not reachable today; matters once Task 10/16 do that compare. */
  worktreeList(repo: string): Promise<WorktreeEntry[]>;
  branchDelete(repo: string, name: string, force: boolean): Promise<void>;
  dirtyCount(worktree: string): Promise<number>;
  /** Commits on the worktree's HEAD that are not in `baseRef`. Needs the worktree directory to
   *  exist; use `branchAheadCount` when it might not. */
  unmergedCount(worktree: string, baseRef: string): Promise<number>;
  /**
   * Commits on `branch` that are not in `baseRef`, counted from the main repo by REF rather than by
   * a worktree's HEAD — so it still answers after the worktree directory has been deleted.
   *
   * That is the case that matters: §10.3's delete dialog warns about work at risk, and a worktree
   * whose directory vanished has not un-risked the commits still sitting on its branch. Asking the
   * missing directory (as `unmergedCount` must) returns 0, which disarms the typed-name force gate
   * at precisely the moment it should arm. Both revs are resolved to SHAs first for the same
   * composed-range reason documented on `unmergedCount`.
   */
  branchAheadCount(repo: string, baseRef: string, branch: string): Promise<number>;
  mergeBase(worktree: string, ref: string): Promise<string>;
  head(worktree: string): Promise<string>;
}

export function createGitService(deps: { exec: Exec; env: Record<string, string>; gitBin?: string }): GitService {
  const bin = deps.gitBin ?? 'git';

  const run = async (cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> => {
    try {
      const r = await deps.exec(bin, args, { cwd, env: deps.env, timeoutMs: opts.timeoutMs ?? 60_000 });
      return r.stdout.replace(/\n$/, '');
    } catch (e) {
      if (e instanceof ExecError) throw new GitError(args, e.stderr.length > 0 ? e.stderr : e.message, e.code, { syscallCode: e.syscallCode, timedOut: e.timedOut });
      throw e;
    }
  };

  const succeeds = async (cwd: string, args: string[]): Promise<boolean> => {
    try {
      await run(cwd, args);
      return true;
    } catch (e) {
      // Only a clean non-zero exit means "no". A spawn failure or a timeout (both `exitCode: null`)
      // must not collapse into the same "no" — `branchExists` returning a confident false for a
      // branch that in fact exists (because git could not even run) makes `worktree add -b` fail
      // later with "already exists", and `refExists` doing the same silently downgrades a fetched
      // `origin/<base>` to a stale local branch with no error anywhere.
      if (e instanceof GitError && e.exitCode !== null) return false;
      throw e;
    }
  };

  const lines = (out: string): string[] => out.split('\n').filter((l) => l.length > 0);

  return {
    run,

    async isToplevel(path) {
      if (!existsSync(path)) return { ok: false, reason: 'path does not exist' };
      try {
        const top = await run(path, ['rev-parse', '--show-toplevel']);
        if (realpathSync(top) === realpathSync(path)) return { ok: true };
        return { ok: false, reason: `not the repository root (the root is ${top})`, toplevel: top };
      } catch (e) {
        if (e instanceof GitError) {
          if (e.syscallCode === 'ENOENT') return { ok: false, reason: 'git could not be run (is it installed?)' };
          return { ok: false, reason: 'not a git repository' };
        }
        return { ok: false, reason: String(e) };
      }
    },

    async detectDefaultBranch(repo) {
      // The origin/HEAD lookup and the validation of its result are deliberately NOT in the same
      // try/catch: origin/HEAD can be a symref to a remote-controlled branch name (a hostile remote
      // could point HEAD at a branch called "-evil"), and a dash-led result must propagate as a
      // hard failure, not be swallowed by the "no origin/HEAD, fall through to main/master" catch.
      let originHead: string | undefined;
      try {
        originHead = await run(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      } catch {
        // no origin/HEAD — fall through
      }
      if (originHead !== undefined) {
        const branch = originHead.replace(/^origin\//, '');
        assertNotOptionLike(branch, 'default branch (from origin/HEAD)');
        return branch;
      }
      for (const name of ['main', 'master']) {
        if (await succeeds(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}`])) return name;
      }
      // A detached HEAD (or an unborn/bare repo) has no branch for the last-resort fallback to name:
      // `rev-parse --abbrev-ref HEAD` would return the literal string "HEAD", and downstream
      // `unmergedCount(worktree, 'HEAD')` runs `rev-list --count HEAD..HEAD`, which is always 0 —
      // reported as "no unmerged commits" instead of refusing to guess.
      const attached = await succeeds(repo, ['symbolic-ref', '-q', 'HEAD']);
      if (!attached) throw new GitError(['symbolic-ref', '-q', 'HEAD'], 'HEAD is detached; no default branch could be determined', null);
      const current = await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      assertNotOptionLike(current, 'default branch (current branch)');
      return current;
    },

    async listBranches(repo) {
      const local = lines(await run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
      // `%(refname:short)` collapses refs/remotes/origin/HEAD to bare `origin`, NOT `origin/HEAD`, so
      // a `/HEAD` filter never matches and the remote itself is returned as though it were a branch.
      // Verified on git 2.50.1 (Apple Git-155). Filter on the FULL refname, then strip the prefix.
      const remote = lines(await run(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes']))
        .filter((r) => !r.endsWith('/HEAD'))
        .map((r) => r.slice('refs/remotes/'.length));
      return { local, remote };
    },

    branchExists: async (repo, name) => {
      assertNotOptionLike(name, 'branch name');
      return succeeds(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}`]);
    },
    refExists: async (repo, ref) => {
      assertNotOptionLike(ref, 'ref');
      return succeeds(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
    },

    async fetch(repo, branch) {
      assertNotOptionLike(branch, 'branch');
      // `--end-of-options`, not `--`: a plain `--` breaks refspec parsing here ("does not appear to
      // be a git repository"). Without a separator, a `branch` beginning with `-` is read as an
      // option — `--upload-pack=<shell command>` runs arbitrary code on the next fetch and RESOLVES
      // rather than throwing, because the injected command executes before the (now-malformed)
      // fetch fails on its own terms. Verified on git 2.50.1. The `assertNotOptionLike` above is now
      // the real defense; this `--end-of-options` is defence in depth underneath it.
      await run(repo, ['fetch', 'origin', '--end-of-options', branch], { timeoutMs: 60_000 });
    },

    async worktreeAdd(repo, opts) {
      assertNotOptionLike(opts.branch, 'branch');
      assertNotOptionLike(opts.path, 'path');
      // Closes a gap `--` alone does not: even behind `--`, worktree add's internal branch-creation
      // step still misreads a dash-led baseRef ("unknown switch"), because that step re-invokes
      // branch creation without the outer `--`'s protection. Verified separately from the path case.
      assertNotOptionLike(opts.baseRef, 'baseRef');
      // 5 minutes, not exec's 60 s default: this is a full checkout, and on a large monorepo the
      // default turns a slow-but-fine operation into a fatal error plus a rollback. `git fetch`'s
      // 60 s is a deliberate spec decision because it has a warn-and-continue fallback (§10.2);
      // this one does not.
      //
      // `--` stops `opts.path` from being read as an option: a path of `-f` would otherwise become
      // `--force`, promoting `opts.baseRef` into the path slot and creating a worktree inside the
      // repo itself with force applied — defeating the caller's own safety check. Verified on git
      // 2.50.1. Defence in depth underneath the `assertNotOptionLike` guards above, which are now
      // what actually stops a dash-led baseRef (this `--` alone does not, per the guard's comment).
      await run(repo, ['worktree', 'add', '-b', opts.branch, '--', opts.path, opts.baseRef], { timeoutMs: 300_000 });
    },

    async worktreeRemove(repo, path, force) {
      assertNotOptionLike(path, 'path');
      await run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path]);
    },

    async worktreePrune(repo) {
      await run(repo, ['worktree', 'prune']);
    },

    async worktreeList(repo) {
      // `-z`: `--porcelain` alone emits paths unquoted and newline-terminated, so a path containing
      // a newline truncates and a forged `branch` line in a hand-made worktree can be read back as
      // though it belonged to the entry above it. `-z` NUL-terminates every field and blank-line
      // record separators become empty fields, removing both classes of misparse.
      const out = await run(repo, ['worktree', 'list', '--porcelain', '-z']);
      const entries: WorktreeEntry[] = [];
      let current: WorktreeEntry | null = null;
      for (const field of out.split('\0')) {
        if (field.length === 0) {
          current = null;
        } else if (field.startsWith('worktree ')) {
          current = { path: field.slice('worktree '.length), branch: null };
          entries.push(current);
        } else if (field.startsWith('branch ') && current) {
          current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
        }
      }
      return entries;
    },

    async branchDelete(repo, name, force) {
      assertNotOptionLike(name, 'branch name');
      await run(repo, ['branch', force ? '-D' : '-d', '--', name]);
    },

    async dirtyCount(worktree) {
      // `=v1 -z`: plain `--porcelain` is documented as "may change in the future"; pin the version.
      // `-z` NUL-terminates entries and never quotes paths, but a rename/copy status emits an EXTRA
      // NUL-terminated field (the original path) with no leading status code — count only fields
      // that start with a two-character XY status, or a rename would be counted twice.
      const out = await run(worktree, ['status', '--porcelain=v1', '-z']);
      return out.split('\0').filter((f) => /^.{2} /.test(f)).length;
    },

    async unmergedCount(worktree, baseRef) {
      // The `assertNotOptionLike` guard below is the real fix: a composed range token
      // ("baseRef..HEAD") that itself begins with `-` defeats getopt-style parsing even behind
      // `--`/`--end-of-options` (verified: still "unknown switch", because the whole token is
      // scanned for option-likeness before revision parsing runs at all) — no per-call separator
      // closes this one. Resolving baseRef to a SHA first (kept as defence in depth) also happens to
      // remove the surface, since a SHA never begins with `-`.
      assertNotOptionLike(baseRef, 'baseRef');
      const resolved = await run(worktree, ['rev-parse', '--verify', '--end-of-options', baseRef]);
      return Number(await run(worktree, ['rev-list', '--count', `${resolved}..HEAD`]));
    },

    async branchAheadCount(repo, baseRef, branch) {
      assertNotOptionLike(baseRef, 'baseRef');
      assertNotOptionLike(branch, 'branch name');
      const base = await run(repo, ['rev-parse', '--verify', '--end-of-options', baseRef]);
      // `refs/heads/<branch>`, not the bare name: a bare name is ambiguous with a tag or a remote
      // ref of the same name, and this count gates whether the user is warned about losing work.
      const tip = await run(repo, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`]);
      return Number(await run(repo, ['rev-list', '--count', `${base}..${tip}`]));
    },

    // `--` before both revs: verified this correctly resolves a `-`-prefixed ref here (unlike
    // rev-list's composed range, merge-base takes two separate rev arguments). Defence in depth
    // underneath `assertNotOptionLike`.
    mergeBase: async (worktree, ref) => {
      assertNotOptionLike(ref, 'ref');
      return run(worktree, ['merge-base', '--', ref, 'HEAD']);
    },
    head: (worktree) => run(worktree, ['rev-parse', 'HEAD']),
  };
}
