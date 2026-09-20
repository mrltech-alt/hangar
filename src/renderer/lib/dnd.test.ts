import { describe, expect, it } from 'vitest';
import type { Row } from './tree.ts';
import { dropPosition, resolveDrop } from './dnd.ts';

const folder = (id: string, depth: number, parentId: string | null): Row => ({ kind: 'folder', id, depth, agentCount: 0, folder: { id, name: id, parentId, sortKey: 0, collapsed: false } });
const agent = (id: string, depth: number, folderId: string | null): Row => ({
  kind: 'agent', id, depth,
  agent: { id, name: id, slug: id, folderId, sortKey: 0, notes: '', createdAt: 'x', lastOpenedAt: null, workspaces: [], claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] } },
});
const rows: Row[] = [folder('f1', 0, null), agent('a1', 1, 'f1'), agent('a2', 1, 'f1'), folder('f2', 0, null), agent('a3', 0, null)];

describe('dropPosition', () => {
  it('agents split top/bottom; folders have an "into" middle band', () => {
    expect(dropPosition(rows[1]!, 0.2)).toBe('before');
    expect(dropPosition(rows[1]!, 0.8)).toBe('after');
    expect(dropPosition(rows[0]!, 0.5)).toBe('into');
    expect(dropPosition(rows[0]!, 0.1)).toBe('before');
    expect(dropPosition(rows[0]!, 0.9)).toBe('after');
  });
});

describe('resolveDrop', () => {
  it('computes parentId/beforeId for before/after/into', () => {
    expect(resolveDrop(rows, rows[1]!, 'before')).toEqual({ parentId: 'f1', beforeId: 'a1' });
    expect(resolveDrop(rows, rows[1]!, 'after')).toEqual({ parentId: 'f1', beforeId: 'a2' });
    expect(resolveDrop(rows, rows[2]!, 'after')).toEqual({ parentId: 'f1', beforeId: null });
    expect(resolveDrop(rows, rows[0]!, 'into')).toEqual({ parentId: 'f1', beforeId: null });
    expect(resolveDrop(rows, rows[0]!, 'after')).toEqual({ parentId: null, beforeId: 'f2' });
    expect(resolveDrop(rows, rows[4]!, 'after')).toEqual({ parentId: null, beforeId: null });
  });
});
