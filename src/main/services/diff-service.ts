// What has this agent changed since it branched? — the Diff tab's change set and per-file texts
// (spec §12.5 Diff, and §19.2's `merge-base + change set (added/modified/deleted/renamed/untracked)`).
//
// Two shapes of answer:
//   changes()  — the header counts (`+A −D · N files · M commits ahead`) and the grouped file list.
//   fileDiff() — the OLD text (the file as it stood at the merge base) and the NEW text (the file as
//                it stands in the working tree right now). Deliberately NOT a unified-diff string:
//                the tab renders with `@codemirror/merge`'s `unifiedMergeView`, which takes
//                `oldText`/`newText` and computes the rendering itself.
//
// An empty side is a legitimate answer — an added file has no base text, a deleted file has no
// working text — so every empty side is labelled with WHY it is empty (`oldMissing`, `newMissing`,
// `binary`, `tooLarge`) and anything that cannot be read throws instead. A blank pane with nothing
// saying which of those it is would be indistinguishable from a bug.
//
// SECURITY. `relPath` comes from the renderer and `defaultBranch` from `workspace.json`, which a
// hand edit can set to anything. Rather than guard git's command line, this module keeps
// caller-influenced bytes OFF it:
//
//   * The working-tree side goes through `jailPath` (fs-browse.ts) — no git involved — and it runs
//     FIRST, so a path that escapes the worktree never reaches git either. The path then handed to
//     git is re-derived from the VERIFIED absolute path, never from the caller's spelling of it.
//   * The base side is read with `git cat-file --batch-check -z` and `--batch -z`, whose argv is a
//     constant and whose `<rev>:<path>` request travels on STDIN. Measured on git 2.50.1 (Apple
//     Git-155): `<sha>:-weird.txt` comes back as that blob (`e556b83… blob 2`) rather than being
//     read as an option, and `<sha>:/etc/passwd` comes back `missing` rather than escaping the
//     tree. Same move as `fs-browse.ts`'s `check-ignore --stdin`, and it is why the object id
//     returned by `--batch-check` never has to be trusted: it is never put back on a command line.
//   * Everything else (`merge-base`, `rev-list`, `diff`, `status`) goes through `GitService`, whose
//     `assertNotOptionLike` refuses a dash-led ref before git is invoked. None of those calls take
//     a PATHSPEC, so pathspec magic (`:(glob)`, `:/`, a leading `-`) has no surface here at all.
import { lstatSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type { ChangeSet, FileDiff } from '../../../shared/ipc-contract.ts';
import { BINARY_SNIFF_BYTES, FsBrowseError, MAX_TEXT_BYTES, jailPath, readHead } from './fs-browse.ts';
import type { GitService } from './git.ts';
import type { Exec } from '../util/exec.ts';

type Status = ChangeSet['files'][number]['status'];
type ChangeFile = ChangeSet['files'][number];

/**
 * Total bytes `changes()` will read off disk to count the lines of untracked files.
 *
 * There has to be a ceiling: `changes()` re-runs every 30 s while the Diff tab is visible
 * (spec §12.5), it runs on Electron's main thread, and `--untracked-files=all` in a repo with a
 * thin `.gitignore` can list a great many files. Past the budget the remaining untracked files
 * still appear in the list; they just stop contributing to `+A`.
 */
export const MAX_UNTRACKED_STAT_BYTES = 4 * 1024 * 1024;

/**
 * `git diff --name-status -z -M <base> HEAD`.
 *
 * `-z` makes each field its own NUL-terminated token, so a path with a space or a newline in it
 * stays whole. A rename or copy spends THREE tokens (`R100`, old path, new path) where every other
 * status spends two — measured: `"M\0README.md\0A\0added-committed.txt\0R100\0old.txt\0renamed.txt\0"`.
 * A parser that advances by two throws the token stream out of phase from the first rename onward.
 */
export function parseNameStatus(out: string): { relPath: string; status: Status }[] {
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const result: { relPath: string; status: Status }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const letter = (tokens[i] ?? '')[0];
    if (letter === 'R' || letter === 'C') {
      // The NEW path, which is what the user clicks; git reports the old one as a separate D.
      const to = tokens[i + 2];
      if (to !== undefined) result.push({ relPath: to, status: 'R' });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) result.push({ relPath: path, status: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M' });
      i += 2;
    }
  }
  return result;
}

/**
 * Collapses porcelain v2's two-column `XY` status into the one letter the drawer shows.
 *
 * X is the index against HEAD, Y is the working tree against the index, and the Diff tab shows the
 * working tree against the merge base — so when the two disagree the working tree wins. `AD`
 * (staged as new, then deleted from the working tree) is the case that makes this matter: reading
 * X first labels it `A` for a file that is not on disk.
 */
function xyStatus(xy: string): Status {
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('R')) return 'R';
  return 'M';
}

