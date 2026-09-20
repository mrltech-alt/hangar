import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
// fileURLToPath, not `.pathname`: the latter leaves percent-encoding, so a checkout under a
// path with a space resolves to `/Users/me/My%20Projects/...` and readdirSync ENOENTs.
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Every runnable `.ts` under the type-stripped directories, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(join(dir, entry.name));
  }
  return out;
}

describe('type-stripped modules load under raw Node (spec G6)', () => {
  const files = ['shared', 'host', 'cli'].flatMap(sourceFiles);

  it('finds the source files in every type-stripped directory', () => {
    // Per-directory, not a single total: `cli/` alone is 11 files, so a bug that dropped all of
    // `host/` would still clear a bare `> 10`.
    for (const dir of ['shared', 'host', 'cli']) {
      expect(files.filter((f) => f.startsWith(`${dir}/`)).length, `${dir}/ files`).toBeGreaterThan(3);
    }
  });

  it.each(files)('%s imports cleanly', async (relPath) => {
    // A child `node` process, not vitest's loader: Vite happily resolves extensionless
    // specifiers and interops CJS, so importing in-process would hide exactly the bugs
    // this test exists to catch.
    await expect(
      execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(join(root, relPath)).href)});`],
        // A module with a side effect at import time — a timer, a listener, a missing entry guard —
        // would otherwise hang for the full vitest timeout and leave the child running, since vitest
        // does not reap it. This names the offending file instead.
        { timeout: 10_000, killSignal: 'SIGKILL' }),
    ).resolves.toBeDefined();
  });
});
