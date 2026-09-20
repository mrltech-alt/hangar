import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Write JSON to `<file>.tmp`, copy the current file to `bakFile` (if given), then rename tmp → file.
 *
 * The rename is what makes the write atomic, and it REPLACES the target rather than writing through
 * it: if the user symlinked their profile into a sync folder, `file` becomes a regular file after
 * the first save and the link is gone. That is the right trade — a torn `workspace.json` costs every
 * project and agent — but it is silent, so it is written down here.
 */
export function atomicWriteJson(file: string, value: unknown, bakFile?: string): void {
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(value, null, 2);
  // `JSON.stringify(undefined)` returns undefined, which concatenated into the literal string
  // "undefined" — an unparseable file. It matters because the config store passes no `bakFile`,
  // so that write has nothing to recover from.
  if (body === undefined) throw new TypeError(`refusing to write a non-JSON value to ${file}`);
  writeFileSync(tmp, body + '\n');
  if (bakFile !== undefined && existsSync(file)) copyFileSync(file, bakFile);
  renameSync(tmp, file);
}
