import { closeSync, ftruncateSync, openSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitFile, createRepo, git, testGitEnv } from '../../../test/fixtures/git-repo.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { exec, type Exec } from '../util/exec.ts';
import { PathJailError, MAX_TEXT_BYTES } from './fs-browse.ts';
import { GitError, createGitService } from './git.ts';
import {
  MAX_UNTRACKED_STAT_BYTES,
  createDiffService,
  parseBatchCheck,
  parseNameStatus,
  parsePorcelainV2,
  parseShortStat,
  type DiffService,
} from './diff-service.ts';

/**
 * A repo plus a worktree branched off it, exactly as `agent-service` builds one.
 *
 * `tempDir`, not `join(repo, '..', …)`: it removes itself with `onTestFinished`, and it mkdtemps
 * under `/tmp` on purpose (spec G9 — see `test/fixtures/tmp.ts`).
 */
async function fixture(files: Record<string, string> = { 'README.md': 'base\n' }): Promise<{
  repo: string;
  wt: string;
  svc: DiffService;
  spied: { args: string[]; input: string | undefined }[];
}> {
  const repo = createRepo({ files });
  const env = testGitEnv(repo);
  const spied: { args: string[]; input: string | undefined }[] = [];
  // Wraps the REAL exec rather than replacing it: every assertion below still runs against real
  // git, and the recording is what lets one test prove no caller byte reached the command line.
  const spy: Exec = (file, args, opts) => {
    spied.push({ args, input: opts?.input });
    return exec(file, args, opts);
  };
  const gitSvc = createGitService({ exec: spy, env });
  const wt = tempDir('diff-wt');
  await gitSvc.worktreeAdd(repo, { branch: 'agent/diff', path: wt, baseRef: 'main' });
  return { repo, wt, svc: createDiffService({ git: gitSvc, exec: spy, env }), spied };
}

