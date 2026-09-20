/**
 * The global keymap (spec §12.3). Three separate claims, because they fail independently:
 *
 *  1. `matchKeymap` — the table itself, and, just as important, everything it must NOT claim. A
 *     keymap that grabs one combo too many is a terminal that silently eats a keystroke.
 *  2. `applyKeymapAction` — each action against the real stores.
 *  3. `installKeymap` — the listener, dispatched as a REAL event at the textarea xterm listens on,
 *     with a live `Terminal` attached. This is the G60-shaped half: a window-CAPTURE listener and
 *     an xterm both want the same keydown, and only a dispatch through the real tree shows who
 *     wins. The pure table cannot see it and neither can a `window.dispatchEvent`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';
import { dictationMessage, type DictationState } from '../../../shared/dictation.ts';
import { defaultLayout, initialSessionState, type Layout } from '../../../shared/types.ts';

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — the same `vi.resetModules()` dance every other renderer test uses. It
 * also gives each test its own store instances.
 */
async function load() {
  const calls: { channel: IpcRequestKey; payload: unknown }[] = [];
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
  const [keymap, layout, ui, registry, search, dictation, sessions] = await Promise.all([
    import('./keymap.ts'),
    import('../stores/layout.ts'),
    import('../stores/ui.ts'),
    import('./terminal-registry.ts'),
    import('../stores/terminal-search.ts'),
    // Plan 09: ⌘D reads the dictation run and the focused agent's session at press time.
    import('../stores/dictation.ts'),
    import('../stores/sessions.ts'),
  ]);
  return { ...keymap, layout, ui, registry, search, dictation, sessions, calls };
}

const key = (patch: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: 'a', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...patch,
});

const cmd = (k: string, shift = false) => key({ key: k, metaKey: true, shiftKey: shift });

let t: Awaited<ReturnType<typeof load>>;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  t = await load();
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = '';
});

const hydrate = (patch: Partial<Layout>): void => t.layout.layoutStore.getState().hydrate({ ...defaultLayout(), ...patch });

