/**
 * The pane grid: arrangement maths, the three pane bodies (terminal / exit card / empty), and the
 * two hazards this half of the renderer walks into.
 *
 * **G59 — a selector that allocates is an infinite render loop.** zustand 5 hands the selector to
 * `useSyncExternalStore`, which requires a referentially stable snapshot: React re-runs it after
 * each commit and commits again whenever the identity differs. `layout.panes` is an ARRAY, so
 * `useLayout((s) => s.panes.map(...))` — the natural way to write `PaneGrid` — is the bug, not a
 * wasted allocation. Measured twice on this project at ~55 renders then "Maximum update depth
 * exceeded", with `tsc`, `eslint` and every pure unit test green the whole time. So the render
 * tests below mount the REAL components on a REAL React root under a `<Profiler>` and count
 * commits, and the last block is a control that mounts a deliberately-allocating selector and
 * asserts the harness throws — without it "commits === 1" could just mean the probe is blind.
 *
 * **G60 — a jsdom test that mounts a component and asserts its own behaviour cannot see an ANCESTOR
 * stealing the event.** A pane grid is nested containers by construction (grid > pane > header >
 * buttons), and `Pane` carries a `mousedown` handler that every descendant sits under. The last two
 * blocks dispatch REAL bubbling events at the deepest node through the whole mounted `App` and
 * assert on the stores, which is the only way that shape is visible.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Arrangement, type Id, type Layout, type Project, type SessionState, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';
import { PANE_HUES, paneChipLabel } from '../../../../shared/pane-hues.ts';
import { GRID, paneSpanClass } from './PaneGrid.tsx';
import { exitCardTitle } from './ExitCard.tsx';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const agent = (id: string, name: string, patch: Partial<Agent> = {}): Agent => ({
  id, name, slug: name.toLowerCase(), folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `hangar/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null, ...patch,
});

const session = (id: Id, patch: Partial<SessionState> = {}): SessionState => ({ ...initialSessionState(id), ...patch });

function snapshotWith(patch: Partial<WorkspaceSnapshot>, layout: Partial<Layout> = {}): WorkspaceSnapshot {
  const { workspace, ...rest } = patch;
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: [project('p1', 'hangar')],
      agents: [agent('a1', 'alpha'), agent('a2', 'beta')],
      ...workspace,
      // Applied last so a test that overrides the whole `workspace` (to swap an agent, say) still
      // gets the pane layout it asked for. Nesting it inside the spread cost two failures.
      layout: { ...defaultLayout(), ...workspace?.layout, ...layout },
    },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
    ...rest,
  };
}

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — hence `vi.resetModules()` plus dynamic imports, the same dance
 * `Sidebar.test.tsx`, `api.test.ts` and `bootstrap.test.ts` use. It also means each `load()` gets
 * FRESH store instances, which is what keeps these tests independent of one another.
 *
 * `channel in replies`, not `replies[channel] !== undefined`: three of the keys stubbed here
 * (`layout:set`, `agent:markOpened`, `agent:start`) have `res: void`, so a value check would report
 * them unstubbed, `run` would route them to the error sink, and every pane action would fire a
 * toast that the commit counters then charge to the component under test.
 */