describe('parsers', () => {
  // Every string in this block was captured from git 2.50.1 (Apple Git-155) on a real repo — see
  // the module comment in diff-service.ts. They are not hand-written approximations of the format.
  it('parseNameStatus handles A/M/D and renames', () => {
    // Measured: `git diff --name-status -z -M <base> HEAD` after a modify, an add and a rename.
    // The rename sits in the MIDDLE on purpose. A rename record is three tokens where every other
    // status is two, and a parser that advances by two throws the stream out of phase — but only
    // for what comes AFTER it, so a rename placed last hides the bug entirely.
    expect(parseNameStatus('M\0README.md\0R100\0old.txt\0renamed.txt\0A\0added-committed.txt\0D\0gone.txt\0')).toEqual([
      { relPath: 'README.md', status: 'M' },
      { relPath: 'renamed.txt', status: 'R' },
      { relPath: 'added-committed.txt', status: 'A' },
      { relPath: 'gone.txt', status: 'D' },
    ]);
    expect(parseNameStatus('D\0gone.txt\0')).toEqual([{ relPath: 'gone.txt', status: 'D' }]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('parsePorcelainV2 handles ordinary, renamed, untracked and unmerged entries', () => {
    // Measured: `git status --porcelain=v2 -z --untracked-files=all`. The rename record ('2') is
    // followed by the ORIGINAL path as its own NUL-terminated token with no status code of its
    // own; a parser that does not skip it reports a phantom file called `r.txt`.
    const out =
      '1 .D N... 100644 100644 000000 2787717b02871c072914baf33306945f9e5cc3c4 2787717b02871c072914baf33306945f9e5cc3c4 bin.dat\0' +
      '1 .M N... 100644 100644 100644 b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d keep.txt\0' +
      '1 AD N... 000000 100644 000000 0000000000000000000000000000000000000000 587be6b4c3f93f93c489c0111bba5596147a26cb staged-del-wt.txt\0' +
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 7202bf1a5548b5f00249a5fe645e7a25246c36fa staged-new.txt\0' +
      // The original path is `u.txt` rather than `r.txt` deliberately: the skip is only observable
      // when that trailing token starts with a record-type character. With `r.txt` the stray token
      // matches no branch and is dropped by accident, so the bug hides — measured.
      '2 R. N... 100644 100644 100644 163ffd1db586ee7df4a3de892b4204af9786e5d4 163ffd1db586ee7df4a3de892b4204af9786e5d4 R100 r2.txt\0u.txt\0' +
      'u UU N... 100644 100644 100644 100644 01e79c32a8c99c557f0757da7cb6d65b3414466d b6ddd0c430e287bf3c3cc901a0ffd5ed7ef8b17b f081db642ff8dbc276a85a6a1c11684677d58348 a.txt\0' +
      '? untracked.txt\0';
    expect(parsePorcelainV2(out)).toEqual([
      { relPath: 'bin.dat', status: 'D', untracked: false },
      { relPath: 'keep.txt', status: 'M', untracked: false },
      // `AD` = staged as new, then removed from the working tree. The working tree is what the
      // Diff tab shows, and the file is not there, so it is a D — not the A the index column says.
      { relPath: 'staged-del-wt.txt', status: 'D', untracked: false },
      { relPath: 'staged-new.txt', status: 'A', untracked: false },
      { relPath: 'r2.txt', status: 'R', untracked: false },
      { relPath: 'a.txt', status: 'M', untracked: false },
      { relPath: 'untracked.txt', status: 'U', untracked: true },
    ]);
  });

  it('parsePorcelainV2 keeps paths containing spaces whole', () => {
    expect(parsePorcelainV2('1 .M N... 100644 100644 100644 abc def a b c.ts\0')).toEqual([
      { relPath: 'a b c.ts', status: 'M', untracked: false },
    ]);
  });

  it('parseShortStat', () => {
    // Measured forms: plural, singular, and the empty string git prints when nothing tracked changed.
    expect(parseShortStat(' 6 files changed, 4 insertions(+), 1 deletion(-)')).toEqual({ insertions: 4, deletions: 1 });
    expect(parseShortStat(' 1 file changed, 1 insertion(+)')).toEqual({ insertions: 1, deletions: 0 });
    expect(parseShortStat(' 1 file changed, 2 deletions(-)')).toEqual({ insertions: 0, deletions: 2 });
    expect(parseShortStat('')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('parseBatchCheck reads a blob header, a miss and a non-blob', () => {
    // Measured `git cat-file --batch-check -z` output for a blob, for a path absent at that rev,
    // and for the tree at the repository root.
    expect(parseBatchCheck('df967b96a579e45a18b8251732d16804b2e56a55 blob 5\n')).toEqual({
      kind: 'blob',
      oid: 'df967b96a579e45a18b8251732d16804b2e56a55',
      size: 5,
    });
    expect(parseBatchCheck('9929bed6f8f3250b4221b981ea299c3345f68691:nope.txt missing\n')).toEqual({ kind: 'missing' });
    expect(parseBatchCheck('56623e7fede43aeb0e5e4f6d56d4b5b591cf9db9 tree 108\n')).toEqual({ kind: 'other' });
  });

  it('parseBatchCheck refuses a header whose object id is not hex', () => {
    // The object id is the ONE value this module would otherwise take from git's stdout and could
    // be tempted to put back on a command line. Requiring `[0-9a-f]{40,64}` in the parser means a
    // forged or garbled header can never produce an option-shaped id — there is no separate guard
    // to forget. `unknown`, not `missing`: a header we cannot read is an error, and reporting it as
    // "the file is not in the base commit" would paint an empty left-hand side for a file that has
    // content, with nothing anywhere saying so.
    expect(parseBatchCheck('--upload-pack=touch blob 5\n')).toEqual({ kind: 'unknown' });
    expect(parseBatchCheck('-evil blob 5\n')).toEqual({ kind: 'unknown' });
    expect(parseBatchCheck('')).toEqual({ kind: 'unknown' });
  });

  it('parseBatchCheck reads a miss whose echoed path contains a newline', () => {
    // `--batch-check` echoes the request verbatim on a miss, so a path with a newline in it splits
    // the "line". Deciding on the first line alone reports `unknown` for a perfectly ordinary miss.
    expect(parseBatchCheck('9929bed6f8f3250b4221b981ea299c3345f68691:a b\nc.txt missing\n')).toEqual({ kind: 'missing' });
  });
});

describe('createDiffService.changes on a real worktree', () => {
  it('groups committed, uncommitted and untracked changes against the merge base', async () => {
    const { repo, wt, svc } = await fixture({ 'README.md': 'base\n', 'keep.txt': 'k\n', 'old.txt': 'rename me, with enough content to score a match\n' });
    commitFile(wt, 'README.md', 'base\nmore\n', 'edit readme');
    git(wt, 'mv', 'old.txt', 'renamed.txt');
    git(wt, 'commit', '-q', '-m', 'rename');
    // main moves on after the branch point: the merge base must stay where the branch forked, or
    // the tab would show main's own commits as though the agent had made them.
    commitFile(repo, 'main-only.txt', 'm\n', 'advance main');
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    unlinkSync(join(wt, 'keep.txt'));

    const set = await svc.changes(repo, wt, 'main');
    expect(set.mergeBase).toBe(git(repo, 'rev-parse', 'main~1'));
    expect(set.aheadCommits).toBe(2);
    // Sorted with `localeCompare`, which folds case — `keep.txt` before `README.md`, not the ASCII
    // order. The rename is ONE row under the new name: `-M` reports it as a single `R100` record
    // (measured), so `old.txt` does not also appear as a deletion.
    expect(set.files.map((f) => `${f.relPath}:${f.status}:${f.committed ? 'c' : '-'}${f.uncommitted ? 'u' : '-'}${f.untracked ? 't' : '-'}`)).toEqual([
      'keep.txt:D:-u-',
      'new.txt:U:-ut',
      'README.md:M:c--',
      'renamed.txt:R:c--',
    ]);
    expect(set.stats).toEqual({ insertions: 2, deletions: 1 });
  });

  it('marks a file that is both committed and dirty as both', async () => {
    const { repo, wt, svc } = await fixture({ 'a.txt': 'one\n' });
    commitFile(wt, 'a.txt', 'one\ntwo\n', 'commit a');
    writeFileSync(join(wt, 'a.txt'), 'one\ntwo\nthree\n');
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files).toEqual([{ relPath: 'a.txt', status: 'M', committed: true, uncommitted: true, untracked: false }]);
  });

  it('lets the working tree overrule the committed status when a committed file is deleted', async () => {
    // Committed as an addition since the base, then removed from disk. The Diff tab shows the
    // working tree, and there is nothing there, so the row is a D — showing it as `A` would offer
    // the user a file to click that no longer exists.
    const { repo, wt, svc } = await fixture();
    commitFile(wt, 'added.txt', 'a\n', 'add');
    unlinkSync(join(wt, 'added.txt'));
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files).toEqual([{ relPath: 'added.txt', status: 'D', committed: true, uncommitted: true, untracked: false }]);
  });

  it('marks a file untracked when git reports it twice, as `git rm --cached` makes it do', async () => {
    // Measured on git 2.50.1: after `git rm --cached later.txt`, porcelain v2 emits BOTH
    // `1 D. … later.txt` and `? later.txt` for the same path. The second record is the one that
    // carries `untracked`, and it arrives after the entry already exists.
    const { repo, wt, svc } = await fixture();
    commitFile(wt, 'later.txt', 'l\n', 'add later');
    git(wt, 'rm', '--cached', '-q', 'later.txt');
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files).toEqual([{ relPath: 'later.txt', status: 'D', committed: true, uncommitted: true, untracked: true }]);
  });

  it('counts a staged file as uncommitted, not as committed', async () => {
    const { repo, wt, svc } = await fixture();
    writeFileSync(join(wt, 'staged.txt'), 's\n');
    git(wt, 'add', 'staged.txt');
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files).toEqual([{ relPath: 'staged.txt', status: 'A', committed: false, uncommitted: true, untracked: false }]);
    expect(set.aheadCommits).toBe(0);
  });

  it('counts the lines of untracked files, which `git diff` cannot see at all', async () => {
    // Measured on git 2.50.1: in a worktree whose only change is two new untracked files,
    // `git diff --shortstat <base>` prints the EMPTY STRING. Left at that, the drawer's header
    // reads "+0 −0 · 2 files" for an agent that has just written two files — the exact case the
    // header exists to show. `git add -N` would fix it in git's own terms but writes to the index
    // of a worktree an agent is actively using, so the lines are counted here instead.
    const { repo, wt, svc } = await fixture();
    writeFileSync(join(wt, 'u1.txt'), 'a\nb\nc\n');
    writeFileSync(join(wt, 'u2.txt'), 'no trailing newline');
    const set = await svc.changes(repo, wt, 'main');
    // 3 for u1, and 1 for u2: a final line without a newline is still a line, which is what git
    // itself counts when the file is later added ("\ No newline at end of file").
    expect(set.stats).toEqual({ insertions: 4, deletions: 0 });
  });

  it('does not read through an untracked symlink when counting lines', async () => {
    // `git status --untracked-files=all` lists a symlink as an ordinary `? link.txt` (measured).
    // Opening it FOLLOWS it, so the agent would be credited with the first lines of /etc/passwd;
    // `lstat` + `isFile()` is what stops it, and reverting that check fails this test. Git stores a
    // symlink's TARGET STRING as its blob, so 0 is the honest count for one anyway.
    const { repo, wt, svc } = await fixture();
    writeFileSync(join(wt, 'real.txt'), 'x\n');
    symlinkSync('/etc/passwd', join(wt, 'link.txt'));
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files.map((f) => f.relPath)).toEqual(['link.txt', 'real.txt']);
    expect(set.stats.insertions).toBe(1);
  });

  it('stops counting untracked lines once the read budget is spent', async () => {
    // The cap is the only thing bounding this work, and `changes()` re-runs every 30 s while the
    // Diff tab is visible (spec §12.5). Five 1 MiB untracked files: the first four spend the 4 MiB
    // budget, the loop then stops, so the count is 4 * (1 MiB / 8 bytes per line).
    const { repo, wt, svc } = await fixture();
    const perLine = 'a'.repeat(7) + '\n';
    const oneMiB = perLine.repeat(1024 * 1024 / 8);
    for (const n of ['u1', 'u2', 'u3', 'u4', 'u5']) writeFileSync(join(wt, `${n}.txt`), oneMiB);
    const set = await svc.changes(repo, wt, 'main');
    expect(set.files.length).toBe(5);
    expect(MAX_UNTRACKED_STAT_BYTES).toBe(4 * 1024 * 1024);
    expect(set.stats.insertions).toBe(4 * (1024 * 1024 / 8));
  });

  it('does not count an untracked file too large to be diffed either', async () => {
    const { repo, wt, svc } = await fixture();
    writeFileSync(join(wt, 'small.txt'), 'a\n');
    writeFileSync(join(wt, 'huge.txt'), 'x\n'.repeat(MAX_TEXT_BYTES));
    const set = await svc.changes(repo, wt, 'main');
    expect(set.stats.insertions).toBe(1);
  });

  it('does not count an untracked binary file', async () => {
    const { repo, wt, svc } = await fixture();
    writeFileSync(join(wt, 'b.dat'), Buffer.from([0x41, 0x00, 0x0a, 0x0a, 0x0a]));
    const set = await svc.changes(repo, wt, 'main');
    // Three newlines in the file, and git's own diffstat reports `Bin` with 0 insertions.
    expect(set.stats).toEqual({ insertions: 0, deletions: 0 });
  });

  it('prefers origin/<default> over a stale local branch of the same name', async () => {
    const { repo, wt, svc } = await fixture();
    // A bare "origin" whose main is one commit BEHIND the local main. If `changes` merge-based
    // against the local `main` the base would be the newer commit and `aheadCommits` would differ.
    const bare = tempDir('origin');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    commitFile(repo, 'after-push.txt', 'a\n', 'local only');
    git(wt, 'merge', '-q', 'main');
    commitFile(wt, 'wt.txt', 'w\n', 'wt work');
    const set = await svc.changes(repo, wt, 'main');
    expect(set.mergeBase).toBe(git(repo, 'rev-parse', 'origin/main'));
    // Both the merged `main` commit and the worktree's own are ahead of origin/main.
    expect(set.aheadCommits).toBe(2);
    // The SAME preference through the standalone entry point. `git:fileDiff` resolves its base with
    // `mergeBaseFor` instead of keeping a second copy of the `origin/<default>` rule, so this is
    // what stops the Diff tab's row list and the file it opens from describing different
    // comparisons. Against the stale local `main` this would be the newer commit, not origin's.
    expect(await svc.mergeBaseFor(repo, wt, 'main')).toBe(set.mergeBase);
  });

  it('mergeBaseFor refuses a dash-led default branch too', async () => {
    // Same reused `assertNotOptionLike` as `changes`, reached by a second caller: a guard that bites
    // on one entry point and not the other is exactly the shape this repo keeps finding.
    const { repo, wt, svc, spied } = await fixture();
    const before = spied.length;
    await expect(svc.mergeBaseFor(repo, wt, '-evil')).rejects.toBeInstanceOf(GitError);
    expect(spied.slice(before).flatMap((c) => c.args).filter((a) => a === '-evil')).toEqual([]);
  });

  it('refuses a dash-led default branch before git is invoked', async () => {
    // `workspace.json` is a plain file the owner (or a careless agent) can edit, and
    // `project.defaultBranch` lands here verbatim. The guard doing the work is
    // `git.ts`'s `assertNotOptionLike`, reached through `mergeBase` — this module adds no guard of
    // its own, so this test is what proves the reused one still bites from here.
    const { repo, wt, svc, spied } = await fixture();
    const before = spied.length;
    await expect(svc.changes(repo, wt, '-evil')).rejects.toBeInstanceOf(GitError);
    // `refExists('refs/remotes/origin/-evil')` is allowed to run — that ref name does not begin
    // with a dash. Nothing after it may put the bare `-evil` on a command line.
    expect(spied.slice(before).flatMap((c) => c.args).filter((a) => a === '-evil')).toEqual([]);
  });
});

describe('createDiffService.fileDiff on a real worktree', () => {
  it('returns both texts for a modified file, byte for byte', async () => {
    const { repo, wt, svc } = await fixture({ 'README.md': 'base\n' });
    commitFile(wt, 'README.md', 'base\nmore\n', 'edit');
    const set = await svc.changes(repo, wt, 'main');
    // The trailing newline must survive: `GitService.run` strips one, which is why the base side
    // is read straight off `cat-file --batch`'s framing rather than through `run`.
    expect(await svc.fileDiff(wt, set.mergeBase, 'README.md')).toEqual({
      oldText: 'base\n',
      newText: 'base\nmore\n',
      oldMissing: false,
      newMissing: false,
      binary: false,
      tooLarge: false,
    });
  });

  it('preserves a file with no trailing newline and non-ASCII text', async () => {
    const { repo, wt, svc } = await fixture({ 'u.txt': 'héllo — ünïcode' });
    commitFile(wt, 'u.txt', 'héllo — ünïcode!', 'edit');
    const d = await svc.fileDiff(wt, await base(repo, wt, svc), 'u.txt');
    expect(d.oldText).toBe('héllo — ünïcode');
    expect(d.newText).toBe('héllo — ünïcode!');
  });

  it('shows one empty side for an added file and one for a deleted file, flagged as missing', async () => {
    // An empty side is a legitimate result here, so it must be distinguishable from "we could not
    // read it": `oldMissing`/`newMissing` say WHY the side is empty, and an unreadable side throws.
    const { repo, wt, svc } = await fixture({ 'keep.txt': 'k\n' });
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    unlinkSync(join(wt, 'keep.txt'));
    const mergeBase = await base(repo, wt, svc);

    expect(await svc.fileDiff(wt, mergeBase, 'new.txt')).toEqual({
      oldText: '', newText: 'n\n', oldMissing: true, newMissing: false, binary: false, tooLarge: false,
    });
    expect(await svc.fileDiff(wt, mergeBase, 'keep.txt')).toEqual({
      oldText: 'k\n', newText: '', oldMissing: false, newMissing: true, binary: false, tooLarge: false,
    });
  });

  it('reads a file that is empty at the base as present-and-empty, not as added', async () => {
    // The one case where `oldMissing` and an empty `oldText` genuinely differ.
    const { repo, wt, svc } = await fixture({ 'e.txt': '' });
    commitFile(wt, 'e.txt', 'now has content\n', 'fill');
    const d = await svc.fileDiff(wt, await base(repo, wt, svc), 'e.txt');
    expect(d).toMatchObject({ oldText: '', oldMissing: false, newText: 'now has content\n' });
  });

  it('reports a binary file as binary with no text on either side', async () => {
    // Once, when only the WORKING side is binary — the base text must not leak through into
    // `oldText` beside an empty `newText`, which would render as "the agent deleted everything".
    const { repo, wt, svc } = await fixture({ 'b.dat': 'placeholder\n' });
    writeFileSync(join(wt, 'b.dat'), Buffer.from([0x41, 0x00, 0x42]));
    git(wt, 'commit', '-q', '-am', 'binary now');
    expect(await svc.fileDiff(wt, await base(repo, wt, svc), 'b.dat')).toEqual({
      oldText: '', newText: '', oldMissing: false, newMissing: false, binary: true, tooLarge: false,
    });
  });

  it('sniffs the BASE side for binary too, not just the working file', async () => {
    // The other direction: a binary blob at the merge base that the agent has replaced with text.
    // Only the base-side sniff can catch this one, and without it the mojibake of a binary blob
    // decoded as UTF-8 would be handed to the diff view as though it were the old text.
    const repo = createRepo({ files: { 'seed.txt': 's\n' } });
    writeFileSync(join(repo, 'b.dat'), Buffer.from([0x41, 0x00, 0x42, 0x0a]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'binary at base');
    const env = testGitEnv(repo);
    const gitSvc = createGitService({ exec, env });
    const wt = tempDir('diff-wt-bin');
    await gitSvc.worktreeAdd(repo, { branch: 'agent/bin', path: wt, baseRef: 'main' });
    const svc = createDiffService({ git: gitSvc, exec, env });
    writeFileSync(join(wt, 'b.dat'), 'now plain text\n');
    expect(await svc.fileDiff(wt, await base(repo, wt, svc), 'b.dat')).toMatchObject({
      binary: true, oldText: '', newText: '', oldMissing: false, newMissing: false,
    });
  });

  it('throws on a base-side header it cannot read, rather than calling the file added', async () => {
    // The one branch real git will not produce, and the one that matters most to get right: a
    // header this module cannot parse means "we do not know", and reporting it as `oldMissing`
    // would draw a confident empty left-hand side for a file that has content. The stub answers
    // only `cat-file`; everything else is the real binary, so the rest of the path is unchanged.
    const repo = createRepo();
    const env = testGitEnv(repo);
    const gitSvc = createGitService({ exec, env });
    const wt = tempDir('diff-wt-garbled');
    await gitSvc.worktreeAdd(repo, { branch: 'agent/garbled', path: wt, baseRef: 'main' });
    const garbled: Exec = (file, args, opts) =>
      args[0] === 'cat-file' ? Promise.resolve({ stdout: 'error: object file is empty\n', stderr: '', code: 0 }) : exec(file, args, opts);
    const svc = createDiffService({ git: gitSvc, exec: garbled, env });
    await expect(svc.fileDiff(wt, await base(repo, wt, createDiffService({ git: gitSvc, exec, env })), 'README.md')).rejects.toMatchObject({
      name: 'DiffError',
      code: 'GIT',
    });
  });

  it('refuses to diff either side when one is too large, rather than inventing a deletion', async () => {
    // Truncating BOTH sides to their first 1.5 MB and handing them to `unifiedMergeView` renders a
    // gigantic fabricated deletion at the cut. `tooLarge` says so instead; it is not `binary`
    // (the file is text) and not `missing` (the file is there).
    const { repo, wt, svc } = await fixture({ 'big.txt': 'x\n'.repeat(MAX_TEXT_BYTES) });
    commitFile(wt, 'big.txt', 'small now\n', 'shrink');
    const oldBig = await svc.fileDiff(wt, await base(repo, wt, svc), 'big.txt');
    expect(oldBig).toEqual({ oldText: '', newText: '', oldMissing: false, newMissing: false, binary: false, tooLarge: true });

    const { repo: r2, wt: w2, svc: s2 } = await fixture({ 'big.txt': 'small\n' });
    writeFileSync(join(w2, 'big.txt'), 'x\n'.repeat(MAX_TEXT_BYTES));
    const newBig = await s2.fileDiff(w2, await base(r2, w2, s2), 'big.txt');
    expect(newBig).toMatchObject({ tooLarge: true, oldText: '', newText: '', binary: false });
  });

  it('serves the base side of a file too large for readFileSync to open (G63)', async () => {
    // A runaway agent log is exactly the file a user reaches for the Diff tab to explain. The
    // working side is read with a bounded descriptor read, never whole-file-then-slice, so a 2.5 GB
    // file answers `tooLarge` instead of throwing ERR_FS_FILE_TOO_LARGE. Sparse, so it costs no disk.
    const { repo, wt, svc } = await fixture({ 'runaway.log': 'small\n' });
    const fd = openSync(join(wt, 'runaway.log'), 'w');
    try {
      writeSync(fd, Buffer.alloc(16 * 1024, 0x78));
      ftruncateSync(fd, 2.5 * 1024 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    const d = await svc.fileDiff(wt, await base(repo, wt, svc), 'runaway.log');
    expect(d).toMatchObject({ tooLarge: true, newMissing: false, oldText: '', newText: '' });
  });

  it('refuses a path that escapes the worktree through a symlink, before git runs', async () => {
    // The lexical `..` check in `shared/ipc-schemas.ts` cannot see this one: every segment of
    // `escape/hosts` is innocent. `jailPath` realpaths and rejects, and it runs FIRST, so the path
    // never reaches git either.
    const { repo, wt, svc, spied } = await fixture();
    symlinkSync('/etc', join(wt, 'escape'));
    const mergeBase = await base(repo, wt, svc);
    const before = spied.length;
    await expect(svc.fileDiff(wt, mergeBase, 'escape/hosts')).rejects.toBeInstanceOf(PathJailError);
    await expect(svc.fileDiff(wt, mergeBase, '../../etc/hosts')).rejects.toMatchObject({ code: 'EACCES' });
    expect(spied.slice(before)).toEqual([]);
  });

  it('normalises the path it asks git for, rather than trusting the caller\'s spelling', async () => {
    // `a/../README.md` passes the jail (it resolves inside) but must not reach git as written:
    // git answers `fatal: … is outside repository` for `..` segments it cannot fold, and the path
    // handed to git is re-derived from the verified absolute path instead.
    const { repo, wt, svc, spied } = await fixture({ 'a/x.txt': 'x\n', 'README.md': 'base\n' });
    const mergeBase = await base(repo, wt, svc);
    const before = spied.length;
    const d = await svc.fileDiff(wt, mergeBase, 'a/../README.md');
    expect(d.oldText).toBe('base\n');
    expect(spied.slice(before).some((c) => (c.input ?? '').includes('..'))).toBe(false);
  });

  it('never puts the path or the base ref on git\'s command line', async () => {
    // The whole security posture of this module in one assertion: `cat-file`'s argv is a constant
    // and the request travels on stdin, so pathspec magic and option injection have no surface.
    const nasty = '-weird dir/--upload-pack=touch.txt';
    // Present in the BASE commit, so both cat-file calls run: an added file is answered by
    // `--batch-check` alone and would never reach the second one.
    const { repo, wt, svc, spied } = await fixture({ [nasty]: 'was\n' });
    writeFileSync(join(wt, nasty), 'now\n');
    const mergeBase = await base(repo, wt, svc);
    const before = spied.length;
    const d = await svc.fileDiff(wt, mergeBase, nasty);
    expect(d).toMatchObject({ oldText: 'was\n', newText: 'now\n', oldMissing: false });

    const after = spied.slice(before);
    expect(after.map((c) => c.args)).toEqual([
      ['cat-file', '--batch-check', '-z'],
      ['cat-file', '--batch', '-z'],
    ]);
    expect(after.every((c) => c.args.every((a) => !a.includes('weird') && !a.includes('upload-pack')))).toBe(true);
    expect(after[0]?.input).toBe(`${mergeBase}:${nasty}\0`);
  });

  it('rejects a directory rather than pretending it is an empty file', async () => {
    const { repo, wt, svc } = await fixture({ 'src/a.ts': 'a\n' });
    await expect(svc.fileDiff(wt, await base(repo, wt, svc), 'src')).rejects.toMatchObject({ code: 'NOT_A_FILE' });
  });
});

/** The merge base of `wt` against `main`, via the service itself. */
async function base(repo: string, wt: string, svc: DiffService): Promise<string> {
  return (await svc.changes(repo, wt, 'main')).mergeBase;
}