describe('matchKeymap — what Hangar claims', () => {
  it('maps every row of spec §12.3\'s table', () => {
    expect(t.matchKeymap(cmd('n'), false)).toEqual({ kind: 'new-agent' });
    expect(t.matchKeymap(cmd('N', true), false)).toEqual({ kind: 'new-folder' });
    expect(t.matchKeymap(cmd('L', true), false)).toEqual({ kind: 'new-agent-linear' });
    // Spec §12.3: "⌘K | Quick switcher (Phase 3; Phase 1 focuses the sidebar search)". Plan 05
    // Task 1 is Phase 3, so ⌘K is the palette and the sidebar search moves to ⌘⇧K — a combo the
    // table did not claim before, so nothing was displaced to make room.
    expect(t.matchKeymap(cmd('k'), false)).toEqual({ kind: 'quick-switcher' });
    expect(t.matchKeymap(cmd('K', true), false)).toEqual({ kind: 'focus-search' });
    expect(t.matchKeymap(cmd('f'), false)).toEqual({ kind: 'terminal-search' });
    expect(t.matchKeymap(cmd('1'), false)).toEqual({ kind: 'focus-pane', index: 0 });
    expect(t.matchKeymap(cmd('4'), false)).toEqual({ kind: 'focus-pane', index: 3 });
    expect(t.matchKeymap(cmd('D', true), false)).toEqual({ kind: 'add-pane' });
    expect(t.matchKeymap(cmd('W', true), false)).toEqual({ kind: 'close-pane' });
    expect(t.matchKeymap(cmd('b'), false)).toEqual({ kind: 'toggle-sidebar' });
    expect(t.matchKeymap(cmd('e'), false)).toEqual({ kind: 'toggle-drawer' });
    expect(t.matchKeymap(cmd('F', true), false)).toEqual({ kind: 'drawer-tab', tab: 'files' });
    expect(t.matchKeymap(cmd('G', true), false)).toEqual({ kind: 'drawer-tab', tab: 'diff' });
    expect(t.matchKeymap(cmd('M', true), false)).toEqual({ kind: 'drawer-tab', tab: 'notes' });
    // Plan 09. Unshifted ⌘D beside ⌘⇧D: two keys, two actions.
    expect(t.matchKeymap(cmd('d'), false)).toEqual({ kind: 'dictate' });
  });

  // Every one of these has to reach either xterm or Electron untouched. ⌘C/⌘V are the terminal's
  // copy and paste (G20), ⌘, is Settings in Phase 3, ⌘Q/⌘W are Electron's own menu.
  it('claims nothing else that carries ⌘', () => {
    for (const k of ['c', 'v', 'a', 'z', 'x', ',', 'q', 'w', '5', '0', 'Enter', 'ArrowLeft']) {
      expect(t.matchKeymap(cmd(k), false)).toBeNull();
    }
  });

  /**
   * The other keyboard in the window: CodeMirror, in the drawer's Files and Diff tabs (Plan 04).
   * `lib/codemirror.ts` installs `defaultKeymap` + `searchKeymap`, and this table wins every
   * collision it enters — `installKeymap` captures on `window` and calls `stopPropagation()`, so a
   * combo Hangar claims never reaches the editor's own handler at all.
   *
   * Read off `@codemirror/search`'s own binding list, which is Mod-f (open panel), Mod-g / F3
   * (find next), **Shift-Mod-g / Shift-F3 (find previous)**, Mod-Alt-g (go to line) and Mod-d
   * (select next occurrence).
   *
   * **What Plan 04 Task 4 recorded, and what changed.** P4-4 swept this list and found exactly one
   * collision — ⌘⇧G is Hangar's Diff tab, so find-previous is unreachable by that combo in a
   * focused editor and Shift-F3 is the way to it — with ⌘F, ⌘G and ⌘D all unclaimed and reaching
   * CodeMirror intact. **Plan 05 Task 3 spends ⌘F on terminal search**, so that finding no longer
   * holds unqualified: ⌘F is claimed, and what keeps CodeMirror's find panel working is no longer
   * "Hangar never asks for it" but `OWNED_BY_CODE_EDITOR` — the keymap routes ⌘F to whichever
   * surface has the keyboard. The unchanged half of P4-4 still stands and is asserted below: ⌘G is
   * unclaimed in BOTH surfaces, ⌘⇧G is still Hangar's, and ⌘⌥G is filtered by the alt gate.
   *
   * **Plan 09 spends ⌘D**, on dictation, and it is settled the ⌘⇧G way, not the ⌘F way: Hangar's in
   * the viewer too (`OWNED_BY_CODE_EDITOR.dictate` is false), so `selectNextOccurrence` is
   * unreachable by that combo in a focused viewer. The binding's caveat says so in the cheatsheet.
   *
   * `isTextField` cannot arbitrate this and that is the whole reason a second surface test exists:
   * the viewer is `EditorView.editable.of(false)`, hence `contenteditable="false"`, hence NOT a text
   * field (asserted below in its own test), so `WORKS_IN_TEXT_FIELD` never sees the case.
   */
  it('routes ⌘F by surface, leaves ⌘G alone in both, and takes ⌘⇧G and ⌘D from CodeMirror', () => {
    // ⌘F: the editor's while the editor has the keyboard, Hangar's everywhere else.
    expect(t.matchKeymap(cmd('f'), false, true)).toBeNull();
    expect(t.matchKeymap(cmd('f'), false, false)).toEqual({ kind: 'terminal-search' });
    // The CodeMirror find PANEL is both a code editor and a real `<input>`. ⌘F has to stay the
    // editor's there too, which is why the code-editor gate is checked before the text-field one.
    expect(t.matchKeymap(cmd('f'), true, true)).toBeNull();
    // Unchanged from P4-4: still nobody's but CodeMirror's, in either surface.
    expect(t.matchKeymap(cmd('g'), false, false)).toBeNull();
    expect(t.matchKeymap(cmd('g'), false, true)).toBeNull();
    // Plan 09: ⌘D is dictation in BOTH surfaces — the viewer's select-next-occurrence gives it up.
    expect(t.matchKeymap(cmd('d'), false, false)).toEqual({ kind: 'dictate' });
    expect(t.matchKeymap(cmd('d'), false, true)).toEqual({ kind: 'dictate' });
    expect(t.shortcutFor({ kind: 'dictate' })?.caveat).toContain('select the next occurrence');
    // Unchanged from P4-4: ⌘⇧G is the Diff tab, in the editor as everywhere else.
    expect(t.matchKeymap(cmd('G', true), false, true)).toEqual({ kind: 'drawer-tab', tab: 'diff' });
    // ⌘⇧F is still the Files tab. Adding unshifted ⌘F displaced nothing.
    expect(t.matchKeymap(cmd('F', true), false, false)).toEqual({ kind: 'drawer-tab', tab: 'files' });
  });

  /**
   * The narrowness of the code-editor rule, asserted so that widening it fails.
   *
   * `OWNED_BY_CODE_EDITOR` gives the editor ⌘F and nothing else. The failure mode it is written
   * against is a future "just ignore everything inside `.cm-editor`", which would silently deaden
   * the whole app over one drawer panel — the user could not open an agent, toggle the drawer the
   * viewer lives in, or move to a terminal. Every one of these is window chrome and must survive.
   */
  it('keeps window chrome live over the CodeMirror viewer', () => {
    expect(t.matchKeymap(cmd('n'), false, true)).toEqual({ kind: 'new-agent' });
    expect(t.matchKeymap(cmd('k'), false, true)).toEqual({ kind: 'quick-switcher' });
    expect(t.matchKeymap(cmd('b'), false, true)).toEqual({ kind: 'toggle-sidebar' });
    expect(t.matchKeymap(cmd('e'), false, true)).toEqual({ kind: 'toggle-drawer' });
    expect(t.matchKeymap(cmd('1'), false, true)).toEqual({ kind: 'focus-pane', index: 0 });
    expect(t.matchKeymap(cmd('F', true), false, true)).toEqual({ kind: 'drawer-tab', tab: 'files' });
    expect(t.matchKeymap(cmd('M', true), false, true)).toEqual({ kind: 'drawer-tab', tab: 'notes' });
    expect(t.matchKeymap(cmd('W', true), false, true)).toEqual({ kind: 'close-pane' });
  });

  // Everything a terminal user types. Without the metaKey gate the app would eat the shell.
  it('claims nothing without ⌘, and nothing with ⌃ or ⌥ also held', () => {
    expect(t.matchKeymap(key({ key: 'n' }), false)).toBeNull();
    expect(t.matchKeymap(key({ key: 'k' }), false)).toBeNull();
    expect(t.matchKeymap(key({ key: 'c', ctrlKey: true }), false)).toBeNull();
    expect(t.matchKeymap(key({ key: 'Enter', shiftKey: true }), false)).toBeNull();
    expect(t.matchKeymap(key({ key: 'n', metaKey: true, ctrlKey: true }), false)).toBeNull();
    expect(t.matchKeymap(key({ key: 'n', metaKey: true, altKey: true }), false)).toBeNull();
  });

  // ⇧1 is '!', not a pane number; the digits are read from the raw `e.key` for exactly this.
  it('does not read a shifted digit as a pane number', () => {
    expect(t.matchKeymap(cmd('!', true), false)).toBeNull();
    expect(t.matchKeymap(cmd('1', true), false)).toBeNull();
  });

  /**
   * Window chrome keeps working with the caret in a text field; creating and closing things does
   * not. Task 6 narrowed to ⌘K alone and Task 7 measured what that cost: ⌘E could not close the
   * drawer from inside the drawer's OWN notes textarea, and ⌘⇧F/G/M could not switch away from
   * the tab holding it. Spec §12.5 writes that shortcut as "Toggle ⌘E", unqualified.
   */
  it('keeps window chrome live inside a text field', () => {
    expect(t.matchKeymap(cmd('k'), true)).toEqual({ kind: 'quick-switcher' });
    expect(t.matchKeymap(cmd('K', true), true)).toEqual({ kind: 'focus-search' });
    expect(t.matchKeymap(cmd('b'), true)).toEqual({ kind: 'toggle-sidebar' });
    expect(t.matchKeymap(cmd('e'), true)).toEqual({ kind: 'toggle-drawer' });
    expect(t.matchKeymap(cmd('1'), true)).toEqual({ kind: 'focus-pane', index: 0 });
    expect(t.matchKeymap(cmd('4'), true)).toEqual({ kind: 'focus-pane', index: 3 });
    expect(t.matchKeymap(cmd('F', true), true)).toEqual({ kind: 'drawer-tab', tab: 'files' });
    expect(t.matchKeymap(cmd('G', true), true)).toEqual({ kind: 'drawer-tab', tab: 'diff' });
    expect(t.matchKeymap(cmd('M', true), true)).toEqual({ kind: 'drawer-tab', tab: 'notes' });
  });

  it('blocks the creational and destructive half inside a text field', () => {
    expect(t.matchKeymap(cmd('n'), true)).toBeNull();
    expect(t.matchKeymap(cmd('N', true), true)).toBeNull();
    expect(t.matchKeymap(cmd('L', true), true)).toBeNull();
    expect(t.matchKeymap(cmd('D', true), true)).toBeNull();
    expect(t.matchKeymap(cmd('W', true), true)).toBeNull();
  });

  /**
   * Plan 09. ⌘D in a REAL text field is not claimed: the caret says where typed words go, and a
   * dictation would type into the focused pane's terminal instead. This is NOT the terminal's case —
   * a focused terminal is not a text field (`isTextField`'s `.xterm` hatch), and the real-event test
   * in `installKeymap` below dispatches ⌘D at a live xterm's own textarea to prove it is claimed there.
   */
  it('does not dictate from a text field, where the caret is somewhere the words would not go', () => {
    expect(t.matchKeymap(cmd('d'), true)).toBeNull();
    // …and the code viewer's find PANEL is a text field inside a code editor: still not claimed.
    expect(t.matchKeymap(cmd('d'), true, true)).toBeNull();
  });

  /**
   * ⌘F is surface-scoped, so a surface with no find does not get one.
   *
   * It sits with the blocked half rather than the chrome half, which looks inconsistent next to
   * ⌘1–4 — that also moves the keyboard out of the box being typed in — and is not. ⌘1–4 is an
   * explicit "go to pane N"; ⌘F means "find in the thing I am looking at", and from the sidebar
   * search box or the notes textarea the thing being looked at has no find. Redirecting it to some
   * other pane's terminal would open a focus-stealing overlay somewhere the user is not. Returning
   * null instead leaves the combo unclaimed, so it falls through to Chromium, which does nothing.
   */
  it('does not claim ⌘F inside a text field', () => {
    expect(t.matchKeymap(cmd('f'), true)).toBeNull();
  });

  // Neither half of the table gets an exemption from the ⌘ gate: a text field's own ⌘ vocabulary
  // has to reach it.
  it('still claims nothing unmodified or otherwise-modified inside a text field', () => {
    expect(t.matchKeymap(key({ key: 'e' }), true)).toBeNull();
    expect(t.matchKeymap(key({ key: 'b', metaKey: true, altKey: true }), true)).toBeNull();
    expect(t.matchKeymap(cmd('a'), true)).toBeNull();
    expect(t.matchKeymap(cmd('z'), true)).toBeNull();
  });
});