async function load(replies: { [K in IpcRequestKey]?: IpcRequests[K]['res'] }) {
  const calls: IpcRequestKey[] = [];
  // Payloads as well as channels, added for Plan 05 Task 4: a project action is judged entirely by
  // the BYTES it puts on `session:write` (spec §15.4 — typed, never submitted), and a channel name
  // cannot show that. Kept beside `calls` rather than replacing it so every existing assertion in
  // this file stays as it was.
  const payloads: { channel: IpcRequestKey; payload: unknown }[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  // Typed as the real `HangarBridge` with no `as unknown as` escape hatch (Plan 02's standing rule),
  // so a change to the bridge's shape fails here rather than being absorbed by a blanket cast.
  const bridge: HangarBridge = {
    // The conditional rest tuple has to be spelled out: omitting it typechecks under vitest (which
    // does not typecheck at all) and fails `tsc -p tsconfig.web.json` with TS2322.
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push(channel);
      payloads.push({ channel, payload: args[0] });
      if (!(channel in replies)) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return Promise.resolve({ ok: true, value: replies[channel] as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      // The one narrowing this file cannot express: a single Map holding handlers for eight
      // different payload types. It hides nothing about any interface.
      const erased = handler as (payload: never) => void;
      const list = listeners.get(channel) ?? [];
      list.push(erased);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [panes, { App }, workspace, sessions, layout, ui, config, keymap, registry] = await Promise.all([
    import('./PaneGrid.tsx'),
    import('../../App.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
    import('../../stores/config.ts'),
    // For `keyLabel`: the pane header's tooltips read their key captions off `SHORTCUTS`, and the
    // test asserts against the same table rather than re-typing '⌘⇧F' beside it.
    import('../../lib/keymap.ts'),
    // The SAME module instance `PaneHeader` imports — `vi.resetModules()` above means a top-level
    // import of the registry would be a different Map, and a test writing into it would prove
    // nothing about the component.
    import('../../lib/terminal-registry.ts'),
  ]);
  return { ...panes, App, workspace, sessions, layout, ui, config, keymap, registry, calls, payloads };
}

/** The common case: a snapshot already in the stores, no `App`, no bootstrap. */
async function withSnapshot(snap: WorkspaceSnapshot) {
  // The four session channels were added in Task 6: a pane with a running session now mounts a
  // real xterm and attaches, so leaving them unstubbed would route a failed `session:attach`
  // through `run`'s error sink on every such test — noise today, and a toast (and therefore an
  // extra commit charged to the component under test) the moment one of these mounts `App`.
  const t = await load({
    'layout:set': undefined, 'agent:markOpened': undefined, 'agent:markViewed': undefined, 'agent:start': undefined, 'agent:stop': undefined,
    'session:attach': { snapshot: '', title: '' }, 'session:detach': undefined, 'session:write': undefined, 'session:resize': undefined,
  });
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.sessions.useSessions.getState().setAll(snap.sessions);
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
function mount(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => n, node);
}

/**
 * The same under `<StrictMode>` — a separate helper rather than `mount(<StrictMode>…</StrictMode>)`,
 * because StrictMode only double-invokes EFFECTS when it is the OUTERMOST element handed to
 * `root.render()` (G65). Measured on React 19.2.8 by `components/strict-mode-nesting.test.tsx`,
 * which re-runs the comparison on every suite run:
 *
 *   root.render(<StrictMode><Profiler><P/></Profiler></StrictMode>)  → effects 2, updaters 2
 *   root.render(<Profiler><StrictMode><P/></StrictMode></Profiler>)  → effects 1, updaters 2
 *
 * The second line is the spelling this file used until the G65 correction. Render and state
 * updaters stayed doubled either way, so the allocating-selector detection below was doing its
 * stated job throughout; what was switched off was the double-MOUNT half — the one that catches
 * double-subscribe, double-fetch and double-attach. `FilesTab.test.tsx`'s `mountStrict` is the
 * reference shape.
 */
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => <StrictMode>{n}</StrictMode>, node);
}

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — that placement is what decides whether effects double-invoke at all.
  act(() => root.render(shell(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>)));
  return { el, commits: () => commits };
}

const ARRANGEMENTS: Arrangement[] = ['single', 'split-h', 'split-v', 'triple', 'grid'];

describe('grid arrangement (pure)', () => {
  it('has a shape for every arrangement the layout reducer can produce', () => {
    for (const a of ARRANGEMENTS) expect(GRID[a]).toMatch(/grid-cols-\d grid-rows-\d/);
  });

  it('lays 1, 2 and 2 panes out as spec §12.3 draws them', () => {
    expect(GRID.single).toBe('grid-cols-1 grid-rows-1');
    expect(GRID['split-h']).toBe('grid-cols-2 grid-rows-1');
    expect(GRID['split-v']).toBe('grid-cols-1 grid-rows-2');
  });

  // The plan wrote `triple && i === 0 ? 'row-span-2'` — a full-height LEFT column. Spec §12.3 draws
  // `[A][B]` over `[ C ]`, so it is the THIRD pane that spans, horizontally. Reverting to the
  // plan's version fails this test and the rendered-DOM one below it.
  it('spans only the third pane, and only in triple (spec §12.3: [A][B] over [ C ])', () => {
    expect(paneSpanClass('triple', 0)).toBe('');
    expect(paneSpanClass('triple', 1)).toBe('');
    expect(paneSpanClass('triple', 2)).toBe('col-span-2');
  });

  it('spans nothing in any other arrangement', () => {
    for (const a of ARRANGEMENTS) {
      if (a === 'triple') continue;
      for (let i = 0; i < 4; i += 1) expect(paneSpanClass(a, i)).toBe('');
    }
  });
});

describe('exit card title (pure)', () => {
  it('reports the exit code when the session exited', () => {
    expect(exitCardTitle(session('a1', { activity: 'exited', exitCode: 137 }), false)).toBe('Session exited with code 137');
  });

  // A session killed by a signal comes back with a null code; "code null" would read as a bug.
  it('falls back to ? when the exit code is null', () => {
    expect(exitCardTitle(session('a1', { activity: 'exited', exitCode: null }), false)).toBe('Session exited with code ?');
  });

  it('says "not running" for a never-started session', () => {
    expect(exitCardTitle(session('a1'), false)).toBe('Session not running');
  });

  // `missing` outranks the activity: the worktree being gone is WHY nothing runs, and it is the only
  // one of the three the Start buttons cannot fix.
  it('reports a missing worktree ahead of the exit code', () => {
    expect(exitCardTitle(session('a1', { activity: 'exited', exitCode: 1 }), true)).toBe('Worktree directory is missing');
  });
});

describe('PaneGrid rendering', () => {
  it('renders one pane per slot and applies the arrangement classes', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.querySelectorAll('section').length).toBe(3);
    // Three panes normalize to `triple`, whose 2x2 grid is shared with `grid`.
    expect(el.querySelector('div > div')?.className).toContain('grid-cols-2 grid-rows-2');
  });

  it('gives the third pane the full bottom row when three panes are open', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null] }));
    const { el } = mount(<t.PaneGrid />);
    const cells = [...(el.firstElementChild?.children ?? [])];
    expect(cells.map((c) => c.className.includes('col-span-2'))).toEqual([false, false, true]);
  });

  it('spans nothing when a fourth pane fills the grid', async () => {
    const t = await withSnapshot(snapshotWith({ workspace: { ...emptyWorkspace(), projects: [project('p1', 'hangar')], agents: [agent('a1', 'alpha'), agent('a2', 'beta')], layout: { ...defaultLayout(), panes: ['a1', 'a2', null, null] } } }, {}));
    const { el } = mount(<t.PaneGrid />);
    const cells = [...(el.firstElementChild?.children ?? [])];
    expect(cells.length).toBe(4);
    expect(cells.some((c) => c.className.includes('col-span-2'))).toBe(false);
  });

  // THE G59 test for this task. `layout.panes` is an array, so the obvious selector allocates.
  it('does not loop React: a four-pane grid commits exactly once', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle' }), a2: session('a2', { activity: 'idle' }) } }, { panes: ['a1', 'a2', null, null] }));
    const { commits } = mount(<t.PaneGrid />);
    expect(commits()).toBe(1);
  });

  // StrictMode double-invokes render, so an allocating selector fails here even louder. The app
  // itself does not use StrictMode (G26: it would attach every terminal twice).
  //
  // `mountStrict`, not `mount(<StrictMode>…</StrictMode>)` — the nesting is what decides whether
  // the mount EFFECT doubles as well as render (G65). This case has no live sessions, so no
  // `TerminalView` mounts and G26's double-attach is not what is under test here (measured: zero
  // IPC calls across the double mount); the loop detection is.
  it('does not loop React under StrictMode either', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null, null] }));
    const { commits } = mountStrict(<t.PaneGrid />);
    expect(commits()).toBeLessThanOrEqual(2);
  });

  // A 1 s ticker runs over the sessions store for as long as the app is up (spec §13), and every
  // pane subscribes to it through `useSession`. A no-op tick must cost nothing.
  it('does not re-render on a tick that changes no session', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle' }) } }, { panes: ['a1'] }));
    const { commits } = mount(<t.PaneGrid />);
    const afterMount = commits();
    for (let i = 0; i < 5; i += 1) act(() => t.sessions.useSessions.getState().tick(Date.now()));
    expect(commits() - afterMount).toBe(0);
  });

  it('settles after a pane action: closing a pane costs a bounded number of commits', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const { commits } = mount(<t.PaneGrid />);
    const afterMount = commits();
    act(() => t.layout.layoutStore.getState().closePane(1));
    expect(commits() - afterMount).toBeLessThanOrEqual(2);
  });
});

