/**
 * Spec §12.3's ⌘K quick switcher.
 *
 * Three hazards are live in this one component and each has its own block below.
 *
 * **G59/G61** — a filtered, ranked list derived from the workspace is the single worst shape for
 * zustand 5's stable-snapshot rule. `render counts` mounts on a real React root under a
 * `<Profiler>`, with a deliberately-allocating control proving the probe is not blind, and — the
 * half a populated test cannot reach — a mount with NO snapshot at all.
 *
 * **G62/G66** — jsdom implements no `HTMLDialogElement` methods and no focusability rule at all,
 * so `activeElement` here is a statement about what this component CALLS, not about what Chromium
 * would do. The `initial focus` block says exactly what it proves and what it does not.
 *
 * **G60** — the panel's `stopPropagation()` is a guard against the backdrop directly above it, so
 * both halves are asserted with real bubbling events: the panel keeps the switcher open, and the
 * backdrop still closes it.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import {
  defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Layout, type Project, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const agent = (id: string, name: string, patch: Partial<Agent> = {}): Agent => ({
  id, name, slug: name.toLowerCase(), folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null, ...patch,
});

const PROJECTS: Project[] = [project('p1', 'hangar'), project('p2', 'acmeapi')];

/**
 * Deliberately NOT in recency order in the file, so "sorted by `lastOpenedAt` descending" is a
 * claim the tests can fail rather than the order they were written in.
 */
const AGENTS: Agent[] = [
  agent('a1', 'alpha', { lastOpenedAt: '2026-09-01T00:00:00.000Z' }),
  agent('a2', 'beta', { lastOpenedAt: '2026-09-05T00:00:00.000Z' }),
  agent('a3', 'gamma'),                                                    // never opened
  agent('a4', 'delta', { lastOpenedAt: '2026-09-03T00:00:00.000Z', workspaces: [{ id: 'w-a4', projectId: 'p2', branch: 'agent/delta', worktreePath: '/wt/delta', baseRef: 'master', createdAt: ISO }] }),
];

