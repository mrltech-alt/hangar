import { getEventListeners } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteJson } from './atomic-write.ts';
import { freeBytes } from './disk.ts';
import { ExecError, cleanEnv, exec } from './exec.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';

describe('exec', () => {
  it('resolves stdout/stderr on success', async () => {
    const r = await exec('/bin/sh', ['-c', 'echo out; echo err >&2']);
    expect(r).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 0 });
  });
  it('rejects with ExecError carrying code, stderr and args', async () => {
    const err = await exec('/bin/sh', ['-c', 'echo boom >&2; exit 3']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    const e = err as ExecError;
    expect(e.code).toBe(3);
    expect(e.stderr).toBe('boom\n');
    expect(e.args).toEqual(['-c', 'echo boom >&2; exit 3']);
    expect(e.message).toContain('boom');
  });
  it('rejects with code null for a missing binary', async () => {
    const err = (await exec('/nonexistent/bin', []).catch((e: unknown) => e)) as ExecError;
    expect(err.code).toBeNull();
    expect(err.message).toContain('ENOENT');
  });
  it('pipes input and honours timeouts', async () => {
    expect((await exec('/bin/cat', [], { input: 'piped' })).stdout).toBe('piped');
    const err = (await exec('/bin/sleep', ['5'], { timeoutMs: 200 }).catch((e: unknown) => e)) as ExecError;
    expect(err).toBeInstanceOf(ExecError);
    expect(err.code).toBeNull();
  });
  // Change `opts.env ?? cleanEnv(process.env)` to `opts.env ?? process.env` and every other test
  // still passes, while G1 comes back weeks later as "agents behave oddly".
  it('cleans the environment by default', async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const r = await exec('/bin/sh', ['-c', 'echo ${ELECTRON_RUN_AS_NODE-unset}']);
      expect(r.stdout).toBe('unset\n');
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = before;
    }
  });

  // §16: an argument array, never a shell string. The everyday case is not an injection attempt —
  // it is a repo path with a space or a branch name containing `$`.
  it('passes arguments literally, with no shell expansion', async () => {
    const r = await exec('/bin/echo', ['$HOME `id` * a b']);
    expect(r.stdout).toBe('$HOME `id` * a b\n');
  });

  // A child can exit before reading stdin; writing past the pipe buffer then raises EPIPE on a
  // stream whose 'error' event fires outside the promise — which crashed the whole process.
  it('reports a child that exits before reading stdin, instead of crashing', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `some/quite/long/path/number-${i}.txt`).join('\0');
    await expect(exec('/usr/bin/git', ['-C', '/tmp', 'check-ignore', '--stdin', '-z'], { input: big }))
      .rejects.toBeInstanceOf(ExecError);
  });

  // A timeout must actually bound an INTERACTIVE shell, which IGNORES SIGTERM. Measured with the
  // SIGTERM default: 20030ms under a 1000ms timeout — the rc file ran to completion, so there was
  // no bound at all. shell-env.ts is forced onto `-i` by G5 and bootstrap awaits it before starting
  // the session host, so this is spec §11's launch budget.
  //
  // The rc file blocks INSIDE the shell (zselect, in hundredths of a second) rather than in a
  // `sleep` child: execFile is not `detached`, so the signal reaches the shell pid only and a
  // `sleep` was verified to survive as PPID 1 for its full 20s after the suite finished. Blocking
  // in-process also makes the assertion stronger — it proves the shell process itself died.
  // A scratch ZDOTDIR, never the owner's real `~/.zshrc`.
  it('kills a timed-out INTERACTIVE shell, which ignores SIGTERM', async () => {
    const zdotdir = tempDir('exec-zdotdir');
    writeFileSync(join(zdotdir, '.zshrc'), 'zmodload zsh/zselect && zselect -t 2000\n');
    const started = Date.now();
    const err = await exec('/bin/zsh', ['-ilc', 'printf ran'], {
      timeoutMs: 1_000,
      killSignal: 'SIGKILL',
      env: cleanEnv(process.env, { ZDOTDIR: zdotdir }),
    }).then(() => null, (e: unknown) => e as ExecError);
    expect(err).toBeInstanceOf(ExecError);
    expect(err?.timedOut).toBe(true);
    // 4x the timeout, deliberately loose: this only has to tell "killed" apart from "waited out the
    // rc file's 20s block", and a tight window would flake on a loaded machine.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 40_000);

  // SIGKILL is per-call for a reason: git registers a sigchain handler that unlinks `index.lock` on
  // SIGTERM, and SIGKILL cannot be caught. Measured on a timed-out `git add` —
  // `{"killSignal":"SIGTERM","locks":[]}` vs `{"killSignal":"SIGKILL","locks":["index.lock"]}` —
  // after which every later git call in that worktree died with "Unable to create index.lock: File
  // exists". Plans 03/04 route git and a user-authored `postCreate` through this wrapper, so the
  // default must stay catchable.
  it('defaults to SIGTERM so a child can run its cleanup handler', async () => {
    const dir = tempDir('exec-killsignal');
    // perl, not `sh -c 'sleep 10 & wait'`: the backgrounded sleep is a child of the CHILD, and
    // execFile is not `detached`, so it reparents to launchd and outlives the suite (measured: two
    // survivors per run). perl sleeps in-process, so the signalled process is the one that blocks
    // and nothing survives it.
    const cleanup = (marker: string) => `$SIG{TERM} = sub { open my $f, '>', '${marker}'; exit 143 }; sleep 10;`;

    const term = join(dir, 'term-cleaned');
    await exec('/usr/bin/perl', ['-e', cleanup(term)], { timeoutMs: 400 }).catch(() => undefined);
    expect(existsSync(term)).toBe(true);

    const kill = join(dir, 'kill-cleaned');
    await exec('/usr/bin/perl', ['-e', cleanup(kill)], { timeoutMs: 400, killSignal: 'SIGKILL' }).catch(() => undefined);
    expect(existsSync(kill)).toBe(false);
  }, 20_000);

  // Plan 04 depends on this behaviour to decide whether a diff side is too big to show.
  it('distinguishes a maxBuffer overflow from a plain non-zero exit', async () => {
    const err = await exec('/bin/sh', ['-c', 'head -c 200000 /dev/zero | tr "\\0" x'], { maxBuffer: 1024 })
      .then(() => null, (e: unknown) => e as ExecError);
    expect(err).toBeInstanceOf(ExecError);
    expect(err?.syscallCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(err?.timedOut).toBe(false);
    const plain = await exec('/bin/sh', ['-c', 'exit 3']).then(() => null, (e: unknown) => e as ExecError);
    expect(plain?.code).toBe(3);
    expect(plain?.syscallCode).toBeNull();
  });

  // Plan 06: the Linear look-up is a `claude -p` the user can cancel from the dialog. A cancel is
  // neither a timeout (which has its own message) nor a failure, so it needs its own flag rather
  // than a substring of `message` or a `syscallCode` comparison at every caller.
  //
  // The rejection alone proves nothing about the child: Node rejects on the abort itself, BEFORE the
  // child exits (measured on Node 24.15). So these tests have the child report its pid and then watch
  // that pid die. `exec sleep` keeps the pid the shell wrote, and an ignored signal survives exec.
  // Waits for the digits, not the file: `>` creates the file before `echo` writes to it, so an early
  // read sees it empty — `Number('')` is 0, and `process.kill(0, 0)` probes the whole process group,
  // which always succeeds and reads as "still alive".
  const pidOf = async (file: string): Promise<number> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      if (/^\d+$/.test(text)) return Number(text);
      if (Date.now() > deadline) throw new Error(`child never wrote its pid to ${file} (read ${JSON.stringify(text)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const diesWithin = async (pid: number, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return !isAlive(pid);
  };
  const killQuietly = (pid: number | undefined): void => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, which is the outcome the test wanted
    }
  };

  it('kills the child when its signal aborts, and says aborted rather than timed out', async () => {
    const pidFile = join(tempDir('exec-abort'), 'pid');
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const pending = exec('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 10`], { signal: controller.signal })
        .then(() => null, (e: unknown) => e as ExecError);
      pid = await pidOf(pidFile);
      controller.abort();
      const err = await pending;
      expect(err).toBeInstanceOf(ExecError);
      expect(err?.aborted).toBe(true);
      expect(err?.timedOut).toBe(false);
      expect(err?.code).toBeNull();
      expect(await diesWithin(pid, 2_000), `pid ${pid} still alive 2 s after the abort`).toBe(true);
    } finally {
      controller.abort(); // a no-op after the abort above; the only kill if `pidOf` threw first
      killQuietly(pid);
    }
  }, 20_000);

  // Node's own abort handling sends plain SIGTERM whatever `killSignal` says (measured on Node 24.15:
  // a child ignoring TERM survived it), so a caller that chose SIGKILL — as shell-env.ts does for a
  // shell that ignores TERM (G5) — would be left with a child that never dies.
  it('applies killSignal on abort, so a child that ignores SIGTERM still dies', async () => {
    const pidFile = join(tempDir('exec-abort-kill'), 'pid');
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const pending = exec('/bin/sh', ['-c', `trap '' TERM; echo $$ > '${pidFile}'; exec sleep 10`], {
        signal: controller.signal,
        killSignal: 'SIGKILL',
      }).then(() => null, (e: unknown) => e as ExecError);
      pid = await pidOf(pidFile);
      controller.abort();
      const err = await pending;
      expect(err).toBeInstanceOf(ExecError);
      expect(err?.aborted).toBe(true);
      expect(await diesWithin(pid, 2_000), `pid ${pid} still alive 2 s after the abort`).toBe(true);
    } finally {
      controller.abort(); // a no-op after the abort above; the only kill if `pidOf` threw first
      killQuietly(pid);
    }
  }, 20_000);

  it('rejects as aborted for a signal that was already aborted', async () => {
    const err = await exec('/bin/sleep', ['10'], { signal: AbortSignal.abort() }).then(() => null, (e: unknown) => e as ExecError);
    expect(err).toBeInstanceOf(ExecError);
    expect(err?.aborted).toBe(true);
  }, 20_000);

  it('does not call a timeout or a plain failure aborted', async () => {
    const timed = await exec('/bin/sleep', ['5'], { timeoutMs: 200 }).then(() => null, (e: unknown) => e as ExecError);
    expect(timed?.timedOut).toBe(true);
    expect(timed?.aborted).toBe(false);
    const plain = await exec('/bin/sh', ['-c', 'exit 3']).then(() => null, (e: unknown) => e as ExecError);
    expect(plain?.aborted).toBe(false);
  });

  // One long-lived signal can be handed to many calls; each call's abort listener has to go when that
  // call settles, or they pile up on the signal, each holding its finished child.
  it('leaves no abort listener on the signal once a call settles', async () => {
    const controller = new AbortController();
    await exec('/bin/sh', ['-c', 'exit 0'], { signal: controller.signal });
    await exec('/bin/sh', ['-c', 'exit 3'], { signal: controller.signal }).catch(() => undefined);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('cleanEnv', () => {
  it('drops ELECTRON_* and non-string values, applies overrides', () => {
    const env = cleanEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', UNDEF: undefined }, { TERM: 'xterm' });
    expect(env).toEqual({ PATH: '/bin', TERM: 'xterm' });
  });
  // G1 exists because one leaked ELECTRON_RUN_AS_NODE makes a spawned `node` behave as plain Node.
  // Spreading overrides last would have let a caller put it straight back — and the PTY env, which
  // §9 rule 5 says must be stripped, is built from overrides.
  it('does not let an override reintroduce an ELECTRON_ variable', () => {
    const out = cleanEnv({ PATH: '/bin' }, { ELECTRON_RUN_AS_NODE: '1', HANGAR_HOME: '/h' });
    expect(out).toEqual({ PATH: '/bin', HANGAR_HOME: '/h' });
    expect('ELECTRON_RUN_AS_NODE' in out).toBe(false);
  });
});

describe('atomicWriteJson', () => {
  it('writes via tmp+rename and keeps a .bak of the previous file', () => {
    const dir = tempDir('aw');
    const file = join(dir, 'ws.json');
    const bak = join(dir, 'ws.json.bak');
    atomicWriteJson(file, { v: 1 }, bak);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1 });
    expect(existsSync(bak)).toBe(false);
    atomicWriteJson(file, { v: 2 }, bak);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 2 });
    expect(JSON.parse(readFileSync(bak, 'utf8'))).toEqual({ v: 1 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
  // The config store writes with no bakFile — the one write with no fallback if it goes wrong.
  it('writes without a bakFile, and refuses a value JSON cannot represent', () => {
    const dir = tempDir('aw');
    const file = join(dir, 'config.json');
    atomicWriteJson(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(existsSync(`${file}.bak`)).toBe(false);
    // JSON.stringify(undefined) is undefined, which was concatenated into the literal "undefined".
    expect(() => atomicWriteJson(file, undefined)).toThrow(TypeError);
    expect(JSON.parse(readFileSync(file, 'utf8')), 'previous file intact').toEqual({ a: 1 });
  });
});

describe('freeBytes', () => {
  it('reports free space, walking up to an existing ancestor', () => {
    expect(freeBytes('/tmp')).toBeGreaterThan(0);
    // Not `toBe`: two `statfs` calls milliseconds apart on a live volume routinely disagree by a
    // block. Measured failing ~1 run in 10 with a 4096-byte delta. What this test is actually for is
    // that a missing path walks UP to an existing ancestor rather than throwing, so compare to within
    // a tolerance far below any plausible walk-to-the-wrong-volume error.
    const missing = freeBytes('/tmp/does/not/exist/yet');
    expect(Math.abs(missing - freeBytes('/tmp'))).toBeLessThan(64 * 1024 * 1024);
  });
});
