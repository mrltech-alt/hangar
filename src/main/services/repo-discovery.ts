// Candidate repositories for a Linear triage — spec 2026-09-15 (linear agent) §5.2. Filesystem only; never runs git.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stripUntrustedText } from '../../../shared/agent-name.ts';
import type { RepoCandidate } from '../../../shared/linear-draft.ts';
import type { Project } from '../../../shared/types.ts';

export const REPO_CANDIDATES_MAX = 200;
export const HINT_MAX = 160;
/**
 * The most a hint read takes from `package.json` or `README.md`: a bounded read, never whole-file
 * (G63). A `description` that starts past this bound makes the JSON unparseable, so the README is used
 * instead; a README whose first prose line lies past it gives no hint.
 */
export const HINT_READ_BYTES = 8 * 1024;

/** README lines that are markup rather than a sentence about the repository. */
const README_SKIP_PREFIXES = ['#', '<', '[![', '![', '---', '==='] as const;

export interface Discovery {
  /**
   * `hint` is always `''` here: hints are read by `mergeCandidates`, once, for exactly the candidates
   * it returns — not for a discovered repo it then drops as a registered project's duplicate.
   */
  repos: RepoCandidate[];
  /** Why `reposDir` itself could not be listed; `repos` is then empty. Null when it was. */
  error: string | null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `realpathSync.native`, or the lexically resolved path when the target does not exist.
 *
 * `.native`, not the JS `realpathSync`: on a case-insensitive volume (APFS's default) the JS version
 * keeps the case the path was TYPED in, so `/Users/me/Code/x` and `/Users/me/code/x` stay two strings
 * for one directory. `.native` returns the case on disk (measured).
 */
export function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * At most `HINT_READ_BYTES` of `name` in `repoDir`, as text with any leading byte-order mark removed —
 * or null when it is missing, unreadable, or not a regular file inside the repository.
 *
 * A hint goes into the claude prompt, and the repository was written by someone else, so the read is
 * confined and cannot block:
 * - **Confined.** The file's real path must be strictly under the repository's real path, so a
 *   `README.md` symlinked to `~/.netrc` is not read (measured leaking credentials into the hint before
 *   this). A link to another file inside the repository is fine. `O_NOFOLLOW` then refuses a final
 *   component swapped for a symlink between the check and the open.
 * - **Non-blocking.** `O_NONBLOCK` makes opening a FIFO return at once instead of waiting for a writer
 *   (measured freezing `discoverRepos` — and so Electron's main process — without it), and `fstat` on
 *   the open descriptor then skips anything that is not a regular file: FIFOs, directories, devices.
 */
function readRepoFile(repoDir: string, name: string): string | null {
  let fd: number;
  try {
    const root = realpathSync.native(repoDir);
    const file = realpathSync.native(join(repoDir, name));
    if (file === root || !isUnder(file, root)) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(HINT_READ_BYTES);
    const text = buf.toString('utf8', 0, readSync(fd, buf, 0, HINT_READ_BYTES, 0));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * One line the model can pick a repo by: `package.json`'s `description`, else the first line of
 * `README.md` that is prose — not blank and not markup (`README_SKIP_PREFIXES`). A missing, unreadable,
 * truncated or malformed file falls through to the next source and finally to `''` — never a throw,
 * because one odd repo must not cost the user the whole look-up. See `readRepoFile` for what is read.
 *
 * Both sources were written by whoever owns the repository, and the hint is shown to the triage model
 * and may reach the user, so it is cleaned with `stripUntrustedText` (C0 and C1 controls, bidi,
 * zero-width and tag characters) — the same treatment the triage answer itself gets — not just the
 * C0 class. Lines are judged AFTER cleaning, so a zero-width space cannot hide a heading.
 */
export function repoHint(dir: string): string {
  const clip = (s: string): string => Array.from(stripUntrustedText(s).replace(/\s+/g, ' ').trim()).slice(0, HINT_MAX).join('');
  const pkgText = readRepoFile(dir, 'package.json');
  if (pkgText !== null) {
    try {
      const pkg: unknown = JSON.parse(pkgText);
      const description = typeof pkg === 'object' && pkg !== null ? (pkg as { description?: unknown }).description : undefined;
      const hint = typeof description === 'string' ? clip(description) : '';
      if (hint !== '') return hint;
    } catch {
      // Not JSON, or cut off by the read bound: the README is next.
    }
  }
  const readme = readRepoFile(dir, 'README.md');
  if (readme === null) return '';
  for (const raw of readme.split('\n')) {
    const line = clip(raw);
    if (line !== '' && !README_SKIP_PREFIXES.some((prefix) => line.startsWith(prefix))) return line;
  }
  return '';
}

/**
 * Git repositories DIRECTLY inside `reposDir`, sorted by name, at most `REPO_CANDIDATES_MAX`. Hidden
 * children are skipped, and so is anything whose real path is under `excludeUnder` (HANGAR_HOME):
 * Hangar's own worktrees are checkouts too, and a symlink must not smuggle one in. Hints are left
 * empty for `mergeCandidates` to read.
 */
export function discoverRepos(reposDir: string, options: { excludeUnder: string }): Discovery {
  let names: string[];
  try {
    names = readdirSync(reposDir);
  } catch (e) {
    return { repos: [], error: errorMessage(e) };
  }
  const excluded = safeRealpath(options.excludeUnder);
  const repos: RepoCandidate[] = [];
  for (const name of [...names].sort()) {
    if (repos.length >= REPO_CANDIDATES_MAX) break;
    if (name.startsWith('.')) continue;
    const path = join(reposDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
      statSync(join(path, '.git')); // a directory, or a linked worktree's `.git` FILE — both are checkouts
    } catch {
      continue;
    }
    if (isUnder(safeRealpath(path), excluded)) continue;
    repos.push({ path, name, hint: '', projectId: null });
  }
  return { repos, error: null };
}

/**
 * Registered projects first — every one is a candidate, wherever it lives — then the discovered repos
 * that are not already one of them. "Already one of them" is REAL-path equality (`safeRealpath`), so
 * `/tmp/x`, `/private/tmp/x` and, on a case-insensitive volume, `/TMP/X` are one repository, not
 * several. Hints are read here, after the merge, so a dropped duplicate costs no reads.
 */
export function mergeCandidates(discovered: readonly RepoCandidate[], projects: readonly Project[]): RepoCandidate[] {
  const registeredReal = new Set(projects.map((p) => safeRealpath(p.repoPath)));
  const merged: RepoCandidate[] = [
    ...projects.map((p): RepoCandidate => ({ path: p.repoPath, name: p.name, hint: '', projectId: p.id })),
    ...discovered.filter((d) => !registeredReal.has(safeRealpath(d.path))),
  ];
  return merged.map((c) => ({ ...c, hint: repoHint(c.path) }));
}
