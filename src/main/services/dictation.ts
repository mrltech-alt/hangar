// Dictation — spec 2026-09-18 §4. Main owns the helper process (`mac/dictate/main.swift`).
//
// What this file decides: when a helper is spawned, how it is told to stop, how long it is given, and
// that it is always reaped. What it does NOT decide: what a stdout line means, which state follows or
// any sentence the user reads. All of that is `shared/dictation.ts`, and this file only drives it.
// Nothing here writes to a session or knows about IPC: `onUpdate` hands every change to the caller,
// which turns it into the `dictation:event` broadcast and the one session write (plan Task 7).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { stripUntrustedText } from '../../../shared/agent-name.ts';
import {
  DICTATION_IDLE, HELPER_COMMANDS, createDictationParser, dictationReducer, endedWith, isAllowed,
  type DictationAction, type DictationOutcome, type DictationParser, type DictationState,
} from '../../../shared/dictation.ts';
import { cleanEnv } from '../util/exec.ts';

/** Spec §4.5: recording stops itself after this long. Passed to the helper AND held here. */
export const MAX_RECORDING_SECONDS = 120;

/**
 * How long a `stop` gets to produce the final before the helper is killed (plan Task 6). The
 * helper's own finalize watchdog is 8 s, so a helper that is merely slow answers before this does.
 */
export const STOP_CEILING_MS = 10_000;

/**
 * How long a helper whose run is over gets to exit by itself before it is SIGKILLed: after a final
 * or an error line (it exits right after writing one), and after the SIGTERM a cancel sends (the
 * helper's own cancel, which exits on the spot).
 */
export const EXIT_GRACE_MS = 2_000;

/** How much of the helper's stderr is kept for the log. The rest is read and dropped. */
export const STDERR_TAIL_BYTES = 4 * 1024;

/** How much of an `error` line's own `message` goes into the log. */
const LOG_MESSAGE_MAX = 300;

export type Cancel = () => void;

/**
 * `setTimeout` as a dependency, so tests can drive the 10 s ceiling and the 120 s cap on a clock of
 * their own instead of waiting for them. Returns the function that clears the timer.
 */
export type Schedule = (ms: number, fn: () => void) => Cancel;

export const realSchedule: Schedule = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * One change, as the caller sees it. `outcome` is set on exactly one update per run — the one that
 * ended it — and is the only thing that may cause a write (`{ kind: 'write' }`).
 */
export interface DictationUpdate {
  /** The run this belongs to: the number `start()` returned. Only one run is ever alive. */
  runId: number;
  state: DictationState;
  outcome: DictationOutcome | null;
}

export interface DictationServiceDeps {
  /**
   * ABSOLUTE path to the `hangar-dictate` binary. The caller resolves it; this file reads no Electron
   * global, which is what lets the tests run a fake. In a checkout it is
   * `<repoRoot>/resources/bin/hangar-dictate` (`DICTATE_BINARY` in `scripts/build-dictate.ts`), and
   * the packaged app carries it at the same path under its own `repoRoot` (`electron-builder.yml`'s
   * `resources/bin` entry). `src/main/index.ts` passes it; nothing here assumes one.
   *
   * Absolute because `spawn` looks a bare name up on `PATH`, which would run whatever
   * `hangar-dictate` it found first. Nothing is cached: each start spawns afresh, so a helper built
   * after "Dictation is not built" is picked up by the next press, without a restart.
   */
  helperPath: string;
  /** The helper's environment — main's sanitised `childEnv`. `ELECTRON_*` is stripped again here (G1). */
  env: Record<string, string>;
  /**
   * Every state change, in order, synchronously. A throw is caught and logged: it must not tear down
   * a stdout handler, and in Electron main an uncaught exception ends the app.
   */
  onUpdate: (update: DictationUpdate) => void;
  /** Diagnostics only. Never receives transcript text. */
  log: (line: string) => void;
  /** `--locale` for the helper. Omitted, the helper uses the system locale. */
  locale?: string;
  /** Defaults to `realSchedule`. */
  schedule?: Schedule;
  /** Defaults to `MAX_RECORDING_SECONDS`. */
  maxSeconds?: number;
  /** Defaults to `STOP_CEILING_MS`. */
  stopCeilingMs?: number;
  /** Defaults to `EXIT_GRACE_MS`. */
  exitGraceMs?: number;
}

/**
 * `DICTATION_BUSY`: a helper process is still alive. `DICTATION_DISPOSED`: the app is quitting.
 * Both keep their `code` across `toIpcError`.
 */
