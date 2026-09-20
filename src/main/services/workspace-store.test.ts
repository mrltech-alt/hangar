import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_WORKSPACES_MAX } from '../../../shared/constants.ts';
import { emptyWorkspace, type Agent } from '../../../shared/types.ts';
import { WorkspaceFileSchema } from '../../../shared/workspace-schema.ts';
import { tempDir } from '../../../test/fixtures/tmp.ts';
import { createFolder, siblings } from './workspace-ops.ts';
import {
  createWorkspaceStore, describeParseFailure, migrate, migrations, parseWorkspace, repairTree,
  WorkspaceMoveAsideError, WorkspaceUnreadableError,
} from './workspace-store.ts';

function tmpStore() {
  const dir = tempDir('store'); // `tempDir` and not a bare `mkdtempSync`: the latter leaked 5 dirs per run
  const file = join(dir, 'workspace.json');
  const bak = join(dir, 'workspace.json.bak');
  return { dir, file, bak, store: createWorkspaceStore({ file, bakFile: bak, debounceMs: 20 }) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createWorkspaceStore', () => {
  it('starts fresh when no file exists and writes it', () => {
    const { file, store } = tmpStore();
    expect(store.load()).toEqual({ recovered: 'fresh', movedCorruptTo: null, problems: [] });
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('update notifies subscribers, debounces writes, flush writes immediately, keeps .bak', async () => {
    const { file, bak, store } = tmpStore();
    store.load();
    const seen: number[] = [];
    store.subscribe((ws) => seen.push(ws.folders.length));
    store.update((ws) => createFolder(ws, { id: 'f1', name: 'A', parentId: null }));
    expect(seen).toEqual([1]);
    expect(JSON.parse(readFileSync(file, 'utf8')).folders).toEqual([]); // not yet written
    await sleep(60);
    expect(JSON.parse(readFileSync(file, 'utf8')).folders.length).toBe(1);
    store.update((ws) => createFolder(ws, { id: 'f2', name: 'B', parentId: null }));
    store.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).folders.length).toBe(2);
    expect(JSON.parse(readFileSync(bak, 'utf8')).folders.length).toBe(1);
  });

  it('recovers from .bak when the main file is corrupt, preserving the corrupt file', () => {
    const { dir, file, bak, store } = tmpStore();
    writeFileSync(bak, JSON.stringify({ ...emptyWorkspace(), folders: [{ id: 'f', name: 'FromBak', parentId: null, sortKey: 0, collapsed: false }] }));
    writeFileSync(file, '{ not json');
    const r = store.load();
    expect(r.recovered).toBe('bak');
    expect(r.movedCorruptTo).toMatch(/workspace\.json\.corrupt-/);
    expect(r.problems[0]).toContain('workspace.json');
    expect(store.get().folders[0]!.name).toBe('FromBak');
    expect(readdirSync(dir).some((f) => f.startsWith('workspace.json.corrupt-'))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).folders[0].name).toBe('FromBak');
  });

  it('starts fresh when both files are unusable (schema violation counts as corrupt)', () => {
    const { file, bak, store } = tmpStore();
    writeFileSync(file, JSON.stringify({ version: 1, projects: 'nope' }));
    writeFileSync(bak, JSON.stringify({ version: 99 }));
    const r = store.load();
    expect(r.recovered).toBe('fresh');
    expect(r.problems.length).toBe(2);
    expect(existsSync(file)).toBe(true);
  });

  // Spec §6.2 requires every folderId/parentId to resolve and the folder graph to be acyclic. Those
  // are enforced on WRITE by workspace-ops, but nothing enforced them on LOAD: WorkspaceFileSchema
  // accepts both a dangling parent and a cycle, and `siblings()` then silently omits the folder AND
  // its entire subtree — invisible in the UI, unreachable, still persisted on the next save. Repair
  // rather than reject: rejecting classes the file corrupt and costs the user every project.
  it('re-parents orphans whose folder or parent is missing', () => {
    const problems: string[] = [];
    const ws = parseWorkspace(JSON.stringify({
      ...emptyWorkspace(),
      folders: [{ id: 'orphan', name: 'Orphan', parentId: 'ghost', sortKey: 0, collapsed: false }],
    }), problems);
    expect(ws.folders[0]!.parentId).toBeNull();
    expect(siblings(ws, null).map((c) => (c.kind === 'folder' ? c.folder.id : c.agent.id))).toContain('orphan');
    expect(problems.join(' ')).toContain('ghost');
  });

  /**
   * Spec §15.4's actions are the one field on `ProjectSchema` that RECOVERS instead of rejecting,
   * and this is the whole reason: a hand-edited `workspace.json` is an input the load path is
   * written to survive, and a stray byte in a row of buttons must not cost the user every project
   * and every agent (which is what `load()` does with a corrupt file — see the tests above: it moves
   * it to `.corrupt-<timestamp>` and starts empty).
   *
   * The recovery only ever drops. It cannot admit the value that failed, which is the half that
   * matters here: the action below carries a carriage return, and a CR typed into the agent's PTY
   * presses Enter on the command the user was supposed to review first.
   */
  it('drops a project\'s actions rather than classing the whole file corrupt, and never admits a control character', () => {
    const problems: string[] = [];
    const project = {
      id: 'p1', name: 'hangar', repoPath: '/repos/hangar', defaultBranch: 'main',
      setup: { fetchBeforeBranch: true, copyPatterns: [], cloneDirs: [], postCreate: null },
      claudeArgs: [], createdAt: '2026-09-07T00:00:00.000Z',
    };
    const ws = parseWorkspace(JSON.stringify({
      ...emptyWorkspace(),
      projects: [{ ...project, actions: [{ label: 'Tests', command: 'npm test\r' }] }],
    }), problems);
    // The project survives; only its actions are gone.
    expect(ws.projects.length).toBe(1);
    expect(ws.projects[0]!.name).toBe('hangar');
    expect(ws.projects[0]!.actions).toBeUndefined();

    // The control that proves the schema is what dropped it rather than the whole field being
    // ignored: the SAME file with a clean command keeps its action.
    const clean = parseWorkspace(JSON.stringify({
      ...emptyWorkspace(),
      projects: [{ ...project, actions: [{ label: 'Tests', command: 'npm test' }] }],
    }), []);
    expect(clean.projects[0]!.actions).toEqual([{ label: 'Tests', command: 'npm test' }]);
  });

  /**
   * The persisted bound on `AgentSchema.workspaces`. `agent:create` has capped this at
   * AGENT_WORKSPACES_MAX since Plan 02, but the file schema had only `.min(1)` and
   * `agent:addWorkspace` had no cap at all — so the cap was reachable-past through the app and
   * simply absent for a hand-edited `workspace.json`. Unlike `actions` this REJECTS rather than
   * recovering: there is no safe repair (dropping workspaces would orphan worktrees and branches),
   * and the exact-cap control below is what proves the bound is at 8 rather than just "small".
   */
  it('rejects an agent carrying more than AGENT_WORKSPACES_MAX workspaces, and accepts exactly that many', () => {
    const workspace = (i: number) => ({
      id: `w${i}`, projectId: `p${i}`, branch: `agent/x-${i}`,
      worktreePath: `/wt/${i}`, baseRef: 'origin/main', createdAt: 'x',
    });
    const agentWith = (n: number) => ({
      id: 'a1', name: 'many', slug: 'many', folderId: null, sortKey: 0, notes: '', createdAt: 'x', lastOpenedAt: null,
      claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
      workspaces: Array.from({ length: n }, (_, i) => workspace(i)),
    });
    const file = (n: number) => ({ ...emptyWorkspace(), agents: [agentWith(n)] });
    expect(WorkspaceFileSchema.safeParse(file(AGENT_WORKSPACES_MAX)).success).toBe(true);
    const over = WorkspaceFileSchema.safeParse(file(AGENT_WORKSPACES_MAX + 1));
    expect(over.success).toBe(false);
    expect(describeParseFailure(over.error)).toContain('workspaces');
    // And it is a real corruption path, not just a schema opinion: `load()` moves the file aside.
    const { file: path, store } = tmpStore();
    writeFileSync(path, JSON.stringify(file(AGENT_WORKSPACES_MAX + 1)));
    expect(store.load().recovered).toBe('fresh');
  });

  it('breaks a folder cycle instead of leaving an unreachable subtree', () => {
    const problems: string[] = [];
    const ws = parseWorkspace(JSON.stringify({
      ...emptyWorkspace(),
      folders: [
        { id: 'f1', name: 'One', parentId: 'f2', sortKey: 0, collapsed: false },
        { id: 'f2', name: 'Two', parentId: 'f1', sortKey: 1, collapsed: false },
      ],
    }), problems);
    // Every folder must be reachable from root by walking parentId, and the walk must terminate.
    const reachable = new Set<string>();
    let frontier = siblings(ws, null).filter((c) => c.kind === 'folder').map((c) => c.folder.id);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (reachable.has(id)) continue;
        reachable.add(id);
        for (const c of siblings(ws, id)) if (c.kind === 'folder') next.push(c.folder.id);
      }
      frontier = next;
    }
    expect([...reachable].sort()).toEqual(['f1', 'f2']);
    expect(problems.join(' ')).toMatch(/cycle/i);
  });

  it('reports repairs through load()\'s problems, and the repair is persisted', () => {
    const { file, store } = tmpStore();
    writeFileSync(file, JSON.stringify({
      ...emptyWorkspace(),
      folders: [{ id: 'orphan', name: 'Orphan', parentId: 'ghost', sortKey: 0, collapsed: false }],
    }));
    const r = store.load();
    // A repairable file is NOT corrupt: nothing is moved aside and nothing is lost.
    expect(r.recovered).toBe('none');
    expect(r.movedCorruptTo).toBeNull();
    expect(r.problems.length).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).folders[0].parentId).toBeNull();
  });

  it('parseWorkspace normalizes the layout', () => {
    const ws = parseWorkspace(JSON.stringify({ ...emptyWorkspace(), layout: { ...emptyWorkspace().layout, panes: ['a', 'a', 'b', 'c', 'd', 'e'], focusedIndex: 9 } }));
    expect(ws.layout.panes).toEqual(['a', null, 'b', 'c']);
    expect(ws.layout.focusedIndex).toBe(3);
  });
});

