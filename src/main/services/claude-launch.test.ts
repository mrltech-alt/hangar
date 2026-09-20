import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { defaultProjectSetup, type Agent, type Project } from '../../../shared/types.ts';
import { buildHookSettings, buildSystemPrompt, claudeProjectKey, composeClaudeArgs, composeStartupCommand, memoryDirFor, writeAgentSettings, writeClaudeFiles } from './claude-launch.ts';

const project: Project = { id: 'p1', name: 'AcmeApi', repoPath: '/r', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: ['--model', 'opus'], createdAt: 'x' };
const agent: Agent = {
  id: 'a1', name: 'Fix webhooks', slug: 'fix-webhooks', folderId: null, sortKey: 0, notes: '', createdAt: 'x', lastOpenedAt: null,
  workspaces: [
    { id: 'w1', projectId: 'p1', branch: 'agent/fix-webhooks', worktreePath: '/wt/acmeapi', baseRef: 'origin/main', createdAt: 'x' },
    { id: 'w2', projectId: 'p2', branch: 'agent/fix-webhooks', worktreePath: '/wt/frontend', baseRef: 'origin/main', createdAt: 'x' },
  ],
  claude: { sessionId: '11111111-2222-3333-4444-555555555555', hasStartedOnce: false, permissionMode: 'acceptEdits', extraArgs: ['--verbose'] },
};
// `LaunchFiles`, not `HangarPaths`: since §11.9 the settings path handed to one launch is that
// agent's generated file, so the composer takes the two paths it actually emits and nothing else.
const files = { settings: '/h/claude/settings.json', systemPrompt: '/h/claude/system-prompt.md' };

describe('composeClaudeArgs', () => {
  it('first start uses --session-id, re-passes --add-dir, settings, prompt, mode, then project and agent args', () => {
    expect(composeClaudeArgs(agent, project, files, false, [])).toEqual([
      '--name', 'Fix webhooks',
      '--session-id', '11111111-2222-3333-4444-555555555555',
      '--add-dir', '/wt/frontend',
      '--settings', '/h/claude/settings.json',
      '--append-system-prompt-file', '/h/claude/system-prompt.md',
      '--permission-mode', 'acceptEdits',
      '--model', 'opus',
      '--verbose',
    ]);
  });
  it('resume uses --resume, omits the mode when null, and still passes the default args ahead of project and agent args', () => {
    const args = composeClaudeArgs({ ...agent, claude: { ...agent.claude, permissionMode: null } }, project, files, true, ['--effort', 'xhigh']);
    expect(args.slice(0, 4)).toEqual(['--name', 'Fix webhooks', '--resume', '11111111-2222-3333-4444-555555555555']);
    expect(args).not.toContain('--permission-mode');
    expect(args.slice(-5)).toEqual(['--effort', 'xhigh', '--model', 'opus', '--verbose']);
  });
  // Spec 2026-09-15 §5.1. The ORDER is the whole feature: measured on claude 2.1.272, the LAST
  // duplicate `--model` wins, so the Hangar-wide defaults must come before the project's `claudeArgs`,
  // which must come before the agent's `extraArgs` — each more specific list overriding the one before.
  it('orders the args: Hangar-composed, then config.claudeDefaultArgs, then project claudeArgs, then agent extraArgs', () => {
    expect(composeClaudeArgs(agent, project, files, false, ['--model', 'claude-opus-5[1m]', '--effort', 'xhigh'])).toEqual([
      '--name', 'Fix webhooks',
      '--session-id', '11111111-2222-3333-4444-555555555555',
      '--add-dir', '/wt/frontend',
      '--settings', '/h/claude/settings.json',
      '--append-system-prompt-file', '/h/claude/system-prompt.md',
      '--permission-mode', 'acceptEdits',
      '--model', 'claude-opus-5[1m]', '--effort', 'xhigh',
      '--model', 'opus',
      '--verbose',
    ]);
  });
});

