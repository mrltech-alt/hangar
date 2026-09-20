import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureExecutable, nodePtyPackageDir, spawnHelperCandidates } from './pty-fix.ts';
import { tempDir } from '../test/fixtures/tmp.ts';


describe('ensureExecutable', () => {
  it('adds the execute bit once and reports what it fixed', () => {
    const dir = tempDir('ptyfix');
    const helper = join(dir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);

    const first = ensureExecutable([helper, join(dir, 'missing')]);
    expect(first.checked).toEqual([helper]);
    expect(first.fixed).toEqual([helper]);
    expect(first.failed).toEqual([]);
    expect(statSync(helper).mode & 0o111).not.toBe(0);

    const second = ensureExecutable([helper]);
    expect(second.fixed).toEqual([]);
  });

  it('records a chmod failure instead of throwing', () => {
    const dir = tempDir('ptyfix-ro');
    const helper = join(dir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);
    chmodSync(dir, 0o500); // read+execute only: chmod of the child fails on a non-owner-writable dir
    try {
      const r = ensureExecutable([helper]);
      // Root can chmod anything; only assert the contract that matters — it never throws.
      expect(r.checked).toEqual([helper]);
      expect(r.fixed.length + r.failed.length).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('spawnHelperCandidates', () => {
  it('lists prebuilt, release and debug locations', () => {
    const c = spawnHelperCandidates('/x/node-pty');
    expect(c).toContain(`/x/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`);
    expect(c).toContain('/x/node-pty/build/Release/spawn-helper');
    expect(c).toContain('/x/node-pty/build/Debug/spawn-helper');
  });
});

describe('nodePtyPackageDir', () => {
  // Deliberately does NOT call ensureSpawnHelperExecutable(): that would chmod the real
  // node_modules as a side effect of `npm test`, and then assert the bit it had just set.
  // These two assertions are what can actually regress — resolution, and candidates matching
  // the installed layout.
  it('resolves the installed node-pty, and a candidate exists there', () => {
    const dir = nodePtyPackageDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir as string, 'package.json'))).toBe(true);
    expect(spawnHelperCandidates(dir as string).some(existsSync)).toBe(true);
  });
});

describe('ensureExecutable on a node-pty-shaped fixture', () => {
  it('fixes a prebuilds-layout helper stripped of its execute bit (spec §19.4)', () => {
    const pkg = tempDir('nodepty');
    const prebuilt = join(pkg, 'prebuilds', `${process.platform}-${process.arch}`);
    mkdirSync(prebuilt, { recursive: true });
    const helper = join(prebuilt, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);

    expect(ensureExecutable(spawnHelperCandidates(pkg)).fixed).toEqual([helper]);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });
});
