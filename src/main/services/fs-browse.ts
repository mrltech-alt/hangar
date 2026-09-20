// Path-jailed file browsing for the drawer — spec §12.5 (Files), §14 (traversal row), §16.
//
// This module is a security boundary. It hands the renderer directory listings and file contents
// for a path the RENDERER chose, and the jail below is the only thing between an agent's worktree
// browser and the rest of the machine. `shared/ipc-schemas.ts` already rejects `..` segments and
// absolute paths on the wire, but that check is lexical and cannot see symlinks, so it is a first
// line rather than the line — same defence-in-depth reasoning as `IdSchema` hardening ids that
// become filenames.
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { FsEntry, FsFile } from '../../../shared/ipc-contract.ts';
import { ExecError, type Exec } from '../util/exec.ts';

export class PathJailError extends Error {
  /** 'EACCES' per spec §14: the renderer must be able to tell "refused" from "missing". */
  readonly code = 'EACCES' as const;
  constructor(relPath: string) {
    super(`path is outside the worktree: ${relPath}`);
    this.name = 'PathJailError';
  }
}

export class FsBrowseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FsBrowseError';
    this.code = code;
  }
}

/** Spec §12.5: files over this are shown as their first 1.5 MB with a "truncated" banner. */
export const MAX_TEXT_BYTES = 1.5 * 1024 * 1024;
/** Spec §12.5: images up to 10 MB are inlined as data URLs; bigger ones are refused. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Spec §12.5: "Binary (NUL in first 8 KB)". Shared with `diff-service.ts` so the Files tab
 *  and the Diff tab cannot disagree about what counts as binary. */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * `Record<string, string>` object literals answer `map['constructor']` with `Object`'s own
 * constructor — a FUNCTION, which is truthy, so `if (NAME_LANG[name])` happily returns it and the
 * renderer is handed a function where it expected a language name. Files called `constructor`,
 * `toString` or `valueOf` are legal. Every lookup in this module goes through here.
 */
function lookup(map: Record<string, string>, key: string): string | null {
  return Object.hasOwn(map, key) ? map[key] : null;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// Values are `@codemirror/language-data` names; the renderer factory added in Task 4 resolves them
// there, and an unmapped extension is `null` rather than a guess, so the viewer falls back to plain
// text instead of asking language-data for something it does not have.
const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.json': 'json', '.md': 'markdown', '.css': 'css', '.scss': 'scss', '.html': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.sh': 'shell', '.zsh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sql': 'sql', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.php': 'php', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.xml': 'xml', '.graphql': 'graphql', '.tf': 'hcl', '.lua': 'lua', '.dart': 'dart',
};

const NAME_LANG: Record<string, string> = { Dockerfile: 'dockerfile', Makefile: 'makefile', '.env': 'shell' };

