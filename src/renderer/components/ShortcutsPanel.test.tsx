/**
 * The shortcut cheatsheet (⌘/, or the toolbar's keyboard button) — a **non-modal floating panel**
 * since X5-3, where it was a `showModal()` `<dialog>` before.
 *
 * The claim that matters first is still **exhaustiveness**: a cheatsheet that silently omits a
 * shortcut teaches the wrong thing, which is worse than not having one. `tsc` carries most of that
 * — `SHORTCUTS` is a `Record` over `KeymapAction['kind']` with a non-empty tuple value type — and
 * the tests here carry the rest: every row of the table reaches the DOM, and the flags each row
 * shows are read off the keymap's own tables rather than restated. **Nothing about that changed
 * when the panel stopped being a dialog**, and these tests are unchanged proof of it.
 *
 * The claim that is NEW is that the panel is not modal: it is mounted from `App`, not from
 * `DialogHost`, `ui.dialog` stays `null` while it is open, and so every shortcut it documents still
 * fires. That half is asserted in `lib/keymap.test.ts`, which owns `installKeymap`; here it is
 * asserted structurally (the panel is not a `<dialog>`, and opening it leaves `ui.dialog` null).
 *
 * **G59/G61** — the panel now reads geometry from the layout store, which is exactly the shape G59
 * kills: a selector returning a fresh `{x,y,w,h}` renders forever. Every selector here returns a
 * zustand action, a primitive, or the STORED rect object, and the clamp is applied below the
 * subscription. So it gets the full probe: commit counts on a real React root, a deliberately
 * allocating control proving the counter is not blind, and a mount with nothing in the stores at
 * all — G61's `?? null` path is the live one here, since `Layout.shortcutsPanel` is null until the
 * first drag.
 *
 * **G66** — jsdom has no layout engine, so every element's box reads zero and the drag arithmetic
 * cannot be measured through the DOM. It is a set of pure functions in `shared/layout.ts` and is
 * tested there directly; what these tests prove is that the component CALLS them with the pointer's
 * deltas and stores what they return, and that the numbers reach the inline `style`. Whether the
 * panel visually lands there, whether a `tabindex="-1"` div takes focus on click, and whether the
 * cursor changes over the handles are CDP questions.
 *
 * **G65** — `mountStrict` puts `<StrictMode>` outermost, with the `<Profiler>` inside it.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_MIN_H, PANEL_MIN_W } from '../../../shared/layout.ts';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';
import { defaultAppConfig, defaultLayout, emptyWorkspace, type Layout, type WorkspaceSnapshot } from '../../../shared/types.ts';

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — the `vi.resetModules()` dance every renderer test in this project uses. It
 * also hands each test fresh stores.
 */
async function load(replies: { [K in IpcRequestKey]?: IpcRequests[K]['res'] } = {}) {
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ..._args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      if (!(channel in replies)) return Promise.resolve({ ok: true, value: undefined as IpcRequests[K]['res'] });
      return Promise.resolve({ ok: true, value: replies[channel] as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(_channel: K, _handler: (payload: IpcEvents[K]) => void): () => void {
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [panel, { App }, host, toolbar, keymap, workspace, layout, ui] = await Promise.all([
    import('./ShortcutsPanel.tsx'),
    import('../App.tsx'),
    import('./dialogs/DialogHost.tsx'),
    import('./Toolbar.tsx'),
    import('../lib/keymap.ts'),
    import('../stores/workspace.ts'),
    import('../stores/layout.ts'),
    import('../stores/ui.ts'),
  ]);
  return { ...panel, App, ...host, ...toolbar, keymap, workspace, layout, ui };
}

const SNAPSHOT: WorkspaceSnapshot = {
  workspace: emptyWorkspace(),
  sessions: {},
  runtime: {},
  host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
  profile: { home: '/h', isDefault: true },
};

const snapshotWith = (layout: Partial<Layout>): WorkspaceSnapshot => ({
  ...SNAPSHOT,
  workspace: { ...emptyWorkspace(), layout: { ...defaultLayout(), ...layout } },
});

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
  setViewport(1024, 768);
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

const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="shortcut-row"]')];
const captions = (el: HTMLElement): string[] => rows(el).map((r) => r.querySelector('kbd')?.textContent ?? '');
const headings = (el: HTMLElement): string[] => [...el.querySelectorAll<HTMLElement>('.tracking-wider')].map((h) => h.textContent ?? '');
const panelOf = (el: HTMLElement): HTMLElement => {
  const p = el.querySelector<HTMLElement>('[data-testid="shortcuts-panel"]');
  if (p === null) throw new Error('the panel is not showing');
  return p;
};
/** The four numbers the panel is actually DRAWN at, off its inline style. */
const drawnAt = (el: HTMLElement): { x: number; y: number; w: number; h: number } => {
  const s = panelOf(el).style;
  return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) };
};

