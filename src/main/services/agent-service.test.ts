import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { addOrigin, commitFile, createRepo, git, testGitEnv } from '../../../test/fixtures/git-repo.ts';
import type { ClientMessage, RequestMessage } from '../../../shared/host-protocol.ts';
import { AGENT_WORKSPACES_MAX } from '../../../shared/constants.ts';
import type { IpcEvents, ProgressEvent } from '../../../shared/ipc-contract.ts';
import { defaultAppConfig, type AppConfig } from '../../../shared/types.ts';
import { exec } from '../util/exec.ts';
import { AgentError, createAgentService } from './agent-service.ts';
import { createGitService, type GitService } from './git.ts';
import type { HostClient, HostClientEvents } from './host-client.ts';
import { getPaths, ensureDirs } from './paths.ts';
import { createSessionRegistry } from './session-registry.ts';
import { StoreError } from './workspace-ops.ts';
import { createWorkspaceStore } from './workspace-store.ts';

/** `killExits: false` models a session that ignores SIGHUP — the case `stopAgent` must not paper over. */
function fakeHost(opts: { killExits?: boolean } = {}) {
  const handlers: { [K in keyof HostClientEvents]: HostClientEvents[K][] } = { data: [], title: [], bell: [], exit: [], snapshot: [], agentEvent: [], connected: [], disconnected: [], hostError: [] };
  const requests: ClientMessage[] = [];
  let connected = true;
  const client = {
    connect: async () => ({ version: 1, hostPid: 1, sessions: [] }),
    request: async (msg: RequestMessage) => {
      requests.push(msg);
      if (msg.t === 'spawn') return { t: 'spawned' as const, id: msg.id, pid: 4242 };
      if (msg.t === 'kill') {
        if (opts.killExits !== false) setTimeout(() => { for (const fn of handlers.exit) fn(msg.id, 0, 1); }, 10);
        return { t: 'ok' as const };
      }
      return { t: 'ok' as const };
    },
    send: () => {},
    on: <K extends keyof HostClientEvents>(k: K, fn: HostClientEvents[K]) => { handlers[k].push(fn); return () => {}; },
    isConnected: () => connected,
    close: () => {},
    // `satisfies`, not `as unknown as` — see session-registry.test.ts.
  } satisfies HostClient;
  return { client, requests, setConnected: (c: boolean) => (connected = c) };
}

function setup(opts: { freeBytes?: number; killExits?: boolean; stopTimeoutMs?: number; git?: (real: GitService) => GitService; config?: Partial<AppConfig> } = {}) {
  const home = tempDir('svc');
  const paths = getPaths(home);
  ensureDirs(paths);
  const store = createWorkspaceStore({ file: paths.workspaceFile, bakFile: paths.workspaceBak, debounceMs: 10 });
  store.load();
  const events: { k: string; p: unknown }[] = [];
  const emit = <K extends keyof IpcEvents>(k: K, p: IpcEvents[K]) => events.push({ k, p });
  const host = fakeHost({ killExits: opts.killExits });
  const registry = createSessionRegistry({ hostClient: host.client, store, emit, log: () => {} });
  const repoRoot = tempDir('approot');
  mkdirSync(join(repoRoot, 'bin'));
  const gitEnv = testGitEnv(home);
  const realGit = createGitService({ exec, env: gitEnv });
  const logs: string[] = [];
  const service = createAgentService({
    store, registry, paths, hostClient: host.client, exec, emit, repoRoot,
    git: opts.git ? opts.git(realGit) : realGit,
    env: gitEnv,
    stopTimeoutMs: opts.stopTimeoutMs,
    shellEnv: () => ({ path: '/usr/bin:/bin', nodeBin: process.execPath, claudeBin: null, claudeVersion: null, shell: '/bin/zsh', source: 'shell', reason: null }),
    config: () => ({ ...defaultAppConfig('/bin/zsh'), ...opts.config }),
    log: (l) => logs.push(l),
    freeBytes: () => opts.freeBytes ?? 50e9,
  });
  const progress = () => events.filter((e) => e.k === 'agent:progress').map((e) => e.p as ProgressEvent);
  return { home, paths, store, registry, service, host, events, progress, repoRoot, logs };
}

function repoWithEnv(): string {
  const repo = createRepo({ files: { 'README.md': 'r', 'src/index.ts': '' } });
  writeFileSync(join(repo, '.env'), 'SECRET=1');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  return repo;
}

describe('addProject', () => {
  it('validates the root, detects the default branch and dedupes names', async () => {
    const { service, store } = setup();
    const repo = createRepo();
    addOrigin(repo);
    await expect(service.addProject(join(repo, '..'))).rejects.toBeInstanceOf(AgentError);
    const p = await service.addProject(repo);
    expect(p.defaultBranch).toBe('main');
    expect(store.get().projects[0]!.id).toBe(p.id);
    await expect(service.addProject(repo)).rejects.toThrow(/already added/);
  });
});

