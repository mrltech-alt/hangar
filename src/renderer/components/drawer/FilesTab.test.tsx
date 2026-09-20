/**
 * The Files tab: the lazy tree, the viewer, and the drawer wiring that mounts them (spec §12.5).
 *
 * Three standing hazards are all live in this component and each has its own block below.
 *
 * **G59/G61 — render counts.** Every store-consuming component on this project gets a commit count
 * on a real React root under a `<Profiler>`, with a control that mounts a deliberately-allocating
 * selector and asserts the harness throws. Nothing in `FilesTab`/`FileTree`/`FileViewer` takes a
 * zustand selector today — the agent and workspace arrive as props from `Drawer` — so the counts
 * here are pinning a PROPERTY, not fixing a bug: the moment someone adds `useWorkspace((s) => …)`
 * to any of the three, these tests are what catches the loop. Per G61 one of them mounts with NO
 * snapshot in the store at all, because a `?? []` fallback allocates only on the nullish path and
 * every populated-state test in the world stays green while the loop sits reachable.
 *
 * **G60 — ancestor handlers.** A test that mounts a component alone cannot see an ancestor stealing
 * its events. The last block dispatches a REAL bubbling click at the deepest node (the filename
 * text) through the whole mounted `App`. The sweep it records: `App`'s root div, `main`, and the
 * drawer's own `<aside>` carry no click, contextmenu, mousedown or drag handlers at all, so no
 * `stopPropagation()` guard is needed here — the same conclusion Plan 03 Tasks 7-9 reached for the
 * drawer, and this test is what keeps it true.
 *
 * **jsdom's limits.** CodeMirror measures the DOM and jsdom implements no layout, so the viewer
 * assertions here are about STATE and STRUCTURE — the text in `.cm-content`, the banners, the img
 * element. See the header of `lib/codemirror.test.ts` for what that does and does not prove.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FsEntry, FsFile, HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests,
} from '../../../../shared/ipc-contract.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace,
  type Agent, type Layout, type Project, type Workspace, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
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

function snapshotWith(layout: Partial<Layout> = {}): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: [project('p1', 'hangar'), project('p2', 'acmeapi')],
      agents: [AGENT],
      layout: { ...defaultLayout(), drawerOpen: true, drawerTab: 'files', panes: ['a1'], focusedIndex: 0, ...layout },
    },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixtures, written in the order `listDir` would return them: dirs first, ignored last within a
// kind, then case-insensitive by name (`node_modules` after `src`; `README.md` after `logo.png`).
// The renderer deliberately does not re-sort, so these arrays ARE the expected screen order.
// ---------------------------------------------------------------------------------------------
const dir = (name: string, ignored = false): FsEntry => ({ name, kind: 'dir', ignored, size: null });
const file = (name: string, size = 100, ignored = false): FsEntry => ({ name, kind: 'file', ignored, size });
const link = (name: string): FsEntry => ({ name, kind: 'symlink', ignored: false, size: null });

const LISTINGS: Record<string, FsEntry[]> = {
  '': [dir('src'), dir('node_modules', true), link('link-out'), file('logo.png', 2048), file('package.json', 640), file('README.md', 120)],
  src: [dir('components'), file('App.tsx', 4096), file('big.bin', 12_288), file('huge.log', 3_000_000)],
  'src/components': [],
  node_modules: [dir('react')],
};

const text = (content: string, patch: Partial<FsFile> = {}): FsFile => ({
  content, language: null, truncated: false, binary: false, size: content.length, image: null, ...patch,
});

const FILES: Record<string, FsFile> = {
  'package.json': text('{\n  "name": "hangar"\n}\n', { language: 'json', size: 640 }),
  'src/App.tsx': text('export function App() {\n  return null;\n}\n', { language: 'tsx', size: 4096 }),
  'src/big.bin': { content: '', language: null, truncated: false, binary: true, size: 12_288, image: null },
  'src/huge.log': text('the first bytes…', { truncated: true, size: 3_000_000 }),
  'logo.png': { content: '', language: null, truncated: false, binary: true, size: 2048, image: 'data:image/png;base64,iVBORw0KGgo=' },
  // An image OVER the 10 MB cap: main reuses `truncated` to mean "more than we will send" and
  // sends no data URL. `readFileForViewer` is the only producer of this shape.
  'huge.png': { content: '', language: null, truncated: true, binary: true, size: 12 * 1024 * 1024, image: null },
};

interface Call { channel: IpcRequestKey; payload: unknown }

const ok = <T,>(value: T): IpcReply<T> => ({ ok: true, value });
const fail = <T,>(code: string, message: string): IpcReply<T> => ({ ok: false, error: { code, message } });

/**
 * Per-PAYLOAD replies, which a lazy tree needs and `Drawer.test.tsx`'s channel-keyed map cannot
 * give: `fs:list` is answered four different ways depending on `relPath`.
 *
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — hence `vi.resetModules()` plus dynamic imports, the same dance the other
 * component suites use. It also means every `load()` gets FRESH stores.
 */