/** jsdom's window is 1024x768 and its `innerWidth`/`innerHeight` are plain writable properties. */
function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, writable: true, configurable: true });
}

/** A whole gesture: down on `node`, two moves, up. Deltas are TOTAL, from the mousedown point. */
function drag(node: HTMLElement, from: [number, number], to: [number, number]): void {
  const mid: [number, number] = [Math.round((from[0] + to[0]) / 2), Math.round((from[1] + to[1]) / 2)];
  act(() => {
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: from[0], clientY: from[1] }));
    for (const [x, y] of [mid, to]) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
  });
}

async function open(layout: Partial<Layout> = {}) {
  const t = await load();
  t.layout.layoutStore.getState().hydrate({ ...defaultLayout(), ...layout });
  act(() => t.ui.useUi.getState().toggleShortcuts());
  const { el, commits } = mount(<t.ShortcutsPanel />);
  return { t, el, commits };
}

describe('exhaustiveness', () => {
  /**
   * The load-bearing test. Every chord in `SHORTCUTS` reaches the DOM, and the row count matches
   * the table exactly — so a shortcut cannot be added to the keymap and left out of the panel, and
   * the panel cannot grow a row for a key that does not exist.
   *
   * Asserted against the table rather than a hand-written list of captions: hand-writing them here
   * would put the drift back in, one file over.
   */
  it('draws one row per chord in SHORTCUTS, and no others', async () => {
    const { t, el } = await open();
    const expected = Object.values(t.keymap.SHORTCUTS).flat().map((s) => t.keymap.chordLabel(s.chord));
    expect(captions(el)).toEqual(expected);
    expect(rows(el)).toHaveLength(expected.length);
    // A floor, so this test cannot pass vacuously if `SHORTCUTS` were ever emptied.
    expect(expected.length).toBeGreaterThanOrEqual(17);
  });

  it('describes every row with the table\'s own words', async () => {
    const { t, el } = await open();
    const all = Object.values(t.keymap.SHORTCUTS).flat();
    for (const [i, s] of all.entries()) {
      expect([s.does, rows(el)[i]?.textContent?.includes(s.does)]).toEqual([s.does, true]);
    }
  });

  /**
   * `cheatsheetSections` starts a new heading whenever `section` changes, so a section split across
   * two runs of `SHORTCUTS` would render its heading twice. That is a real, visible bug and this is
   * the only thing that can catch it — `tsc` has nothing to say about the ORDER of a `Record`.
   */
  it('groups into contiguous, non-repeating sections', async () => {
    const { t, el } = await open();
    const sections = t.cheatsheetSections();
    const titles = sections.map((s) => s.title);
    expect(titles.length).toBe(new Set(titles).size);
    expect(sections.every((s) => s.rows.length > 0)).toBe(true);
    expect(sections.flatMap((s) => s.rows)).toEqual(Object.values(t.keymap.SHORTCUTS).flat());
    expect(headings(el)).toEqual(titles.map((x) => x.toUpperCase()));
  });
});