describe('pane bodies', () => {
  it('shows the empty-pane prompt, numbered from 1, for a null slot', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: [null] }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.textContent).toContain('Choose an agent for pane 1');
    expect(el.textContent).toContain('New agent');
  });

  /**
   * §12.3: "centred 'Choose an agent' with the quick switcher button". Until Plan 05 this button
   * raised `requestSearchFocus` — the Phase 1 stopgap ⌘K — which moved the caret into a sidebar
   * that may not even be on screen (⌘B), leaving the button doing nothing visible on the pane that
   * needs it most. It now opens the palette, and the label and ⌘K hint say so.
   */
  it('offers the quick switcher from an empty pane', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: [null] }));
    const { el } = mount(<t.PaneGrid />);
    const jump = [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Jump to agent'));
    expect(jump?.textContent).toBe('Jump to agent ⌘K');
    act(() => jump?.click());
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(0);
  });

  // `closePane` blanks a lone pane instead of removing it, so the button would visibly do nothing.
  it('hides "Close pane" on the only pane and shows it once there are two', async () => {
    const one = await withSnapshot(snapshotWith({}, { panes: [null] }));
    const oneEl = mount(<one.PaneGrid />).el;
    expect(oneEl.textContent).not.toContain('Close pane');
    const two = await withSnapshot(snapshotWith({}, { panes: [null, null] }));
    const twoEl = mount(<two.PaneGrid />).el;
    // The captions come from `SHORTCUTS` via `<ShortcutKbd>` — they used to be literal
    // `<Kbd>⌘N</Kbd>` markup — so this asserts both halves of the empty pane's offer.
    expect(twoEl.textContent).toContain(`Close pane ${String(two.keymap.keyLabel({ kind: 'close-pane' }))}`);
    expect(twoEl.textContent).toContain('Close pane ⌘⇧W');
    expect(twoEl.textContent).toContain('New agent ⌘N');
  });

  it('shows the exit card with the two-button form for an agent that never started', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1') } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.textContent).toContain('Session not running');
    expect(el.textContent).toContain('Start Claude');
    expect(el.textContent).not.toContain('Resume conversation');
  });

  it('offers Resume / Fresh / Shell only once the agent has started before', async () => {
    const started = agent('a1', 'alpha', { claude: { sessionId: 's-a1', hasStartedOnce: true, permissionMode: null, extraArgs: [] } });
    const t = await withSnapshot(snapshotWith({
      workspace: { ...emptyWorkspace(), projects: [project('p1', 'hangar')], agents: [started], layout: defaultLayout() },
      sessions: { a1: session('a1', { activity: 'exited', exitCode: 137 }) },
    }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.textContent).toContain('Session exited with code 137');
    expect(el.textContent).toContain('Resume conversation');
    expect(el.textContent).toContain('Start fresh');
    expect(el.textContent).toContain('Shell only');
  });

  it('shows the missing-worktree card, with the path, instead of any start option', async () => {
    const t = await withSnapshot(snapshotWith({
      sessions: { a1: session('a1', { activity: 'idle' }) },
      runtime: { 'w-a1': { workspaceId: 'w-a1', worktreeMissing: true } },
    }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.textContent).toContain('Worktree directory is missing');
    expect(el.textContent).toContain('/wt/alpha no longer exists');
    expect(el.textContent).not.toContain('Start Claude');
  });

  // A running session gets the terminal, not a card. `TerminalView` is Task 6's; today it is the
  // empty `absolute inset-0` box, which is exactly what "no card" looks like from here.
  it('mounts the terminal view, not a card, while the session is running', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle' }) } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    expect(el.textContent).not.toContain('Session not running');
    expect(el.querySelector('.absolute.inset-0')).not.toBeNull();
  });
});

