import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_REPLY_TIMEOUT_MS, MAX_SOCKET_PATH_LEN } from '../../shared/constants.ts';
import { FIELD_SEP, FIELD_SEP_PRINTF, extractBetween, sentinels } from '../../shared/shell-probe.ts';
import { ensureSpawnHelperExecutable, type PtyFixResult } from '../../host/pty-fix.ts';
import type { CliContext } from '../context.ts';
import { requestOnce } from '../socket.ts';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** What the interactive login shell resolves — the environment the host and agents actually get. */
export interface ShellTools {
  node: string;
  claude: string;
  claudeVersion: string;
  /** Why the probe produced nothing readable, or null when the shell answered. */
  error: string | null;
}

/** `fix` is injectable so §19.4's fixture test can run against a copied node-pty tree. */
export function checkSpawnHelper(fix: () => PtyFixResult = ensureSpawnHelperExecutable): Check {
  const name = 'node-pty spawn-helper';
  const r = fix();
  // Three distinct worlds, previously collapsed into one "not installed" message: node-pty absent,
  // node-pty present but shipping no spawn-helper (a future version may drop it, and G3 stops
  // applying), and chmod refused (read-only volume, or a packaged app owned by another user).
  if (r.packageDir === null) return { name, status: 'fail', detail: 'node-pty is not installed (run npm install)' };
  if (r.failed.length > 0) {
    return { name, status: 'fail', detail: r.failed.map((f) => `could not chmod ${f.path}: ${f.error}`).join('; ') };
  }
  if (r.checked.length === 0) {
    return { name, status: 'warn', detail: `node-pty at ${r.packageDir} has no spawn-helper at the expected paths; G3 may no longer apply` };
  }
  return { name, status: 'ok', detail: r.fixed.length > 0 ? `fixed execute bit on ${r.fixed.join(', ')}` : 'executable' };
}

