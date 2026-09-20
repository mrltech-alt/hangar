// How a Claude Code session is launched — spec §11.1–§11.3.
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripControlChars } from '../../../shared/agent-name.ts';
import { shellJoin, shellQuote } from '../../../shared/shell-quote.ts';
import { HOOK_NAMES } from '../../../shared/status.ts';
import type { Agent, Project } from '../../../shared/types.ts';
import { atomicWriteJson } from '../util/atomic-write.ts';

/**
 * The two files `writeClaudeFiles` rewrites at app start (§11.2). Structurally satisfied by
 * `HangarPaths`, which is what `index.ts` passes.
 *
 * NOT the same thing as `LaunchFiles` below, and the plan for this task ("delete the old
 * `LaunchPaths` interface") was wrong to assume it could go: `writeClaudeFiles` still names these
 * two paths, and it is the only writer of the shared `claude/settings.json`.
 */
export interface LaunchPaths {
  claudeSettings: string;
  claudeSystemPrompt: string;
}

/**
 * What one launch actually points `claude` at. `settings` is now PER AGENT (§11.9) — written by
 * `writeAgentSettings` just before the command is composed — while `systemPrompt` is still the one
 * shared file. Splitting this out of `LaunchPaths` is what stops a caller passing `HangarPaths`
 * whole and silently getting the shared settings back.
 */
export interface LaunchFiles {
  settings: string;
  systemPrompt: string;
}

/** Change to '--append-system-prompt' (and pass the text) only if Task 11 Step 1 showed the -file variant is unavailable. */
export const SYSTEM_PROMPT_FLAG = '--append-system-prompt-file';

export function composeClaudeArgs(agent: Agent, primaryProject: Project, files: LaunchFiles, resume: boolean, defaultArgs: readonly string[]): string[] {
  const args: string[] = ['--name', agent.name, resume ? '--resume' : '--session-id', agent.claude.sessionId];
  for (const w of agent.workspaces.slice(1)) args.push('--add-dir', w.worktreePath); // not restored by --resume (G15)
  // `--settings` wins first over a duplicate later in `extraArgs` in 2.1.128 (verified deterministically
  // over 3 runs), so Hangar's hooks cannot be displaced by a user's own `--settings`. That rests on an
  // undocumented manual argv scan in the CLI bundle ahead of commander's parse, not a contract — do not
  // rely on it holding across versions. `--permission-mode`, in contrast, is a plain commander option: a
  // duplicate later in `extraArgs` parses without error, so a user's `extraArgs` silently contradicts
  // `agent.claude.permissionMode`. Which one wins was not established (would require launching a real
  // session) — the contradiction is accepted and untested, not resolved.
  args.push('--settings', files.settings, SYSTEM_PROMPT_FLAG, files.systemPrompt);
  if (agent.claude.permissionMode !== null) args.push('--permission-mode', agent.claude.permissionMode);
  // `defaultArgs` is `config.claudeDefaultArgs` (spec 2026-09-15 §5.1): Hangar-wide, so it goes BEFORE
  // the project's and the agent's own lists. Measured 2026-09-15 on claude 2.1.272: for a duplicated
  // `--model` the LAST occurrence wins in both orders (`--model sonnet --model 'claude-opus-5[1m]'` ran
  // Opus; the reverse ran claude-sonnet-5, confirmed via `modelUsage` in `-p --output-format json`). So
  // project `claudeArgs` and agent `extraArgs`, which come after `claudeDefaultArgs`, override it.
  // `claude-launch.test.ts` pins this order.
  args.push(...defaultArgs, ...primaryProject.claudeArgs, ...agent.claude.extraArgs);
  return args;
}