function snapshotWith(agents: Agent[] = AGENTS, layout: Partial<Layout> = {}): WorkspaceSnapshot {
  return {
    workspace: { ...emptyWorkspace(), projects: PROJECTS, agents, layout: { ...defaultLayout(), panes: [null], focusedIndex: 0, ...layout } },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

interface Call { channel: IpcRequestKey; payload: unknown }

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — the `vi.resetModules()` dance every renderer test in this project uses.
 * It also hands each test FRESH stores, which is what keeps them independent.
 *
 * Every request is answered `ok` with `undefined`: the only one this component sends is
 * `agent:markOpened`, whose result type IS void.
 */
async function load() {
  const calls: Call[] = [];
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      return Promise.resolve({ ok: true, value: undefined as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(_channel: K, _handler: (payload: IpcEvents[K]) => void): () => void {
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [switcher, host, workspace, sessions, layout, ui] = await Promise.all([
    import('./QuickSwitcher.tsx'),
    import('./DialogHost.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
  ]);
  return { ...switcher, ...host, workspace, sessions, layout, ui, calls };
}

/** The common case: a snapshot already in the stores, and the switcher raised. */
async function withSnapshot(snap: WorkspaceSnapshot = snapshotWith()) {
  const t = await load();
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.layout.layoutStore.getState().hydrate(snap.workspace.layout);
  t.ui.useUi.getState().openDialog({ kind: 'quick-switcher' });
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

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — that placement is what decides whether effects double-invoke at all (G65,
  // re-measured every run by `components/strict-mode-nesting.test.tsx`).
  act(() => root.render(shell(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>)));
  return { el, commits: () => commits };
}

const mount = (node: ReactNode) => mountWith((n) => n, node);
const mountStrict = (node: ReactNode) => mountWith((n) => <StrictMode>{n}</StrictMode>, node);

/**
 * Types into a CONTROLLED field the way a browser does. React installs its own value setter on the
 * element, so assigning `.value` directly is invisible to it.
 */
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A REAL bubbling keydown at the element the user is typing in — not a call to the prop. */
function press(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void el.dispatchEvent(event));
  return event;
}

/** Likewise for the pointer: `mousedown` is the event both the panel and the backdrop listen for. */
function mouseDown(el: HTMLElement): void {
  act(() => void el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
}

const input = (el: HTMLElement): HTMLInputElement => {
  const found = el.querySelector<HTMLInputElement>('input[aria-label="Jump to agent"]');
  if (found === null) throw new Error('no query field');
  return found;
};

const panel = (el: HTMLElement): HTMLElement => {
  const found = el.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error('no panel');
  return found;
};

const rows = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('li button')];
/**
 * The row's NAME line. `querySelector('span > span')` is wrong here and silently returns '': the
 * status dot is itself a `<span>` wrapping a `<span>`, so it wins document order over the text.
 * Addressed by structure instead — the button's second direct `<span>` child is the text column,
 * and its first child is the name.
 */
const names = (el: HTMLElement): string[] => rows(el).map((b) => {
  const column = [...b.children].filter((c) => c.tagName === 'SPAN')[1];
  return column?.firstElementChild?.textContent ?? '';
});
const selected = (el: HTMLElement): number => rows(el).findIndex((b) => b.getAttribute('aria-selected') === 'true');

describe('list, ranking and filtering', () => {
  it('ranks by lastOpenedAt descending, with never-opened agents last', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    expect(names(el)).toEqual(['beta', 'delta', 'alpha', 'gamma']);
  });

  /**
   * The tiebreak is an explicit `localeCompare` on the name rather than a reliance on `Array.sort`
   * being stable. Three agents that have never been opened all compare `''` against `''`; without
   * the tiebreak this asserts insertion order, which is a property of V8 and of `emptyWorkspace()`,
   * not of the component.
   */
  it('breaks a recency tie by name', async () => {
    const t = await withSnapshot(snapshotWith([agent('a1', 'zulu'), agent('a2', 'mike'), agent('a3', 'alfa')]));
    const { el } = mount(<t.QuickSwitcher />);
    expect(names(el)).toEqual(['alfa', 'mike', 'zulu']);
  });

  it('shows at most 12 agents', async () => {
    const many = Array.from({ length: 30 }, (_, i) => agent(`a${i}`, `agent-${String(i).padStart(2, '0')}`));
    const t = await withSnapshot(snapshotWith(many));
    const { el } = mount(<t.QuickSwitcher />);
    expect(rows(el)).toHaveLength(12);
  });

  /**
   * The reuse claim. `matchesSearch` (lib/tree.ts) is the sidebar's own matcher, and it matches on
   * the agent name, the BRANCH and the PROJECT name — a second ranker written here would have to
   * agree with it about all three, so it does not exist. The project case is the one a name-only
   * filter silently gets wrong: "acmeapi" appears nowhere in `delta` or in `agent/delta`.
   */
  it('filters on name, branch and project name, through the sidebar\'s own matcher', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    type(input(el), 'bet');
    expect(names(el)).toEqual(['beta']);
    type(input(el), 'agent/gamma');
    expect(names(el)).toEqual(['gamma']);
    type(input(el), 'acmeapi');
    expect(names(el)).toEqual(['delta']);
  });

  it('says so when nothing matches', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    type(input(el), 'nothing-like-this');
    expect(rows(el)).toEqual([]);
    expect(el.textContent).toContain('No agents match.');
  });

  it('shows each agent\'s primary branch', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    expect(el.textContent).toContain('agent/beta');
  });

  /**
   * The status dot is driven by the sessions store, and an agent with no entry there is `stopped`
   * (§6.5) rather than a crash. Both halves in one test because they share the same lookup.
   */
  it('shows a live status dot, and treats an agent absent from the store as stopped', async () => {
    const t = await withSnapshot();
    act(() => t.sessions.useSessions.getState().setOne('a2', { ...initialSessionState('a2'), activity: 'working' }));
    const { el } = mount(<t.QuickSwitcher />);
    const titles = [...el.querySelectorAll('li span[title]')].map((s) => s.getAttribute('title'));
    expect(titles[0]).toBe('Working');
    expect(titles[1]).toBe('Stopped');
  });
});

describe('keyboard', () => {
  it('moves the highlight with the arrows and stops at both ends', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    expect(selected(el)).toBe(0);
    press(input(el), { key: 'ArrowUp' });
    expect(selected(el)).toBe(0);
    press(input(el), { key: 'ArrowDown' });
    press(input(el), { key: 'ArrowDown' });
    expect(selected(el)).toBe(2);
    press(input(el), { key: 'ArrowUp' });
    expect(selected(el)).toBe(1);
    for (let i = 0; i < 10; i += 1) press(input(el), { key: 'ArrowDown' });
    expect(selected(el)).toBe(3);
  });

  /**
   * Without `preventDefault` the arrows move the caret inside the field (Home/End behaviour on
   * macOS) and scroll the list container, and Enter is a submit in any browser that decides this
   * input belongs to a form. Asserted on the event rather than on a spy, so it is the real
   * `defaultPrevented` a browser would see.
   */
  it('takes the arrows and Enter away from the field\'s own defaults', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(press(input(el), { key }).defaultPrevented).toBe(true);
    }
  });

  it('leaves ordinary typing alone', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    expect(press(input(el), { key: 'a' }).defaultPrevented).toBe(false);
    expect(press(input(el), { key: 'Backspace' }).defaultPrevented).toBe(false);
  });

  /**
   * The ArrowDown bound, isolated from the render-time clamp — two guards that would otherwise
   * mask each other, which is exactly the pair this project has shipped twice before.
   *
   * The clamp (`Math.min(index, items.length - 1)`) hides an over-run for as long as the list stays
   * the size it was, so dropping the bound in the handler survives every other test here. It stops
   * hiding it when the list GROWS: an `index` parked at 5 by five ArrowDowns on a one-row list is
   * still 5 when a snapshot adds three more agents, and the highlight jumps to the last row the
   * user never asked for. Measured: with the bound the highlight stays on row 0; without it, row 3.
   */
  it('does not arm the highlight past the end for a list that later grows', async () => {
    const t = await withSnapshot(snapshotWith([agent('a1', 'alpha')]));
    const { el } = mount(<t.QuickSwitcher />);
    for (let i = 0; i < 5; i += 1) press(input(el), { key: 'ArrowDown' });
    expect(selected(el)).toBe(0);
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith(AGENTS)));
    expect(rows(el)).toHaveLength(4);
    expect(selected(el)).toBe(0);
  });

  it('resets the highlight when the query changes', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    press(input(el), { key: 'ArrowDown' });
    expect(selected(el)).toBe(1);
    type(input(el), 'a');
    expect(selected(el)).toBe(0);
  });

  it('opens the highlighted agent in the focused pane, closes, and marks it opened', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    press(input(el), { key: 'ArrowDown' });   // 'delta'
    press(input(el), { key: 'Enter' });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a4']);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.calls).toEqual([{ channel: 'agent:markOpened', payload: { id: 'a4' } }]);
  });

  it('opens in a NEW pane with ⌘Enter', async () => {
    const t = await withSnapshot(snapshotWith(AGENTS, { panes: ['a1'], focusedIndex: 0 }));
    const { el } = mount(<t.QuickSwitcher />);
    press(input(el), { key: 'Enter', metaKey: true });   // 'beta', the most recent
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
  });

  it('closes on Escape without opening anything', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    press(input(el), { key: 'Escape' });
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.layout.layoutStore.getState().layout.panes).toEqual([null]);
    expect(t.calls).toEqual([]);
  });

  it('does nothing on Enter with an empty list', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    type(input(el), 'nothing-like-this');
    press(input(el), { key: 'Enter' });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
    expect(t.calls).toEqual([]);
  });

  it('opens an agent on click, and in a new pane on ⌘click', async () => {
    const t = await withSnapshot(snapshotWith(AGENTS, { panes: ['a1'], focusedIndex: 0 }));
    const { el } = mount(<t.QuickSwitcher />);
    // Row 1 is 'delta'. Row 2 is 'alpha', which is ALREADY in pane 0 — "an agent appears at most
    // once" (§12.3), so that row would focus the existing pane and prove nothing about ⌘click.
    act(() => { rows(el)[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a4']);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('follows the mouse with the highlight', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    act(() => { rows(el)[2]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(selected(el)).toBe(2);
  });
});

/**
 * The clamp, which no `[query]` reset can stand in for: `items` also shrinks when a snapshot
 * arrives with an agent deleted, and the highlight is then past the end of the list.
 *
 * Reverting `const active = items.length === 0 ? 0 : Math.min(index, items.length - 1)` to a bare
 * `index` fails this test alone — `items[3]` is `undefined`, `choose` returns early, and Enter is
 * a dead key on a switcher that looks perfectly normal.
 */
describe('a snapshot that shrinks the list while the switcher is open', () => {
  it('keeps the highlight inside the list', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    for (let i = 0; i < 3; i += 1) press(input(el), { key: 'ArrowDown' });
    expect(selected(el)).toBe(3);
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith([agent('a1', 'alpha')])));
    expect(names(el)).toEqual(['alpha']);
    expect(selected(el)).toBe(0);
    press(input(el), { key: 'Enter' });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1']);
  });
});