describe('isTextField', () => {
  const el = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  it('recognises the places a user types prose', () => {
    expect(t.isTextField(el('<input />'))).toBe(true);
    expect(t.isTextField(el('<textarea></textarea>'))).toBe(true);
    expect(t.isTextField(el('<select></select>'))).toBe(true);
    expect(t.isTextField(el('<div contenteditable="true"></div>'))).toBe(true);
  });

  it('is false for ordinary elements and for a missing target', () => {
    expect(t.isTextField(el('<div></div>'))).toBe(false);
    expect(t.isTextField(el('<button></button>'))).toBe(false);
    expect(t.isTextField(null)).toBe(false);
  });

  /**
   * The drawer's CodeMirror viewer, both halves of it (Plan 04).
   *
   * The editor's content is `contenteditable="false"` — `lib/codemirror.ts` sets
   * `EditorView.editable.of(false)` — and the selector matches only `"true"`, so a focused viewer
   * is NOT a text field and the full table stays live over it. That is the right answer: reading a
   * file is not typing prose, and ⌘N over a read-only viewer should open the New Agent dialog.
   * `@codemirror/search`'s panel is a real `<input>`, so typing a search term there does block
   * ⌘N/⌘⇧W the way typing anywhere else does.
   */
  it('treats a read-only CodeMirror as chrome and its search panel as prose', () => {
    expect(t.isTextField(el('<div class="cm-content" contenteditable="false" tabindex="0"></div>'))).toBe(false);
    expect(t.isTextField(el('<input class="cm-textfield" placeholder="Find" />'))).toBe(true);
  });

  /**
   * The load-bearing case. xterm's keyboard input goes through a real
   * `<textarea class="xterm-helper-textarea">`, so without the `.xterm` escape hatch a focused
   * terminal — this app's resting state — would classify as a text field and every shortcut in
   * the table would be dead exactly where it matters.
   */
  it('is false inside a terminal, even though xterm types into a real <textarea>', () => {
    document.body.innerHTML = '<div class="xterm"><div><textarea class="xterm-helper-textarea"></textarea></div></div>';
    const textarea = document.querySelector('textarea') as HTMLElement;
    expect(textarea.matches('textarea')).toBe(true);
    expect(t.isTextField(textarea)).toBe(false);
  });
});

/**
 * The second surface test (Plan 05 Task 3).
 *
 * It exists because `isTextField` provably cannot answer this question. The drawer's viewer is
 * `EditorView.editable.of(false)`, which `@codemirror/view` writes to the DOM as
 * `contenteditable="false"` — `codemirror.test.ts` asserts the attribute, and the test two blocks up
 * asserts that `isTextField` therefore returns false for it. So by the time ⌘F is classified, the
 * text-field flag is already false and no `WORKS_IN_TEXT_FIELD` entry can route it.
 */
describe('isCodeEditor', () => {
  const el = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  // `closest`, not `matches`: the keydown's target is the content div or a descendant span of it,
  // never the `.cm-editor` wrapper itself.
  it('is true for the editor wrapper and anything inside it', () => {
    expect(t.isCodeEditor(el('<div class="cm-editor"></div>'))).toBe(true);
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" contenteditable="false"><span class="tok">x</span></div></div></div>';
    expect(t.isCodeEditor(document.querySelector('.cm-content'))).toBe(true);
    expect(t.isCodeEditor(document.querySelector('span.tok'))).toBe(true);
  });

  // CodeMirror renders its find panel inside the editor wrapper, so the panel's own input is a code
  // editor AND a text field. Both flags true is the case `matchKeymap` orders its gates for.
  it('is true for the search panel input, which is also a text field', () => {
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-panels"><input class="cm-textfield" /></div></div>';
    const input = document.querySelector('input') as HTMLElement;
    expect(t.isCodeEditor(input)).toBe(true);
    expect(t.isTextField(input)).toBe(true);
  });

  it('is false for a terminal, for ordinary chrome and for a missing target', () => {
    expect(t.isCodeEditor(el('<div class="xterm"></div>'))).toBe(false);
    expect(t.isCodeEditor(el('<div></div>'))).toBe(false);
    expect(t.isCodeEditor(null)).toBe(false);
  });
});