/**
 * `git status --porcelain=v2 -z --untracked-files=all`.
 *
 * Field layouts measured on git 2.50.1; the path is always the last field, but it can contain
 * spaces, so it is rejoined from a fixed index rather than taken as the last split:
 *
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                       → path at index 8
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>  → path at index 9, +1 token
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>             → path at index 10
 *   ? <path>
 *
 * The `2` record's original path is a bare NUL-terminated token with no status code of its own; not
 * skipping it reports a phantom changed file under the pre-rename name.
 */
export function parsePorcelainV2(out: string): { relPath: string; status: Status; untracked: boolean }[] {
  const tokens = out.split('\0');
  const result: { relPath: string; status: Status; untracked: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i] ?? '';
    if (line.length === 0) continue;
    const type = line[0];
    const parts = line.split(' ');
    if (type === '?') {
      result.push({ relPath: line.slice(2), status: 'U', untracked: true });
    } else if (type === '1') {
      result.push({ relPath: parts.slice(8).join(' '), status: xyStatus(parts[1] ?? ''), untracked: false });
    } else if (type === '2') {
      result.push({ relPath: parts.slice(9).join(' '), status: 'R', untracked: false });
      i++;
    } else if (type === 'u') {
      // An unmerged path is shown as a plain modification: the drawer has no conflict UI, and the
      // working-tree file (with its conflict markers) is exactly what the user needs to see.
      result.push({ relPath: parts.slice(10).join(' '), status: 'M', untracked: false });
    }
  }
  return result;
}

/** `git diff --shortstat` — " 6 files changed, 4 insertions(+), 1 deletion(-)", or "" for no change. */
export function parseShortStat(out: string): { insertions: number; deletions: number } {
  const ins = /(\d+) insertions?\(\+\)/.exec(out);
  const del = /(\d+) deletions?\(-\)/.exec(out);
  return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

export type BatchCheck =
  | { kind: 'blob'; oid: string; size: number }
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'unknown' };

/**
 * `git cat-file --batch-check -z` for a single request. Measured outputs:
 *
 *   "df967b96…a55 blob 5\n"                       a blob
 *   "56623e7f…db9 tree 108\n"                     a directory at that rev
 *   "<the request echoed verbatim> missing\n"     nothing there
 *
 * The blob branch requires a hex object id. That is not decoration: the id is the only value this
 * module takes from git's stdout, and requiring `[0-9a-f]{40,64}` here is what makes it impossible
 * for a garbled or forged header to yield an option-shaped id — so no separate guard is needed, and
 * there is none to forget. Anything unrecognised is `unknown`, which the caller turns into a thrown
 * error: reporting it as `missing` would draw an empty base side for a file that has content.
 *
 * The `missing` test looks at the whole output, not just the first line: on a miss git echoes the
 * request, and a path containing a newline splits the "line" in two (measured).
 */
export function parseBatchCheck(out: string): BatchCheck {
  const first = out.split('\n', 1)[0] ?? '';
  const m = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(first);
  if (m) return m[2] === 'blob' ? { kind: 'blob', oid: m[1] as string, size: Number(m[3]) } : { kind: 'other' };
  if (/ missing\n?$/.test(out)) return { kind: 'missing' };
  return { kind: 'unknown' };
}

