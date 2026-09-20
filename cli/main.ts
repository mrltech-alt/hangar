// Process entry for the `hangar` CLI. Keep this file tiny; logic lives in run.ts so it can be tested.
import { realpathSync } from 'node:fs';
import { runCli } from './run.ts';

// Entry guard, same as host/main.ts (spec G6, Plan 01 Task 14): shared/module-load.test.ts imports
// every file under host/, cli/ and shared/ in a child Node process. Without this, merely importing
// this file runs the CLI — which parses the importing process's argv, may open the host socket, and
// sets a non-zero exitCode that fails the test. `import.meta.main` needs Node >= 24.2 and is
// experimental, and §8.3's nodeBin chain can end at the Node 22 of G4, so keep the argv[1] fallback.
const entryPath = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
if (import.meta.main ?? entryPath === import.meta.filename) {
  process.exitCode = await runCli(process.argv.slice(2), process.env, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