describe('createAgent', () => {
  it('provisions a worktree per project with copied files and cloned dirs, then saves the agent', async () => {
    const { service, store, paths, progress } = setup();
    const a = await service.addProject(repoWithEnv());
    const b = await service.addProject(createRepo({ branch: 'main' }));
    const agent = await service.createAgent({ name: 'Fix Webhooks!', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: null }], permissionMode: 'acceptEdits', startNow: false });
    expect(agent.slug).toBe('fix-webhooks');
    expect(agent.workspaces.map((w) => w.branch)).toEqual(['agent/fix-webhooks', 'agent/fix-webhooks']);
    const wtA = agent.workspaces[0]!.worktreePath;
    expect(wtA).toBe(join(paths.worktreesDir, a.name, 'fix-webhooks'));
    expect(readFileSync(join(wtA, '.env'), 'utf8')).toBe('SECRET=1');
    expect(existsSync(join(wtA, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(wtA, 'src', 'index.ts'))).toBe(true);
    expect(store.get().agents[0]!.claude.permissionMode).toBe('acceptEdits');
    expect(progress().some((p) => p.step === 'saved' && p.status === 'done')).toBe(true);
    expect(agent.workspaces[0]!.baseRef).toBe('main');
  });

  it('suffixes the slug when the branch or directory is taken in any selected project', async () => {
    const { service } = setup();
    const a = await service.addProject(createRepo());
    const bRepo = createRepo();
    git(bRepo, 'branch', 'agent/fix');
    const b = await service.addProject(bRepo);
    const agent = await service.createAgent({ name: 'fix', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: null }], permissionMode: null, startNow: false });
    expect(agent.slug).toBe('fix-2');
    expect(agent.workspaces.every((w) => w.branch === 'agent/fix-2' && w.worktreePath.endsWith('/fix-2'))).toBe(true);
  });

  it('rolls back created worktrees when a later project fails, and saves nothing', async () => {
    const { service, store, progress } = setup();
    const a = await service.addProject(createRepo());
    const b = await service.addProject(createRepo());
    const err = await service
      .createAgent({ name: 'doomed', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: 'no-such-branch' }], permissionMode: null, startNow: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('BASE_NOT_FOUND');
    expect(store.get().agents).toEqual([]);
    const aRepo = store.get().projects[0]!.repoPath;
    expect(git(aRepo, 'branch', '--list', 'agent/doomed')).toBe('');
    expect(progress().some((p) => p.step === 'rollback' && p.status === 'done')).toBe(true);
  });

  // §6.2 requires agents[].slug unique per project, but pickSlug only ever consulted the filesystem
  // and git — so a worktree deleted out from under the app let a second agent take a slug that is
  // already spoken for, and the slug is what the CLI mirror and `hangar status` key on.
  it('does not reuse a slug another agent holds, even with no worktree left on disk', async () => {
    const { service, store, home } = setup();
    const project = await service.addProject(createRepo());
    const first = await service.createAgent({ name: 'Fix it', folderId: null, workspaces: [{ projectId: project.id, baseBranch: null }], permissionMode: null, startNow: false });
    expect(first.slug).toBe('fix-it');

    // Simulate the worktree and branch vanishing behind the app's back.
    rmSync(join(home, 'worktrees', project.name, 'fix-it'), { recursive: true, force: true });
    git(project.repoPath, 'worktree', 'prune');
    git(project.repoPath, 'branch', '-D', 'agent/fix-it');

    const second = await service.createAgent({ name: 'Fix it', folderId: null, workspaces: [{ projectId: project.id, baseBranch: null }], permissionMode: null, startNow: false });
    expect(second.slug).not.toBe('fix-it');
    expect(new Set(store.get().agents.map((a) => a.slug)).size).toBe(2);
  });


  // The doc comment on `provisionWorkspace` once claimed this was unreachable. It is not:
  // `copyPatterns` hard-throws when the worktree ROOT is absent, so a worktree that disappears
  // between `worktree add` and the copy lands there. Removing it is what `register` defends.
  it('rolls back a worktree whose setup throws after the worktree was created', async () => {
    const { service, store, progress } = setup({
      git: (real) => ({
        ...real,
        worktreeAdd: async (repo, o) => {
          await real.worktreeAdd(repo, o);
          rmSync(o.path, { recursive: true, force: true }); // an external `worktree remove`, a volume vanishing
        },
      }),
    });
    const p = await service.addProject(repoWithEnv());
    const err = await service
      .createAgent({ name: 'boom', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain('worktree path does not exist');
    expect(store.get().agents).toEqual([]);
    expect(progress().some((x) => x.step === 'rollback' && x.status === 'done')).toBe(true);
    expect(git(p.repoPath, 'branch', '--list', 'agent/boom')).toBe('');
  });

  it('reports what rollback could not clean instead of claiming it removed everything', async () => {
    const { service, progress } = setup({
      git: (real) => ({ ...real, worktreeRemove: async () => { throw new Error('device is busy'); } }),
    });
    const a = await service.addProject(createRepo());
    const b = await service.addProject(createRepo());
    await expect(
      service.createAgent({ name: 'rbf', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: 'no-such-branch' }], permissionMode: null, startNow: false }),
    ).rejects.toMatchObject({ code: 'BASE_NOT_FOUND' });
    const rollback = progress().filter((x) => x.step === 'rollback');
    expect(rollback.at(-1)!.status).toBe('warn');
    expect(rollback.at(-1)!.message).toContain('removed 0 of 1');
    expect(rollback.at(-1)!.message).toContain('device is busy');
    // The orphan the message now names: still on disk, and the reason the next create of this name
    // would otherwise die on PATH_EXISTS with nothing on screen explaining why.
    expect(git(a.repoPath, 'branch', '--list', 'agent/rbf')).toContain('agent/rbf');
  });

  it('refuses to provision over a directory that appeared after the slug was chosen', async () => {
    // `slugIsFree` already rejects a slug whose directory exists, so the only way to reach the
    // PATH_EXISTS guard is the race it was written for: the directory appears between the slug
    // decision and `worktree add`. `refExists` runs inside that window (baseRefFor).
    let racePath = '';
    const { service, paths } = setup({
      git: (real) => ({
        ...real,
        refExists: async (repo, ref) => {
          if (racePath) mkdirSync(racePath, { recursive: true });
          return real.refExists(repo, ref);
        },
      }),
    });
    const p = await service.addProject(createRepo());
    racePath = join(paths.worktreesDir, p.name, 'race');
    await expect(
      service.createAgent({ name: 'race', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false }),
    ).rejects.toMatchObject({ code: 'PATH_EXISTS' });
  });

  it('suffixes the slug when only the worktree directory is taken', async () => {
    const { service, paths } = setup();
    const p = await service.addProject(createRepo());
    mkdirSync(join(paths.worktreesDir, p.name, 'taken'), { recursive: true });
    const agent = await service.createAgent({ name: 'taken', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    expect(agent.slug).toBe('taken-2');
  });

  it('refuses when disk space is low', async () => {
    const { service } = setup({ freeBytes: 1e9 });
    const a = await service.addProject(createRepo());
    await expect(service.createAgent({ name: 'x', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }], permissionMode: null, startNow: false })).rejects.toMatchObject({ code: 'LOW_DISK' });
  });
});

