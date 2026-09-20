/**
 * The dictation service against a FAKE helper: a small script run by the system Node (its shebang is
 * this process's own `node`) that speaks the helper's protocol on stdout, reads `stop`/`cancel` on
 * stdin, and does whatever the test's program tells it to — including ignoring SIGTERM, never
 * answering a stop, and never exiting. It records its pid, its argv, every stdin line and every
 * SIGTERM to a file, so what the service SENT is checked from the child's side.
 *
 * Reaping is proved by the pid being gone (`process.kill(pid, 0)` failing), never by trusting a flag.
 * The 10 s ceiling, the 120 s cap and the exit grace run on a manual clock injected as `schedule`, so
 * the real numbers are exercised without waiting for them.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { toggleRequest, type DictationOutcome, type DictationState } from '../../../shared/dictation.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { cleanEnv } from '../util/exec.ts';
import {
  EXIT_GRACE_MS, MAX_RECORDING_SECONDS, STDERR_TAIL_BYTES, STOP_CEILING_MS, DictationServiceError,
  createDictationService, helperArgs, keepTail,
  type DictationService, type DictationUpdate, type Schedule,
} from './dictation.ts';

// ─── The fake helper ─────────────────────────────────────────────────────────────────────────────

/** One instruction to the fake. Run in order; `exit` and `hang` end the program. */
type Step =
  | { out: string }
  | { outHex: string }
  | { err: string; times?: number }
  | { sleep: number }
  | { await: 'stop' }
  | { note: string }
  | { waitFile: string }
  | { term: 'exit' | 'ignore' | { final: string } }
  | { exit: number }
  | { hang: true };

/**
 * Plain CommonJS for whatever Node runs it. No template literals, so nothing in here is interpolated
 * by the test file. Like the real helper: a `cancel` line, stdin EOF and SIGTERM all exit 0 with no
 * line — unless the program says `term: 'ignore'` (a wedged helper) or `term: { final }` (a final
 * racing the cancel).
 */
const FAKE_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const program = JSON.parse(process.env.FAKE_DICTATE_PROGRAM || '[]');
const record = process.env.FAKE_DICTATE_RECORD;
const NL = String.fromCharCode(10);
function note(o) { if (record) fs.appendFileSync(record, JSON.stringify(o) + NL); }
function write(stream, data) { return new Promise((resolve) => stream.write(data, resolve)); }
note({ pid: process.pid, argv: process.argv.slice(2) });

let onTerm = 'exit';
process.on('SIGTERM', () => {
  note({ signal: 'SIGTERM' });
  if (onTerm === 'ignore') return;
  if (typeof onTerm === 'object') {
    write(process.stdout, JSON.stringify({ t: 'final', text: onTerm.final }) + NL).then(() => process.exit(0));
    return;
  }
  process.exit(0);
});

