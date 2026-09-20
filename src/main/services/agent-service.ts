// Agent lifecycle orchestration — spec §10.2–§10.5, §11.1, §11.6. Everything here is driven through injected services.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { AGENT_WORKSPACES_MAX } from '../../../shared/constants.ts';
import { MIN_FREE_FOR_WORKTREE } from '../../../shared/disk.ts';
import { PROGRESS_STEP_ROLLBACK, PROGRESS_STEP_SAVED } from '../../../shared/ipc-contract.ts';
import type { CreateAgentInput, DeleteAgentOptions, DeleteInspection, IpcEvents, StartMode } from '../../../shared/ipc-contract.ts';
import { slugCandidate, slugify } from '../../../shared/slug.ts';
import { defaultProjectSetup, primaryWorkspace, type Agent, type AppConfig, type Id, type Project, type Workspace, type WorkspaceRuntime } from '../../../shared/types.ts';
import { formatGb, freeBytes as defaultFreeBytes } from '../util/disk.ts';
import type { Exec } from '../util/exec.ts';
import { composeClaudeArgs, composeStartupCommand, writeAgentSettings } from './claude-launch.ts';
import type { GitService } from './git.ts';
import type { HostClient } from './host-client.ts';
import { worktreePath, type HangarPaths } from './paths.ts';
import type { SessionRegistry } from './session-registry.ts';
import type { ShellEnv } from './shell-env.ts';
import { StoreError, addProject, createAgent as opCreateAgent, deleteAgent as opDeleteAgent, updateAgent } from './workspace-ops.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import { cloneDirs, copyPatterns, runPostCreate } from './worktree-setup.ts';

export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface AgentServiceDeps {
  store: WorkspaceStore;
  git: GitService;
  paths: HangarPaths;
  registry: SessionRegistry;
  hostClient: HostClient;
  exec: Exec;
  shellEnv: () => ShellEnv;
  config: () => AppConfig;
  repoRoot: string;
  env: Record<string, string>;
  emit: <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => void;
  log: (line: string) => void;
  uuid?: () => string;
  now?: () => Date;
  freeBytes?: (path: string) => number;
  /** How long `stopAgent` waits for the host to confirm the session is down. Injectable so tests can
   *  exercise the STOP_TIMEOUT path without a real 4s wall-clock wait. */
  stopTimeoutMs?: number;
}

