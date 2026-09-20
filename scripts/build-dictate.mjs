#!/usr/bin/env node
// Builds mac/dictate/main.swift into resources/bin/hangar-dictate (spec §4, "The helper").
//
// A machine with no Swift toolchain SKIPS with a message rather than failing. Whether a build may go
// on without the helper is decided in one place, `scripts/package.mjs`'s check 3, and it may not:
// `npm run app` refuses to package a Hangar with no dictation in it. So this script only says why
// there is no helper, and the packaging check is what stops the bundle.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dictateBinaryPath,
  dictateSourcePath,
  noSourceMessage,
  noToolchainMessage,
  swiftcArgs,
  tempBinaryPath,
} from './build-dictate.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const source = dictateSourcePath(root);
const binary = dictateBinaryPath(root);
const env = { ...process.env };
// G1: Claude Code's Bash sets this, and it makes every Electron-adjacent tool behave oddly. xcrun
// does not care, but every script in this directory strips it for the same reason.
delete env.ELECTRON_RUN_AS_NODE;

if (!existsSync(source)) {
  console.error(noSourceMessage(source));
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error(noToolchainMessage(`this is ${process.platform}, and swiftc with the Speech framework is macOS-only`));
  process.exit(0);
}

const found = spawnSync('xcrun', ['--find', 'swiftc'], { env, encoding: 'utf8' });
if (found.error || found.status !== 0) {
  const reason = found.error
    ? `could not run xcrun (${found.error.code ?? found.error.message})`
    : `xcrun --find swiftc failed: ${(found.stderr ?? '').trim() || `exit ${found.status}`}`;
  console.error(noToolchainMessage(reason));
  process.exit(0);
}

// Compile to a sibling temp path and rename on success, so a failed or interrupted build can never
// leave a truncated binary where a working one is expected.
const temp = tempBinaryPath(binary, process.pid);
mkdirSync(dirname(binary), { recursive: true });
// A build killed outright (Ctrl-C reaches node as well as swiftc) cannot clean up after itself, and
// resources/bin is copied into the bundle wholesale — so the next build sweeps any leftover.
const stale = basename(tempBinaryPath(binary, ''));
for (const name of readdirSync(dirname(binary))) {
  if (name.startsWith(stale)) rmSync(join(dirname(binary), name), { force: true });
}

const compiled = spawnSync('xcrun', swiftcArgs(source, temp), { cwd: root, env, stdio: 'inherit' });
if (compiled.error || compiled.status !== 0) {
  rmSync(temp, { force: true });
  console.error(`\n[build-dictate] swiftc failed; ${binary} is unchanged.\n`);
  process.exit(compiled.status ?? 1);
}

renameSync(temp, binary);
chmodSync(binary, 0o755);
console.log(`[build-dictate] built ${binary}`);
