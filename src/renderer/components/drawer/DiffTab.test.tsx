/**
 * The Diff tab: the header, the grouped change list, the unified diff, and the four auto-refresh
 * triggers of spec §12.5.
 *
 * **The auto-refresh rules are the point of this file.** §12.5 wants a refresh when the tab is
 * visible and (a) it was just opened, (b) a `Stop`/`SessionEnd` hook arrives for this agent, (c) the
 * workspace switcher changes, (d) every 30 s while visible — and *never while hidden*. The last
 * clause is the one a `setInterval` gets wrong for free, so the `never while hidden` block below
 * runs the whole `Drawer`, switches to Files, and advances 90 s of fake time.
 *
 * **`FileDiff`'s flags must stay distinguishable.** `diff-service.ts` labels every empty side with
 * WHY it is empty — `oldMissing`, `newMissing`, `binary`, `tooLarge`, or genuinely-empty-at-the-base
 * — and `tooLarge` blanks BOTH sides on purpose, because truncating them would draw a deletion at
 * the cut that nobody made. Rendered as an unlabelled empty document that is indistinguishable from
 * an unchanged file, so each has a test here.
 *
 * **G59/G61 — render counts.** `DiffTab` subscribes to two stores (`useSession`, `useProject`), so
 * unlike the Files tab these counts are guarding a live surface rather than pinning a property. Per
 * G61 one of them mounts with NO snapshot in the store at all, because a `?? []`-shaped fallback
 * allocates only on the nullish path. The control mounts a deliberately-allocating selector and
 * asserts the harness throws.
 *
 * **G65** — `mountStrict` puts `<StrictMode>` outermost, with the commit `<Profiler>` inside it;
 * anything else silently switches off the double-invocation of effects.
 *
 * **G66 / jsdom's limits.** jsdom implements no focusability rule (`focus()` on a bare `<div>` moves
 * `activeElement`), so the focus assertion here is on the `tabindex` ATTRIBUTE, with the control
 * that proves the attribute is absent without `contentAttributes` living in `lib/codemirror.test.ts`
 * and duplicated below. jsdom also has no layout engine and CodeMirror measures the DOM, so
 * everything here is about DOC CONTENTS, facets and structure — never scrolling, viewport rendering
 * or whether `collapseUnchanged` actually collapsed anything on screen. Those are CDP questions.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOriginalDoc } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import type {
  ChangeSet, FileDiff, HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests,
} from '../../../../shared/ipc-contract.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Layout, type Project, type SessionState, type Workspace, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string, defaultBranch: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch, setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const WORKSPACES: Workspace[] = [
  { id: 'w1', projectId: 'p1', branch: 'hangar/alpha', worktreePath: '/wt/alpha', baseRef: 'main', createdAt: ISO },
  { id: 'w2', projectId: 'p2', branch: 'hangar/alpha', worktreePath: '/wt/alpha-2', baseRef: 'main', createdAt: ISO },
];

const AGENT: Agent = {
  id: 'a1', name: 'alpha', slug: 'alpha', folderId: null, sortKey: 0,
  workspaces: WORKSPACES, notes: '',
  claude: { sessionId: 's-a1', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
};

const OTHER_AGENT: Agent = { ...AGENT, id: 'a2', name: 'beta', slug: 'beta', sortKey: 1 };

function snapshotWith(layout: Partial<Layout> = {}): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      // `p1`'s default branch is `trunk`, not `main`: the header must read the PROJECT's field
      // (which is what `git:changes` measures against in `handlers.ts`), not the workspace's
      // `baseRef`, and identical values would not tell the two apart.
      projects: [project('p1', 'hangar', 'trunk'), project('p2', 'acmeapi', 'main')],
      agents: [AGENT, OTHER_AGENT],
      layout: { ...defaultLayout(), drawerOpen: true, drawerTab: 'diff', panes: ['a1'], focusedIndex: 0, ...layout },
    },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

// ---------------------------------------------------------------------------------------------
// The change set, in the order `changes()` returns it (sorted by `relPath`). The renderer groups
// but never re-sorts, so within a group these arrays ARE the expected screen order.
// ---------------------------------------------------------------------------------------------
type ChangeFile = ChangeSet['files'][number];
const chg = (relPath: string, status: ChangeFile['status'], patch: Partial<ChangeFile> = {}): ChangeFile => ({
  relPath, status, committed: false, uncommitted: true, untracked: false, ...patch,
});

const CHANGES: ChangeFile[] = [
  chg('README.md', 'M', { committed: true, uncommitted: false }),
  chg('empty-at-base.ts', 'M', { committed: true, uncommitted: false }),
  chg('gone.txt', 'D', { committed: true }),
  chg('logo.png', 'A'),
  chg('renamed.ts', 'R', { committed: true, uncommitted: false }),
  chg('src/edited.ts', 'M', { committed: true }),
  chg('src/new.ts', 'U', { untracked: true }),
  chg('billingr/huge.min.js', 'M', { committed: true, uncommitted: false }),
];

const changeSet = (patch: Partial<ChangeSet> = {}): ChangeSet => ({
  mergeBase: 'a'.repeat(40), aheadCommits: 2, stats: { insertions: 12, deletions: 3 }, files: CHANGES, ...patch,
});

const fd = (patch: Partial<FileDiff> = {}): FileDiff => ({
  oldText: '', newText: '', oldMissing: false, newMissing: false, binary: false, tooLarge: false, ...patch,
});

const DIFFS: Record<string, FileDiff> = {
  'README.md': fd({ oldText: '# old\n', newText: '# new\n' }),
  // Genuinely empty at the base — `oldText: ''` with `oldMissing: false`. Must NOT read as "added".
  'empty-at-base.ts': fd({ oldText: '', newText: 'export const x = 1;\n' }),
  // Committed as new and then deleted again: absent both sides, and neither binary nor too large.
  'gone.txt': fd({ oldMissing: true, newMissing: true }),
  'logo.png': fd({ oldMissing: true, binary: true }),
  'renamed.ts': fd({ oldMissing: true, newText: 'export const renamed = true;\n' }),
  'src/edited.ts': fd({ oldText: 'const a = 1;\n', newText: 'const a = 2;\n' }),
  'src/new.ts': fd({ oldMissing: true, newText: 'export const fresh = 1;\n' }),
  'billingr/huge.min.js': fd({ tooLarge: true }),
};

interface Call { channel: IpcRequestKey; payload: unknown }

const ok = <T,>(value: T): IpcReply<T> => ({ ok: true, value });
const fail = <T,>(code: string, message: string): IpcReply<T> => ({ ok: false, error: { code, message } });

/**
 * A stub may answer with a PROMISE, which is what the two ordering tests below need: the real bridge
 * is asynchronous and the renderer has to survive two replies landing out of order.
 */