describe('applyKeymapAction', () => {
  it('opens the two creation dialogs at the root', () => {
    t.applyKeymapAction({ kind: 'new-agent' });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });
    t.ui.useUi.getState().closeDialog();
    t.applyKeymapAction({ kind: 'new-folder' });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-folder', parentId: null });
  });

  it('raises the quick switcher', () => {
    t.applyKeymapAction({ kind: 'quick-switcher' });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
  });

  it('opens the Linear dialog', () => {
    t.applyKeymapAction({ kind: 'new-agent-linear' });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'linear' });
  });

  it('bumps the search-focus request rather than setting a flag that cannot repeat', () => {
    const before = t.ui.useUi.getState().searchFocusRequest;
    t.applyKeymapAction({ kind: 'focus-search' });
    t.applyKeymapAction({ kind: 'focus-search' });
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(before + 2);
  });

  /**
   * ⌘F toggles the find bar of the FOCUSED agent, resolved through `focusedAgent` so a clamped or
   * sparse `focusedIndex` lands on the same agent the rest of the app calls focused.
   */
  it('toggles the focused agent\'s find bar, and only that agent\'s', () => {
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
    t.applyKeymapAction({ kind: 'terminal-search' });
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a2']);
    t.applyKeymapAction({ kind: 'terminal-search' });
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  /**
   * `focusedAgent` clamps, where `panes[focusedIndex]` would read `undefined`.
   *
   * The state is written STRAIGHT into the store rather than through `hydrate`, and that detail is
   * the finding: `hydrate` runs `normalizeLayout`, which repairs the focus index, and so does every
   * reducer behind `apply`. Measured — going through `hydrate({ panes: ['a1'], focusedIndex: 3 })`
   * normalises the index to 0 before the action ever runs, so that spelling of this test passes
   * whichever lookup the action uses and proves nothing. Written this way it fails when the action
   * is reverted to `panes[focusedIndex] ?? null`.
   *
   * So the clamp is defence in depth against a state the store does not currently produce, kept for
   * the reason `shared/layout.ts` gives — one clamped implementation, because the hand-rolled
   * version was about to be written out four times — and matching `bootstrap.ts`'s call.
   */
  it('clamps an out-of-range focused index instead of finding no agent', () => {
    const layout = { ...defaultLayout(), panes: ['a1'], focusedIndex: 3 };
    t.layout.layoutStore.setState({ layout, hydrated: true });
    t.applyKeymapAction({ kind: 'terminal-search' });
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a1']);
  });

  // An empty grid claims the combo and does nothing with it, the way ⌘4 with two panes does.
  it('does nothing when no pane holds an agent', () => {
    hydrate({ panes: [], focusedIndex: 0 });
    expect(() => t.applyKeymapAction({ kind: 'terminal-search' })).not.toThrow();
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
  });

  it('focuses the pane and moves the KEYBOARD there too', () => {
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 0 });
    const handle = t.registry.createTerminal({ fontFamily: 'monospace', fontSize: 13, scrollback: 10, onShiftEnter: () => undefined, onOpenLink: () => undefined, onEscape: () => false });
    cleanups.push(() => handle.dispose());
    const el = document.createElement('div');
    document.body.appendChild(el);
    handle.term.open(el);
    const focus = vi.spyOn(handle.term, 'focus');
    t.registry.terminals.set('a2', handle);
    cleanups.push(() => t.registry.terminals.clear());
    t.applyKeymapAction({ kind: 'focus-pane', index: 1 });
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
    expect(focus).toHaveBeenCalled();
  });

  // ⌘4 with two panes open is still swallowed (the table claimed it) but must not move focus to a
  // slot that does not exist, nor throw.
  it('ignores a pane number past the end of the grid', () => {
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
    t.applyKeymapAction({ kind: 'focus-pane', index: 3 });
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });

  it('adds a pane, and says why when it cannot', () => {
    hydrate({ panes: ['a1'] });
    t.applyKeymapAction({ kind: 'add-pane' });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', null]);
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
    hydrate({ panes: ['a1', 'a2', null, null] });
    t.applyKeymapAction({ kind: 'add-pane' });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2', null, null]);
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['All four panes are in use']);
  });

  it('closes the FOCUSED pane, not the first one', () => {
    hydrate({ panes: ['a1', 'a2', 'a3'], focusedIndex: 1 });
    t.applyKeymapAction({ kind: 'close-pane' });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a3']);
  });

  it('toggles the sidebar and the drawer both ways', () => {
    hydrate({ sidebarVisible: true, drawerOpen: false });
    t.applyKeymapAction({ kind: 'toggle-sidebar' });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
    t.applyKeymapAction({ kind: 'toggle-sidebar' });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(true);
    t.applyKeymapAction({ kind: 'toggle-drawer' });
    expect(t.layout.layoutStore.getState().layout.drawerOpen).toBe(true);
    t.applyKeymapAction({ kind: 'toggle-drawer' });
    expect(t.layout.layoutStore.getState().layout.drawerOpen).toBe(false);
  });

  // ⌘⇧F/G/M name a tab, so they must OPEN the drawer rather than switching a hidden one.
  /**
   * ⌘/ is the twelfth action. **This test used to assert the opposite of its last two lines**: while
   * the cheatsheet was a `<dialog>` it went through `ui.dialog`, `applyKeymapAction` only ever
   * OPENED, and the toggle lived in `installKeymap` via `OPENS_DIALOG` — so a second call left the
   * dialog up, and the old test said so ("Twice, to say plainly that this function is not where the
   * toggle is"). The panel is not a dialog any anymore (X5-3), nothing stands down behind it, and the
   * toggle moved HERE, beside `toggle-sidebar` and `toggle-drawer`. Raising no dialog is now part
   * of the claim: that is what keeps every other shortcut alive while the panel is showing.
   */
  it('toggles the shortcut cheatsheet panel, and raises no dialog', () => {
    t.applyKeymapAction({ kind: 'shortcuts' });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    t.applyKeymapAction({ kind: 'shortcuts' });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
  });

  /**
   * **The guard that keeps `OPENS_DIALOG` honest**, and the reason a `Record` is not enough on its
   * own here. `tsc` forces a thirteenth action to be given an entry, but `null` is a legitimate
   * value for most rows, so a new dialog-opening action written as `null` compiles clean and
   * silently loses its toggle (G73's "keep the run-time half", in the only form that fits).
   *
   * So the table is cross-checked against what the code actually does: every action in `SHORTCUTS`
   * — payload variants included — is dispatched at the real stores from a closed dialog, and the
   * dialog that appears (or the absence of one) must be exactly what `OPENS_DIALOG` names.
   * Mislabelling a row in EITHER direction fails: `'toggle-drawer': 'host-panel'` fails because no
   * dialog appears, `'new-agent': null` fails because one does.
   *
   * `shortcuts` is the row that changed in X5-3, and it is the one this table can no longer speak
   * for: the cheatsheet raises no dialog at all now, so `null` is right here and the thing that
   * would otherwise go unchecked — that ⌘/ still DOES something — is asserted separately below.
   */
  it('OPENS_DIALOG names the dialog each action actually opens', () => {
    const kinds = Object.keys(t.SHORTCUTS) as (keyof typeof t.SHORTCUTS)[];
    // **This line cannot fail while `tsc` is green, and is documentation rather than a guard.**
    // Measured: an extra key in `OPENS_DIALOG` is `TS2353` and a missing one `TS2741`, both exit
    // **2** on `tsconfig.web.json`. It is here because the loop below iterates `SHORTCUTS`' keys
    // and a reader is owed the reason that covers `OPENS_DIALOG`'s.
    expect([...kinds].sort()).toEqual(Object.keys(t.OPENS_DIALOG).sort());
    const raised: string[] = [];
    for (const kind of kinds) {
      for (const shortcut of t.SHORTCUTS[kind]) {
        t.ui.useUi.getState().closeDialog();
        t.applyKeymapAction(shortcut.action);
        const dialog = t.ui.useUi.getState().dialog;
        expect({ kind, opened: dialog === null ? null : dialog.kind }).toEqual({ kind, opened: t.OPENS_DIALOG[kind] });
        if (dialog !== null) raised.push(dialog.kind);
      }
    }
    t.ui.useUi.getState().closeDialog();
    // Not vacuous: four kinds really did raise something. The loop alone cannot say that — an
    // `applyKeymapAction` that opened nothing at all, paired with an all-null table, agrees with
    // every assertion above and fails only on this line.
    expect([...new Set(raised)].sort()).toEqual(['linear', 'new-agent', 'new-folder', 'quick-switcher']);
    // The cheatsheet's row is `null` because it is not a dialog — not because ⌘/ does nothing. The
    // loop above cannot tell those apart, so this is the half of the cross-check that covers it.
    t.ui.useUi.getState().closeShortcuts();
    t.applyKeymapAction({ kind: 'shortcuts' });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  describe('dictate (⌘D, Plan 09)', () => {
    const live = (id: string): void => t.sessions.useSessions.getState().setOne(id, { ...initialSessionState(id), activity: 'idle' });
    const dictation = (channel: IpcRequestKey) => t.calls.filter((c) => c.channel === channel).map((c) => c.payload);
    const heard = (agentId: string, state: DictationState): void => t.dictation.useDictation.getState().receive({ agentId, state, outcome: null });

    it('starts a dictation into the FOCUSED pane\'s agent, and only that one', () => {
      hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
      live('a1');
      live('a2');
      t.applyKeymapAction({ kind: 'dictate' });
      expect(dictation('dictation:start')).toEqual([{ agentId: 'a2' }]);
    });

    // The toggle is `toggleRequest` of the focused agent's own run — press again to stop, and a
    // press before `ready` cancels (a stop there would come back as NO_INPUT).
    it('sends what toggleRequest asks for in each phase of the focused agent\'s run', () => {
      hydrate({ panes: ['a1'], focusedIndex: 0 });
      live('a1');
      heard('a1', { phase: 'recording', partial: 'so' });
      t.applyKeymapAction({ kind: 'dictate' });
      heard('a1', { phase: 'preparing' });
      t.applyKeymapAction({ kind: 'dictate' });
      heard('a1', { phase: 'finalizing', partial: 'so' });
      t.applyKeymapAction({ kind: 'dictate' });
      expect(t.calls.map((c) => c.channel)).toEqual(['dictation:stop', 'dictation:cancel']);
    });

    // A key cannot be disabled, so where the button would be greyed out ⌘D says why instead — the
    // button's own tooltip sentence, from `shared/dictation.ts`.
    it('refuses with the button\'s sentence when the agent is not running, or another agent is being dictated to', () => {
      hydrate({ panes: ['a1', 'a2'], focusedIndex: 0 });
      t.applyKeymapAction({ kind: 'dictate' });
      live('a1');
      heard('a2', { phase: 'recording', partial: '' });
      t.applyKeymapAction({ kind: 'dictate' });
      expect(t.calls).toEqual([]);
      expect(t.ui.useUi.getState().toasts.map((x) => [x.level, x.title])).toEqual([
        ['warn', dictationMessage('NOT_RUNNING')],
        ['warn', dictationMessage('ELSEWHERE')],
      ]);
    });

    it('claims the key and does nothing on an empty pane', () => {
      hydrate({ panes: [null], focusedIndex: 0 });
      expect(() => t.applyKeymapAction({ kind: 'dictate' })).not.toThrow();
      expect(t.calls).toEqual([]);
      expect(t.ui.useUi.getState().toasts).toEqual([]);
    });
  });

  it('opens the drawer on the tab the shortcut names', () => {
    hydrate({ drawerOpen: false, drawerTab: 'notes' });
    t.applyKeymapAction({ kind: 'drawer-tab', tab: 'diff' });
    const layout = t.layout.layoutStore.getState().layout;
    expect(layout.drawerOpen).toBe(true);
    expect(layout.drawerTab).toBe('diff');
  });
});