describe('composeStartupCommand', () => {
  it('quotes every argument so hostile names survive the shell', () => {
    const hostile = { ...agent, name: `it's "quoted" $HOME \`id\`` };
    const cmd = composeStartupCommand(composeClaudeArgs(hostile, project, files, false, []));
    expect(cmd.startsWith("claude '--name' ")).toBe(true);
    const echoed = execFileSync('/bin/sh', ['-c', cmd.replace(/^claude/, 'printf "%s\\n"')], { encoding: 'utf8' }).split('\n');
    expect(echoed[1]).toBe(`it's "quoted" $HOME \`id\``);
  });

  it('leaves the command word unquoted so a user alias for claude still resolves', () => {
    const cmd = composeStartupCommand(composeClaudeArgs(agent, project, files, false, []));
    expect(cmd.startsWith('claude ')).toBe(true);
  });

  // Quoting cannot contain these: the line is typed into a live shell, so ZLE eats the
  // control byte (and the opening quote with it) before the parser runs. See the docstring.
  it('strips control characters, which would otherwise break out of the quotes', () => {
    const hostile = { ...agent, name: 'Fix bug\u0003touch /tmp/hangar-canary\r' };
    const cmd = composeStartupCommand(composeClaudeArgs(hostile, project, files, false, []));
    expect(cmd).toContain("'Fix bug touch /tmp/hangar-canary '");
  });

  // Pinned to an exact expected output per character rather than re-derived from the
  // implementation's own regex: a mutant that narrows the stripped class (drops \u007f or
  // \u0000 from it, or narrows the whole class down to just \r) must fail here even though it
  // still strips *some* control bytes. Mirrors shared/agent-name.test.ts's membership test for
  // the sibling function -- this composer used to keep its own private copy of the same class.
  const CONTROL_CHARS: [string, string][] = [
    ['NUL', '\u0000'],
    ['ETX', '\u0003'],
    ['NAK', '\u0015'],
    ['ESC', '\u001b'],
    ['DEL', '\u007f'],
  ];
  it.each(CONTROL_CHARS)('replaces %s with a space rather than passing it through', (_label, ch) => {
    const hostile = { ...agent, name: `Fix${ch}bug` };
    const cmd = composeStartupCommand(composeClaudeArgs(hostile, project, files, false, []));
    expect(cmd).toContain("'Fix bug'");
  });
});

describe('generated Claude files', () => {
  it('hook settings wire all six events to the absolute hangar shim and enable the bell', () => {
    const s = buildHookSettings('/Users/x y/hangar/bin/hangar') as { hooks: Record<string, unknown[]>; preferredNotifChannel: string };
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: "'/Users/x y/hangar/bin/hangar' event", timeout: 5 }] }]);
    expect(s.preferredNotifChannel).toBe('terminal_bell');
  });
  it('system prompt names the three commands', () => {
    const p = buildSystemPrompt('/h/bin/hangar');
    for (const cmd of ['hangar rename', 'hangar note', 'hangar status']) expect(p).toContain(cmd);
    expect(p).toContain('/h/bin/hangar');
  });
  it('writeClaudeFiles writes both files', () => {
    const dir = tempDir('claude');
    const out = { claudeSettings: join(dir, 'settings.json'), claudeSystemPrompt: join(dir, 'system-prompt.md') };
    writeClaudeFiles(out, '/h/bin/hangar');
    expect(JSON.parse(readFileSync(out.claudeSettings, 'utf8')).preferredNotifChannel).toBe('terminal_bell');
    expect(readFileSync(out.claudeSystemPrompt, 'utf8')).toContain('Hangar');
  });
});