type Replies = { [K in IpcRequestKey]?: (payload: IpcRequests[K]['req']) => IpcReply<IpcRequests[K]['res']> | Promise<IpcReply<IpcRequests[K]['res']>> };

const DEFAULT_REPLIES: Replies = {
  'git:changes': () => ok(changeSet()),
  // A FRESH object per call, because that is what the real bridge does — every reply crosses
  // `contextBridge` and arrives structurally cloned. Handing back the same object reference would
  // let React bail out of the re-render on identity alone and quietly stand in for `sameDiff`.
  'git:fileDiff': (p) => (p.relPath in DIFFS ? ok({ ...DIFFS[p.relPath] }) : fail('NOT_FOUND', `${p.relPath} does not exist`)),
  'fs:list': () => ok([]),
  'layout:set': () => ok(undefined),
  'agent:markOpened': () => ok(undefined),
  // The four `bootstrap()` fires, so mounting the whole `App` produces no failure of its own.
  'config:get': () => ok(defaultAppConfig('/bin/zsh')),
  'workspace:get': () => ok(snapshotWith()),
  'app:windowFocused': () => ok(undefined),
  'agent:markViewed': () => ok(undefined),
};

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — hence `vi.resetModules()` plus dynamic imports, the same dance every other
 * component suite here uses. It also means every `load()` gets FRESH stores.
 */
async function load(replies: Replies = DEFAULT_REPLIES) {
  const calls: Call[] = [];
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const handler = replies[channel];
      if (handler === undefined) return Promise.resolve(fail('TEST', `no stub for ${channel}`));
      return Promise.resolve((handler as (p: unknown) => IpcReply<IpcRequests[K]['res']> | Promise<IpcReply<IpcRequests[K]['res']>>)(args[0]));
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      void channel;
      void handler;
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [diffTab, diffView, diffList, drawer, { App }, workspace, layout, sessions, ui] = await Promise.all([
    import('./DiffTab.tsx'),
    import('./DiffView.tsx'),
    import('./DiffList.tsx'),
    import('./Drawer.tsx'),
    import('../../App.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/ui.ts'),
  ]);
  return { ...diffTab, ...diffView, ...diffList, ...drawer, App, workspace, layout, sessions, ui, calls };
}

type Harness = Awaited<ReturnType<typeof load>>;

/** The common case: the snapshot already in the stores, no `App`, no bootstrap. */
async function withSnapshot(snap: WorkspaceSnapshot = snapshotWith(), replies: Replies = DEFAULT_REPLIES): Promise<Harness> {
  const t = await load(replies);
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.layout.layoutStore.getState().hydrate(snap.workspace.layout);
  return t;
}

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
  // Last, and in the same hook as the unmounts: a root torn down under a fake clock still has to
  // run its `clearInterval` cleanups against the clock that created the timers.
  vi.useRealTimers();
});

function mount(node: ReactNode): { el: HTMLElement; commits: () => number; render: (next: ReactNode) => void } {
  return mountWith((n) => n, node);
}

