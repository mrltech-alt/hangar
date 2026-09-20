import { describe, expect, it } from 'vitest';
import { defaultLayout, defaultProjectSetup, emptyWorkspace, primaryWorkspace, type Agent } from './types.ts';

describe('types defaults', () => {
  it('emptyWorkspace has version 1, no records and a single empty pane', () => {
    const ws = emptyWorkspace();
    expect(ws.version).toBe(1);
    expect(ws.projects).toEqual([]);
    expect(ws.folders).toEqual([]);
    expect(ws.agents).toEqual([]);
    expect(ws.layout.panes).toEqual([null]);
    expect(ws.layout.focusedIndex).toBe(0);
    expect(ws.layout.arrangement).toBe('single');
  });

  it('defaultProjectSetup matches spec §6 defaults', () => {
    expect(defaultProjectSetup()).toEqual({
      fetchBeforeBranch: true,
      copyPatterns: ['.env', '.env.*', '.claude/settings.local.json'],
      cloneDirs: ['node_modules'],
      postCreate: null,
    });
  });

  // Asserted in full because five of these fields have bounds enforced elsewhere
  // (LayoutSchema: sidebarWidth 200-480, drawerWidth >= 420). Without this, changing a
  // default here stays green and fails much later as a confusing schema mismatch.
  it('defaultLayout matches spec §6 defaults', () => {
    expect(defaultLayout()).toEqual({
      panes: [null],
      focusedIndex: 0,
      arrangement: 'single',
      splitOrientation: 'split-h',
      sidebarWidth: 260,
      sidebarVisible: true,
      drawerWidth: 560,
      drawerOpen: false,
      drawerTab: 'notes',
      // Not a rect: the cheatsheet panel's default geometry is derived from the live window and
      // sidebar width, so `null` here means "never moved" rather than "no default".
      shortcutsPanel: null,
    });
  });

  it('factories return fresh objects, so callers cannot mutate a shared default', () => {
    defaultProjectSetup().copyPatterns.push('mutated');
    expect(defaultProjectSetup().copyPatterns).toEqual(['.env', '.env.*', '.claude/settings.local.json']);
  });
});

describe('primaryWorkspace', () => {
  const agent = (workspaces: Agent['workspaces']): Agent => ({
    id: 'a1',
    name: 'Test',
    slug: 'test',
    folderId: null,
    sortKey: 0,
    workspaces,
    notes: '',
    claude: { sessionId: 's1', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
    createdAt: '2026-09-07T00:00:00.000Z',
    lastOpenedAt: null,
  });

  const workspace = (id: string) => ({
    id,
    projectId: 'p1',
    branch: `agent/${id}`,
    worktreePath: `/tmp/${id}`,
    baseRef: 'origin/main',
    createdAt: '2026-09-07T00:00:00.000Z',
  });

  it('returns workspaces[0]', () => {
    expect(primaryWorkspace(agent([workspace('w1'), workspace('w2')])).id).toBe('w1');
  });

  it('throws with the agent named, rather than returning undefined', () => {
    expect(() => primaryWorkspace(agent([]))).toThrow(/a1 \(Test\) has no workspaces/);
  });
});