describe('memory sharing (§11.9)', () => {
  it('encodes a path the way Claude Code does — every non-alphanumeric becomes a hyphen', () => {
    expect(claudeProjectKey('/Users/me/code')).toBe('-Users-me-code');
    expect(claudeProjectKey('/Users/me/.hangar/worktrees/AcmeApi/fix')).toBe('-Users-me--hangar-worktrees-AcmeApi-fix');
    expect(memoryDirFor('/Users/me/code', '/Users/me')).toBe('/Users/me/.claude/projects/-Users-me-code/memory');
  });

  // The awkward cases, because "non-alphanumeric" is easy to get right on a happy path and easy to
  // get wrong everywhere else. Checked against the encoder read out of the 2.1.266 bundle
  // (`e.replace(/[^a-zA-Z0-9]/g,"-")`) and against the real directory names in ~/.claude/projects:
  // `/Users/me/.hangar-dev/playground` is filed there as `-Users-me--hangar-dev-playground`,
  // which is exactly what this produces.
  it('collapses nothing: a dot, a space, an existing hyphen and a unicode character each map to one hyphen', () => {
    expect(claudeProjectKey('/Users/me/.hangar-dev/playground')).toBe('-Users-me--hangar-dev-playground');
    expect(claudeProjectKey('/a/My Repo')).toBe('-a-My-Repo');          // space
    expect(claudeProjectKey('/a/re-po')).toBe('-a-re-po');              // hyphen survives as itself
    expect(claudeProjectKey('/a/b.c.d')).toBe('-a-b-c-d');              // dots
    expect(claudeProjectKey('/a/café')).toBe('-a-caf-');                // é is one non-alphanumeric
    expect(claudeProjectKey('/a/日本')).toBe('-a---');                   // two chars, two hyphens
    expect(claudeProjectKey('/a/repo/')).toBe('-a-repo-');              // trailing slash is NOT trimmed
    expect(claudeProjectKey('/a/_x')).toBe('-a--x');                    // underscore is not alphanumeric
  });

  // A KNOWN divergence, pinned so it stays visible rather than being discovered as a bug. The CLI
  // caps the encoded key at 200 characters and appends `-<base36 hash>` past that; the hash is an
  // internal function in the bundle and nothing here can reproduce it. So for a repo path this long
  // the opt-in points at a directory Claude Code never writes to. Measured, not repaired.
  it('does NOT reproduce the CLI’s 200-character truncation', () => {
    const long = '/' + 'a'.repeat(240);
    expect(claudeProjectKey(long).length).toBe(241);
    expect(claudeProjectKey(long).length).toBeGreaterThan(200);
  });

  it('writes a per-agent settings file, with autoMemoryDirectory only when sharing is on', () => {
    // `tempDir` — self-cleaning, and under /tmp on purpose (macOS os.tmpdir() blows the 104-byte
    // sun_path limit, G9).
    const dir = tempDir('agentsettings');
    const off = writeAgentSettings(dir, 'a1', { ...project, shareClaudeMemory: false }, '/h/bin/hangar', '/Users/me');
    expect(JSON.parse(readFileSync(off, 'utf8')).autoMemoryDirectory).toBeUndefined();
    const on = writeAgentSettings(dir, 'a1', { ...project, shareClaudeMemory: true }, '/h/bin/hangar', '/Users/me');
    const json = JSON.parse(readFileSync(on, 'utf8'));
    expect(json.autoMemoryDirectory).toBe('/Users/me/.claude/projects/-r/memory');
    expect(Object.keys(json.hooks).length).toBe(6);
    expect(on).toBe(join(dir, 'a1.json'));
  });

  // The file is GENERATED, so turning the setting off has to remove the key, not leave the last
  // value on disk. This is the direction the plan's test did not cover and the one a user would
  // actually notice.
  it('drops autoMemoryDirectory again when the project setting is turned back off', () => {
    const dir = tempDir('agentsettings');
    writeAgentSettings(dir, 'a1', { ...project, shareClaudeMemory: true }, '/h/bin/hangar', '/Users/me');
    const file = writeAgentSettings(dir, 'a1', { ...project, shareClaudeMemory: false }, '/h/bin/hangar', '/Users/me');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('autoMemoryDirectory');
    expect(JSON.parse(text).preferredNotifChannel).toBe('terminal_bell');
  });

  // A project written before §11.9 has no such key at all; `undefined` must behave as off rather
  // than as `!== false`.
  it('treats a project with the field absent as off', () => {
    const dir = tempDir('agentsettings');
    const file = writeAgentSettings(dir, 'a1', project, '/h/bin/hangar', '/Users/me');
    expect(JSON.parse(readFileSync(file, 'utf8')).autoMemoryDirectory).toBeUndefined();
  });
});