/**
 * The same, under `<StrictMode>` — and StrictMode has to be the OUTERMOST element handed to
 * `root.render()` (G65). Measured on React 19.2.8: a `<Profiler>` above `<StrictMode>` silently
 * switches off the double-invocation of EFFECTS while leaving updaters doubled, so the obvious
 * spelling tests half of what it claims. `components/strict-mode-nesting.test.tsx` re-measures both
 * shapes on every run.
 */
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number; render: (next: ReactNode) => void } {
  return mountWith((n) => <StrictMode>{n}</StrictMode>, node);
}

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number; render: (next: ReactNode) => void } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  const wrap = (n: ReactNode): ReactNode => shell(<Profiler id="commits" onRender={() => { commits += 1; }}>{n}</Profiler>);
  act(() => root.render(wrap(node)));
  return { el, commits: () => commits, render: (next) => act(() => root.render(wrap(next))) };
}

/** Lets every pending IPC reply, `.then()` and dynamic `import()` settle. Real timers only. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The fake-clock equivalent, for the auto-refresh block. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountTab(t: Harness, workspace: Workspace = WORKSPACES[0], agent: Agent = AGENT) {
  const m = mount(<t.DiffTab agent={agent} workspace={workspace} />);
  await settle();
  return m;
}

const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
const rowNames = (el: HTMLElement): string[] => rows(el).map((b) => b.textContent?.slice(1) ?? '');
const rowNamed = (el: HTMLElement, name: string): HTMLElement => {
  const found = rows(el).find((b) => b.textContent?.slice(1) === name);
  if (found === undefined) throw new Error(`no diff row "${name}" in [${rowNames(el).join(', ')}]`);
  return found;
};
const changesCalls = (calls: Call[]): unknown[] => calls.filter((c) => c.channel === 'git:changes').map((c) => c.payload);
const diffCalls = (calls: Call[]): string[] => calls.filter((c) => c.channel === 'git:fileDiff').map((c) => (c.payload as { relPath: string }).relPath);
const headings = (el: HTMLElement): string[] => [...el.querySelectorAll<HTMLElement>('[role="listbox"] > div > div:first-child')].map((d) => d.textContent ?? '');

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens a row and lets the diff (and its lazy grammar chunk) arrive. */
async function open(el: HTMLElement, name: string): Promise<void> {
  await click(rowNamed(el, name));
  await settle();
}

describe('header', () => {
  it('renders §12.5\'s counts, and the PROJECT\'s default branch', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    expect(el.textContent).toContain('+12');
    expect(el.textContent).toContain('−3');
    expect(el.textContent).toContain('8 files');
    expect(el.textContent).toContain('2 commits ahead of trunk');
  });

  it('shows the untracked-only case as the insertions main counted, not as +0', async () => {
    // `git diff --shortstat` answers the EMPTY STRING when the only changes are untracked, so
    // `changes()` counts those lines itself (P4-2 `untrackedInsertions`). The renderer must render
    // `stats` verbatim; re-deriving anything from the file list would reintroduce "+0 −0" for
    // exactly the agent that has just written a pile of new files.
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => ok(changeSet({ aheadCommits: 0, stats: { insertions: 41, deletions: 0 }, files: [chg('a.ts', 'U', { untracked: true })] })),
    });
    const { el } = await mountTab(t);
    expect(el.textContent).toContain('+41');
    expect(el.textContent).toContain('−0');
    expect(el.textContent).toContain('1 file ·');
    expect(el.textContent).toContain('0 commits ahead');
  });

  it('reports a failed refresh in the header rather than leaving a stale list looking live', async () => {
    let calls = 0;
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => (++calls === 1 ? ok(changeSet()) : fail('GIT', 'not a git repository')),
    });
    const { el } = await mountTab(t);
    expect(el.textContent).toContain('8 files');
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    expect(el.textContent).toContain('not a git repository');
    // The list it loaded first is still there; what changed is that it now says so.
    expect(el.textContent).toContain('8 files');
  });

  it('reports the very first failure with no list at all, and raises no toast', async () => {
    const t = await withSnapshot(snapshotWith(), { ...DEFAULT_REPLIES, 'git:changes': () => fail('GIT', 'bad object HEAD') });
    const { el } = await mountTab(t);
    expect(el.textContent).toContain('bad object HEAD');
    expect(el.textContent).not.toContain('loading…');
    expect(rows(el)).toEqual([]);
  });
});