describe('start / stop', () => {
  async function agentReady() {
    const s = setup();
    const p = await s.service.addProject(createRepo());
    const agent = await s.service.createAgent({ name: 'run', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    return { ...s, agent };
  }

  it('spawns a login shell in the worktree with the agent env and a claude startup command', async () => {
    const { service, host, agent, store, registry, repoRoot, paths } = await agentReady();
    await service.startAgent(agent.id, 'auto');
    const spawn = host.requests.find((r) => r.t === 'spawn');
    expect(spawn && spawn.t === 'spawn' ? spawn : null).toMatchObject({ id: agent.id, cwd: agent.workspaces[0]!.worktreePath, file: '/bin/zsh', args: ['-il'] });
    const env = (spawn as Extract<ClientMessage, { t: 'spawn' }>).env;
    expect(env.HANGAR_AGENT_ID).toBe(agent.id);
    expect(env.HANGAR_SOCKET).toBe(paths.socketPath);
    expect(env.PATH.startsWith(`${repoRoot}/bin:`)).toBe(true);
    expect(env.TERM).toBe('xterm-256color');
    const cmd = (spawn as Extract<ClientMessage, { t: 'spawn' }>).startupCommand ?? '';
    // Bare `claude`, not `'claude'`: quoting a command word suppresses alias expansion in zsh and
    // bash, so a user with `alias claude='npx …'` would get command-not-found. See the docstring on
    // composeStartupCommand in Task 11 — do not "fix" this by adding quotes.
    expect(cmd).toContain("claude '--name' 'run' '--session-id'");
    expect(cmd).toContain("'--settings'");
    expect(registry.get(agent.id)).toMatchObject({ activity: 'starting', pid: 4242 });
    expect(store.get().agents[0]!.claude.hasStartedOnce).toBe(true);
    await expect(service.startAgent(agent.id, 'auto')).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
  });

  it('launches with config.claudeDefaultArgs ahead of the project args', async () => {
    const s = setup({ config: { claudeDefaultArgs: ['--effort', 'xhigh'] } });
    const p = await s.service.addProject(createRepo());
    s.store.update((w) => ({ ...w, projects: w.projects.map((x) => (x.id === p.id ? { ...x, claudeArgs: ['--model', 'opus'] } : x)) }));
    const agent = await s.service.createAgent({ name: 'defaults', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    await s.service.startAgent(agent.id, 'auto');
    const cmd = (s.host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand ?? '';
    expect(cmd).toContain("'--effort' 'xhigh' '--model' 'opus'");
  });

  it('resume after exit uses --resume; fresh rotates the session id; shell-only has no startup command', async () => {
    const { service, host, agent, store, registry } = await agentReady();
    await service.startAgent(agent.id, 'auto');
    const firstId = store.get().agents[0]!.claude.sessionId;
    registry.apply(agent.id, { kind: 'exit', exitCode: 0, at: Date.now() });
    await service.startAgent(agent.id, 'auto');
    expect((host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand).toContain(`'--resume' '${firstId}'`);
    registry.apply(agent.id, { kind: 'exit', exitCode: 0, at: Date.now() });
    await service.startAgent(agent.id, 'fresh');
    const secondId = store.get().agents[0]!.claude.sessionId;
    expect(secondId).not.toBe(firstId);
    expect((host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand).toContain(`'--session-id' '${secondId}'`);
    registry.apply(agent.id, { kind: 'exit', exitCode: 0, at: Date.now() });
    await service.startAgent(agent.id, 'shell-only');
    expect((host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand).toBeUndefined();
  });

  it('shell-only leaves hasStartedOnce alone, so the next auto start does not --resume a session claude never made', async () => {
    const { service, host, agent, store, registry } = await agentReady();
    await service.startAgent(agent.id, 'shell-only');
    expect(store.get().agents[0]!.claude.hasStartedOnce).toBe(false);
    registry.apply(agent.id, { kind: 'exit', exitCode: 0, at: Date.now() });
    await service.startAgent(agent.id, 'auto');
    const cmd = (host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand ?? '';
    expect(cmd).toContain("'--session-id'");
    expect(cmd).not.toContain("'--resume'");
  });

  // Spec §11.1 makes `'resume'` unconditional, so on a never-started agent it asks claude to resume
  // a session that does not exist. Pinned deliberately: the guard that would soften it would make
  // `'resume'` indistinguishable from `'auto'` in every reachable case.
  it('resume is unconditional, even on an agent that has never started', async () => {
    const { service, host, agent, store } = await agentReady();
    expect(store.get().agents[0]!.claude.hasStartedOnce).toBe(false);
    await service.startAgent(agent.id, 'resume');
    expect((host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand).toContain(`'--resume' '${agent.claude.sessionId}'`);
  });

  it('stop throws STOP_TIMEOUT when the host never confirms the session is down', async () => {
    const s = setup({ killExits: false, stopTimeoutMs: 60 });
    const p = await s.service.addProject(createRepo());
    const agent = await s.service.createAgent({ name: 'zombie', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    await s.service.startAgent(agent.id, 'auto');
    // G38: deletion runs `git worktree remove` on the guarantee that the tree is down. Returning
    // normally here handed the caller a guarantee it had not got.
    await expect(s.service.stopAgent(agent.id)).rejects.toMatchObject({ code: 'STOP_TIMEOUT' });
    expect(s.registry.get(agent.id).activity).not.toBe('exited');
  });

  it('stop kills the session and waits for exit; refuses when the host is down', async () => {
    const { service, host, agent, registry } = await agentReady();
    await service.startAgent(agent.id, 'auto');
    await service.stopAgent(agent.id);
    expect(registry.get(agent.id).activity).toBe('exited');
    host.setConnected(false);
    await expect(service.startAgent(agent.id, 'auto')).rejects.toMatchObject({ code: 'HOST_DOWN' });
  });
});

describe('inspectDelete / deleteAgent / reconcile', () => {
  it('reports dirty and unmerged work, refuses non-forced removal, then force-deletes everything', async () => {
    const { service, store, host } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'del', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const wt = agent.workspaces[0]!.worktreePath;
    // Order matters: `commitFile` runs `git add -A`, so writing the dirty file first would commit it
    // and leave the tree clean. Same trap as G50 — the dirty precondition has to come last.
    commitFile(wt, 'feature.txt', 'f');
    writeFileSync(join(wt, 'dirty.txt'), 'x');
    const inspection = await service.inspectDelete(agent.id);
    expect(inspection.workspaces[0]).toMatchObject({ branch: 'agent/del', dirtyFiles: 1, unmergedCommits: 1, worktreeMissing: false, inspectionFailed: false });

    await expect(service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: false })).rejects.toMatchObject({ code: 'DELETE_INCOMPLETE' });
    expect(store.get().agents.length).toBe(1);
    expect(existsSync(wt)).toBe(true);

    await service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: true });
    expect(store.get().agents).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    expect(git(p.repoPath, 'branch', '--list', 'agent/del')).toBe('');
    expect(host.requests.some((r) => r.t === 'dispose')).toBe(true);
  });

  it('counts unmerged commits by branch, so the force gate still arms once the worktree is gone', async () => {
    const { service } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'risk', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const wt = agent.workspaces[0]!.worktreePath;
    commitFile(wt, 'feature.txt', 'f');
    rmSync(wt, { recursive: true, force: true });
    const inspection = await service.inspectDelete(agent.id);
    // The commit is still on the branch, so it is still at risk. Counting from the missing directory
    // reported 0 here — disarming the typed-name gate exactly when it should arm.
    expect(inspection.workspaces[0]).toMatchObject({ unmergedCommits: 1, dirtyFiles: 0, worktreeMissing: true, inspectionFailed: false });
  });

  // The counts feed the renderer's typed-name force gate, which is the ONLY gate on this operation:
  // a 0 it could not actually establish reads as "nothing to lose" and offers a clean delete over
  // real files. Both counts used to `.catch(() => 0)` in silence.
  it('flags a workspace it could not inspect rather than reporting it clean', async () => {
    const { service, logs } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'broken', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const wt = agent.workspaces[0]!.worktreePath;
    writeFileSync(join(wt, 'secret.txt'), 'do not lose me');
    // A worktree's `.git` is a file pointing at the real gitdir. Break it and the directory still
    // EXISTS — so `worktreeMissing` is false — while `git status` answers "not a git repository".
    writeFileSync(join(wt, '.git'), 'gitdir: /nowhere/at/all\n');
    const inspection = await service.inspectDelete(agent.id);
    expect(inspection.workspaces[0]).toMatchObject({ dirtyFiles: 0, worktreeMissing: false, inspectionFailed: true });
    expect(logs.join('\n')).toContain('inspectDelete: dirtyCount failed');
    expect(existsSync(join(wt, 'secret.txt'))).toBe(true); // the files the dialog would have called safe
  });

  it('flags a workspace whose project is gone, instead of fabricating two zeroes', async () => {
    const { service, store } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'orphan', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    // `removeProject` refuses this with PROJECT_IN_USE, so reach past it — the point is that the
    // inspection stays honest if that invariant is ever broken, which is why `deleteAgent` also
    // refuses to touch such a workspace.
    store.update((ws) => ({ ...ws, projects: [] }));
    const inspection = await service.inspectDelete(agent.id);
    expect(inspection.workspaces[0]).toMatchObject({ dirtyFiles: 0, unmergedCommits: 0, inspectionFailed: true });
  });

  it('deletes an agent whose branch was removed behind the app back', async () => {
    const { service, store } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'ext', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const wt = agent.workspaces[0]!.worktreePath;
    git(wt, 'checkout', '-q', '--detach');
    git(p.repoPath, 'branch', '-D', 'agent/ext');
    // A branch already gone is the goal state. Treating it as fatal left the agent undeletable, and
    // force did not help — force only picks `-D` over `-d`.
    await service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: false });
    expect(store.get().agents).toEqual([]);
    expect(existsSync(wt)).toBe(false);
  });

  it('deletes when the worktree directory vanished but its registration did not', async () => {
    const { service, store } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'ghost', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    rmSync(agent.workspaces[0]!.worktreePath, { recursive: true, force: true });
    // Verified on git 2.50.1: `branch -D` refuses with "used by worktree at …" until the stale
    // registration is pruned. With the prune sequenced AFTER the branch delete in the same try, the
    // one command that fixes this state never ran and no retry could ever succeed.
    await service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: true });
    expect(store.get().agents).toEqual([]);
    expect(git(p.repoPath, 'branch', '--list', 'agent/ghost')).toBe('');
  });

  it('drops each cleaned workspace as it goes, so a retry resumes instead of restarting', async () => {
    let removals = 0;
    const { service, store } = setup({
      git: (real) => ({
        ...real,
        worktreeRemove: async (repo, path, force) => {
          removals += 1;
          if (removals === 2) throw new Error('simulated failure on the second workspace');
          return real.worktreeRemove(repo, path, force);
        },
      }),
    });
    const a = await service.addProject(createRepo());
    const b = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'two', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: null }], permissionMode: null, startNow: false });
    const [wsA, wsB] = [agent.workspaces[0]!, agent.workspaces[1]!];

    await expect(service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: true })).rejects.toMatchObject({ code: 'DELETE_INCOMPLETE' });
    expect(existsSync(wsA.worktreePath)).toBe(false);
    expect(existsSync(wsB.worktreePath)).toBe(true);
    expect(git(a.repoPath, 'branch', '--list', 'agent/two')).toBe('');
    // The record must not keep claiming a worktree and branch that were already destroyed: the retry
    // used to die on that phantom and never reach the workspace that actually still existed.
    expect(store.get().agents[0]!.workspaces.map((w) => w.id)).toEqual([wsB.id]);

    await service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: true });
    expect(store.get().agents).toEqual([]);
    expect(existsSync(wsB.worktreePath)).toBe(false);
    expect(git(b.repoPath, 'branch', '--list', 'agent/two')).toBe('');
  });

  it('honours removeWorktrees:false and deleteBranches:false', async () => {
    const { service, store } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'keep', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const wt = agent.workspaces[0]!.worktreePath;
    // §6/spec defaults "Delete branches" OFF, so this is the DEFAULT path — a version that deleted
    // the branch regardless passed the whole suite before this test existed.
    await service.deleteAgent(agent.id, { removeWorktrees: false, deleteBranches: false, force: false });
    expect(store.get().agents).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(git(p.repoPath, 'branch', '--list', 'agent/keep')).toContain('agent/keep');
  });

  it('stops a running session before it touches the worktree, and refuses to delete one that will not die', async () => {
    const alive = setup({ killExits: false, stopTimeoutMs: 60 });
    const pa = await alive.service.addProject(createRepo());
    const stuck = await alive.service.createAgent({ name: 'stuck', folderId: null, workspaces: [{ projectId: pa.id, baseBranch: null }], permissionMode: null, startNow: false });
    await alive.service.startAgent(stuck.id, 'auto');
    await expect(alive.service.deleteAgent(stuck.id, { removeWorktrees: true, deleteBranches: true, force: true })).rejects.toMatchObject({ code: 'STOP_TIMEOUT' });
    expect(existsSync(stuck.workspaces[0]!.worktreePath)).toBe(true);
    expect(alive.store.get().agents.length).toBe(1);

    const ok = setup();
    const pb = await ok.service.addProject(createRepo());
    const agent = await ok.service.createAgent({ name: 'bye', folderId: null, workspaces: [{ projectId: pb.id, baseBranch: null }], permissionMode: null, startNow: false });
    await ok.service.startAgent(agent.id, 'auto');
    await ok.service.deleteAgent(agent.id, { removeWorktrees: true, deleteBranches: true, force: true });
    expect(ok.host.requests.some((r) => r.t === 'kill')).toBe(true);
    expect(ok.host.requests.some((r) => r.t === 'dispose')).toBe(true);
  });

  it('reconcile prunes stale registrations', async () => {
    const { service } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'stale', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    rmSync(agent.workspaces[0]!.worktreePath, { recursive: true, force: true });
    expect(git(p.repoPath, 'worktree', 'list')).toContain('stale');
    await service.reconcile();
    expect(git(p.repoPath, 'worktree', 'list')).not.toContain('stale');
  });

  it('reconcile flags missing worktrees', async () => {
    const { service } = setup();
    const p = await service.addProject(createRepo());
    const agent = await service.createAgent({ name: 'gone', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    git(p.repoPath, 'worktree', 'remove', '--force', agent.workspaces[0]!.worktreePath);
    const runtime = await service.reconcile();
    expect(runtime[agent.workspaces[0]!.id]).toEqual({ workspaceId: agent.workspaces[0]!.id, worktreeMissing: true });
    await expect(service.startAgent(agent.id, 'auto')).rejects.toMatchObject({ code: 'WORKTREE_MISSING' });
  });

  // The caller must be able to call this per snapshot: `index.ts` captured `reconcile()`'s map once
  // at boot, so an agent created afterwards had NO runtime entry, and a worktree that vanished later
  // never raised the warning `WorkspaceRuntime.worktreeMissing` exists for — it read as present.
  it('computeRuntime sees agents and worktree changes that happen after reconcile', async () => {
    const { service } = setup();
    const p = await service.addProject(createRepo());
    await service.reconcile();
    const agent = await service.createAgent({ name: 'later', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    const w = agent.workspaces[0]!;
    expect(service.computeRuntime()[w.id]).toEqual({ workspaceId: w.id, worktreeMissing: false });
    rmSync(w.worktreePath, { recursive: true, force: true });
    expect(service.computeRuntime()[w.id]).toEqual({ workspaceId: w.id, worktreeMissing: true });
  });
});

describe('addWorkspace', () => {
  async function oneProjectAgent() {
    const s = setup();
    const a = await s.service.addProject(createRepo());
    const b = await s.service.addProject(createRepo());
    const agent = await s.service.createAgent({ name: 'multi', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }], permissionMode: null, startNow: false });
    return { ...s, a, b, agent };
  }

  // Regression: `slugIsFree` checks the workspace, and `addWorkspace` re-uses the agent's OWN slug,
  // so without `ignoreAgentId` the agent collided with itself and every added workspace silently
  // took a `-2` — diverging from the slug the CLI mirror and `hangar status` key on.
  it('reuses the agent own slug rather than colliding with itself', async () => {
    const { service, store, agent, b } = await oneProjectAgent();
    const w = await service.addWorkspace(agent.id, b.id, null);
    expect(w.branch).toBe('agent/multi');
    expect(w.worktreePath.endsWith('/multi')).toBe(true);
    expect(store.get().agents[0]!.workspaces.map((x) => x.id)).toEqual([agent.workspaces[0]!.id, w.id]);
  });

  it('refuses a duplicate project and leaves the agent untouched when provisioning fails', async () => {
    const { service, store, agent, a, b } = await oneProjectAgent();
    await expect(service.addWorkspace(agent.id, a.id, null)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(service.addWorkspace(agent.id, b.id, 'no-such-branch')).rejects.toMatchObject({ code: 'BASE_NOT_FOUND' });
    expect(store.get().agents[0]!.workspaces).toHaveLength(1);
    expect(git(b.repoPath, 'branch', '--list', 'agent/multi')).toBe('');
  });

  /**
   * `agent:create` has always capped `workspaces` at AGENT_WORKSPACES_MAX; this path had no cap at
   * all, so an agent created at the maximum could be grown past it one project at a time — and the
   * result would then fail `AgentSchema` on the next load, costing the user the whole file.
   *
   * The eight existing workspaces are written straight into the store rather than provisioned:
   * seven more real repos and worktrees would buy nothing this assertion needs, and the refusal is
   * a length check on the agent record.
   */
  it('refuses to grow an agent past AGENT_WORKSPACES_MAX, before provisioning anything', async () => {
    const { service, store, agent, b } = await oneProjectAgent();
    const pad = Array.from({ length: AGENT_WORKSPACES_MAX - 1 }, (_, i) => ({
      id: `pad-${i}`, projectId: `proj-${i}`, branch: `agent/pad-${i}`,
      worktreePath: `/nowhere/pad-${i}`, baseRef: 'origin/main', createdAt: 'x',
    }));
    store.update((w) => ({ ...w, agents: w.agents.map((x) => (x.id === agent.id ? { ...x, workspaces: [...x.workspaces, ...pad] } : x)) }));
    expect(store.get().agents[0]!.workspaces).toHaveLength(AGENT_WORKSPACES_MAX);
    await expect(service.addWorkspace(agent.id, b.id, null)).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' });
    expect(store.get().agents[0]!.workspaces).toHaveLength(AGENT_WORKSPACES_MAX);
    // Nothing was provisioned on the way to the refusal: no branch in the target repo.
    expect(git(b.repoPath, 'branch', '--list', 'agent/multi')).toBe('');
  });
});

describe('inspectRemoveWorkspace / removeWorkspace (spec 2026-09-15 §11)', () => {
  const DEFAULTS = { removeWorktrees: true, deleteBranches: false, force: false };

  async function twoProjectAgent(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    const a = await s.service.addProject(createRepo());
    const b = await s.service.addProject(createRepo());
    const agent = await s.service.createAgent({ name: 'pair', folderId: null, workspaces: [{ projectId: a.id, baseBranch: null }, { projectId: b.id, baseBranch: null }], permissionMode: null, startNow: false });
    return { ...s, a, b, agent, primary: agent.workspaces[0]!, second: agent.workspaces[1]! };
  }
  const ids = (s: Awaited<ReturnType<typeof twoProjectAgent>>): string[] => s.store.get().agents[0]!.workspaces.map((w) => w.id);

  it('inspects exactly the one workspace asked about', async () => {
    const { service, agent, second } = await twoProjectAgent();
    // `commitFile` runs `git add -A`, so the dirty file has to come after it (G50's trap).
    commitFile(second.worktreePath, 'feature.txt', 'f');
    writeFileSync(join(second.worktreePath, 'dirty.txt'), 'x');
    const inspection = await service.inspectRemoveWorkspace(agent.id, second.id);
    expect(inspection.workspaces).toHaveLength(1);
    expect(inspection.workspaces[0]).toMatchObject({ workspaceId: second.id, branch: 'agent/pair', dirtyFiles: 1, unmergedCommits: 1, worktreeMissing: false, inspectionFailed: false });
    await expect(service.inspectRemoveWorkspace(agent.id, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the primary workspace and unknown ids, and touches nothing', async () => {
    const s = await twoProjectAgent();
    await expect(s.service.removeWorkspace(s.agent.id, s.primary.id, DEFAULTS)).rejects.toMatchObject({ code: 'PRIMARY_WORKSPACE' });
    await expect(s.service.removeWorkspace('ghost', s.second.id, DEFAULTS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.service.removeWorkspace(s.agent.id, 'ghost', DEFAULTS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ids(s)).toEqual([s.primary.id, s.second.id]);
    expect(existsSync(s.primary.worktreePath)).toBe(true);
    expect(existsSync(s.second.worktreePath)).toBe(true);
  });

  it('removes the worktree and drops the record, keeping the branch by default', async () => {
    const s = await twoProjectAgent();
    await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS);
    expect(ids(s)).toEqual([s.primary.id]);
    expect(existsSync(s.second.worktreePath)).toBe(false);
    expect(existsSync(s.primary.worktreePath)).toBe(true);
    expect(git(s.b.repoPath, 'branch', '--list', 'agent/pair')).toContain('agent/pair');
  });

  it('deletes the branch when asked', async () => {
    const s = await twoProjectAgent();
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, deleteBranches: true });
    expect(git(s.b.repoPath, 'branch', '--list', 'agent/pair')).toBe('');
    // The primary's branch lives in the OTHER repo and is untouched.
    expect(git(s.a.repoPath, 'branch', '--list', 'agent/pair')).toContain('agent/pair');
  });

  it('leaves the directory when removeWorktrees is off, and still drops the record', async () => {
    const s = await twoProjectAgent();
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, removeWorktrees: false });
    expect(ids(s)).toEqual([s.primary.id]);
    expect(existsSync(s.second.worktreePath)).toBe(true);
  });

  it('refuses a dirty worktree without force and keeps the record; force removes it', async () => {
    const s = await twoProjectAgent();
    writeFileSync(join(s.second.worktreePath, 'dirty.txt'), 'x');
    const err = await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOVE_INCOMPLETE' });
    expect((err as AgentError).message).toContain(`${s.b.name} (agent/pair): `);
    expect(ids(s)).toEqual([s.primary.id, s.second.id]);
    expect(existsSync(s.second.worktreePath)).toBe(true);
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, force: true });
    expect(ids(s)).toEqual([s.primary.id]);
    expect(existsSync(s.second.worktreePath)).toBe(false);
  });

  // Spec §11.2 step 2. Unlike `deleteAgent`, which refuses such a workspace: removing the record is
  // the whole request here, and there is no repo left to run git against.
  it('drops the record without touching git when the project is gone', async () => {
    const s = await twoProjectAgent();
    s.store.update((ws) => ({ ...ws, projects: ws.projects.filter((p) => p.id !== s.b.id) }));
    await s.service.removeWorkspace(s.agent.id, s.second.id, { removeWorktrees: true, deleteBranches: true, force: true });
    expect(ids(s)).toEqual([s.primary.id]);
    expect(existsSync(s.second.worktreePath)).toBe(true);
    // Not a silent orphan: what was left on disk is named in the log.
    expect(s.logs.some((l) => l.includes(s.second.worktreePath) && l.includes('left on disk'))).toBe(true);
  });

  // Measured with real git: `branch -D` refuses a branch checked out in a worktree that is being
  // kept, so this combination always failed — AFTER the record was dropped, leaving a registered
  // worktree nothing referenced and a retry that answered NOT_FOUND.
  it('refuses to delete the branch of a worktree it is keeping, before touching anything', async () => {
    const s = await twoProjectAgent();
    await expect(s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, removeWorktrees: false, deleteBranches: true })).rejects.toMatchObject({ code: 'INVALID' });
    expect(ids(s)).toEqual([s.primary.id, s.second.id]);
    expect(existsSync(s.second.worktreePath)).toBe(true);
    expect(git(s.b.repoPath, 'branch', '--list', 'agent/pair')).toContain('agent/pair');
    // And the record that survived is still removable the valid way.
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, deleteBranches: true });
    expect(ids(s)).toEqual([s.primary.id]);
    expect(git(s.b.repoPath, 'branch', '--list', 'agent/pair')).toBe('');
  });

  it('still drops the record when removeWorktrees is off and a later step failed', async () => {
    const s = await twoProjectAgent({ git: (real) => ({ ...real, branchDelete: async () => { throw new Error('simulated branch failure'); } }) });
    // The directory has to be gone already: with it on disk, this combination is refused as INVALID.
    rmSync(s.second.worktreePath, { recursive: true, force: true });
    const err = await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, removeWorktrees: false, deleteBranches: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOVE_INCOMPLETE' });
    expect((err as AgentError).message).toContain('simulated branch failure');
    expect(ids(s)).toEqual([s.primary.id]);
  });

  // The registration of a directory deleted behind the app's back makes `branch -D` refuse with "used
  // by worktree at …" unless the prune runs first.
  it('cleans up a directory that is already gone: drops the record and deletes the branch after the prune', async () => {
    const s = await twoProjectAgent();
    rmSync(s.second.worktreePath, { recursive: true, force: true });
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, deleteBranches: true });
    expect(ids(s)).toEqual([s.primary.id]);
    expect(git(s.b.repoPath, 'branch', '--list', 'agent/pair')).toBe('');
  });

  // Any store write while prune and branch delete are awaited broadcasts the runtime map; with the
  // record still there, that says `worktreeMissing: true` and `Pane.tsx` unmounts the live terminal.
  it('drops the record as soon as the worktree is gone, before the prune and branch steps', async () => {
    let probe: ((step: string) => void) | null = null;
    const s = await twoProjectAgent({
      git: (real) => ({
        ...real,
        worktreePrune: async (repo) => { probe?.('prune'); return real.worktreePrune(repo); },
        branchDelete: async (repo, name, force) => { probe?.('branchDelete'); return real.branchDelete(repo, name, force); },
      }),
    });
    const seen: { step: string; ids: string[]; missing: boolean }[] = [];
    probe = (step) => seen.push({ step, ids: ids(s), missing: Object.values(s.service.computeRuntime()).some((r) => r.worktreeMissing) });
    await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, deleteBranches: true });
    expect(seen).toEqual([
      { step: 'prune', ids: [s.primary.id], missing: false },
      { step: 'branchDelete', ids: [s.primary.id], missing: false },
    ]);
  });

  it('keeps the git failure message when the agent is deleted mid-teardown', async () => {
    let afterRemove: (() => void) | null = null;
    const s = await twoProjectAgent({
      git: (real) => ({ ...real, worktreeRemove: async (repo, path, force) => { await real.worktreeRemove(repo, path, force); afterRemove?.(); throw new Error('simulated late failure'); } }),
    });
    afterRemove = () => s.store.update((ws) => ({ ...ws, agents: ws.agents.filter((a) => a.id !== s.agent.id) }));
    const err = await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOVE_INCOMPLETE' });
    expect((err as AgentError).message).toContain('simulated late failure');
    expect(s.logs.some((l) => l.includes(`could not drop workspace ${s.second.id}`))).toBe(true);
  });

  // The swallow above is only for an agent that is GONE. A record write that fails while the agent
  // still exists leaves the record in place, so reporting success would be a lie.
  it.each([
    ['while the worktree is being removed', DEFAULTS],
    ['at the final record drop', { ...DEFAULTS, removeWorktrees: false }],
  ])('surfaces a failed record drop %s, keeping the store error code', async (_label, options) => {
    const s = await twoProjectAgent();
    const realUpdate = s.store.update.bind(s.store);
    let armed = true;
    s.store.update = (mutate) => {
      if (armed) throw new StoreError('SIMULATED_WRITE', 'simulated store failure');
      return realUpdate(mutate);
    };
    const err = await s.service.removeWorkspace(s.agent.id, s.second.id, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'SIMULATED_WRITE' });
    expect((err as AgentError).message).toContain('simulated store failure');
    expect(ids(s)).toEqual([s.primary.id, s.second.id]);
    expect(s.logs.some((l) => l.startsWith('removed workspace'))).toBe(false);
    // The record it reported as kept is still removable once the store works again.
    armed = false;
    await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS);
    expect(ids(s)).toEqual([s.primary.id]);
  });

  /** A `worktreeAdd` that parks on its next call, so another operation can run while `addWorkspace` is mid-provision. */
  function holdableGit() {
    let hold: { reached: () => void; released: Promise<void> } | null = null;
    const git = (real: GitService): GitService => ({
      ...real,
      worktreeAdd: async (repo, opts) => {
        const h = hold;
        hold = null;
        if (h) { h.reached(); await h.released; }
        return real.worktreeAdd(repo, opts);
      },
    });
    const holdNext = () => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const reached = new Promise<void>((r) => (hold = { reached: r, released }));
      return { reached, release };
    };
    return { git, holdNext };
  }

  // Measured before the fix: `addWorkspace` wrote back the list it read before provisioning, so the
  // removed record came back — `[primary, SECOND, new]`, with SECOND `worktreeMissing: true`.
  it('a concurrent addWorkspace does not resurrect the removed record', async () => {
    const h = holdableGit();
    const s = await twoProjectAgent({ git: h.git });
    const c = await s.service.addProject(createRepo());
    const gate = h.holdNext();
    const adding = s.service.addWorkspace(s.agent.id, c.id, null);
    await gate.reached;
    await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS);
    gate.release();
    const added = await adding;
    expect(ids(s)).toEqual([s.primary.id, added.id]);
    expect(Object.values(s.service.computeRuntime()).some((r) => r.worktreeMissing)).toBe(false);
  });

  it('an addWorkspace whose agent is deleted mid-provision rolls back and says so', async () => {
    const h = holdableGit();
    const s = await twoProjectAgent({ git: h.git });
    const c = await s.service.addProject(createRepo());
    const gate = h.holdNext();
    const adding = s.service.addWorkspace(s.agent.id, c.id, null);
    await gate.reached;
    s.store.update((ws) => ({ ...ws, agents: ws.agents.filter((a) => a.id !== s.agent.id) }));
    gate.release();
    await expect(adding).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(existsSync(join(s.paths.worktreesDir, c.name, 'pair'))).toBe(false);
    expect(git(c.repoPath, 'branch', '--list', 'agent/pair')).toBe('');
  });

  // The rule that keeps a live terminal on screen: a record for a directory that is gone would mark
  // the agent `worktreeMissing`, and `Pane.tsx` swaps the terminal for the exit card over that.
  it('still drops the record when only the branch delete failed', async () => {
    const s = await twoProjectAgent({ git: (real) => ({ ...real, branchDelete: async () => { throw new Error('simulated branch failure'); } }) });
    const err = await s.service.removeWorkspace(s.agent.id, s.second.id, { ...DEFAULTS, deleteBranches: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOVE_INCOMPLETE' });
    expect((err as AgentError).message).toContain('simulated branch failure');
    expect(existsSync(s.second.worktreePath)).toBe(false);
    expect(ids(s)).toEqual([s.primary.id]);
  });

  it('keeps the record when the worktree removal itself failed', async () => {
    const s = await twoProjectAgent({ git: (real) => ({ ...real, worktreeRemove: async () => { throw new Error('device is busy'); } }) });
    await expect(s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS)).rejects.toMatchObject({ code: 'REMOVE_INCOMPLETE' });
    expect(ids(s)).toEqual([s.primary.id, s.second.id]);
    expect(existsSync(s.second.worktreePath)).toBe(true);
  });

  it('does not stop a running session', async () => {
    const s = await twoProjectAgent();
    await s.service.startAgent(s.agent.id, 'auto');
    await s.service.removeWorkspace(s.agent.id, s.second.id, DEFAULTS);
    expect(s.host.requests.some((r) => r.t === 'kill' || r.t === 'dispose')).toBe(false);
    expect(s.registry.get(s.agent.id).activity).toBe('starting');
  });
});

