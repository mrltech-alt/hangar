import { closeSync, ftruncateSync, mkdirSync, openSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepo, testGitEnv } from '../../../test/fixtures/git-repo.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { exec, type Exec } from '../util/exec.ts';
import { FsBrowseError, MAX_TEXT_BYTES, PathJailError, jailPath, languageFor, listDir, readFileForViewer } from './fs-browse.ts';

/**
 * A real repo with a real `.gitignore`, real symlinks and real binary bytes. Nothing here is
 * mocked: `listDir` shells out to the actual `git check-ignore`, so the ignore column is the one
 * git would produce, and the symlink cases exercise the kernel's resolution rather than a stub's.
 *
 * NOTE: the `.gitignore` is written by `createRepo` and therefore already committed by its
 * `git add -A` / `git commit`. Adding and committing it a second time here (as an earlier draft
 * of this fixture did) aborts the whole suite: with nothing staged, `git commit` exits 1 and
 * `git()` uses `execFileSync`, which throws on non-zero.
 */
function repo(): string {
  const dir = createRepo({
    files: { 'README.md': '# hi', 'src/index.ts': 'export const x = 1;\n', 'src/util/a.ts': '', '.gitignore': 'node_modules\n*.log\n' },
  });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(dir, 'debug.log'), 'log');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(dir, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  // Points outside the jail. `/etc` realpaths to `/private/etc` on macOS, so the jail check must
  // compare against the ROOT's realpath rather than expecting any particular target string.
  symlinkSync('/etc', join(dir, 'escape'));
  return dir;
}

describe('jailPath', () => {
  it('resolves inside the root and rejects traversal and absolute paths', () => {
    const root = repo();
    expect(jailPath(root, 'src/index.ts').endsWith('/src/index.ts')).toBe(true);
    expect(jailPath(root, '')).toBe(jailPath(root, '.'));
    expect(() => jailPath(root, '../x')).toThrow(PathJailError);
    expect(() => jailPath(root, 'src/../../x')).toThrow(PathJailError);
    expect(() => jailPath(root, '/etc/passwd')).toThrow(PathJailError);
  });

  it('rejects a real symlink that escapes the jail, whether or not the leaf exists', () => {
    const root = repo();
    // `escape` -> /etc. Both the link itself and anything under it are refused.
    expect(() => jailPath(root, 'escape')).toThrow(PathJailError);
    expect(() => jailPath(root, 'escape/passwd')).toThrow(PathJailError);
    // The one the lexical check and a leaf-only `existsSync` guard both miss: the leaf does NOT
    // exist, so `existsSync('<root>/escape/newfile')` is false and a guard written as
    // `existsSync(t) && !inside(realpathSync(t))` skips the physical check entirely, returning a
    // path that physically resolves to /private/etc/newfile. Measured on macOS 25.6 / Node 22.
    expect(() => jailPath(root, 'escape/newfile')).toThrow(PathJailError);
    // …and one more level down, where even the parent directory is missing.
    expect(() => jailPath(root, 'escape/deeper/still')).toThrow(PathJailError);
  });

  it('rejects a `..` spelling even when it loops back inside the jail', () => {
    // The physical check alone would ACCEPT this: `<base>/sibling` is a symlink to the root, so
    // `../sibling/README.md` realpaths to `<root>/README.md`, which is inside. Measured. Only the
    // lexical check rejects it, and it should — `shared/ipc-schemas.ts` bans `..` on the wire
    // outright, so a request spelled this way is not a browse, it is someone probing the jail.
    // Without this case the lexical check is unreachable decoration.
    const base = tempDir('fsbrowse-lex');
    mkdirSync(join(base, 'root'));
    writeFileSync(join(base, 'root', 'README.md'), 'x');
    symlinkSync(join(base, 'root'), join(base, 'sibling'));
    expect(() => jailPath(join(base, 'root'), '../sibling/README.md')).toThrow(PathJailError);
  });

  it('allows a symlink that stays inside the jail and returns its resolved target', () => {
    const root = repo();
    symlinkSync('src', join(root, 'inner'));
    expect(jailPath(root, 'inner/index.ts')).toBe(jailPath(root, 'src/index.ts'));
  });

  it('allows a path that does not exist yet, so callers can fail with NOT_FOUND rather than EACCES', () => {
    const root = repo();
    expect(jailPath(root, 'nope.txt').endsWith('/nope.txt')).toBe(true);
  });
});

