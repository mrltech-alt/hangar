// HANGAR_HOME resolution and every derived path — spec §5.2. Nothing else may hard-code these locations.
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSocketPathLength } from '../../../shared/host-protocol.ts';

export interface HangarPaths {
  readonly home: string;
  readonly isDefaultHome: boolean;
  readonly workspaceFile: string;
  readonly workspaceBak: string;
  readonly configFile: string;
  /** Where the main window was last left (spec §13). Main-owned; see `window-state.ts`. */
  readonly windowStateFile: string;
  readonly runDir: string;
  readonly socketPath: string;
  readonly pidFile: string;
  /**
   * The empty cwd a Linear triage's `claude -p` runs in (Plan 06): outside every project, so no
   * project's CLAUDE.md or `.claude/settings.json` is picked up from the cwd. Settings files are kept
   * out separately, by `--setting-sources ''` (linear-triage.ts); whether CLAUDE.md files in parent
   * directories (`~/CLAUDE.md`, for one) are still read under that flag has not been measured. Created on demand.
   */
  readonly triageDir: string;
  readonly logsDir: string;
  readonly appLog: string;
  readonly hostLog: string;
  readonly hostStdioLog: string;
  readonly claudeDir: string;
  readonly claudeSettings: string;
  readonly claudeSystemPrompt: string;
  readonly claudeAgentsDir: string;
  readonly stateAgentsDir: string;
  readonly worktreesDir: string;
  readonly electronUserData: string;
}

export function defaultHome(): string {
  return join(homedir(), '.hangar');
}

/**
 * Main is the OUTER boundary: it is the only one of the three resolvers that sees unnormalized user
 * input, and both children receive its already-resolved output (`HANGAR_HOME: paths.home`). That is
 * why it expands `~` while `host/main.ts` and `cli/context.ts` do not — making the outermost
 * resolver stricter than what it feeds would be the odd choice.
 */
export function resolveHome(env: NodeJS.ProcessEnv): string {
  const raw = env.HANGAR_HOME;
  if (raw === undefined || raw.trim().length === 0) return defaultHome();
  const trimmed = raw.trim();
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  return resolve(expanded);
}

export function getPaths(home: string): HangarPaths {
  const runDir = join(home, 'run');
  const logsDir = join(home, 'logs');
  const claudeDir = join(home, 'claude');
  const paths: HangarPaths = {
    home,
    isDefaultHome: home === defaultHome(),
    workspaceFile: join(home, 'workspace.json'),
    workspaceBak: join(home, 'workspace.json.bak'),
    configFile: join(home, 'config.json'),
    windowStateFile: join(home, 'window-state.json'),
    runDir,
    socketPath: join(runDir, 'host.sock'),
    pidFile: join(runDir, 'host.pid'),
    triageDir: join(runDir, 'triage'),
    logsDir,
    appLog: join(logsDir, 'app.log'),
    hostLog: join(logsDir, 'host.log'),
    // Separate from hostLog on purpose: createFileLogger RENAMES host.log on rotation, and the
    // launcher's inherited fd would keep writing into the renamed inode (spec §8.3 step 2).
    hostStdioLog: join(logsDir, 'host-stdio.log'),
    claudeDir,
    claudeSettings: join(claudeDir, 'settings.json'),
    claudeSystemPrompt: join(claudeDir, 'system-prompt.md'),
    // One generated settings file per agent (§11.9). Written at every start, never edited by hand.
    claudeAgentsDir: join(claudeDir, 'agents'),
    stateAgentsDir: join(home, 'state', 'agents'),
    worktreesDir: join(home, 'worktrees'),
    electronUserData: join(home, 'electron'),
  };
  assertSocketPathLength(paths.socketPath);
  return paths;
}

export function ensureDirs(p: HangarPaths): void {
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  // `mkdirSync`'s mode applies only on CREATION, so a profile restored by rsync without -p, an
  // unzip with no stored modes, or a cloud-sync client arrives at 0755 and stays there. That
  // matters: §16's same-uid guarantee rests on this directory alone — there is no getpeereid check
  // in the host — and the socket's own 0600 is applied *after* `listen()` has already created it at
  // `0777 & ~umask`, so there is a brief window where only the directory is protecting it.
  chmodSync(p.runDir, 0o700);
  for (const dir of [p.logsDir, p.claudeDir, p.claudeAgentsDir, p.stateAgentsDir, p.worktreesDir, p.electronUserData]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * `HANGAR_HOME/worktrees/<projectName>/<agentSlug>` (spec §5.2). Here rather than inlined at the
 * three call sites in agent-service, because this file is the one that owns the §5.2 layout.
 * Containment is enforced separately, by `DirSegmentSchema` on `Project.name`.
 */
export function worktreePath(p: HangarPaths, projectName: string, slug: string): string {
  return join(p.worktreesDir, projectName, slug);
}