export class DiffError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiffError';
    this.code = code;
  }
}

export interface DiffService {
  /**
   * The commit `changes()` measures against — exposed because `git:fileDiff` needs the SAME base as
   * the row list the user clicked, and the rule for picking it is not a detail. Preferring
   * `origin/<default>` over the local branch is a correctness decision (see `changes()` below), and
   * a second copy of it in `src/main/ipc/handlers.ts` is how the two halves of one tab come to
   * disagree about what "changed" means after a fetch. One implementation, two callers.
   */
  mergeBaseFor(repoPath: string, worktree: string, defaultBranch: string): Promise<string>;
  /** The change set for `worktree` against `defaultBranch` of `repoPath`. */
  changes(repoPath: string, worktree: string, defaultBranch: string): Promise<ChangeSet>;
  /** The base and working-tree texts of one file. `mergeBase` comes from `mergeBaseFor`/`changes()`. */
  fileDiff(worktree: string, mergeBase: string, relPath: string): Promise<FileDiff>;
}

type Side = { text: string; missing: boolean; binary: boolean; tooLarge: boolean };

/**
 * The working-tree side of a file.
 *
 * The `st.size` test above the read is what does the work, not the bounded read below it: reverting
 * it fails `refuses to diff either side when one is too large` AND the 2.5 GB G63 case, while
 * swapping `readHead` for `readFileSync` fails nothing (measured — both mutations run). `readHead`
 * stays because it cannot read more than the size already approved: nothing here reads a file whose
 * length it has not first agreed to, even if an agent appends to it between the stat and the read.
 *
 * `lstat` and `stat` agree here — `jailPath` has already realpathed `abs`, so the leaf is never a
 * symlink by the time this runs. `lstat` is kept as the narrower of the two.
 */
function workingSide(abs: string, relPath: string): Side {
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // The agent deletes files under the drawer constantly, so "not there" is an ordinary answer
    // here rather than an error — but it is reported as `newMissing`, never as empty text.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return { text: '', missing: true, binary: false, tooLarge: false };
    throw e;
  }
  if (!st.isFile()) throw new FsBrowseError('NOT_A_FILE', `${relPath} is not a file`);
  if (st.size > MAX_TEXT_BYTES) return { text: '', missing: false, binary: false, tooLarge: true };
  const buf = readHead(abs, st.size);
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { text: '', missing: false, binary: true, tooLarge: false };
  return { text: buf.toString('utf8'), missing: false, binary: false, tooLarge: false };
}

