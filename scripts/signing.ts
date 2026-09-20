// Pure helpers for `scripts/sign.mjs`, split out for the reason `packaging.ts` and `build-dictate.ts`
// are: the driver runs `security` and `codesign` against a real keychain and a real bundle, neither
// of which a test can touch, while every argv it runs, every line of output it reads and every
// sentence it prints can be pinned — and a silent change to any of them ships an app whose
// microphone grant does not survive the next install.
//
// Why sign at all (spec 2026-09-18 §5): electron-builder leaves the bundle AD-HOC signed
// (`identity: null`), and an ad-hoc signature is a hash of the code, so it changes on every build and
// macOS treats each install as a new app. A self-signed certificate gives it an identity that stays
// put. No Apple Developer Program and no notarization — the app never leaves this Mac.

/** The certificate the owner made on 2026-09-18 (login keychain; `docs/RUNBOOK.md` has the recipe). */
export const DEFAULT_SIGN_IDENTITY = 'Hangar Local Signing';

/** Overrides `DEFAULT_SIGN_IDENTITY`: the certificate's name, exactly as the keychain labels it. */
export const SIGN_IDENTITY_ENV = 'HANGAR_SIGN_IDENTITY';

/**
 * The helper's code identifier. Named rather than left to codesign: `swiftc` links it with an ad-hoc
 * signature whose identifier is the file it wrote, and `build-dictate` writes to a temp path and
 * renames, so the linker's identifier is `hangar-dictate.building-<pid>` — measured — and a fresh
 * one on every build.
 */
export const HELPER_IDENTIFIER = 'dev.hangar.app.dictate';

/**
 * The identity to sign with, and whether the owner ASKED for it: `HANGAR_SIGN_IDENTITY` when it is set
 * to something (explicit), else the default (not). A blank override is unset, not a name.
 */
export function signIdentityChoice(env: Readonly<Record<string, string | undefined>>): { name: string; explicit: boolean } {
  const set = env[SIGN_IDENTITY_ENV]?.trim();
  return set !== undefined && set !== '' ? { name: set, explicit: true } : { name: DEFAULT_SIGN_IDENTITY, explicit: false };
}

/** `security find-certificate`'s exit status when nothing matched at all ("could not be found"). */
export const SECURITY_NOT_FOUND = 44;