describe('pane header', () => {
  const headerOf = (el: HTMLElement) => el.querySelector('header') as HTMLElement;
  const buttonTitled = (el: HTMLElement, title: string) => el.querySelector<HTMLButtonElement>(`button[title="${title}"]`);

  it('shows the agent name, the branch chip and the terminal title', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle', title: 'fixing the thing' }) } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    const header = headerOf(el);
    expect(header.textContent).toContain('alpha');
    expect(header.textContent).toContain('hangar/alpha');
    expect(header.textContent).toContain('fixing the thing');
  });

  /**
   * Which of the three the header gives up FIRST, pinned as far as a DOM test can pin it.
   *
   * jsdom has no layout engine (G66's family), so nothing here can show that the agent name stays
   * legible in a 400px pane — that is a Blink question and it is not answered below. What a test
   * CAN hold still is the contract the CSS is made of, and a class assertion is the only instrument
   * available for it: the name comes first and never gives space back (`shrink-0`, capped at
   * `max-w-[45%]`), the chips ARE shrinkable — they used to be `shrink-0` pinned at 180px while the
   * name collapsed to nothing, which is the bug this pins shut — and the terminal title is the only
   * growing item, so `flex-1`'s zero basis makes it the first thing to yield.
   */
  it('gives the agent name priority over the chips, and the terminal title none (order + classes)', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle', title: 'fixing the thing' }) } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    const header = headerOf(el);
    const name = header.querySelector('span[title="Double-click to rename"]') as HTMLElement;
    const title = header.querySelector('span[title="Terminal title"]') as HTMLElement;
    const chip = header.querySelector('button[title$="click to copy path"]') as HTMLElement;
    expect([name?.textContent, title?.textContent, chip?.textContent]).toEqual(['alpha', 'fixing the thing', 'hangar/alpha']);
    // Reading order: name, then title, then the chips.
    expect(name.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The name is the one item that keeps its width...
    expect(name.className).toContain('shrink-0');
    expect(name.className).toContain('max-w-[45%]');
    // ...and it is not the only shrinkable thing in the row any more: the chips and their row are.
    expect(chip.className).toContain('shrink');
    expect(chip.className).not.toContain('shrink-0');
    expect(chip.className).toContain('min-w-0');
    expect(chip.parentElement?.className).not.toContain('shrink-0');
    expect(chip.parentElement?.className).toContain('min-w-0');
    // `flex-1` is flex-basis 0: the title only ever holds leftover space, so it yields it first.
    expect(title.className).toContain('flex-1');
    expect(title.className).toContain('min-w-0');
  });

  // The growing span is also the spacer that keeps the chips and buttons hard right, so it renders
  // with no title to show. (`ml-auto` on the chips would read better and be wrong — auto margins
  // absorb free space before flex-grow, which would lay a title that IS present out at zero width.)
  it('keeps the growing spacer, without a tooltip, when the session has no title', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle', title: '' }) } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    const name = headerOf(el).querySelector('span[title="Double-click to rename"]') as HTMLElement;
    const spacer = name.nextElementSibling as HTMLElement;
    expect(spacer.className).toContain('flex-1');
    expect(spacer.textContent).toBe('');
    expect(spacer.hasAttribute('title')).toBe(false);
  });

  // §12.3: the swap button must never be a control that does nothing.
  it('disables swap on a single pane and enables it once there are two', async () => {
    const one = await withSnapshot(snapshotWith({}, { panes: ['a1'] }));
    const oneEl = mount(<one.PaneGrid />).el;
    expect(buttonTitled(oneEl, 'Swap with next pane')?.disabled).toBe(true);
    const two = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const twoPaneEl = mount(<two.PaneGrid />).el;
    expect(buttonTitled(twoPaneEl, 'Swap with next pane')?.disabled).toBe(false);
  });

  it('swaps the last pane with the first rather than no-opping off the end', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    const swap = [...el.querySelectorAll<HTMLButtonElement>('button[title="Swap with next pane"]')][1];
    act(() => swap?.click());
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a2', 'a1']);
  });

  // Only the two-pane case has a free h/v choice; 3 and 4 panes are fixed shapes (§12.3).
  it('offers the orientation toggle at exactly two panes', async () => {
    const two = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const twoEl = mount(<two.PaneGrid />).el;
    expect(buttonTitled(twoEl, 'Stacked')).not.toBeNull();
    act(() => buttonTitled(twoEl, 'Stacked')?.click());
    expect(two.layout.layoutStore.getState().layout.arrangement).toBe('split-v');
    // The preference is stored where it survives the pane count, not only in `arrangement`.
    expect(two.layout.layoutStore.getState().layout.splitOrientation).toBe('split-v');

    const three = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null] }));
    const threeEl = mount(<three.PaneGrid />).el;
    expect(buttonTitled(threeEl, 'Stacked')).toBeNull();
    expect(buttonTitled(threeEl, 'Side by side')).toBeNull();
  });

  it('closes the pane without stopping the session', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const { el } = mount(<t.PaneGrid />);
    // Pane 0 is the focused one, so its Close button names the key (see PaneHeader.tsx).
    act(() => buttonTitled(el, 'Close pane (⌘⇧W) — the session keeps running')?.click());
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a2']);
    expect(t.calls).not.toContain('agent:stop');
  });

  it('greys the start options while a session runs, and Stop while it does not', async () => {
    const running = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle' }) } }, { panes: ['a1'] }));
    const runningEl = mount(<running.PaneGrid />).el;
    act(() => buttonTitled(runningEl, 'Restart / stop')?.click());
    const live = Object.fromEntries((running.ui.useUi.getState().contextMenu?.items ?? []).filter((i) => !i.separator).map((i) => [i.label, i.disabled === true]));
    expect(live).toEqual({ 'Resume conversation': true, 'Start fresh': true, 'Shell only': true, Stop: false });

    const stopped = await withSnapshot(snapshotWith({ sessions: { a1: session('a1') } }, { panes: ['a1'] }));
    const stoppedEl = mount(<stopped.PaneGrid />).el;
    act(() => buttonTitled(stoppedEl, 'Restart / stop')?.click());
    const dead = Object.fromEntries((stopped.ui.useUi.getState().contextMenu?.items ?? []).filter((i) => !i.separator).map((i) => [i.label, i.disabled === true]));
    expect(dead).toEqual({ 'Resume conversation': false, 'Start fresh': false, 'Shell only': false, Stop: true });
  });

  /**
   * Spec §15.4's project actions. The command is USER-AUTHORED and is typed into a live `$SHELL -il`
   * PTY, so these assert on the bytes `session:write` receives, not on the menu labels alone.
   *
   * Control characters are written as escapes, never as literal bytes (G48).
   */
  describe('project actions (spec §15.4)', () => {
    const withActions = (actions: { label: string; command: string }[], patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => snapshotWith({
      workspace: {
        ...emptyWorkspace(),
        projects: [{ ...project('p1', 'hangar'), actions }],
        agents: [agent('a1', 'alpha')],
        layout: defaultLayout(),
      },
      sessions: { a1: session('a1', { activity: 'idle' }) },
      ...patch,
    }, { panes: ['a1'] });

    // Hidden, not disabled: a ⋯ that opens an empty menu is a control that does nothing.
    it('shows the ⋯ button only when the primary project has actions', async () => {
      const none = await withSnapshot(withActions([]));
      expect(buttonTitled(mount(<none.PaneGrid />).el, 'Project actions')).toBeNull();
      const some = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test' }]));
      expect(buttonTitled(mount(<some.PaneGrid />).el, 'Project actions')).not.toBeNull();
    });

    it('lists the project\'s actions and greys them while the session is not running', async () => {
      const live = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test' }, { label: 'Lint', command: 'npm run lint' }]));
      const liveEl = mount(<live.PaneGrid />).el;
      act(() => buttonTitled(liveEl, 'Project actions')?.click());
      expect((live.ui.useUi.getState().contextMenu?.items ?? []).map((i) => [i.label, i.disabled === true])).toEqual([['Tests', false], ['Lint', false]]);

      // A stopped agent has no PTY to type into.
      const dead = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test' }], { sessions: { a1: session('a1') } }));
      const deadEl = mount(<dead.PaneGrid />).el;
      act(() => buttonTitled(deadEl, 'Project actions')?.click());
      expect((dead.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.disabled === true)).toEqual([true]);
    });

    // THE test for this feature. §15.4: "clicking types the command into the agent's terminal
    // WITHOUT pressing Enter (the user reviews and submits)".
    it('types the command at the prompt and does not submit it', async () => {
      const t = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test' }]));
      const { el } = mount(<t.PaneGrid />);
      act(() => buttonTitled(el, 'Project actions')?.click());
      act(() => t.ui.useUi.getState().contextMenu?.items[0]?.onSelect?.());
      const writes = t.payloads.filter((c) => c.channel === 'session:write').map((c) => c.payload);
      expect(writes).toEqual([{ agentId: 'a1', data: 'npm test' }]);
      // Spelled out as its own assertion because it is the whole safety model, and a future
      // "convenience" newline would otherwise only break the deep-equal above by accident.
      expect((writes[0] as { data: string }).data).not.toMatch(/[\r\n]/);
    });

    /**
     * "The user reviews the typed command and presses Enter" (§15.4) only works if the next keypress
     * reaches the terminal rather than the menu that was just dismissed. A real `TerminalHandle` from
     * the same registry module the component imports, so this measures the wiring rather than a stub.
     */
    it('leaves focus in the terminal, because pressing Enter is the rest of the gesture', async () => {
      const t = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test' }]));
      const { el } = mount(<t.PaneGrid />);
      // The handle `TerminalView` itself put in the registry — not one this test invented, which
      // `TerminalView`'s own mount effect would have overwritten anyway.
      const handle = t.registry.terminals.get('a1');
      expect(handle, 'a running pane should have registered a terminal').toBeDefined();
      const focus = vi.spyOn(handle!.term, 'focus');
      try {
        act(() => buttonTitled(el, 'Project actions')?.click());
        const before = focus.mock.calls.length;
        act(() => t.ui.useUi.getState().contextMenu?.items[0]?.onSelect?.());
        // The delta, not the total: `TerminalView`'s own focus effect also runs on a focused pane,
        // so an absolute count would pass with the call removed from the menu item entirely.
        expect(focus.mock.calls.length - before).toBe(1);
      } finally {
        focus.mockRestore();
      }
    });

    /**
     * G33: quoting cannot defend a value that is TYPED into a live shell, because the line editor
     * consumes control bytes before any parser runs — and `\r` submits whatever is on the line.
     * `ProjectActionSchema` refuses to store one, so reaching this state needs a hand-edited
     * `workspace.json` whose actions the loader would have dropped; `actionKeystrokes` is the
     * second, independent guard, and this is what proves it is wired in rather than merely present.
     */
    it('strips a control character out of a command that reached the store anyway', async () => {
      const t = await withSnapshot(withActions([{ label: 'Tests', command: 'npm test\u0003 && rm -rf ~\r' }]));
      const { el } = mount(<t.PaneGrid />);
      act(() => buttonTitled(el, 'Project actions')?.click());
      act(() => t.ui.useUi.getState().contextMenu?.items[0]?.onSelect?.());
      expect(t.payloads.filter((c) => c.channel === 'session:write').map((c) => c.payload))
        .toEqual([{ agentId: 'a1', data: 'npm test  && rm -rf ~' }]);
    });

    /**
     * The actions belong to `workspaces[0]`'s project — the one whose worktree is the PTY's cwd.
     * A second workspace is an `--add-dir` for Claude, not a directory the shell is sitting in, so
     * offering its project's `npm test` would type a command for the wrong repository.
     */
    it('takes the actions from the primary workspace\'s project, not a secondary one', async () => {
      const twoWorkspaces = agent('a1', 'alpha', {
        workspaces: [
          { id: 'w-a1', projectId: 'p1', branch: 'hangar/alpha', worktreePath: '/wt/alpha', baseRef: 'main', createdAt: ISO },
          { id: 'w-a1b', projectId: 'p2', branch: 'acmeapi/alpha', worktreePath: '/wt/alpha-acmeapi', baseRef: 'main', createdAt: ISO },
        ],
      });
      const t = await withSnapshot(snapshotWith({
        workspace: {
          ...emptyWorkspace(),
          projects: [
            { ...project('p1', 'hangar'), actions: [{ label: 'Hangar tests', command: 'npm test' }] },
            { ...project('p2', 'acmeapi'), actions: [{ label: 'AcmeApi tests', command: 'npx jest' }] },
          ],
          agents: [twoWorkspaces],
          layout: defaultLayout(),
        },
        sessions: { a1: session('a1', { activity: 'idle' }) },
      }, { panes: ['a1'] }));
      const el = mount(<t.PaneGrid />).el;
      act(() => buttonTitled(el, 'Project actions')?.click());
      expect((t.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label)).toEqual(['Hangar tests']);
    });

    // The header derives its project with a `.find` and falls back with `?? []`. Both are below the
    // subscriptions, not inside a selector — but G61 is precisely the bug that only shows on the
    // nullish path, so this mounts a pane whose project is GONE (a removed project, or a
    // hand-edited file) and counts commits rather than assuming.
    it('renders, and does not loop, for an agent whose project no longer exists', async () => {
      const t = await withSnapshot(snapshotWith({
        workspace: { ...emptyWorkspace(), projects: [], agents: [agent('a1', 'alpha')], layout: defaultLayout() },
        sessions: { a1: session('a1', { activity: 'idle' }) },
      }, { panes: ['a1'] }));
      const { el, commits } = mount(<t.PaneGrid />);
      expect(commits()).toBe(1);
      expect(headerOf(el).textContent).toContain('alpha');
      expect(buttonTitled(el, 'Project actions')).toBeNull();
    });
  });

  it('focuses the pane and opens the drawer on the tab the button names', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    // `^=`, not `=`: the FOCUSED pane's drawer buttons carry the shortcut in their title and the
    // unfocused pane's do not, which is the point of the assertion two tests below. Matching on the
    // prefix keeps this test about the drawer and not about tooltips.
    const diffOnSecondPane = [...el.querySelectorAll<HTMLButtonElement>('button[title^="Diff"]')][1];
    act(() => diffOnSecondPane?.click());
    const layout = t.layout.layoutStore.getState().layout;
    expect(layout.focusedIndex).toBe(1);
    expect(layout.drawerOpen).toBe(true);
    expect(layout.drawerTab).toBe('diff');
  });

  /**
   * The tooltips that carry a key, and the rule that keeps them honest.
   *
   * ⌘⇧F/G/M and ⌘⇧W all act on the FOCUSED pane, so naming them on an unfocused pane's
   * header would point the user at a key that operates on the other pane. `PaneHeader` names the
   * key only where the button and the key really coincide, and this is where that is measured.
   *
   * The captions themselves are read off `SHORTCUTS` rather than typed here, so rebinding a drawer
   * tab moves this expectation with the app instead of failing it.
   */
  it('names the shortcut on the FOCUSED pane\'s header buttons and nowhere else', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    const titles = (prefix: string) => [...el.querySelectorAll<HTMLButtonElement>(`button[title^="${prefix}"]`)].map((b) => b.title);
    const filesKey = t.keymap.keyLabel({ kind: 'drawer-tab', tab: 'files' });
    const closeKey = t.keymap.keyLabel({ kind: 'close-pane' });
    expect(filesKey).toBe('⌘⇧F');
    expect(closeKey).toBe('⌘⇧W');
    expect(titles('Files')).toEqual([`Files (${filesKey})`, 'Files']);
    expect(titles('Close pane')).toEqual([`Close pane (${closeKey}) — the session keeps running`, 'Close pane — the session keeps running']);
  });
});

