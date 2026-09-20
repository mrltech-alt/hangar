// One agent session: a PTY, a headless xterm mirror (for reattach snapshots), output batching, kill grace.
import { execFileSync } from 'node:child_process';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import xterm from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import { KILL_GRACE_MS, MAX_FRAME_CHARS, OUTPUT_FLUSH_MS, SCROLLBACK_LINES } from '../shared/constants.ts';
import { MAX_LINE_CHARS } from '../shared/host-protocol.ts';
import type { SessionInfo } from '../shared/host-protocol.ts';

const { Terminal } = xterm;
const { SerializeAddon } = serialize;

export interface SessionOptions {
  id: string;
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  startupCommand?: string;
  scrollback?: number;
  /** Test seam: a 3 s wall-clock wait is the first thing deleted when the suite gets slow. */
  killGraceMs?: number;
}

export interface SessionEvents {
  onData: (id: string, data: string) => void;
  onTitle: (id: string, title: string) => void;
  onBell: (id: string) => void;
  onExit: (id: string, exitCode: number, signal: number | null) => void;
  /** Host-level log line (snapshot truncation, etc). Not PTY data — see spec §8.2 logging. */
  onLog: (message: string) => void;
}

export type KillSignal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL';

/**
 * Serialise with as much scrollback as fits inside `budget`, measured as the JSON-ENCODED length.
 *
 * Measuring the encoded length rather than guessing at an expansion factor matters in both
 * directions: an ESC becomes six characters (`\u001b`) while ordinary text becomes one, so a fixed
 * `/2` allowance both discards ~40% more history than necessary on typical content and can still
 * overshoot on escape-saturated content. `JSON.stringify` costs about a fifth of one serialize pass,
 * which is less than the extra pass a guess would need.
 *
 * Steps proportionally rather than halving: serialized length is near-linear in line count, so
 * aiming straight at the budget converges in about two passes instead of four and keeps more
 * history. Falls back to halving if an estimate fails to shrink, which guarantees termination.
 *
 * Floors at zero, not at some minimum scrollback: a screen-only snapshot is a degraded but usable
 * attach, whereas returning an over-budget line makes the client's parser overflow, destroy the
 * socket, reconnect, re-attach and receive the same frame again — forever.
 */