describe('per-agent Claude settings (§11.9)', () => {
  async function started(share: boolean) {
    const s = setup();
    const p = await s.service.addProject(createRepo());
    if (share) s.store.update((w) => ({ ...w, projects: w.projects.map((x) => (x.id === p.id ? { ...x, shareClaudeMemory: true } : x)) }));
    const agent = await s.service.createAgent({ name: 'mem', folderId: null, workspaces: [{ projectId: p.id, baseBranch: null }], permissionMode: null, startNow: false });
    return { ...s, agent, project: p };
  }
  const startupOf = (host: ReturnType<typeof fakeHost>): string =>
    (host.requests.at(-1) as Extract<ClientMessage, { t: 'spawn' }>).startupCommand ?? '';

  it('points --settings at this agent own generated file and writes the hooks into it', async () => {
    const { service, host, agent, paths } = await started(false);
    await service.startAgent(agent.id, 'auto');
    const file = join(paths.claudeAgentsDir, `${agent.id}.json`);
    expect(startupOf(host)).toContain(`'--settings' '${file}'`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(json.hooks)).toHaveLength(6);
    expect(json.autoMemoryDirectory).toBeUndefined();
  });

  it('adds autoMemoryDirectory when the primary project opts in', async () => {
    const { service, agent, paths, project } = await started(true);
    await service.startAgent(agent.id, 'auto');
    const json = JSON.parse(readFileSync(join(paths.claudeAgentsDir, `${agent.id}.json`), 'utf8'));
    expect(json.autoMemoryDirectory).toBe(join(homedir(), '.claude', 'projects', project.repoPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'));
  });

  it('writes no settings file for a shell-only start, which composes no command to read one', async () => {
    const { service, agent, paths } = await started(true);
    await service.startAgent(agent.id, 'shell-only');
    expect(existsSync(join(paths.claudeAgentsDir, `${agent.id}.json`))).toBe(false);
  });
});
