// node-pty 1.1.0's prebuilt spawn-helper is extracted without the execute bit → "posix_spawnp failed" (spec G3).
//
// Deliberately imports no native code: it reaches node-pty via `require.resolve('node-pty/package.json')`,
// never `require('node-pty')`. That is what lets npm's postinstall run it before node-pty is usable, and
// lets `hangar doctor` call it without loading a native module built for a different Node ABI (spec G2).
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface PtyFixResult {
  /** null means node-pty could not be resolved at all — distinct from "resolved, but no helper found". */
  packageDir: string | null;
  checked: string[];
  fixed: string[];
  /** chmod threw (read-only volume, wrong owner, packaged app under /Applications). */
  failed: { path: string; error: string }[];
}

/**
 * Every place node-pty may keep the helper, mirroring its own `loadNativeModule` search order
 * (`build/Release`, `build/Debug`, then `prebuilds/<platform>-<arch>`). node-pty execs
 * `native.dir + '/spawn-helper'`, so these are exactly the paths that can ever be run.
 * All existing candidates are repaired, not just the first, so the order here does not have to
 * match node-pty's precedence.
 */
export function spawnHelperCandidates(nodePtyPkgDir: string): string[] {
  return [
    join(nodePtyPkgDir, 'build', 'Release', 'spawn-helper'),
    join(nodePtyPkgDir, 'build', 'Debug', 'spawn-helper'),
    join(nodePtyPkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
}

export function ensureExecutable(paths: string[]): PtyFixResult {
  const result: PtyFixResult = { packageDir: null, checked: [], fixed: [], failed: [] };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    result.checked.push(p);
    if ((statSync(p).mode & 0o111) === 0) {
      // Never throw: this runs from npm postinstall, where an EPERM must not fail the install,
      // and from createHost(), where it must not stop the host from starting.
      try {
        chmodSync(p, 0o755);
        result.fixed.push(p);
      } catch (e) {
        result.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return result;
}

export function nodePtyPackageDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

export function ensureSpawnHelperExecutable(): PtyFixResult {
  const dir = nodePtyPackageDir();
  if (dir === null) return { packageDir: null, checked: [], fixed: [], failed: [] };
  return { ...ensureExecutable(spawnHelperCandidates(dir)), packageDir: dir };
}