export type DictationServiceErrorCode = 'DICTATION_BUSY' | 'DICTATION_DISPOSED';

export class DictationServiceError extends Error {
  readonly code: DictationServiceErrorCode;
  constructor(code: DictationServiceErrorCode, message: string) {
    super(message);
    this.name = 'DictationServiceError';
    this.code = code;
  }
}

export interface DictationService {
  /**
   * Spawns a helper and starts a run; returns the run's id. Throws `DICTATION_BUSY` while a helper
   * PROCESS is alive — which includes the moments after its run has ended (a final, a cancel) and
   * before the process has gone — and never queues. A helper that cannot be spawned does not throw:
   * the run ends at once as `NOT_BUILT` (missing binary) or `CRASHED`, through `onUpdate`.
   */
  start(): number;
  /**
   * Sends `stop` and waits up to `STOP_CEILING_MS` for the final, then kills the helper and ends the
   * run as `CRASHED`. Only while recording: before `ready` the helper would hold the stop and answer
   * NO_INPUT, so the request there is `cancel` (`toggleRequest` says so). Returns false, and sends
   * nothing, when the current phase does not accept a stop.
   */
  stop(): boolean;
  /**
   * Ends the run at once as `cancelled` (nothing is written) and kills the helper: SIGTERM, which is
   * the helper's own cancel, then SIGKILL if it is still there `EXIT_GRACE_MS` later. Returns false
   * when no run is active.
   */
  cancel(): boolean;
  state(): DictationState;
  /** A helper process is alive: spawned and not yet `close`d. THIS is what refuses a start, not `state()`. */
  busy(): boolean;
  /** Resolves once no helper process is alive. */
  reaped(): Promise<void>;
  /**
   * App quit. Ends any run silently (no further `onUpdate`), SIGKILLs the helper at once — there is
   * no time left to escalate — and refuses every later start. Resolves once the helper has closed.
   * If main dies without calling this, the helper still goes: its stdin reaching EOF is a cancel.
   */
  dispose(): Promise<void>;
}

/**
 * The helper's argv (CLAUDE.md rule 1: an array, never a shell string). `--max-seconds` is always
 * passed, so the helper's own cap and main's are the same number; `--locale` only when one is set.
 */
export function helperArgs(opts: { maxSeconds: number; locale?: string }): string[] {
  const args = ['--max-seconds', String(opts.maxSeconds)];
  if (opts.locale !== undefined && opts.locale !== '') args.push('--locale', opts.locale);
  return args;
}

/** The last `max` bytes of `tail` + `chunk`. Bounded however much the helper writes. */
export function keepTail(tail: Uint8Array, chunk: Uint8Array, max: number): Uint8Array {
  // A copy, never a view: `Buffer#slice` is a view, and a view pins the pipe's whole chunk.
  if (chunk.length >= max) return new Uint8Array(chunk.subarray(chunk.length - max));
  const keep = Math.min(tail.length, max - chunk.length);
  const out = new Uint8Array(keep + chunk.length);
  out.set(tail.subarray(tail.length - keep));
  out.set(chunk, keep);
  return out;
}

/** One log-safe line: controls and invisibles gone, whitespace collapsed, bounded. */
function logLine(text: string, max: number): string {
  const line = stripUntrustedText(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `…${line.slice(line.length - max)}` : line;
}

interface Helper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly parser: DictationParser;
  stderrTail: Uint8Array;
  /** Node's code when the SPAWN failed (`ENOENT` is an unbuilt checkout); null for a real process. */
  spawnError: string | null;
  /** This helper's run ended in an error — its stderr tail is then worth logging. */
  failed: boolean;
  /** Set on `close`: the process is gone and its handle is inert. */
  closed: boolean;
  /** The SIGKILL owed if the process outstays its run; see `EXIT_GRACE_MS`. */
  killTimer: Cancel | null;
}