/**
 * The shortcut TABLE — the thing `match` looks up and the thing every key caption in the app is
 * rendered from. Two consumers, one array, so the whole class of "the tooltip says ⌘N and the
 * keymap has moved on" is unspellable rather than merely unlikely.
 *
 * The strong assertion is the SWEEP: for every ⌘ chord this app could plausibly meet, the table and
 * `matchKeymap` must agree — nothing in the table that `matchKeymap` refuses, and nothing
 * `matchKeymap` claims that the table does not list. That is what makes it impossible to add a
 * binding to `match` without giving it a caption, or to change a binding and leave a caption behind.
 *
 * It is also what pins `match`'s rewrite: it used to be a ladder of `if (key === 'n')`, with the
 * pane digits read off the RAW `e.key` so that ⇧1 ('!') could not count as pane 1. The sweep below
 * covers both spellings of that case.
 */
describe('the shortcut table', () => {
  const all = () => Object.values(t.SHORTCUTS).flat();

  it('round-trips every entry through matchKeymap', () => {
    for (const s of all()) {
      expect(t.matchKeymap(cmd(s.chord.key, s.chord.shiftKey), false)).toEqual(s.action);
    }
  });

  /**
   * Both directions, over the whole keyspace a ⌘ chord can occupy on this keyboard: every letter,
   * every digit, the punctuation a US layout puts on an unshifted key, and the named keys.
   *
   * Shifted letters are dispatched the way macOS reports them (uppercase), which is the case
   * `match`'s `toLowerCase()` exists for. Shifted digits are dispatched BOTH ways — as the symbol
   * macOS really sends ('!') and as the digit a different layout might — because the old ladder
   * guarded that with `PANE_DIGITS.includes(e.key)` on the raw key and the table-lookup rewrite
   * guards it with `shiftKey: false` on every digit row instead. Neither must claim ⌘⇧1.
   */
  it('agrees with matchKeymap across the entire ⌘ keyspace, in both directions', () => {
    const letters = [...'abcdefghijklmnopqrstuvwxyz'];
    const digits = [...'0123456789'];
    const punctuation = [...'`-=[]\\;\'/.,'];
    const named = ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'F3'];
    const chords: { key: string; shift: boolean; lookup: string }[] = [];
    for (const k of [...letters, ...digits, ...punctuation, ...named]) {
      chords.push({ key: k, shift: false, lookup: k.toLowerCase() });
      chords.push({ key: k.toUpperCase(), shift: true, lookup: k.toLowerCase() });
    }
    // The macOS spelling of ⌘⇧1…⌘⇧4, which no `toUpperCase()` produces.
    for (const symbol of ['!', '@', '#', '$']) chords.push({ key: symbol, shift: true, lookup: symbol });

    const table = new Map(all().map((s) => [`${s.chord.key}/${String(s.chord.shiftKey)}`, s.action]));
    let claimed = 0;
    for (const c of chords) {
      const expected = table.get(`${c.lookup}/${String(c.shift)}`) ?? null;
      // `false, false`: the surface gates are a separate question, tested above. This is the table.
      expect({ ...c, action: t.matchKeymap(cmd(c.key, c.shift), false, false) }).toEqual({ ...c, action: expected });
      if (expected !== null) claimed += 1;
    }
    // The sweep is only meaningful if it actually reached every row. 19 chords: ⌘N ⌘⇧N ⌘⇧L ⌘K ⌘⇧K
    // ⌘1–4 ⌘⇧D ⌘⇧W ⌘D ⌘B ⌘E ⌘⇧F ⌘⇧G ⌘⇧M ⌘/ ⌘F.
    expect(claimed).toBe(all().length);
    expect(claimed).toBe(19);
  });

  it('binds every action kind to at least one chord, and every chord exactly once', () => {
    // The `NonEmpty` tuple type already makes `fake: []` a compile error; this is the runtime half,
    // and it is what a `Record<..., Shortcut[]>` regression would trip over.
    for (const [kind, entries] of Object.entries(t.SHORTCUTS)) expect([kind, entries.length > 0]).toEqual([kind, true]);
    const labels = all().map((s) => t.chordLabel(s.chord));
    expect(labels.length).toBe(new Set(labels).size);
  });

  /**
   * The two classification tables are keyed off the same union as `SHORTCUTS`, so `tsc` already
   * refuses a kind missing from any of the three. This asserts the consequence the cheatsheet
   * depends on at run time: every row it draws can look its flags up and get a boolean, never
   * `undefined` — which would render as a blank marker rather than an error.
   */
  it('classifies every bound action in both surface tables', () => {
    for (const s of all()) {
      expect([s.action.kind, typeof t.WORKS_IN_TEXT_FIELD[s.action.kind]]).toEqual([s.action.kind, 'boolean']);
      expect([s.action.kind, typeof t.OWNED_BY_CODE_EDITOR[s.action.kind]]).toEqual([s.action.kind, 'boolean']);
    }
    expect(Object.keys(t.WORKS_IN_TEXT_FIELD).sort()).toEqual(Object.keys(t.SHORTCUTS).sort());
    expect(Object.keys(t.OWNED_BY_CODE_EDITOR).sort()).toEqual(Object.keys(t.SHORTCUTS).sort());
  });

  it('renders a chord as the caption a Mac user reads', () => {
    expect(t.chordLabel({ key: 'n', shiftKey: false })).toBe('⌘N');
    expect(t.chordLabel({ key: 'w', shiftKey: true })).toBe('⌘⇧W');
    expect(t.chordLabel({ key: '1', shiftKey: false })).toBe('⌘1');
    expect(t.chordLabel({ key: '/', shiftKey: false })).toBe('⌘/');
  });

  /**
   * The payload matters, not just the kind: pane 3 is ⌘3. `shortcutFor` compares every own key of
   * the action, which IS deep equality only while every payload field is a primitive — asserted
   * here by walking the table, so an action that later carries an object fails this rather than
   * silently matching the wrong row.
   */
  it('finds the binding for a specific action payload, and admits when there is none', () => {
    for (const s of all()) {
      for (const [, v] of Object.entries(s.action)) expect([s.action.kind, typeof v === 'object']).toEqual([s.action.kind, false]);
    }
    expect(t.keyLabel({ kind: 'focus-pane', index: 0 })).toBe('⌘1');
    expect(t.keyLabel({ kind: 'focus-pane', index: 2 })).toBe('⌘3');
    expect(t.keyLabel({ kind: 'drawer-tab', tab: 'notes' })).toBe('⌘⇧M');
    expect(t.keyLabel({ kind: 'drawer-tab', tab: 'diff' })).toBe('⌘⇧G');
    // Nothing is bound to a fifth pane. Null, not '⌘5' and not '⌘1'.
    expect(t.shortcutFor({ kind: 'focus-pane', index: 8 })).toBeNull();
    expect(t.keyLabel({ kind: 'focus-pane', index: 8 })).toBeNull();
  });

  it('appends the key to a tooltip, and leaves the text alone when there is no key', () => {
    expect(t.withShortcut('Files', { kind: 'drawer-tab', tab: 'files' })).toBe('Files (⌘⇧F)');
    expect(t.withShortcut('Focus pane 9', { kind: 'focus-pane', index: 8 })).toBe('Focus pane 9');
  });

  /**
   * The caption in `applyKeymapAction`'s four-panes toast. It read "(⌘⇧W)" as a literal until this
   * change; asserting it against `keyLabel` rather than against the string '⌘⇧W' is what makes the
   * test move with a rebinding instead of failing on one.
   */
  it('interpolates the close-pane key into the four-panes toast', () => {
    hydrate({ panes: [null, null, null, null], focusedIndex: 0 });
    t.applyKeymapAction({ kind: 'add-pane' });
    const toast = t.ui.useUi.getState().toasts[0];
    expect(toast?.detail).toBe(`Close a pane (${String(t.keyLabel({ kind: 'close-pane' }))}) first.`);
    expect(toast?.detail).toContain('⌘⇧W');
  });
});

