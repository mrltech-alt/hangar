/**
 * `agentMenuItems` — the one list the sidebar row and the pane header both show (spec §12.2). Whether
 * a real right-click through the mounted App reaches this list at all (G60) is pinned by
 * `PaneGrid.test.tsx` → "context menu routing"; the entry added here brings no handler of its own, so
 * this file is about what the list CONTAINS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';
import {
  defaultProjectSetup, emptyWorkspace, initialSessionState, type Agent, type Project, type Workspace, type WorkspaceSnapshot,
} from '../../../shared/types.ts';
import type { MenuItem } from '../stores/ui.ts';

/** `lib/api.ts` reads `window.hangar` at module-evaluation time — the same `vi.resetModules()` dance as every renderer test. */
async function load() {
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(_channel: K, ..._args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      return Promise.resolve({ ok: true, value: undefined as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(_channel: K, _handler: (payload: IpcEvents[K]) => void): () => void {
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [actions, ui] = await Promise.all([import('./agent-actions.ts'), import('../stores/ui.ts')]);
  return { ...actions, ui };
}

const ISO = '2026-09-15T10:00:00.000Z';
const project = (id: string, name: string): Project => ({ id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO });
/**
 * The real shapes: every workspace of an agent is on the agent's own branch, and its worktree sits at
 * `<worktreesDir>/<project name when it was added>/<agent slug>` (`paths.ts` → `worktreePath`).
 */
const ws = (id: string, projectId: string, projectDir = projectId): Workspace => ({ id, projectId, branch: 'agent/pair', worktreePath: `/h/worktrees/${projectDir}/pair`, baseRef: 'main', createdAt: ISO });
const agentWith = (workspaces: Workspace[]): Agent => ({
  id: 'a1', name: 'pair', slug: 'pair', folderId: null, sortKey: 0, workspaces, notes: '',
  claude: { sessionId: 's-a1', hasStartedOnce: false, permissionMode: null, extraArgs: [] }, createdAt: ISO, lastOpenedAt: null,
});
const snapshotOf = (agent: Agent, projects: Project[]): WorkspaceSnapshot => ({
  workspace: { ...emptyWorkspace(), projects, agents: [agent] },
  sessions: {},
  runtime: {},
  host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
  profile: { home: '/h', isDefault: true },
});

const PROJECTS = [project('p1', 'hangar'), project('p2', 'acmeapi'), project('p3', 'acme-frontend')];

let t: Awaited<ReturnType<typeof load>>;
beforeEach(async () => {
  t = await load();
});

const menuFor = (agent: Agent): MenuItem[] => t.agentMenuItems(agent, initialSessionState(agent.id), snapshotOf(agent, PROJECTS));
const removeEntry = (items: MenuItem[]): MenuItem => {
  const found = items.find((i) => i.label === 'Remove project from this agent');
  if (!found) throw new Error(`no remove entry in: ${items.map((i) => i.label).join(' | ')}`);
  return found;
};

describe('agentMenuItems → Remove project from this agent (spec 2026-09-15 §11.1)', () => {
  it('sits directly after "Add project to this agent…" and lists every workspace but the primary', () => {
    const items = menuFor(agentWith([ws('w1', 'p1'), ws('w2', 'p2'), ws('w3', 'p3')]));
    const labels = items.map((i) => i.label);
    expect(labels.indexOf('Remove project from this agent')).toBe(labels.indexOf('Add project to this agent…') + 1);
    const remove = removeEntry(items);
    expect(remove.disabled).toBe(false);
    expect(remove.children?.map((c) => c.label)).toEqual(['acmeapi', 'acme-frontend']);
  });

  it('is disabled for an agent with a single workspace', () => {
    const remove = removeEntry(menuFor(agentWith([ws('w1', 'p1')])));
    expect(remove.disabled).toBe(true);
    expect(remove.children).toEqual([]);
  });

  it('opens the Remove project dialog for the workspace chosen', () => {
    const remove = removeEntry(menuFor(agentWith([ws('w1', 'p1'), ws('w2', 'p2'), ws('w3', 'p3')])));
    remove.children?.find((c) => c.label === 'acme-frontend')?.onSelect?.();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'remove-workspace', agentId: 'a1', workspaceId: 'w3' });
  });

  // Both on `agent/pair`, as every workspace of one agent is — so the branch cannot tell them apart,
  // and the worktree's own location (which still names the project it was made for) does.
  it('tells two removed projects apart by where their worktrees are', () => {
    const remove = removeEntry(menuFor(agentWith([ws('w1', 'p1'), ws('w2', 'gone-a', 'old-api'), ws('w3', 'gone-b', 'old-web')])));
    expect(remove.children?.map((c) => c.label)).toEqual(['missing project (old-api/pair)', 'missing project (old-web/pair)']);
  });

  it('leaves a lone removed project, and every live one, labelled by name alone', () => {
    const remove = removeEntry(menuFor(agentWith([ws('w1', 'p1'), ws('w2', 'p2'), ws('w3', 'gone-a', 'old-api')])));
    expect(remove.children?.map((c) => c.label)).toEqual(['acmeapi', 'missing project']);
  });
});