/**
 * G60, in the direction where the guard is the right answer rather than the wrong one.
 *
 * The backdrop's `onMouseDown={close}` is a direct ANCESTOR of everything in the panel, so without
 * `stopPropagation()` on the panel every mousedown in the switcher — including the one that puts
 * the caret in the query field — closes it. Both halves are asserted with real bubbling events so
 * the fix cannot become "delete the backdrop handler".
 *
 * Reverting `onMouseDown={(e) => e.stopPropagation()}` on the panel fails the first two
 * expectations here and nothing else in the suite.
 */
describe('backdrop and panel (G60)', () => {
  it('stays open for a mousedown inside the panel and closes for one on the backdrop', async () => {
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    mouseDown(input(el));
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
    mouseDown(rows(el)[0] as HTMLElement);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
    const backdrop = el.querySelector<HTMLElement>('[data-testid="quick-switcher-backdrop"]');
    if (backdrop === null) throw new Error('no backdrop');
    mouseDown(backdrop);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });
});

/**
 * G62/G66 — what these two tests prove, and what they cannot.
 *
 * They PROVE: the component calls `.focus()` on its query field during mount (jsdom's `focus()`
 * does move `activeElement` on an `<input>`, and the control below shows the assertion fails when
 * nothing calls it); and that the query field is the FIRST focusable element in the panel, with no
 * Close button ahead of it — the DOM-order property that made `ui/Dialog.tsx` focus its header
 * Close button before G62 was found.
 *
 * They do NOT prove that Chromium focuses it. jsdom implements no focusability rule at all (G66:
 * `focus()` on a bare `<div>` moves `activeElement` there) and no `HTMLDialogElement` behaviour
 * (G62), so real focus is a CDP question, not a jsdom one. What removes the G62 risk here is
 * structural rather than tested: this component is not a `<dialog>` and nothing calls
 * `showModal()`, so there are no dialog focusing steps to run after the mount effect and overwrite
 * it.
 */
