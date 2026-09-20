#!/usr/bin/env node
// Launches Electron for development or from the built output.
// - Strips ELECTRON_RUN_AS_NODE (Claude Code's Bash sets it; it makes Electron run as plain Node — spec G1).
// - Defaults HANGAR_HOME to ~/.hangar-dev for `dev` and ~/.hangar for `--built` (spec §15.3).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = process.argv.includes('--built');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ELECTRON_')) delete env[key];
}
// `??=` would keep an exported-but-empty HANGAR_HOME, resolving every derived path against cwd.
if (!env.HANGAR_HOME) env.HANGAR_HOME = join(homedir(), built ? '.hangar' : '.hangar-dev');
env.HANGAR_APP_ROOT = root.replace(/\/$/, '');

const bin = join(root, 'node_modules', '.bin', built ? 'electron' : 'electron-vite');
const args = built ? ['.'] : ['dev'];
console.log(`[hangar] HANGAR_HOME=${env.HANGAR_HOME}  →  ${built ? 'electron .' : 'electron-vite dev'}`);
const child = spawn(bin, args, { cwd: root, env, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[hangar] cannot launch ${bin}: ${err.code}. Run \`npm install\` (Electron is installed in Plan 02).`);
  process.exit(1);
});
// A signal-killed child reports code === null; without the signal branch that reads as success.
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
