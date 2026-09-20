// Pure helpers for `scripts/package.mjs`. They exist as a separate, tested module because the
// checks they back are the only things standing between a green `electron-builder` run and a
// packaged app that throws MODULE_NOT_FOUND the first time it is opened — or, for the dictation
// helper, a packaged app whose mic button can only ever say `Dictation is not built.` Both are
// failures the build itself cannot see, because nothing in the build ever runs what it just copied.
import { builtinModules } from 'node:module';
import { dirname } from 'node:path';
import { DICTATE_BINARY } from './build-dictate.ts';

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** `electron` and `electron/*` are provided by the runtime, not by node_modules. */
function isProvidedByElectron(specifier: string): boolean {
  return specifier === 'electron' || specifier.startsWith('electron/');
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * Does this look like something npm could have installed?
 *
 * `bareImports` scans comments as well as code, and the first run of it against this tree pulled
 * `resolved, but no helper found` and `the app has not been started` out of two doc comments that
 * happened to contain the word `from` before a quoted phrase. Rejecting anything with whitespace,
 * a comma or a newline drops that class of prose while keeping the scan deliberately broad.
 */
const PACKAGE_SPECIFIER = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * `@scope/name/deep/path` → `@scope/name`; `name/deep/path` → `name`. This is the directory
 * electron-builder has to have copied, which is never the full specifier.
 */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Package names a built CommonJS bundle will look up in `node_modules` at run time.
 *
 * The packaged Electron side ships **no** `node_modules` at all (see `electron-builder.yml`), so
 * this must be empty for `out/main/index.js` and `out/preload/index.js`. It is not empty by
 * default: `electron-vite` externalises every entry in `dependencies` unless
 * `build.externalizeDeps` is false, and `require("zod")` was in fact present in `out/main/index.js`
 * before that flag was set.
 */
export function externalRequires(bundle: string): string[] {
  const found = new Set<string>();
  for (const m of bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (isRelative(spec) || BUILTIN.has(spec) || isProvidedByElectron(spec) || !PACKAGE_SPECIFIER.test(spec)) continue;
    found.add(packageNameOf(spec));
  }
  return [...found].sort();
}

/**
 * Package names a type-stripped `.ts` source needs from `node_modules`.
 *
 * Deliberately over-inclusive: it reads `from '…'` and bare `import '…'` wherever they appear,
 * comments included. A false positive fails the packaging build with a name to look at; a false
 * negative ships an app whose host cannot start.
 */
export function bareImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (isRelative(spec) || BUILTIN.has(spec) || !PACKAGE_SPECIFIER.test(spec)) continue;
      found.add(packageNameOf(spec));
    }
  }
  return [...found].sort();
}

/**
 * The `node_modules/<pkg>` trees `electron-builder.yml` copies into `Contents/Resources/app`.
 *
 * Read out of the YAML as text rather than parsed: the only YAML parser on hand is a transitive
 * dependency of electron-builder, and pinning a parser (CLAUDE.md rule 6) to read six lines is a
 * worse trade than a regex anchored to `from:`.
 */
export function packagedModules(builderYml: string): string[] {
  const found = new Set<string>();
  for (const m of builderYml.matchAll(/^\s*(?:-\s*)?from:\s*['"]?node_modules\/([^'"\s},]+)/gm)) {
    found.add(packageNameOf(m[1]));
  }
  return [...found].sort();
}

/** Bare imports of the Node-side sources that `electron-builder.yml` would not carry. */
export function missingPackagedModules(sources: string[], builderYml: string): string[] {
  const carried = new Set(packagedModules(builderYml));
  const needed = new Set<string>();
  for (const src of sources) for (const pkg of bareImports(src)) if (!carried.has(pkg)) needed.add(pkg);
  return [...needed].sort();
}

// ─── The dictation helper (Plan 09) ─────────────────────────────────────────────────────────────

/**
 * `Contents/Resources/<this>` is the packaged app's `repoRoot` — `src/main/index.ts` sets
 * `repoRoot = join(process.resourcesPath, 'app')` when `app.isPackaged`. Every Node-side tree is
 * copied under it, and so is the helper, which is what lets main use ONE relative path for both.
 */
export const PACKAGED_APP_DIR = 'app';

/**
 * Where `electron-builder.yml` copies the directory `from` to, relative to `Contents/Resources`, or
 * null when no `extraResources` entry copies it. Read as text for the reason `packagedModules` is: a
 * `- from:` line and the `to:` that follows it within the same list item.
 */
export function extraResourceDestination(builderYml: string, from: string): string | null {
  const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const lines = builderYml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const item = /^\s*-\s*from:\s*(.+?)\s*$/.exec(lines[i]);
    if (item === null || unquote(item[1]) !== from) continue;
    // The item's other keys are indented deeper than its `-`; the first line that is not ends it.
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]) && !/^\s*-\s/.test(lines[j]); j++) {
      const to = /^\s*to:\s*(.+?)\s*$/.exec(lines[j]);
      if (to !== null) return unquote(to[1]);
    }
    return null;
  }
  return null;
}

/** What `package.mjs` knows about `resources/bin/hangar-dictate` in the checkout — `statSync`, reduced. */
export interface HelperProbe {
  exists: boolean;
  /** False for a directory (or anything else) sitting where the binary should be. */
  isFile?: boolean;
  /** `st_mode`; only its permission bits are read. */
  mode?: number;
}

/**
 * Why `npm run app` would produce a Hangar with no dictation in it, or `[]` if it would not.
 *
 * `scripts/build-dictate.mjs` deliberately exits 0 when there is no Swift toolchain, so that is not
 * what stops a dictation-less bundle — THIS is, run before electron-builder the way
 * `missingPackagedModules` is, and failing the build the same way. Two halves, because either alone
 * ships the same broken app: the binary must exist and be executable, and `electron-builder.yml`
 * must carry `resources/bin` to `app/resources/bin`, which is the one place main looks
 * (`join(repoRoot, 'resources/bin/hangar-dictate')`). `buildResources: resources` does NOT carry it:
 * that directory is build INPUT (the icon), and electron-builder copies none of it into the app.
 */
export function dictateHelperProblems(builderYml: string, helper: HelperProbe): string[] {
  const problems: string[] = [];
  const dir = dirname(DICTATE_BINARY);
  const want = `${PACKAGED_APP_DIR}/${dir}`;
  const got = extraResourceDestination(builderYml, dir);
  if (got !== want) {
    problems.push(
      `electron-builder.yml copies ${dir} ${got === null ? 'nowhere' : `to ${got}`}; it must go to ${want}, ` +
        `where the packaged app looks for Contents/Resources/${PACKAGED_APP_DIR}/${DICTATE_BINARY}.`,
    );
  }
  if (!helper.exists) {
    problems.push(
      `${DICTATE_BINARY} has not been built, so the app would ship with no dictation and every press of the mic ` +
        `button would say "Dictation is not built." It needs Apple's Swift compiler: run xcode-select --install ` +
        `if build-dictate said there was no toolchain, then npm run build:dictate (or npm run app again).`,
    );
  } else if (helper.isFile === false) {
    problems.push(`${DICTATE_BINARY} is not a file. Delete it and run npm run build:dictate.`);
  } else if (helper.mode !== undefined && (helper.mode & 0o111) === 0) {
    problems.push(
      `${DICTATE_BINARY} is not executable (mode ${(helper.mode & 0o777).toString(8).padStart(3, '0')}), so the ` +
        `packaged app could not spawn it. Run npm run build:dictate, which sets 0755.`,
    );
  }
  return problems;
}