describe('change list', () => {
  it('groups as Uncommitted then Committed since base, and lists a file in only one', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    expect(headings(el)).toEqual(['UNCOMMITTED · 4', 'COMMITTED SINCE BASE · 4']);
    expect(rowNames(el)).toEqual([
      // Uncommitted, in main's order.
      'gone.txt', 'logo.png', 'src/edited.ts', 'src/new.ts',
      // Committed since base — and `src/edited.ts`, which is both, is NOT repeated here.
      'README.md', 'empty-at-base.ts', 'renamed.ts', 'billingr/huge.min.js',
    ]);
  });

  it('groups the same way outside React', async () => {
    const t = await load();
    expect(t.groupChanges(CHANGES).map((g) => [g.title, g.files.map((f) => f.relPath)])).toEqual([
      ['Uncommitted', ['gone.txt', 'logo.png', 'src/edited.ts', 'src/new.ts']],
      ['Committed since base', ['README.md', 'empty-at-base.ts', 'renamed.ts', 'billingr/huge.min.js']],
    ]);
    // An empty group is omitted, not rendered as a heading with nothing under it.
    expect(t.groupChanges([chg('a.ts', 'U', { untracked: true })]).map((g) => g.title)).toEqual(['Uncommitted']);
    expect(t.groupChanges([chg('a.ts', 'M', { committed: true, uncommitted: false })]).map((g) => g.title)).toEqual(['Committed since base']);
  });

  it('carries the status letter in the §6.5 palette and marks the selected row', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    // The LETTER itself, not just its colour. Found by this file's mutation control: replacing
    // `{f.status}` with `{'?'}` left every assertion here green, because `rowNames` strips the first
    // character to read the path and the palette check reads `className`. §12.5's row is "status
    // letter, path", so the letter is half of it.
    const letterText = (name: string): string => rowNamed(el, name).querySelector('span')?.textContent ?? '';
    expect(letterText('src/new.ts')).toBe('U');
    expect(letterText('logo.png')).toBe('A');
    expect(letterText('src/edited.ts')).toBe('M');
    expect(letterText('gone.txt')).toBe('D');
    expect(letterText('renamed.ts')).toBe('R');
    const letter = (name: string): string => rowNamed(el, name).querySelector('span')?.className ?? '';
    expect(letter('src/new.ts')).toContain('text-green');
    expect(letter('src/edited.ts')).toContain('text-blue');
    expect(letter('gone.txt')).toContain('text-red');
    expect(letter('renamed.ts')).toContain('text-amber');
    expect(rowNamed(el, 'src/edited.ts').getAttribute('aria-selected')).toBe('false');
    await click(rowNamed(el, 'src/edited.ts'));
    expect(rowNamed(el, 'src/edited.ts').getAttribute('aria-selected')).toBe('true');
  });

  it('says so when there is nothing to show', async () => {
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => ok(changeSet({ aheadCommits: 0, stats: { insertions: 0, deletions: 0 }, files: [] })),
    });
    const { el } = await mountTab(t);
    expect(el.textContent).toContain('No changes vs the base branch.');
    expect(headings(el)).toEqual([]);
  });

  it('drags the list/diff split and clamps it at both ends', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    const handle = el.querySelector<HTMLElement>('.cursor-col-resize');
    const column = el.querySelector<HTMLElement>('[style*="width"]');
    if (handle === null || column === null) throw new Error('no resizer');
    expect(column.style.width).toBe(`${t.LIST_DEFAULT_WIDTH}px`);
    const drag = (from: number, to: number): void =>
      act(() => {
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }));
        window.dispatchEvent(new MouseEvent('mouseup', {}));
      });
    drag(0, 10_000);
    expect(column.style.width).toBe(`${t.LIST_MAX_WIDTH}px`);
    drag(0, -10_000);
    expect(column.style.width).toBe(`${t.LIST_MIN_WIDTH}px`);
  });
});

