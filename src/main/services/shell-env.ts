// GUI apps do not inherit the interactive shell PATH (spec §9, G4, G5). Ask the login shell once, with sentinels.
import { randomBytes } from 'node:crypto';
import { FIELD_SEP, FIELD_SEP_PRINTF, extractBetween, sentinels } from '../../../shared/shell-probe.ts';
import { cleanEnv, type Exec } from '../util/exec.ts';

export interface ShellEnv {
  path: string;
  nodeBin: string | null;
  claudeBin: string | null;
  claudeVersion: string | null;
  shell: string;
  source: 'shell' | 'fallback';
  /**
   * Why the answer is degraded, or null when the shell answered in full. `catch { return fallback }`
   * threw away the `timedOut`/`syscallCode` that ExecError carries precisely so callers could tell
   * a slow `.zshrc` apart from a missing shell — and §8.3 puts this in Host status, where "fallback"
   * with no reason is a dead end for whoever is trying to fix their machine.
   */
  reason: string | null;
}

/** Fields the probe asks for, in order. A shorter split means the payload sheared (see M1 below). */
const FIELD_COUNT = 4;

export async function resolveShellEnv(opts: { shell: string; exec: Exec; fallbackPath: string; timeoutMs?: number }): Promise<ShellEnv> {
  const degraded = (reason: string): ShellEnv => ({
    path: `${opts.fallbackPath}:/opt/homebrew/bin:/usr/local/bin`,
    nodeBin: null,
    claudeBin: null,
    claudeVersion: null,
    shell: opts.shell,
    source: 'fallback',
    reason,
  });

  // A fresh nonce per invocation: the sentinels must be unguessable by the rc files this very
  // command runs. See shared/shell-probe.ts — `.zshrc` forged the old fixed BEGIN marker, and
  // `.zlogout` (a login shell runs it AFTER the command) forged the old fixed END.
  const { begin, end } = sentinels(randomBytes(8).toString('hex'));
  // `\037` reaches printf verbatim through the single quotes.
  const script = `printf '${begin}%s${FIELD_SEP_PRINTF}%s${FIELD_SEP_PRINTF}%s${FIELD_SEP_PRINTF}%s${end}' "$PATH" "$(command -v node 2>/dev/null)" "$(command -v claude 2>/dev/null)" "$(claude --version 2>/dev/null | head -1)"`;

  let stdout: string;
  try {
    ({ stdout } = await opts.exec(opts.shell, ['-ilc', script], {
      timeoutMs: opts.timeoutMs ?? 10_000, // spec §9 rule 2
      env: cleanEnv(process.env),
      // The one place that overrides the SIGTERM default, because G5 forces this call onto `-i` and
      // an INTERACTIVE shell ignores SIGTERM: measured, a `.zshrc` that blocks for 20s returned
      // after 20030ms under a 1000ms timeout, and with SIGKILL after ~1005ms. bootstrap awaits this
      // before starting the session host, so an inert timeout is an unbounded launch (spec §11).
      // It reaches the shell process only — execFile is not `detached`, so anything the rc file
      // spawned is reparented to launchd rather than killed (true of SIGTERM here as well).
      killSignal: 'SIGKILL',
      // The payload is ~1 KB. Inheriting the 32 MB default lets a runaway rc file buffer 32 MB
      // inside Electron main.
      maxBuffer: 1024 * 1024,
    }));
  } catch (e) {
    // Duck-typed, not `instanceof ExecError`: `exec` is injectable and a stub may throw anything.
    const err = e as { timedOut?: unknown; syscallCode?: unknown };
    if (err.timedOut === true) return degraded('timeout');
    return degraded(typeof err.syscallCode === 'string' ? err.syscallCode : 'exec-failed');
  }

  const inner = extractBetween(stdout, begin, end);
  if (inner === null) return degraded('no-sentinel');
  const fields = inner.split(FIELD_SEP);
  // M1: without this a stray U+001F anywhere in PATH, or a printf that mishandles `\037`, shears
  // the payload silently — a 2-field split yielded `claudeBin: null` under `source: 'shell'`.
  if (fields.length !== FIELD_COUNT) return degraded('bad-field-count');
  const [path = '', node = '', claude = '', version = ''] = fields;
  // An empty PATH means falling back to `opts.fallbackPath`, and a result that uses the fallback
  // path must not claim to have come from the shell.
  if (path.length === 0) return degraded('empty-path');

  // `command -v` returns a BARE NAME for a shell function — the standard lazy-nvm wrapper — and
  // verified in both zsh and bash it prints `node`, not a path. Accepting that put `nodeBin: 'node'`
  // into config, and pickNodeBin then fell through to `/usr/local/bin/node` v22, which cannot parse
  // `.ts` at all: the exact failure §9 exists to prevent, on a machine whose shell resolves Node 24
  // perfectly. Guarded here in JS so it holds for every shell, rather than in the probe script.
  const dropped: string[] = [];
  const absolute = (value: string, what: string): string | null => {
    if (value.length === 0) return null;
    if (!value.startsWith('/')) {
      dropped.push(what);
      return null;
    }
    return value;
  };
  const nodeBin = absolute(node, 'node');
  const claudeBin = absolute(claude, 'claude');

  return {
    path,
    nodeBin,
    claudeBin,
    claudeVersion: version.trim().length > 0 ? version.trim() : null,
    shell: opts.shell,
    source: 'shell',
    reason: dropped.length > 0 ? `not-absolute:${dropped.join(',')}` : null,
  };
}

export const WELL_KNOWN_NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

/** Which rung of the ladder a node binary came from. §8.3 shows this in Host status. */
export type NodeBinFrom = 'config' | 'shell' | 'well-known';

export interface PickedNodeBin {
  path: string;
  from: NodeBinFrom;
}

/**
 * The node that will run the session host, and — the point of the return shape — WHERE it came
 * from. "The user configured this" and "nothing else existed, so here is `/usr/local/bin/node`" are
 * very different facts, and the caller both writes the result to `config.json` and surfaces it in
 * Host status (§8.3). `null` still means §8.3's "→ error".
 */
export function pickNodeBin(input: { configured: string | null; fromShell: string | null; exists: (p: string) => boolean }): PickedNodeBin | null {
  const rungs: [NodeBinFrom, string | null][] = [
    ['config', input.configured],
    ['shell', input.fromShell],
    ...WELL_KNOWN_NODE.map((p): [NodeBinFrom, string] => ['well-known', p]),
  ];
  for (const [from, candidate] of rungs) {
    if (candidate !== null && input.exists(candidate)) return { path: candidate, from };
  }
  return null;
}