const lines = [];
let wake = null;
let pending = '';
process.stdin.on('data', (d) => {
  pending += d.toString('utf8');
  for (let i = pending.indexOf(NL); i !== -1; i = pending.indexOf(NL)) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    note({ stdin: line });
    if (line === 'cancel') process.exit(0);
    lines.push(line);
    if (wake) { const w = wake; wake = null; w(); }
  }
});
process.stdin.on('end', () => { note({ stdin: 'EOF' }); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextLine(want) {
  for (;;) {
    const i = lines.indexOf(want);
    if (i !== -1) { lines.splice(i, 1); return; }
    await new Promise((r) => { wake = r; });
  }
}
(async () => {
  for (const step of program) {
    if ('term' in step) onTerm = step.term;
    else if ('out' in step) await write(process.stdout, step.out);
    else if ('outHex' in step) await write(process.stdout, Buffer.from(step.outHex, 'hex'));
    else if ('err' in step) await write(process.stderr, step.err.repeat(step.times || 1));
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('await' in step) await nextLine(step.await);
    else if ('note' in step) note({ note: step.note });
    else if ('waitFile' in step) { while (!fs.existsSync(step.waitFile)) await sleep(10); }
    else if ('exit' in step) process.exit(step.exit);
    else if ('hang' in step) { setInterval(() => {}, 1 << 30); return; }
  }
})();
`;

function writeFake(dir: string): string {
  const file = join(dir, 'hangar-dictate');
  writeFileSync(file, `#!${process.execPath}\n${FAKE_SOURCE}`);
  chmodSync(file, 0o755);
  return file;
}

const line = (o: object): string => `${JSON.stringify(o)}\n`;
const READY = line({ t: 'ready' });
const PREPARING = line({ t: 'preparing' });
const partial = (text: string): string => line({ t: 'partial', text });
const final = (text: string): string => line({ t: 'final', text });

const CRASHED: DictationOutcome = { kind: 'error', code: 'CRASHED', message: 'Dictation stopped unexpectedly.' };

// ─── The harness ─────────────────────────────────────────────────────────────────────────────────

/** Timers that fire only when the test advances them. */
function manualClock(): { schedule: Schedule; advance: (ms: number) => void } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (ms, fn) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

interface Seen {
  pid?: number;
  argv?: string[];
  stdin?: string;
  signal?: string;
  note?: string;
}

interface Harness {
  svc: DictationService;
  clock: ReturnType<typeof manualClock>;
  updates: DictationUpdate[];
  logs: string[];
  dir: string;
  /** Everything the fake recorded, in order. */
  seen(): Seen[];
  /** Every pid a fake reported — one per helper the service spawned. */
  pids(): number[];
  /** The pid of the Nth helper spawned (0-based), once it has reported it. */
  pid(n?: number): Promise<number>;
}

function harness(
  program: Step[] | ((dir: string) => Step[]),
  opts: { helperPath?: (dir: string) => string; onUpdate?: (u: DictationUpdate) => void } = {},
): Harness {
  const dir = tempDir('dictate');
  const record = join(dir, 'record.ndjson');
  const clock = manualClock();
  const updates: DictationUpdate[] = [];
  const logs: string[] = [];
  const steps = typeof program === 'function' ? program(dir) : program;
  const svc = createDictationService({
    helperPath: opts.helperPath ? opts.helperPath(dir) : writeFake(dir),
    env: { ...cleanEnv(process.env), FAKE_DICTATE_PROGRAM: JSON.stringify(steps), FAKE_DICTATE_RECORD: record },
    onUpdate: (u) => {
      updates.push(u);
      opts.onUpdate?.(u);
    },
    log: (l) => logs.push(l),
    schedule: clock.schedule,
  });
  // SIGKILL through the service's own handle, which cannot hit a recycled pid. A fake that outlives
  // even that still exits when this worker does: stdin EOF is a cancel.
  onTestFinished(async () => {
    await svc.dispose();
  });
  const seen = (): Seen[] =>
    existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Seen) : [];
  const pids = (): number[] => seen().flatMap((s) => (s.pid === undefined ? [] : [s.pid]));
  return {
    svc, clock, updates, logs, dir, seen, pids,
    pid: (n = 0) => until(() => pids()[n], `helper #${n} to report its pid`),
  };
}

async function until<T>(probe: () => T | null | undefined | false, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function diesWithin(pid: number, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return !isAlive(pid);
}

const outcomes = (h: Harness, runId?: number): DictationOutcome[] =>
  h.updates.flatMap((u) => (u.outcome !== null && (runId === undefined || u.runId === runId) ? [u.outcome] : []));
const outcomeOf = (h: Harness, runId?: number): Promise<DictationOutcome> => until(() => outcomes(h, runId)[0], 'the run to end');
const isRecording = (h: Harness, text?: string) => (): boolean => {
  const s = h.svc.state();
  return s.phase === 'recording' && (text === undefined || s.partial === text);
};
const refusal = (fn: () => unknown): DictationServiceError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DictationServiceError) return e;
    throw e;
  }
  throw new Error('expected a DictationServiceError, and nothing was thrown');
};

// ─── Pure pieces ─────────────────────────────────────────────────────────────────────────────────

describe('helperArgs', () => {
  it('always passes the cap, and a locale only when there is one', () => {
    expect(helperArgs({ maxSeconds: 120 })).toEqual(['--max-seconds', '120']);
    expect(helperArgs({ maxSeconds: 120, locale: '' })).toEqual(['--max-seconds', '120']);
    expect(helperArgs({ maxSeconds: 120, locale: 'en-GB' })).toEqual(['--max-seconds', '120', '--locale', 'en-GB']);
  });

  it('pins the numbers the plan names', () => {
    expect(MAX_RECORDING_SECONDS).toBe(120);
    expect(STOP_CEILING_MS).toBe(10_000);
  });
});

