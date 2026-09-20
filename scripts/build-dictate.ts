// Pure helpers for `scripts/build-dictate.mjs`, split out for the same reason `packaging.ts` is:
// the driver spawns a compiler and touches the filesystem, and neither of those is testable, while
// the argv it spawns, the path it writes and the sentence it prints when there is no toolchain all
// are — and all three are things a silent change to would ship a Hangar with no dictation in it.
import { join } from 'node:path';

/** Relative to the repo root, so both halves of the build agree on one spelling. */
export const DICTATE_SOURCE = 'mac/dictate/main.swift';

/**
 * Relative to the repo root. `resources/` is what `electron-builder.yml` copies into the bundle, so
 * the helper has to land there rather than in `out/` or `dist/`, which are wiped per build.
 */
export const DICTATE_BINARY = 'resources/bin/hangar-dictate';

export function dictateSourcePath(root: string): string {
  return join(root, DICTATE_SOURCE);
}

export function dictateBinaryPath(root: string): string {
  return join(root, DICTATE_BINARY);
}

/**
 * Where `swiftc` actually writes. The compiler is not atomic — an interrupted or failing run can
 * leave a truncated Mach-O behind — and a half-written `hangar-dictate` is worse than no helper at
 * all: the packaging check in `package.mjs` sees a file and passes, and the failure moves to the
 * first press of the microphone button in a packaged app.
 */
export function tempBinaryPath(binary: string, token: string | number): string {
  return `${binary}.building-${token}`;
}

/**
 * The argv for `xcrun`. Never a shell string (CLAUDE.md rule 1), and `-swift-version 5` is pinned
 * rather than left to the toolchain's default: the helper's top-level `await`, its `@unchecked
 * Sendable` state box and its `AsyncStream` continuations are all warning-free under Swift 5 and
 * would become errors under the Swift 6 language mode, which a newer Xcode may well default to.
 */
export function swiftcArgs(source: string, out: string): string[] {
  return ['swiftc', '-swift-version', '5', '-O', source, '-o', out];
}

/**
 * What a checkout with no Swift compiler is told. Not a stack trace: the only thing wrong is that
 * the Xcode command line tools are not installed, and the person reading it needs the one command
 * that fixes it and to know what works without it: `npm run dev` does, and `npm run app` does not —
 * its packaging check refuses a bundle with no helper (`dictateHelperProblems` in `packaging.ts`).
 */
export function noToolchainMessage(reason: string): string {
  return [
    `[build-dictate] No Swift toolchain found, so ${DICTATE_BINARY} was not built.`,
    `  Reason: ${reason}`,
    `  ${DICTATE_SOURCE} needs Apple's Swift compiler. Install the Xcode command line tools:`,
    '      xcode-select --install',
    '  then build the helper on its own with:',
    '      npm run build:dictate',
    '  npm run dev runs without it (only dictation is missing), but npm run app will not package without it.',
  ].join('\n');
}

/** What a checkout with a compiler but no source is told — a truncated clone, or a bad `root`. */
export function noSourceMessage(source: string): string {
  return `[build-dictate] ${source} does not exist; nothing to build.`;
}
