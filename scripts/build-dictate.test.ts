import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DICTATE_BINARY,
  DICTATE_SOURCE,
  dictateBinaryPath,
  dictateSourcePath,
  noSourceMessage,
  noToolchainMessage,
  swiftcArgs,
  tempBinaryPath,
} from './build-dictate.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

describe('dictate paths', () => {
  it('builds into resources/bin/hangar-dictate, the directory the bundle copies', () => {
    expect(DICTATE_BINARY).toBe('resources/bin/hangar-dictate');
    expect(dictateBinaryPath('/repo')).toBe('/repo/resources/bin/hangar-dictate');
  });

  it('builds from mac/dictate/main.swift, and that file exists in this checkout', () => {
    expect(dictateSourcePath('/repo')).toBe('/repo/mac/dictate/main.swift');
    // Moving the Swift without moving this constant would make every build print "nothing to build".
    expect(existsSync(join(root, DICTATE_SOURCE))).toBe(true);
  });

  // The rename that publishes the binary is only atomic within one directory, and the sweep of
  // leftovers finds them by the binary's own name as a prefix.
  it('compiles to a temp path beside the binary, never to the binary itself', () => {
    const binary = dictateBinaryPath('/repo');
    const temp = tempBinaryPath(binary, 4242);
    expect(temp).not.toBe(binary);
    expect(dirname(temp)).toBe(dirname(binary));
    expect(temp.startsWith(binary)).toBe(true);
    expect(tempBinaryPath(binary, 1)).not.toBe(tempBinaryPath(binary, 2));
  });
});

describe('swiftcArgs', () => {
  it('is xcrun swiftc -O with the Swift 5 language mode pinned, source then -o out', () => {
    expect(swiftcArgs('/r/mac/dictate/main.swift', '/r/resources/bin/hangar-dictate.building-1')).toEqual([
      'swiftc', '-swift-version', '5', '-O', '/r/mac/dictate/main.swift', '-o', '/r/resources/bin/hangar-dictate.building-1',
    ]);
  });

  // Rule 1: an argv, never a shell string — a checkout under "~/My Projects" must still build.
  it('keeps a path with spaces as one argument', () => {
    const args = swiftcArgs('/Users/me/My Projects/hangar/mac/dictate/main.swift', '/tmp/out dir/x');
    expect(args).toContain('/Users/me/My Projects/hangar/mac/dictate/main.swift');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out dir/x');
  });
});

describe('noToolchainMessage', () => {
  const message = noToolchainMessage('could not run xcrun (ENOENT)');

  it('names the one command that fixes it and the one that rebuilds', () => {
    expect(message).toContain('xcode-select --install');
    expect(message).toContain('npm run build:dictate');
  });

  it('says what was not built and why', () => {
    expect(message).toContain(DICTATE_BINARY);
    expect(message).toContain('could not run xcrun (ENOENT)');
  });

  // The packaging check refuses a bundle with no helper, so "the rest builds without it" would be a
  // promise `npm run app` breaks one step later.
  it('says npm run app will not package without it', () => {
    expect(message).toContain('npm run app will not package without it');
  });

  it('reads as a message, not a stack trace', () => {
    expect(message.split('\n')[0]).toMatch(/^\[build-dictate\] /);
    expect(message).not.toMatch(/^\s+at /m);
    expect(message).not.toMatch(/\bError:/);
  });

  it('a missing source names the path it looked for', () => {
    expect(noSourceMessage('/r/mac/dictate/main.swift')).toBe('[build-dictate] /r/mac/dictate/main.swift does not exist; nothing to build.');
  });
});

describe('wiring', () => {
  it('npm run build:dictate runs the script', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:dictate']).toBe('node scripts/build-dictate.mjs');
  });

  // electron-builder copies resources/ as it finds it; a helper built after it is a helper missing
  // from the app.
  it('npm run app builds the helper before electron-builder packages', () => {
    const script = readFileSync(join(root, 'scripts', 'package.mjs'), 'utf8');
    const helper = script.indexOf("'build-dictate.mjs'");
    const builder = script.indexOf("'node_modules/.bin/electron-builder'");
    expect(helper).toBeGreaterThan(-1);
    expect(builder).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(builder);
  });

  it('the compiled binary is never committed', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^resources\/bin\/$/m);
  });
});
