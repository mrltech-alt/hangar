import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultHome, ensureDirs, getPaths, resolveHome } from './paths.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';

describe('resolveHome', () => {
  it('defaults to ~/.hangar', () => {
    expect(resolveHome({})).toBe(join(homedir(), '.hangar'));
    expect(resolveHome({ HANGAR_HOME: '  ' })).toBe(defaultHome());
  });
  it('expands ~ and makes relative paths absolute', () => {
    expect(resolveHome({ HANGAR_HOME: '~/.hangar-dev' })).toBe(join(homedir(), '.hangar-dev'));
    expect(resolveHome({ HANGAR_HOME: 'rel/x' })).toBe(join(process.cwd(), 'rel/x'));
  });
});

describe('getPaths', () => {
  it('derives every path from home and flags the default', () => {
    const p = getPaths('/tmp/hh');
    expect(p).toMatchObject({
      home: '/tmp/hh',
      isDefaultHome: false,
      workspaceFile: '/tmp/hh/workspace.json',
      workspaceBak: '/tmp/hh/workspace.json.bak',
      configFile: '/tmp/hh/config.json',
      windowStateFile: '/tmp/hh/window-state.json',
      socketPath: '/tmp/hh/run/host.sock',
      pidFile: '/tmp/hh/run/host.pid',
      triageDir: '/tmp/hh/run/triage',
      appLog: '/tmp/hh/logs/app.log',
      hostLog: '/tmp/hh/logs/host.log',
      hostStdioLog: '/tmp/hh/logs/host-stdio.log',
      claudeSettings: '/tmp/hh/claude/settings.json',
      claudeSystemPrompt: '/tmp/hh/claude/system-prompt.md',
      claudeAgentsDir: '/tmp/hh/claude/agents',
      stateAgentsDir: '/tmp/hh/state/agents',
      worktreesDir: '/tmp/hh/worktrees',
      electronUserData: '/tmp/hh/electron',
    });
    expect(getPaths(defaultHome()).isDefaultHome).toBe(true);
  });
  it('rejects a home whose socket path would exceed the macOS limit', () => {
    expect(() => getPaths('/tmp/' + 'x'.repeat(100))).toThrow(/socket path too long/);
  });
});

describe('ensureDirs', () => {
  it('creates all directories, run/ with mode 0700', () => {
    const home = tempDir('paths');
    const p = getPaths(join(home, 'h'));
    ensureDirs(p);
    for (const d of [p.runDir, p.logsDir, p.claudeDir, p.claudeAgentsDir, p.stateAgentsDir, p.worktreesDir, p.electronUserData]) expect(existsSync(d)).toBe(true);
    expect(statSync(p.runDir).mode & 0o777).toBe(0o700);
  });
  // mkdirSync's mode applies only on creation, so a profile restored by rsync/unzip/cloud sync
  // arrives with a loose run/ and keeps it. §16's same-uid guarantee has no other enforcement.
  it('repairs a run/ that already exists with a loose mode, and is idempotent', () => {
    const p = getPaths(join(tempDir('paths'), 'h'));
    mkdirSync(p.runDir, { recursive: true, mode: 0o755 });
    ensureDirs(p);
    ensureDirs(p);
    expect(statSync(p.runDir).mode & 0o777).toBe(0o700);
  });
});