/** Uses an interactive login shell, exactly like the PTY sessions do (spec G4/G5). */
export function readShellTools(shell: string): ShellTools {
  // BEGIN *and* END, both nonce-framed — the same framing shell-env.ts uses, from the same module.
  // Opening the payload without closing it meant everything the shell printed afterwards landed in
  // the last field, and `.zlogout` runs AFTER the command on a login shell. Measured with a
  // `.zlogout` containing nothing but `echo "Goodbye."`, checkStaleGlobalClaude flipped from
  // ok to warn — it compares version strings for equality, so any trailing byte fabricates a
  // warning. `hangar doctor` is what people run when things are already broken; a warning it
  // invents is worse than one it misses.
  const { begin, end } = sentinels(randomBytes(8).toString('hex'));
  const script = `printf '${begin}%s${FIELD_SEP_PRINTF}%s${FIELD_SEP_PRINTF}%s${end}' "$(command -v node)" "$(command -v claude)" "$(claude --version 2>/dev/null | head -1)"`;
  const out = execFileSync(shell, ['-ilc', script], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  // An unreadable probe is NOT the same finding as a missing `claude`. Collapsing the two reported
  // "claude not found in the interactive login shell" on a machine where claude is installed and
  // fine — the same invented-diagnosis problem the framing above exists to prevent.
  const inner = extractBetween(out, begin, end);
  if (inner === null) return { node: '', claude: '', claudeVersion: '', error: 'the shell printed no readable probe output' };
  const fields = inner.split(FIELD_SEP);
  if (fields.length !== 3) return { node: '', claude: '', claudeVersion: '', error: `the probe returned ${fields.length} fields, expected 3` };
  const [node = '', claude = '', claudeVersion = ''] = fields;
  return { node, claude, claudeVersion: claudeVersion.trim(), error: null };
}

export function checkShellTools(tools: ShellTools): Check {
  const name = 'interactive shell tools';
  if (tools.error !== null) return { name, status: 'fail', detail: `could not read the interactive login shell: ${tools.error}` };
  if (tools.claude.length === 0) return { name, status: 'fail', detail: 'claude not found in the interactive login shell' };
  return { name, status: 'ok', detail: `node=${tools.node} claude=${tools.claude} (${tools.claudeVersion})` };
}

/**
 * The node the LOGIN SHELL resolves is the one that will run the session host — not the node
 * running this CLI. Reporting on `process.version` here would say everything is fine in exactly the
 * case this check exists for: verified on this machine that `/usr/local/bin/node` is v22 (ABI 127)
 * and cannot parse `.ts` at all, so a host started with it dies instantly with a SyntaxError.
 *
 * A literal ABI-number comparison is the wrong test — node-pty 1.1.0 is N-API and keys its prebuilds
 * by platform-arch, not ABI — so this loads node-pty under that node instead, which is the thing
 * that actually has to work. Spec §8.3's "`hangar doctor` detects this and prints `npm rebuild
 * node-pty`" is this row.
 */
export function checkHostNode(nodePath: string): Check {
  const name = 'node that will run the host';
  if (nodePath.length === 0) return { name, status: 'fail', detail: 'the interactive login shell resolves no `node`' };
  // A bare name (`command -v` on a shell function — lazy nvm) would be resolved by execFileSync
  // against THIS process's PATH, so the row would report on a different binary than the host gets.
  if (!nodePath.startsWith('/')) {
    return { name, status: 'fail', detail: `the shell resolves \`node\` to "${nodePath}", not a path — it is a shell function or alias, so the host cannot be started with it` };
  }
  try {
    const out = execFileSync(nodePath, ['-e', "require('node-pty'); process.stdout.write(process.version)"], {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: new URL('../..', import.meta.url).pathname,
    });
    const major = Number(out.trim().replace(/^v/, '').split('.')[0]);
    if (!Number.isFinite(major) || major < 24) {
      return { name, status: 'fail', detail: `${nodePath} is ${out.trim()}; the host is run as type-stripped TypeScript and needs Node 24+` };
    }
    return { name, status: 'ok', detail: `${nodePath} ${out.trim()} loads node-pty` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const hint = /NODE_MODULE_VERSION|dlopen|invalid ELF|mach-o/i.test(message) ? ' — run `npm rebuild node-pty`' : '';
    return { name, status: 'fail', detail: `${nodePath} cannot load node-pty${hint}: ${message.split('\n')[0]}` };
  }
}

/**
 * §11.4 asks for the interactive version *versus* `/usr/local/bin`. Warning merely because the file
 * exists would fire on a machine that is perfectly configured — the official installer puts `claude`
 * there, and for those users it IS the interactive one — which teaches people to ignore the warning.
 */
export function checkStaleGlobalClaude(tools: ShellTools, globalPath = '/usr/local/bin/claude'): Check {
  const name = 'stale global claude';
  if (!existsSync(globalPath)) return { name, status: 'ok', detail: 'none' };
  if (tools.claude === globalPath) return { name, status: 'ok', detail: `the interactive shell uses ${globalPath}` };
  let globalVersion = 'unknown version';
  try {
    globalVersion = execFileSync(globalPath, ['--version'], { encoding: 'utf8', timeout: 20_000 }).split('\n')[0]?.trim() ?? globalVersion;
  } catch {
    // unreadable or not executable — still worth reporting the split
  }
  if (globalVersion === tools.claudeVersion) {
    return { name, status: 'ok', detail: `${globalPath} is a different file but the same version (${globalVersion})` };
  }
  return {
    name,
    status: 'warn',
    detail: `interactive ${tools.claudeVersion} at ${tools.claude} vs ${globalVersion} at ${globalPath}; non-interactive shells would run the latter (spec G4). Hangar always uses an interactive login shell.`,
  };
}

/**
 * The profile itself: does `HANGAR_HOME` exist and is it usable, and does its socket path fit?
 * Without this, a G9 over-length socket path or an unwritable home both surface only as
 * "session host: not running", which reads like the app simply has not been started yet.
 */
export function checkProfile(home: string): Check {
  const name = 'profile';
  const socketPath = join(home, 'run', 'host.sock');
  const bytes = new TextEncoder().encode(socketPath).length;
  if (bytes > MAX_SOCKET_PATH_LEN) {
    return { name, status: 'fail', detail: `socket path is ${bytes} bytes (limit ${MAX_SOCKET_PATH_LEN}); choose a shorter HANGAR_HOME than ${home}` };
  }
  if (!existsSync(home)) return { name, status: 'warn', detail: `${home} does not exist yet; Hangar creates it on launch` };
  try {
    if (!statSync(home).isDirectory()) return { name, status: 'fail', detail: `${home} exists but is not a directory` };
  } catch (e) {
    return { name, status: 'fail', detail: `${home} is unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { name, status: 'ok', detail: `${home} (socket path ${bytes} bytes)` };
}

/**
 * A ping alone can only ever say "not running", which is indistinguishable from "the app has not
 * been started" — even when the host is crash-looping. `host/main.ts` writes the real reason to
 * `host.log` and exits 1, so read it.
 */
export async function checkHost(home: string, socketPath: string): Promise<Check> {
  const name = 'session host';
  const reply = await requestOnce(socketPath, { t: 'ping', seq: 1 }, CLI_REPLY_TIMEOUT_MS);
  if (reply?.t === 'pong') return { name, status: 'ok', detail: `reachable at ${socketPath}` };

  let tail = '';
  try {
    tail = readFileSync(join(home, 'logs', 'host.log'), 'utf8').trimEnd().split('\n').slice(-20).join('\n');
  } catch {
    // no log yet — the host has simply never run here
  }
  const failed = tail.split('\n').filter((l) => l.includes('host failed to start') || l.includes('NODE_MODULE_VERSION'));
  if (failed.length > 0) {
    return { name, status: 'fail', detail: `not running, and the last start failed: ${failed[failed.length - 1]}` };
  }
  return { name, status: 'warn', detail: `not running (${socketPath}); Hangar starts it on launch` };
}

export function checkDisk(path: string): Check {
  const target = existsSync(path) ? path : homedir();
  const s = statfsSync(target);
  const gb = (s.bavail * s.bsize) / 1e9;
  return { name: 'disk space', status: gb >= 5 ? 'ok' : gb >= 2 ? 'warn' : 'fail', detail: `${gb.toFixed(1)} GB free on ${target}` };
}

/** One throwing check must not destroy the report — this is the tool people run when things break. */
function safe(name: string, fn: () => Check): Check {
  try {
    return fn();
  } catch (e) {
    return { name, status: 'fail', detail: `check threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function collectChecks(ctx: CliContext): Promise<Check[]> {
  // `unset()`'s reasoning applies here too: SHELL="" is what a spawn-built env produces, and passing
  // it to execFileSync yields a fabricated FAIL ("the argument 'file' cannot be empty").
  const shell = ctx.env.SHELL === undefined || ctx.env.SHELL === '' ? '/bin/zsh' : ctx.env.SHELL;
  let tools: ShellTools = { node: '', claude: '', claudeVersion: '', error: 'not probed' };
  let toolsCheck: Check;
  try {
    tools = readShellTools(shell);
    toolsCheck = checkShellTools(tools);
  } catch (e) {
    toolsCheck = { name: 'interactive shell tools', status: 'fail', detail: e instanceof Error ? e.message : String(e) };
  }
  return [
    safe('profile', () => checkProfile(ctx.home)),
    safe('node-pty spawn-helper', () => checkSpawnHelper()),
    toolsCheck,
    safe('node that will run the host', () => checkHostNode(tools.node)),
    safe('stale global claude', () => checkStaleGlobalClaude(tools)),
    await checkHost(ctx.home, ctx.socketPath),
    safe('disk space', () => checkDisk(ctx.home)),
  ];
}

export async function runDoctor(_args: string[], ctx: CliContext, checks?: Check[]): Promise<number> {
  const results = checks ?? (await collectChecks(ctx));
  for (const c of results) ctx.stdout.write(`${c.status.toUpperCase().padEnd(4)} ${c.name}: ${c.detail}\n`);
  return results.some((c) => c.status === 'fail') ? 1 : 0;
}
