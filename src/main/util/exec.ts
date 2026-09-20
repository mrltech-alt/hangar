// The only way main runs child processes: execFile with argument arrays, never a shell string (spec §16).
import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number;
  /**
   * Signal used when `timeoutMs` expires. Defaults to SIGTERM, and callers should leave it there:
   * git registers a sigchain handler that unlinks `index.lock` on SIGTERM, and SIGKILL cannot be
   * caught, so the lock outlives the process. Measured on a timed-out `git add`:
   * `{"killSignal":"SIGTERM","locks":[]}` vs `{"killSignal":"SIGKILL","locks":["index.lock"]}`,
   * after which every later git call in that worktree dies with
   * `fatal: Unable to create …/.git/index.lock: File exists.` — a permanently wedged worktree.
   * Only shell-env.ts overrides it, where an interactive shell IGNORES SIGTERM (G5).
   */
  killSignal?: NodeJS.Signals;
  /**
   * Cancels the child: the promise rejects with `ExecError.aborted` set and the child is sent
   * `killSignal`. Plan 06's Linear look-up is the caller: a `claude -p` the user can stop from the
   * dialog.
   *
   * Measured on Node 24.15: execFile's own abort handling sends plain SIGTERM whatever `killSignal`
   * says, and rejects at once, before the child has exited — a child ignoring TERM, given
   * `killSignal: 'SIGKILL'`, was still alive a second later. The abort listener in `exec` is what
   * makes `killSignal` apply to an abort. The rejection still does not wait for the child to exit.
   */
  signal?: AbortSignal;
}

export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export class ExecError extends Error {
  readonly file: string;
  readonly args: string[];
  /** The child's exit status, or null when it never got one (spawn failure, timeout, maxBuffer). */
  readonly code: number | null;
  readonly stderr: string;
  /** Whatever was on stdout before the failure — a git command can be useful even when it exits non-zero. */
  readonly stdout: string;
  /** Node's string code (`ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), or null for a plain non-zero exit. */
  readonly syscallCode: string | null;
  /** Killed by our own timeout, as opposed to failing on its own terms. */
  readonly timedOut: boolean;
  /** Killed because the caller's `signal` aborted — neither a timeout nor the child failing on its own terms. */
  readonly aborted: boolean;

  constructor(
    file: string,
    args: string[],
    code: number | null,
    stderr: string,
    detail: string,
    extra: { stdout?: string; syscallCode?: string | null; timedOut?: boolean; aborted?: boolean } = {},
  ) {
    const tail = stderr.trim().split('\n').slice(0, 10).join('\n');
    super(`${file} ${args.join(' ')} failed (${code ?? detail}): ${tail}`.trim());
    this.name = 'ExecError';
    this.file = file;
    this.args = args;
    this.code = code;
    this.stderr = stderr;
    // These three exist so callers stop distinguishing failures by substring-matching `message`:
    // a spawn failure, a timeout and a maxBuffer overflow all arrive with `code === null`, and
    // treating them alike is how an over-large `git show` got reported as "file added".
    this.stdout = extra.stdout ?? '';
    this.syscallCode = extra.syscallCode ?? null;
    this.timedOut = extra.timedOut ?? false;
    this.aborted = extra.aborted ?? false;
  }
}

/** process.env without ELECTRON_* (spec G1) and without undefined values, plus overrides. */
export function cleanEnv(env: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && !k.startsWith('ELECTRON_')) out[k] = v;
  }
  // Overrides are filtered too. Spreading them last would let a caller reintroduce exactly what this
  // function exists to remove — and §9 rule 5 says the PTY env has `ELECTRON_*` stripped, which is
  // built by passing overrides. The whole point of G1 is that one leaked `ELECTRON_RUN_AS_NODE`
  // makes a spawned `node` behave as plain Node, which fails in ways that look nothing like the cause.
  for (const [k, v] of Object.entries(overrides)) {
    if (!k.startsWith('ELECTRON_')) out[k] = v;
  }
  return out;
}

export const exec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const { signal } = opts;
    const killSignal = opts.killSignal ?? 'SIGTERM';
    const child = execFile(
      file,
      args,
      // `?? cleanEnv(process.env)`: a caller that omits `env` would otherwise inherit
      // ELECTRON_RUN_AS_NODE and every ELECTRON_* var (G1, spec §9 rule 4). worktree-setup's
      // `cp` call passes no env at all.
      { cwd: opts.cwd, env: opts.env ?? cleanEnv(process.env), timeout: opts.timeoutMs ?? 60_000, killSignal, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, encoding: 'utf8', signal },
      (err, stdout, stderr) => {
        // Not once the signal has aborted. Node calls this back synchronously from INSIDE the abort
        // dispatch, before later listeners run, and removing a listener that has not run yet cancels
        // it (both measured on Node 24.15) — so removing it here would stop `killOnAbort` from ever
        // sending `killSignal`. An aborted signal never fires again, and `once` removes it after it runs.
        if (signal && !signal.aborted) signal.removeEventListener('abort', killOnAbort);
        if (err) {
          const e = err as Error & { code?: number | string; killed?: boolean; signal?: string };
          const code = typeof e.code === 'number' ? e.code : null;
          const detail = typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.killed ? `killed by ${e.signal ?? 'timeout'}` : e.message;
          reject(new ExecError(file, args, code, stderr, detail, {
            stdout,
            syscallCode: typeof e.code === 'string' ? e.code : null,
            timedOut: e.killed === true,
            // An abort arrives as Node's `AbortError` through the child's 'error' event, never with
            // `killed` set, so `timedOut` above is already false for it.
            aborted: e.name === 'AbortError',
          }));
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
    // Node's abort sends SIGTERM regardless of `killSignal` (see `ExecOptions.signal`); this sends the
    // one the caller chose. `pid === undefined` is a child that never spawned (ENOENT): nothing to kill.
    function killOnAbort(): void {
      if (child.pid !== undefined) child.kill(killSignal);
    }
    if (signal) {
      // An already-aborted signal dispatches no event. Node handles that case on the next tick, so
      // this goes on the next tick too, after Node's own abort has rejected the promise.
      if (signal.aborted) process.nextTick(killOnAbort);
      else signal.addEventListener('abort', killOnAbort, { once: true });
    }
    if (opts.input !== undefined && child.stdin) {
      // A child can exit before reading stdin (`git check-ignore` in a non-repo prints a fatal and
      // exits immediately), and writing more than the ~64 KB pipe buffer then raises EPIPE. Without
      // this listener that surfaces as an unhandled 'error' event OUTSIDE this promise — so the
      // caller's try/catch cannot see it, and in Electron main it kills the whole app with no
      // dialog. Reproduced. Swallowing it is right: the real failure arrives on the exec callback
      // with the child's actual exit code and stderr.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
  });