/**
 * Spec §3's colour spine, the pane half of it.
 *
 * **G66's family: jsdom has no layout engine**, so nothing below measures a rail's width, its
 * position or whether it moved the terminal — those are Blink questions and this file cannot ask
 * them. What it can hold still is the rendered style and the classes the geometry is made of: the
 * hue that came out of `shared/pane-hues.ts`, the opacity focus picks, and the fact that the rail
 * is drawn OUT OF FLOW (`absolute` inside a `relative` section) rather than as a border, a padding
 * or a flex sibling — which is the difference between a repaint and a PTY reflow, and the only
 * part of "it does not move the terminal" a DOM test can pin.
 *
 * The expectations read the palette out of `shared/pane-hues.ts` rather than restating it, so a
 * retuned hue moves with the app; what they pin is that pane N draws entry N and no other. jsdom
 * serialises an inline hex as `rgb(...)`, hence `rgb()` below.
 */
describe('pane colour spine (spec §3)', () => {
  const rails = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="pane-rail"]')];
  const chips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="pane-chip"]')];
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

  it('paints each pane\'s rail in that pane index\'s own hue, empty panes included', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null, null] }));
    const { el } = mount(<t.PaneGrid />);
    // Four panes, four rails: the hue belongs to the SLOT, so the two agentless panes have one too.
    expect(rails(el).map((r) => r.style.backgroundColor)).toEqual(PANE_HUES.map(rgb));
    // Decorative — the number is what carries the meaning for anyone who cannot separate the hues.
    expect(rails(el).map((r) => r.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true', 'true']);
  });

  it('holds the focused pane\'s rail at full strength and the rest at 55%', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null, null], focusedIndex: 1 }));
    const { el } = mount(<t.PaneGrid />);
    expect(rails(el).map((r) => r.style.opacity)).toEqual(['0.55', '1', '0.55', '0.55']);
    // The rail follows focus rather than being painted once at mount.
    act(() => t.layout.layoutStore.getState().focusPane(2));
    expect(rails(el).map((r) => r.style.opacity)).toEqual(['0.55', '0.55', '1', '0.55']);
  });

  /**
   * The one thing that would make this feature cost something: three pixels taken off the pane's
   * content box are three pixels off the terminal, which `TerminalView` turns into a column count
   * and a PTY resize. jsdom cannot measure that, so this asserts the contract instead — the rail is
   * absolutely positioned (out of flow, so it occupies no track in the pane's flex column) inside a
   * section that is its containing block, and the terminal's own box is untouched beside it.
   */
  it('draws the rail out of flow, in a relative pane, so no box moves', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1', { activity: 'idle' }) } }, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    const section = el.querySelector('section') as HTMLElement;
    const rail = rails(el)[0] as HTMLElement;
    expect(section.className).toContain('relative');
    expect(rail.className).toContain('absolute');
    expect(rail.className).toContain('inset-y-0');
    expect(rail.className).toContain('left-0');
    expect(rail.className).toContain('w-[3px]');
    // Those three pixels sit ON TOP of the first terminal column, so a drag started at the very
    // left edge has to pass through the rail to reach xterm.
    expect(rail.className).toContain('pointer-events-none');
    // The pane's in-flow children are the two it always had, in the order it always had them.
    expect([...section.children].filter((c) => c !== rail).map((c) => c.tagName)).toEqual(['HEADER', 'DIV']);
    expect(section.querySelector('.absolute.inset-0')).not.toBeNull();
  });

  it('tints the header chip with the same hue and numbers it from 1', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const { el } = mount(<t.PaneGrid />);
    // One-based because the number IS the ⌘1–⌘4 key, which the tooltip names outright.
    expect(chips(el).map((c) => c.textContent)).toEqual([paneChipLabel(0), paneChipLabel(1)]);
    expect(chips(el).map((c) => c.textContent)).toEqual(['⧉1', '⧉2']);
    expect(chips(el).map((c) => c.style.color)).toEqual([rgb(PANE_HUES[0]), rgb(PANE_HUES[1])]);
    expect(chips(el).map((c) => c.title)).toEqual([`Pane 1 (${String(t.keymap.keyLabel({ kind: 'focus-pane', index: 0 }))})`, 'Pane 2 (⌘2)']);
  });

  /**
   * The chip joins the row `PaneHeader`'s own comment describes, and must not become the thing that
   * squeezes the agent name: it is `shrink-0` (a half-drawn `⧉` says nothing), it sits inside the
   * shrinkable chip container rather than beside the name, and the name keeps the classes that make
   * it the item which never yields.
   */
  it('keeps the chip among the chips, and out of the agent name\'s way', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1'] }));
    const { el } = mount(<t.PaneGrid />);
    const header = el.querySelector('header') as HTMLElement;
    const chip = chips(el)[0] as HTMLElement;
    const branch = header.querySelector('button[title$="click to copy path"]') as HTMLElement;
    const name = header.querySelector('span[title="Double-click to rename"]') as HTMLElement;
    expect(chip.className).toContain('shrink-0');
    expect(chip.parentElement).toBe(branch.parentElement);
    expect(chip.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.className).toContain('shrink-0');
    expect(name.className).toContain('max-w-[45%]');
  });

  // A pane with no agent has no header and therefore no chip — and still renders its own rail and
  // its own prompt rather than throwing on an agent that is not there.
  it('renders an empty pane with a rail, no chip and no crash', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: [null] }));
    const { el, commits } = mount(<t.PaneGrid />);
    expect(commits()).toBe(1);
    expect(rails(el).map((r) => r.style.backgroundColor)).toEqual([rgb(PANE_HUES[0])]);
    expect(chips(el)).toEqual([]);
    expect(el.querySelector('header')).toBeNull();
    expect(el.textContent).toContain('Choose an agent for pane 1');
  });
});