describe('the non-uniform half', () => {
  /**
   * The shortcuts are NOT uniform and the panel must not imply they are. Two of the three
   * differences are read off the keymap's own tables, so they cannot drift:
   *
   *   - `WORKS_IN_TEXT_FIELD` — the "while typing" marker.
   *   - `OWNED_BY_CODE_EDITOR` — the note that the drawer's viewer keeps a key for itself.
   *
   * The third (⌘⇧G colliding with `@codemirror/search`'s find-previous) is a fact about another
   * package that no table here can derive, so it is hand-written prose carried on that binding's
   * own row in `SHORTCUTS` — and this asserts the panel prints it.
   */
  it('marks exactly the shortcuts that survive a text field', async () => {
    const { t, el } = await open();
    const all = Object.values(t.keymap.SHORTCUTS).flat();
    const marked = all.filter((_, i) => rows(el)[i]?.textContent?.includes('while typing') === true).map((s) => t.keymap.chordLabel(s.chord));
    const expected = all.filter((s) => t.keymap.WORKS_IN_TEXT_FIELD[s.action.kind]).map((s) => t.keymap.chordLabel(s.chord));
    expect(marked).toEqual(expected);
    // The split is real, not everything-or-nothing — otherwise the marker would be decoration.
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.length).toBeLessThan(all.length);
    expect(marked).toContain('⌘E');
    expect(marked).not.toContain('⌘N');
  });

  it('notes the rows the code viewer keeps, and only those', async () => {
    const { t, el } = await open();
    const all = Object.values(t.keymap.SHORTCUTS).flat();
    const noted = all.filter((_, i) => rows(el)[i]?.textContent?.includes('code viewer keeps this one') === true).map((s) => t.keymap.chordLabel(s.chord));
    expect(noted).toEqual(all.filter((s) => t.keymap.OWNED_BY_CODE_EDITOR[s.action.kind]).map((s) => t.keymap.chordLabel(s.chord)));
    expect(noted).toEqual(['⌘F']);
  });

  it('prints the ⌘⇧G caveat that no table can derive', async () => {
    const { t, el } = await open();
    const diff = Object.values(t.keymap.SHORTCUTS).flat().findIndex((s) => t.keymap.chordLabel(s.chord) === '⌘⇧G');
    expect(rows(el)[diff]?.textContent).toContain('⇧F3');
    // Carried on the binding, so rebinding ⌘⇧G puts the caveat in front of whoever does it.
    expect(t.keymap.shortcutFor({ kind: 'drawer-tab', tab: 'diff' })?.caveat).toContain('find-previous');
  });
});

