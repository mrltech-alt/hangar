import { describe, expect, it } from 'vitest';
import { defaultProjectSetup, emptyWorkspace, type Agent, type WorkspaceFile } from '../../../shared/types.ts';
import { buildRows, matchesSearch } from './tree.ts';

const agent = (id: string, folderId: string | null, sortKey: number, name = id): Agent => ({
  id, name, slug: id, folderId, sortKey, notes: '', createdAt: 'x', lastOpenedAt: null,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${id}`, worktreePath: '/w', baseRef: 'main', createdAt: 'x' }],
  claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
});

const ws: WorkspaceFile = {
  ...emptyWorkspace(),
  projects: [{ id: 'p1', name: 'AcmeApi', repoPath: '/r', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: 'x' }],
  folders: [
    { id: 'f1', name: 'Ac', parentId: null, sortKey: 0, collapsed: false },
    { id: 'f2', name: 'Games', parentId: null, sortKey: 1, collapsed: true },
    { id: 'f1a', name: 'Sub', parentId: 'f1', sortKey: 5, collapsed: false },
  ],
  agents: [agent('a1', 'f1', 1, 'Fix webhooks'), agent('a2', 'f2', 0), agent('a3', null, 2, 'Root agent'), agent('a4', 'f1a', 0)],
};

describe('buildRows', () => {
  it('nests by sortKey with depth, hiding children of collapsed folders', () => {
    const rows = buildRows(ws, '');
    expect(rows.map((r) => `${r.kind}:${r.id}@${r.depth}`)).toEqual(['folder:f1@0', 'agent:a1@1', 'folder:f1a@1', 'agent:a4@2', 'folder:f2@0', 'agent:a3@0']);
    expect(rows.find((r) => r.id === 'f2')).toMatchObject({ kind: 'folder', agentCount: 1 });
    expect(rows.find((r) => r.id === 'f1')).toMatchObject({ kind: 'folder', agentCount: 2 });
  });
  it('search flattens to matching agents only', () => {
    const rows = buildRows(ws, 'web');
    expect(rows.map((r) => r.id)).toEqual(['a1']);
    expect(rows[0]!.depth).toBe(0);
    expect(buildRows(ws, 'agent/a2').map((r) => r.id)).toEqual(['a2']); // matches branch
    expect(buildRows(ws, 'acmeapi').length).toBe(4); // matches project name
  });
});

describe('matchesSearch', () => {
  it('is case-insensitive across name, branch and project', () => {
    expect(matchesSearch(ws, ws.agents[0]!, 'FIX')).toBe(true);
    expect(matchesSearch(ws, ws.agents[0]!, 'nope')).toBe(false);
  });
});