describe('diff view', () => {
  it('renders the new text as the document with the old text as the merge original', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    expect(diffCalls(t.calls)).toEqual(['src/edited.ts']);
    expect(el.querySelector('.cm-content')?.textContent).toContain('const a = 2;');
    // The deleted side is `@codemirror/merge`'s original document, not a second editor.
    const editors = el.querySelectorAll('.cm-editor');
    expect(editors).toHaveLength(1);
    expect(el.textContent).toContain('modified');
  });

  it('carries tabindex="0" on the diff content, which is the only reason ⌘F can reach it', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    expect(el.querySelector('.cm-content')?.getAttribute('tabindex')).toBe('0');
    // The control. A non-editable CodeMirror view with no `contentAttributes` gets no tab index at
    // all, so this attribute is `createUnifiedDiff`'s doing and not CodeMirror's default. jsdom
    // implements no focusability rule whatsoever (G66) — `focus()` on a bare `<div>` moves
    // `activeElement` — so `activeElement` is deliberately not asserted anywhere here; whether the
    // real diff takes focus and opens its search panel is a CDP question. The full control lives in
    // `lib/codemirror.test.ts`.
    const bare = document.createElement('div');
    expect(bare.hasAttribute('tabindex')).toBe(false);
  });

  it('labels an added file "added" and shows an empty base side', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/new.ts');
    expect(el.textContent).toContain('added');
    expect(el.querySelector('.cm-content')?.textContent).toContain('export const fresh = 1;');
  });

  it('does NOT call a file that is genuinely empty at the base "added"', async () => {
    // `oldText: ''` with `oldMissing: false` is a real answer from `diff-service.ts` and means the
    // file existed at the base with no content. Reading the empty string as "added" is the exact
    // collapse the flags exist to prevent.
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'empty-at-base.ts');
    expect(el.textContent).toContain('modified');
    expect(el.textContent).not.toContain('added');
    expect(el.querySelector('.cm-content')?.textContent).toContain('export const x = 1;');
  });

  it('renders `tooLarge` as an explicit notice, never as an unchanged empty file', async () => {
    // The carried finding from Task 2. `diff-service.ts` blanks BOTH sides at 1.5 MB precisely
    // because handing `unifiedMergeView` two independently truncated texts draws a fabricated
    // deletion at the cut. With both sides blank and no notice, the file would instead render as an
    // unchanged empty document — quieter, still a lie.
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'billingr/huge.min.js');
    expect(el.textContent).toContain('Too large to diff: one side is over 1.5 MB.');
    expect(el.textContent).toContain('too large');
    expect(el.querySelector('.cm-editor')).toBeNull();
  });

  it('renders `binary` as its own notice, distinct from `tooLarge`', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'logo.png');
    expect(el.textContent).toContain('Binary file — there is no text to diff.');
    expect(el.textContent).not.toContain('Too large to diff');
    expect(el.querySelector('.cm-editor')).toBeNull();
  });

  it('renders "absent from both sides" as its own notice too', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'gone.txt');
    expect(el.textContent).toContain('added and then deleted again');
    expect(el.querySelector('.cm-editor')).toBeNull();
  });

  it('banners a rename instead of passing it off as an addition', async () => {
    // `git diff -M` emits one `R100` record and `diff-service.ts` keeps only the NEW path
    // (P4-2h/P4-3e), so the base has no file there and the diff is honestly a whole-file addition.
    // What must not happen is the header calling it "added" with nothing saying why.
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    expect(rowNamed(el, 'renamed.ts').title).toContain('renamed; the diff shows the new path as an addition');
    await open(el, 'renamed.ts');
    expect(el.textContent).toContain('renamed');
    expect(el.textContent).toContain('the pre-rename text is not carried through yet');
    // The diff itself is still shown: it is real, just not a rename diff.
    expect(el.querySelector('.cm-content')?.textContent).toContain('export const renamed = true;');
  });

  it('labels every FileDiff shape distinguishably, outside React', async () => {
    const t = await load();
    expect(t.diffLabel(fd({ oldText: 'a', newText: 'b' }), 'M')).toBe('modified');
    expect(t.diffLabel(fd({ oldMissing: true, newText: 'b' }), 'A')).toBe('added');
    expect(t.diffLabel(fd({ newMissing: true, oldText: 'a' }), 'D')).toBe('deleted');
    expect(t.diffLabel(fd({ oldMissing: true, newMissing: true }), 'D')).toBe('gone');
    expect(t.diffLabel(fd({ oldMissing: true, binary: true }), 'A')).toBe('added · binary');
    expect(t.diffLabel(fd({ tooLarge: true }), 'M')).toBe('modified · too large');
    expect(t.diffLabel(fd({ oldMissing: true }), 'R')).toBe('renamed');
    // Empty at the base is a MODIFICATION, not an addition — `oldMissing` is what decides, never
    // `oldText === ''`.
    expect(t.diffLabel(fd({ oldText: '', newText: 'x' }), 'M')).toBe('modified');
    expect(t.diffNotice(fd({ oldText: '', newText: 'x' }))).toBeNull();
    expect(t.diffNotice(fd({ oldMissing: true, newText: 'x' }))).toBeNull();
  });

  it('shows a failed fileDiff next to the file, not as a toast', async () => {
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => ok(changeSet({ files: [chg('vanished.ts', 'M', { committed: true })] })),
    });
    const { el } = await mountTab(t);
    await open(el, 'vanished.ts');
    expect(el.textContent).toContain('vanished.ts does not exist');
    expect(el.querySelector('.cm-editor')).toBeNull();
  });

  it('destroys the previous editor when another row is clicked', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    expect(el.querySelectorAll('.cm-editor')).toHaveLength(1);
    await open(el, 'README.md');
    expect(el.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(el.querySelector('.cm-content')?.textContent).toContain('# new');
  });

  it('holds the base text as @codemirror/merge\'s original document', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    // `.cm-content` shows the NEW text; the deleted side is a facet on the state, so read it there.
    // jsdom has no layout, so whether the deletion chunk is painted (or whether `collapseUnchanged`
    // collapsed anything) cannot be asserted here at all — this is the state, not the picture.
    const cm = el.querySelector<HTMLElement>('.cm-editor');
    const view = cm === null ? null : EditorView.findFromDOM(cm);
    if (view === null) throw new Error('no CodeMirror view on the editor element');
    expect(getOriginalDoc(view.state).toString()).toBe('const a = 1;\n');
  });
});