describe('showing and hiding', () => {
  it('renders nothing until it is opened, and stops rendering when it is closed', async () => {
    const t = await load();
    const { el } = mount(<t.ShortcutsPanel />);
    expect(el.querySelector('[data-testid="shortcuts-panel"]')).toBeNull();
    act(() => t.ui.useUi.getState().toggleShortcuts());
    expect(rows(el).length).toBeGreaterThan(0);
    act(() => t.ui.useUi.getState().toggleShortcuts());
    expect(el.querySelector('[data-testid="shortcuts-panel"]')).toBeNull();
  });

  /**
   * **The change, stated as a property.** While the cheatsheet was a `DialogState` member,
   * `installKeymap`'s "a modal owns the keyboard" stand-down made every shortcut it documents inert
   * on the screen documenting it. `ui.dialog` staying null is what fixes that, and it is what
   * `keymap.test.ts` → "leaves every shortcut live while the cheatsheet panel is open" depends on.
   */
  it('is not a dialog: no <dialog> element, and ui.dialog stays null', async () => {
    const { t, el } = await open();
    expect(el.querySelector('dialog')).toBeNull();
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    // And `DialogHost` no longer knows about it — mounting it renders nothing.
    const host = mount(<t.DialogHost />);
    expect(host.el.querySelector('[data-testid="shortcuts-panel"]')).toBeNull();
  });

  it('closes on its Close button', async () => {
    const { t, el } = await open();
    act(() => panelOf(el).querySelector<HTMLButtonElement>('button[title="Close"]')?.click());
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
  });

  /**
   * Escape used to come free with `<dialog>`'s `cancel` event. It is now a handler on the panel
   * itself — deliberately NOT on `window`, because Escape belongs to the terminal (vim is one
   * keystroke away from every pane), so it only fires with focus inside the panel. The second half
   * of this test is the one that pins that distinction.
   */
  it('closes on Escape from inside itself, and ignores Escape from outside', async () => {
    const { t, el } = await open();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    act(() => void outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    outside.remove();

    const body = panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-body"]');
    act(() => void body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
  });

  /**
   * The scroll container keeps `tabIndex={-1}`, but for a different reason than it had as a dialog:
   * there it was `initialFocus`, the G62 defence against `showModal()` parking focus on the header
   * Close button. There is no `showModal()` now and the panel focuses nothing at all — the keyboard
   * stays where it was, which is what lets you try a shortcut while reading it — so the attribute
   * is only there to let a CLICK focus the list for arrow-key scrolling. G66: jsdom implements no
   * focusability rule, so that is a CDP question; the attribute is what can be asserted, with a
   * control showing the assertion is capable of failing.
   */
  /**
   * The handler that acts on a key owns it — the `stopPropagation()` half of the same rule
   * `AgentRow` learned the hard way in G60, applied to a keystroke instead of a menu. Nothing above
   * this panel handles Escape TODAY, so without this test the call is unbitten decoration and could
   * be deleted freely; with it, the panel keeps the key it consumed even once something above does.
   */
  it('does not let the Escape it consumed reach an ancestor', async () => {
    const t = await load();
    t.layout.layoutStore.getState().hydrate(defaultLayout());
    act(() => t.ui.useUi.getState().toggleShortcuts());
    const seen: string[] = [];
    const { el } = mount(<div onKeyDown={() => void seen.push('ancestor')}><t.ShortcutsPanel /></div>);
    const body = panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-body"]');
    // The control FIRST, because Escape unmounts the panel and a detached node reaches no ancestor:
    // a key the panel does not claim must still bubble, or the assertion below would be about the
    // ancestor never firing at all rather than about Escape.
    act(() => void body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    expect(seen).toEqual(['ancestor']);
    act(() => void body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
    expect(seen).toEqual(['ancestor']);
  });

  it('is a no-drag region, so its title bar moves the panel and not the window', async () => {
    // It floats over the toolbar's `drag-region` (`-webkit-app-region: drag`), and a title bar that
    // dragged the WINDOW is the obvious way to get a floating panel wrong. jsdom has no such
    // behaviour, so the class is what can be asserted here; the effect is a CDP question.
    const { el } = await open();
    expect(panelOf(el).classList.contains('no-drag')).toBe(true);
  });

  it('takes no focus, and leaves the list clickable-to-focus', async () => {
    const before = document.activeElement;
    const { el } = await open();
    expect(document.activeElement).toBe(before);
    expect(panelOf(el).querySelector('[data-testid="shortcuts-body"]')?.getAttribute('tabindex')).toBe('-1');
    // Control on the assertion itself: a sibling without the attribute reads back null.
    expect(panelOf(el).getAttribute('tabindex')).toBeNull();
  });
});

/**
 * Geometry. Every number below comes out of `shared/layout.ts`'s pure functions, which are tested
 * directly in `shared/layout.test.ts`; what these prove is the wiring — that the component asks
 * them the right question with the pointer's deltas and the live window, stores the answer in
 * `Layout` so it survives a restart, and draws it.
 *
 * jsdom's window is 1024x768 (measured) and `setViewport` rewrites `innerWidth`/`innerHeight`.
 */
describe('geometry, persistence and staying on screen', () => {
  it('opens at the width of the sidebar, filling the lower half of the window', async () => {
    const { el } = await open({ sidebarWidth: 300 });
    expect(drawnAt(el)).toEqual({ x: 0, y: 384, w: 300, h: 384 });
  });

  /**
   * The CURRENT sidebar width, not a hardcoded 260: the user resizes the sidebar, and until the
   * panel has been dragged its default keeps following it. That is why `Layout.shortcutsPanel`
   * starts as `null` rather than as a rect written at first open.
   */
  it('follows the sidebar width until the panel is moved, and stops following once it is', async () => {
    const { t, el } = await open({ sidebarWidth: 260 });
    expect(drawnAt(el).w).toBe(260);
    act(() => t.layout.layoutStore.getState().setSidebar({ width: 420 }));
    expect(drawnAt(el).w).toBe(420);
    drag(panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]') as HTMLElement, [10, 400], [110, 350]);
    act(() => t.layout.layoutStore.getState().setSidebar({ width: 300 }));
    expect(drawnAt(el).w).toBe(420); // frozen at the width it was dragged with
  });

  it('drags by the title bar, and persists the position in Layout', async () => {
    const { t, el } = await open({ sidebarWidth: 260 });
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toBeNull();
    const bar = panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]') as HTMLElement;
    // The mousedown is `preventDefault`ed, or the drag selects the text under the pointer — the
    // same reason `ui/Resizer.tsx` does it. NOT `stopPropagation`ed: see the G60 block below.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 400 });
    act(() => void bar.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    act(() => void window.dispatchEvent(new MouseEvent('mouseup', {})));
    drag(bar, [10, 400], [210, 300]);
    // +200 / -100 from { x: 0, y: 384 }. The MIDPOINT move is in the gesture too, so an
    // implementation that accumulated per-move deltas against a stale base would land elsewhere.
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toEqual({ x: 200, y: 284, w: 260, h: 384 });
    expect(drawnAt(el)).toEqual({ x: 200, y: 284, w: 260, h: 384 });
  });

  it('resizes from the corner, and persists the size', async () => {
    const { t, el } = await open({ sidebarWidth: 260, shortcutsPanel: { x: 100, y: 100, w: 300, h: 300 } });
    drag(panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-resize"]') as HTMLElement, [400, 400], [500, 450]);
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toEqual({ x: 100, y: 100, w: 400, h: 350 });
    expect(drawnAt(el)).toEqual({ x: 100, y: 100, w: 400, h: 350 });
  });

  it('will not be resized smaller than it can be used at', async () => {
    const { t, el } = await open({ shortcutsPanel: { x: 100, y: 100, w: 300, h: 300 } });
    drag(panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-resize"]') as HTMLElement, [400, 400], [0, 0]);
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toEqual({ x: 100, y: 100, w: PANEL_MIN_W, h: PANEL_MIN_H });
  });

  it('cannot be dragged off the screen it would have to be dragged back from', async () => {
    const { t, el } = await open();
    const bar = panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]') as HTMLElement;
    drag(bar, [10, 400], [9000, 9000]);
    const far = t.layout.layoutStore.getState().layout.shortcutsPanel;
    expect(far).toEqual({ x: 1024 - 260, y: 768 - 384, w: 260, h: 384 });
    drag(bar, [10, 400], [-9000, -9000]);
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toMatchObject({ x: 0, y: 0 });
  });

  /**
   * **The classic failure of a draggable panel**: a position saved on a larger display leaves it
   * somewhere unreachable, and dragging it back needs a title bar that is off screen. The rect that
   * comes off disk is left alone by `normalizeLayout` (which cannot see the window) and corrected
   * where the panel is DRAWN — so the very first render is already on screen, before any gesture.
   */
  it('drags a position saved on a bigger display back onto this one', async () => {
    const { el } = await open({ shortcutsPanel: { x: 3400, y: 2000, w: 500, h: 600 } });
    expect(drawnAt(el)).toEqual({ x: 524, y: 168, w: 500, h: 600 });
    const bar = panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]');
    expect(bar).not.toBeNull();
    // The property that makes it recoverable: wholly inside the viewport, so the bar is on screen.
    const at = drawnAt(el);
    expect([at.x >= 0, at.y >= 0, at.x + at.w <= 1024, at.y + at.h <= 768]).toEqual([true, true, true, true]);
  });

  /**
   * The other direction: the window shrinks under a panel that was legal a moment ago. The clamp
   * runs on what is drawn, and the correction is written BACK so it is not re-derived every launch.
   * The second half is the guard against a write on every window drag.
   */
  it('follows a window that shrinks, and does not write when it does not have to', async () => {
    const { t, el } = await open({ shortcutsPanel: { x: 700, y: 600, w: 300, h: 160 } });
    expect(drawnAt(el)).toEqual({ x: 700, y: 600, w: 300, h: 160 });
    act(() => {
      setViewport(600, 400);
      window.dispatchEvent(new Event('resize'));
    });
    expect(drawnAt(el)).toEqual({ x: 300, y: 240, w: 300, h: 160 });
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toEqual({ x: 300, y: 240, w: 300, h: 160 });

    const settled = t.layout.layoutStore.getState().layout.shortcutsPanel;
    act(() => {
      setViewport(1400, 900);
      window.dispatchEvent(new Event('resize'));
    });
    // A resize that leaves a legal rect legal must not rewrite it — same object, not just equal.
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toBe(settled);
  });

  /**
   * Persistence, end to end through the store's own push: geometry belongs in `Layout` beside
   * `sidebarWidth` and `drawerWidth`, so it goes to `layout:set` and comes back on the next launch.
   * The store debounces by 100 ms, which is what makes a whole drag one write.
   */
  it('pushes the geometry to main, once per drag', async () => {
    vi.useFakeTimers();
    try {
      const pushed: Layout[] = [];
      const t = await load();
      const store = t.layout.createLayoutStore((l) => pushed.push(l));
      store.getState().hydrate(defaultLayout());
      store.getState().setShortcutsPanel({ x: 1, y: 2, w: 300, h: 300 });
      store.getState().setShortcutsPanel({ x: 3, y: 4, w: 300, h: 300 });
      vi.advanceTimersByTime(200);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.shortcutsPanel).toEqual({ x: 3, y: 4, w: 300, h: 300 });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * **G60 — an ancestor stealing the drag.** A component mounted alone cannot see one, and this panel
 * floats over the pane grid, whose `Pane` focuses itself on `onMouseDownCapture`. The sweep: the
 * panel is a sibling of the whole layout in `App`, not a descendant of `main` or of any pane, so
 * React never routes a mousedown on it through `Pane`'s capture handler however the boxes overlap
 * on screen; `App`'s root div and `main` carry no mouse handlers at all. No `stopPropagation()`
 * guard was added — the same conclusion Plan 03 Tasks 7-9 and Plan 04 Task 4 reached for the
 * drawer and the Files tab, and an unnecessary guard is worse than none. These two tests are what
 * keep it true: the first pins the PLACEMENT, the second proves the drag survives an ancestor that
 * does handle the same event.
 */
describe('placement in the real tree', () => {
  async function mountApp(layout: Partial<Layout> = {}) {
    // `app:diskFree` is stubbed because `StatusBar` polls it on mount and reads `.freeBytes`; the
    // blanket `undefined` this harness gives an unstubbed channel is not a shape it can survive.
    const t = await load({ 'workspace:get': snapshotWith(layout), 'config:get': defaultAppConfig('/bin/zsh'), 'app:diskFree': { freeBytes: 5e11, path: '/wt' } });
    const { el } = mount(<t.App />);
    await act(async () => undefined);
    act(() => t.ui.useUi.getState().toggleShortcuts());
    return { t, el };
  }

  it('mounts beside the pane grid, not inside it', async () => {
    const { el } = await mountApp();
    const panel = panelOf(el);
    const main = el.querySelector('main');
    expect(main).not.toBeNull();
    expect(main?.contains(panel)).toBe(false);
    expect(el.querySelector('aside')?.contains(panel)).toBe(false);
    // …and it is reachable through the whole App, which is what makes the negatives meaningful.
    expect(rows(el).length).toBeGreaterThanOrEqual(17);
  });

  it('keeps its drag when an ancestor handles mousedown too', async () => {
    const t = await load();
    t.layout.layoutStore.getState().hydrate(defaultLayout());
    act(() => t.ui.useUi.getState().toggleShortcuts());
    const seen: string[] = [];
    const { el } = mount(
      <div onMouseDownCapture={() => void seen.push('ancestor')}>
        <t.ShortcutsPanel />
      </div>,
    );
    drag(panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]') as HTMLElement, [10, 400], [60, 380]);
    // The ancestor really did run — otherwise this test proves nothing about coexisting with one.
    expect(seen).toEqual(['ancestor']);
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toMatchObject({ x: 50, y: 364 });
  });
});

/**
 * "Reachable from the toolbar" — the owner's original request — plus the smallest possible instance
 * of the bug the cheatsheet exists to prevent: the button's own tooltip naming its own key.
 */
describe('the toolbar button', () => {
  it('toggles the panel and names the key without hardcoding it', async () => {
    const t = await load();
    t.layout.layoutStore.getState().hydrate(defaultLayout());
    const { el, commits } = mount(<><t.Toolbar /><t.ShortcutsPanel /></>);
    const button = el.querySelector<HTMLButtonElement>('button[title^="Keyboard shortcuts"]');
    // Against `keyLabel`, not against the literal '⌘/': a rebinding must move this expectation with
    // the app rather than fail it.
    expect(button?.title).toBe(`Keyboard shortcuts (${String(t.keymap.keyLabel({ kind: 'shortcuts' }))})`);
    expect(button?.title).toBe('Keyboard shortcuts (⌘/)');
    // `IconButton` mirrors `title` onto `aria-label`, so the key is announced too.
    expect(button?.getAttribute('aria-label')).toBe(button?.title);
    act(() => button?.click());
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    expect(rows(el).length).toBeGreaterThan(0);
    // A toggle, like ⌘/ — the button that shows it hides it.
    act(() => button?.click());
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
    // The toolbar reads one zustand ACTION and nothing else, so neither a snapshot nor the panel
    // opening may re-render it. Three commits: the mount and the two toggles, each of which is the
    // PANEL rendering under the same Profiler (G59/G61).
    expect(commits()).toBe(3);
  });

  it('renders before bootstrap, with the stores still empty', async () => {
    const t = await load();
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    const { el, commits } = mount(<t.Toolbar />);
    expect(commits()).toBe(1);
    act(() => t.workspace.useWorkspace.getState().setSnapshot(SNAPSHOT));
    // Still 1: a snapshot landing is not this component's business.
    expect(commits()).toBe(1);
    expect(el.querySelector('button[title^="Keyboard shortcuts"]')).not.toBeNull();
  });

  it('opens the Linear dialog from the ticket button, whose tooltip carries ⌘⇧L off the table', async () => {
    const t = await load();
    const { el } = mount(<t.Toolbar />);
    const ticket = el.querySelector<HTMLButtonElement>('button[title^="New agent from Linear ticket"]');
    expect(ticket?.title).toBe(`New agent from Linear ticket (${String(t.keymap.keyLabel({ kind: 'new-agent-linear' }))})`);
    expect(ticket?.title).toBe('New agent from Linear ticket (⌘⇧L)');
    act(() => ticket?.click());
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'linear' });
  });
});

describe('render counts', () => {
  it('commits once, and once under StrictMode\'s double invocation', async () => {
    const t = await load();
    t.workspace.useWorkspace.getState().setSnapshot(SNAPSHOT);
    t.layout.layoutStore.getState().hydrate(defaultLayout());
    act(() => t.ui.useUi.getState().toggleShortcuts());
    expect(mount(<t.ShortcutsPanel />).commits()).toBe(1);
    expect(mountStrict(<t.ShortcutsPanel />).commits()).toBeLessThanOrEqual(2);
  });

  /**
   * G61's half that a populated store cannot reach. Here the nullish path is the DEFAULT one —
   * `Layout.shortcutsPanel` is null until the first drag — so `?? defaultShortcutsRect(…)` inside
   * a selector would loop for every user who has never moved the panel, and a test that only ever
   * mounted with a stored rect would never see it.
   */
  it('commits once with nothing in the stores and no saved position', async () => {
    const t = await load();
    expect(t.workspace.useWorkspace.getState().snapshot).toBeNull();
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toBeNull();
    act(() => t.ui.useUi.getState().toggleShortcuts());
    expect(mount(<t.ShortcutsPanel />).commits()).toBe(1);
  });

  it('commits once more per drag step, not once per subscription', async () => {
    const { t, el, commits } = await open();
    const before = commits();
    drag(panelOf(el).querySelector<HTMLElement>('[data-testid="shortcuts-titlebar"]') as HTMLElement, [10, 400], [110, 400]);
    // Two moves in the gesture, one commit each — and crucially a FINITE number, not 55 then
    // "Maximum update depth exceeded".
    expect(commits() - before).toBeLessThanOrEqual(3);
    expect(t.layout.layoutStore.getState().layout.shortcutsPanel).toMatchObject({ x: 100 });
  });

  /**
   * The control. Without it every `commits() === 1` above could mean the probe is simply blind.
   * Measured on this tree with React 19.2.8: an allocating selector renders ~55 times and then
   * React throws "Maximum update depth exceeded". The selector here is the exact shape this panel
   * would have if its rect were assembled in the selector instead of below it.
   */
  it('catches an allocating selector — proof the counter is not blind', async () => {
    const t = await load();
    t.layout.layoutStore.getState().hydrate(defaultLayout());
    const Looping = (): ReactNode => {
      const rect = t.layout.useLayout((s) => ({ x: s.layout.sidebarWidth, y: 0, w: 0, h: 0 }));
      return <span>{rect.x}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});