describe('listDir', () => {
  it('lists dirs first, ignored last, marks ignored entries, hides .git, keeps symlinks unfollowed', async () => {
    const root = repo();
    const entries = await listDir(root, '', exec, testGitEnv(root));
    // Dirs before files; within each kind non-ignored before ignored; then case-INSENSITIVE name.
    // `README.md` therefore sorts after `pic.png` (r > p once case is folded), which is the
    // opposite of the plain ASCII order an earlier expectation assumed. Spec §12.5 asks for
    // case-insensitive, and `'README.md'.localeCompare('pic.png', undefined, {sensitivity:'base'})`
    // is 1 — measured.
    expect(entries.map((e) => e.name)).toEqual(['src', 'node_modules', '.gitignore', 'bin.dat', 'escape', 'pic.png', 'README.md', 'debug.log']);
    expect(entries.find((e) => e.name === 'node_modules')).toMatchObject({ kind: 'dir', ignored: true });
    expect(entries.find((e) => e.name === 'debug.log')).toMatchObject({ kind: 'file', ignored: true, size: 3 });
    expect(entries.find((e) => e.name === 'escape')).toMatchObject({ kind: 'symlink', ignored: false, size: null });
    expect(entries.some((e) => e.name === '.git')).toBe(false);

    const sub = await listDir(root, 'src', exec, testGitEnv(root));
    expect(sub.map((e) => e.name)).toEqual(['util', 'index.ts']);
  });

  it('resolves ignore patterns relative to the listed subdirectory, not the repo root', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'inner.log'), 'x');
    const sub = await listDir(root, 'src', exec, testGitEnv(root));
    expect(sub.find((e) => e.name === 'inner.log')).toMatchObject({ ignored: true });
  });

  it('does not report a tracked file as ignored even when a pattern matches it', async () => {
    const root = repo();
    // `*.log` matches, but the file is in the index. `git check-ignore` consults the index unless
    // `--no-index` is passed, so it reports this as NOT ignored — which is what the tree should
    // show. Verified against git 2.50.1: force-adding `tracked.log` drops it from the output.
    writeFileSync(join(root, 'tracked.log'), 'x');
    await exec('git', ['add', '-f', 'tracked.log'], { cwd: root, env: testGitEnv(root) });
    const entries = await listDir(root, '', exec, testGitEnv(root));
    expect(entries.find((e) => e.name === 'tracked.log')).toMatchObject({ ignored: false });
    expect(entries.find((e) => e.name === 'debug.log')).toMatchObject({ ignored: true });
  });

  it('handles a filename that looks like a git option', async () => {
    const root = repo();
    // Names never reach git's argv — they go down stdin, and `git check-ignore --stdin` treats each
    // record as a pathspec, not an option. Measured: a file called `-weird.log` is reported ignored
    // (exit 0, output `-weird.log`) rather than parsed as a flag. This test is what stops a future
    // refactor from moving names onto the command line.
    writeFileSync(join(root, '-weird.log'), 'x');
    writeFileSync(join(root, '-plain.txt'), 'x');
    const entries = await listDir(root, '', exec, testGitEnv(root));
    expect(entries.find((e) => e.name === '-weird.log')).toMatchObject({ ignored: true });
    expect(entries.find((e) => e.name === '-plain.txt')).toMatchObject({ ignored: false });
  });

  it('passes no caller-controlled value in git argv', async () => {
    const root = repo();
    const seen: { file: string; args: string[] }[] = [];
    const spy: Exec = async (file, args, opts) => {
      seen.push({ file, args });
      return exec(file, args, opts);
    };
    await listDir(root, 'src', spy, testGitEnv(root));
    expect(seen).toEqual([{ file: 'git', args: ['check-ignore', '--stdin', '-z'] }]);
  });

  it('degrades to "nothing ignored" when git cannot answer, instead of failing the whole listing', async () => {
    const plain = tempDir('fsbrowse-nonrepo');
    writeFileSync(join(plain, 'a.txt'), 'x');
    // Two distinct failure modes reach the same place: exit 1 (repo, nothing matched) and exit 128
    // (`fatal: not a git repository`). A worktree whose `.git` link is broken hits the second one,
    // and the file tree must still render — a dimming hint is not worth an unusable drawer.
    const entries = await listDir(plain, '', exec, testGitEnv(plain));
    expect(entries).toEqual([{ name: 'a.txt', kind: 'file', ignored: false, size: 1 }]);
  });

  it('returns an empty list without spawning git for an empty directory', async () => {
    const root = repo();
    mkdirSync(join(root, 'empty'));
    let calls = 0;
    const spy: Exec = async (file, args, opts) => {
      calls += 1;
      return exec(file, args, opts);
    };
    expect(await listDir(root, 'empty', spy, testGitEnv(root))).toEqual([]);
    expect(calls).toBe(0);
  });

  it('refuses a path outside the jail and reports missing or non-directory paths', async () => {
    const root = repo();
    await expect(listDir(root, '../..', exec, testGitEnv(root))).rejects.toThrow(PathJailError);
    await expect(listDir(root, 'escape', exec, testGitEnv(root))).rejects.toThrow(PathJailError);
    await expect(listDir(root, 'README.md', exec, testGitEnv(root))).rejects.toThrow(/not a directory/i);
    await expect(listDir(root, 'ghost', exec, testGitEnv(root))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('readFileForViewer', () => {
  it('returns text with language, detects binary, returns images as data URLs', () => {
    const root = repo();
    expect(readFileForViewer(root, 'src/index.ts')).toMatchObject({
      content: 'export const x = 1;\n',
      language: 'typescript',
      binary: false,
      truncated: false,
      image: null,
      size: 20,
    });
    expect(readFileForViewer(root, 'bin.dat')).toMatchObject({ binary: true, content: '', image: null, language: null });
    const png = readFileForViewer(root, 'pic.png');
    expect(png.image?.startsWith('data:image/png;base64,')).toBe(true);
    expect(png).toMatchObject({ binary: true, content: '', size: 8 });
    expect(() => readFileForViewer(root, 'src')).toThrow(/not a file/i);
    expect(() => readFileForViewer(root, '../etc/hosts')).toThrow(PathJailError);
    expect(() => readFileForViewer(root, 'escape/hosts')).toThrow(PathJailError);
    expect(() => readFileForViewer(root, 'ghost.txt')).toThrow(FsBrowseError);
    expect(() => readFileForViewer(root, 'ghost.txt')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('truncates large text files', () => {
    const root = repo();
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
    const big = readFileForViewer(root, 'big.txt');
    expect(big.truncated).toBe(true);
    expect(big.content.length).toBe(1.5 * 1024 * 1024);
    expect(big.size).toBe(2 * 1024 * 1024);
    expect(big.binary).toBe(false);
  });

  it('does not read the whole of a huge binary file just to classify it', () => {
    const root = repo();
    // 3 MB with a NUL in the first 8 KB. `truncated` stays false: the viewer shows
    // "Binary file (N KB)", and a truncation banner on top of that would be noise.
    const buf = Buffer.alloc(3 * 1024 * 1024, 0x41);
    buf[10] = 0;
    writeFileSync(join(root, 'huge.bin'), buf);
    expect(readFileForViewer(root, 'huge.bin')).toMatchObject({ binary: true, truncated: false, content: '', size: 3 * 1024 * 1024 });
  });

  it('serves the head of a file too large for readFileSync to open at all', () => {
    const root = repo();
    // `readFileSync` refuses anything over 2 GiB outright: measured on Node 22,
    // `ERR_FS_FILE_TOO_LARGE: File size (2684354560) is greater than 2 GiB`. An agent that lets a
    // log or a capture run away produces exactly this, and reading the whole file "and then
    // slicing" would throw before the slice — the drawer would break on the one file the user most
    // wants to look at. `readHead` opens a descriptor and reads 1.5 MB instead.
    //
    // The file is SPARSE, so this costs no disk space: `ftruncateSync` past the written head
    // allocates nothing on APFS (`du -h` reports 0B for the 2.5 GB file — measured). The first
    // 16 KB are written for real so the binary sniff, which only looks at the first 8 KB, sees text.
    const big = join(root, 'runaway.log');
    const fd = openSync(big, 'w');
    try {
      writeSync(fd, Buffer.alloc(16 * 1024, 0x78));
      ftruncateSync(fd, 2.5 * 1024 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    const out = readFileForViewer(root, 'runaway.log');
    expect(out).toMatchObject({ binary: false, truncated: true, size: 2.5 * 1024 * 1024 * 1024 });
    expect(out.content.length).toBe(MAX_TEXT_BYTES);
  });

  it('refuses an oversized image rather than base64-ing it onto the IPC channel', () => {
    const root = repo();
    writeFileSync(join(root, 'huge.png'), Buffer.alloc(11 * 1024 * 1024, 0x41));
    expect(readFileForViewer(root, 'huge.png')).toMatchObject({ binary: true, truncated: true, image: null, content: '' });
  });

  it('reads an empty file as empty text, not as binary', () => {
    const root = repo();
    expect(readFileForViewer(root, 'src/util/a.ts')).toMatchObject({ content: '', binary: false, size: 0, language: 'typescript' });
  });
});

describe('languageFor', () => {
  it('maps common extensions and special filenames', () => {
    expect(languageFor('a.tsx')).toBe('tsx');
    expect(languageFor('src/deep/a.TS')).toBe('typescript');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('x.unknownext')).toBeNull();
    expect(languageFor('noextension')).toBeNull();
  });

  it('does not return inherited Object properties for files named after them', () => {
    // A plain object literal answers `map['constructor']` with a FUNCTION, and every truthiness
    // check downstream passes it along as though it were a language name. Files called
    // `constructor`, `toString` or `valueOf` are unusual but entirely legal.
    expect(languageFor('constructor')).toBeNull();
    expect(languageFor('toString')).toBeNull();
    expect(languageFor('x.valueOf')).toBeNull();
  });
});
