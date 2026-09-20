#!/usr/bin/env node
// End-to-end smoke test for the session host and CLI. Exit 0 = pass. Prints what it checked.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `HANGAR_SMOKE_ROOT` points the smoke at a tree other than this repo — specifically at a packaged
// `Hangar.app/Contents/Resources/app`, which is the only way to show that the artefact SHIPS a
// working Node half: node-pty's binding loading under the system Node rather than Electron's ABI
// (G2), the spawn-helper's execute bit (G3), and `bin/hangar` resolving inside a login shell.
// Everything else — HANGAR_HOME, the socket, the state mirror — stays in this script's own tmpdir.
const root = (process.env.HANGAR_SMOKE_ROOT ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\/$/, '');
// /tmp, not tmpdir(): macOS's /var/folders TMPDIR makes the socket path exceed the 104-byte
// limit and the host dies with EINVAL (G9). Do not "tidy" this into tmpdir().
const home = mkdtempSync('/tmp/hangar-smoke-');
const socketPath = join(home, 'run', 'host.sock');
const agentId = 'smoke-agent';
const shell = process.env.SHELL || '/bin/zsh';

function log(msg) { console.log(`[smoke] ${msg}`); }

/**
 * Cleanup must run on the FAILURE path too. The host is detached, unref'd and stdio-ignored, so
 * without this every failed `npm test` leaks a live daemon holding its socket, plus a tmpdir —
 * and a failing smoke test is exactly when someone runs it repeatedly.
 */
const cleanups = [];
function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best effort — we are on our way out */ }
  }
}
function fail(msg) {
  writeSync(2, `[smoke] FAIL: ${msg}\n`); // sync: under `npm test` stderr is a pipe and exit does not flush it
  cleanup();
  process.exit(1);
}
process.on('uncaughtException', (e) => fail(`unexpected error: ${e.stack ?? String(e)}`));
// Ctrl-C is the MOST likely way this gets interrupted — a slow or failing test is exactly when
// someone reaches for it — and Node runs no JS on the default SIGINT disposition, so without this
// the detached host survives in its own process group. Verified.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) fail(`timeout waiting for ${what}`); await sleep(25); }
}

cleanups.push(() => rmSync(home, { recursive: true, force: true }));

// 1. state mirror the CLI will read
mkdirSync(join(home, 'state', 'agents'), { recursive: true });
writeFileSync(join(home, 'state', 'agents', `${agentId}.json`), JSON.stringify({
  id: agentId, name: 'Smoke Agent', slug: 'smoke-agent', notes: '',
  workspaces: [{ projectName: 'demo', repoPath: '/tmp', branch: 'agent/smoke-agent', worktreePath: '/tmp' }],
  updatedAt: new Date().toISOString(),
}));

// 2. detached host, exactly as the app will launch it
const env = { ...process.env, HANGAR_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const hostProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'host/main.ts')], {
  env, detached: true, stdio: 'ignore',
});
hostProc.unref();
cleanups.push(() => { try { process.kill(hostProc.pid, 'SIGKILL'); } catch { /* already gone */ } });
await waitFor(() => existsSync(socketPath), 8000, 'host socket');
log(`host up (pid ${hostProc.pid})`);

// 3. NDJSON client
const received = [];
const socket = net.createConnection(socketPath);
socket.setEncoding('utf8');
let buf = '';
socket.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) received.push(JSON.parse(line)); } });
await new Promise((r) => socket.on('connect', r));
const send = (m) => socket.write(JSON.stringify(m) + '\n');
const take = async (pred, what) => { await waitFor(() => received.some(pred), 15000, what); const i = received.findIndex(pred); return received.splice(i, 1)[0]; };

send({ t: 'hello', role: 'app', version: 1, clientId: 'smoke' });
await take((m) => m.t === 'hello', 'hello');

// 4. a real interactive login shell with the agent env, running the real CLI shim
const ptyEnv = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('ELECTRON_')) ptyEnv[k] = v;
ptyEnv.HANGAR_HOME = home;
ptyEnv.HANGAR_SOCKET = socketPath;
ptyEnv.HANGAR_AGENT_ID = agentId;
ptyEnv.HANGAR_NODE = process.execPath;
ptyEnv.PATH = `${root}/bin:${ptyEnv.PATH || '/usr/bin:/bin'}`;
ptyEnv.TERM = 'xterm-256color';

