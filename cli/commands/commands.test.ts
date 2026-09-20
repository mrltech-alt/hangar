import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureExecutable, spawnHelperCandidates } from '../../host/pty-fix.ts';
import type { HostHandle } from '../../host/server.ts';
import { runCli } from '../run.ts';
import { fakeIo, startTestHost } from '../test-util.ts';
import { createContext } from '../context.ts';
import { checkDisk, checkHostNode, checkProfile, checkShellTools, checkSpawnHelper, checkStaleGlobalClaude, readShellTools, runDoctor } from './doctor.ts';
import { formatMirror } from './status.ts';
import { tempDir } from '../../test/fixtures/tmp.ts';

const hosts: HostHandle[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close(true);
});

describe('status', () => {
  it('formats the mirror file', () => {
    expect(
      formatMirror({
        id: 'a', name: 'Fix it', slug: 'fix-it', notes: 'line1\nline2', updatedAt: 'x',
        workspaces: [{ projectName: 'AcmeApi', repoPath: '/r', branch: 'agent/fix-it', worktreePath: '/w' }],
      }),
      // `updated:` is here because §6.6's whole promise is that this works with the app shut down,
      // so staleness is the characteristic failure and the reader cannot otherwise detect it.
      // An unparseable timestamp renders as the em-dash relativeTime uses for "unknown".
    ).toBe('agent:  Fix it (a)\nslug:   fix-it\nupdated: —\n- AcmeApi  agent/fix-it  /w\nnotes:\n  line1\n  line2\n');
  });
  it('reads state/agents/<id>.json from HANGAR_HOME and supports --json', async () => {
    const home = tempDir('status');
    mkdirSync(join(home, 'state', 'agents'), { recursive: true });
    writeFileSync(join(home, 'state', 'agents', 'ag.json'), JSON.stringify({ id: 'ag', name: 'N', slug: 'n', notes: '', workspaces: [], updatedAt: 'x' }));
    const io = fakeIo();
    expect(await runCli(['status', '--json'], { HANGAR_HOME: home, HANGAR_AGENT_ID: 'ag' }, io)).toBe(0);
    expect(JSON.parse(io.out()).name).toBe('N');
    const io2 = fakeIo();
    expect(await runCli(['status'], { HANGAR_HOME: home, HANGAR_AGENT_ID: 'missing' }, io2)).toBe(1);
    expect(io2.err()).toContain('no state for agent');
  });

  // Without this the CLI printed a raw Node stack trace into the agent's own terminal — the only
  // error path in the whole CLI that did not emit a single `hangar: …` line.
  it('reports a corrupt or foreign mirror as an error, not a stack trace', async () => {
    const home = tempDir('status-bad');
    mkdirSync(join(home, 'state', 'agents'), { recursive: true });
    writeFileSync(join(home, 'state', 'agents', 'torn.json'), '{"id":"torn","name":');
    writeFileSync(join(home, 'state', 'agents', 'shape.json'), '{}');

    const io = fakeIo();
    expect(await runCli(['status', '--agent', 'torn', '--home', home], {}, io)).toBe(1);
    expect(io.err()).toContain('is unreadable');

    const io2 = fakeIo();
    expect(await runCli(['status', '--agent', 'shape', '--home', home], {}, io2)).toBe(1);
    expect(io2.err()).toContain('not in the expected format');

    // --json must not bypass the shape check either.
    const io3 = fakeIo();
    expect(await runCli(['status', '--json', '--agent', 'shape', '--home', home], {}, io3)).toBe(1);
  });
});

describe('host', () => {
  it('reports status and can stop the host', async () => {
    const { socketPath, host } = await startTestHost();
    hosts.push(host);
    const io = fakeIo();
    expect(await runCli(['host', 'status'], { HANGAR_SOCKET: socketPath }, io)).toBe(0);
    expect(io.out()).toContain('host: running, 0 session(s)');
    const io2 = fakeIo();
    expect(await runCli(['host', 'status'], { HANGAR_SOCKET: '/tmp/hangar-nope.sock' }, io2)).toBe(1);
    expect(io2.out()).toContain('not running');

    // `stop` is the only command here that mutates state, and it was untested.
    const io3 = fakeIo();
    expect(await runCli(['host', 'stop'], { HANGAR_SOCKET: socketPath }, io3)).toBe(0);
    expect(io3.out()).toContain('shutdown requested');

    const io4 = fakeIo();
    expect(await runCli(['host', 'frobnicate'], { HANGAR_SOCKET: socketPath }, io4)).toBe(1);
    expect(io4.err()).toContain('usage: hangar host');
  });
});