describe('initial focus', () => {
  it('focuses the query field on mount', async () => {
    const t = await withSnapshot();
    expect(document.activeElement).toBe(document.body);
    const { el } = mount(<t.QuickSwitcher />);
    expect(document.activeElement).toBe(input(el));
  });

  /**
   * The control. Same markup, no mount effect: if jsdom focused the first input on its own, or if
   * `activeElement` reported the field for any reason other than the component's own call, this
   * would pass too.
   */
  it('does not focus a query field nothing focuses', () => {
    const Inert = (): ReactNode => (
      <div>
        <input aria-label="Jump to agent" readOnly value="" />
      </div>
    );
    const { el } = mount(<Inert />);
    expect(input(el)).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('puts the query field first in the panel, with no Close button ahead of it', async () => {
    // An independent copy of `ui/Dialog.tsx`'s list on purpose: sharing it would let this pass
    // whenever the production selector is wrong in the same way.
    const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const t = await withSnapshot();
    const { el } = mount(<t.QuickSwitcher />);
    expect(panel(el).querySelector(FOCUSABLE)).toBe(input(el));
    expect(panel(el).querySelector('button[aria-label="Close"]')).toBeNull();
  });
});

/**
 * G59/G61. zustand 5 hands the selector to `useSyncExternalStore`, which re-runs it after every
 * commit and commits again whenever the identity differs — so `.filter(...)`, `.map(...)`, `?? []`
 * and object literals in a selector are an infinite render loop, measured at ~55 renders on this
 * project before React throws, with `tsc`, `eslint` and every pure unit test green throughout.
 *
 * This component is the shape the gotcha is written about: a filtered, ranked list derived from the
 * workspace. Every derivation happens in a `useMemo` BELOW three selectors that each return a
 * stored reference.
 */
describe('render counts', () => {
  it('commits once, and does not loop under StrictMode', async () => {
    const t = await withSnapshot();
    const plain = mount(<t.QuickSwitcher />);
    expect(plain.commits()).toBe(1);
    const strict = mountStrict(<t.QuickSwitcher />);
    expect(strict.commits()).toBeLessThanOrEqual(2);
  });

  /**
   * The pre-bootstrap case, and the one a populated mount cannot reach (G61).
   *
   * `useWorkspace((s) => s.snapshot?.workspace.agents ?? [])` returns the stored array once a
   * snapshot exists and allocates nothing, so every test above passes with that selector in place;
   * it allocates exactly when the left side is nullish, which is this test — ⌘K pressed before
   * `bootstrap()`'s `workspace:get` has answered. The `NO_AGENTS` constant in QuickSwitcher.tsx is
   * the same hoist for the `useMemo`'s empty path.
   */
  it('commits once with no snapshot at all — the pre-bootstrap ⌘K', async () => {
    const t = await load();
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    const plain = mount(<t.QuickSwitcher />);
    expect(plain.commits()).toBe(1);
    expect(plain.el.textContent).toContain('No agents match.');
    const strict = mountStrict(<t.QuickSwitcher />);
    expect(strict.commits()).toBeLessThanOrEqual(2);
  });

  it('commits once for the whole DialogHost with the switcher open', async () => {
    const t = await withSnapshot();
    const { el, commits } = mount(<t.DialogHost />);
    expect(commits()).toBe(1);
    expect(input(el)).not.toBeNull();
  });

  /**
   * The 1 s ticker (stores/sessions.ts) runs while the switcher is open, and this component
   * subscribes to the whole `sessions` record. `tick` returns the SAME object when nothing moved,
   * so zustand's `Object.is` check means no notification and no commit. Without that, a palette
   * would re-render every second for as long as it is open.
   */
  it('costs nothing when a tick moves no session', async () => {
    const t = await withSnapshot();
    const { commits } = mount(<t.QuickSwitcher />);
    const before = commits();
    act(() => t.sessions.useSessions.getState().tick(Date.now()));
    expect(commits() - before).toBe(0);
  });

  /**
   * The control. Without it, "commits === 1" above could just mean the probe is blind — two tasks
   * on this project shipped selector loops past green suites. The selector is the exact shape this
   * component invites: "the agents that match, or an empty list".
   */
  it('catches a selector that allocates — exactly what this component must not do', async () => {
    const t = await withSnapshot();
    const Looping = (): ReactNode => {
      const agents = t.workspace.useWorkspace((s) => s.snapshot?.workspace.agents.filter(() => true) ?? []);
      return <span>{agents.length}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});
