import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectSetup, emptyWorkspace, type WorkspaceFile } from '../../../shared/types.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { buildMirrors, writeMirrors } from './state-mirror.ts';

const ws: WorkspaceFile = {
  ...emptyWorkspace(),
  projects: [{ id: 'p1', name: 'AcmeApi', repoPath: '/repos/acmeapi', defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: 'x' }],
  agents: [{
    id: 'a1', name: 'Fix', slug: 'fix', folderId: null, sortKey: 0, notes: 'why', createdAt: 'x', lastOpenedAt: null,
    workspaces: [{ id: 'w1', projectId: 'p1', branch: 'agent/fix', worktreePath: '/wt/fix', baseRef: 'origin/main', createdAt: 'x' }],
    claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  }],
};

describe('buildMirrors', () => {
  it('resolves project names and paths', () => {
    expect(buildMirrors(ws, 'NOW')).toEqual([{
      id: 'a1', name: 'Fix', slug: 'fix', notes: 'why', updatedAt: 'NOW',
      workspaces: [{ projectName: 'AcmeApi', repoPath: '/repos/acmeapi', branch: 'agent/fix', worktreePath: '/wt/fix' }],
    }]);
  });
});

describe('buildMirrors', () => {
  // The fallbacks are the only reason this is more than a field copy, and nothing pinned them: a
  // mutation replacing either survived the plan's two tests.
  it('falls back honestly when the project is gone', () => {
    const orphaned: WorkspaceFile = { ...ws, projects: [] };
    expect(buildMirrors(orphaned, 'NOW')[0]!.workspaces[0]).toEqual({
      projectName: 'p1', // the raw projectId, so the reader can see WHICH project vanished
      repoPath: '',
      branch: 'agent/fix',
      worktreePath: '/wt/fix',
    });
  });
});

describe('writeMirrors', () => {
  it('writes one file per agent and deletes files for agents that no longer exist', () => {
    const dir = tempDir('mirror');
    writeFileSync(join(dir, 'stale.json'), '{}');
    writeMirrors(dir, ws, 'NOW');
    expect(readdirSync(dir).sort()).toEqual(['a1.json']);
    expect(JSON.parse(readFileSync(join(dir, 'a1.json'), 'utf8')).name).toBe('Fix');
  });

  // The write is atomic so a reader never sees a torn file; a mutation replacing it with a plain
  // writeFileSync survived the plan's tests. Also pins that the sweep now collects orphaned .tmp
  // files, which a crash between the write and the rename leaves behind.
  it('leaves no .tmp behind, and sweeps an orphan from an earlier crash', () => {
    const dir = tempDir('mirror-tmp');
    writeFileSync(join(dir, 'gone.json.tmp'), '{}');
    writeMirrors(dir, ws, 'NOW');
    expect(readdirSync(dir).sort()).toEqual(['a1.json']);
  });

  // The directory is owned by main, so debris is deleted — but only files that look like mirrors.
  it('does not touch files that are not mirrors', () => {
    const dir = tempDir('mirror-other');
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeMirrors(dir, ws, 'NOW');
    expect(readdirSync(dir).sort()).toEqual(['a1.json', 'notes.txt']);
  });

  // An id that escapes the directory must never reach `join`. Verified before the guard: an agent
  // with id '../../pwned' wrote outside state/agents/ entirely.
  it('refuses an agent id that would escape the directory', () => {
    const dir = tempDir('mirror-escape');
    const hostile: WorkspaceFile = { ...ws, agents: [{ ...ws.agents[0]!, id: '../../pwned' }] };
    expect(() => writeMirrors(dir, hostile, 'NOW')).toThrow(/unsafe agent id/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
