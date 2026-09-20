import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTATE_BINARY } from './build-dictate.ts';
import {
  PACKAGED_APP_DIR, bareImports, dictateHelperProblems, externalRequires, extraResourceDestination, missingPackagedModules, packageNameOf,
  packagedModules,
} from './packaging.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

/** Every `.ts` the packaged app carries under Contents/Resources/app — tests excluded, as the yml excludes them. */
function nodeSideSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['host', 'cli', 'shared']) walk(join(root, d));
  return out;
}

describe('packageNameOf', () => {
  it('keeps both segments of a scoped package and drops deep paths', () => {
    expect(packageNameOf('@xterm/headless')).toBe('@xterm/headless');
    expect(packageNameOf('@codemirror/view/dist/index.js')).toBe('@codemirror/view');
    expect(packageNameOf('zod/v4')).toBe('zod');
  });
});

describe('externalRequires', () => {
  it('ignores electron and node builtins', () => {
    expect(externalRequires('require("electron");require("node:fs");require("fs");require("electron/common")')).toEqual([]);
  });

  it('ignores relative requires', () => {
    expect(externalRequires('require("./chunk.js");require("../x")')).toEqual([]);
  });

  it('reports a package the bundle would look up in node_modules', () => {
    // The real regression: this is what `out/main/index.js` contained until
    // `externalizeDeps: false` was set, and the packaged app ships no node_modules.
    expect(externalRequires('const z=require("zod");const h=require("@xterm/headless/lib/x.js")')).toEqual(['@xterm/headless', 'zod']);
  });
});

describe('bareImports', () => {
  it('extracts bare specifiers and ignores relative .ts imports and builtins', () => {
    const src = [
      "import { join } from 'node:path';",
      "import pty from 'node-pty';",
      "import { z } from 'zod';",
      "import type { A } from './a.ts';",
      "import '@xterm/addon-serialize';",
      "const m = await import('@xterm/headless');",
    ].join('\n');
    expect(bareImports(src)).toEqual(['@xterm/addon-serialize', '@xterm/headless', 'node-pty', 'zod']);
  });

  // Both of these are real doc-comment prose from host/pty-fix.ts and cli/commands/host.ts; the
  // first version of this scan reported them as missing packages and failed the build.
  it('does not mistake quoted prose after the word "from" for a package', () => {
    const src = [
      "/** distinct from \"resolved, but no helper found\". */",
      "// different from 'the app has not been started'",
    ].join('\n');
    expect(bareImports(src)).toEqual([]);
  });
});