export function languageFor(file: string): string | null {
  const name = basename(file);
  return lookup(NAME_LANG, name) ?? lookup(EXT_LANG, extname(name).toLowerCase());
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Physically resolves `target` by realpathing the DEEPEST ANCESTOR THAT EXISTS and re-joining the
 * segments below it.
 *
 * Realpathing `target` itself is not enough. `realpathSync` throws ENOENT when the leaf is missing,
 * so the obvious guard — `if (existsSync(t) && !inside(realpathSync(t))) reject` — silently skips
 * the physical check for any path whose last component does not exist yet, and `existsSync` FOLLOWS
 * symlinks, so a missing leaf under an escaping link reads as "does not exist" rather than "escapes".
 * Measured on macOS 25.6 / Node 22 with `escape -> /etc` inside the root:
 *
 *   rel                | lexically inside | existsSync | realpathSync(target)
 *   escape             | true             | true       | /private/etc
 *   escape/hosts       | true             | true       | /private/etc/hosts
 *   escape/newfile     | true             | FALSE      | THROW ENOENT      <-- the hole
 *   escape/deeper/x    | true             | FALSE      | THROW ENOENT      <-- the hole
 *
 * Walking up finds `<root>/escape`, realpaths it to `/private/etc`, and yields `/private/etc/newfile`,
 * which the caller then rejects. Only ENOENT/ENOTDIR are absorbed: EACCES on an unreadable directory
 * and ELOOP on a symlink cycle propagate, so this fails closed rather than guessing.
 */
function realpathDeepest(target: string): string {
  const rest: string[] = [];
  let probe = target;
  for (;;) {
    try {
      return join(realpathSync(probe), ...rest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = dirname(probe);
      // `dirname('/') === '/'`. The jailed root is realpathed by the caller before this runs, so in
      // practice the walk always terminates there; this stops an unreachable case from spinning.
      if (parent === probe) return join(probe, ...rest);
      rest.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolves `relPath` under `root`, refusing anything that escapes — via `..`, via an absolute path,
 * or via a symlink. Returns the resolved absolute path, which for an existing entry is its
 * REALPATH: the caller then operates on the exact path this function verified, rather than on a
 * spelling of it that could resolve somewhere else.
 *
 * `resolve`, not `join`, is what makes the lexical half meaningful — `resolve('/repo', '/etc/hosts')`
 * yields `/etc/hosts`, so an absolute `relPath` is caught by the containment test rather than being
 * quietly appended (the same note `worktree-setup.ts` carries). Unlike that module's
 * `resolveWithin`, this one must NOT simply follow symlinks: copy-patterns wants a `.env` symlinked
 * out of the repo to be copied, but the drawer must never serve a file the worktree merely points
 * at. Spec §14: symlinks that escape are listed as `symlink` and not followed.
 *
 * A path that does not exist is allowed through (once its ancestors are checked) so callers can
 * fail with NOT_FOUND. That is safe here only because this module never writes; a future writer
 * must resolve the parent and re-check before creating anything.
 */
export function jailPath(root: string, relPath: string): string {
  // The root itself is realpathed first: test fixtures live under `/tmp`, which IS a symlink to
  // `/private/tmp` on macOS, so comparing a realpathed child against an unresolved root would
  // reject every legitimate path in the suite (and every worktree under a symlinked HANGAR_HOME).
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, relPath);
  if (!isInside(rootReal, target)) throw new PathJailError(relPath);
  const real = realpathDeepest(target);
  if (!isInside(rootReal, real)) throw new PathJailError(relPath);
  return real;
}

/**
 * The subset of `names` that git considers ignored, asked of the real `git check-ignore`.
 *
 * Names travel on STDIN, never argv: `git check-ignore --stdin` reads each NUL-separated record as
 * a pathspec and does not option-parse it. Measured on git 2.50.1 with a file called `-weird.log` —
 * reported as ignored (exit 0, echoed verbatim) rather than treated as a flag. That is why this
 * needs no `assertNotOptionLike` guard: the argv is the constant `['check-ignore', '--stdin', '-z']`
 * and the directory is passed as `cwd`, so no caller-controlled byte reaches git's command line at
 * all. `fs-browse.test.ts` asserts that argv, which is what stops a refactor from moving the names
 * back onto it. `-z` also keeps a filename containing a newline intact, both in and out.
 *
 * Output echoes each ignored path exactly as supplied, so running with `cwd` set to the directory
 * being listed means the results are the bare names already — no basename mapping, and therefore no
 * chance of a name from one directory being credited to another.
 *
 * The index is deliberately consulted (no `--no-index`): a tracked file that happens to match a
 * pattern is not dimmed, because it is not actually ignored.
 */
async function ignoredNames(dir: string, names: string[], exec: Exec, env: Record<string, string>): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  try {
    const { stdout } = await exec('git', ['check-ignore', '--stdin', '-z'], {
      cwd: dir,
      input: names.join('\0') + '\0',
      env,
      timeoutMs: 10_000,
    });
    return new Set(stdout.split('\0').filter((p) => p.length > 0));
  } catch (e) {
    // Exit 1 is not an error: it is git saying "none of these are ignored" (measured — empty stdout,
    // empty stderr). Exit 128 is `fatal: not a git repository`, which a worktree with a broken
    // `.git` link produces; degrading to "nothing ignored" costs a dimming hint, whereas throwing
    // would make the file tree unusable for exactly the workspace the user is trying to inspect.
    // A timeout or a missing git binary lands here too, for the same reason.
    if (e instanceof ExecError) return new Set();
    throw e;
  }
}

// Directories first, then everything else. Symlinks sort with files rather than with directories
// because this module refuses to follow them, so a symlink is a leaf whatever it points at.
const KIND_ORDER: Record<FsEntry['kind'], number> = { dir: 0, symlink: 2, file: 2, other: 3 };

export async function listDir(root: string, relPath: string, exec: Exec, env: Record<string, string>): Promise<FsEntry[]> {
  const dir = jailPath(root, relPath);
  const st = statOrNotFound(dir, relPath);
  if (!st.isDirectory()) throw new FsBrowseError('NOT_A_DIR', `${relPath || '.'} is not a directory`);
  // Hidden at every level, not just the top: a submodule's `.git` is no more browsable than the
  // worktree's own, and `.git` in a worktree is a FILE, not a directory (spec §10.2).
  const names = readdirSync(dir).filter((n) => n !== '.git');
  const ignored = await ignoredNames(dir, names, exec, env);
  const entries: FsEntry[] = names.map((name) => {
    // lstat, not stat: a symlink must be reported as `symlink` with its own metadata. `stat` would
    // report an escaping link as a plain `dir`/`file` and invite the renderer to open it.
    const lst = lstatSync(join(dir, name));
    const kind: FsEntry['kind'] = lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : 'other';
    return { name, kind, ignored: ignored.has(name), size: kind === 'file' ? lst.size : null };
  });
  // Spec §12.5: dirs first, ignored last, case-insensitive by name. `sensitivity: 'base'` folds
  // case, so `README.md` sorts AFTER `pic.png` (r > p) — not the ASCII order, deliberately.
  entries.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(a.ignored) - Number(b.ignored) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return entries;
}

// Annotated `Stats`, not `ReturnType<typeof statSync>`: that alias picks up the `throwIfNoEntry: false`
// overload and widens to `Stats | BigIntStats | undefined`, so every `st.size` below became
// "possibly undefined" and `number | bigint`. tsc caught it; the 21 passing tests did not.
function statOrNotFound(abs: string, relPath: string): Stats {
  try {
    return statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A worktree mutates under the drawer constantly: the agent deletes the file the user just
    // clicked. That must arrive as a structured NOT_FOUND, not a raw Node ENOENT that
    // `toIpcError` can only report as INTERNAL. ENOTDIR is `a.txt/x`; ELOOP is a symlink cycle.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw new FsBrowseError('NOT_FOUND', `${relPath || '.'} does not exist`);
    }
    throw e;
  }
}

/** Reads at most `maxBytes` from the head of `file`, so classifying a 3 GB blob costs one page.
 *  Exported for `diff-service.ts`, which needs the same G63-safe bounded read. */
export function readHead(file: string, maxBytes: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function readFileForViewer(root: string, relPath: string): FsFile {
  const file = jailPath(root, relPath);
  const st = statOrNotFound(file, relPath);
  if (!st.isFile()) throw new FsBrowseError('NOT_A_FILE', `${relPath} is not a file`);

  const mime = lookup(IMAGE_MIME, extname(file).toLowerCase());
  if (mime !== null) {
    // `truncated` doubles as "there is more here than we are willing to send" — base64 inflates by
    // 4/3, so an 11 MB image would cross the IPC channel as ~15 MB of string.
    if (st.size > MAX_IMAGE_BYTES) return { content: '', language: null, truncated: true, binary: true, size: st.size, image: null };
    return { content: '', language: null, truncated: false, binary: true, size: st.size, image: `data:${mime};base64,${readFileSync(file).toString('base64')}` };
  }

  const overLimit = st.size > MAX_TEXT_BYTES;
  const buf = overLimit ? readHead(file, MAX_TEXT_BYTES) : readFileSync(file);
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    // Not `truncated`: the viewer shows "Binary file (N KB)" and there is no text to have truncated.
    return { content: '', language: null, truncated: false, binary: true, size: st.size, image: null };
  }
  // Cutting at a byte offset can split a multi-byte sequence, so a truncated file may end in one
  // U+FFFD. Left as-is: trimming the tail would make `content.length` depend on the file's encoding,
  // and the banner already tells the reader this is not the whole file.
  return { content: buf.toString('utf8'), language: languageFor(file), truncated: overLimit, binary: false, size: st.size, image: null };
}