type Replies = { [K in IpcRequestKey]?: (payload: IpcRequests[K]['req']) => IpcReply<IpcRequests[K]['res']> };

const DEFAULT_REPLIES: Replies = {
  'fs:list': (p) => (p.relPath in LISTINGS ? ok(LISTINGS[p.relPath]) : fail('NOT_FOUND', `${p.relPath} does not exist`)),
  'fs:read': (p) => (p.relPath in FILES ? ok(FILES[p.relPath]) : fail('NOT_FOUND', `${p.relPath} does not exist`)),
  'layout:set': () => ok(undefined),
  'agent:markOpened': () => ok(undefined),
  'app:copyToClipboard': () => ok(undefined),
  'app:openExternal': () => ok(undefined),
  // The four `bootstrap()` fires, so mounting the whole `App` produces no failure of its own — the
  // toast assertions below would otherwise be reading a burst of "no stub for workspace:get".
  'config:get': () => ok(defaultAppConfig('/bin/zsh')),
  'workspace:get': () => ok(snapshotWith()),
  'app:windowFocused': () => ok(undefined),
  'agent:markViewed': () => ok(undefined),
};

async function load(replies: Replies = DEFAULT_REPLIES) {
  const calls: Call[] = [];
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const handler = replies[channel];
      if (handler === undefined) return Promise.resolve(fail('TEST', `no stub for ${channel}`));
      // One narrow cast, of the HANDLER's parameter only: `replies[channel]` is a union of
      // per-key functions that TS will not collapse for an unresolved `K`. The reply type stays
      // checked, so a stub returning the wrong shape is still a compile error.
      return Promise.resolve((handler as (p: unknown) => IpcReply<IpcRequests[K]['res']>)(args[0]));
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      void channel;
      void handler;
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [filesTab, drawer, { App }, workspace, layout, ui] = await Promise.all([
    import('./FilesTab.tsx'),
    import('./Drawer.tsx'),
    import('../../App.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
  ]);
  return { ...filesTab, ...drawer, App, workspace, layout, ui, calls };
}

/** The common case: the snapshot already in the stores, no `App`, no bootstrap. */
async function withSnapshot(snap: WorkspaceSnapshot = snapshotWith(), replies: Replies = DEFAULT_REPLIES) {
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
});

/** Mounts `node` and returns the host element plus a live count of subtree COMMITS. */
function mount(node: ReactNode): { el: HTMLElement; commits: () => number; render: (next: ReactNode) => void } {
  return mountWith((n) => n, node);
}

