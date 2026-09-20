/**
 * The sidebar is the first thing in this app that subscribes a COMPONENT to a zustand store, so it
 * is the first thing that can hang React.
 *
 * zustand 5 hands a selector straight to `useSyncExternalStore`, which requires a referentially
 * stable snapshot: React re-runs the selector after each commit and commits again whenever the
 * result differs by identity. `buildRows(ws, query)` returns a fresh array on every call, so
 * `useWorkspace((s) => buildRows(s.snapshot.workspace, query))` — the obvious way to write `Tree` —
 * is an infinite loop rather than a wasted allocation. Task 2 hit exactly this in `useSession` and
 * measured 55 renders before React threw "Maximum update depth exceeded"; `tsc`, `eslint` and the
 * pure unit tests were all green the whole time it was live.
 *
 * So this file mounts the REAL components on a REAL React root and counts commits with a
 * `<Profiler>`. The last test is the control: it mounts a component whose selector allocates, and
 * asserts the harness blows up — without it, "commits === 1" could just mean the probe is blind.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import { PANE_HUES, paneChipLabel } from '../../../../shared/pane-hues.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Folder, type Project, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const folder = (id: string, name: string, parentId: string | null, sortKey: number): Folder => ({ id, name, parentId, sortKey, collapsed: false });

const agent = (id: string, name: string, folderId: string | null, sortKey: number): Agent => ({
  id, name, slug: name.toLowerCase(), folderId, sortKey,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `hangar/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

function snapshotWith(patch: Partial<WorkspaceSnapshot['workspace']>): WorkspaceSnapshot {
  return {
    workspace: { ...emptyWorkspace(), layout: defaultLayout(), ...patch },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

/** Two folders, three agents, one loose agent: enough shape that nesting and ordering are visible. */
const POPULATED = snapshotWith({
  projects: [project('p1', 'hangar')],
  folders: [folder('f1', 'Billing', null, 0), folder('f2', 'Nested', 'f1', 0)],
  agents: [agent('a1', 'alpha', 'f1', 1), agent('a2', 'beta', 'f2', 0), agent('a3', 'gamma', null, 1)],
});

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — hence `vi.resetModules()` plus dynamic imports, the same dance
 * `api.test.ts` and `bootstrap.test.ts` use. It also means each `load()` gets FRESH store
 * instances, which is what keeps these tests independent of one another.
 */
