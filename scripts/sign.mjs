#!/usr/bin/env node
// Signs dist/mac-arm64/Hangar.app with a stable identity (spec 2026-09-18 §5). Run by `npm run app`
// as its last step; `node scripts/sign.mjs [path/to/Hangar.app]` re-signs a bundle on its own.
//
// Why: electron-builder leaves the app ad-hoc signed, an ad-hoc signature changes on every build, and
// macOS ties a microphone grant to the signature — so without this, dictation asks for the microphone
// again after every install. With a self-signed certificate the grant survives.
//
//   1. resolve HANGAR_SIGN_IDENTITY (default `Hangar Local Signing`) to its SHA-1 — codesign is only
//      ever handed the hash (G93);
//   2. sign the dictation helper inside the bundle, THEN the bundle, which seals the helper's bytes;
//   3. verify: `codesign --verify --deep --strict` passes, and both the app and the helper name the
//      identity as their authority. Anything else fails the build loudly.
//
// Only the DEFAULT certificate being absent WARNS and exits 0, leaving the ad-hoc signature: a fresh
// checkout must still build. An explicit HANGAR_SIGN_IDENTITY that is not there, or a `security` that
// fails with anything but exit 44 (not found), fails the build (`identityVerdict`). No hardened
// runtime (`--options runtime`), deliberately. Every command is an argv array, never a shell string
// (CLAUDE.md rule 1).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTATE_BINARY } from './build-dictate.ts';
import { PACKAGED_APP_DIR } from './packaging.ts';
import {
  describeArgs,
  findCertificateArgs,
  identityVerdict,
  signAppArgs,
  signatureProblem,
  signHelperArgs,
  signIdentityChoice,
  verifyArgs,
} from './signing.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const app = resolve(process.argv[2] ?? join(root, 'dist', 'mac-arm64', 'Hangar.app'));
const helper = join(app, 'Contents', 'Resources', PACKAGED_APP_DIR, DICTATE_BINARY);
const env = { ...process.env };
// G1, as in every script here: nothing below is Electron, but nothing below needs it either.
delete env.ELECTRON_RUN_AS_NODE;

const die = (msg) => {
  console.error(`\n[sign] ${msg}\n`);
  process.exit(1);
};
const rel = (p) => (p.startsWith(`${app}/`) ? p.slice(app.length + 1) : p);

/** codesign, with its output captured for a failure message; dies on a non-zero exit. */
const codesign = (args, what) => {
  const r = spawnSync('codesign', args, { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    die(`${what} failed: codesign ${args.map(rel).join(' ')}\n${r.error ? r.error.message : out || `exit ${r.status}`}`);
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

if (!existsSync(app)) die(`${app} does not exist. Run npm run app.`);
if (!existsSync(helper)) die(`${rel(helper)} is not in the bundle. Run npm run app, which checks that it is.`);
if (process.platform !== 'darwin') {
  console.warn(`[sign] WARNING: this is ${process.platform}; codesign is macOS-only, so ${app} is left as built.`);
  process.exit(0);
}

const choice = signIdentityChoice(env);
const { name } = choice;
const found = spawnSync('security', findCertificateArgs(name), { env, encoding: 'utf8' });
// `security` exits 44 with "could not be found" when nothing matches at all. Whether that — or any
// other answer — signs, warns or stops the build is `identityVerdict`'s call, tested in signing.test.ts.
const verdict = identityVerdict(
  { error: found.error ? found.error.message : null, status: found.status, stdout: found.stdout ?? '', stderr: found.stderr ?? '' },
  choice,
);
if (verdict.kind === 'fail') die(verdict.message);
if (verdict.kind === 'warn') {
  console.warn(verdict.message);
  process.exit(0);
}
const { sha1 } = verdict;

console.log(`[sign] identity "${name}" = ${sha1}`);
codesign(signHelperArgs(sha1, helper), `signing ${rel(helper)}`);
console.log(`[sign] signed ${rel(helper)}`);
codesign(signAppArgs(sha1, app), `signing ${app}`);
console.log(`[sign] signed ${app}`);

codesign(verifyArgs(app, { deep: true }), 'codesign --verify --deep --strict of the app');
codesign(verifyArgs(helper, { deep: false }), `codesign --verify --strict of ${rel(helper)}`);
for (const [path, what] of [[app, 'Hangar.app'], [helper, rel(helper)]]) {
  const problem = signatureProblem(codesign(describeArgs(path), `codesign -dvv of ${what}`), name, what);
  if (problem !== null) die(`${problem}\nThe signature was written but is not the one asked for; the microphone grant would not survive an install.`);
}
console.log(`[sign] verified: Hangar.app and ${rel(helper)} are signed by "${name}"; codesign --verify --deep --strict passes`);