// The following cover four review findings against the block above. Each one reproduces a way the
// store loses or corrupts a healthy profile — the failure mode that matters here, since every
// project, folder and agent the user has lives in this single file.
describe('createWorkspaceStore recovery boundaries', () => {
  const root = process.getuid?.() === 0; // chmod 000 does not deny root, so those tests cannot run

  function newStore(prefix: string) {
    const dir = tempDir(prefix);
    const file = join(dir, 'workspace.json');
    const bak = join(dir, 'workspace.json.bak');
    return { dir, file, bak, store: createWorkspaceStore({ file, bakFile: bak, debounceMs: 20 }) };
  }

  // An I/O error is not a corruption signal (spec §6.4 conditions the corrupt path on a JSON or
  // schema error). Treating one as corruption renames a HEALTHY workspace.json aside — rename needs
  // only directory permission, so it succeeds — and writes an empty workspace over it: a transient
  // EMFILE at startup is enough to present the user with zero projects and zero agents.
  it.skipIf(root)('throws a typed error and changes nothing when the main file cannot be read', () => {
    const { dir, file, bak } = newStore('store-unreadable');
    const original = JSON.stringify({ ...emptyWorkspace(), folders: [{ id: 'keep', name: 'Keep', parentId: null, sortKey: 0, collapsed: false }] });
    writeFileSync(file, original);
    const store = createWorkspaceStore({ file, bakFile: bak, debounceMs: 20 });
    chmodSync(file, 0o000);
    try {
      let err: unknown;
      try {
        store.load();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorkspaceUnreadableError);
      expect((err as WorkspaceUnreadableError).file).toBe(file);
      expect((err as WorkspaceUnreadableError).code).toBe('EACCES');
      expect((err as WorkspaceUnreadableError).syscall).toBe('open');
      expect(readdirSync(dir)).toEqual(['workspace.json']); // nothing moved aside, nothing written
    } finally {
      chmodSync(file, 0o600); // in a finally: a failure above must not leave the temp dir unreadable
    }
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  // §6.4 wants a banner saying WHY the file was moved aside. `e.message.split('\n')[0]` was written
  // for JSON.parse (one line); a zod 4 message starts with a bare `[`, so every schema banner read
  // `/…/workspace.json: [`.
  it('reports the offending field path for a schema error, not a bare bracket', () => {
    const { file, store } = newStore('store-schema');
    writeFileSync(file, JSON.stringify({ ...emptyWorkspace(), agents: [{ id: 'a1' }] }));
    const r = store.load();
    expect(r.recovered).toBe('fresh');
    expect(r.problems[0]).toContain('agents.0.name');
    expect(r.problems[0]!.endsWith(': [')).toBe(false);
  });

  // A file from a NEWER Hangar is not corrupt, and the user must be told not to overwrite it — it
  // is still preserved as .corrupt-<ts>, but a generic schema error gives them no way to know that.
  it('names a future workspace version rather than letting it fall through as a schema error', () => {
    const { dir, file, store } = newStore('store-future');
    writeFileSync(file, JSON.stringify({ ...emptyWorkspace(), version: 99 }));
    const r = store.load();
    expect(r.recovered).toBe('fresh');
    expect(r.problems[0]).toMatch(/newer version of Hangar/i);
    expect(r.problems[0]).toContain('99');
    expect(readdirSync(dir).some((f) => f.startsWith('workspace.json.corrupt-'))).toBe(true);
  });

  // A migration that forgets to set `version` was assumed to have advanced, so the loop exited and
  // the half-migrated object hit the schema — presenting a migration bug as a corrupt file.
  it('names a migration that does not set a version, instead of assuming it advanced', () => {
    migrations[0] = (raw) => ({ ...raw, migrated: true });
    try {
      expect(() => migrate({})).toThrow(/migration from version 0/);
    } finally {
      delete migrations[0];
    }
  });

  // The cycle walk blamed `start`, but `start` is only in the cycle when the walk began inside it.
  // On a healthy 3-chain hanging off a 2-cycle that flattened the user's whole hierarchy and named
  // three folders that were never in a cycle.
  const cycleGraph = () => [
    { id: 'f5', name: 'Five', parentId: 'f4', sortKey: 4, collapsed: false },
    { id: 'f4', name: 'Four', parentId: 'f3', sortKey: 3, collapsed: false },
    { id: 'f3', name: 'Three', parentId: 'f1', sortKey: 2, collapsed: false },
    { id: 'f1', name: 'One', parentId: 'f2', sortKey: 0, collapsed: false },
    { id: 'f2', name: 'Two', parentId: 'f1', sortKey: 1, collapsed: false },
  ];
  const repairOf = (folders: unknown[], problems: string[]) => {
    const ws = parseWorkspace(JSON.stringify({ ...emptyWorkspace(), folders }), problems);
    return Object.fromEntries(ws.folders.map((f) => [f.id, f.parentId]));
  };

  it('blames only a folder actually in the cycle and leaves the chain hanging off it intact', () => {
    const problems: string[] = [];
    expect(repairOf(cycleGraph(), problems)).toEqual({ f5: 'f4', f4: 'f3', f3: 'f1', f1: null, f2: 'f1' });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('f1');
  });

  it('repairs the same cycle identically regardless of folder array order', () => {
    const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [3, 4, 0, 2, 1], [1, 3, 0, 4, 2], [2, 0, 4, 1, 3]];
    const results = orders.map((order) => {
      const problems: string[] = [];
      const parents = repairOf(order.map((i) => cycleGraph()[i]!), problems);
      return { parents, problems };
    });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  // A throw inside the debounce timer escapes as an uncaught exception; in Electron main that is an
  // app crash with no dialog. `flush()` must not throw either — a `before-quit` flush on a full disk
  // would then crash the app on quit.
  it.skipIf(root)('survives a failed write, logs it, reports it, and still persists on a later retry', async () => {
    const { dir, file, bak } = newStore('store-write-fail');
    const log: string[] = [];
    const store = createWorkspaceStore({ file, bakFile: bak, debounceMs: 10, log: (l) => log.push(l) });
    store.load();
    chmodSync(dir, 0o500); // r-x: the .tmp file can no longer be created
    try {
      store.update((ws) => createFolder(ws, { id: 'f1', name: 'A', parentId: null }));
      await sleep(40); // the debounced write fires here and must not escape the timer
      expect(log.join(' ')).toMatch(/EACCES|EROFS/);
      expect(store.flush()).toBe(false);
      expect(store.lastWriteError()).not.toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }
    store.update((ws) => createFolder(ws, { id: 'f2', name: 'B', parentId: null }));
    expect(store.flush()).toBe(true);
    expect(store.lastWriteError()).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8')).folders.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2']);
  });
});

// Round two: the boundaries above are only safe if the .bak side is held to the same rule, if the
// caller is told when a write did not happen, and if the graph the repair walks is the one on disk.
describe('createWorkspaceStore last-good-copy safety', () => {
  const root = process.getuid?.() === 0;

  function newStore(prefix: string, extra: { now?: () => Date } = {}) {
    const dir = tempDir(prefix);
    const file = join(dir, 'workspace.json');
    const bak = join(dir, 'workspace.json.bak');
    return { dir, file, bak, store: createWorkspaceStore({ file, bakFile: bak, debounceMs: 20, ...extra }) };
  }
  const precious = JSON.stringify({ ...emptyWorkspace(), folders: [{ id: 'p', name: 'PRECIOUS', parentId: null, sortKey: 0, collapsed: false }] });

  // The dangerous pair is corrupt main + UNREADABLE .bak: the .bak is then the only healthy copy,
  // and starting empty does not merely ignore it — the empty file parses cleanly next boot and
  // `atomicWriteJson` copies it over the .bak, so one clean-looking boot later the profile is gone.
  it.skipIf(root)('refuses to start empty when the .bak — the only healthy copy — cannot be read', () => {
    const { dir, file, bak } = newStore('store-bak-unreadable');
    writeFileSync(bak, precious);
    writeFileSync(file, '{ truncated');
    const store = createWorkspaceStore({ file, bakFile: bak, debounceMs: 20 });
    chmodSync(bak, 0o000);
    try {
      expect(() => store.load()).toThrow(WorkspaceUnreadableError);
      expect(readdirSync(dir).sort()).toEqual(['workspace.json', 'workspace.json.bak']); // not moved, not written
      expect(readFileSync(file, 'utf8')).toBe('{ truncated');
    } finally {
      chmodSync(bak, 0o600);
    }
    // …and once the transient condition clears, the next boot gets the profile back.
    const r = createWorkspaceStore({ file, bakFile: bak, debounceMs: 20 }).load();
    expect(r.recovered).toBe('bak');
    expect(JSON.parse(readFileSync(file, 'utf8')).folders[0].name).toBe('PRECIOUS');
  });

  // `write()` stopped throwing, so a discarded return value is a load that reports success while
  // nothing reached the disk — and `problems` is exactly the array the §6.4 banner reads.
  it('reports a write that failed during load instead of claiming a clean load', () => {
    const { file, bak, store } = newStore('store-bak-isdir');
    writeFileSync(file, precious);
    mkdirSync(bak); // a directory where the .bak belongs: every future write fails at the copy step
    const r = store.load();
    expect(r.recovered).toBe('none');
    expect(r.problems.join(' ')).toMatch(/could not be saved/);
    expect(store.lastWriteError()?.message).toMatch(/EISDIR/);
  });

  it('reports a fresh start that could not be persisted', () => {
    const dir = tempDir('store-nodir');
    const missing = join(dir, 'gone');
    const store = createWorkspaceStore({ file: join(missing, 'workspace.json'), bakFile: join(missing, 'workspace.json.bak'), debounceMs: 20 });
    const r = store.load();
    expect(r.recovered).toBe('fresh');
    expect(r.problems.join(' ')).toMatch(/could not be saved/);
    expect(existsSync(missing)).toBe(false);
  });

  // Moving the corrupt file aside is itself an I/O operation that can fail, and continuing would
  // overwrite the only copy of the damaged file the user might still recover data from.
  it.skipIf(root)('fails loudly, and keeps the corrupt file, when it cannot be moved aside', () => {
    const { dir, file, bak, store } = newStore('store-readonly-dir');
    writeFileSync(file, '{ truncated');
    writeFileSync(bak, precious);
    chmodSync(dir, 0o500);
    try {
      expect(() => store.load()).toThrow(WorkspaceMoveAsideError);
      expect(readFileSync(file, 'utf8')).toBe('{ truncated');
      expect(readdirSync(dir).sort()).toEqual(['workspace.json', 'workspace.json.bak']);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('never clobbers an existing .corrupt- file when two moves land in the same millisecond', () => {
    const frozen = () => new Date('2026-09-07T12:00:00.000Z');
    const { dir, file } = newStore('store-corrupt-collision', { now: frozen });
    for (const body of ['{ one', '{ two']) {
      writeFileSync(file, body);
      createWorkspaceStore({ file, bakFile: join(dir, 'workspace.json.bak'), debounceMs: 20, now: frozen }).load();
    }
    const corrupt = readdirSync(dir).filter((f) => f.startsWith('workspace.json.corrupt-')).sort();
    expect(corrupt.length).toBe(2);
    expect(corrupt.map((f) => readFileSync(join(dir, f), 'utf8')).sort()).toEqual(['{ one', '{ two']);
  });

  // Ids are not unique per the schema, and every lookup here is a Map keyed by id — which keeps the
  // LAST entry, so the cycle detector walked a graph that was not the one on disk. Reported nothing,
  // and left `siblings()` looping forever. Hand-edited files and sync-conflict merges look like this.
  const dupGraph = () => [
    { id: 'a', name: 'A-first', parentId: 'b', sortKey: 0, collapsed: false },
    { id: 'b', name: 'B', parentId: 'a', sortKey: 1, collapsed: false },
    { id: 'a', name: 'A-second', parentId: null, sortKey: 2, collapsed: false },
  ];

  it('drops duplicate folder ids before repairing, leaving a graph that terminates', () => {
    const problems: string[] = [];
    const ws = parseWorkspace(JSON.stringify({ ...emptyWorkspace(), folders: dupGraph() }), problems);
    expect(ws.folders.map((f) => f.id)).toEqual(['a', 'b']);
    expect(ws.folders.map((f) => f.parentId)).toEqual([null, 'a']); // the a⇄b cycle is cut at the lower id
    expect(problems.length).toBe(2);
    expect(problems.join(' ')).toMatch(/repeated the id a/);
    // The walk `siblings()` performs must terminate, which it did not before the dedupe.
    const seen = new Set<string>();
    const walk = (parentId: string | null): void => {
      for (const c of siblings(ws, parentId)) {
        if (c.kind !== 'folder' || seen.has(c.folder.id)) continue;
        seen.add(c.folder.id);
        walk(c.folder.id);
      }
    };
    walk(null);
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it('drops the same duplicate regardless of folder array order', () => {
    const results = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]].map((order) => {
      const problems: string[] = [];
      const ws = parseWorkspace(JSON.stringify({ ...emptyWorkspace(), folders: order.map((i) => dupGraph()[i]!) }), problems);
      return { folders: ws.folders.map((f) => `${f.id}:${f.name}:${String(f.parentId)}`).sort(), problems };
    });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  // Repair lines go straight into the §6.4 banner, so their order is user-visible; the order they
  // are DISCOVERED in is just the order the folders happen to sit in the file.
  it('emits repair problems in a stable order whatever the array order', () => {
    const folders = [
      { id: 'zeta', name: 'Zeta', parentId: 'ghost-z', sortKey: 0, collapsed: false },
      { id: 'alpha', name: 'Alpha', parentId: 'ghost-a', sortKey: 1, collapsed: false },
    ];
    const repair = (fs: unknown[]) => {
      const problems: string[] = [];
      parseWorkspace(JSON.stringify({ ...emptyWorkspace(), folders: fs }), problems);
      return problems;
    };
    expect(repair(folders).length).toBe(2);
    expect(repair(folders)).toEqual(repair([...folders].reverse()));
  });

  const agent = (id: string, folderId: string | null): Agent => ({
    id, name: id, slug: id, folderId, sortKey: 0, notes: '', createdAt: '2026-09-07T00:00:00.000Z', lastOpenedAt: null,
    workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${id}`, worktreePath: `/wt/${id}`, baseRef: 'origin/main', createdAt: 'x' }],
    claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  });

  // repairTree's other half: an agent in a folder that does not exist is invisible in the sidebar and
  // unreachable, exactly like an orphaned folder — and it was the untested half.
  it('re-parents an agent whose folder is missing, and drops duplicate agent ids', () => {
    const problems: string[] = [];
    const ws = repairTree({ ...emptyWorkspace(), agents: [agent('a1', 'ghost'), agent('a1', null), agent('a2', null)] }, problems);
    expect(ws.agents.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(ws.agents[0]!.folderId).toBeNull();
    expect(problems.join(' ')).toMatch(/repeated the id a1/);
  });

  // The debounce is anchored to the first pending change: resetting it on every update would let a
  // steady stream of edits (a drag, a rename) postpone the save indefinitely.
  it('anchors the debounce to the first pending change rather than restarting it on every update', async () => {
    const dir = tempDir('store-debounce');
    const file = join(dir, 'workspace.json');
    const store = createWorkspaceStore({ file, bakFile: join(dir, 'workspace.json.bak'), debounceMs: 100 });
    store.load();
    store.update((ws) => createFolder(ws, { id: 'f1', name: 'A', parentId: null }));
    await sleep(50);
    store.update((ws) => createFolder(ws, { id: 'f2', name: 'B', parentId: null }));
    await sleep(75); // t=125: past the anchored deadline of 100, short of a restarted one at 150
    expect(JSON.parse(readFileSync(file, 'utf8')).folders.length).toBe(2);
  });

  it('keeps notifying the other subscribers when one throws, and stops on unsubscribe', () => {
    const dir = tempDir('store-subscribers');
    const log: string[] = [];
    const seen: string[] = [];
    const store = createWorkspaceStore({ file: join(dir, 'workspace.json'), bakFile: join(dir, 'workspace.json.bak'), debounceMs: 20, log: (l) => log.push(l) });
    store.load();
    store.subscribe(() => { throw new Error('subscriber blew up'); });
    const off = store.subscribe((ws) => seen.push(`n=${ws.folders.length}`));
    expect(() => store.update((ws) => createFolder(ws, { id: 'f1', name: 'A', parentId: null }))).not.toThrow();
    expect(seen).toEqual(['n=1']); // the thrower is registered first: the second must still be called
    expect(log.join(' ')).toMatch(/subscriber threw.*subscriber blew up/s);
    off();
    store.update((ws) => createFolder(ws, { id: 'f2', name: 'B', parentId: null }));
    expect(seen).toEqual(['n=1']); // the disposer must actually remove the listener
  });

  // A failed write leaves the change pending with nothing scheduled to retry it, so the last edit
  // before a force-quit on a momentarily-full disk was lost even though the disk had recovered.
  it.skipIf(root)('retries a failed write on its own, without waiting for another edit', async () => {
    const dir = tempDir('store-retry');
    const file = join(dir, 'workspace.json');
    const log: string[] = [];
    const store = createWorkspaceStore({ file, bakFile: join(dir, 'workspace.json.bak'), debounceMs: 10, log: (l) => log.push(l) });
    store.load();
    chmodSync(dir, 0o500);
    try {
      store.update((ws) => createFolder(ws, { id: 'f1', name: 'A', parentId: null }));
      await sleep(40);
      expect(log.length).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
    await sleep(150); // the retry (debounceMs * 10) fires here; nothing else touches the store
    expect(JSON.parse(readFileSync(file, 'utf8')).folders.length).toBe(1);
    expect(store.lastWriteError()).toBeNull();
  });

  it('describeParseFailure keeps banner lines short and survives a non-Error throw', () => {
    const many = describeParseFailure(WorkspaceFileSchema.safeParse({ version: 1 }).error);
    expect(many).toContain('projects: ');
    expect(many).toMatch(/; and \d+ more$/);
    expect(describeParseFailure('a string, not an Error')).toBe('a string, not an Error');
    expect(describeParseFailure(new Error('line one\nline two'))).toBe('line one');
  });
});