/**
 * The other end of the link: a sidebar row is hovered, and the pane holding that agent answers.
 *
 * The hover itself is written by `AgentRow` and read here, so these drive the store directly —
 * `Sidebar.test.tsx` owns the half that proves a real pointer crossing a real row is what writes
 * it. What this file can hold still is which rails move when it changes, and the cost: a hover is
 * one field on the ui store, and three of the four assertions below are about panes NOT reacting.
 *
 * G66's family again — jsdom has no layout engine, so opacity is read off the inline style rather
 * than from anything computed.
 */
describe('hover links a sidebar row to its pane (spec §3)', () => {
  const opacities = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="pane-rail"]')].map((r) => r.style.opacity);

  it('lifts exactly the hovered agent\'s pane, and puts it back on leave', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2', null], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    expect(opacities(el)).toEqual(['1', '0.55', '0.55']);
    act(() => t.ui.useUi.getState().setHoveredAgent('a2'));
    // Pane 1 only. The focused pane stays at full strength (a lift, never a dim) and the empty
    // pane 2 — which no row can be holding — does not move.
    expect(opacities(el)).toEqual(['1', '1', '0.55']);
    act(() => t.ui.useUi.getState().setHoveredAgent(null));
    expect(opacities(el)).toEqual(['1', '0.55', '0.55']);
  });

  /**
   * The trap in the naive spelling, and the reason `Pane` tests `agentId !== null` before comparing:
   * an empty pane's `agentId` is null and so is `hoveredAgentId` when the pointer is nowhere near
   * the sidebar, so `s.hoveredAgentId === agentId` alone lights every empty pane the moment the
   * page loads — the feature inverted, brightest when nothing at all is being pointed at.
   */
  it('never lights an empty pane, hovered or not', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', null, null], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    expect(opacities(el)).toEqual(['1', '0.55', '0.55']);
    act(() => t.ui.useUi.getState().setHoveredAgent('a2'));
    expect(opacities(el)).toEqual(['1', '0.55', '0.55']);
  });

  // A row whose agent is in no pane still writes the hover (`AgentRow` does not check first), so
  // this is the case where the answer must be "nothing happens" — no rail moves, and, because
  // every pane selects a BOOLEAN about its own agent rather than the raw id, not one of them even
  // re-renders. Selecting `s.hoveredAgentId` out here instead would make this count go up, which
  // is the cheap version of "every open pane re-renders on every row the pointer crosses".
  it('changes nothing, and costs no render, when the hovered agent is in no pane', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', null], focusedIndex: 0 }));
    const { el, commits } = mount(<t.PaneGrid />);
    const before = commits();
    act(() => t.ui.useUi.getState().setHoveredAgent('a2'));
    expect(opacities(el)).toEqual(['1', '0.55']);
    expect(commits()).toBe(before);
  });

  // Focus and hover are independent claims, so the rail must survive losing either one alone.
  it('keeps the rail up while the hovered pane also loses focus', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'], focusedIndex: 1 }));
    const { el } = mount(<t.PaneGrid />);
    act(() => t.ui.useUi.getState().setHoveredAgent('a2'));
    expect(opacities(el)).toEqual(['0.55', '1']);
    act(() => t.layout.layoutStore.getState().focusPane(0));
    expect(opacities(el)).toEqual(['1', '1']);
  });
});