describe('installKeymap (real events)', () => {
  const press = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it('handles a claimed combo and swallows it', () => {
    cleanups.push(t.installKeymap());
    hydrate({ sidebarVisible: true });
    const event = press(document.body, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * The real guard on the surface routing, and the reason `matchKeymap`'s third argument can safely
   * default to false: this dispatches through the actual tree, so it fails if `installKeymap` ever
   * stops passing `isCodeEditor(e.target)`.
   *
   * Deleting that argument from the call in `installKeymap` fails the first two assertions —
   * measured by reverting it — because ⌘F would then be claimed and swallowed over the viewer and
   * CodeMirror's own `Mod-f` binding would never run.
   *
   * jsdom caveat, stated plainly: this proves Hangar does not CLAIM the event (no `preventDefault`,
   * no `stopPropagation`), which is the half that lives in this repo. That CodeMirror then opens its
   * panel is `@codemirror/search`'s `Mod-f`, and whether the panel actually appears is a CDP
   * question, not one jsdom can answer.
   */
  it('leaves ⌘F to CodeMirror when the event comes from inside the viewer', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1'], focusedIndex: 0 });
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content" contenteditable="false" tabindex="0"></div></div>';
    const content = document.querySelector('.cm-content') as HTMLElement;
    const event = press(content, { key: 'f', metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
    // …and the same key from anywhere else IS Hangar's, so the test is not passing because ⌘F is
    // simply broken everywhere.
    const outside = press(document.body, { key: 'f', metaKey: true });
    expect(outside.defaultPrevented).toBe(true);
    expect([...t.search.useTerminalSearch.getState().open]).toEqual(['a1']);
  });

  // Window chrome still reaches the app from inside the viewer. A blanket "ignore `.cm-editor`"
  // passes the test above and fails this one.
  it('still handles window chrome dispatched from inside the viewer', () => {
    cleanups.push(t.installKeymap());
    hydrate({ sidebarVisible: true });
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content" contenteditable="false" tabindex="0"></div></div>';
    const content = document.querySelector('.cm-content') as HTMLElement;
    const event = press(content, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  // The other half: an unclaimed combo must be left completely alone, or Electron's menu and
  // xterm's copy/paste stop working.
  /**
   * ⌘/ end to end, and the half a pure-table test cannot see: it is claimed and swallowed like any
   * other chord, and it still fires with the caret in a text box (`WORKS_IN_TEXT_FIELD.shortcuts`),
   * which is the whole point of a reference panel — the moment you want it is mid-form.
   */
  it('toggles the cheatsheet with ⌘/, including from inside a text field', () => {
    cleanups.push(t.installKeymap());
    const event = press(document.body, { key: '/', metaKey: true });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    // A second ⌘/ shuts it. It used to reach `installKeymap`'s `OPENS_DIALOG` exception; the panel
    // is not a dialog now, so it reaches `applyKeymapAction`'s toggle instead. The user-visible
    // behaviour is the one X5-2 fixed and it must not have been lost in the move.
    const second = press(document.body, { key: '/', metaKey: true });
    expect(second.defaultPrevented).toBe(true);
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);

    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, { key: '/', metaKey: true });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
  });

  /**
   * **The reason the cheatsheet stopped being a dialog.** `installKeymap` returns early while
   * `ui.dialog !== null`, so while the panel was a `DialogState` member every shortcut it lists was
   * inert on the screen listing it — you could not try one while reading about it. Now nothing
   * stands down: the sweep below drives the panel open with ⌘/ and then presses the same eleven
   * combos the modal stand-down test presses, and every one of them must WORK.
   *
   * Reverting the panel into `ui.dialog` fails this test on its first assertion.
   */
  it('leaves every shortcut live while the cheatsheet panel is open', () => {
    cleanups.push(t.installKeymap());
    hydrate({ sidebarVisible: true, drawerOpen: false, drawerTab: 'notes', panes: ['a1', 'a2'], focusedIndex: 0 });
    press(document.body, { key: '/', metaKey: true });
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);

    expect(press(document.body, { key: 'b', metaKey: true }).defaultPrevented).toBe(true);
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
    press(document.body, { key: 'e', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerOpen).toBe(true);
    press(document.body, { key: 'G', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('diff');
    press(document.body, { key: '2', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
    press(document.body, { key: 'D', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2', null]);
    press(document.body, { key: 'W', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
    press(document.body, { key: 'K', metaKey: true, shiftKey: true });
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(1);
    // …including the ones that raise a modal OVER the panel, which then owns the keyboard as usual.
    press(document.body, { key: 'n', metaKey: true });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });
    // The panel is still showing behind it: a modal does not dismiss it, it just takes the keys.
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(true);
    expect(press(document.body, { key: 'b', metaKey: true }).defaultPrevented).toBe(false);
  });

  it('leaves an unclaimed combo untouched', () => {
    cleanups.push(t.installKeymap());
    const event = press(document.body, { key: 'c', metaKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops firing once uninstalled', () => {
    const off = t.installKeymap();
    hydrate({ sidebarVisible: true });
    off();
    press(document.body, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(true);
  });

  /**
   * A modal owns the keyboard: EVERY Hangar shortcut is inert until it closes, not just the ones
   * that would open a second dialog. Deleting the mode guard in `installKeymap` fails every
   * assertion in this test — measured by reverting it.
   *
   * The dialog up here is `project-settings`, which NO shortcut opens, so the whole table is
   * genuinely inert and the toggle exception cannot mask a hole: ⌘N, ⌘⇧N, ⌘K and ⌘/ are all
   * dialog-openers and all four must still do nothing behind a dialog that is not theirs.
   */
  it('stands down completely while a dialog no shortcut opens is up', () => {
    cleanups.push(t.installKeymap());
    t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p1' });
    hydrate({ sidebarVisible: true, drawerOpen: false, panes: ['a1', 'a2'], focusedIndex: 0 });
    for (const init of [
      { key: 'b', metaKey: true },                    // ⌘B — chrome, live everywhere else
      { key: 'e', metaKey: true },                    // ⌘E
      { key: '2', metaKey: true },                    // ⌘2
      { key: 'n', metaKey: true },                    // ⌘N — must not stack a second dialog
      { key: 'N', metaKey: true, shiftKey: true },    // ⌘⇧N — nor must this one
      { key: 'W', metaKey: true, shiftKey: true },    // ⌘⇧W — must not close a pane behind the modal
      { key: 'D', metaKey: true, shiftKey: true },    // ⌘⇧D
      { key: 'k', metaKey: true },                    // ⌘K — the switcher is not what is up
      { key: '/', metaKey: true },                    // ⌘/ — and the cheatsheet panel stays shut
      { key: 'K', metaKey: true, shiftKey: true },    // ⌘⇧K
      { key: 'f', metaKey: true },                    // ⌘F
    ]) {
      const event = press(document.body, init);
      expect(event.defaultPrevented).toBe(false);
    }
    const layout = t.layout.layoutStore.getState().layout;
    expect(layout).toEqual({ ...layout, sidebarVisible: true, drawerOpen: false, panes: ['a1', 'a2'], focusedIndex: 0 });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'project-settings', projectId: 'p1' });
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(0);
    expect([...t.search.useTerminalSearch.getState().open]).toEqual([]);
    // ⌘/ leaves no `ui.dialog` behind to check, so the stand-down over the cheatsheet has to be
    // asserted on its own flag — otherwise moving the panel out of `DialogState` would have
    // silently exempted it from a rule it is still subject to.
    expect(t.ui.useUi.getState().shortcutsOpen).toBe(false);
  });

  /**
   * **The three protections the over-broad rule was written for, with the New Agent dialog up.**
   * They are the reason a flat `dialog !== null` return existed (Plan 03 Task 8) and the toggle
   * must not have cost any of them: ⌘⇧W must not close the pane behind the modal, ⌘⇧D must not
   * add one, and ⌘N must never leave a SECOND New Agent dialog standing.
   *
   * ⌘N gets both surfaces, because they answer differently and both answers are deliberate. From
   * the dialog's own name field it is inert — `WORKS_IN_TEXT_FIELD['new-agent']` is false and
   * `matchKeymap` drops it before the mode test is reached — and that is where `NewAgentDialog`
   * puts focus, so it is the case a user actually hits. From outside any text box it toggles the
   * dialog SHUT, which is the general rule applying to a dialog-opener like any other. Neither
   * outcome is a second dialog, which is what the ruling protected.
   */
  it('will not stack a dialog, close a pane or add one from behind the New Agent dialog', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 0 });
    const open = (): void => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null });

    open();
    const closePane = press(document.body, { key: 'W', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
    expect(closePane.defaultPrevented).toBe(false);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });

    const addPane = press(document.body, { key: 'D', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
    expect(addPane.defaultPrevented).toBe(false);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });

    // ⌘N with the caret in the dialog's own field: inert, and the dialog is untouched.
    document.body.innerHTML = '<dialog><input /></dialog>';
    const field = document.querySelector('input') as HTMLInputElement;
    const inField = press(field, { key: 'n', metaKey: true });
    expect(inField.defaultPrevented).toBe(false);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });

    // ⌘N from outside a text box: one dialog closes, none opens.
    const outside = press(document.body, { key: 'n', metaKey: true });
    expect(outside.defaultPrevented).toBe(true);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
  });

  /**
   * **The bug this rule was added for**, end to end through real events. Each dialog closes on a
   * second press of its OWN key and reopens on a third, and the closing press is claimed —
   * `defaultPrevented`, so it is swallowed rather than reaching Chromium or xterm.
   *
   * Measured in the built app over CDP before X5-2: the second ⌘K left the switcher up and only
   * Escape got out. jsdom cannot see Chromium's half of that; what it can prove, and what this
   * asserts, is the store round trip.
   *
   * ⌘/ was the other row here until X5-3 took the cheatsheet out of `ui.dialog` — it toggles
   * through `applyKeymapAction` now and is covered by `toggles the cheatsheet with ⌘/` above. The
   * rule itself is unchanged and still general: ⌘N and ⌘⇧N get it without a per-key branch, which
   * is what the two dialogs below stand for.
   */
  it('toggles a dialog shut with the shortcut that opened it', () => {
    cleanups.push(t.installKeymap());
    for (const [init, kind] of [
      [{ key: 'N', metaKey: true, shiftKey: true }, 'new-folder'],
      [{ key: 'k', metaKey: true }, 'quick-switcher'],
      [{ key: 'L', metaKey: true, shiftKey: true }, 'linear'],
    ] as const) {
      // `.kind` rather than the whole object: `new-folder` carries a `parentId` payload and the
      // claim here is about WHICH dialog is up, not about what it was opened with.
      const first = press(document.body, init);
      expect(first.defaultPrevented).toBe(true);
      expect(t.ui.useUi.getState().dialog?.kind).toBe(kind);
      const second = press(document.body, init);
      expect(second.defaultPrevented).toBe(true);
      expect(t.ui.useUi.getState().dialog).toBeNull();
      const third = press(document.body, init);
      expect(third.defaultPrevented).toBe(true);
      expect(t.ui.useUi.getState().dialog?.kind).toBe(kind);
      t.ui.useUi.getState().closeDialog();
    }
    // The toggle is the only thing the open dialog let through — nothing else moved.
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(0);
  });

  /**
   * The other half of "its OWN key": with the New Folder dialog up, ⌘K is a dialog-opener too and
   * is still inert — it neither swaps that dialog for the switcher nor closes it. A rule written as
   * "any dialog-opening shortcut closes the dialog" instead of "the one that opens THIS dialog"
   * passes the test above and fails this one.
   *
   * The dialog under test was the cheatsheet until X5-3; it is a New Folder dialog now, because the
   * cheatsheet no longer raises a `ui.dialog` for a stray ⌘K to be inert behind. (With the panel
   * open, ⌘K is not inert at all — it opens the switcher, which is the whole point of the change,
   * and `leaves every shortcut live while the cheatsheet panel is open` asserts exactly that.)
   */
  it('does not let one dialog\'s shortcut close another\'s', () => {
    cleanups.push(t.installKeymap());
    press(document.body, { key: 'N', metaKey: true, shiftKey: true });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-folder', parentId: null });
    const other = press(document.body, { key: 'k', metaKey: true });
    expect(other.defaultPrevented).toBe(false);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-folder', parentId: null });
    // …and its own key still works afterwards, so the switcher press did not leave it wedged.
    press(document.body, { key: 'N', metaKey: true, shiftKey: true });
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('picks the shortcuts back up the moment the dialog closes', () => {
    cleanups.push(t.installKeymap());
    t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null });
    hydrate({ sidebarVisible: true });
    press(document.body, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(true);
    t.ui.useUi.getState().closeDialog();
    press(document.body, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
  });

  it('does not create or close things from a text box, but still answers ⌘⇧K, ⌘E and ⌘K', () => {
    cleanups.push(t.installKeymap());
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLElement;
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 0, drawerOpen: true });
    press(input, { key: 'W', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    press(input, { key: 'n', metaKey: true });
    expect(t.ui.useUi.getState().dialog).toBeNull();
    const before = t.ui.useUi.getState().searchFocusRequest;
    press(input, { key: 'K', metaKey: true, shiftKey: true });
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(before + 1);
    press(input, { key: 'e', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerOpen).toBe(false);
    // ⌘K last, because it is the one that leaves a modal up — and from here on every shortcut is
    // inert except ⌘K itself, which toggles the switcher shut (the tests below).
    press(input, { key: 'k', metaKey: true });
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
  });

  /**
   * The palette from the keyboard, end to end, and specifically from a TEXT FIELD, which is where
   * the switcher's own query box leaves the caret. A second ⌘K there must reach the toggle rather
   * than being dropped by `WORKS_IN_TEXT_FIELD` — `'quick-switcher': true` is what allows it — and
   * it must not stack a second switcher or leak through to the sidebar search.
   */
  it('opens and closes the quick switcher with ⌘K from inside a text field', () => {
    cleanups.push(t.installKeymap());
    document.body.innerHTML = '<input />';
    const box = document.querySelector('input') as HTMLInputElement;
    const first = press(box, { key: 'k', metaKey: true });
    expect(first.defaultPrevented).toBe(true);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'quick-switcher' });
    const second = press(box, { key: 'k', metaKey: true });
    expect(second.defaultPrevented).toBe(true);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().searchFocusRequest).toBe(0);
  });

  /**
   * The case that made the ruling: the drawer's notes textarea IS a text field, and until now
   * ⌘E — the shortcut spec §12.5 gives for the drawer — could not close the drawer it sits in.
   * Dispatched at a real focused textarea rather than passed to `matchKeymap`, so the
   * `isTextField` classification is part of what is under test.
   */
  it('closes the drawer with ⌘E from inside the drawer\'s own textarea', () => {
    cleanups.push(t.installKeymap());
    hydrate({ drawerOpen: true, drawerTab: 'notes' });
    document.body.innerHTML = '<aside><textarea></textarea></aside>';
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    area.focus();
    press(area, { key: 'M', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('notes');
    press(area, { key: 'F', metaKey: true, shiftKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerTab).toBe('files');
    const event = press(area, { key: 'e', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.drawerOpen).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * A window listener and a LIVE xterm both want this keydown, dispatched at the textarea xterm
   * genuinely listens on. Two assertions, because they fail separately: the store moved (Hangar
   * got it) AND `onData` stayed empty (the PTY did not — that half is G20's
   * `attachCustomKeyEventHandler`, not this listener).
   *
   * This test is NOT what pins the capture phase — see the last test in this block for that.
   */
  it('beats a live terminal to a ⌘ combo, and the terminal sees nothing', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
    const handle = t.registry.createTerminal({ fontFamily: 'monospace', fontSize: 13, scrollback: 10, onShiftEnter: () => undefined, onOpenLink: () => undefined, onEscape: () => false });
    cleanups.push(() => handle.dispose());
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle.term.open(host);
    const data: string[] = [];
    handle.term.onData((d) => void data.push(d));
    const textarea = host.querySelector('textarea.xterm-helper-textarea') as HTMLElement;
    const event = press(textarea, { key: '1', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(0);
    expect(data).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * **The point of ⌘D**: it works with the TERMINAL focused, which is where a user is when they want
   * to talk to the agent in it. Dispatched at the helper textarea of a live xterm — the element that
   * actually has the keyboard — so the `.xterm` escape hatch in `isTextField` is part of what is under
   * test: were the terminal classed as a text field, `WORKS_IN_TEXT_FIELD.dictate` (false) would drop
   * the key right here.
   */
  it('dictates with a live terminal focused, and the terminal sees nothing', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
    t.sessions.useSessions.getState().setOne('a2', { ...initialSessionState('a2'), activity: 'idle' });
    const handle = t.registry.createTerminal({ fontFamily: 'monospace', fontSize: 13, scrollback: 10, onShiftEnter: () => undefined, onOpenLink: () => undefined, onEscape: () => false });
    cleanups.push(() => handle.dispose());
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle.term.open(host);
    const data: string[] = [];
    handle.term.onData((d) => void data.push(d));
    const textarea = host.querySelector('textarea.xterm-helper-textarea') as HTMLElement;
    const event = press(textarea, { key: 'd', metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(t.calls).toEqual([{ channel: 'dictation:start', payload: { agentId: 'a2' } }]);
    expect(data).toEqual([]);
  });

  // The other two surfaces, end to end: a real text field leaves ⌘D alone; the code viewer gives
  // it up to Hangar, as it does ⌘⇧G.
  it('leaves ⌘D alone in a text field, and takes it over the code viewer', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1'], focusedIndex: 0 });
    t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'idle' });
    document.body.innerHTML = '<textarea></textarea><div class="cm-editor"><div class="cm-content" contenteditable="false" tabindex="0"></div></div>';
    const area = document.querySelector('textarea') as HTMLElement;
    expect(press(area, { key: 'd', metaKey: true }).defaultPrevented).toBe(false);
    expect(t.calls).toEqual([]);
    const viewer = document.querySelector('.cm-content') as HTMLElement;
    expect(press(viewer, { key: 'd', metaKey: true }).defaultPrevented).toBe(true);
    expect(t.calls).toEqual([{ channel: 'dictation:start', payload: { agentId: 'a1' } }]);
  });

  /**
   * A HELD ⌘D is one press. Dictation replaces Claude Code's hold-to-talk, so a hand used to holding
   * the key will hold it — and without this the auto-repeat would start, then cancel (once `starting`
   * came back), then start again. The repeats are still claimed, so none reaches the terminal.
   */
  it('treats a held ⌘D as one press: the repeats are swallowed and send nothing', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1'], focusedIndex: 0 });
    t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'idle' });
    press(document.body, { key: 'd', metaKey: true });
    t.dictation.useDictation.getState().receive({ agentId: 'a1', state: { phase: 'starting' }, outcome: null });
    for (let i = 0; i < 3; i += 1) expect(press(document.body, { key: 'd', metaKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(t.calls.map((c) => c.channel)).toEqual(['dictation:start']);
    // A fresh press — not a repeat — is a second press, and before `ready` that is a cancel.
    press(document.body, { key: 'd', metaKey: true });
    expect(t.calls.map((c) => c.channel)).toEqual(['dictation:start', 'dictation:cancel']);
  });

  // …while ordinary typing in that same terminal is never a shortcut and never swallowed.
  it('never touches a plain keystroke aimed at the terminal', () => {
    cleanups.push(t.installKeymap());
    hydrate({ panes: ['a1', 'a2'], focusedIndex: 1 });
    const handle = t.registry.createTerminal({ fontFamily: 'monospace', fontSize: 13, scrollback: 10, onShiftEnter: () => undefined, onOpenLink: () => undefined, onEscape: () => false });
    cleanups.push(() => handle.dispose());
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle.term.open(host);
    const textarea = host.querySelector('textarea.xterm-helper-textarea') as HTMLElement;
    for (const k of ['n', 'b', 'e', '1', 'k']) {
      const event = press(textarea, { key: k });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(1);
  });

  /**
   * The one that pins the capture phase, and the reason the test above cannot.
   *
   * Measured on xterm 6.0.0 in jsdom: a keydown dispatched at `.xterm-helper-textarea` — 'a',
   * Enter, ArrowUp, Tab, 'c' and ⌘1 alike — still reaches a BUBBLE-phase listener on `window`.
   * xterm stops propagation of nothing, so flipping `addEventListener('keydown', handler, true)`
   * to `false` left all 23 tests in this file green. That is a keymap one library update away from
   * being unreachable, in a component where a swallowed keystroke looks like a hung terminal.
   *
   * So this puts a handler that DOES consume the event between the target and `window` — exactly
   * what an xterm that decided to own its keydowns would look like — and asserts the shortcut
   * still fires. Reverting to the bubble phase fails this test alone. Same shape as `Pane`'s
   * `onMouseDownCapture` (G60).
   */
  it('still fires when something between the target and window stops propagation', () => {
    cleanups.push(t.installKeymap());
    hydrate({ sidebarVisible: true });
    const box = document.createElement('div');
    const leaf = document.createElement('span');
    box.appendChild(leaf);
    document.body.appendChild(box);
    box.addEventListener('keydown', (e) => e.stopPropagation());
    press(leaf, { key: 'b', metaKey: true });
    expect(t.layout.layoutStore.getState().layout.sidebarVisible).toBe(false);
  });
});