export interface AgentService {
  addProject(repoPath: string): Promise<Project>;
  createAgent(input: CreateAgentInput): Promise<Agent>;
  startAgent(id: Id, mode: StartMode): Promise<void>;
  stopAgent(id: Id): Promise<void>;
  inspectDelete(id: Id): Promise<DeleteInspection>;
  deleteAgent(id: Id, options: DeleteAgentOptions): Promise<void>;
  addWorkspace(id: Id, projectId: Id, baseBranch: string | null): Promise<Workspace>;
  /** Spec 2026-09-15 §11.2: `inspectDelete` for ONE workspace — the line the Remove project dialog shows. */
  inspectRemoveWorkspace(id: Id, workspaceId: Id): Promise<DeleteInspection>;
  /** Spec 2026-09-15 §11.2: take a non-primary workspace off an agent. Does NOT stop the agent's session. */
  removeWorkspace(id: Id, workspaceId: Id, options: DeleteAgentOptions): Promise<void>;
  reconcile(): Promise<Record<Id, WorkspaceRuntime>>;
  /**
   * The `existsSync` half of `reconcile()`, without the `git worktree prune` — cheap enough to call
   * on every snapshot, which is what the caller must do: a map captured once at boot has no entry
   * for an agent created afterwards, and never notices a worktree deleted behind the app's back.
   */
  computeRuntime(): Record<Id, WorkspaceRuntime>;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAgentService(deps: AgentServiceDeps): AgentService {
  const uuid = deps.uuid ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 4_000;

  type Progress = (step: string, status: 'running' | 'done' | 'warn' | 'error', message: string, log?: string) => void;
  const progressFor = (agentId: Id | null): Progress => {
    const opId = uuid();
    return (step, status, message, log) => deps.emit('agent:progress', { agentId, opId, step, status, message, log });
  };

  const requireAgent = (id: Id): Agent => {
    const a = deps.store.get().agents.find((x) => x.id === id);
    if (!a) throw new AgentError('NOT_FOUND', `no agent ${id}`);
    return a;
  };
  const requireProject = (id: Id): Project => {
    const p = deps.store.get().projects.find((x) => x.id === id);
    if (!p) throw new AgentError('NOT_FOUND', `no project ${id}`);
    return p;
  };

  const childEnv = (extra: Record<string, string>): Record<string, string> => ({ ...deps.env, ...extra });

  async function baseRefFor(project: Project, baseBranch: string | null): Promise<string> {
    const base = baseBranch ?? project.defaultBranch;
    if (await deps.git.refExists(project.repoPath, `refs/remotes/origin/${base}`)) return `origin/${base}`;
    if (await deps.git.refExists(project.repoPath, `refs/heads/${base}`)) return base;
    throw new AgentError('BASE_NOT_FOUND', `${project.name}: branch "${base}" was not found locally or on origin`);
  }

  async function slugIsFree(slug: string, projects: Project[], ignoreAgentId: string | null = null): Promise<boolean> {
    // The workspace, not only the disk. `workspace-ops.createAgent` already rejects a duplicate
    // branch, so this does not close a hole — it moves the failure earlier. Without it, a worktree
    // deleted behind the app's back let `pickSlug` hand back a taken slug, the whole provision ran,
    // and only then did the store throw, leaving a rollback of work that never needed doing. With
    // it, the suffix is chosen up front.
    //
    // `ignoreAgentId` is not optional: `addWorkspace` re-uses the agent's OWN slug for a newly added
    // project, so without excluding it the agent would always collide with itself and every added
    // workspace would get a pointless `-2`.
    if (deps.store.get().agents.some((a) => a.id !== ignoreAgentId && a.slug === slug)) return false;
    for (const p of projects) {
      if (existsSync(join(deps.paths.worktreesDir, p.name, slug))) return false;
      if (await deps.git.branchExists(p.repoPath, `agent/${slug}`)) return false;
    }
    return true;
  }

  /** Spec §10.2 step 3: one suffix decision for all selected projects. */
  async function pickSlug(base: string, projects: Project[], ignoreAgentId: string | null = null): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const candidate = slugCandidate(base, n); // makes room for the suffix; see shared/slug.ts
      if (await slugIsFree(candidate, projects, ignoreAgentId)) return candidate;
    }
    throw new AgentError('SLUG_EXHAUSTED', `could not find a free branch name for ${base}`);
  }

  /**
   * Spec §10.2 steps 1, 2, 4–7 for one project. Returns the Workspace record.
   *
   * `register` is called the moment `git worktree add` succeeds, NOT when this function returns, and
   * it has exactly one job: put the worktree on the caller's rollback list. It is deliberately NOT
   * the channel by which the caller learns the workspace — that is the return value — so that a
   * `register` which stopped working would break rollback and nothing else, instead of quietly
   * breaking both.
   *
   * Registering early matters because a throw from any setup step below would otherwise leave a real
   * worktree and a real branch on disk that rollback never hears about; since the agent is not saved
   * either, nothing in the app would reference them again, and the orphan then makes the next create
   * of the same name die on `PATH_EXISTS` with no visible cause.
   *
   * **This is reachable.** An earlier version of this comment claimed it was not, on the grounds
   * that `copyPatterns` "skips a file it cannot read" — true per file, but it also hard-throws up
   * front when the worktree ROOT is absent (`worktree-setup.ts`, deliberately, so a mistyped path
   * cannot fabricate a directory tree). A worktree removed between `worktree add` and the copy —
   * an external `git worktree remove`, a volume disappearing — lands exactly there. See the
   * "rolls back a worktree whose setup throws" test.
   */
  async function provisionWorkspace(project: Project, baseBranch: string | null, slug: string, progress: Progress, register: (w: Workspace) => void): Promise<Workspace> {
    const label = project.name;
    const base = baseBranch ?? project.defaultBranch;
    if (project.setup.fetchBeforeBranch) {
      progress(`${label}: fetch`, 'running', `git fetch origin ${base}`);
      try {
        await deps.git.fetch(project.repoPath, base);
        progress(`${label}: fetch`, 'done', 'fetched');
      } catch (e) {
        progress(`${label}: fetch`, 'warn', `fetch failed; using local refs (${errorMessage(e).split('\n')[0]})`);
      }
    }
    const baseRef = await baseRefFor(project, baseBranch);
    const branch = `agent/${slug}`;
    const path = worktreePath(deps.paths, project.name, slug);
    if (existsSync(path)) throw new AgentError('PATH_EXISTS', `${label}: ${path} already exists; remove it first`);

    progress(`${label}: worktree`, 'running', `git worktree add -b ${branch} ${path} ${baseRef}`);
    await deps.git.worktreeAdd(project.repoPath, { branch, path, baseRef });
    progress(`${label}: worktree`, 'done', path);
    // From here on the worktree exists on disk. Everything below can fail, so make it rollback-able
    // before attempting any of it — see this function's doc comment.
    const workspace: Workspace = { id: uuid(), projectId: project.id, branch, worktreePath: path, baseRef, createdAt: now().toISOString() };
    register(workspace);

    const copyLog: string[] = [];
    progress(`${label}: copy files`, 'running', project.setup.copyPatterns.join(', ') || 'nothing to copy');
    const copied = copyPatterns(project.repoPath, path, project.setup.copyPatterns, (l) => copyLog.push(l));
    progress(`${label}: copy files`, 'done', `${copied.length} file(s)`, copyLog.join('\n'));

    if (project.setup.cloneDirs.length > 0) {
      const cloneLog: string[] = [];
      progress(`${label}: clone dirs`, 'running', project.setup.cloneDirs.join(', '));
      const r = await cloneDirs(project.repoPath, path, project.setup.cloneDirs, deps.exec, (l) => cloneLog.push(l));
      progress(`${label}: clone dirs`, r.cloned.length === 0 && r.skipped.length > 0 ? 'warn' : 'done', `cloned: ${r.cloned.join(', ') || 'nothing'}`, cloneLog.join('\n'));
    }

    if (project.setup.postCreate !== null && project.setup.postCreate.trim().length > 0) {
      const pcLog: string[] = [];
      progress(`${label}: postCreate`, 'running', project.setup.postCreate);
      const r = await runPostCreate({ shell: deps.config().shellPath, command: project.setup.postCreate, cwd: path, env: childEnv({ PATH: deps.shellEnv().path }), log: (l) => pcLog.push(l) });
      progress(`${label}: postCreate`, r.ok ? 'done' : 'warn', r.ok ? 'completed' : `exited with ${r.code ?? 'signal'}`, pcLog.join('\n'));
    }

    return workspace;
  }

  async function rollback(created: { project: Project; workspace: Workspace }[], progress: Progress): Promise<void> {
    if (created.length === 0) return;
    progress(PROGRESS_STEP_ROLLBACK, 'running', `removing ${created.length} worktree(s)`);
    const removed: string[] = [];
    const survivors: string[] = [];
    for (const c of created) {
      try {
        await deps.git.worktreeRemove(c.project.repoPath, c.workspace.worktreePath, true);
        // Prune before the branch delete, and only delete a branch that is still there — same two
        // reasons as `deleteAgent`: a stale registration makes `branch -D` refuse with "used by
        // worktree at …", and an already-absent branch is the goal state, not a failure.
        await deps.git.worktreePrune(c.project.repoPath).catch(() => undefined);
        if (await deps.git.branchExists(c.project.repoPath, c.workspace.branch)) {
          await deps.git.branchDelete(c.project.repoPath, c.workspace.branch, true);
        }
        removed.push(c.workspace.worktreePath);
      } catch (e) {
        survivors.push(`${c.workspace.worktreePath} (${errorMessage(e).split('\n')[0]})`);
        deps.log(`rollback failed for ${c.workspace.worktreePath}: ${errorMessage(e)}`);
      }
    }
    // §10.2 requires rollback to report what was cleaned AND what was not. Reporting a flat
    // `done / removed N` from the ATTEMPTED count told the user the tree was clean while an orphan
    // was still on disk; the only trace was `deps.log`, which no user ever sees, and that orphan is
    // what makes the next create of the same name die on `PATH_EXISTS`.
    if (survivors.length === 0) progress(PROGRESS_STEP_ROLLBACK, 'done', `removed ${removed.length} worktree(s)`);
    else progress(PROGRESS_STEP_ROLLBACK, 'warn', `removed ${removed.length} of ${created.length}; left behind: ${survivors.join('; ')}`);
  }

  /**
   * One workspace's line in a `DeleteInspection`. The body of `inspectDelete`'s loop, moved here
   * unchanged so the Remove project dialog (spec 2026-09-15 §11) reads its line from the same code the
   * Delete dialog does. The log prefix stays `inspectDelete:` so an existing grep still finds it.
   */
  async function inspectWorkspace(w: Workspace): Promise<DeleteInspection['workspaces'][number]> {
    const project = deps.store.get().projects.find((p) => p.id === w.projectId);
    const missing = !existsSync(w.worktreePath);
    let dirtyFiles = 0;
    let unmergedCommits = 0;
    // Both counts used to `.catch(() => 0)` in silence, and 0 is the SAFE-LOOKING answer: it
    // reads as "nothing to lose" to the only force gate this operation has. A worktree whose
    // `.git` link is broken exists on disk, so `worktreeMissing` is false and `dirtyCount`
    // throws "not a git repository" — the dialog then offered a clean delete over real files.
    let inspectionFailed = false;
    const counted = async (label: string, run: Promise<number>): Promise<number> =>
      run.catch((e: unknown) => {
        inspectionFailed = true;
        deps.log(`inspectDelete: ${label} failed for ${w.worktreePath} (${w.branch}): ${errorMessage(e)}`);
        return 0;
      });
    if (project) {
      // Dirty files genuinely need the working tree — a directory that is gone has no uncommitted
      // edits to lose. Unmerged commits deliberately do NOT: they live on the branch, and asking
      // the missing directory (as `unmergedCount` must) reported 0 at exactly the moment the
      // renderer's typed-name force gate — the only force gate there will ever be — should arm.
      if (!missing) dirtyFiles = await counted('dirtyCount', deps.git.dirtyCount(w.worktreePath));
      const ref = (await deps.git.refExists(project.repoPath, `refs/remotes/origin/${project.defaultBranch}`)) ? `origin/${project.defaultBranch}` : project.defaultBranch;
      unmergedCommits = await counted('branchAheadCount', deps.git.branchAheadCount(project.repoPath, ref, w.branch));
    } else {
      // No project, so neither count can even be attempted, and "0 dirty, 0 unmerged" would be a
      // fabricated verdict. `inspectionFailed` is load-bearing: the renderer's `deleteIsRisky` arms
      // the typed-name gate on it, and the confirmed Delete or Remove is then sent with `force`.
      inspectionFailed = true;
      deps.log(`inspectDelete: project ${w.projectId} is no longer in the workspace, so ${w.worktreePath} could not be inspected`);
    }
    return { workspaceId: w.id, branch: w.branch, worktreePath: w.worktreePath, dirtyFiles, unmergedCommits, worktreeMissing: missing, inspectionFailed };
  }

  /**
   * Take one workspace's git footprint down: the worktree (forced only with `force`), its stale
   * registration, and its branch. The body of `deleteAgent`'s loop, shared with `removeWorkspace` so
   * the two cannot drift apart. Throws on the first worktree-remove or branch-delete failure (prune
   * errors are ignored); the caller decides what the record should say.
   *
   * `onWorktreeGone` fires once the directory is gone — removed just now, or already missing — and
   * BEFORE the prune and branch awaits. `removeWorkspace` drops its record there, because a record for
   * a missing directory reads as `worktreeMissing` in any snapshot broadcast during those awaits, and
   * `Pane.tsx` swaps a live terminal for the exit card over that. `deleteAgent` passes nothing.
   */
  async function teardownWorkspace(project: Project, w: Workspace, options: DeleteAgentOptions, onWorktreeGone?: () => void): Promise<void> {
    if (options.removeWorktrees && existsSync(w.worktreePath)) await deps.git.worktreeRemove(project.repoPath, w.worktreePath, options.force);
    if (onWorktreeGone && !existsSync(w.worktreePath)) onWorktreeGone();
    // Prune BEFORE the branch delete, not after. A worktree directory that vanished behind the
    // app's back keeps its registration, and git then refuses `branch -D` with "used by
    // worktree at …" — with the prune sequenced afterwards in the same try, the one command
    // that would have fixed the state never ran, and no amount of retrying or forcing helped.
    await deps.git.worktreePrune(project.repoPath).catch(() => undefined);
    // A branch that is already gone is the goal state, not an error. Treating "not found" as
    // fatal made an agent whose branch was deleted behind the app's back permanently
    // undeletable — force did not rescue it either, since force only picks `-D` over `-d`.
    if (options.deleteBranches && (await deps.git.branchExists(project.repoPath, w.branch))) {
      await deps.git.branchDelete(project.repoPath, w.branch, options.force);
    }
  }

  /** True if the session reached a terminal state within the timeout, false if it never did. */
  async function waitForExit(id: Id, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const a = deps.registry.get(id).activity;
      if (a === 'exited' || a === 'stopped') return true;
      if (Date.now() >= deadline) return false;
      await sleep(25);
    }
  }

  const service: AgentService = {
    async addProject(repoPath) {
      const top = await deps.git.isToplevel(repoPath);
      if (!top.ok) throw new AgentError('NOT_REPO_ROOT', top.reason);
      const defaultBranch = await deps.git.detectDefaultBranch(repoPath);
      const project: Project = { id: uuid(), name: basename(repoPath), repoPath, defaultBranch, setup: defaultProjectSetup(), claudeArgs: [], createdAt: now().toISOString() };
      try {
        deps.store.update((ws) => addProject(ws, project));
      } catch (e) {
        if (e instanceof StoreError) throw new AgentError(e.code, e.message);
        throw e;
      }
      return deps.store.get().projects.find((p) => p.id === project.id)!;
    },

    async createAgent(input) {
      const ws = deps.store.get();
      const name = input.name.trim();
      const selections = input.workspaces.map((w) => ({ project: requireProject(w.projectId), baseBranch: w.baseBranch }));
      if (new Set(selections.map((s) => s.project.id)).size !== selections.length) throw new AgentError('INVALID', 'the same project cannot be selected twice');
      if (input.folderId !== null && !ws.folders.some((f) => f.id === input.folderId)) throw new AgentError('NOT_FOUND', `no folder ${input.folderId}`);
      const free = freeBytes(deps.paths.worktreesDir);
      if (free < MIN_FREE_FOR_WORKTREE) throw new AgentError('LOW_DISK', `only ${formatGb(free)} free on the volume holding ${deps.paths.worktreesDir}; at least ${formatGb(MIN_FREE_FOR_WORKTREE)} is required`);

      const agentId = uuid();
      const progress = progressFor(agentId);
      const slug = await pickSlug(slugify(name), selections.map((s) => s.project));
      // Two lists on purpose: `created` is the rollback ledger, written the instant each worktree
      // exists; `provisioned` is what the agent record is built from, written only on success. They
      // hold the same things today, but conflating them made `register` the sole return channel —
      // so a broken `register` would have corrupted the saved agent rather than only the rollback.
      const created: { project: Project; workspace: Workspace }[] = [];
      const provisioned: Workspace[] = [];
      try {
        for (const { project, baseBranch } of selections) {
          provisioned.push(await provisionWorkspace(project, baseBranch, slug, progress, (workspace) => created.push({ project, workspace })));
        }
      } catch (e) {
        await rollback(created, progress);
        progress('failed', 'error', errorMessage(e));
        throw e instanceof AgentError ? e : new AgentError('CREATE_FAILED', errorMessage(e));
      }

      const agent: Agent = {
        id: agentId,
        name,
        slug,
        folderId: input.folderId,
        sortKey: 0,
        workspaces: provisioned,
        notes: '',
        claude: { sessionId: uuid(), hasStartedOnce: false, permissionMode: input.permissionMode, extraArgs: [] },
        createdAt: now().toISOString(),
        lastOpenedAt: null,
      };
      try {
        deps.store.update((w) => opCreateAgent(w, agent));
      } catch (e) {
        await rollback(created, progress);
        throw e instanceof StoreError ? new AgentError(e.code, e.message) : e;
      }
      progress(PROGRESS_STEP_SAVED, 'done', 'agent created');
      if (input.startNow) await service.startAgent(agentId, 'auto');
      return requireAgent(agentId);
    },

    async startAgent(id, mode) {
      const agent = requireAgent(id);
      const primary = agent.workspaces[0]!;
      const project = requireProject(primary.projectId);
      if (!existsSync(primary.worktreePath)) throw new AgentError('WORKTREE_MISSING', `${primary.worktreePath} does not exist`);
      if (!deps.hostClient.isConnected()) throw new AgentError('HOST_DOWN', 'the session host is not connected');
      const activity = deps.registry.get(id).activity;
      if (activity !== 'stopped' && activity !== 'exited') throw new AgentError('ALREADY_RUNNING', `${agent.name} is already running`);

      let resume = agent.claude.hasStartedOnce;
      let sessionId = agent.claude.sessionId;
      if (mode === 'fresh') {
        resume = false;
        sessionId = uuid();
      } else if (mode === 'resume') {
        // Unconditional, per §11.1 ("`'resume'` → `--resume`"). On an agent that has never started
        // this emits `--resume <uuid>` for a session claude never created, and claude errors out.
        // Downgrading to `--session-id` here would be kinder, but it would also make `'resume'`
        // behave identically to `'auto'` in every reachable case, i.e. delete the mode. The caller
        // that can tell the difference is the UI, which only offers Resume once a session exists;
        // pinned by the "resume on a never-started agent" test so the sharp edge stays visible.
        resume = true;
      }
      const launchAgent: Agent = { ...agent, claude: { ...agent.claude, sessionId } };
      let startupCommand: string | undefined;
      if (mode !== 'shell-only') {
        // Written here, at every start, rather than once at boot: it carries the primary project's
        // §11.9 opt-in, so it has to be re-derived after a Project Settings change — and turning the
        // setting off has to be able to REMOVE the key, which only a rewrite does. Skipped entirely
        // for 'shell-only', which composes no command and would leave an unread file behind.
        const settings = writeAgentSettings(deps.paths.claudeAgentsDir, id, project, join(deps.repoRoot, 'bin', 'hangar'), homedir());
        startupCommand = composeStartupCommand(composeClaudeArgs(launchAgent, project, { settings, systemPrompt: deps.paths.claudeSystemPrompt }, resume, deps.config().claudeDefaultArgs));
      }

      const shellEnv = deps.shellEnv();
      const extra: Record<string, string> = {
        HANGAR_AGENT_ID: id,
        HANGAR_SOCKET: deps.paths.socketPath,
        HANGAR_HOME: deps.paths.home,
        HANGAR_APP_ROOT: deps.repoRoot,
        PATH: `${join(deps.repoRoot, 'bin')}:${shellEnv.path}`,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: deps.env.LANG ?? 'en_US.UTF-8',
      };
      if (shellEnv.nodeBin !== null) extra.HANGAR_NODE = shellEnv.nodeBin;

      const reply = await deps.hostClient.request({
        t: 'spawn',
        id,
        cwd: primary.worktreePath,
        file: deps.config().shellPath,
        args: ['-il'],
        env: childEnv(extra),
        cols: 120,
        rows: 40,
        startupCommand,
      });
      if (reply.t !== 'spawned') throw new AgentError('SPAWN_FAILED', `unexpected reply from the session host: ${reply.t}`);
      deps.registry.apply(id, { kind: 'spawned', pid: reply.pid, at: Date.now() });
      deps.store.update((w) => updateAgent(w, id, { claude: { sessionId, hasStartedOnce: mode === 'shell-only' ? agent.claude.hasStartedOnce : true } }));
      deps.log(`started agent ${id} (${agent.name}) pid=${reply.pid} mode=${mode}`);
    },

    async stopAgent(id) {
      const agent = requireAgent(id);
      if (!deps.hostClient.isConnected()) throw new AgentError('HOST_DOWN', 'the session host is not connected');
      const activity = deps.registry.get(id).activity;
      if (activity === 'stopped' || activity === 'exited') return;
      await deps.hostClient.request({ t: 'kill', id, signal: 'SIGHUP' });
      // G38: `killTree()` snapshots the process tree, and agent deletion runs `git worktree remove`
      // on that guarantee. Returning normally after the poll expired handed `deleteAgent` a
      // guarantee it had not actually got, and `worktree remove --force` then pulled the tree out
      // from under a live claude. If the tree is not confirmed down, say so and delete nothing.
      if (!(await waitForExit(id, stopTimeoutMs))) {
        throw new AgentError('STOP_TIMEOUT', `${agent.name} did not exit within ${stopTimeoutMs}ms of SIGHUP`);
      }
    },

    async inspectDelete(id) {
      const agent = requireAgent(id);
      const workspaces: DeleteInspection['workspaces'] = [];
      for (const w of agent.workspaces) workspaces.push(await inspectWorkspace(w));
      return { workspaces };
    },

    async deleteAgent(id, options) {
      const agent = requireAgent(id);
      if (deps.hostClient.isConnected()) {
        await service.stopAgent(id);
        await deps.hostClient.request({ t: 'dispose', id }).catch(() => undefined);
      }
      // Resumable, not restart-from-scratch. §10.4's "otherwise it stays with a warning badge so
      // nothing is orphaned silently" needs the surviving record to stay TRUE: every workspace whose
      // cleanup completed is dropped here and now, so a retry attempts only what is genuinely left.
      // Previously one failure aborted the loop with the record untouched, so a two-workspace agent
      // whose second workspace failed kept claiming a first worktree and branch that had already
      // been destroyed — and the retry then died on that phantom and never reached the real one.
      const remaining: Workspace[] = [];
      const failures: string[] = [];
      for (const w of agent.workspaces) {
        const project = deps.store.get().projects.find((p) => p.id === w.projectId);
        if (!project) {
          // Not `continue`: dropping the record while its worktree and branch are still on disk is
          // exactly the silent orphan §10.4 forbids. Unreachable while `removeProject` refuses with
          // PROJECT_IN_USE, so fail loudly if that ever stops being true.
          remaining.push(w);
          failures.push(`${w.branch}: its project is no longer in the workspace, so ${w.worktreePath} was left in place`);
          continue;
        }
        try {
          await teardownWorkspace(project, w, options);
        } catch (e) {
          remaining.push(w);
          failures.push(`${project.name} (${w.branch}): ${errorMessage(e)}`);
        }
      }
      if (failures.length > 0) {
        try {
          deps.store.update((ws) => updateAgent(ws, id, { workspaces: remaining }));
        } catch (e) {
          deps.log(`could not trim agent ${id} after a partial delete: ${errorMessage(e)}`);
        }
        throw new AgentError('DELETE_INCOMPLETE', failures.join('; '));
      }
      deps.store.update((ws) => opDeleteAgent(ws, id));
      deps.log(`deleted agent ${id} (${agent.name})`);
    },

    async addWorkspace(id, projectId, baseBranch) {
      const agent = requireAgent(id);
      const project = requireProject(projectId);
      if (agent.workspaces.some((w) => w.projectId === projectId)) throw new AgentError('INVALID', `${agent.name} already has a workspace for ${project.name}`);
      // The cap `agent:create` has always applied, applied to the path that GROWS an agent. Without
      // it an agent created at the maximum could be walked past it one project at a time, and the
      // result would then fail `AgentSchema` on the next load — the store would class
      // `workspace.json` as corrupt and start empty. Refusing here is the cheap end of that.
      if (agent.workspaces.length >= AGENT_WORKSPACES_MAX) {
        throw new AgentError('WORKSPACE_LIMIT', `${agent.name} already has the maximum of ${AGENT_WORKSPACES_MAX} projects`);
      }
      const slug = (await slugIsFree(agent.slug, [project], id)) ? agent.slug : await pickSlug(agent.slug, [project], id);
      const progress = progressFor(id);
      // `addWorkspace` had no rollback at all: a throw after `git worktree add` left an orphaned
      // worktree and branch with nothing referencing them, exactly the case `register` exists for on
      // the create path. Same list, same `rollback`.
      const created: { project: Project; workspace: Workspace }[] = [];
      let workspace: Workspace;
      try {
        workspace = await provisionWorkspace(project, baseBranch, slug, progress, (w) => created.push({ project, workspace: w }));
      } catch (e) {
        await rollback(created, progress);
        progress('failed', 'error', errorMessage(e));
        throw e instanceof AgentError ? e : new AgentError('CREATE_FAILED', errorMessage(e));
      }
      try {
        deps.store.update((ws) => {
          // Appended to the store's CURRENT list, not `agent.workspaces` read before provisioning
          // awaited: a `removeWorkspace` that finished in between would otherwise be written back,
          // resurrecting a record whose directory is gone. The two guards above are re-checked for
          // the same reason.
          const current = ws.agents.find((a) => a.id === id);
          if (!current) throw new StoreError('NOT_FOUND', `${agent.name} was deleted while ${project.name} was being added`);
          if (current.workspaces.some((x) => x.projectId === projectId)) throw new StoreError('INVALID', `${agent.name} already has a workspace for ${project.name}`);
          if (current.workspaces.length >= AGENT_WORKSPACES_MAX) throw new StoreError('WORKSPACE_LIMIT', `${agent.name} already has the maximum of ${AGENT_WORKSPACES_MAX} projects`);
          return updateAgent(ws, id, { workspaces: [...current.workspaces, workspace] });
        });
      } catch (e) {
        await rollback(created, progress);
        throw e instanceof StoreError ? new AgentError(e.code, e.message) : e;
      }
      progress(PROGRESS_STEP_SAVED, 'done', `added ${project.name}`);
      return workspace;
    },

    async inspectRemoveWorkspace(id, workspaceId) {
      const agent = requireAgent(id);
      const w = agent.workspaces.find((x) => x.id === workspaceId);
      if (!w) throw new AgentError('NOT_FOUND', `no workspace ${workspaceId} on agent ${agent.name}`);
      return { workspaces: [await inspectWorkspace(w)] };
    },

    async removeWorkspace(id, workspaceId, options) {
      const agent = requireAgent(id);
      const w = agent.workspaces.find((x) => x.id === workspaceId);
      if (!w) throw new AgentError('NOT_FOUND', `no workspace ${workspaceId} on agent ${agent.name}`);
      // The guard, not the UX: the menu never offers the primary. It is the PTY's cwd (§6.4), and an
      // agent with no workspace fails `AgentSchema` on the next load.
      if (primaryWorkspace(agent).id === workspaceId) {
        throw new AgentError('PRIMARY_WORKSPACE', `${agent.name}'s first project is where its terminal runs, so it cannot be removed`);
      }
      // Before any git call. git refuses `branch -D` on a branch checked out in a worktree that stays,
      // so this combination could only ever fail — and it failed after the record was dropped, leaving
      // a registered worktree nothing referenced and a retry that answered NOT_FOUND.
      if (!options.removeWorktrees && options.deleteBranches && existsSync(w.worktreePath)) {
        throw new AgentError('INVALID', `${w.branch} is checked out in ${w.worktreePath}, so it can only be deleted together with that worktree`);
      }
      let dropped = false;
      // Recorded rather than thrown: `dropRecord` also runs inside `teardownWorkspace`, where a throw
      // would skip the prune and branch steps and be re-labelled a git failure.
      let dropError: AgentError | null = null;
      const dropRecord = (): void => {
        if (dropped) return;
        dropped = true;
        try {
          // Filtered from the store's CURRENT agent, not the one read before the git calls awaited.
          deps.store.update((ws) => updateAgent(ws, id, { workspaces: (ws.agents.find((a) => a.id === id)?.workspaces ?? []).filter((x) => x.id !== workspaceId) }));
        } catch (e) {
          if (!deps.store.get().agents.some((a) => a.id === id)) {
            // As `deleteAgent` does: an agent deleted mid-teardown must not turn the git outcome into
            // a raw StoreError. There is no record left to drop, so say so and carry on.
            deps.log(`could not drop workspace ${workspaceId} from agent ${id}: ${errorMessage(e)}`);
            return;
          }
          // The agent is still there, and so is the record: that is a failure, not a success to log.
          const message = `could not drop ${w.branch} from ${agent.name}: ${errorMessage(e)}`;
          dropError = new AgentError(e instanceof StoreError || e instanceof AgentError ? e.code : 'REMOVE_INCOMPLETE', message);
        }
      };
      const project = deps.store.get().projects.find((p) => p.id === w.projectId);
      let failure: string | null = null;
      if (project) {
        try {
          await teardownWorkspace(project, w, options, dropRecord);
        } catch (e) {
          failure = `${project.name} (${w.branch}): ${errorMessage(e)}`;
        }
      } else {
        // No project: there is no repo to run git in, and dropping the record is the whole request.
        deps.log(`removeWorkspace: project ${w.projectId} is no longer in the workspace, so git was not run; ${w.worktreePath} (if present) and branch ${w.branch} were left on disk`);
      }
      // Spec §11.2 step 3. Keep the record ONLY when the worktree removal itself failed — the
      // directory is still there and was supposed to go. A record for a directory that is gone marks
      // the agent `worktreeMissing`, and `Pane.tsx` then swaps a live terminal for the exit card.
      const keepRecord = failure !== null && options.removeWorktrees && existsSync(w.worktreePath);
      if (!keepRecord) dropRecord();
      if (dropError !== null) {
        const { code, message } = dropError;
        throw failure === null ? dropError : new AgentError(code, `${message}; ${failure}`);
      }
      if (failure !== null) throw new AgentError('REMOVE_INCOMPLETE', failure);
      deps.log(`removed workspace ${workspaceId} (${w.branch}) from agent ${id} (${agent.name})`);
    },

    async reconcile() {
      const ws = deps.store.get();
      // `worktree prune` is repo-wide and cannot be scoped to a path, so this deregisters ANY of the
      // user's own worktrees whose directory is currently unreachable — an external volume not yet
      // mounted at app start, say — not only Hangar's. §10.5 asks for the repo-wide prune, so the
      // behaviour stays; the note is here because the blast radius is wider than the name suggests.
      // Pruning only drops registrations for directories that are already gone: it never deletes a
      // branch and never touches a worktree that is still on disk, so no work is at risk either way.
      for (const p of ws.projects) await deps.git.worktreePrune(p.repoPath).catch((e: unknown) => deps.log(`prune failed for ${p.repoPath}: ${errorMessage(e)}`));
      return service.computeRuntime();
    },

    computeRuntime() {
      const runtime: Record<Id, WorkspaceRuntime> = {};
      for (const a of deps.store.get().agents) for (const w of a.workspaces) runtime[w.id] = { workspaceId: w.id, worktreeMissing: !existsSync(w.worktreePath) };
      return runtime;
    },
  };

  return service;
}