describe('electron-builder.yml', () => {
  // Removing this line makes electron-builder rebuild node-pty against ELECTRON's ABI (149). The
  // host runs under the system Node (137) and would die on its first PTY (G2). Nothing else in the
  // repo would notice: the build still succeeds and the window still opens.
  it('keeps npmRebuild off so node-pty is never rebuilt for Electron', () => {
    expect(builderYml).toMatch(/^npmRebuild:\s*false\s*$/m);
  });

  // The sibling trap, and the one that had no guard until Task 9. `files` reads like "just the
  // bundles", but electron-builder matches node_modules on a SEPARATE code path and copies the
  // whole production dependency tree unless a `!` pattern in `files` stops it (G69). Deleting this
  // one line takes the asar from 4.2 MB to 59 MB and puts `node-pty` — a native module built for
  // the SYSTEM Node's ABI (G2) — back on the Electron side, which CLAUDE.md rule 3 forbids.
  // Measured in Task 8; nothing else notices, because the build still succeeds and the window
  // still opens.
  it('keeps node_modules out of the asar, so the Electron side ships none', () => {
    // Either quote style, any indent, anywhere in `files` — YAML needs the quotes (a bare
    // `- !node_modules/**` is a tag, not a string), but which ones is not the point being guarded.
    expect(builderYml).toMatch(/^\s*-\s*['"]!node_modules\/\*\*['"]\s*$/m);
  });
});

describe('packagedModules', () => {
  it('reads the node_modules trees out of the real electron-builder.yml', () => {
    expect(packagedModules(builderYml)).toEqual(['@xterm/addon-serialize', '@xterm/headless', 'node-addon-api', 'node-pty', 'zod']);
  });

  it('ignores extraResources that are not node_modules', () => {
    expect(packagedModules('extraResources:\n  - from: host\n    to: app/host\n')).toEqual([]);
  });
});

describe('missingPackagedModules', () => {
  it('names a package the host imports that the app would not carry', () => {
    expect(missingPackagedModules(["import x from 'left-pad';"], builderYml)).toEqual(['left-pad']);
  });

  // THE guard. Adding a bare import anywhere under host/, cli/ or shared/ without adding the
  // package to electron-builder.yml ships an app whose session host dies with MODULE_NOT_FOUND on
  // first launch, and nothing else in the suite, the typecheck or the build notices.
  it('every bare import in host/, cli/ and shared/ is carried into the packaged app', () => {
    const sources = nodeSideSources();
    expect(sources.length).toBeGreaterThan(30);
    expect(missingPackagedModules(sources.map((s) => s.text), builderYml)).toEqual([]);
  });
});

describe('extraResourceDestination', () => {
  it('reads where the real electron-builder.yml copies each tree', () => {
    expect(extraResourceDestination(builderYml, 'host')).toBe('app/host');
    expect(extraResourceDestination(builderYml, 'resources/bin')).toBe('app/resources/bin');
    expect(extraResourceDestination(builderYml, 'node_modules/zod')).toBe('app/node_modules/zod');
  });

  it('is null for a tree nothing copies', () => {
    expect(extraResourceDestination(builderYml, 'mac')).toBeNull();
  });

  it('takes the `to:` of the SAME list item, quoted or not, and never the next item\'s', () => {
    const yml = [
      'extraResources:',
      "  - from: 'resources/bin'",
      "    filter: ['hangar-dictate']",
      '    to: "app/resources/bin"',
      '  - from: host',
      '    to: app/host',
    ].join('\n');
    expect(extraResourceDestination(yml, 'resources/bin')).toBe('app/resources/bin');
    // An item with no `to:` of its own must not borrow the following item's.
    expect(extraResourceDestination('extraResources:\n  - from: resources/bin\n  - from: host\n    to: app/host\n', 'resources/bin')).toBeNull();
  });
});

// Plan 09. `build-dictate` exits 0 when there is no Swift toolchain, so a checkout without one runs
// `npm run app` to the end — and without THIS check, ships a Hangar whose mic button can only ever
// say "Dictation is not built." The same shape as the bare-import guard above: nothing else in the
// suite, the typecheck or the build would notice.
describe('dictateHelperProblems', () => {
  const built = { exists: true, isFile: true, mode: 0o100755 };

  it('a built, executable helper and the real electron-builder.yml pass', () => {
    expect(dictateHelperProblems(builderYml, built)).toEqual([]);
  });

  it('a build with no helper binary fails, naming the binary and the commands that build it', () => {
    const problems = dictateHelperProblems(builderYml, { exists: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(DICTATE_BINARY);
    expect(problems[0]).toContain('npm run build:dictate');
    expect(problems[0]).toContain('xcode-select --install');
  });

  it('a helper that is not executable fails, and says the mode it found', () => {
    const problems = dictateHelperProblems(builderYml, { exists: true, isFile: true, mode: 0o100644 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not executable (mode 644)');
  });

  it('a directory where the helper should be fails', () => {
    expect(dictateHelperProblems(builderYml, { exists: true, isFile: false, mode: 0o40755 })).toEqual([
      `${DICTATE_BINARY} is not a file. Delete it and run npm run build:dictate.`,
    ]);
  });

  // The other half: a helper built but not carried is a helper missing from the app all the same.
  it('fails with the helper built when electron-builder.yml does not carry resources/bin', () => {
    const withoutEntry = builderYml.replace(/^ {2}- from: resources\/bin\n {4}to: app\/resources\/bin\n/m, '');
    expect(withoutEntry).not.toBe(builderYml);
    expect(dictateHelperProblems(withoutEntry, built)).toEqual([
      expect.stringContaining('copies resources/bin nowhere; it must go to app/resources/bin'),
    ]);
  });

  it('fails when resources/bin is carried somewhere main does not look', () => {
    const elsewhere = builderYml.replace('to: app/resources/bin', 'to: bin');
    expect(dictateHelperProblems(elsewhere, built)).toEqual([expect.stringContaining('copies resources/bin to bin; it must go to app/resources/bin')]);
  });

  it('reports both halves at once, so one build names everything that is wrong', () => {
    const withoutEntry = builderYml.replace('to: app/resources/bin', 'to: elsewhere');
    expect(dictateHelperProblems(withoutEntry, { exists: false })).toHaveLength(2);
  });
});

describe('the dictation helper in the packaged app', () => {
  // THE path. Main resolves the helper as `join(repoRoot, 'resources/bin/hangar-dictate')` in both a
  // checkout and the packaged app, where `repoRoot` is Contents/Resources/app. That only works while
  // the yml's destination is `app/` + the checkout's own relative directory — so the two are pinned
  // against each other, and against the line in index.ts that reads it.
  it('lands at Contents/Resources/app/resources/bin/hangar-dictate, where main looks for it', () => {
    const dest = extraResourceDestination(builderYml, 'resources/bin');
    expect(`${dest}/hangar-dictate`).toBe(`${PACKAGED_APP_DIR}/${DICTATE_BINARY}`);
    const index = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8');
    expect(index).toMatch(/const repoRoot = app\.isPackaged \? join\(process\.resourcesPath, 'app'\) :/);
    expect(index).toContain(`helperPath: join(repoRoot, '${DICTATE_BINARY}')`);
  });

  it('ships only the binary, never a .building-* leftover from an interrupted compile', () => {
    expect(builderYml).toMatch(/^ {2}- from: resources\/bin\n {4}to: app\/resources\/bin\n {4}filter: \['hangar-dictate'\]$/m);
  });

  it('npm run app checks the helper before electron-builder packages, as it checks bare imports', () => {
    const script = readFileSync(join(root, 'scripts', 'package.mjs'), 'utf8');
    const check = script.indexOf('dictateHelperProblems(');
    const builder = script.indexOf("'node_modules/.bin/electron-builder'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(builder);
  });
});

describe('Info.plist', () => {
  // What the macOS permission prompts say. Electron's own plist carries "This app needs access to the
  // microphone", which tells the owner nothing about when Hangar listens.
  it('says what the microphone is for, in Hangar\'s words', () => {
    expect(builderYml).toMatch(/^ {2}extendInfo:$/m);
    expect(builderYml).toMatch(/^ {4}NSMicrophoneUsageDescription: Hangar listens only while you dictate into a pane\.$/m);
  });

  it('says what speech recognition is for', () => {
    expect(builderYml).toMatch(/^ {4}NSSpeechRecognitionUsageDescription: Hangar .+ on this Mac.*$/m);
  });
});