/** What `spawnSync('security', findCertificateArgs(name))` came back with. */
export interface SecurityLookup {
  /** The spawn's own error (`security` could not be run at all), or null. */
  error: string | null;
  /** The exit status; null when a signal ended it. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type IdentityVerdict =
  | { kind: 'sign'; sha1: string }
  /** Carry on, ad-hoc, after printing `message`: only ever the DEFAULT identity, simply absent. */
  | { kind: 'warn'; message: string }
  /** Stop the build with `message`. */
  | { kind: 'fail'; message: string };

/**
 * What the certificate look-up means for the build. **Only one case may carry on unsigned: the
 * DEFAULT identity, looked for successfully and not there** — a fresh checkout that has never made
 * the certificate (spec §5). Everything else stops the build, because each is a signature the owner
 * expects and would not get, and an ad-hoc build costs the microphone grant at the next install with
 * nothing on screen to say why:
 *
 *  - `HANGAR_SIGN_IDENTITY` set and no certificate with exactly that name. The owner named one, so a
 *    typo must not quietly ship an ad-hoc app.
 *  - `security` failing with anything but exit 44 (not found) — a locked or unreadable keychain, a
 *    signal — or not running at all. That is not an absent certificate but an unanswered question,
 *    and it used to be reported as a missing one and waved through.
 *  - two different certificates with the name (`resolveIdentity`'s `ambiguous`).
 */
export function identityVerdict(lookup: SecurityLookup, choice: { name: string; explicit: boolean }): IdentityVerdict {
  const { name } = choice;
  if (lookup.error !== null) return { kind: 'fail', message: securityFailedMessage(name, `could not run security: ${lookup.error}`) };
  if (lookup.status !== 0 && lookup.status !== SECURITY_NOT_FOUND) {
    const said = lookup.stderr.trim();
    return { kind: 'fail', message: securityFailedMessage(name, `${lookup.status === null ? 'security was killed by a signal' : `security exited ${lookup.status}`}${said === '' ? '' : `: ${said}`}`) };
  }
  const found = lookup.status === 0 ? resolveIdentity(lookup.stdout, name) : ({ kind: 'missing' } as const);
  if (found.kind === 'found') return { kind: 'sign', sha1: found.sha1 };
  if (found.kind === 'ambiguous') return { kind: 'fail', message: ambiguousIdentityMessage(name, found.sha1s) };
  if (choice.explicit) return { kind: 'fail', message: explicitIdentityMissingMessage(name) };
  return { kind: 'warn', message: missingIdentityWarning(name) };
}

/**
 * The argv for `security`. `-c` is a SUBSTRING match and `-a` returns every hit, so the exact name is
 * picked out of the output by `resolveIdentity`; `-Z` prints each certificate's SHA-1.
 *
 * Not `security find-identity -v -p codesigning`: that lists only identities macOS TRUSTS for code
 * signing, and a self-signed certificate nobody has marked trusted is not one — it reports
 * `0 valid identities found` for a certificate codesign signs with perfectly well (G93).
 */
export function findCertificateArgs(name: string): string[] {
  return ['find-certificate', '-a', '-c', name, '-Z'];
}

export interface KeychainCertificate {
  sha1: string;
  /** The keychain's `labl` attribute — the name Keychain Access shows. Null when it is not printed as plain text. */
  label: string | null;
}

/**
 * Every certificate in `security find-certificate -a -Z` output, in order. A record starts at its
 * `SHA-1 hash:` line (the `SHA-256 hash:` line above it is ignored). A label that `security` prints
 * as hex — it does that for bytes it will not show as text — reads as `null` and so matches no name.
 */
export function parseCertificates(output: string): KeychainCertificate[] {
  const certs: KeychainCertificate[] = [];
  let current: KeychainCertificate | null = null;
  for (const line of output.split('\n')) {
    const sha1 = /^SHA-1 hash:\s*([0-9A-Fa-f]{40})\s*$/.exec(line);
    if (sha1 !== null) {
      current = { sha1: sha1[1].toUpperCase(), label: null };
      certs.push(current);
      continue;
    }
    if (current === null) continue;
    const label = /^\s*"labl"<blob>="(.*)"\s*$/.exec(line);
    if (label !== null) current.label = label[1];
  }
  return certs;
}

export type IdentityLookup =
  | { kind: 'found'; sha1: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; sha1s: string[] };

/**
 * The one certificate labelled exactly `name`, by SHA-1. Codesign is then handed the HASH, never the
 * name. By name, `man codesign` says, it first looks for an identity PREFERENCE of that name and
 * otherwise takes any certificate whose common name CONTAINS the string — so what a name signs with
 * depends on what else is in the keychain. Forty hex digits is the one form that means exactly one
 * certificate (G93). The label must match exactly here for the same reason.
 *
 * The same certificate in two keychains is one certificate. Two DIFFERENT ones with the same label is
 * `ambiguous` — signing with either could be signing with the one the microphone grant is not tied to.
 */
export function resolveIdentity(output: string, name: string): IdentityLookup {
  const sha1s = [...new Set(parseCertificates(output).filter((c) => c.label === name).map((c) => c.sha1))];
  if (sha1s.length === 0) return { kind: 'missing' };
  if (sha1s.length > 1) return { kind: 'ambiguous', sha1s };
  return { kind: 'found', sha1: sha1s[0] };
}

/**
 * Signs the helper INSIDE the bundle, before the bundle. Order matters: the bundle's signature seals
 * the helper's bytes as a resource, so re-signing the helper afterwards would break the seal.
 * No `--options runtime` (hardened runtime) anywhere — spec §5.
 */
export function signHelperArgs(sha1: string, helperPath: string): string[] {
  return ['--force', '--sign', sha1, '--identifier', HELPER_IDENTIFIER, helperPath];
}

/** The whole `.app`, nested frameworks and Electron's helper apps included (`--deep`). */
export function signAppArgs(sha1: string, appPath: string): string[] {
  return ['--force', '--deep', '--sign', sha1, appPath];
}

/** Must exit 0. `--verbose=2` only makes it say `valid on disk` / `satisfies its Designated Requirement`. */
export function verifyArgs(path: string, opts: { deep: boolean }): string[] {
  return ['--verify', ...(opts.deep ? ['--deep'] : []), '--strict', '--verbose=2', path];
}

/**
 * `codesign -d --verbose=2` (`-dvv`). NOT `-dv`: measured on 2026-09-18, `-dv` prints the identifier,
 * the format and `Signature size=` for a certificate-signed file but no `Authority=` line at all, so
 * a check that read `-dv` could never see who signed. Everything goes to STDERR.
 */
export function describeArgs(path: string): string[] {
  return ['-d', '--verbose=2', path];
}

/** The `Authority=` lines of `codesign -dvv` output, leaf first. None for an ad-hoc signature. */
export function authoritiesOf(output: string): string[] {
  return [...output.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim());
}

/**
 * Why `codesign -dvv` output does not show a signature by `name`, or null when it does. The LEAF
 * authority is the one that has to match: that is the certificate that signed.
 */
export function signatureProblem(output: string, name: string, what: string): string | null {
  const [leaf] = authoritiesOf(output);
  if (leaf === name) return null;
  if (leaf !== undefined) return `${what} is signed by "${leaf}", not "${name}".`;
  if (/^Signature=adhoc$/m.test(output)) return `${what} is still ad-hoc signed, not signed by "${name}".`;
  return `${what} shows no signing authority at all; expected "${name}".`;
}

/**
 * What a checkout with no DEFAULT certificate is told. A WARNING — the build carries on with the
 * ad-hoc signature electron-builder left, because a fresh checkout must still build — but one that
 * says what it costs, since the cost only shows up later and somewhere else: in System Settings,
 * after an install. Only ever for the default identity: see `identityVerdict`.
 */
export function missingIdentityWarning(name: string): string {
  return [
    `[sign] WARNING: no certificate named "${name}" in the keychain, so Hangar.app keeps its ad-hoc signature.`,
    '  What that costs: an ad-hoc signature changes with every build, so macOS sees each install as a new app.',
    '  Dictation will ask for the microphone again after every install; a grant never survives one.',
    `  To fix it, create the self-signed certificate (docs/RUNBOOK.md → "A stable signature"),`,
    `  or set ${SIGN_IDENTITY_ENV} to the name of one you already have. Then run npm run app again.`,
  ].join('\n');
}

/** `HANGAR_SIGN_IDENTITY` names a certificate that is not there: refuse rather than ship ad-hoc. */
export function explicitIdentityMissingMessage(name: string): string {
  return [
    `${SIGN_IDENTITY_ENV} is "${name}", and no certificate with exactly that name is in the keychain.`,
    'An identity you named is never skipped: an ad-hoc build would lose the microphone grant at the next install.',
    `Fix the name (as Keychain Access shows it), or unset ${SIGN_IDENTITY_ENV} to use "${DEFAULT_SIGN_IDENTITY}".`,
  ].join('\n');
}

/** `security` failed, or could not run: the keychain was not read, which is not the same as empty. */
export function securityFailedMessage(name: string, what: string): string {
  return [
    `Could not look up the certificate "${name}": ${what}.`,
    'A keychain that could not be read is not a missing certificate, so the build stops rather than ship an',
    'ad-hoc signature. If the login keychain is locked: security unlock-keychain, then run npm run app again.',
  ].join('\n');
}

/** Two different certificates share the name: refuse, and say how to get back to one. */
export function ambiguousIdentityMessage(name: string, sha1s: string[]): string {
  return [
    `${sha1s.length} different certificates are named "${name}":`,
    ...sha1s.map((h) => `  ${h}`),
    'Signing with the wrong one would lose the microphone grant just as an ad-hoc build does. Keep the one',
    'the installed app was signed with — codesign -d -r- /Applications/Hangar.app prints it as',
    '`certificate root = H"<sha1>"` — and delete the other:',
    '  security delete-certificate -Z <sha1>',
  ].join('\n');
}