export function createDiffService(deps: { git: GitService; exec: Exec; env: Record<string, string> }): DiffService {
  const catFile = async (worktree: string, args: string[], request: string): Promise<string> => {
    const { stdout } = await deps.exec('git', args, { cwd: worktree, input: `${request}\0`, env: deps.env, timeoutMs: 30_000 });
    return stdout;
  };

  /**
   * The file as it stood at `mergeBase`.
   *
   * Two calls, not one, so the size is known before any content crosses the pipe: `--batch` cannot
   * be told to stop, and a 500 MB blob would otherwise be buffered in the main process before
   * anyone could decide it was too large.
   *
   * The content is recovered from `--batch`'s framing (`<header>\n<content>\n`) by dropping the
   * header line and the single trailing byte git appends. That is exact for any content, including
   * one that already ends in a newline and one that does not — measured on git 2.50.1:
   * `"…blob 5\nbase\n\n"` → `"base\n"`, `"…blob 11\nno trailing\n"` → `"no trailing"`. It is also
   * why this does not go through `GitService.run`, which strips a trailing newline of its own and
   * would silently eat the last line of every file.
   */
  const baseSide = async (worktree: string, mergeBase: string, gitPath: string): Promise<Side> => {
    const request = `${mergeBase}:${gitPath}`;
    const check = parseBatchCheck(await catFile(worktree, ['cat-file', '--batch-check', '-z'], request));
    // A tree or a submodule gitlink at the base has no text to show; from the diff's point of view
    // the file the user clicked did not exist there.
    if (check.kind === 'missing' || check.kind === 'other') return { text: '', missing: true, binary: false, tooLarge: false };
    if (check.kind === 'unknown') throw new DiffError('GIT', `could not read ${gitPath} at ${mergeBase}`);
    if (check.size > MAX_TEXT_BYTES) return { text: '', missing: false, binary: false, tooLarge: true };
    const out = await catFile(worktree, ['cat-file', '--batch', '-z'], request);
    const content = out.slice(out.indexOf('\n') + 1, out.length - 1);
    if (content.slice(0, BINARY_SNIFF_BYTES).includes('\0')) return { text: '', missing: false, binary: true, tooLarge: false };
    return { text: content, missing: false, binary: false, tooLarge: false };
  };

  /**
   * Lines added by untracked files.
   *
   * `git diff` cannot see them at all: measured on git 2.50.1, a worktree whose only change is two
   * new untracked files answers `git diff --shortstat <base>` with the EMPTY STRING, so the header
   * would read "+0 −0 · 2 files" for an agent that has just written two files — the very case the
   * header exists to show. `git add -N` would teach git about them, but it writes to the index of a
   * worktree an agent is actively using, so the lines are counted here instead.
   *
   * `lstat` + `isFile` is the check that matters, and SYMLINKS are what it is for: measured,
   * `--untracked-files=all` lists a link as an ordinary `? link.txt` alongside real files, and
   * `openSync` FOLLOWS it — a link to /etc/passwd would credit that file's first lines to the
   * agent. Reverting the check fails `does not read through an untracked symlink`. Git stores a
   * symlink's target string as its blob, so 0 is the honest count for one anyway. Binary files
   * count 0 for the same reason git's own diffstat reports `Bin`.
   *
   * It is not doing fifo duty, tempting as that story is: measured on git 2.50.1, a fifo in the
   * worktree is omitted from `--untracked-files=all` altogether (`? link.txt`, `? real.txt`, no
   * `? pipe`), so `openSync` blocking forever on one is not reachable from here.
   *
   * Paths come from git's own status output, relative to the worktree root, so they cannot contain
   * `..`; with the leaf proven to be a regular file, nothing here can open anything outside the
   * worktree. An earlier draft also ran each path through `jailPath`; it was removed because no
   * path git can emit reaches it before `isFile` does (measured: reverting it alone failed no
   * test), and it cost a `realpathSync` per untracked file on a 30-second timer.
   */
  const untrackedInsertions = (worktree: string, paths: string[]): number => {
    let budget = MAX_UNTRACKED_STAT_BYTES;
    let lines = 0;
    for (const p of paths) {
      // The sole cap. An earlier draft also clamped each file to the REMAINING budget; the two
      // covered for each other, so reverting either one alone failed no test (measured). This one
      // stays because it also stops the loop `lstat`ing every remaining path. The overshoot it
      // allows is bounded by one file, so at most MAX_TEXT_BYTES beyond the budget.
      if (budget <= 0) break;
      const abs = join(worktree, p);
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // deleted between `git status` and now
      }
      if (!st.isFile() || st.size === 0 || st.size > MAX_TEXT_BYTES) continue;
      const buf = readHead(abs, st.size);
      budget -= buf.length;
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
      let n = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
      // A final line with no newline after it is still a line — the "\ No newline at end of file"
      // case, which git counts as an insertion once the file is added.
      lines += buf[buf.length - 1] === 0x0a ? n : n + 1;
    }
    return lines;
  };

  // `origin/<default>` when it exists: the local branch of that name can be arbitrarily stale in an
  // agent's worktree, and merge-basing against a stale local branch reports commits the agent never
  // made. `refs/remotes/origin/…` cannot itself be option-shaped; a dash-led `defaultBranch` falls
  // through to the bare name and is refused by `mergeBase`/`unmergedCount`'s `assertNotOptionLike`
  // before git runs (`diff-service.test.ts` asserts that it still does).
  const baseRefFor = async (repoPath: string, defaultBranch: string): Promise<string> =>
    (await deps.git.refExists(repoPath, `refs/remotes/origin/${defaultBranch}`)) ? `origin/${defaultBranch}` : defaultBranch;

  return {
    async mergeBaseFor(repoPath, worktree, defaultBranch) {
      return deps.git.mergeBase(worktree, await baseRefFor(repoPath, defaultBranch));
    },

    async changes(repoPath, worktree, defaultBranch) {
      const baseRef = await baseRefFor(repoPath, defaultBranch);
      const mergeBase = await deps.git.mergeBase(worktree, baseRef);
      const aheadCommits = await deps.git.unmergedCount(worktree, baseRef);
      // `mergeBase` here is git's own `merge-base` output — a hex object id, so nothing
      // caller-shaped reaches these command lines. None of the three takes a pathspec.
      const committed = parseNameStatus(await deps.git.run(worktree, ['diff', '--name-status', '-z', '-M', mergeBase, 'HEAD']));
      const working = parsePorcelainV2(await deps.git.run(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all']));
      const stat = parseShortStat(await deps.git.run(worktree, ['diff', '--shortstat', mergeBase]));

      const byPath = new Map<string, ChangeFile>();
      for (const c of committed) byPath.set(c.relPath, { relPath: c.relPath, status: c.status, committed: true, uncommitted: false, untracked: false });
      for (const w of working) {
        const existing = byPath.get(w.relPath);
        if (existing) {
          existing.uncommitted = true;
          existing.untracked = w.untracked;
          // The working tree is the newer fact: a file committed as A and then deleted is a D.
          if (w.status === 'D') existing.status = 'D';
        } else {
          byPath.set(w.relPath, { relPath: w.relPath, status: w.status, committed: false, uncommitted: true, untracked: w.untracked });
        }
      }
      const files = [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
      return {
        mergeBase,
        aheadCommits,
        stats: {
          insertions: stat.insertions + untrackedInsertions(worktree, files.filter((f) => f.untracked).map((f) => f.relPath)),
          deletions: stat.deletions,
        },
        files,
      };
    },

    async fileDiff(worktree, mergeBase, relPath) {
      // FIRST, before any git call: a path that escapes the worktree is refused here and never
      // reaches git at all. `jailPath` realpaths, so it catches the escapes the lexical `..` check
      // in `shared/ipc-schemas.ts` cannot see — a symlink whose every path segment looks innocent.
      const root = jailPath(worktree, '');
      const abs = jailPath(worktree, relPath);
      // Re-derived from the VERIFIED path rather than reused from the caller's spelling: `a/../b`
      // passes the jail (it resolves inside) but git answers `fatal: … is outside repository` for
      // `..` segments it will not fold (measured), and this way git is only ever asked for a path
      // this module has already resolved. Both ends come from `jailPath`, so both are realpathed
      // and `relative` cannot be thrown off by /tmp being a symlink to /private/tmp on macOS.
      const gitPath = relative(root, abs);
      const [oldSide, newSide] = [await baseSide(worktree, mergeBase, gitPath), workingSide(abs, relPath)];
      const binary = oldSide.binary || newSide.binary;
      // `tooLarge` blanks BOTH sides on purpose. Handing `unifiedMergeView` two independently
      // truncated texts renders a fabricated deletion of everything past the cut, which reads as a
      // real change the agent never made; saying "too large" is the honest answer.
      const tooLarge = oldSide.tooLarge || newSide.tooLarge;
      const blank = binary || tooLarge;
      return {
        oldText: blank ? '' : oldSide.text,
        newText: blank ? '' : newSide.text,
        oldMissing: oldSide.missing,
        newMissing: newSide.missing,
        binary,
        tooLarge,
      };
    },
  };
}