// `command -v hangar` first: the PATH we inject is prepended BEFORE the rc files run, and rc files
// routinely prepend their own entries (nvm, homebrew). Without this assertion a developer with
// `ln -s <repo>/bin/hangar /usr/local/bin/hangar` installed could get a green smoke test for a
// DIFFERENT checkout's CLI — which is a false pass on the one test whose whole point is that the
// real shim resolves the way an agent resolves it. Plan 02's worktrees make that likelier.
send({ t: 'spawn', id: agentId, cwd: '/tmp', file: shell, args: ['-il'], env: ptyEnv, cols: 120, rows: 30,
  startupCommand: 'command -v hangar; hangar status --json; hangar rename "Renamed by smoke"; hangar note "left a note"' });
await take((m) => m.t === 'spawned', 'spawned');
send({ t: 'attach', id: agentId, cols: 120, rows: 30 });
await take((m) => m.t === 'snapshot', 'snapshot');

// No sentinel echoed into the shell: `Session.onExit` flushes before it emits `exit`, and both go
// out on the same socket, so the CLI's own relayed events are a sufficient completion signal. An
// echoed sentinel could match the PTY's echo of the command rather than its output — which the
// earlier version did, surviving only by accident of ZLE line-wrapping at cols:120.
let output = '';
socket.on('data', () => {
  for (const m of received) if (m.t === 'data') output += m.data;
  for (let i = received.length - 1; i >= 0; i--) if (received[i].t === 'data') received.splice(i, 1);
});

const rename = await take((m) => m.t === 'agentEvent' && m.cmd === 'rename', 'rename event');
if (rename.payload.name !== 'Renamed by smoke') fail(`unexpected rename payload ${JSON.stringify(rename.payload)}`);
const note = await take((m) => m.t === 'agentEvent' && m.cmd === 'note', 'note event');
if (note.payload.text !== 'left a note') fail(`unexpected note payload ${JSON.stringify(note.payload)}`);
log('rename + note relayed to the app client');

await waitFor(() => output.includes('"name": "Smoke Agent"'), 15000, 'hangar status --json output');
if (!output.includes(`${root}/bin/hangar`)) fail(`the login shell resolved a different hangar; got:\n${output.slice(-1500)}`);
log(`hangar resolved to ${root}/bin/hangar and status --json ran inside the login shell`);

// 5. reconnect against the SURVIVING daemon — spec §19.5 steps 5 and 6, and the thing Plan 02's
// app-restart and crash-recovery flows are built on. Unit tests cover a second client on a live
// in-process host; only this covers a client that goes away and comes back to a detached one.
socket.destroy();
const socket2 = net.createConnection(socketPath);
socket2.setEncoding('utf8');
let buf2 = '';
const received2 = [];
socket2.on('data', (c) => { buf2 += c; let i; while ((i = buf2.indexOf('\n')) !== -1) { const line = buf2.slice(0, i); buf2 = buf2.slice(i + 1); if (line) received2.push(JSON.parse(line)); } });
await new Promise((r) => socket2.on('connect', r));
const send2 = (m) => socket2.write(JSON.stringify(m) + '\n');
const take2 = async (pred, what) => { await waitFor(() => received2.some(pred), 15000, what); const i = received2.findIndex(pred); return received2.splice(i, 1)[0]; };

send2({ t: 'hello', role: 'app', version: 1, clientId: 'smoke-2' });
const hello2 = await take2((m) => m.t === 'hello', 'hello after reconnect');
const live = hello2.sessions.find((x) => x.id === agentId);
if (!live || live.exited) fail(`session did not survive the reconnect: ${JSON.stringify(hello2.sessions)}`);
send2({ t: 'attach', id: agentId, cols: 120, rows: 30 });
const snap2 = await take2((m) => m.t === 'snapshot', 'snapshot after reconnect');
if (!snap2.data.includes('Smoke Agent')) fail(`reattach snapshot lost the scrollback:\n${snap2.data.slice(-800)}`);
log('reconnected to the surviving daemon and reattached with scrollback intact');

send2({ t: 'write', id: agentId, data: 'exit\r' });
await take2((m) => m.t === 'exit', 'exit');
log('session exited');

// 6. shutdown and cleanup
send2({ t: 'shutdown', killSessions: true });
await waitFor(() => !existsSync(socketPath), 8000, 'socket removal');
socket2.destroy();
cleanup();
log('PASS');