/**
 * The line typed into the agent's login shell (spec §8.2). Every ARGUMENT is single-quoted;
 * the command word is left bare.
 *
 * Two non-obvious decisions, both verified on this machine:
 *
 * 1. Control characters are stripped first, because quoting cannot contain them. This line is
 *    TYPED into a live interactive zsh, so the line editor (ZLE) consumes control bytes before
 *    the shell parser ever sees the quotes: a `\x03` (send-break) or `\x15` (kill-line) inside
 *    an agent name discards the buffer INCLUDING the opening quote, and an embedded `\r` then
 *    submits whatever follows as a fresh command in the user's login shell. `shellQuote` is a
 *    parser-level defence and cannot help here — no round-trip test through `sh -c` can even
 *    detect it. Verified: a name of `Fix bug\x03touch /tmp/CANARY\r` created the canary; the
 *    same name with a bare `\r` and no control byte did not. This is the choke point for every
 *    interpolated value, including project `claudeArgs` and per-agent `extraArgs` — so it uses
 *    `stripControlChars` from `shared/agent-name.ts`, the single place this character class is
 *    defined, rather than a private copy (a narrowed copy here would not be caught by that
 *    module's own tests; see `agent-name.ts`'s docstring).
 * 2. `claude` is NOT quoted. Quoting a command word suppresses alias expansion in zsh and bash —
 *    verified against a real PTY: an alias resolves with a bare word and fails to resolve when
 *    quoted (`command not found`), while a shell function resolves either way. So this specifically
 *    protects users whose `claude` is an alias, e.g. `alias claude='npx @anthropic-ai/claude-code'`,
 *    while `hangar doctor`'s `command -v claude` still reports it present either way. The command
 *    word is a fixed literal and never user data, so quoting it bought no safety at all. Spec §9.1
 *    wants the PTY to behave exactly as the user's own Terminal does.
 */
export function composeStartupCommand(args: string[]): string {
  return `claude ${shellJoin(args.map(stripControlChars))}`;
}

export function buildHookSettings(hangarBin: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  // A fresh object literal per hook name: `buildHookSettings` is exported, and sharing one `entry`
  // reference across all six arrays would let a caller that mutates `hooks.Stop[0]` silently mutate
  // `hooks.SessionEnd[0]` too. Harmless through the `JSON.stringify` this module actually performs,
  // but nothing enforces that stays the only consumer.
  for (const name of HOOK_NAMES) hooks[name] = [{ hooks: [{ type: 'command', command: `${shellQuote(hangarBin)} event`, timeout: 5 }] }];
  return { hooks, preferredNotifChannel: 'terminal_bell' };
}

export function buildSystemPrompt(hangarBin: string): string {
  return [
    'You are running inside Hangar, a desktop manager for Claude Code sessions. Your session is one "agent" in Hangar\'s sidebar.',
    `A \`hangar\` command is on PATH (also at ${hangarBin}). Use it sparingly:`,
    '- `hangar rename "<short title>"` — rename this agent in the sidebar once you understand the task. Keep it under 40 characters, e.g. "AcmeApi: fix Billing webhook retries".',
    '- `hangar note "<text>"` — append a line to this agent\'s notes. Use it when you are blocked or when the user will need context to resume later (what is waiting on what, and why).',
    '- `hangar status` — print this agent\'s name, projects, branches and worktree paths.',
    'Do not use these commands as a substitute for replying to the user.',
    '',
  ].join('\n');
}

/**
 * Both files are rewritten at every app start (spec §11.2) while other agents may already be
 * launching against them, so each write is tmp-then-rename rather than a bare `writeFileSync`: a
 * reader never observes a torn or truncated file. `claudeSettings` is JSON, so it goes through the
 * house `atomicWriteJson` helper (also used by `workspace-store.ts`); `claudeSystemPrompt` is plain
 * text, so it gets the same tmp+rename by hand, matching `state-mirror.ts`'s pattern.
 *
 * Throws a bare ENOENT if the directory holding `paths.claudeSettings`/`claudeSystemPrompt`
 * (`HangarPaths.claudeDir`) does not exist yet — untested here; `ensureDirs()` in `paths.ts` is
 * relied on to run first (spec §17 orders it that way).
 *
 * Since §11.9, `claudeSettings` is NO LONGER the file a launch points `--settings` at —
 * `writeAgentSettings` writes a per-agent one and `composeClaudeArgs` takes that. This file is kept
 * because it is the boot-time artefact `index.ts` reports on (`writeSideFile`), and because it is
 * the only copy of the hooks that survives when no agent has ever been started; it is not read by
 * `claude` on any path Hangar composes. Do not add settings here expecting a session to see them.
 */