describe('doctor', () => {
  // Injected checks, so the FAIL -> exit 1 contract is pinned without depending on this machine.
  it('exits 1 if any check fails, 0 otherwise', async () => {
    const io = fakeIo();
    const ctx = createContext({ HANGAR_HOME: '/tmp/hangar-doctor-home' }, io);
    expect(await runDoctor([], ctx, [
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'warn', detail: 'meh' },
    ])).toBe(0);

    const io2 = fakeIo();
    const ctx2 = createContext({ HANGAR_HOME: '/tmp/hangar-doctor-home' }, io2);
    expect(await runDoctor([], ctx2, [
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'fail', detail: 'broken' },
    ])).toBe(1);
    expect(io2.out()).toContain('FAIL b: broken');
  });

  it('reports an unreadable probe as such, not as a missing claude', () => {
    // Collapsing the two said "claude not found in the interactive login shell" on a machine where
    // claude is installed and working — an invented diagnosis, in the tool people run when things
    // are already broken.
    const unreadable = checkShellTools({ node: '', claude: '', claudeVersion: '', error: 'the shell printed no readable probe output' });
    expect(unreadable.status).toBe('fail');
    expect(unreadable.detail).toContain('no readable probe output');
    expect(unreadable.detail).not.toContain('claude not found');

    const missing = checkShellTools({ node: '/n', claude: '', claudeVersion: '', error: null });
    expect(missing.detail).toContain('claude not found');
  });

  it('warns only on a genuine claude split, not merely because the global file exists', () => {
    const same = checkStaleGlobalClaude({ node: '/n', claude: '/usr/local/bin/claude', claudeVersion: '2.1.128', error: null });
    expect(same.status).toBe('ok');
    const absent = checkStaleGlobalClaude({ node: '/n', claude: '/nvm/claude', claudeVersion: '2.1.128', error: null }, '/nonexistent/claude');
    expect(absent.status).toBe('ok');
  });

  it('fails when the socket path would exceed the byte limit (G9)', () => {
    expect(checkProfile('/tmp/' + 'x'.repeat(120)).status).toBe('fail');
    expect(checkProfile(tmpdir()).status).not.toBe('fail');
  });

  it('reports a node that cannot run the host as a failure', () => {
    expect(checkHostNode('').status).toBe('fail');
    expect(checkHostNode('/nonexistent/node').status).toBe('fail');
    // A bare name is the lazy-nvm shell-function case. execFileSync would PATH-resolve it against
    // THIS process's env, so the row passed green while describing a binary the host never gets.
    expect(checkHostNode('node').status).toBe('fail');
    expect(checkHostNode('node').detail).toContain('not a path');
  });
});

describe('doctor', () => {
  it('checks pass on this machine', async () => {
    // A fixture, not the real node_modules: asserting on the live tree both mutates it and
    // cannot fail twice, since the call under test sets the bit it then checks (spec §19.4).
    const pkg = tempDir('doctor-pty');
    const prebuilt = join(pkg, 'prebuilds', `${process.platform}-${process.arch}`);
    mkdirSync(prebuilt, { recursive: true });
    const helper = join(prebuilt, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);
    const fix = () => ({ ...ensureExecutable(spawnHelperCandidates(pkg)), packageDir: pkg });

    const check = checkSpawnHelper(fix);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('fixed execute bit');
    expect(statSync(helper).mode & 0o111).not.toBe(0);

    // node-pty absent is a fail; present-but-helperless is only a warn.
    expect(checkSpawnHelper(() => ({ packageDir: null, checked: [], fixed: [], failed: [] })).status).toBe('fail');
    expect(checkSpawnHelper(() => ({ packageDir: '/x', checked: [], fixed: [], failed: [] })).status).toBe('warn');
    expect(checkDisk('/tmp').detail).toMatch(/GB free/);
    const io = fakeIo();
    await runCli(['doctor'], { HANGAR_SOCKET: '/tmp/hangar-nope.sock', SHELL: '/bin/zsh' }, io);
    expect(io.out()).toContain('node-pty spawn-helper');
    expect(io.out()).toContain('session host');
    expect(io.out()).toContain('interactive shell tools');
  });

  // Two defects at once. (1) readShellTools opened its payload but never closed it, so anything the
  // shell printed AFTERWARDS landed in the last field — and `.zlogout` runs after the command on a
  // login shell. With a `.zlogout` of just `echo "Goodbye."`, checkStaleGlobalClaude flipped
  // ok -> warn, because it compares version strings for equality. `hangar doctor` is what people run
  // when things are already broken; a warning it invents is worse than one it misses.
  // (2) `/node$/` matches the bare string `node`, which is what `command -v` prints for a shell
  // function, so the old assertions could not tell a real path from the lazy-nvm failure mode.
  it('frames its payload so trailing shell output cannot leak into a field', () => {
    const zdotdir = tempDir('doctor-zlogout');
    writeFileSync(join(zdotdir, '.zlogout'), 'echo "Goodbye."\n');
    const before = process.env.ZDOTDIR;
    process.env.ZDOTDIR = zdotdir;
    try {
      const tools = readShellTools('/bin/zsh');
      // The leak is what this test is about, and it is observable with or without the `claude` CLI:
      // if the framing broke, `.zlogout`'s output lands in a field either way. Only the assertions
      // that require claude to actually be installed are conditional.
      expect(tools.claudeVersion).not.toContain('Goodbye');
      expect(isAbsolute(tools.node)).toBe(true);
      if (tools.claude !== '') {
        expect(tools.claudeVersion).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/);
        expect(isAbsolute(tools.claude)).toBe(true);
      }
      // The version is the field checkStaleGlobalClaude compares, so assert the row it produces too.
      expect(checkStaleGlobalClaude(tools).detail).not.toContain('Goodbye');
    } finally {
      if (before === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = before;
    }
  }, 30_000);
});
