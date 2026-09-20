import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_FRAME_CHARS } from '../shared/constants.ts';
import { ensureSpawnHelperExecutable } from './pty-fix.ts';
import { budgetedSerialize, Session, type SessionEvents } from './session.ts';

// These tests spawn real PTYs, and they run before createHost() (Task 10) exists to ensure the
// execute bit. Task 1 installs with `--ignore-scripts`, so on a fresh clone every case here would
// otherwise fail with `posix_spawnp failed` for a non-obvious reason (spec G3). This is the one
// place where chmodding the real node_modules from a test is the right thing to do.
beforeAll(() => {
  ensureSpawnHelperExecutable();
});

function envStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function collector() {
  const data: string[] = [];
  const titles: string[] = [];
  let bells = 0;
  let resolveExit!: (v: { exitCode: number; signal: number | null }) => void;
  const exit = new Promise<{ exitCode: number; signal: number | null }>((r) => (resolveExit = r));
  const events: SessionEvents = {
    onData: (_id, d) => data.push(d),
    onTitle: (_id, t) => titles.push(t),
    onBell: () => bells++,
    onExit: (_id, exitCode, signal) => resolveExit({ exitCode, signal }),
    onLog: () => undefined,
  };
  return { events, data, titles, bells: () => bells, exit, text: () => data.join('') };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const base = { cwd: '/tmp', file: '/bin/sh', env: envStrings(), cols: 80, rows: 24 };

describe('Session', () => {
  it('runs a command, forwards batched output, mirrors it and reports exit', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 's1', args: ['-c', 'echo READY; read line; echo GOT:$line; exit 7'] }, c.events);
    expect(s.pid).toBeGreaterThan(0);
    await waitFor(() => c.text().includes('READY'));
    s.write('hello\r');
    const { exitCode } = await c.exit;
    expect(exitCode).toBe(7);
    // node-pty does not guarantee all data is delivered before onExit, so wait for the text
    // rather than asserting straight after the exit — measured ~20% flaky without this.
    await waitFor(() => c.text().includes('GOT:hello'));
    expect(c.text()).toContain('GOT:hello');
    expect(s.exited).toBe(true);
    expect(s.exitCode).toBe(7);
    expect(await s.snapshot()).toContain('GOT:hello');
    s.dispose();
  });

  it('delivers startupCommand without any client write', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 's2', args: ['-i'], startupCommand: 'echo STARTED_$((20+22)); exit' }, c.events);
    await c.exit;
    expect(c.text()).toContain('STARTED_42');
    s.dispose();
  });

  it('captures OSC titles and bells from the mirror', async () => {
    const c = collector();
    const s = new Session(
      { ...base, id: 's3', args: ['-c', `printf '\\033]0;My Title\\007'; printf '\\007'; exit 0`] },
      c.events,
    );
    await c.exit;
    await waitFor(() => c.titles.length > 0 && c.bells() > 0);
    expect(c.titles).toEqual(['My Title']);
    expect(s.title).toBe('My Title');
    expect(c.bells()).toBe(1);
    s.dispose();
  });

  it('kill(SIGHUP) ends a long-running process', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 's4', args: ['-c', 'sleep 30'] }, c.events);
    s.kill('SIGHUP');
    await c.exit;
    expect(s.exited).toBe(true);
    s.dispose();
  });

  it('resize updates geometry and info()', () => {
    const c = collector();
    const s = new Session({ ...base, id: 's5', args: ['-c', 'sleep 5'] }, c.events);
    s.resize(100, 30);
    expect(s.info(2)).toMatchObject({ id: 's5', cols: 100, rows: 30, attached: 2, exited: false, exitCode: null, cwd: '/tmp' });
    s.dispose();
  });

  it('reports signal null on a clean exit, not 0', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 's6', args: ['-c', 'exit 0'] }, c.events);
    const { signal } = await c.exit;
    // node-pty reports 0 here, which would read as "killed by signal 0".
    expect(signal).toBeNull();
    expect(s.info(0).signal).toBeNull();
    s.dispose();
  });

  // This is the one that silently corrupts a user's terminal if it regresses.
  // Terminal.write() is async: serialize() in the same turn as recent output returns without it.
  it('snapshot waits for the mirror to catch up with the newest output', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 'snap1', args: ['-c', 'echo LATEST_LINE; exit 0'] }, c.events);
    await c.exit;
    expect(await s.snapshot()).toContain('LATEST_LINE');
    s.dispose();
  });

  it('splits an over-cap burst without exceeding the cap or splitting a surrogate pair', async () => {
    const c = collector();
    const script = `process.stdout.write('\\u{1F600}'.repeat(350000) + '\\nDONE\\n')`;
    const s = new Session({ ...base, id: 'f1', file: process.execPath, args: ['-e', script] }, c.events);
    await c.exit;
    await waitFor(() => c.text().includes('DONE'));
    expect(c.data.length).toBeGreaterThan(1);
    for (const frame of c.data) {
      expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);
      const last = frame.charCodeAt(frame.length - 1);
      const first = frame.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no trailing high surrogate
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no leading low surrogate
    }
    expect(c.text()).not.toContain('\uFFFD');
    s.dispose();
  });

  // node-pty signals only the shell pid, and a SIGKILLed shell forwards nothing — without a tree
  // walk the agent survives, reparented to pid 1, and `git worktree remove` then fails.
  it('escalates to SIGKILL and leaves no surviving descendants', async () => {
    const c = collector();
    const s = new Session(
      { ...base, id: 'k1', killGraceMs: 200, args: ['-c', `perl -e '$SIG{HUP}="IGNORE"; $SIG{TERM}="IGNORE"; print "GC:$$\\n"; sleep 60'`] },
      c.events,
    );
    await waitFor(() => /GC:\d+/.test(c.text()));
    const child = Number((c.text().match(/GC:(\d+)/) as RegExpMatchArray)[1]);
    expect(alive(child)).toBe(true);

    const started = Date.now();
    s.kill('SIGHUP');
    await c.exit;
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    await waitFor(() => !alive(child), 3000);
    expect(alive(child)).toBe(false);
    s.dispose();
  });

  it('stops emitting after dispose', async () => {
    const c = collector();
    const s = new Session({ ...base, id: 'd1', args: ['-c', 'while :; do echo spam; sleep 0.01; done'] }, c.events);
    await waitFor(() => c.text().includes('spam'));
    s.dispose();
    const seen = c.data.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(c.data.length).toBe(seen);
  });
});

describe('budgetedSerialize', () => {
  it('shrinks until the JSON-encoded snapshot fits, and floors at 0 rather than exceeding', () => {
    const calls: number[] = [];
    // Every ESC costs six characters once encoded, so this is the escape-saturated worst case.
    const fake = (lines: number) => { calls.push(lines); return '\u001b['.repeat(lines * 300); };
    let truncatedTo = -1;
    const out = budgetedSerialize(fake, 10_000, 4 * 1024 * 1024, (l) => (truncatedTo = l));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(truncatedTo).toBeGreaterThanOrEqual(0);
    expect(calls.length).toBeLessThanOrEqual(4); // proportional stepping, not repeated halving
  });

  it('returns everything and never calls onTruncate when it already fits', () => {
    let truncated = false;
    const out = budgetedSerialize(() => 'small', 10_000, 4 * 1024 * 1024, () => (truncated = true));
    expect(out).toBe('small');
    expect(truncated).toBe(false);
  });
});