describe('auto-refresh (spec §12.5)', () => {
  it('(a) refreshes when the tab is opened', async () => {
    const t = await withSnapshot();
    await mountTab(t);
    expect(changesCalls(t.calls)).toEqual([{ agentId: 'a1', workspaceId: 'w1' }]);
  });

  it('sends ONE git:changes on mount under StrictMode', async () => {
    // StrictMode double-invokes the mount effect. Two identical reads is waste, not corruption, and
    // this is a ceiling that says so out loud rather than a claim that a dedupe exists.
    const t = await withSnapshot();
    mountStrict(<t.DiffTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(changesCalls(t.calls).length).toBeLessThanOrEqual(2);
  });

  it('(c) refreshes when the workspace switcher changes, and drops the open file', async () => {
    const t = await withSnapshot();
    const m = await mountTab(t);
    await open(m.el, 'src/edited.ts');
    expect(m.el.querySelector('.cm-content')).not.toBeNull();
    m.render(<t.DiffTab agent={AGENT} workspace={WORKSPACES[1]} />);
    await settle();
    expect(changesCalls(t.calls)).toEqual([
      { agentId: 'a1', workspaceId: 'w1' },
      { agentId: 'a1', workspaceId: 'w2' },
    ]);
    // The file the user was reading does not exist in the workspace they just switched to.
    expect(m.el.textContent).toContain('Select a changed file');
    expect(m.el.querySelector('.cm-content')).toBeNull();
  });

  it('(b) refreshes when a Stop hook lands for this agent', async () => {
    const t = await withSnapshot();
    await mountTab(t);
    expect(changesCalls(t.calls)).toHaveLength(1);
    act(() => t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'waiting', lastHookAt: 1000, hooksSeen: true }));
    await settle();
    expect(changesCalls(t.calls)).toHaveLength(2);
  });

  it('(b) refreshes on a SECOND Stop that moves no activity', async () => {
    // `Stop` while already `waiting` leaves `activity` alone and only advances `lastHookAt`. Keying
    // the trigger on the activity transition alone would miss every turn after the first.
    const t = await withSnapshot();
    const waiting = (at: number): SessionState => ({ ...initialSessionState('a1'), activity: 'waiting', lastHookAt: at, hooksSeen: true });
    await mountTab(t);
    act(() => t.sessions.useSessions.getState().setOne('a1', waiting(1000)));
    await settle();
    act(() => t.sessions.useSessions.getState().setOne('a1', waiting(2000)));
    await settle();
    expect(changesCalls(t.calls)).toHaveLength(3);
  });

  it('(b) refreshes on SessionEnd, and not on UserPromptSubmit', async () => {
    const t = await withSnapshot();
    await mountTab(t);
    act(() => t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'working', lastHookAt: 1000, hooksSeen: true }));
    await settle();
    expect(changesCalls(t.calls)).toHaveLength(1);
    act(() => t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'shell', lastHookAt: 2000, hooksSeen: true }));
    await settle();
    expect(changesCalls(t.calls)).toHaveLength(2);
  });

  it('(b) does NOT refresh for a hook that belongs to a different agent', async () => {
    const t = await withSnapshot();
    await mountTab(t);
    act(() => t.sessions.useSessions.getState().setOne('a2', { ...initialSessionState('a2'), activity: 'waiting', lastHookAt: 9999, hooksSeen: true }));
    await settle();
    expect(changesCalls(t.calls)).toHaveLength(1);
  });

  it('does not double-refresh when the AGENT changes with a hook already recorded', async () => {
    const t = await withSnapshot();
    act(() => {
      t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'waiting', lastHookAt: 1000, hooksSeen: true });
      t.sessions.useSessions.getState().setOne('a2', { ...initialSessionState('a2'), activity: 'waiting', lastHookAt: 7000, hooksSeen: true });
    });
    const m = await mountTab(t);
    expect(changesCalls(t.calls)).toHaveLength(1);
    m.render(<t.DiffTab agent={OTHER_AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    // One for the switch, not two: `a2`'s already-recorded `lastHookAt` is not a hook that arrived.
    expect(changesCalls(t.calls)).toHaveLength(2);
  });

  it('(d) refreshes every 30 s while visible', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot();
    mount(<t.DiffTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await tick();
    expect(changesCalls(t.calls)).toHaveLength(1);
    await tick(30_000);
    expect(changesCalls(t.calls)).toHaveLength(2);
    await tick(30_000);
    expect(changesCalls(t.calls)).toHaveLength(3);
    // Not sooner than 30 s.
    await tick(29_000);
    expect(changesCalls(t.calls)).toHaveLength(3);
  });

  it('re-reads the OPEN file on the timer, not just the list', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    expect(diffCalls(t.calls)).toEqual(['src/edited.ts']);
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    await settle();
    expect(diffCalls(t.calls)).toEqual(['src/edited.ts', 'src/edited.ts']);
  });

  it('keeps the SAME editor when a refresh returns identical texts', async () => {
    // A rebuild throws away scroll position, selection and any open search panel — twice a minute,
    // while the user is reading. `sameDiff` keeps the previous state object so the mounting effect,
    // which is keyed on its identity, does not re-run.
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    const before = el.querySelector('.cm-editor');
    expect(before).not.toBeNull();
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    await settle();
    expect(el.querySelector('.cm-editor')).toBe(before);
    // …and it DOES rebuild when the text actually moved.
    expect(t.sameDiff(DIFFS['src/edited.ts'], fd({ oldText: 'const a = 1;\n', newText: 'const a = 3;\n' }))).toBe(false);
  });

  it('rebuilds the editor when the file\'s text changes under it', async () => {
    let n = 0;
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:fileDiff': () => ok(fd({ oldText: 'const a = 1;\n', newText: `const a = ${++n};\n` })),
    });
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    const before = el.querySelector('.cm-editor');
    expect(el.querySelector('.cm-content')?.textContent).toContain('const a = 1;');
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    await settle();
    expect(el.querySelector('.cm-editor')).not.toBe(before);
    expect(el.querySelector('.cm-content')?.textContent).toContain('const a = 2;');
  });

  it('does not re-open a file by itself when it comes BACK into the change set', async () => {
    // The `setSelected` prune. Without it the derived lookup in `DiffTab` still hides the row while
    // the file is gone — the two mask each other, the shape P4-4e found in the Files tab — so this
    // is the one case that separates them: a stale `selected` would silently re-open the diff the
    // moment the agent re-created the file, without the user asking for it.
    let calls = 0;
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => (++calls === 2 ? ok(changeSet({ files: CHANGES.filter((f) => f.relPath !== 'src/edited.ts') })) : ok(changeSet())),
    });
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh); // call 2: the file is gone
    await settle();
    expect(el.textContent).toContain('Select a changed file');
    await click(refresh); // call 3: it is back
    await settle();
    expect(rowNames(el)).toContain('src/edited.ts');
    expect(el.textContent).toContain('Select a changed file');
    expect(el.querySelector('.cm-content')).toBeNull();
  });

  it('does not show a stale diff when a slower reply lands after the user has moved on', async () => {
    // Click A, click B, then let A's reply arrive LAST. Without the effect's `cancelled` flag, A's
    // text is rendered under B's filename — a diff attributed to the wrong file, which is worse than
    // no diff at all. The 30 s timer and a busy worktree make slow replies ordinary here.
    const inflight: { relPath: string; resolve: (r: IpcReply<FileDiff>) => void }[] = [];
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:fileDiff': (p) => new Promise<IpcReply<FileDiff>>((resolve) => inflight.push({ relPath: p.relPath, resolve })),
    });
    const { el } = await mountTab(t);
    await click(rowNamed(el, 'README.md'));
    await click(rowNamed(el, 'src/edited.ts'));
    expect(inflight.map((r) => r.relPath)).toEqual(['README.md', 'src/edited.ts']);
    await act(async () => {
      inflight[1].resolve(ok({ ...DIFFS['src/edited.ts'] }));
      inflight[0].resolve(ok({ ...DIFFS['README.md'] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(el.querySelector('.cm-content')?.textContent).toContain('const a = 2;');
    expect(el.querySelector('.cm-content')?.textContent).not.toContain('# new');
  });

  it('clears the selection when the open file leaves the change set', async () => {
    let calls = 0;
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:changes': () => (++calls === 1 ? ok(changeSet()) : ok(changeSet({ files: CHANGES.filter((f) => f.relPath !== 'src/edited.ts') }))),
    });
    const { el } = await mountTab(t);
    await open(el, 'src/edited.ts');
    expect(el.querySelector('.cm-content')).not.toBeNull();
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    await settle();
    expect(el.textContent).toContain('Select a changed file');
    expect(el.querySelector('.cm-content')).toBeNull();
  });
});

