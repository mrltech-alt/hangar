// Direct tests for the §6.3 sibling ordering, against `shared/tree.ts` itself.
//
// DO NOT "de-duplicate" this against `src/main/services/workspace-ops.test.ts`. The overlap is
// deliberate and load-bearing, and the two tests are not the same test:
//   - workspace-ops.test.ts reaches this ordering through workspace-ops' re-export. That is real
//     integration coverage, and it is the test that historically caught the tie-break mutants.
//   - this file exercises the shared module directly, so the ordering stays guarded if
//     workspace-ops ever stops re-exporting it, and it satisfies CLAUDE.md rule 5 (tests live next
//     to their module) for a file that would otherwise have none of its own.
// Deleting either one loses something the other does not provide.
//
// The tie-breaks are the reason this matters. When `siblings` lived in two places — here and a
// verbatim copy in `src/renderer/lib/tree.ts` — the renderer copy was covered by nothing, and both
// of its tie-break mutants survived the whole suite.
import { describe, expect, it } from 'vitest';
import { childId, childKey, siblings } from './tree.ts';
import { defaultProjectSetup, emptyWorkspace, type Agent, type Folder, type WorkspaceFile } from './types.ts';

const folder = (id: string, parentId: string | null, sortKey: number, name = id): Folder => ({ id, name, parentId, sortKey, collapsed: false });

const agent = (id: string, folderId: string | null, sortKey: number, createdAt = `2026-09-07T00:00:00.00${id.length}Z`): Agent => ({
  id,
  name: id,
  slug: id,
  folderId,
  sortKey,
  notes: '',
  createdAt,
  lastOpenedAt: null,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${id}`, worktreePath: `/w/${id}`, baseRef: 'main', createdAt }],
  claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
});

const build = (folders: Folder[], agents: Agent[]): WorkspaceFile => ({
  ...emptyWorkspace(),
  projects: [{ id: 'p1', name: 'AcmeApi', repoPath: '/r', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: 'x' }],
  folders,
  agents,
});

const ids = (ws: WorkspaceFile, parentId: string | null): string[] => siblings(ws, parentId).map(childId);

describe('siblings ordering', () => {
  it('interleaves folders and agents by sortKey, not by kind', () => {
    // Declared in an order that does NOT match the answer, so a function which merely concatenated
    // ws.folders and ws.agents would produce ['f-b','f-d','a-a','a-c'] and fail here.
    const ws = build(
      [folder('f-b', null, 1), folder('f-d', null, 3)],
      [agent('a-a', null, 0), agent('a-c', null, 2)],
    );
    expect(ids(ws, null)).toEqual(['a-a', 'f-b', 'a-c', 'f-d']);
  });

  it('orders by sortKey ascending, independently of declaration order', () => {
    const ws = build([], [agent('third', null, 30), agent('first', null, 10), agent('second', null, 20)]);
    expect(ids(ws, null)).toEqual(['first', 'second', 'third']);
  });
});

describe('siblings tie-breaks (spec §6.3)', () => {
  it('puts folders before agents at an equal sortKey', () => {
    // Both at sortKey 1, agent declared first: only the `0`/`1` tie prefixes can order these.
    const ws = build([folder('fold', null, 1)], [agent('ag', null, 1)]);
    expect(ids(ws, null)).toEqual(['fold', 'ag']);
  });

  it('breaks a folder-vs-folder tie by name', () => {
    const ws = build([folder('f1', null, 0, 'Zebra'), folder('f2', null, 0, 'Alpha')], []);
    expect(ids(ws, null)).toEqual(['f2', 'f1']);
  });

  it('breaks an agent-vs-agent tie by createdAt', () => {
    const ws = build([], [
      agent('later', null, 0, '2026-09-07T10:00:00.000Z'),
      agent('earlier', null, 0, '2026-09-07T09:00:00.000Z'),
    ]);
    expect(ids(ws, null)).toEqual(['earlier', 'later']);
  });

  it('applies the kind tie-break before the within-kind one', () => {
    // Every item shares sortKey 0. Folders come first (ordered by name), then agents (by createdAt),
    // so a mutant that dropped either prefix would interleave them by name/date instead.
    const ws = build(
      [folder('fz', null, 0, 'Zulu'), folder('fa', null, 0, 'Alpha')],
      [agent('az', null, 0, '2026-09-07T23:00:00.000Z'), agent('aa', null, 0, '2026-09-07T01:00:00.000Z')],
    );
    expect(ids(ws, null)).toEqual(['fa', 'fz', 'aa', 'az']);
  });
});

describe('siblings scoping by parent', () => {
  const ws = build(
    [folder('root-f', null, 0), folder('child-f', 'root-f', 0), folder('other-f', 'elsewhere', 0)],
    [agent('root-a', null, 1), agent('child-a', 'root-f', 1), agent('other-a', 'elsewhere', 1)],
  );

  it('selects only root items for parentId null', () => {
    expect(ids(ws, null)).toEqual(['root-f', 'root-a']);
  });

  it('selects only that parent\'s children for a non-null parentId', () => {
    expect(ids(ws, 'root-f')).toEqual(['child-f', 'child-a']);
  });

  it('returns nothing for a parent with no children', () => {
    expect(ids(ws, 'child-f')).toEqual([]);
  });

  // A folder's children hang off `parentId` while an agent's hang off `folderId` — two different
  // field names for one relationship, which is exactly the kind of thing a refactor conflates.
  it('reads parentId for folders and folderId for agents', () => {
    expect(ids(ws, 'elsewhere')).toEqual(['other-f', 'other-a']);
  });
});

describe('childId and childKey', () => {
  const f = folder('fid', null, 7, 'Name');
  const a = agent('aid', null, 9);

  it('read the folder fields for a folder child', () => {
    expect(childId({ kind: 'folder', folder: f })).toBe('fid');
    expect(childKey({ kind: 'folder', folder: f })).toBe(7);
  });

  it('read the agent fields for an agent child', () => {
    expect(childId({ kind: 'agent', agent: a })).toBe('aid');
    expect(childKey({ kind: 'agent', agent: a })).toBe(9);
  });
});