async function load(reply: WorkspaceSnapshot | null) {
  // Typed as the real `HangarBridge` with no `as unknown as` escape hatch, so a change to the
  // bridge's shape fails here rather than being absorbed. The mapped `replies` table is what lets
  // `invoke` stay generic without a cast: indexing it with `K` yields `IpcRequests[K]['res'] |
  // undefined` directly.
  // `config:get` joined this table in Task 5, where `bootstrap()` started loading `config.json`
  // (§6.7) for `TerminalView`'s font and scrollback. Without a stub the store's `run` routes the
  // failure to the error sink, which is a real toast in the tree these tests count commits on.
  const replies: { [K in IpcRequestKey]?: IpcRequests[K]['res'] } = reply === null ? {} : { 'workspace:get': reply, 'config:get': defaultAppConfig('/bin/zsh') };
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const bridge: HangarBridge = {
    // The conditional rest tuple has to be spelled out even though nothing here reads the payload:
    // omitting it typechecks under vitest (which does not typecheck at all) and fails `tsc -p
    // tsconfig.web.json` with TS2322, "Source has 2 element(s) but target allows only 1".
    invoke<K extends IpcRequestKey>(channel: K, ..._args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      const value = replies[channel];
      if (value === undefined) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return Promise.resolve({ ok: true, value });
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      // The one narrowing this file cannot express: a single Map holding handlers for eight
      // different payload types. It hides nothing about any interface — `emit` below is typed
      // per-key on the way back out.
      const erased = handler as (payload: never) => void;
      const list = listeners.get(channel) ?? [];
      list.push(erased);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [{ Sidebar }, { App }, workspace, ui, layout, keymap] = await Promise.all([
    import('./Sidebar.tsx'),
    import('../../App.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/ui.ts'),
    import('../../stores/layout.ts'),
    import('../../lib/keymap.ts'),
  ]);
  return {
    Sidebar,
    App,
    workspace,
    ui,
    layout,
    keymap,
    emit: <K extends IpcEventKey>(channel: K, payload: IpcEvents[K]): void => {
      for (const h of listeners.get(channel) ?? []) (h as unknown as (p: IpcEvents[K]) => void)(payload);
    },
  };
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

describe('Sidebar', () => {
  it('renders the tree: a row per folder and per agent, nested children included', async () => {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { el } = mount(<Sidebar />);
    const text = el.textContent ?? '';
    for (const name of ['Billing', 'Nested', 'alpha', 'beta', 'gamma']) expect(text).toContain(name);
    // The branch subtitle proves the row rendered its agent, not just its name.
    expect(text).toContain('hangar/alpha');
    // Placeholder copy from Task 1's shell must be gone — this is the task that makes the sidebar real.
    expect(text).not.toContain('sidebar');
  });

  // THE test for this task. `buildRows` allocates, so `Tree` must select the stable snapshot and
  // derive with `useMemo`. One commit for the mount is all a populated tree may cost.
  it('does not loop React: mounting a populated tree commits exactly once', async () => {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { commits } = mount(<Sidebar />);
    expect(commits()).toBe(1);
  });

  // StrictMode double-invokes render, so a selector that allocates fails here even louder. The app
  // itself does not use StrictMode (G26: it would attach every terminal twice), but running the
  // sidebar under it is free extra pressure on exactly the invariant this file exists to protect.
  //
  // `mountStrict`, not `mount(<StrictMode>…</StrictMode>)` — the nesting is what decides whether
  // the mount EFFECT doubles as well as render (G65). Nothing in the sidebar tree has a
  // side-effecting mount effect (measured: zero IPC calls across the double mount), so what this
  // test buys is still the render half; the correction just makes the spelling honest.
  it('does not loop React under StrictMode either', async () => {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { commits } = mountStrict(<Sidebar />);
    expect(commits()).toBeLessThanOrEqual(2);
  });

  it('settles after a search: filtering the tree costs a bounded number of commits', async () => {
    const { Sidebar, workspace, ui } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { el, commits } = mount(<Sidebar />);
    const afterMount = commits();
    act(() => ui.useUi.getState().setSearch('alph'));
    expect(commits() - afterMount).toBeLessThanOrEqual(2);
    const text = el.textContent ?? '';
    expect(text).toContain('alpha');
    // Search flattens to matching agents only: no folders, no non-matching agents (lib/tree.ts).
    expect(text).not.toContain('beta');
    expect(text).not.toContain('Billing');
  });

  /**
   * The search box's hint and `lib/keymap.ts` are one decision spelled in two places, and a stale
   * hint is worse than none: Plan 05 Task 1 moved ⌘K to the quick switcher (spec §12.3 wrote it as
   * Phase 1's stopgap) and the sidebar search to ⌘⇧K. Pinned here so the label cannot drift back.
   */
  it('advertises ⌘⇧K, the shortcut that actually focuses it', async () => {
    const { Sidebar, workspace, keymap } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { el } = mount(<Sidebar />);
    const box = el.querySelector('input');
    expect(box?.getAttribute('placeholder')).toBe('Search agents  ⌘⇧K');
    expect(keymap.matchKeymap({ key: 'K', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }, false)).toEqual({ kind: 'focus-search' });
  });

  it('offers "Add project…" instead of a tree when there are no projects', async () => {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(snapshotWith({}));
    const { el } = mount(<Sidebar />);
    expect(el.textContent ?? '').toContain('Add project');
  });

  it('marks unread agents and counts them on their ancestor folders', async () => {
    const { Sidebar, workspace } = await load(null);
    const unread = { ...initialSessionState('a2'), unread: true };
    workspace.useWorkspace.getState().setSnapshot({ ...POPULATED, sessions: { a2: unread } });
    const [{ useSessions }] = await Promise.all([import('../../stores/sessions.ts')]);
    useSessions.getState().setAll({ a2: unread });
    const { el } = mount(<Sidebar />);
    // a2 lives in f2, which is inside f1 — `ancestorsOf` walks up, so BOTH folders show the badge.
    expect((el.textContent ?? '').match(/1/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('App', () => {
  it('boots, takes the snapshot from workspace:get and renders the real sidebar', async () => {
    const { App } = await load(POPULATED);
    const { el, commits } = mount(<App />);
    // `bootstrap()` runs in an effect and the reply is a resolved promise: one flush is enough.
    await act(async () => undefined);
    const text = el.textContent ?? '';
    expect(text).toContain('alpha');
    // Task 5 replaced the `<main>` placeholder ("3 agents") with the real pane grid. `POPULATED`
    // carries `defaultLayout()`, whose single pane is empty, so this is what the grid renders.
    expect(text).toContain('Choose an agent for pane 1');
    expect(text).toContain('host: connected');
    // Mount, effect, snapshot. Anything unbounded here is the loop.
    expect(commits()).toBeLessThanOrEqual(4);
  });
});

/**
 * Spec §3's colour spine, the sidebar half: the rail a pane wears down its left edge, drawn again
 * on the row of the agent that pane is holding.
 *
 * The rule here is the INVERSE of the pane's, and that is the thing worth pinning. A pane always
 * has a hue, empty or not, because the hue names the pane; a row only borrows one while it holds a
 * pane, because forty coloured rows would say nothing. So every test below has a negative half.
 *
 * G66's family: jsdom has no layout engine, so nothing here measures three pixels, an edge or an
 * indent. What it reads is the rendered inline style and the classes the geometry is made of.
 */
describe('the row rail (spec §3)', () => {
  /** `rgb(...)`, which is how jsdom serialises an inline hex. */
  const triple = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');

  /** The agent row containing the leaf whose text is `name` — `.group` belongs to `AgentRow` alone. */
  function rowFor(el: HTMLElement, name: string): HTMLElement {
    const leaf = [...el.querySelectorAll<HTMLElement>('*')].find((n) => n.children.length === 0 && n.textContent?.trim() === name);
    const row = leaf?.closest<HTMLElement>('.group');
    if (!row) throw new Error(`no agent row for "${name}"`);
    return row;
  }

  const rail = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-testid="row-rail"]');
  const chip = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-testid="row-pane-chip"]');

  /** `alpha` in pane 1 and `gamma` in pane 0 — deliberately not in row order, so a rail that read
   *  its hue off the row's position instead of the pane's would come out swapped. */
  async function withPanes() {
    const t = await load(null);
    t.workspace.useWorkspace.getState().setSnapshot(POPULATED);
    t.layout.layoutStore.getState().hydrate({ ...defaultLayout(), panes: ['a3', 'a1'], focusedIndex: 0 });
    return { ...t, ...mount(<t.Sidebar />) };
  }

  it('draws a rail on the rows that hold a pane, in that pane\'s own hue', async () => {
    const { el } = await withPanes();
    expect(rail(rowFor(el, 'alpha'))?.style.backgroundColor).toBe(`rgb(${triple(PANE_HUES[1])})`);
    expect(rail(rowFor(el, 'gamma'))?.style.backgroundColor).toBe(`rgb(${triple(PANE_HUES[0])})`);
    // Decorative: the chip beside it is the text that carries the same fact.
    expect(rail(rowFor(el, 'alpha'))?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves a row with no pane completely unmarked — no rail, no chip', async () => {
    const { el } = await withPanes();
    expect(rail(rowFor(el, 'beta'))).toBeNull();
    expect(chip(rowFor(el, 'beta'))).toBeNull();
    // And exactly two rails in the whole tree: the two panes that are open, and nothing else.
    expect(el.querySelectorAll('[data-testid="row-rail"]').length).toBe(2);
  });

  it('keeps the sidebar quiet when no agent is in a pane at all', async () => {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { el } = mount(<Sidebar />);
    expect(el.querySelectorAll('[data-testid="row-rail"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="row-pane-chip"]').length).toBe(0);
  });

  it('tints the ⧉N chip to the same hue and numbers it from 1', async () => {
    const { el } = await withPanes();
    const alpha = chip(rowFor(el, 'alpha')) as HTMLElement;
    expect(alpha.textContent).toBe(paneChipLabel(1));
    expect(alpha.textContent).toBe('⧉2');
    expect(chip(rowFor(el, 'gamma'))?.textContent).toBe('⧉1');
    // Same hue as the rail beside it, over a translucent wash of itself — the pane header's chip
    // is built from the same two values, so the two copies of `⧉2` cannot drift apart.
    expect(alpha.style.color).toBe(`rgb(${triple(PANE_HUES[1])})`);
    expect(alpha.style.backgroundColor).toContain(triple(PANE_HUES[1]));
    expect(alpha.style.backgroundColor).toMatch(/^rgba\(/);
    // The old flat `bg-bg-3`/`text-fg-2` are gone rather than sitting under the inline style.
    expect(alpha.className).not.toContain('bg-bg-3');
    expect(alpha.className).not.toContain('text-fg-2');
  });

  /** Out of flow, like the pane's: the row's left padding is `10 + depth * 14`, so a border or a
   *  flex sibling would knock every nested label three pixels out of line with the rows above it. */
  it('draws the rail out of flow at the row\'s left edge', async () => {
    const { el } = await withPanes();
    const row = rowFor(el, 'alpha');
    const bar = rail(row) as HTMLElement;
    expect(row.className).toContain('relative');
    expect(bar.className).toContain('absolute');
    expect(bar.className).toContain('inset-y-0');
    expect(bar.className).toContain('left-0');
    expect(bar.className).toContain('w-[3px]');
    // Three pixels of decoration must not swallow a click on the row.
    expect(bar.className).toContain('pointer-events-none');
  });
});

/**
 * The hover half of §3 — "sweeping the sidebar makes the matching pane answer" — driven the way
 * the user drives it: real bubbling pointer events at the leaf the pointer would actually be over,
 * through a mounted `App`, asserting on the store and on the pane's rendered rail. Mounting
 * `AgentRow` and calling its handler would prove only that the handler exists (G60's lesson).
 *
 * **And the cost.** `hoveredAgentId` changes on every row the pointer crosses, which makes it the
 * worst field in the ui store to read carelessly: a selector that allocates hangs React (G59/G61),
 * and even a stable one that returns the raw id re-renders every row in the tree on every move.
 * So the sidebar writes it and never reads it, and the commit counter below is what says so.
 */
describe('hovering a row, and the pane answering', () => {
  const POPULATED_WITH_PANES = snapshotWith({
    projects: [project('p1', 'hangar')],
    folders: [folder('f1', 'Billing', null, 0), folder('f2', 'Nested', 'f1', 0)],
    agents: [agent('a1', 'alpha', 'f1', 1), agent('a2', 'beta', 'f2', 0), agent('a3', 'gamma', null, 1)],
    // gamma in pane 0 (focused), alpha in pane 1, beta in none.
    layout: { ...defaultLayout(), panes: ['a3', 'a1'], focusedIndex: 0 },
  });

  function leafWithText(root: HTMLElement, text: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>('*')].find((n) => n.children.length === 0 && n.textContent?.trim() === text);
    if (!found) throw new Error(`no leaf element with text "${text}"`);
    return found;
  }

  /** React synthesises `onPointerEnter`/`onPointerLeave` from the native over/out pair, so these
   *  are the events a browser really sends; `relatedTarget` is what tells React where the pointer
   *  came from and therefore which enters and leaves to fire. */
  const pointerOver = (node: HTMLElement, from: HTMLElement | null = null): void => {
    act(() => void node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: from })));
  };
  const pointerOut = (node: HTMLElement, to: HTMLElement | null = null): void => {
    act(() => void node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: to })));
  };

  async function mountApp() {
    const t = await load(POPULATED_WITH_PANES);
    const { el, commits } = mount(<t.App />);
    await act(async () => undefined);
    return { ...t, el, commits };
  }

  const railOpacities = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="pane-rail"]')].map((r) => r.style.opacity);

  it('lifts exactly the hovered agent\'s pane rail, and drops it again on leave', async () => {
    const { el, ui } = await mountApp();
    // Pane 0 is focused, pane 1 is not: the unfocused 55% is what the hover has to move.
    expect(railOpacities(el)).toEqual(['1', '0.55']);
    pointerOver(leafWithText(el, 'alpha'));
    expect(ui.useUi.getState().hoveredAgentId).toBe('a1');
    expect(railOpacities(el)).toEqual(['1', '1']);
    pointerOut(leafWithText(el, 'alpha'));
    expect(ui.useUi.getState().hoveredAgentId).toBeNull();
    expect(railOpacities(el)).toEqual(['1', '0.55']);
  });

  it('changes nothing anywhere when the hovered agent is in no pane', async () => {
    const { el, ui } = await mountApp();
    pointerOver(leafWithText(el, 'beta'));
    // The row still writes the hover — it is `Pane` that decides nobody matches, which is what
    // keeps the previous row's pane from staying lit after the pointer has moved on.
    expect(ui.useUi.getState().hoveredAgentId).toBe('a2');
    expect(railOpacities(el)).toEqual(['1', '0.55']);
    expect(el.querySelectorAll('[data-testid="row-rail"]').length).toBe(2);
  });

  // Crossing from one row straight to the next: the browser sends the leave of the row being left
  // before the enter of the row being entered, so the unconditional `setHovered(null)` cannot land
  // on top of the new row's write and leave the sidebar pointing at nothing.
  it('follows the pointer from one row to the next without dropping it', async () => {
    const { el, ui } = await mountApp();
    const alpha = leafWithText(el, 'alpha');
    const gamma = leafWithText(el, 'gamma');
    pointerOver(alpha);
    pointerOut(alpha, gamma);
    pointerOver(gamma, alpha);
    expect(ui.useUi.getState().hoveredAgentId).toBe('a3');
    expect(railOpacities(el)).toEqual(['1', '0.55']);
  });

  /**
   * React fires no `pointerleave` for a row that UNMOUNTS under the pointer, so a row filtered away
   * by the search (or hidden with the sidebar, or folded into its folder) used to leave the hover on
   * itself and its pane's rail lit, with nothing under the pointer that could clear it.
   */
  it('lets go of the hover when the hovered row disappears from under the pointer', async () => {
    const { el, ui } = await mountApp();
    pointerOver(leafWithText(el, 'alpha'));
    expect(railOpacities(el)).toEqual(['1', '1']);
    act(() => ui.useUi.getState().setSearch('gamma'));
    expect(el.querySelector('aside')?.textContent).not.toContain('alpha');
    expect(ui.useUi.getState().hoveredAgentId).toBeNull();
    expect(railOpacities(el)).toEqual(['1', '0.55']);
  });

  // The release is for the row's OWN hover. Rows vanishing while another row holds it leave it be.
  it('leaves the hover alone when rows that do not hold it disappear', async () => {
    const { el, ui } = await mountApp();
    pointerOver(leafWithText(el, 'gamma'));
    act(() => ui.useUi.getState().setSearch('gamma'));
    expect(el.querySelector('aside')?.textContent).not.toContain('alpha');
    expect(ui.useUi.getState().hoveredAgentId).toBe('a3');
  });

  /**
   * THE performance test for this task. A hover is a fact about the panes, so the sidebar — every
   * folder, every row, every status dot — must not re-render at all when it changes. Reading
   * `useUi((s) => s.hoveredAgentId)` in `AgentRow` (the obvious spelling, and referentially stable,
   * so G59's loop detector never fires) re-renders the whole tree on every row the pointer crosses,
   * and this counter is the only thing that sees it: measured at +1 commit per hover with that
   * spelling, 0 with the row writing and never reading.
   */
  it('costs the sidebar no renders at all', async () => {
    const t = await load(null);
    t.workspace.useWorkspace.getState().setSnapshot(POPULATED);
    t.layout.layoutStore.getState().hydrate({ ...defaultLayout(), panes: ['a3', 'a1'], focusedIndex: 0 });
    const { el, commits } = mount(<t.Sidebar />);
    const afterMount = commits();
    pointerOver(leafWithText(el, 'alpha'));
    expect(t.ui.useUi.getState().hoveredAgentId).toBe('a1');
    expect(commits()).toBe(afterMount);
    act(() => t.ui.useUi.getState().setHoveredAgent('a2'));
    expect(commits()).toBe(afterMount);
  });
});

describe('the render-count probe itself', () => {
  // Control. Without this, every "commits === 1" above could mean the probe is simply blind.
  // Measured on this tree with React 19.2.8: the component below renders ~55 times and then React
  // throws "Maximum update depth exceeded", having first logged "The result of getSnapshot should
  // be cached to avoid an infinite loop".
  it('catches a selector that allocates a fresh array per call', async () => {
    const { workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const Looping = (): ReactNode => {
      // Exactly the mistake `Tree` avoids: `.filter(...)` (or `buildRows`, or `?? []`) inside the
      // selector returns a new identity every time React re-runs it.
      const names = workspace.useWorkspace((s) => (s.snapshot?.workspace.agents ?? []).filter(() => true));
      return <span>{names.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });

  /**
   * The same control aimed at `hoveredAgentId` in particular, because that is the field this task
   * added and the one that changes most often — once per row the pointer crosses. `Pane` reads it
   * as `agentId !== null && s.hoveredAgentId === agentId`, a boolean; wrapping it in an object or a
   * tuple to carry "who is hovered" alongside "is it me" is the mistake that is easy to make here,
   * and it hangs React rather than costing an allocation. G61's warning applies too: the object is
   * fresh on EVERY path, so unlike a `?? []` fallback this one loops even with the store empty.
   */
  it('catches an object selector over the hover field, which is what Pane must never write', async () => {
    const { ui } = await load(null);
    ui.useUi.getState().setHoveredAgent('a1');
    const Looping = (): ReactNode => {
      const { hoveredAgentId } = ui.useUi((s) => ({ hoveredAgentId: s.hoveredAgentId }));
      return <span>{hoveredAgentId}</span>;
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
 * Mounting a component and asserting its own behaviour cannot see an ANCESTOR handler stealing the
 * event. Every test above passed while right-clicking any row in the built app opened the sidebar's
 * background menu instead of the row's: `Sidebar`'s `<aside>` wraps the whole tree and carries its
 * own `onContextMenu`, the row handlers called `preventDefault()` but not `stopPropagation()`, so
 * the row's `showMenu(...)` ran first and the ancestor's overwrote it. Every per-row action was
 * unreachable by right-click.
 *
 * So these dispatch REAL bubbling events at the deepest node — the text the user actually aims at —
 * through the whole mounted `App`, and assert on what ends up in the store. Recorded as G60.
 */
describe('context menu routing (bubbling through the real tree)', () => {
  /** The leaf element whose visible text is exactly `text` — i.e. what the pointer would be over. */
  function leafWithText(root: HTMLElement, text: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>('*')].find((n) => n.children.length === 0 && n.textContent?.trim() === text);
    if (!found) throw new Error(`no leaf element with text "${text}"`);
    return found;
  }

  async function mountApp() {
    const { App, ui } = await load(POPULATED);
    const { el } = mount(<App />);
    await act(async () => undefined);
    return { el, ui };
  }

  const rightClick = (node: HTMLElement): void => {
    act(() => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
  };

  it('right-clicking an agent row opens the AGENT menu, not the sidebar background menu', async () => {
    const { el, ui } = await mountApp();
    rightClick(leafWithText(el, 'alpha'));
    const labels = (ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label);
    expect(labels).toContain('Open in new pane');
    expect(labels).toContain('Delete…');
    expect(labels).not.toContain('Add project…');
  });

  it('right-clicking a folder row opens the FOLDER menu, not the sidebar background menu', async () => {
    const { el, ui } = await mountApp();
    rightClick(leafWithText(el, 'Billing'));
    const labels = (ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label);
    expect(labels).toContain('New agent here');
    expect(labels).toContain('Delete folder (children move up)');
    expect(labels).not.toContain('Add project…');
  });

  // The other half of the fix: "stop the ancestor winning" must not become "remove the ancestor".
  // Right-clicking the sidebar's own background is how the root menu is reached at all.
  it('right-clicking the sidebar background still opens the ROOT menu', async () => {
    const { el, ui } = await mountApp();
    const aside = el.querySelector('aside');
    expect(aside).not.toBeNull();
    rightClick(aside as HTMLElement);
    const labels = (ui.useUi.getState().contextMenu?.items ?? []).map((i) => i.label);
    expect(labels).toEqual(['New agent', 'New folder', 'Add project…', 'Project settings']);
  });
});

/**
 * The same ancestor-steals-the-event shape one level along, found by sweeping for it rather than by
 * hitting it: `Tree`'s scroll container has an `onDragOver` that calls `preventDefault()` for any
 * drag in progress, and it is the ancestor of every row's own `onDragOver`. A row that REFUSED a
 * drop used to return without stopping propagation, so the container then marked the drop allowed —
 * the cursor read "yes" over a row that would reject it. `onDrop` re-checks `canDrop`, so nothing
 * invalid was ever committed; the bug was a lying cursor, which no store assertion can see.
 */
describe('drag-over routing (bubbling through the real tree)', () => {
  interface FakeDataTransfer {
    dropEffect: string;
    effectAllowed: string;
    setData: (type: string, value: string) => void;
    getData: (type: string) => string;
  }

  function fakeDataTransfer(): FakeDataTransfer {
    const store = new Map<string, string>();
    return {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: (type, value) => void store.set(type, value),
      getData: (type) => store.get(type) ?? '',
    };
  }

  /** jsdom has no `DataTransfer`, and React reads it straight off the native event. */
  function dragEvent(type: string, dt: FakeDataTransfer): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: dt });
    return e;
  }

  function leaf(root: HTMLElement, text: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>('*')].find((n) => n.children.length === 0 && n.textContent?.trim() === text);
    if (!found) throw new Error(`no leaf element with text "${text}"`);
    return found;
  }

  /** Drags `from` onto `over` and reports whether the drop was ultimately marked as allowed. */
  async function dragOnto(from: string, over: string): Promise<boolean> {
    const { Sidebar, workspace } = await load(null);
    workspace.useWorkspace.getState().setSnapshot(POPULATED);
    const { el } = mount(<Sidebar />);
    const dt = fakeDataTransfer();
    act(() => void leaf(el, from).dispatchEvent(dragEvent('dragstart', dt)));
    const ev = dragEvent('dragover', dt);
    act(() => void leaf(el, over).dispatchEvent(ev));
    // jsdom's zero-height getBoundingClientRect makes the pointer ratio NaN, which `dropPosition`
    // resolves to 'into' for a folder and 'after' for an agent — exactly the two cases wanted here.
    return ev.defaultPrevented;
  }

  it('refuses a folder dropped into its own descendant, and the container does not overturn it', async () => {
    // G30: 'Nested' is a child of 'Billing', so this move would corrupt the tree.
    expect(await dragOnto('Billing', 'Nested')).toBe(false);
  });

  it('still allows a legitimate drop', async () => {
    expect(await dragOnto('alpha', 'gamma')).toBe(true);
  });
});

/**
 * The sidebar's own half of a bug found while building the drawer's identical resize handle:
 * `Resizer` creates its `mousemove` listener once per drag, so it used to call the `onResize` from
 * the render that was current at MOUSEDOWN. That callback closes over `width`, and the deltas are
 * incremental, so every step of a drag recomputed from the width the drag started at: measured
 * here at 360 for a 200 px drag in two steps, and 660 instead of 860 through the drawer. The fix
 * is in the shared primitive (a ref holding the latest callbacks); this pins the second call site.
 *
 * One `act` per event, because a browser delivers each `mousemove` in its own task and React has
 * therefore re-rendered before the next arrives. Batching them into a single `act` defers every
 * render to the end and hides exactly what this measures.
 */
describe('resizing', () => {
  it('accumulates the whole drag, not just its last step', async () => {
    const { Sidebar, layout } = await load(null);
    const { el } = mount(<Sidebar />);
    const handle = el.querySelector('.cursor-col-resize');
    expect(handle).not.toBeNull();
    act(() => void (handle as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200 })));
    for (const x of [300, 400]) act(() => void window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x })));
    act(() => void window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(layout.layoutStore.getState().layout.sidebarWidth).toBe(460);
  });

  it('stops at the 480 px maximum §6 gives it', async () => {
    const { Sidebar, layout } = await load(null);
    const { el } = mount(<Sidebar />);
    const handle = el.querySelector('.cursor-col-resize') as HTMLElement;
    act(() => void handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 })));
    act(() => void window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 9000 })));
    act(() => void window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(layout.layoutStore.getState().layout.sidebarWidth).toBe(480);
  });
});