describe('the render-count probe itself', () => {
  // Control. Without this, every "commits === 1" above could mean the probe is simply blind.
  // Measured on this tree with React 19.2.8: the component below renders ~55 times and then React
  // throws "Maximum update depth exceeded", having first logged "The result of getSnapshot should
  // be cached to avoid an infinite loop".
  it('catches a selector that maps over layout.panes — exactly what PaneGrid must not do', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'] }));
    const Looping = (): ReactNode => {
      const ids = t.layout.useLayout((s) => s.layout.panes.map((p) => p ?? ''));
      return <span>{ids.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * G60, first half: the pane header's context menu, dispatched as a REAL bubbling event through the
 * whole mounted `App`. Task 4 shipped with right-click broken on every sidebar row while 633 tests
 * — 8 of which mounted that exact sidebar — stayed green, because not one of them dispatched
 * through the real tree. Nothing above the pane header handles `contextmenu` today; these tests are
 * what makes that stay true.
 */
describe('context menu routing (bubbling through the real tree)', () => {
  async function mountApp(layout: Partial<Layout>) {
    const t = await load({
      'workspace:get': snapshotWith({}, layout),
      'config:get': defaultAppConfig('/bin/zsh'),
      'layout:set': undefined,
      'agent:markOpened': undefined,
      'app:windowFocused': undefined,
    });
    const { el } = mount(<t.App />);
    await act(async () => undefined);
    return { t, el };
  }

  /** The leaf element inside `scope` whose visible text is exactly `text` — what the pointer is over. */
  function leafWithin(scope: HTMLElement, text: string): HTMLElement {
    const found = [...scope.querySelectorAll<HTMLElement>('*')].find((n) => n.children.length === 0 && n.textContent?.trim() === text);
    if (!found) throw new Error(`no leaf element with text "${text}"`);
    return found;
  }

  const rightClick = (node: HTMLElement): void => {
    act(() => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
  };

  it('right-clicking the agent name in a pane header opens the AGENT menu', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    const main = el.querySelector('main') as HTMLElement;
    rightClick(leafWithin(main, 'alpha'));
    const labels = (t.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label);
    // The SAME list the sidebar row builds — `agentMenuItems`, not a second menu that can drift.
    expect(labels).toContain('Open in new pane');
    expect(labels).toContain('Copy worktree path');
    expect(labels).toContain('Delete…');
    // Deliberately NOT spelled "Add project…": that label belongs to the sidebar background menu,
    // where it registers a git repository with Hangar, and it is what the next assertion uses to
    // prove no ancestor stole this menu. This one adds a second worktree to THIS agent (§10.3).
    expect(labels).toContain('Add project to this agent…');
    // If an ancestor were to steal this the way `Sidebar`'s `<aside>` stole the row's, these are
    // what would arrive instead.
    expect(labels).not.toContain('Add project…');
  });

  it('opens the add-workspace dialog for the agent whose menu it is', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    const main = el.querySelector('main') as HTMLElement;
    rightClick(leafWithin(main, 'alpha'));
    const item = (t.ui.useUi.getState().contextMenu?.items ?? []).find((i) => i.label === 'Add project to this agent…');
    act(() => item?.onSelect?.());
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'add-workspace', agentId: 'a1' });
  });

  it('right-clicking the branch chip in a pane header opens the same menu', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    const main = el.querySelector('main') as HTMLElement;
    rightClick(leafWithin(main, 'hangar/alpha'));
    expect((t.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label)).toContain('Delete…');
  });

  // The other half of the fix: "the header owns the event" must not become "no one else may have
  // one". The sidebar's own menus still have to work with the pane grid mounted beside them.
  it('leaves the sidebar background menu alone', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    rightClick(el.querySelector('aside') as HTMLElement);
    expect((t.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label)).toEqual(['New agent', 'New folder', 'Add project…', 'Project settings']);
  });

  /**
   * The one that is not blind. Nothing above the pane header handles `contextmenu` TODAY, so
   * deleting `stopPropagation()` from `PaneHeader` breaks none of the tests above — measured: 36
   * passed with it removed. That is exactly the state Task 4 shipped in, one ancestor handler away
   * from every pane action being unreachable by right-click.
   *
   * So this mounts the grid under a React ancestor that handles the same event the way `Sidebar`'s
   * `<aside>` does, and asserts the header still wins. React attaches at the root and replays the
   * synthetic event down its own tree, so a REACT ancestor is the shape that matters here; a native
   * `addEventListener` on a DOM ancestor fires before React's root listener and would test the
   * opposite ordering. Removing `stopPropagation()` from `PaneHeader` fails this test alone.
   */
  it('keeps its menu when an ancestor handles contextmenu too', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1'] }));
    const stolen: string[] = [];
    const { el } = mount(
      <div onContextMenu={() => void stolen.push('ancestor')}>
        <t.PaneGrid />
      </div>,
    );
    rightClick(leafWithin(el, 'alpha'));
    expect(stolen).toEqual([]);
    expect((t.ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label)).toContain('Delete…');
  });

  it('leaves the empty pane without a menu of its own rather than borrowing one', async () => {
    const { t, el } = await mountApp({ panes: [null] });
    const main = el.querySelector('main') as HTMLElement;
    rightClick(leafWithin(main, 'Choose an agent for pane 1'));
    expect(t.ui.useUi.getState().contextMenu).toBeNull();
  });
});