export function createDictationService(deps: DictationServiceDeps): DictationService {
  if (!isAbsolute(deps.helperPath)) {
    throw new Error(`dictation helper path must be absolute, got ${JSON.stringify(deps.helperPath)}`);
  }
  const schedule = deps.schedule ?? realSchedule;
  const maxSeconds = deps.maxSeconds ?? MAX_RECORDING_SECONDS;
  const stopCeilingMs = deps.stopCeilingMs ?? STOP_CEILING_MS;
  const exitGraceMs = deps.exitGraceMs ?? EXIT_GRACE_MS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error(`maxSeconds must be a positive number, got ${maxSeconds}`);

  let state: DictationState = DICTATION_IDLE;
  let runId = 0;
  /**
   * The process handle — non-null from spawn until its `close` has been handled. Single-flight is on
   * THIS and never on `state`: `idle` means the run is over, not that the helper has exited, and
   * after a cancel or a final the reducer is idle while the process may still be on its way out.
   */
  let helper: Helper | null = null;
  /** Inside `start()`, so an `onUpdate` that calls `start()` again cannot spawn a second helper. */
  let launching = false;
  let capTimer: Cancel | null = null;
  let ceilingTimer: Cancel | null = null;
  let disposed = false;
  let waiters: Array<() => void> = [];

  const report = (update: DictationUpdate): void => {
    if (disposed) return;
    try {
      deps.onUpdate(update);
    } catch (e) {
      deps.log(`onUpdate threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** SIGKILL if the process is still there `exitGraceMs` from now. Idempotent. */
  const owedExit = (h: Helper): void => {
    if (h.closed || h.killTimer !== null) return;
    h.killTimer = schedule(exitGraceMs, () => {
      h.killTimer = null;
      if (h.closed) return;
      deps.log(`helper pid=${h.child.pid} still running ${exitGraceMs} ms after its run ended; killing it`);
      h.child.kill('SIGKILL');
    });
  };

  const clearCap = (): void => {
    capTimer?.();
    capTimer = null;
  };
  const clearCeiling = (): void => {
    ceilingTimer?.();
    ceilingTimer = null;
  };

  /**
   * The one place state changes. The timers follow the PHASE, so no path can leave one running for a
   * phase it has left: the cap lives exactly as long as `recording`, the ceiling as long as
   * `finalizing`. Side effects happen before `report`, so an `onUpdate` that acts re-entrantly sees
   * a service that is already consistent.
   */
  const dispatch = (action: DictationAction): void => {
    const prev = state;
    const next = dictationReducer(prev, action);
    if (next === prev) return;
    state = next;
    if (next.phase !== 'recording') clearCap();
    else if (prev.phase !== 'recording') capTimer = schedule(maxSeconds * 1000, onCap);
    if (next.phase !== 'finalizing') clearCeiling();
    else if (prev.phase !== 'finalizing') ceilingTimer = schedule(stopCeilingMs, onCeiling);
    const outcome = endedWith(prev, next);
    if (outcome !== null && helper !== null) {
      if (outcome.kind === 'error') helper.failed = true;
      owedExit(helper);
    }
    report({ runId, state: next, outcome });
  };

  const sendStop = (h: Helper, why: string): void => {
    deps.log(`${why}; sending stop to pid=${h.child.pid}`);
    h.child.stdin.write(HELPER_COMMANDS.stop);
    dispatch({ type: 'stop' });
  };

  /**
   * The 120 s cap, measured from `ready` exactly as the helper measures `--max-seconds`: before
   * `ready` the microphone is not open yet, and a first-use model download may legitimately take
   * longer than 120 s. The helper finalizes by itself at the same moment, so normally this finds the
   * run already over. If it does not, the helper is not honouring its own cap, and this is the user
   * pressing stop on its behalf — the words so far are still worth having — with the ceiling behind
   * it for a helper that ignores that too.
   */
  const onCap = (): void => {
    capTimer = null;
    if (helper === null || state.phase !== 'recording') return;
    sendStop(helper, `${maxSeconds} s cap reached`);
  };

  /**
   * No final `stopCeilingMs` after the stop: the helper is wedged. Kill it, and end the run NOW as a
   * crash. This is the one `closed` not dispatched from the child's `close` event, deliberately: that
   * rule exists so a final still in the pipe at `exit` is not lost, and at the ceiling there is no
   * final left to wait for — one that lands in the next millisecond must not be written, and the
   * outcome must not wait on a process that may not die promptly. The reducer ignores everything
   * after this, including the real `closed` when `close` comes.
   */
  const onCeiling = (): void => {
    ceilingTimer = null;
    if (state.phase !== 'finalizing') return;
    const h = helper;
    deps.log(`no final ${stopCeilingMs} ms after stop; killing pid=${h?.child.pid}`);
    h?.child.kill('SIGKILL');
    dispatch({ type: 'closed' });
  };

  const onClose = (h: Helper, code: number | null, signal: NodeJS.Signals | null): void => {
    h.closed = true;
    h.killTimer?.();
    h.killTimer = null;
    // `close`, never `exit`: at `exit` stdout may still hold the final. And the parser's last line —
    // one written without its newline — before `closed`, or the run would end as a crash first.
    for (const event of h.parser.end()) dispatch({ type: 'event', event });
    dispatch({ type: 'closed', helperMissing: h.spawnError === 'ENOENT' });
    const how = h.spawnError !== null ? `could not start (${h.spawnError})` : `exited code=${code} signal=${signal}`;
    const tail = h.failed || code !== 0 || signal !== null ? logLine(new TextDecoder().decode(h.stderrTail), STDERR_TAIL_BYTES) : '';
    deps.log(`helper pid=${h.child.pid ?? '-'} ${how}${tail === '' ? '' : `; stderr: ${tail}`}`);
    helper = null;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  const spawnHelper = (): Helper | null => {
    const args = helperArgs({ maxSeconds, locale: deps.locale });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(deps.helperPath, args, { env: cleanEnv(deps.env) });
    } catch (e) {
      // ENOENT and EACCES arrive as an `error` event; only the rest (a bad argument, an unrunnable
      // file) is thrown. There is no process, so the run ends here.
      const code = (e as NodeJS.ErrnoException).code;
      deps.log(`could not spawn ${deps.helperPath}: ${e instanceof Error ? e.message : String(e)}`);
      dispatch({ type: 'start' });
      dispatch({ type: 'closed', helperMissing: code === 'ENOENT' });
      return null;
    }
    const h: Helper = { child, parser: createDictationParser(), stderrTail: new Uint8Array(0), spawnError: null, failed: false, closed: false, killTimer: null };
    // Every stream and the child get an `error` listener: an unhandled one is thrown, and in Electron
    // main that ends the app. A failed spawn (pid undefined) is followed by `close`, which ends the run.
    child.on('error', (e: Error) => {
      if (child.pid === undefined) h.spawnError = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      deps.log(`helper error: ${e.message}`);
    });
    // EPIPE: a stop written to a helper that has just exited. The exit is what matters, and `close` reports it.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', (e) => deps.log(`helper stdout error: ${e.message}`));
    child.stderr.on('error', (e) => deps.log(`helper stderr error: ${e.message}`));
    // BYTES, straight in. Never `setEncoding`: a chunk decoded on its own has already lost a
    // character the pipe split in two, and the parser refuses strings for exactly that reason.
    child.stdout.on('data', (chunk: Buffer) => {
      for (const event of h.parser.feed(chunk)) {
        // The helper's own message is for the log; what the user reads is `dictationMessage(code)`.
        if (event.t === 'error') deps.log(`helper says ${event.code}: ${logLine(event.message, LOG_MESSAGE_MAX)}`);
        dispatch({ type: 'event', event });
      }
    });
    // Diagnostics: read (a full pipe would block the helper mid-write), never parsed, never shown.
    child.stderr.on('data', (chunk: Buffer) => {
      h.stderrTail = keepTail(h.stderrTail, chunk, STDERR_TAIL_BYTES);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => onClose(h, code, signal));
    if (child.pid !== undefined) deps.log(`helper pid=${child.pid} started: ${deps.helperPath} ${args.join(' ')}`);
    return h;
  };

  const reaped = (): Promise<void> => {
    if (helper === null) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  };

  return {
    start() {
      if (disposed) throw new DictationServiceError('DICTATION_DISPOSED', 'Hangar is quitting.');
      if (helper !== null || launching) {
        // Fires only between a run's end and its helper's exit (a toggle never asks for a start while
        // a run is active) — which a press straight after a run ends CAN meet. The message is for the
        // log: the renderer says `dictationMessage('BUSY')` for this code (`dictationRefusal`).
        throw new DictationServiceError('DICTATION_BUSY', 'Dictation is still running. Wait for it to finish.');
      }
      launching = true;
      try {
        runId += 1;
        const h = spawnHelper();
        if (h !== null) {
          helper = h;
          // After the handle is held, so an `onUpdate` that starts again is refused, not doubled.
          dispatch({ type: 'start' });
        }
        return runId;
      } finally {
        launching = false;
      }
    },
    stop() {
      if (helper === null || !isAllowed(state, 'stop')) return false;
      sendStop(helper, 'stop requested');
      return true;
    },
    cancel() {
      const h = helper;
      if (h === null || !isAllowed(state, 'cancel')) return false;
      deps.log(`cancel requested; terminating pid=${h.child.pid}`);
      h.child.kill('SIGTERM');
      dispatch({ type: 'cancel' });
      return true;
    },
    state: () => state,
    busy: () => helper !== null || launching,
    reaped,
    dispose() {
      if (!disposed) {
        disposed = true;
        const h = helper;
        if (h !== null) {
          h.child.kill('SIGKILL');
          dispatch({ type: 'cancel' });
        }
        clearCap();
        clearCeiling();
      }
      return reaped();
    },
  };
}