describe('keepTail', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const text = (b: Uint8Array): string => new TextDecoder().decode(b);

  it('keeps the LAST bytes, however they arrive', () => {
    let tail: Uint8Array = new Uint8Array(0);
    for (const chunk of ['abc', 'def', 'gh']) tail = keepTail(tail, bytes(chunk), 5);
    expect(text(tail)).toBe('defgh');
    expect(text(keepTail(bytes('xy'), bytes('0123456789'), 4))).toBe('6789');
    expect(text(keepTail(bytes('ab'), bytes('c'), 10))).toBe('abc');
  });

  it('copies rather than keeping a view of the chunk', () => {
    const chunk = Buffer.from('0123456789');
    const tail = keepTail(new Uint8Array(0), chunk, 4);
    chunk.fill(0x21);
    expect(text(tail)).toBe('6789');
  });
});

describe('createDictationService', () => {
  it('refuses a helper path that is not absolute, which spawn would look up on PATH', () => {
    expect(() => createDictationService({ helperPath: 'hangar-dictate', env: {}, onUpdate: () => undefined, log: () => undefined })).toThrow(/absolute/);
  });
});

// ─── A run ───────────────────────────────────────────────────────────────────────────────────────

describe('a run', () => {
  it('start → partials → stop → the final, once, and the helper is reaped', async () => {
    const h = harness([{ out: READY }, { out: partial('hello') }, { out: partial('hello world') }, { await: 'stop' }, { out: final('  hello world ') }, { exit: 0 }]);
    const runId = h.svc.start();
    expect(h.svc.state()).toEqual({ phase: 'starting' });
    const pid = await h.pid();
    await until(isRecording(h, 'hello world'), 'the second partial');

    expect(h.svc.stop()).toBe(true);
    expect(h.svc.stop()).toBe(false); // finalizing: the stop has been sent
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'hello world' });

    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(h.svc.busy()).toBe(false);
    // The helper's exit after its final is not a crash: nothing follows the write.
    expect(h.updates.map((u) => u.state)).toEqual<DictationState[]>([
      { phase: 'starting' },
      { phase: 'recording', partial: '' },
      { phase: 'recording', partial: 'hello' },
      { phase: 'recording', partial: 'hello world' },
      { phase: 'finalizing', partial: 'hello world' },
      { phase: 'idle', outcome: { kind: 'write', text: 'hello world' } },
    ]);
    expect(outcomes(h)).toHaveLength(1);
    expect(h.updates.every((u) => u.runId === runId)).toBe(true);
    // From the child's side: the argv, and exactly one stop.
    expect(h.seen()[0]?.argv).toEqual(['--max-seconds', '120']);
    expect(h.seen().filter((s) => s.stdin !== undefined)).toEqual([{ stdin: 'stop' }]);
  });

  it('refuses stop before `ready` — the helper would answer NO_INPUT — and cancel is the request there', async () => {
    const h = harness([{ out: PREPARING }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(() => h.svc.state().phase === 'preparing', 'preparing');

    expect(toggleRequest(h.svc.state())).toBe('cancel');
    expect(h.svc.stop()).toBe(false);
    expect(h.svc.cancel()).toBe(true);
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(h.seen().some((s) => s.stdin === 'stop')).toBe(false);
    expect(outcomes(h)).toEqual([{ kind: 'cancelled' }]);
  });

  it('a final written with no newline before the helper exits is still the final', async () => {
    const h = harness([{ out: READY }, { await: 'stop' }, { out: JSON.stringify({ t: 'final', text: 'no newline' }) }, { exit: 0 }]);
    h.svc.start();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'no newline' });
    await h.svc.reaped();
    expect(outcomes(h)).toHaveLength(1);
  });

  it('a final split across two chunks, through the middle of a multi-byte character, arrives whole', async () => {
    const whole = Buffer.from(final('café ☕ done'));
    const cut = whole.indexOf(Buffer.from('☕')) + 1; // one byte into a three-byte character
    const h = harness((dir) => [
      { out: READY },
      { await: 'stop' },
      { outHex: whole.subarray(0, cut).toString('hex') },
      { note: 'first half written' },
      { waitFile: join(dir, 'go') },
      { outHex: whole.subarray(cut).toString('hex') },
      { exit: 0 },
    ]);
    h.svc.start();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    await until(() => h.seen().some((s) => s.note === 'first half written'), 'the first half');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.svc.state().phase).toBe('finalizing'); // half a line is not a line

    writeFileSync(join(h.dir, 'go'), '');
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'café ☕ done' });
  });

  it("the helper's error line: the code picks the sentence, and its own message goes only to the log", async () => {
    const h = harness([{ out: line({ t: 'error', code: 'MIC_DENIED', message: 'Microphone access was refused.' }) }, { exit: 1 }]);
    h.svc.start();
    expect(await outcomeOf(h)).toEqual({
      kind: 'error', code: 'MIC_DENIED', message: 'Microphone access is denied. System Settings → Privacy & Security → Microphone.',
    });
    await h.svc.reaped();
    expect(h.logs.some((l) => l.includes('Microphone access was refused.'))).toBe(true);
    expect(JSON.stringify(h.updates)).not.toContain('was refused');
  });
});