export function writeClaudeFiles(paths: LaunchPaths, hangarBin: string): void {
  atomicWriteJson(paths.claudeSettings, buildHookSettings(hangarBin));
  const promptTmp = `${paths.claudeSystemPrompt}.tmp`;
  writeFileSync(promptTmp, buildSystemPrompt(hangarBin));
  renameSync(promptTmp, paths.claudeSystemPrompt);
}

/**
 * Claude Code's own encoding of a directory into a `~/.claude/projects/<key>` segment: every
 * character outside `[a-zA-Z0-9]` becomes `-`. Read out of the 2.1.266 bundle rather than assumed —
 * it is literally `e.replace(/[^a-zA-Z0-9]/g,"-")` there.
 *
 * ONE measured divergence, deliberately not reproduced: the CLI then caps the encoded key at 200
 * characters and appends `-<base36 hash of the original path>` when it is longer. The hash is an
 * internal, unnamed function in the bundle, so there is nothing here that could reproduce it. For a
 * repo path whose encoding exceeds 200 characters, `memoryDirFor` therefore names a directory the
 * CLI will never use, and the opt-in below silently points at an empty memory instead of the main
 * checkout's. Pinned by a test so the boundary stays visible; a repo path that long is the only
 * case, and it is not repaired.
 */
export function claudeProjectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** `~/.claude/projects/<encoded repo path>/memory` — where Claude Code keeps a project's auto-memory. */
export function memoryDirFor(repoPath: string, home: string): string {
  return join(home, '.claude', 'projects', claudeProjectKey(repoPath), 'memory');
}

/**
 * The per-agent generated settings file (§11.9): the shared hooks, plus `autoMemoryDirectory`
 * pointing at the MAIN checkout's memory when the project opts in.
 *
 * Three things about this were measured against the installed CLI (2.1.266) rather than assumed:
 *
 * 1. **The opt-in is a fallback, not a fix.** The CLI's default memory directory is
 *    `~/.claude/projects/<encoded X>/memory/`, where X is the canonical *git repository root* —
 *    `canonicalWcRoot ?? gitRoot(cwd) ?? cwd` — and for a linked worktree the canonical root is
 *    resolved back to the main checkout by reading the worktree's `.git` pointer file, following
 *    its `commondir`, and checking the admin dir's `gitdir` points back. So worktrees of one repo
 *    ALREADY share a memory directory, and §23 item 3's premise holds. This setting exists for the
 *    cases where that resolution bails out and returns the worktree itself — every one of those
 *    back-checks failing returns the worktree path — and for a user who simply wants it pinned.
 * 2. **It has to arrive by `--settings`.** The CLI reads `autoMemoryDirectory` from, in order,
 *    `policySettings`, `flagSettings`, `localSettings`/`projectSettings`, `userSettings` — and it
 *    IGNORES the value in `projectSettings` (a checked-in `.claude/settings.json`) for security.
 *    `flagSettings` is the `--settings` file, i.e. this one, and it outranks everything a user can
 *    write except a managed policy.
 * 3. **It is generated, every start.** There is nothing here to preserve across writes: turning the
 *    project setting off drops the key from the file at the next start of any of its agents. A
 *    session already running keeps whatever it read at launch — Hangar cannot revise that.
 *
 * A plain `writeFileSync`, not the `atomicWriteJson` the shared files get: this path is written
 * microseconds before the one process that will read it is spawned, and no other writer names it
 * (the file is keyed by agent id, and an agent has at most one session).
 */
export function writeAgentSettings(agentsDir: string, agentId: string, project: Project, hangarBin: string, home: string): string {
  const settings: Record<string, unknown> = { ...buildHookSettings(hangarBin) };
  if (project.shareClaudeMemory === true) settings.autoMemoryDirectory = memoryDirFor(project.repoPath, home);
  const file = join(agentsDir, `${agentId}.json`);
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}