/**
 * The same, under `<StrictMode>` — and StrictMode has to be the OUTERMOST element handed to
 * `root.render()`, which is why this is a separate helper rather than `mount(<StrictMode>…)`.
 *
 * Measured on React 19.2.8, one root each, a component with a mount effect and a click handler
 * whose updater counts its own calls:
 *
 *   root.render(<StrictMode><A/></StrictMode>)                                → effects 2, updaters 2
 *   root.render(<Profiler><StrictMode><div><B/></div></StrictMode></Profiler>)  → effects 1, updaters 2
 *
 * So a `<Profiler>` above `<StrictMode>` silently switches off the double-invocation of EFFECTS
 * while leaving updaters doubled. The obvious spelling — wrap the node, then wrap that in the
 * commit counter — therefore tests half of what it claims: it was hiding a real survivor in this
 * file's own matrix (the tree's in-flight dedupe, which only the double-invoked mount effect can
 * exercise) while reporting the test as green.
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
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — see `mountStrict`'s measurements for why that placement decides whether
  // effects double-invoke at all.
  const wrap = (n: ReactNode): ReactNode => shell(<Profiler id="commits" onRender={() => { commits += 1; }}>{n}</Profiler>);
  act(() => root.render(wrap(node)));
  return { el, commits: () => commits, render: (next) => act(() => root.render(wrap(next))) };
}

/** Lets every pending IPC reply, `.then()` and dynamic `import()` settle, then re-renders. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountTab(t: Awaited<ReturnType<typeof withSnapshot>>, workspace: Workspace = WORKSPACES[0]) {
  const m = mount(<t.FilesTab agent={AGENT} workspace={workspace} />);
  await settle();
  return m;
}

const items = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const names = (el: HTMLElement): string[] => items(el).map((b) => b.textContent ?? '');
const itemNamed = (el: HTMLElement, name: string): HTMLElement => {
  const found = items(el).find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no tree row "${name}" in [${names(el).join(', ')}]`);
  return found;
};
const listed = (calls: Call[]): string[] => calls.filter((c) => c.channel === 'fs:list').map((c) => (c.payload as { relPath: string }).relPath);
const readCalls = (calls: Call[]): string[] => calls.filter((c) => c.channel === 'fs:read').map((c) => (c.payload as { relPath: string }).relPath);

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('file tree', () => {
  it('lists the ROOT on mount, with the empty relPath the handler accepts', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    // `relPath: ''` is the root. Task 3 found the drafted schema rejecting exactly this, which
    // would have made the Files tab open empty; this pins the renderer's half of that.
    expect(t.calls.filter((c) => c.channel === 'fs:list').map((c) => c.payload)).toEqual([
      { agentId: 'a1', workspaceId: 'w1', relPath: '' },
    ]);
    expect(names(el)).toEqual(['src', 'node_modules', 'link-out', 'logo.png', 'package.json', 'README.md']);
  });

  it('renders main\'s order and main\'s `ignored` verbatim rather than re-deciding either', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    expect(itemNamed(el, 'node_modules').className).toContain('text-muted');
    expect(itemNamed(el, 'src').className).not.toContain('text-muted');
  });

  it('fetches a directory on its first expand and never again', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    expect(listed(t.calls)).toEqual(['', 'src']);
    expect(names(el)).toContain('App.tsx');
    await click(itemNamed(el, 'src')); // collapse
    expect(names(el)).not.toContain('App.tsx');
    await click(itemNamed(el, 'src')); // expand again, from cache
    expect(listed(t.calls)).toEqual(['', 'src']);
    expect(names(el)).toContain('App.tsx');
  });

  it('sends ONE fs:list per directory under StrictMode, on mount and on expand', async () => {
    // Two independent doubling mechanisms, one test. StrictMode runs the mount EFFECT twice
    // (mount → cleanup → mount) and invokes a state UPDATER twice for one event; measured on React
    // 19.2.8 through `mountStrict`, both happen here. Either would send `fs:list` twice: the first
    // is what the in-flight set in `load` exists for, the second is why the fetch sits outside the
    // `setExpanded` updater.
    //
    // They MASK each other, the shape Plan 04 Task 2's matrix found for its own pair. Measured with
    // this file's mutation matrix (17 of 18 mutants bite): deleting the in-flight set alone fails
    // the first assertion below with `['', '']`; moving the fetch back inside the updater alone
    // changes nothing observable, because the in-flight set dedupes the doubled call; deleting BOTH
    // fails this test. So the updater placement is kept as a correctness rule that only the pair
    // makes visible, and is recorded here rather than pretended to be independently tested.
    const t = await withSnapshot();
    const { el } = mountStrict(<t.FilesTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(listed(t.calls)).toEqual(['']);
    await click(itemNamed(el, 'src'));
    expect(listed(t.calls)).toEqual(['', 'src']);
  });

  it('marks an expanded directory expanded, and a selected file selected', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    expect(itemNamed(el, 'src').getAttribute('aria-expanded')).toBe('false');
    await click(itemNamed(el, 'src'));
    expect(itemNamed(el, 'src').getAttribute('aria-expanded')).toBe('true');
    expect(itemNamed(el, 'package.json').getAttribute('aria-expanded')).toBeNull();
    await click(itemNamed(el, 'package.json'));
    expect(itemNamed(el, 'package.json').getAttribute('aria-selected')).toBe('true');
    expect(itemNamed(el, 'README.md').getAttribute('aria-selected')).toBe('false');
  });

  it('Refresh re-lists every expanded directory, the root included', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    const refresh = el.querySelector<HTMLElement>('button[title="Refresh"]');
    if (refresh === null) throw new Error('no Refresh button');
    await click(refresh);
    expect(listed(t.calls)).toEqual(['', 'src', '', 'src']);
  });

  it('says so in place when a directory cannot be read, and retries on click — no toast', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    // `node_modules/react` is not in LISTINGS, so the stub answers NOT_FOUND — the same thing main
    // sends when the agent deletes a directory out from under the drawer.
    await click(itemNamed(el, 'node_modules'));
    await click(itemNamed(el, 'react'));
    expect(el.textContent).toContain('couldn’t read this folder');
    expect(el.textContent).not.toContain('loading…');
    const retry = [...el.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes('retry'));
    if (retry === undefined) throw new Error('no retry button');
    await click(retry);
    expect(listed(t.calls)).toEqual(['', 'node_modules', 'node_modules/react', 'node_modules/react']);
  });

  it('shows an empty directory as empty rather than as perpetually loading', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    await click(itemNamed(el, 'components'));
    expect(el.textContent).toContain('empty');
  });

  it('does not follow a symlink, and does not read a directory', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'link-out'));
    await click(itemNamed(el, 'src'));
    // Spec §14: an escaping symlink is listed and never followed, so main would answer EACCES.
    // Clicking one must do nothing at all rather than raising an error the user cannot act on.
    expect(readCalls(t.calls)).toEqual([]);
    expect(itemNamed(el, 'link-out').title).toContain('symlink (not followed)');
  });
});

describe('file viewer', () => {
  it('reads the clicked file by its joined path and renders it in CodeMirror', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    await click(itemNamed(el, 'App.tsx'));
    await settle();
    expect(readCalls(t.calls)).toEqual(['src/App.tsx']);
    expect(el.querySelector('.cm-content')?.textContent).toContain('export function App()');
    // The breadcrumb of spec §12.5, one span per segment.
    expect(el.textContent).toContain('src / App.tsx');
  });

  it('shows a binary file as its size, with no editor', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    await click(itemNamed(el, 'big.bin'));
    await settle();
    expect(el.textContent).toContain('Binary file (12.0 KB)');
    expect(el.querySelector('.cm-content')).toBeNull();
  });

  it('banners a truncated text file', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'src'));
    await click(itemNamed(el, 'huge.log'));
    await settle();
    expect(el.textContent).toContain('Showing the first 1.5 MB of this file.');
    expect(el.querySelector('.cm-content')?.textContent).toContain('the first bytes');
    expect(el.textContent).toContain('2.9 MB');
  });

  it('renders an image from main\'s data URL', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'logo.png'));
    await settle();
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(img?.getAttribute('alt')).toBe('logo.png');
    expect(el.textContent).not.toContain('Binary file');
  });

  it('does not claim "the first 1.5 MB" for an image too big to send', async () => {
    // The guard. `readFileForViewer` answers an over-10 MB image with `binary: true, truncated:
    // true, image: null` — `truncated` there means "more than we will send", not "1.5 MB of text
    // follows". Gate the banner on the file being text and this case reads correctly; drop the
    // `!file.binary` and a 12 MB PNG announces a 1.5 MB prefix that was never sent.
    const t = await withSnapshot(snapshotWith(), {
      ...DEFAULT_REPLIES,
      'fs:list': () => ok([file('huge.png', 12 * 1024 * 1024)]),
    });
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'huge.png'));
    await settle();
    expect(el.textContent).toContain('Too large to preview (12.0 MB).');
    expect(el.textContent).not.toContain('Showing the first 1.5 MB');
  });

  it('shows a read failure next to the file, not as a toast', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    // `README.md` is listed but absent from FILES: the agent deleted it between the listing and
    // the click, which is the everyday case in a live worktree.
    await click(itemNamed(el, 'README.md'));
    await settle();
    expect(el.textContent).toContain('README.md does not exist');
  });

  it('copies the ABSOLUTE path and opens the worktree', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'package.json'));
    await settle();
    const copy = el.querySelector<HTMLElement>('button[title="Copy path"]');
    const open = el.querySelector<HTMLElement>('button[title="Open worktree in VS Code"]');
    if (copy === null || open === null) throw new Error('no viewer buttons');
    await click(copy);
    await click(open);
    expect(t.calls.find((c) => c.channel === 'app:copyToClipboard')?.payload).toEqual({ text: '/wt/alpha/package.json' });
    expect(t.calls.find((c) => c.channel === 'app:openExternal')?.payload).toEqual({ agentId: 'a1', workspaceId: 'w1', target: 'vscode' });
  });

  it('destroys the previous editor when another file is clicked', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    await click(itemNamed(el, 'package.json'));
    await settle();
    expect(el.querySelectorAll('.cm-editor')).toHaveLength(1);
    await click(itemNamed(el, 'src'));
    await click(itemNamed(el, 'App.tsx'));
    await settle();
    expect(el.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(el.querySelector('.cm-content')?.textContent).toContain('export function App()');
  });
});

describe('two columns', () => {
  it('switching workspace re-lists from the root and drops the open file', async () => {
    const t = await withSnapshot();
    const m = await mountTab(t);
    await click(itemNamed(m.el, 'src'));
    await click(itemNamed(m.el, 'package.json'));
    await settle();
    expect(m.el.querySelector('.cm-content')).not.toBeNull();

    m.render(<t.FilesTab agent={AGENT} workspace={WORKSPACES[1]} />);
    await settle();
    // The `key` on `FileTree`: without it the previous worktree's expansion state and listings stay
    // on screen against the new workspace.
    expect(t.calls.filter((c) => c.channel === 'fs:list').map((c) => c.payload)).toContainEqual({ agentId: 'a1', workspaceId: 'w2', relPath: '' });
    expect(names(m.el)).toEqual(['src', 'node_modules', 'link-out', 'logo.png', 'package.json', 'README.md']);
    expect(m.el.textContent).toContain('Select a file');
    expect(m.el.querySelector('.cm-content')).toBeNull();
  });

  it('drags the tree/viewer split and clamps it at both ends', async () => {
    const t = await withSnapshot();
    const { el } = await mountTab(t);
    const handle = el.querySelector<HTMLElement>('.cursor-col-resize');
    const column = el.querySelector<HTMLElement>('[style*="width"]');
    if (handle === null || column === null) throw new Error('no resizer');
    expect(column.style.width).toBe(`${t.TREE_DEFAULT_WIDTH}px`);
    const drag = (from: number, to: number): void =>
      act(() => {
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: to }));
        window.dispatchEvent(new MouseEvent('mouseup', {}));
      });
    // Three steps, because `Resizer` reports INCREMENTAL deltas and a stale closure would swallow
    // all but the first — the bug Plan 03 Task 7 measured as a 300 px drag moving 100 px.
    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
    });
    expect(column.style.width).toBe(`${t.TREE_DEFAULT_WIDTH + 90}px`);
    drag(0, 10_000);
    expect(column.style.width).toBe(`${t.TREE_MAX_WIDTH}px`);
    drag(0, -10_000);
    expect(column.style.width).toBe(`${t.TREE_MIN_WIDTH}px`);
  });

  it('replaces the drawer\'s Files placeholder', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.Drawer />);
    await settle();
    expect(el.textContent).not.toContain('arrives with the code drawer');
    expect(el.querySelector('[role="tree"]')).not.toBeNull();
    expect(names(el)).toContain('package.json');
  });
});

describe('render counts', () => {
  /**
   * The bounds, measured on this tree with React 19.2.8. They are ceilings on a settled component,
   * not predictions: a loop is ~55 commits and then a thrown "Maximum update depth exceeded".
   */
  it('settles in a handful of commits and then stops', async () => {
    const t = await withSnapshot();
    const m = await mountTab(t);
    // Mount, then one commit for the root listing arriving. Measured: 2.
    expect(m.commits()).toBeLessThanOrEqual(3);
    const afterMount = m.commits();
    await settle();
    await settle();
    // Nothing further arrives on its own — an effect that re-fetched on every commit would show up
    // here as unbounded growth.
    expect(m.commits()).toBe(afterMount);
  });

  it('does not loop under StrictMode either', async () => {
    const t = await withSnapshot();
    const m = mountStrict(<t.FilesTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(m.commits()).toBeLessThanOrEqual(6);
  });

  it('does not loop with NO snapshot in the store at all', async () => {
    // G61: a `?? []` fallback in a selector allocates ONLY on the nullish path, so every
    // populated-state count above stays green while the loop sits reachable — ⌘⇧F pressed before
    // `workspace:get` answers. Both mounts here run against stores that have never been given a
    // snapshot.
    const t = await load();
    t.layout.layoutStore.getState().hydrate(snapshotWith().workspace.layout);
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    const tab = mount(<t.FilesTab agent={AGENT} workspace={WORKSPACES[0]} />);
    await settle();
    expect(tab.commits()).toBeLessThanOrEqual(3);
    const drawer = mount(<t.Drawer />);
    await settle();
    expect(drawer.commits()).toBeLessThanOrEqual(3);
    expect(drawer.el.textContent).toContain('Focus a pane');
  });

  // The control. Without it, the ceilings above could just mean the probe is blind. Measured on
  // this tree with React 19.2.8: ~55 renders, then React throws "Maximum update depth exceeded".
  it('catches a selector that allocates — exactly what these components must not do', async () => {
    const t = await withSnapshot();
    const Looping = (): ReactNode => {
      const derived = t.layout.useLayout((s) => ({ open: s.layout.drawerOpen, tab: s.layout.drawerTab }));
      return <span>{derived.tab}</span>;
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
  it('a real bubbling click on a filename reaches the row and nothing upstream', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.App />);
    await settle();
    const row = itemNamed(el, 'package.json');
    // The deepest node — the text the pointer is actually over — not the button itself.
    const target = row.querySelector('span.truncate') ?? row;
    await click(target as HTMLElement);
    await settle();
    expect(itemNamed(el, 'package.json').getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('.cm-content')?.textContent).toContain('"name": "hangar"');
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
   * This one has to run through `App`, not through a bare `FilesTab`: the toast sink is installed
   * by `bootstrap()` (`setErrorSink(… useUi.toast …)`), and a component-level mount leaves it at
   * `lib/api.ts`'s default, which is `console.error`. An `expect(toasts).toEqual([])` beside a bare
   * mount therefore passes whether or not the calls suppress their toasts — measured: dropping the
   * `() => undefined` argument from BOTH `runResult` calls left every such assertion green. It is
   * the mount that makes the assertion real, not the assertion.
   */
  it('reports a failed listing and a failed read in place, never as a toast', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.App />);
    await settle();
    await click(itemNamed(el, 'node_modules'));
    await click(itemNamed(el, 'react')); // not in LISTINGS → NOT_FOUND
    await click(itemNamed(el, 'README.md')); // listed but not in FILES → NOT_FOUND
    await settle();
    expect(el.textContent).toContain('couldn’t read this folder');
    expect(el.textContent).toContain('README.md does not exist');
    // Refresh re-lists every expanded directory at once, and a worktree mutates under the drawer
    // constantly, so the default sink would fire a burst of toasts for conditions the tree and the
    // viewer both state in place.
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });
});