/**
 * G60, second half — the ancestor is `Pane` itself. §12.3: "clicking anywhere in a pane focuses
 * it", and `Pane` implements that with `onMouseDownCapture` rather than `onMouseDown` for a reason
 * the last test here pins down. React attaches at the ROOT, so a bubbling handler never sees an
 * event a descendant stopped — over most of the pane's area, which from Task 6 is a live xterm.
 *
 * Corrected in Task 6 after measuring it: xterm 6.0.0 does not itself stop propagation of
 * mousedown, so the terminal is not the live offender the original wording claimed. The last test
 * stands in for one, and it is the only test that fails on a revert to `onMouseDown`.
 */
describe('pane focus routing (bubbling through the real tree)', () => {
  const mouseDown = (node: HTMLElement): void => {
    act(() => void node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  };

  it('focuses the pane a mousedown lands in', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1'), a2: session('a2') } }, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    const second = el.querySelectorAll('section')[1] as HTMLElement;
    mouseDown(second.querySelector('button') as HTMLElement);
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });

  // Capture is additive, not a steal: the header button still runs its own handler.
  it('does not swallow the click it focuses on', async () => {
    const t = await withSnapshot(snapshotWith({}, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    const close = [...el.querySelectorAll<HTMLButtonElement>('button[title^="Close pane"]')][1];
    mouseDown(close as HTMLElement);
    act(() => close?.click());
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1']);
  });

  // The reason for `onMouseDownCapture`. Reverting it to `onMouseDown` fails this test alone.
  it('still focuses when a descendant stops propagation, the way xterm does', async () => {
    const t = await withSnapshot(snapshotWith({ sessions: { a1: session('a1'), a2: session('a2') } }, { panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.PaneGrid />);
    const second = el.querySelectorAll('section')[1] as HTMLElement;
    const body = second.querySelector('.relative') as HTMLElement;
    body.addEventListener('mousedown', (e) => e.stopPropagation());
    const leaf = document.createElement('span');
    body.appendChild(leaf);
    mouseDown(leaf);
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });
});
