import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SIGN_IDENTITY,
  HELPER_IDENTIFIER,
  SIGN_IDENTITY_ENV,
  ambiguousIdentityMessage,
  authoritiesOf,
  describeArgs,
  explicitIdentityMissingMessage,
  findCertificateArgs,
  identityVerdict,
  missingIdentityWarning,
  parseCertificates,
  resolveIdentity,
  signAppArgs,
  signHelperArgs,
  signIdentityChoice,
  signatureProblem,
  verifyArgs,
  type SecurityLookup,
} from './signing.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const SHA1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4';
const OTHER = 'D1296D35E71B8F3F006F34902BDDA59E0A2915A5';

/** One record of `security find-certificate -a -c <name> -Z`, as it printed on 2026-09-18. */
function certificate(sha1: string, label: string, keychain = '/Users/me/Library/Keychains/login.keychain-db'): string {
  return [
    'SHA-256 hash: 6C3036114D7DA89B1182BAED4CE80BC419A663CC3E381251F3337DD8E68E70C1',
    `SHA-1 hash: ${sha1}`,
    `keychain: "${keychain}"`,
    'version: 512',
    'class: 0x80001000 ',
    'attributes:',
    `    "alis"<blob>="${label}"`,
    '    "cenc"<uint32>=0x00000003 ',
    '    "hpky"<blob>=0x9D04E501BB362883465349D5C0542B000CC4086F  "\\235\\004\\345"',
    `    "labl"<blob>="${label}"`,
    '    "subj"<blob>=0x3030311D301B06035504030C1448616E676172  "001\\0350\\033"',
  ].join('\n');
}

/** `codesign -dvv` of a file signed by the self-signed certificate, as measured. */
const SIGNED_DVV = [
  'Executable=/x/Hangar.app/Contents/MacOS/Hangar',
  'Identifier=dev.hangar.app',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20400 size=494 flags=0x0(none) hashes=10+2 location=embedded',
  'Signature size=1750',
  'Authority=Hangar Local Signing',
  'Signed Time=18 Sep 2026 at 13:51:44',
  'Info.plist entries=33',
  'TeamIdentifier=not set',
].join('\n');

/** `codesign -dv` of the ad-hoc app electron-builder leaves, as installed before Plan 09. */
const ADHOC_DV = [
  'Executable=/x/Hangar.app/Contents/MacOS/Hangar',
  'Identifier=Electron',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded',
  'Signature=adhoc',
  'Info.plist=not bound',
  'TeamIdentifier=not set',
].join('\n');

describe('signIdentityChoice', () => {
  it('defaults to the certificate made for Hangar, which nobody asked for by name', () => {
    expect(DEFAULT_SIGN_IDENTITY).toBe('Hangar Local Signing');
    expect(signIdentityChoice({})).toEqual({ name: 'Hangar Local Signing', explicit: false });
  });

  it('takes HANGAR_SIGN_IDENTITY when it says something, trimmed, as an explicit choice', () => {
    expect(SIGN_IDENTITY_ENV).toBe('HANGAR_SIGN_IDENTITY');
    expect(signIdentityChoice({ HANGAR_SIGN_IDENTITY: '  My Cert ' })).toEqual({ name: 'My Cert', explicit: true });
    // Naming the default is still naming it.
    expect(signIdentityChoice({ HANGAR_SIGN_IDENTITY: 'Hangar Local Signing' })).toEqual({ name: 'Hangar Local Signing', explicit: true });
  });

  it('treats an empty or blank override as unset rather than as a name', () => {
    expect(signIdentityChoice({ HANGAR_SIGN_IDENTITY: '' })).toEqual({ name: DEFAULT_SIGN_IDENTITY, explicit: false });
    expect(signIdentityChoice({ HANGAR_SIGN_IDENTITY: '   ' })).toEqual({ name: DEFAULT_SIGN_IDENTITY, explicit: false });
  });
});

/**
 * Whether the build signs, carries on ad-hoc, or stops. Only the DEFAULT certificate being absent may
 * carry on: anything else is a signature the owner expects and would not get, and an ad-hoc build
 * only shows its cost after the next install, as a microphone prompt nobody can explain.
 */
