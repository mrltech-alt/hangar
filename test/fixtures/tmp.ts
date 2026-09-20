import { mkdtempSync, rmSync } from 'node:fs';
import { onTestFinished } from 'vitest';

/**
 * A temp directory that removes itself when the test finishes.
 *
 * Under `/tmp`, deliberately — NOT `os.tmpdir()`. On macOS `tmpdir()` is a long
 * `/var/folders/…/T` path, and anything that puts a Unix socket inside it blows the 104-byte
 * `sun_path` limit (spec G9): the host then dies with a bare `EINVAL` that looks nothing like a
 * path-length problem. Do not "tidy" this into `tmpdir()`.
 *
 * `onTestFinished` rather than a module-level `afterEach`: it needs no tracking array, and cleanup
 * is scoped to the test that created the directory rather than to whichever suite happened to be
 * collecting when this module was imported.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(`/tmp/hangar-${prefix}-`);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