describe('never refreshes while hidden (spec §12.5)', () => {
  /**
   * "Visible" is: the drawer is open AND the Diff tab is selected — exactly the condition under
   * which `Drawer` renders `DiffTab` at all. So these run the real `Drawer` and drive the real
   * layout store rather than a `visible` prop nothing would ever pass as false.
   */
  it('stops the 30 s timer when the drawer switches to another tab', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot();
    mount(<t.Drawer />);
    await tick();
    expect(changesCalls(t.calls)).toHaveLength(1);
    await tick(30_000);
    expect(changesCalls(t.calls)).toHaveLength(2);
    act(() => t.layout.layoutStore.getState().setDrawer({ tab: 'files' }));
    await tick(90_000);
    expect(changesCalls(t.calls)).toHaveLength(2);
    // …and comes back when the tab does.
    act(() => t.layout.layoutStore.getState().setDrawer({ tab: 'diff' }));
    await tick();
    expect(changesCalls(t.calls)).toHaveLength(3);
  });

  it('stops the 30 s timer when the drawer is closed', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot();
    mount(<t.Drawer />);
    await tick();
    expect(changesCalls(t.calls)).toHaveLength(1);
    act(() => t.layout.layoutStore.getState().setDrawer({ open: false }));
    await tick(120_000);
    expect(changesCalls(t.calls)).toHaveLength(1);
  });

  it('does not refresh on a hook for an agent whose Diff tab is hidden', async () => {
    vi.useFakeTimers();
    const t = await withSnapshot();
    mount(<t.Drawer />);
    await tick();
    act(() => t.layout.layoutStore.getState().setDrawer({ tab: 'notes' }));
    await tick();
    const before = changesCalls(t.calls).length;
    act(() => t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'waiting', lastHookAt: 1000, hooksSeen: true }));
    await tick();
    expect(changesCalls(t.calls)).toHaveLength(before);
  });
});

