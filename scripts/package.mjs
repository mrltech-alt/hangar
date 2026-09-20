#!/usr/bin/env node
// Builds dist/mac-arm64/Hangar.app for local use (spec §20, Phase 3), and signs it (Plan 09).
//
// The dictation helper is compiled first (`scripts/build-dictate.mjs`), because electron-builder
// copies resources/bin as it finds it and the helper has to be there by then; it goes first rather
// than just before electron-builder so a Swift error fails the build before the bundle is spent on.
//
// Three assertions run between the bundle and the package, because every one of these failures is
// invisible to electron-builder and only shows up when the app is opened:
//   1. the Electron side must require nothing from node_modules — the app ships none;
//   2. every bare import in host/, cli/ and shared/ must be carried into Contents/Resources/app;
//   3. the dictation helper must exist, be executable, and be carried there too — build-dictate
//      exits 0 when there is no Swift toolchain, so this is what stops a dictation-less app.
//
// Last, `scripts/sign.mjs` signs the bundle with a stable identity, so a microphone grant survives
// the next install. A missing identity is a warning there, not a failure.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHelperCandidates } from '../host/pty-fix.ts';
import { DICTATE_BINARY } from './build-dictate.ts';
import { dictateHelperProblems, externalRequires, missingPackagedModules } from './packaging.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const env = { ...process.env };
// G1: Claude Code's Bash sets this, and it makes every Electron tool run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const die = (msg) => {
  console.error(`\n[package] ${msg}\n`);
  process.exit(1);
};

run(process.execPath, [join(root, 'scripts', 'build-dictate.mjs')]);
run(join(root, 'node_modules/.bin/electron-vite'), ['build']);

// 1. The packaged asar carries out/** and package.json only.
for (const rel of ['out/main/index.js', 'out/preload/index.js']) {
  const external = externalRequires(readFileSync(join(root, rel), 'utf8'));
  if (external.length > 0) {
    die(`${rel} requires ${external.join(', ')} from node_modules, which the packaged app does not ship.\n` +
      `Either let electron-vite bundle it (electron.vite.config.ts sets externalizeDeps: false) or add it to electron-builder.yml's files.`);
  }
}

// 2. The Node half runs as source from Contents/Resources/app under the system Node.
const sources = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) sources.push(readFileSync(p, 'utf8'));
  }
};
for (const d of ['host', 'cli', 'shared']) walk(join(root, d));
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const missing = missingPackagedModules(sources, builderYml);
if (missing.length > 0) {
  die(`host/, cli/ or shared/ imports ${missing.join(', ')}, which electron-builder.yml does not copy into Contents/Resources/app.\n` +
    `The session host would start and die with MODULE_NOT_FOUND. Add an extraResources entry for each.`);
}
console.log(`[package] checked ${sources.length} Node-side sources; no unshipped imports`);

// 3. The dictation helper. `statSync` follows a symlink, which is what the packaged copy would too.
const helperSrc = join(root, DICTATE_BINARY);
const helperStat = existsSync(helperSrc) ? statSync(helperSrc) : null;
const helperProblems = dictateHelperProblems(builderYml, {
  exists: helperStat !== null,
  isFile: helperStat?.isFile(),
  mode: helperStat?.mode,
});
if (helperProblems.length > 0) {
  die(`The packaged app would have no dictation:\n  ${helperProblems.join('\n  ')}`);
}
console.log(`[package] ${DICTATE_BINARY} is built and carried`);

run(join(root, 'node_modules/.bin/electron-builder'), ['--mac', 'dir']);

const app = join(root, 'dist', 'mac-arm64', 'Hangar.app');
const res = join(app, 'Contents', 'Resources', 'app');
// Check 3's other half: that electron-builder really put the helper where main looks for it
// (`join(repoRoot, DICTATE_BINARY)`). A changed `filter:` or `to:` would drop it without a word.
const helperInApp = join(res, DICTATE_BINARY);
if (!existsSync(helperInApp)) {
  die(`${helperInApp.slice(app.length + 1)} is not in the bundle, although ${DICTATE_BINARY} was built. Check the resources/bin entry in electron-builder.yml.`);
}
// Measured on electron-builder 26.16.1: extraResources are copied WITH their mode, so this repairs
// nothing today — `bin/hangar`, the dictation helper and `spawn-helper` all arrive 0755. It stays
// because these are the files that produce unreadable failures when a mode is lost (a shim that is
// not executable, a mic button that says `Dictation stopped unexpectedly.`, and G3's
// `posix_spawnp failed`), the chmod is idempotent, and any later copy step — a different
// electron-builder, a zip round-trip — could drop it silently.
// `spawnHelperCandidates`, not a hardcoded darwin-arm64 path: a hardcoded one no-ops on an x64 or
// universal build without saying so.
const repaired = [];
for (const p of [join(res, 'bin', 'hangar'), helperInApp, ...spawnHelperCandidates(join(res, 'node_modules', 'node-pty'))]) {
  if (!existsSync(p)) continue;
  chmodSync(p, 0o755);
  repaired.push(p.slice(app.length + 1));
}
console.log(`[package] chmod 0755: ${repaired.length > 0 ? repaired.join(', ') : 'nothing found'}`);

// Last, after every change to the bundle's contents: the signature seals them, and anything written
// into the bundle afterwards fails `codesign --verify`.
run(process.execPath, [join(root, 'scripts', 'sign.mjs'), app]);
console.log(`\nBuilt ${app}\nInstall: rm -rf /Applications/Hangar.app && cp -R "${app}" /Applications/`);