// ─── Cancel and crash ────────────────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('mid-recording: the run ends at once, nothing is written, and the helper is reaped', async () => {
    const h = harness([{ out: READY }, { out: partial('half a sen') }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h, 'half a sen'), 'the partial');

    expect(h.svc.cancel()).toBe(true);
    // At once — not when the process gets round to exiting.
    expect(h.svc.state()).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
    expect(await diesWithin(pid), `helper pid ${pid} still alive after cancel`).toBe(true);
    await h.svc.reaped();
    expect(h.seen()).toContainEqual({ signal: 'SIGTERM' });
    expect(outcomes(h)).toEqual([{ kind: 'cancelled' }]);
    expect(h.svc.cancel()).toBe(false);
  });

  it('a final that races the cancel is never written', async () => {
    const h = harness([{ term: { final: 'too late' } }, { out: READY }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.cancel();
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(outcomes(h)).toEqual([{ kind: 'cancelled' }]);
  });

  it('a helper that ignores SIGTERM is SIGKILLed after the grace, not left holding the microphone', async () => {
    const h = harness([{ term: 'ignore' }, { out: READY }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.cancel();
    await until(() => h.seen().some((s) => s.signal === 'SIGTERM'), 'the SIGTERM');
    h.clock.advance(EXIT_GRACE_MS - 1);
    expect(isAlive(pid)).toBe(true);
    h.clock.advance(1);
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
  });
});

describe('a crash', () => {
  it('a silent exit mid-recording, with no cancel, is the crash sentence and writes nothing', async () => {
    const h = harness([{ out: READY }, { out: partial('some words') }, { err: '[dictate] something broke\n' }, { exit: 0 }]);
    h.svc.start();
    const pid = await h.pid();
    expect(await outcomeOf(h)).toEqual(CRASHED);
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(outcomes(h)).toEqual([CRASHED]);
    expect(h.updates.map((u) => u.state.phase)).toEqual(['starting', 'recording', 'recording', 'idle']);
    // The diagnostics reach the log, never the user.
    expect(h.logs.some((l) => l.includes('[dictate] something broke'))).toBe(true);
    expect(JSON.stringify(h.updates)).not.toContain('something broke');
  });

  it('stderr is drained, never parsed and never shown; the log keeps only a bounded tail', async () => {
    const h = harness([
      { out: READY },
      { err: line({ t: 'final', text: 'from stderr' }) },
      { err: 'x'.repeat(1_000), times: 200 }, // 200 KB: an undrained pipe blocks at 64 KB
      { err: '[dictate] last words\n' },
      { exit: 1 },
    ]);
    h.svc.start();
    expect(await outcomeOf(h)).toEqual(CRASHED);
    await h.svc.reaped();
    expect(JSON.stringify(h.updates)).not.toContain('from stderr');
    const exitLine = h.logs.find((l) => l.includes('stderr:'));
    expect(exitLine).toContain('[dictate] last words');
    expect(exitLine).not.toContain('from stderr'); // scrolled out of the tail
    expect(exitLine!.length).toBeLessThan(STDERR_TAIL_BYTES + 200);
  });
});

// ─── The clocks ──────────────────────────────────────────────────────────────────────────────────

describe('the 10 s stop ceiling', () => {
  it('a helper that never answers the stop is killed at 10 s and the run is a crash', async () => {
    const h = harness([{ term: 'ignore' }, { out: READY }, { await: 'stop' }, { note: 'got stop' }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    await until(() => h.seen().some((s) => s.note === 'got stop'), 'the helper to read the stop');

    h.clock.advance(STOP_CEILING_MS - 1);
    expect(h.svc.state().phase).toBe('finalizing');
    expect(isAlive(pid)).toBe(true);

    h.clock.advance(1);
    // Decided AT the ceiling, not whenever the process gets round to dying.
    expect(h.svc.state()).toEqual({ phase: 'idle', outcome: CRASHED });
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(outcomes(h)).toEqual([CRASHED]);
    // SIGKILL — a wedged helper can refuse a SIGTERM (this one would have).
    expect(h.seen().some((s) => s.signal === 'SIGTERM')).toBe(false);
  });

  it('a final that arrives before the ceiling is written, and the ceiling then does nothing', async () => {
    const h = harness([{ out: READY }, { await: 'stop' }, { out: final('in time') }, { exit: 0 }]);
    h.svc.start();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'in time' });
    await h.svc.reaped();
    h.clock.advance(STOP_CEILING_MS);
    expect(outcomes(h)).toEqual([{ kind: 'write', text: 'in time' }]);
  });
});

describe('the 120 s cap', () => {
  it('counts from `ready`, sends the stop at 120 s, and kills a helper that ignores it 10 s later', async () => {
    const h = harness((dir) => [{ term: 'ignore' }, { out: PREPARING }, { waitFile: join(dir, 'go') }, { out: READY }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(() => h.svc.state().phase === 'preparing', 'preparing');
    h.clock.advance(10 * 60_000); // a slow first-use model download is not cut off: the microphone is not open yet
    expect(h.svc.state().phase).toBe('preparing');

    writeFileSync(join(h.dir, 'go'), '');
    await until(isRecording(h), 'recording');
    h.clock.advance(MAX_RECORDING_SECONDS * 1000 - 1);
    expect(h.svc.state().phase).toBe('recording');
    expect(h.seen().some((s) => s.stdin === 'stop')).toBe(false);

    h.clock.advance(1);
    expect(h.svc.state().phase).toBe('finalizing');
    await until(() => h.seen().some((s) => s.stdin === 'stop'), 'the stop the cap sent');

    h.clock.advance(STOP_CEILING_MS);
    expect(h.svc.state()).toEqual({ phase: 'idle', outcome: CRASHED });
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(h.seen()[0]?.argv).toEqual(['--max-seconds', '120']);
  });

  it('a helper that answers the cap’s stop keeps its words', async () => {
    const h = harness([{ out: READY }, { out: partial('forty words') }, { await: 'stop' }, { out: final('forty words') }, { exit: 0 }]);
    h.svc.start();
    await until(isRecording(h, 'forty words'), 'the partial');
    h.clock.advance(MAX_RECORDING_SECONDS * 1000);
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'forty words' });
    await h.svc.reaped();
  });
});

// ─── One at a time ───────────────────────────────────────────────────────────────────────────────

describe('single-flight', () => {
  it('refuses a second start while a run is active, and spawns nothing', async () => {
    const h = harness([{ out: READY }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    const err = refusal(() => h.svc.start());
    expect(err.code).toBe('DICTATION_BUSY');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.pids()).toEqual([pid]);
    h.svc.cancel();
    await h.svc.reaped();
  });

  it('refuses a start while the helper is still alive after a cancel, EVEN THOUGH the reducer is idle', async () => {
    const h = harness([{ term: 'ignore' }, { out: READY }, { hang: true }]);
    const first = h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.cancel();
    await until(() => h.seen().some((s) => s.signal === 'SIGTERM'), 'the SIGTERM it ignores');

    expect(h.svc.state()).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
    expect(isAlive(pid)).toBe(true);
    expect(h.svc.busy()).toBe(true);
    expect(refusal(() => h.svc.start()).code).toBe('DICTATION_BUSY');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.pids()).toEqual([pid]);

    h.clock.advance(EXIT_GRACE_MS);
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(h.svc.start()).toBe(first + 1);
    await h.pid(1);
    expect(h.pids()).toHaveLength(2);
  });

  it('refuses a start while a helper that has said its final is still exiting, and reaps one that never does', async () => {
    const h = harness([{ out: READY }, { await: 'stop' }, { out: final('done') }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    expect(await outcomeOf(h)).toEqual({ kind: 'write', text: 'done' });
    expect(h.svc.state().phase).toBe('idle');
    expect(refusal(() => h.svc.start()).code).toBe('DICTATION_BUSY');

    h.clock.advance(EXIT_GRACE_MS - 1);
    expect(isAlive(pid)).toBe(true);
    h.clock.advance(1);
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(() => h.svc.start()).not.toThrow();
  });
});

// ─── A helper that is not there ──────────────────────────────────────────────────────────────────

describe('a helper that cannot run', () => {
  it('a missing binary is NOT_BUILT, and the next start is not refused', async () => {
    const h = harness([], { helperPath: (dir) => join(dir, 'resources', 'bin', 'hangar-dictate') });
    h.svc.start();
    expect(await outcomeOf(h)).toEqual({ kind: 'error', code: 'NOT_BUILT', message: 'Dictation is not built. Run npm run build:dictate.' });
    await h.svc.reaped();
    expect(h.svc.busy()).toBe(false);
    expect(h.updates.map((u) => u.state.phase)).toEqual(['starting', 'idle']);
    expect(h.logs.some((l) => l.includes('ENOENT'))).toBe(true);
    expect(() => h.svc.start()).not.toThrow();
    await h.svc.reaped();
  });

  it('a binary that is there but not executable is a crash, not NOT_BUILT', async () => {
    const h = harness([], {
      helperPath: (dir) => {
        const file = join(dir, 'hangar-dictate');
        writeFileSync(file, '#!/bin/sh\n');
        chmodSync(file, 0o644);
        return file;
      },
    });
    h.svc.start();
    expect(await outcomeOf(h)).toEqual(CRASHED);
    await h.svc.reaped();
    expect(h.svc.busy()).toBe(false);
  });

  it('a spawn that throws does not throw out of start() or leave the service busy', async () => {
    const h = harness([], { helperPath: (dir) => join(dir, `bad${String.fromCharCode(0)}name`) });
    expect(() => h.svc.start()).not.toThrow();
    expect(h.svc.busy()).toBe(false);
    expect(outcomes(h)).toEqual([CRASHED]);
  });
});

// ─── Quit, and a caller that throws ──────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('leaves no process behind — even one that ignores SIGTERM — reports nothing more, and refuses later starts', async () => {
    const h = harness([{ term: 'ignore' }, { out: READY }, { hang: true }]);
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    const before = h.updates.length;

    await h.svc.dispose();
    expect(isAlive(pid), `helper pid ${pid} outlived dispose()`).toBe(false);
    expect(h.updates).toHaveLength(before);
    expect(h.seen().some((s) => s.signal === 'SIGTERM')).toBe(false);
    expect(refusal(() => h.svc.start()).code).toBe('DICTATION_DISPOSED');
  });

  it('with no helper running, resolves at once', async () => {
    const h = harness([]);
    await h.svc.dispose();
    expect(h.svc.busy()).toBe(false);
  });
});

describe('onUpdate', () => {
  it('a caller that throws does not stop the run or the reaping', async () => {
    const h = harness([{ out: READY }, { await: 'stop' }, { out: final('still here') }, { exit: 0 }], {
      onUpdate: () => {
        throw new Error('renderer gone');
      },
    });
    h.svc.start();
    const pid = await h.pid();
    await until(isRecording(h), 'recording');
    h.svc.stop();
    await until(() => h.svc.state().phase === 'idle', 'the run to end');
    expect(h.svc.state()).toEqual({ phase: 'idle', outcome: { kind: 'write', text: 'still here' } });
    expect(await diesWithin(pid)).toBe(true);
    await h.svc.reaped();
    expect(h.logs.some((l) => l.includes('onUpdate threw: renderer gone'))).toBe(true);
  });
});