export function budgetedSerialize(
  serialize: (lines: number) => string,
  maxLines: number,
  budget: number,
  onTruncate: (lines: number, chars: number) => void,
): string {
  let lines = maxLines;
  for (;;) {
    const data = serialize(lines);
    const encoded = JSON.stringify(data).length;
    if (encoded <= budget || lines === 0) {
      if (lines < maxLines) onTruncate(lines, encoded);
      return data;
    }
    const next = Math.floor(lines * (budget / encoded) * 0.9);
    lines = next >= lines ? Math.floor(lines / 2) : Math.max(0, next);
  }
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly pid: number;
  cols: number;
  rows: number;
  exited = false;
  exitCode: number | null = null;
  signal: number | null = null;
  title = '';

  private readonly events: SessionEvents;
  private readonly scrollback: number;
  private readonly killGraceMs: number;
  private readonly subs: { dispose(): void }[] = [];
  private readonly proc: IPty;
  private readonly term: HeadlessTerminal;
  private readonly serializer: SerializeAddonType;
  private pending = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: SessionOptions, events: SessionEvents) {
    this.events = events;
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.startedAt = new Date().toISOString();
    this.scrollback = opts.scrollback ?? SCROLLBACK_LINES;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;

    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.onTitleChange((title) => {
      this.title = title;
      this.events.onTitle(this.id, title);
    });
    this.term.onBell(() => this.events.onBell(this.id));

    this.proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pid = this.proc.pid;
    this.subs.push(this.proc.onData((data) => {
      this.term.write(data);
      this.enqueue(data);
    }));
    this.subs.push(this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      // node-pty reports 0, not undefined, on a clean exit, so `?? null` never fires and the
      // field would read as "killed by signal 0" — false, and indistinguishable from null to
      // any consumer that tests truthiness.
      const sig = typeof signal === 'number' && signal > 0 ? signal : null;
      this.signal = sig;
      if (this.killTimer !== null) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.flush();
      this.events.onExit(this.id, exitCode, sig);
    }));

    if (opts.startupCommand !== undefined && opts.startupCommand.length > 0) {
      this.proc.write(opts.startupCommand + '\r');
    }
  }

  /**
   * Serialised screen + scrollback, suitable for `xterm.write()` in a fresh terminal of the same size.
   * Budgeted against the protocol's line cap — see `budgetedSerialize` for why that matters.
   */
  async snapshot(): Promise<string> {
    // Two orderings have to be right here, and both were wrong at first.
    //
    // 1. Flush the wire batch. The mirror is fed in `onData`, but the client copy waits on the
    //    16 ms timer — so without this, bytes already in the mirror are ALSO delivered as a `data`
    //    frame just after the snapshot. Measured: 3 of 6 attaches replayed their last line.
    // 2. Wait for the mirror to catch up. `Terminal.write()` is ASYNCHRONOUS — verified:
    //    `serialize()` called immediately after `write('HELLO')` returns an empty string. So a
    //    snapshot taken in the same turn as recent output silently omits it, and an attach right
    //    after a burst hands the client a screen missing its newest lines. `write('', cb)` resolves
    //    once the parser has drained.
    this.flush();
    await new Promise<void>((resolve) => this.term.write('', resolve));
    return budgetedSerialize(
      (lines) => this.serializer.serialize({ scrollback: lines }),
      this.scrollback,
      MAX_LINE_CHARS - 512, // headroom for the enclosing `snapshot` message envelope
      (lines, chars) => this.events.onLog(`snapshot for ${this.id} truncated to ${lines} scrollback lines (${chars} encoded chars)`),
    );
  }

  write(data: string): void {
    if (!this.exited && !this.disposed) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    if (!this.exited) this.proc.resize(cols, rows);
  }

  /** Sends `signal`; if the process is still alive after KILL_GRACE_MS, sends SIGKILL. */
  kill(signal: KillSignal = 'SIGHUP'): void {
    if (this.exited || this.disposed) return;
    this.proc.kill(signal);
    if (signal !== 'SIGKILL' && this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        if (!this.exited) this.killTree();
      }, this.killGraceMs);
    }
  }

  /**
   * SIGKILL the shell AND everything under it.
   *
   * node-pty's `kill()` signals only the shell's pid. SIGHUP works because the shell forwards it to
   * its jobs; SIGKILL cannot be caught, so a dying shell forwards nothing and its children are
   * reparented to pid 1 and survive — verified on this machine. Signalling the process group is not
   * enough either: a job-controlled foreground child has its own process group. So walk the tree.
   *
   * This matters beyond tidiness: spec §8.2 states the process is dead after the grace period, and
   * Plan 02's delete-agent flow runs `git worktree remove` on that guarantee. A survivor holding
   * files open in the worktree makes the removal fail.
   */
  private killTree(): void {
    const victims: number[] = [];
    try {
      // Snapshot the tree BEFORE killing anything, or the ppid links are already broken.
      const children = new Map<number, number[]>();
      for (const line of execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (!pid) continue;
        const siblings = children.get(ppid);
        if (siblings === undefined) children.set(ppid, [pid]);
        else siblings.push(pid);
      }
      const stack = [this.pid];
      while (stack.length > 0) {
        const pid = stack.pop() as number;
        victims.push(pid);
        stack.push(...(children.get(pid) ?? []));
      }
    } catch {
      victims.push(this.pid); // ps unavailable: at least kill what node-pty would have
    }
    // Deepest first, so a parent cannot re-fork while we work down the tree.
    for (const pid of victims.reverse()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /** Frees the mirror and the PTY listeners. Kills the process tree if it is still running. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.exited) this.killTree();
    // Release the pty listeners: without this a disposed Session keeps emitting under an id that
    // spec §8.2 allows a respawn to reuse, so late frames would reach the NEW session's panes.
    for (const sub of this.subs) sub.dispose();
    this.subs.length = 0;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.pending = '';
    this.term.dispose();
  }

  info(attached: number): SessionInfo {
    return {
      id: this.id,
      pid: this.pid,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      exited: this.exited,
      exitCode: this.exitCode,
      signal: this.signal,
      title: this.title,
      attached,
    };
  }

  private enqueue(data: string): void {
    if (this.disposed) return;
    this.pending += data;
    if (this.pending.length >= MAX_FRAME_CHARS) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
  }

  private flush(): void {
    if (this.disposed) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const data = this.pending;
    this.pending = '';
    for (let i = 0; i < data.length; ) {
      // Never split a surrogate pair: Claude Code's Ink UI emits emoji, and half a pair
      // corrupts the receiving terminal. Back the boundary off by one when it lands mid-pair.
      let end = Math.min(i + MAX_FRAME_CHARS, data.length);
      const code = data.charCodeAt(end - 1);
      if (end < data.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      this.events.onData(this.id, data.slice(i, end));
      i = end;
    }
  }
}