describe('identityVerdict — sign, warn, or stop the build', () => {
  const DEFAULT = { name: 'Hangar Local Signing', explicit: false };
  const NAMED = { name: 'My Cert', explicit: true };
  const answered = (over: Partial<SecurityLookup>): SecurityLookup => ({ error: null, status: 0, stdout: '', stderr: '', ...over });
  const NOT_FOUND = answered({ status: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' });

  it('signs with the one certificate of that name', () => {
    expect(identityVerdict(answered({ stdout: certificate(SHA1, 'Hangar Local Signing') }), DEFAULT)).toEqual({ kind: 'sign', sha1: SHA1 });
    expect(identityVerdict(answered({ stdout: certificate(OTHER, 'My Cert') }), NAMED)).toEqual({ kind: 'sign', sha1: OTHER });
  });

  it('only WARNS — the build carries on ad-hoc — when the default certificate is simply not there', () => {
    expect(identityVerdict(NOT_FOUND, DEFAULT)).toEqual({ kind: 'warn', message: missingIdentityWarning('Hangar Local Signing') });
    // `-c` is a substring match: a near miss answers 0, and is still not the certificate.
    expect(identityVerdict(answered({ stdout: certificate(SHA1, 'Hangar Local Signing (old)') }), DEFAULT).kind).toBe('warn');
  });

  it('STOPS the build when an identity named in HANGAR_SIGN_IDENTITY is not there', () => {
    const verdict = identityVerdict(NOT_FOUND, NAMED);
    expect(verdict).toEqual({ kind: 'fail', message: explicitIdentityMissingMessage('My Cert') });
    expect(explicitIdentityMissingMessage('My Cert').split('\n')[0]).toBe('HANGAR_SIGN_IDENTITY is "My Cert", and no certificate with exactly that name is in the keychain.');
    expect(identityVerdict(answered({ stdout: certificate(OTHER, 'My Cert 2') }), NAMED).kind).toBe('fail');
  });

  it('STOPS the build when security fails with anything but 44 (not found), passing on what it said', () => {
    const locked = identityVerdict(answered({ status: 36, stderr: 'security: unable to read the keychain\n' }), DEFAULT);
    expect(locked.kind).toBe('fail');
    expect(locked.kind === 'fail' && locked.message.split('\n')[0]).toBe('Could not look up the certificate "Hangar Local Signing": security exited 36: security: unable to read the keychain.');
    const killed = identityVerdict(answered({ status: null }), DEFAULT);
    expect(killed.kind === 'fail' && killed.message.split('\n')[0]).toBe('Could not look up the certificate "Hangar Local Signing": security was killed by a signal.');
  });

  it('STOPS the build when security could not be run at all', () => {
    const verdict = identityVerdict(answered({ error: 'spawnSync security ENOENT', status: null }), DEFAULT);
    expect(verdict.kind === 'fail' && verdict.message.split('\n')[0]).toBe('Could not look up the certificate "Hangar Local Signing": could not run security: spawnSync security ENOENT.');
  });

  it('STOPS the build for two different certificates of one name, default or not', () => {
    const two = answered({ stdout: [certificate(SHA1, 'Hangar Local Signing'), certificate(OTHER, 'Hangar Local Signing')].join('\n') });
    expect(identityVerdict(two, DEFAULT)).toEqual({ kind: 'fail', message: ambiguousIdentityMessage('Hangar Local Signing', [SHA1, OTHER]) });
  });
});

describe('finding the certificate', () => {
  // Rule 1, and a name with spaces is the default case here, not an edge case.
  it('asks security for every certificate matching the name, with SHA-1s, as one argument', () => {
    expect(findCertificateArgs('Hangar Local Signing')).toEqual(['find-certificate', '-a', '-c', 'Hangar Local Signing', '-Z']);
  });

  it('parses the SHA-1 and the label of each record', () => {
    const output = `${certificate(SHA1, 'Hangar Local Signing')}\n${certificate(OTHER, 'Hangar Local Signing Old')}\n`;
    expect(parseCertificates(output)).toEqual([
      { sha1: SHA1, label: 'Hangar Local Signing' },
      { sha1: OTHER, label: 'Hangar Local Signing Old' },
    ]);
  });

  it('resolves the name to its SHA-1', () => {
    expect(resolveIdentity(certificate(SHA1, 'Hangar Local Signing'), 'Hangar Local Signing')).toEqual({ kind: 'found', sha1: SHA1 });
  });

  it('upper-cases the hash, whatever case it arrives in', () => {
    expect(resolveIdentity(certificate(SHA1.toLowerCase(), 'Hangar Local Signing'), 'Hangar Local Signing')).toEqual({ kind: 'found', sha1: SHA1 });
  });

  // `-c` is a substring match: asking for "Hangar" finds "Hangar Local Signing" too, and signing with
  // it would be signing with a certificate nobody named.
  it('matches the label exactly, never as a substring', () => {
    expect(resolveIdentity(certificate(SHA1, 'Hangar Local Signing'), 'Hangar')).toEqual({ kind: 'missing' });
    expect(resolveIdentity(certificate(SHA1, 'Hangar Local Signing'), 'hangar local signing')).toEqual({ kind: 'missing' });
  });

  it('is missing when security printed nothing (exit 44, "could not be found")', () => {
    expect(resolveIdentity('', 'Hangar Local Signing')).toEqual({ kind: 'missing' });
  });

  it('counts one certificate in two keychains once', () => {
    const output = `${certificate(SHA1, 'Hangar Local Signing')}\n${certificate(SHA1, 'Hangar Local Signing', '/Library/Keychains/System.keychain')}`;
    expect(resolveIdentity(output, 'Hangar Local Signing')).toEqual({ kind: 'found', sha1: SHA1 });
  });

  it('refuses two different certificates with the same name', () => {
    const output = `${certificate(SHA1, 'Hangar Local Signing')}\n${certificate(OTHER, 'Hangar Local Signing')}`;
    expect(resolveIdentity(output, 'Hangar Local Signing')).toEqual({ kind: 'ambiguous', sha1s: [SHA1, OTHER] });
    const message = ambiguousIdentityMessage('Hangar Local Signing', [SHA1, OTHER]);
    expect(message).toContain(SHA1);
    expect(message).toContain(OTHER);
    expect(message).toContain('security delete-certificate -Z <sha1>');
  });
});

describe('the codesign argv', () => {
  const helper = '/Users/me/My Projects/hangar/dist/mac-arm64/Hangar.app/Contents/Resources/app/resources/bin/hangar-dictate';
  const app = '/Users/me/My Projects/hangar/dist/mac-arm64/Hangar.app';

  it('signs the helper by HASH, with a stable identifier of its own', () => {
    expect(HELPER_IDENTIFIER).toBe('dev.hangar.app.dictate');
    expect(signHelperArgs(SHA1, helper)).toEqual(['--force', '--sign', SHA1, '--identifier', 'dev.hangar.app.dictate', helper]);
  });

  it('signs the app by hash, deep', () => {
    expect(signAppArgs(SHA1, app)).toEqual(['--force', '--deep', '--sign', SHA1, app]);
  });

  // Spec §5: no hardened runtime. It would need Electron's JIT entitlements and buys nothing here.
  it('never asks for the hardened runtime', () => {
    for (const args of [signHelperArgs(SHA1, helper), signAppArgs(SHA1, app)]) {
      expect(args).not.toContain('--options');
      expect(args.join(' ')).not.toMatch(/runtime/);
    }
  });

  it('verifies the app deep and strict, and the helper strict', () => {
    expect(verifyArgs(app, { deep: true })).toEqual(['--verify', '--deep', '--strict', '--verbose=2', app]);
    expect(verifyArgs(helper, { deep: false })).toEqual(['--verify', '--strict', '--verbose=2', helper]);
  });

  // Measured: `codesign -dv` prints no Authority= line for a certificate-signed file; `-dvv` does.
  it('describes with verbosity 2, where the Authority= lines are', () => {
    expect(describeArgs(app)).toEqual(['-d', '--verbose=2', app]);
  });

  it('keeps every path with spaces as one argument', () => {
    expect(signHelperArgs(SHA1, helper).at(-1)).toBe(helper);
    expect(signAppArgs(SHA1, app).at(-1)).toBe(app);
    expect(verifyArgs(app, { deep: true }).at(-1)).toBe(app);
    expect(describeArgs(helper).at(-1)).toBe(helper);
  });
});

describe('reading the signature back', () => {
  it('finds the authority lines, leaf first', () => {
    expect(authoritiesOf(SIGNED_DVV)).toEqual(['Hangar Local Signing']);
    expect(authoritiesOf('Authority=Leaf\nAuthority=Intermediate\nAuthority=Root\n')).toEqual(['Leaf', 'Intermediate', 'Root']);
    expect(authoritiesOf(ADHOC_DV)).toEqual([]);
  });

  it('passes a file signed by the identity asked for', () => {
    expect(signatureProblem(SIGNED_DVV, 'Hangar Local Signing', 'Hangar.app')).toBeNull();
  });

  it('fails an ad-hoc signature, which is what an unsigned-by-us build still carries', () => {
    expect(signatureProblem(ADHOC_DV, 'Hangar Local Signing', 'Hangar.app')).toBe('Hangar.app is still ad-hoc signed, not signed by "Hangar Local Signing".');
  });

  it('fails a signature by some other certificate', () => {
    expect(signatureProblem(SIGNED_DVV.replace('Authority=Hangar Local Signing', 'Authority=Apple Development: Someone (X)'), 'Hangar Local Signing', 'the helper'))
      .toBe('the helper is signed by "Apple Development: Someone (X)", not "Hangar Local Signing".');
  });

  it('checks the LEAF, not any authority in the chain', () => {
    expect(signatureProblem('Authority=Someone Else\nAuthority=Hangar Local Signing\n', 'Hangar Local Signing', 'x')).not.toBeNull();
  });

  // The trap `describeArgs` avoids: `-dv` output of a properly signed file has no Authority= line,
  // and must read as a failure rather than as a pass.
  it('fails output with no authority at all', () => {
    const dv = SIGNED_DVV.replace('Authority=Hangar Local Signing\n', '');
    expect(signatureProblem(dv, 'Hangar Local Signing', 'x')).toBe('x shows no signing authority at all; expected "Hangar Local Signing".');
  });
});

describe('missingIdentityWarning', () => {
  const warning = missingIdentityWarning('Hangar Local Signing');

  it('is a warning that names the certificate and says the app stays ad-hoc', () => {
    expect(warning.split('\n')[0]).toBe('[sign] WARNING: no certificate named "Hangar Local Signing" in the keychain, so Hangar.app keeps its ad-hoc signature.');
  });

  it('says what it costs: the microphone grant will not survive an install', () => {
    expect(warning).toContain('Dictation will ask for the microphone again after every install; a grant never survives one.');
  });

  it('says how to fix it', () => {
    expect(warning).toContain('docs/RUNBOOK.md');
    expect(warning).toContain('HANGAR_SIGN_IDENTITY');
  });

});

describe('wiring', () => {
  const pkg = readFileSync(join(root, 'scripts', 'package.mjs'), 'utf8');
  const sign = readFileSync(join(root, 'scripts', 'sign.mjs'), 'utf8');

  // Signing seals the bundle's contents, so it has to come after electron-builder and after the
  // chmod repair; anything written into the bundle later breaks the seal.
  it('npm run app signs last, after electron-builder and the chmod repair', () => {
    const builder = pkg.indexOf("'node_modules/.bin/electron-builder'");
    const chmod = pkg.indexOf('chmodSync(p, 0o755)');
    const signing = pkg.indexOf("'sign.mjs'");
    expect(builder).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(builder);
    expect(signing).toBeGreaterThan(chmod);
  });

  it('signs the helper before the app', () => {
    expect(sign.indexOf('signHelperArgs(')).toBeLessThan(sign.indexOf('signAppArgs('));
  });

  // `identityVerdict` decides; the driver must do exactly what it says. A missing DEFAULT identity
  // must not fail a fresh checkout's build (spec §5), and every `fail` must.
  it('warns and exits 0 only on a warn verdict, and dies on a fail', () => {
    expect(sign).toMatch(/if \(verdict\.kind === 'fail'\) die\(verdict\.message\);/);
    expect(sign).toMatch(/if \(verdict\.kind === 'warn'\) \{\n\s+console\.warn\(verdict\.message\);\n\s+process\.exit\(0\);\n\}/);
    expect(sign.match(/process\.exit\(0\)/g)).toHaveLength(2); // this one, and the non-macOS skip
  });

  // Rule 1: argv arrays only. A shell would split a checkout path with a space in it.
  it('spawns without a shell', () => {
    expect(sign).not.toMatch(/shell:\s*true/);
    expect(sign).not.toMatch(/\bexecSync\b|\bexec\(/);
  });
});