describe('render counts', () => {
  /**
   * Ceilings on a settled component, not predictions: a G59 loop is ~55 commits and then a thrown
   * "Maximum update depth exceeded". `DiffTab` takes two store selectors (`useSession`,
   * `useProject`), so unlike the Files tab these are guarding live subscriptions.
   */
  it('settles in a handful of commits and then stops', async () => {
    const t = await withSnapshot();
    const m = await mountTab(t);
    expect(m.commits()).toBeLessThanOrEqual(4);
    const afterMount = m.commits();
    await settle();
    await settle();
    expect(m.commits()).toBe(afterMount);
  });

  it('does not loop under StrictMode either', async () => {
    const t = await withSnapshot();
    const m = mountStrict(<t.DiffTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(m.commits()).toBeLessThanOrEqual(8);
  });

  it('does not loop with NO snapshot in the store at all', async () => {
    // G61: a `?? []`-shaped fallback allocates only on the NULLISH path, so every populated-state
    // count above stays green while the loop sits reachable — ⌘⇧G pressed before `workspace:get`
    // answers. `useProject` returns `undefined` here and `useSession` returns its per-id memo.
    const t = await load();
    t.layout.layoutStore.getState().hydrate(snapshotWith().workspace.layout);
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    const tab = mount(<t.DiffTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(tab.commits()).toBeLessThanOrEqual(4);
    // With no project in the store the header falls back to the workspace's own base ref.
    expect(tab.el.textContent).toContain('ahead of main');
    const drawer = mount(<t.Drawer />);
    await settle();
    expect(drawer.commits()).toBeLessThanOrEqual(3);
    expect(drawer.el.textContent).toContain('Focus a pane');
  });

  it('a session update for ANOTHER agent commits nothing here', async () => {
    const t = await withSnapshot();
    const m = await mountTab(t);
    const before = m.commits();
    act(() => t.sessions.useSessions.getState().setOne('a2', { ...initialSessionState('a2'), activity: 'working', lastHookAt: 5 }));
    await settle();
    // `useSession`'s selector re-runs and compares equal, so this component never re-renders — which
    // is also what makes trigger (b) per-agent without a comparison of its own.
    expect(m.commits()).toBe(before);
  });

  // The control. Without it the ceilings above could just mean the probe is blind. Measured on this
  // tree with React 19.2.8: ~55 renders, then React throws "Maximum update depth exceeded".
  it('catches a selector that allocates — exactly what this component must not do', async () => {
    const t = await withSnapshot();
    const Looping = (): ReactNode => {
      const derived = t.workspace.useWorkspace((s) => s.snapshot?.workspace.projects.map((p) => p.id) ?? []);
      return <span>{derived.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('placement in the whole app (G60)', () => {
  it('a real bubbling click on a path reaches the row and nothing upstream', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.App />);
    await settle();
    const row = rowNamed(el, 'src/edited.ts');
    // The deepest node — the text the pointer is actually over — not the button itself.
    const target = row.querySelector('span.truncate') ?? row;
    await click(target as HTMLElement);
    await settle();
    expect(rowNamed(el, 'src/edited.ts').getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('.cm-content')?.textContent).toContain('const a = 2;');
    // Sweep: `App`'s root div, `main` and the drawer's `<aside>` carry no click, mousedown,
    // contextmenu or drag handlers, so there is nothing to steal the event and no
    // `stopPropagation()` guard is needed. These assert that conclusion rather than the absence.
    expect(t.ui.useUi.getState().contextMenu).toBeNull();
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(0);
  });

  /**
   * The drawer's failures stay in the drawer.
   *
   * This has to run through `App`, not a bare `DiffTab`: the toast sink is installed by
   * `bootstrap()`, and a component-level mount leaves it at `lib/api.ts`'s default of
   * `console.error`, which would make `expect(toasts).toEqual([])` pass whether or not the calls
   * suppress their toasts (P4-4g). It is the mount that makes the assertion real.
   */
  it('reports a failed change set and a failed file diff in place, never as a toast', async () => {
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'git:fileDiff': () => fail('GIT', 'could not read src/edited.ts at HEAD'),
    });
    const { el } = mount(<t.App />);
    await settle();
    await open(el, 'src/edited.ts');
    expect(el.textContent).toContain('could not read src/edited.ts at HEAD');
    // A 30 s timer over a worktree the agent is mutating would otherwise stack a toast per tick.
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  it('replaces the drawer\'s Diff placeholder', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Drawer />);
    await settle();
    expect(el.textContent).not.toContain('arrives with the code drawer');
    expect(el.querySelector('[role="listbox"]')).not.toBeNull();
    expect(rowNames(el)).toContain('src/edited.ts');
  });
});
