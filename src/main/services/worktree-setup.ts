// Make a fresh worktree usable — spec §10.2 steps 5–7 and G12/G13/G28.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Exec } from '../util/exec.ts';

export type SetupLog = (line: string) => void;

const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);

/**
 * Resolves `rel` against `root` and refuses anything that lands outside it.
 *
 * `rel` comes from `globSync` output or straight from user-authored config (copy-pattern lists),
 * and can contain `..` or even look absolute (`resolve('/repo', '/etc/hosts')` yields `/etc/hosts`,
 * unlike `join`, which is exactly why `resolve` — not `join` — is what makes this check meaningful).
 * A pattern like `../.env` or one pasted from another project must not read from, or write to,
 * anything outside `root`. Returns null rather than throwing: an escaping match is a config mistake
 * to skip and log, not a reason to abort the whole batch (see the per-file try/catch below).
 */
function resolveWithin(root: string, rel: string): string | null {
  const abs = resolve(root, rel);
  const withSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(withSep)) return null;
  return abs;
}

/** Copies files matching gitignored-file patterns (e.g. ".env", ".env.*") from the main checkout. Returns relative paths copied. */
export function copyPatterns(repoPath: string, worktreePath: string, patterns: string[], log: SetupLog): string[] {
  // A wrong/mistyped worktree path must fail loudly, not fabricate a plausible-looking directory
  // tree next to whatever the caller actually meant (mkdirSync(..., {recursive:true}) below would
  // otherwise manufacture it silently).
  if (!existsSync(worktreePath)) {
    throw new Error(`copyPatterns: worktree path does not exist: ${worktreePath}`);
  }
  const copied: string[] = [];
  for (const pattern of patterns) {
    // Synchronous and can block the main thread on a very broad pattern (e.g. `**/*` over a large
    // tree) — acceptable for the small, fixed pattern lists this is called with, but a caller that
    // starts accepting arbitrary user-typed globs should move this off the main thread.
    const matches = globSync(pattern, {
      cwd: repoPath,
      exclude: (name: string) => name.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg)),
    });
    for (const rel of matches) {
      const src = resolveWithin(repoPath, rel);
      const dst = src === null ? null : resolveWithin(worktreePath, rel);
      if (src === null || dst === null) {
        log(`skip ${rel}: pattern escapes the repo or worktree root`);
        continue;
      }
      try {
        // Symlinks are followed (statSync/copyFileSync, not the l- variants): a `.env` symlinked
        // outside the repo still gets its content copied in, which is the useful case. `src` itself
        // stays inside `repoPath` either way — only its target may live elsewhere — so this cannot
        // reintroduce the escape the check above rules out.
        if (!statSync(src).isFile()) continue;
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        copied.push(rel);
        log(`copied ${rel}`);
      } catch (e) {
        // One unreadable or vanished file (permissions, a race, a broken symlink) must not abort
        // the rest of the batch — this runs with no try/catch around it at the call site.
        log(`skip ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return copied;
}

/**
 * APFS copy-on-write clone (`cp -c -R`): instant and space-shared. `cp -c` does NOT fail on a
 * non-APFS volume (or across filesystems) — it silently degrades to a full byte copy and exits 0
 * (G28). So this compares `statSync(...).dev` on both sides first and refuses to even attempt the
 * clone when they differ, rather than trusting the exit code.
 */
/** Injectable only so the cross-filesystem guard can be tested without creating a real second
 *  filesystem — a RAM disk leaks until reboot if the test runner is interrupted. */
export type DeviceOf = (path: string) => number;
const realDeviceOf: DeviceOf = (p) => statSync(p).dev;

export async function cloneDirs(repoPath: string, worktreePath: string, dirs: string[], exec: Exec, log: SetupLog, deviceOf: DeviceOf = realDeviceOf): Promise<{ cloned: string[]; skipped: string[] }> {
  const cloned: string[] = [];
  const skipped: string[] = [];
  const destDev = deviceOf(worktreePath);
  for (const dir of dirs) {
    const src = resolve(repoPath, dir);
    const dst = resolve(worktreePath, dir);
    if (!existsSync(src)) {
      skipped.push(dir);
      log(`skip ${dir}: not present in ${repoPath}`);
      continue;
    }
    if (existsSync(dst)) {
      skipped.push(dir);
      log(`skip ${dir}: already exists in the worktree`);
      continue;
    }
    if (deviceOf(src) !== destDev) {
      skipped.push(dir);
      log(`skip ${dir}: source and worktree are on different filesystems; cp -c would silently full-copy instead of cloning (G12/G28) — refusing`);
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      await exec('/bin/cp', ['-c', '-R', src, dst], { timeoutMs: 300_000 });
      cloned.push(dir);
      log(`cloned ${dir} (APFS copy-on-write)`);
    } catch (e) {
      // A `cp` that fails partway can still have written some of the tree. Leaving it behind is
      // worse than having skipped outright: `existsSync(dst)` above would then make a retry treat
      // the half-populated directory as "already there" and never repair it.
      rmSync(dst, { recursive: true, force: true });
      skipped.push(dir);
      log(`warn: could not clone ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { cloned, skipped };
}

/**
 * SIGKILLs `rootPid` and every process descended from it.
 *
 * Reuses the approach from `Session.killTree()` (host/session.ts, spec G38): snapshot the tree from
 * `ps` BEFORE killing anything (ppid links break as soon as a process dies), then kill deepest-first
 * so a parent cannot re-fork while we work down the tree. The process GROUP is the wrong unit here:
 * `-ilc` turns on job control, so each backgrounded job in the postCreate script gets its OWN process
 * group, not the shell's — signalling only the shell's group leaves those jobs running, reparented to
 * pid 1, still writing into a worktree that createAgent's rollback is about to force-remove. Measured
 * on this machine: a `(sleep 1; touch marker) & sleep 30` job survived `process.kill(-shellPid, ...)`
 * and created its marker file after the shell was gone.
 */
function killDescendants(rootPid: number): void {
  const victims: number[] = [];
  try {
    const children = new Map<number, number[]>();
    for (const line of execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      const siblings = children.get(ppid);
      if (siblings === undefined) children.set(ppid, [pid]);
      else siblings.push(pid);
    }
    const stack = [rootPid];
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      victims.push(pid);
      stack.push(...(children.get(pid) ?? []));
    }
  } catch {
    victims.push(rootPid); // ps unavailable: at least kill the shell itself
  }
  for (const pid of victims.reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** A line forwarder that caps its buffer so unbounded newline-free output cannot grow it without bound. */
function lineForwarder(prefix: string, log: SetupLog): { onData: (chunk: Buffer) => void; flush: () => void } {
  // 64 KiB: generous for a real log line, tiny next to the multi-hundred-MB growth an unbounded
  // buffer produced on newline-free output (measured: 2.4 GB heap for 300 MB of it). exec.ts caps
  // whole-process output at 32 MB for the same reason; raw `spawn` has no equivalent of its own.
  const MAX_BUF = 64 * 1024;
  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    let i = buf.indexOf('\n');
    while (i !== -1) {
      log(`${prefix}${buf.slice(0, i)}`);
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
    if (buf.length > MAX_BUF) {
      log(`${prefix}${buf}`);
      buf = '';
    }
  };
  const flush = () => {
    // A final line with no trailing newline (the likeliest shape for a postCreate's last error
    // message) would otherwise sit in `buf` and never reach `log` at all.
    if (buf.length > 0) {
      log(`${prefix}${buf}`);
      buf = '';
    }
  };
  return { onData, flush };
}

/** Runs the user's postCreate command in an interactive login shell inside the worktree, streaming output lines to `log`. */
export function runPostCreate(opts: {
  shell: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  log: SetupLog;
  timeoutMs?: number;
}): Promise<{ ok: boolean; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    // No `detached: true`: it does not help the timeout kill (see `killDescendants`) and buys
    // nothing else here. No `unref()`: piped stdio keeps streaming and the parent still waits.
    const child = spawn(opts.shell, ['-ilc', opts.command], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      opts.log('postCreate timed out; killing it');
      // SIGKILL, not the exec.ts default of SIGTERM: this is an INTERACTIVE shell (`-ilc`, required
      // by G4/G5), and an interactive shell ignores SIGTERM (G43/G5) — it would run to completion
      // regardless of the timeout. There is no git index.lock concern here (G44) unless the user's
      // own command is `git`, in which case a wedge in a worktree about to be force-removed by
      // rollback is the lesser problem next to a script that never stops.
      killDescendants(child.pid as number);
    }, opts.timeoutMs ?? 600_000);
    const out = lineForwarder('', opts.log);
    const err = lineForwarder('stderr: ', opts.log);
    child.stdout.on('data', out.onData);
    child.stderr.on('data', err.onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.log(`postCreate failed to start: ${e.message}`);
      resolve({ ok: false, code: null, timedOut: false });
    });
    // 'exit', not 'close': 'close' waits for the child's stdio pipes to close, and a backgrounded
    // orphan job that inherited those pipes can hold them open long after the shell itself is gone
    // — measured, 'exit' fired at 1,023 ms while 'close' waited the full 30 s of the orphan's own
    // sleep. `killDescendants` above kills that orphan too, but tying resolution to 'exit' rather
    // than 'close' means a leak in some OTHER shape does not also wedge this promise.
    child.on('exit', (code) => {
      clearTimeout(timer);
      out.flush();
      err.flush();
      resolve({ ok: code === 0, code, timedOut });
    });
  });
}
