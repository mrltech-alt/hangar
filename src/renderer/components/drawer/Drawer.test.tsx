/**
 * The drawer, and in particular the one piece of Phase-1 logic in it that is not chrome: the Notes
 * tab's autosave, which shares a single string with the agent running in the pane. `hangar note`
 * writes `agent.notes` while the human is typing into the same textarea, so "500 ms debounce" is
 * only a third of the behaviour — the focus guard, the reload chip and the pane-switch flush are
 * the rest, and each is a race rather than a rendering detail.
 *
 * The two standing renderer hazards are both live here:
 *
 * **G59** — every store-subscribing component gets a commit count on a real React root under a
 * `<Profiler>`, with a control that mounts a deliberately-allocating selector and asserts the
 * harness throws. Without the control, "commits === 1" could mean the probe is blind.
 *
 * **G60** — a test that mounts a component alone cannot see an ANCESTOR handler stealing its
 * events. The last block dispatches REAL bubbling events at the deepest node through the whole
 * mounted `App`.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import { LayoutInputSchema } from '../../../../shared/workspace-schema.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace,
  type Agent, type Layout, type Project, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';
/** 12:04 UTC, so the "Saved · 12:04" stamp in spec §12.5 is the literal thing under test. */
const NOW = Date.UTC(2026, 8, 7, 12, 4, 0);

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const agent = (id: string, name: string, patch: Partial<Agent> = {}): Agent => ({
  id, name, slug: name.toLowerCase(), folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `hangar/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null, ...patch,
});

const AGENTS: Agent[] = [
  agent('a1', 'alpha', { notes: 'alpha note' }),
  agent('a2', 'beta', { notes: 'beta note' }),
  agent('a3', 'gamma', {
    workspaces: [
      { id: 'w-a3', projectId: 'p1', branch: 'hangar/gamma', worktreePath: '/wt/gamma', baseRef: 'main', createdAt: ISO },
      { id: 'w-a3b', projectId: 'p2', branch: 'hangar/gamma', worktreePath: '/wt/gamma-2', baseRef: 'main', createdAt: ISO },
    ],
  }),
];

function snapshotWith(layout: Partial<Layout> = {}, agents: Agent[] = AGENTS): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: [project('p1', 'hangar'), project('p2', 'acmeapi')],
      agents,
      layout: { ...defaultLayout(), drawerOpen: true, drawerTab: 'notes', panes: ['a1', 'a2'], focusedIndex: 0, ...layout },
    },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

/** A snapshot as main would push it after someone else wrote the note — `hangar note`, say. */
function withNotes(snap: WorkspaceSnapshot, id: string, notes: string): WorkspaceSnapshot {
  return {
    ...snap,
    workspace: { ...snap.workspace, agents: snap.workspace.agents.map((a) => (a.id === id ? { ...a, notes } : a)) },
  };
}

interface Call { channel: IpcRequestKey; payload: unknown }

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — hence `vi.resetModules()` plus dynamic imports, the same dance
 * `PaneGrid.test.tsx`, `Sidebar.test.tsx` and `api.test.ts` use. It also means each `load()` gets
 * FRESH store instances, which is what keeps these tests independent of one another.
 *
 * `channel in replies`, not `replies[channel] !== undefined`: `layout:set` and `agent:markOpened`
 * have `res: void`, so a value check would report them unstubbed and every layout write would fire
 * an error toast that the commit counters then charge to the component under test.
 */
async function load(replies: { [K in IpcRequestKey]?: IpcRequests[K]['res'] }) {
  const calls: Call[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  // The real `HangarBridge`, with no `as unknown as` escape hatch (Plan 02's standing rule), so a
  // change to the bridge's shape fails here instead of being absorbed by a blanket cast.
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      if (!(channel in replies)) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return Promise.resolve({ ok: true, value: replies[channel] as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      const erased = handler as (payload: never) => void;
      const list = listeners.get(channel) ?? [];
      list.push(erased);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [drawer, { App }, keymap, workspace, sessions, layout, ui] = await Promise.all([
    import('./Drawer.tsx'),
    import('../../App.tsx'),
    // For `keyLabel`: the tab tooltips read their key captions off `SHORTCUTS`, and the assertion
    // below reads the same table rather than re-typing '⌘⇧F' beside it.
    import('../../lib/keymap.ts'),
    import('../../stores/workspace.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
  ]);
  return { ...drawer, App, keymap, workspace, sessions, layout, ui, calls };
}

/**
 * The common case: a snapshot already in the stores, no `App`, no bootstrap.
 *
 * `failSaves` leaves `agent:update` unstubbed, which is how this harness spells "main rejected the
 * write" — the bridge answers `{ ok: false }`, `run` resolves null and routes it to the error sink.
 */
async function withSnapshot(snap: WorkspaceSnapshot, failSaves = false) {
  const t = await load(failSaves
    ? { 'layout:set': undefined, 'agent:markOpened': undefined }
    : { 'layout:set': undefined, 'agent:update': AGENTS[0], 'agent:markOpened': undefined });
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.layout.layoutStore.getState().hydrate(snap.workspace.layout);
  return { ...t, push: (next: WorkspaceSnapshot) => act(() => t.workspace.useWorkspace.getState().setSnapshot(next)) };
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
  vi.useRealTimers();
});

/** Mounts `node` and returns the host element plus a live count of subtree COMMITS. */
function mount(node: ReactNode): { el: HTMLElement; commits: () => number; unmount: () => void } {
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
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number; unmount: () => void } {
  return mountWith((n) => <StrictMode>{n}</StrictMode>, node);
}

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number; unmount: () => void } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — that placement is what decides whether effects double-invoke at all.
  act(() => root.render(shell(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>)));
  return { el, commits: () => commits, unmount: () => act(() => root.unmount()) };
}

const areaOf = (el: HTMLElement): HTMLTextAreaElement => {
  const area = el.querySelector('textarea');
  if (area === null) throw new Error('no textarea in the drawer');
  return area;
};

/**
 * Types into a CONTROLLED textarea the way the browser does. React installs its own value setter
 * on the element, so assigning `area.value` directly is invisible to it: the native prototype
 * setter has to be called before the input event, or `onChange` sees the stale value.
 */
function type(area: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Fires the pending debounce and lets the `agent:update` promise settle. */
async function settle(ms = 500): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const notesWritten = (calls: Call[]): unknown[] => calls.filter((c) => c.channel === 'agent:update').map((c) => c.payload);

describe('drawer chrome', () => {
  it('renders nothing at all while the drawer is closed', async () => {
    const t = await withSnapshot(snapshotWith({ drawerOpen: false }));
    const { el } = mount(<t.Drawer />);
    expect(el.querySelector('aside')).toBeNull();
  });

  it('is scoped to the focused pane: name in the header, that agent\'s notes in the textarea', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 1 }));
    const { el } = mount(<t.Drawer />);
    expect(el.textContent).toContain('beta');
    expect(areaOf(el).value).toBe('beta note');
  });

  it('follows focus when another pane is focused', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.Drawer />);
    expect(areaOf(el).value).toBe('alpha note');
    act(() => t.layout.layoutStore.getState().focusPane(1));
    expect(areaOf(el).value).toBe('beta note');
  });

  it('says so, rather than showing an empty note, when the focused pane has no agent', async () => {
    const t = await withSnapshot(snapshotWith({ panes: [null] }));
    const { el } = mount(<t.Drawer />);
    expect(el.textContent).toContain('No agent focused');
    expect(el.querySelector('textarea')).toBeNull();
  });

  // Every tab is real as of Plan 04 Task 5, so there is no placeholder string left to assert on:
  // each is identified by the structure only it renders. Their own behaviour lives in
  // `FilesTab.test.tsx` and `DiffTab.test.tsx`; this is the switching.
  it('switches tabs through the layout store, and each one mounts its real tab', async () => {
    const t = await withSnapshot(snapshotWith({}));
    const { el } = mount(<t.Drawer />);
    const tab = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
    act(() => tab('Files')?.click());
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('files');
    expect(el.querySelector('[role="tree"]')).not.toBeNull();
    expect(el.textContent).not.toContain('Plan 04');
    expect(el.querySelector('textarea')).toBeNull();
    act(() => tab('Diff')?.click());
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('diff');
    // This file's bridge stubs no `git:changes`, so the Diff tab renders its inline failure — which
    // is itself the assertion that the real tab mounted and asked, rather than a placeholder.
    expect(el.querySelector('[role="tree"]')).toBeNull();
    expect(el.querySelector('button[title="Refresh"]')).not.toBeNull();
    expect(el.textContent).not.toContain('Plan 04');
    act(() => tab('Notes')?.click());
    expect(el.querySelector('textarea')).not.toBeNull();
  });

  /**
   * The tabs carry visible labels, so a tooltip repeating "Files" would be noise. What the label
   * does NOT say is the key, and that is the whole content of these three `title`s — built by
   * `withShortcut` off `SHORTCUTS`, so a rebinding moves them rather than orphaning them.
   *
   * Unlike the pane header's copies, these are unconditional: the drawer is a single panel scoped
   * to whichever pane is focused, so ⌘⇧F and this button always mean the same thing.
   */
  it('names each tab\'s shortcut in its tooltip, from the keymap\'s own table', async () => {
    const t = await withSnapshot(snapshotWith({}));
    const { el } = mount(<t.Drawer />);
    const titles = [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => ['Files', 'Diff', 'Notes'].includes(b.textContent ?? '')).map((b) => b.title);
    expect(titles).toEqual([
      `Files (${String(t.keymap.keyLabel({ kind: 'drawer-tab', tab: 'files' }))})`,
      `Diff (${String(t.keymap.keyLabel({ kind: 'drawer-tab', tab: 'diff' }))})`,
      `Notes (${String(t.keymap.keyLabel({ kind: 'drawer-tab', tab: 'notes' }))})`,
    ]);
    expect(titles).toEqual(['Files (⌘⇧F)', 'Diff (⌘⇧G)', 'Notes (⌘⇧M)']);
  });
});

describe('workspace switcher', () => {
  it('is hidden for a single-workspace agent', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    expect(el.querySelector('button[title^="/wt/"]')).toBeNull();
  });

  it('shows one segment per workspace, named by project, and selects the primary', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a3'] }));
    const { el } = mount(<t.Drawer />);
    const segments = [...el.querySelectorAll<HTMLButtonElement>('button[title^="/wt/"]')];
    expect(segments.map((b) => b.textContent)).toEqual(['hangar', 'acmeapi']);
    expect(segments[0]?.className).toContain('bg-bg-3');
    act(() => segments[1]?.click());
    expect([...el.querySelectorAll<HTMLButtonElement>('button[title^="/wt/"]')][1]?.className).toContain('bg-bg-3');
  });
});

/**
 * G59. Every component in this file subscribes to a zustand store, and zustand 5 hands the selector
 * to `useSyncExternalStore`, which requires a referentially stable snapshot. Measured twice on this
 * project: ~55 renders, then "Maximum update depth exceeded", with `tsc`, `eslint` and every pure
 * unit test green throughout.
 */
describe('render counts', () => {
  it('commits exactly once for a drawer with notes and a workspace switcher', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a3'] }));
    const { commits } = mount(<t.Drawer />);
    expect(commits()).toBe(1);
  });

  it('does not loop under StrictMode either', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a3'] }));
    const { commits } = mountStrict(<t.Drawer />);
    expect(commits()).toBeLessThanOrEqual(2);
  });

  it('costs nothing when an unrelated agent\'s notes change', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'], focusedIndex: 0 }));
    const { commits } = mount(<t.Drawer />);
    const afterMount = commits();
    t.push(withNotes(snapshotWith({ panes: ['a1'] }), 'a2', 'someone else entirely'));
    expect(commits() - afterMount).toBeLessThanOrEqual(1);
  });

  // The control. Without it, "commits === 1" above could just mean the probe is blind. Measured on
  // this tree with React 19.2.8: ~55 renders, then React throws "Maximum update depth exceeded".
  it('catches a selector that allocates — exactly what the drawer must not do', async () => {
    const t = await withSnapshot(snapshotWith({}));
    const Looping = (): ReactNode => {
      const ids = t.layout.useLayout((s) => ({ open: s.layout.drawerOpen, tab: s.layout.drawerTab }));
      return <span>{ids.tab}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('notes autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('waits for the typing to stop, then sends exactly one update with the final text', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    type(area, 'alpha note!');
    await settle(300);
    expect(notesWritten(t.calls)).toEqual([]);
    type(area, 'alpha note!!');
    await settle(499);
    expect(notesWritten(t.calls)).toEqual([]);
    await settle(1);
    expect(notesWritten(t.calls)).toEqual([{ id: 'a1', patch: { notes: 'alpha note!!' } }]);
  });

  it('stamps the save with the wall clock, and shows "Unsaved…" until it lands', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'typed');
    expect(el.textContent).toContain('Unsaved…');
    await settle();
    expect(el.textContent).toContain('Saved · 12:04');
    expect(el.textContent).not.toContain('Unsaved…');
  });

  /**
   * A failed save is the one path where the optimistic "the store now holds my text" is WRONG. The
   * store still holds the old note, so the next snapshot — any snapshot, for any reason — carries
   * it, and a NotesTab that had already recorded the new value as its own would read that as an
   * external edit and adopt it, wiping the text the user is looking at. Dropping the `mine.current
   * = previous` rollback in NotesTab fails the second assertion here.
   */
  it('keeps the typed text, and stops believing it saved, when the write fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const base = snapshotWith({ panes: ['a1'] });
      const t = await withSnapshot(base, true);
      const { el } = mount(<t.Drawer />);
      type(areaOf(el), 'typed while the host was down');
      await settle();
      expect(el.textContent).toContain('Save failed');
      t.push(base); // unchanged notes: the write never landed
      expect(areaOf(el).value).toBe('typed while the host was down');
    } finally {
      errors.mockRestore();
    }
  });

  it('sends nothing when the text ends up back where it started', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'alpha not');
    type(areaOf(el), 'alpha note');
    await settle();
    expect(notesWritten(t.calls)).toEqual([]);
  });

  // The plan's version cleared the timer and then called `save(text)`, which re-arms the SAME
  // 500 ms timer — that postpones the write rather than flushing it. Reverting to it fails on the
  // first assertion: nothing has been sent when the blur returns.
  it('flushes immediately on blur instead of re-arming the debounce', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    act(() => area.focus());
    type(area, 'half typed');
    act(() => area.blur());
    expect(notesWritten(t.calls)).toEqual([{ id: 'a1', patch: { notes: 'half typed' } }]);
    await settle();
    expect(notesWritten(t.calls).length).toBe(1);
  });
});

/**
 * Spec §12.5: "External updates (from `hangar note`) merge in only when the textarea is not
 * focused, to avoid clobbering typing; while focused, a small 'Notes changed by agent — reload'
 * chip appears."
 */
describe('external notes changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('adopts a change made by the agent while the textarea is not focused', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    t.push(withNotes(base, 'a1', 'written by hangar note'));
    expect(areaOf(el).value).toBe('written by hangar note');
    expect(el.textContent).not.toContain('Notes changed by the agent');
  });

  it('does NOT overwrite the textarea while it is focused, and raises the chip instead', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    act(() => area.focus());
    type(area, 'what the human is typing');
    await settle(); // the human's own edit is saved and echoed back
    t.push(withNotes(base, 'a1', 'written by hangar note'));
    expect(areaOf(el).value).toBe('what the human is typing');
    expect(el.textContent).toContain('Notes changed by the agent');
  });

  it('reloads the NEWEST value, not the one that raised the chip', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    act(() => area.focus());
    type(area, 'mine');
    await settle();
    t.push(withNotes(base, 'a1', 'first agent write'));
    expect(el.textContent).toContain('Notes changed by the agent');
    t.push(withNotes(base, 'a1', 'second agent write'));
    const reload = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Reload');
    act(() => reload?.click());
    expect(areaOf(el).value).toBe('second agent write');
    expect(el.textContent).not.toContain('Notes changed by the agent');
  });

  // The save's own round trip comes back as a `workspace:changed` carrying the value we just wrote.
  // Treating that as an external edit would raise the chip on every autosave.
  it('does not mistake the echo of our own save for someone else\'s edit', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    act(() => area.focus());
    type(area, 'typed by hand');
    await settle();
    t.push(withNotes(base, 'a1', 'typed by hand'));
    expect(el.textContent).not.toContain('Notes changed by the agent');
    expect(areaOf(el).value).toBe('typed by hand');
  });

  /**
   * A snapshot arriving in the window between "we sent our save" and "main replied". The value in
   * it is about to be overwritten by our own write, and adopting it puts the agent's text into a
   * textarea whose contents are already on their way to disk — the store then echoes ours back and
   * the textarea flips a second time. Both bounds of that window are deterministic here: the sync
   * `act` fires the debounce without letting the reply's microtask run, so `inFlight` is 1 when the
   * snapshot lands. Removing the `inFlight`/`timer` guard from NotesTab fails this test alone.
   */
  it('ignores a snapshot that lands while our own save is still in flight', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'typed by hand');
    act(() => void vi.advanceTimersByTime(500)); // sent; the reply has not settled yet
    t.push(withNotes(base, 'a1', 'agent write racing our save'));
    expect(areaOf(el).value).toBe('typed by hand');
    await settle(0);
    expect(areaOf(el).value).toBe('typed by hand');
  });

  /**
   * The same shape one step earlier: our save is only SCHEDULED. The incoming value is still the
   * one we are about to overwrite, so adopting it would drop the keystrokes that are sitting in
   * the debounce.
   */
  it('ignores the echo of an earlier save that arrives after a newer edit', async () => {
    const base = snapshotWith({ panes: ['a1'] });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    const area = areaOf(el);
    type(area, 'first');
    await settle();
    type(area, 'second');           // scheduled, not yet sent
    t.push(withNotes(base, 'a1', 'first')); // the echo of the FIRST save, arriving late
    expect(areaOf(el).value).toBe('second');
    await settle();
    expect(notesWritten(t.calls)).toEqual([
      { id: 'a1', patch: { notes: 'first' } },
      { id: 'a1', patch: { notes: 'second' } },
    ]);
  });
});

/**
 * Whose notes is the in-flight save for? The drawer is scoped to the FOCUSED pane's agent, so a
 * pane switch swaps the agent under a debounce that has not fired yet.
 */
describe('switching agents mid-edit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('sends the pending edit to the agent it was typed for, and shows the new agent\'s notes', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 }));
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'meant for alpha');
    act(() => t.layout.layoutStore.getState().focusPane(1));
    await settle();
    expect(notesWritten(t.calls)).toEqual([{ id: 'a1', patch: { notes: 'meant for alpha' } }]);
    expect(areaOf(el).value).toBe('beta note');
  });

  // Removing the unmount flush from `NotesTab` fails this one alone: the pending edit is dropped
  // and `notesWritten` comes back empty.
  it('flushes a pending edit when the drawer closes under it', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'] }));
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'closed mid-sentence');
    act(() => t.layout.layoutStore.getState().setDrawer({ open: false }));
    expect(notesWritten(t.calls)).toEqual([{ id: 'a1', patch: { notes: 'closed mid-sentence' } }]);
  });

  // The refs that make the above work belong to ONE agent, which is what `key={agent.id}` buys.
  // Without the key the same instance is reused and the new agent inherits the old agent's
  // "last saved" value, so the next snapshot for it reads as an external edit.
  it('gives the new agent a fresh tab rather than the old one\'s state', async () => {
    const base = snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 });
    const t = await withSnapshot(base);
    const { el } = mount(<t.Drawer />);
    type(areaOf(el), 'alpha edit');
    await settle();
    act(() => t.layout.layoutStore.getState().focusPane(1));
    expect(el.textContent).not.toContain('Saved · ');
    expect(el.textContent).not.toContain('Unsaved…');
    t.push(withNotes(base, 'a2', 'beta note grew'));
    expect(areaOf(el).value).toBe('beta note grew');
    expect(el.textContent).not.toContain('Notes changed by the agent');
  });
});

describe('resizing', () => {
  /**
   * One `act` PER event, not one around the drag. A browser delivers each `mousemove` in its own
   * task, so React has re-rendered before the next one arrives; batching them into a single `act`
   * defers every render to the end and hides exactly the staleness this is measuring — the first
   * draft did that and reported a 300 px drag as +100.
   */
  const drag = (el: HTMLElement, from: number, steps: number[]): void => {
    const handle = el.querySelector('.cursor-col-resize');
    if (handle === null) throw new Error('no resize handle');
    act(() => void handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from })));
    for (const x of steps) act(() => void window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x })));
    act(() => void window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
  };

  /**
   * `Resizer` reports INCREMENTAL deltas, so the width has to accumulate across a drag. It did not:
   * the `mousemove` listener closes over the `onResize` prop from the render at MOUSEDOWN, so every
   * step recomputed from the width the drag started at and the drawer stuck ~2 px from where it
   * began. Measured before the fix — a 300 px drag left `drawerWidth` at 561 instead of 860 — and
   * the sidebar had the same bug, since the staleness lives in the shared primitive.
   */
  it('accumulates the whole drag, not just the last step', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'], drawerWidth: 560 }));
    const { el } = mount(<t.Drawer />);
    drag(el, 800, [700, 600, 500]);
    expect(t.layout.layoutStore.getState().layout.drawerWidth).toBe(860);
  });

  // Both bounds are `LayoutInputSchema`'s, and a payload outside them is REJECTED by `layout:set`
  // — the drag would look right and then silently fail to persist, with an error toast.
  it('clamps to the bounds layout:set will actually accept', async () => {
    const t = await withSnapshot(snapshotWith({ panes: ['a1'], drawerWidth: 560 }));
    const { el } = mount(<t.Drawer />);
    drag(el, 9000, [0]);
    const wide = t.layout.layoutStore.getState().layout;
    expect(wide.drawerWidth).toBe(t.DRAWER_MAX_WIDTH);
    expect(LayoutInputSchema.safeParse(wide).success).toBe(true);
    drag(el, 0, [9000]);
    const narrow = t.layout.layoutStore.getState().layout;
    expect(narrow.drawerWidth).toBe(t.DRAWER_MIN_WIDTH);
    expect(LayoutInputSchema.safeParse(narrow).success).toBe(true);
  });
});

/**
 * G60. Task 4 shipped with right-click broken on every sidebar row while 633 tests — 8 of which
 * mounted that exact sidebar — stayed green, because not one of them dispatched a real bubbling
 * event through the real tree. These do, from the app root, at the node the pointer is actually
 * over.
 *
 * Measured for this task: nothing above the drawer handles `contextmenu`, `mousedown`, `click` or
 * `input` — `Sidebar`'s `onContextMenu` is scoped to its own `<aside>` and `Pane`'s
 * `onMouseDownCapture` to `<main>`, and the drawer is a sibling of both. So the drawer adds NO
 * `stopPropagation()` guard: there is nothing to stop, and an untested guard here would be the
 * blind capture-phase pair Task 6 found and deleted. These tests are what keeps that true.
 */
describe('event routing through the real App', () => {
  async function mountApp(layout: Partial<Layout> = {}) {
    const t = await load({
      'workspace:get': snapshotWith(layout),
      'config:get': defaultAppConfig('/bin/zsh'),
      'layout:set': undefined,
      'agent:update': AGENTS[0],
      'agent:markOpened': undefined,
      'app:windowFocused': undefined,
    });
    const { el } = mount(<t.App />);
    await act(async () => undefined);
    return { t, el };
  }

  it('mounts the drawer beside the pane grid, not inside it', async () => {
    const { el } = await mountApp({ panes: ['a1'] });
    const asides = [...el.querySelectorAll('aside')];
    expect(asides.length).toBe(2);
    expect(asides[1]?.querySelector('textarea')).not.toBeNull();
    expect((el.querySelector('main') as HTMLElement).querySelector('textarea')).toBeNull();
  });

  it('lets typing reach the textarea through the whole tree', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    const area = areaOf(el);
    act(() => area.focus());
    type(area, 'typed through App');
    expect(area.value).toBe('typed through App');
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  // The shape that broke the sidebar: an ancestor with its own handler for the same event. The
  // drawer deliberately raises no menu of its own, so the assertion is that the SIDEBAR's does not
  // fire for a right-click inside the drawer either — it is a sibling, not an ancestor.
  it('does not borrow the sidebar background menu on a right-click inside it', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => {
      areaOf(el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    expect(t.ui.useUi.getState().contextMenu).toBeNull();
  });

  it('switches tabs from a real click, without moving pane focus', async () => {
    const { t, el } = await mountApp({ panes: ['a1', 'a2'], focusedIndex: 1 });
    const files = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Files');
    act(() => {
      files?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      files?.click();
    });
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('files');
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });
});
