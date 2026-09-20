// Global ⌘ shortcuts — spec §12.3's table. Registered on `window` in the CAPTURE phase.
//
// Two independent mechanisms keep Hangar and xterm out of each other's way:
//   1. `classifyTerminalKey` (terminal-registry.ts) tells xterm to decline every ⌘ combo except
//      ⌘C/⌘V (G20), so nothing here is racing the PTY for a keystroke. A combo this table does
//      NOT claim — ⌘A, ⌘Z, ⌘, — still falls through to Chromium and Electron's menu rather than
//      being typed into the shell.
//   2. This listener captures on `window`, so it runs before any handler on xterm's
//      `textarea.xterm-helper-textarea` (a descendant), and `stopPropagation()` means a claimed
//      combo never reaches the terminal's keyboard machinery at all.
//
// Capture rather than bubble is the spec's wording and is belt-and-braces, not a live fix.
// Measured on xterm 6.0.0 under jsdom: a keydown dispatched at the helper textarea — 'a', Enter,
// ArrowUp, Tab, 'c' and ⌘1 alike — still reaches a BUBBLE-phase listener on `window`, so xterm
// stops propagation of nothing and a bubble listener would behave identically TODAY. It stops
// behaving identically the moment (1) and this table disagree about one combo, so the test suite
// pins the phase with an ancestor that does consume the event — the same shape `Pane`'s
// `onMouseDownCapture` is written against (G60).
//
// Everything without ⌘ is the terminal's: `matchKeymap` returns null unless `metaKey` is set and
// neither Ctrl nor Alt is, so ⌃C, ⌃R, Option+Enter and every printable character are untouched.
import { focusedAgent } from '../../../shared/layout.ts';
import type { DrawerTab, Id } from '../../../shared/types.ts';
import { openNewAgentDialog } from './agent-actions.ts';
import { layoutStore } from '../stores/layout.ts';
import { useTerminalSearch } from '../stores/terminal-search.ts';
import { useUi, type DialogState } from '../stores/ui.ts';
import { toggleDictation } from './dictation.ts';
import { focusTerminal, type KeyLike } from './terminal-registry.ts';

export type KeymapAction =
  | { kind: 'new-agent' }
  | { kind: 'new-folder' }
  | { kind: 'new-agent-linear' }
  | { kind: 'quick-switcher' }
  | { kind: 'focus-search' }
  | { kind: 'terminal-search' }
  | { kind: 'focus-pane'; index: number }
  | { kind: 'add-pane' }
  | { kind: 'close-pane' }
  | { kind: 'toggle-sidebar' }
  | { kind: 'toggle-drawer' }
  | { kind: 'drawer-tab'; tab: DrawerTab }
  | { kind: 'shortcuts' }
  // Plan 09. Toggles a dictation into the FOCUSED pane's agent — start, then stop, per
  // `toggleRequest`; it never names an agent of its own.
  | { kind: 'dictate' };

/**
 * Is the keystroke going into somewhere the user is typing prose?
 *
 * The `.xterm` escape hatch is the load-bearing half. xterm feeds the keyboard through a real
 * `<textarea class="xterm-helper-textarea">`, so the plain `matches('input, textarea, …')` test
 * classifies a focused terminal as a text field — and a focused terminal is this app's RESTING
 * state, so every shortcut in the table would be dead in the only place they matter.
 */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm') !== null) return false;
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

/**
 * Is the keystroke going into the drawer's CodeMirror viewer?
 *
 * The second surface test, and it exists because the first one cannot arbitrate this. The viewer is
 * built with `EditorView.editable.of(false)` (`lib/codemirror.ts`), and `@codemirror/view` maps that
 * facet straight onto the DOM as `contenteditable="false"` — measured in
 * `@codemirror/view/dist/index.js`, which sets `contenteditable: !editable ? "false" : "true"`, and
 * asserted already by `codemirror.test.ts`. `isTextField` matches only `[contenteditable="true"]`,
 * so it returns FALSE inside the viewer. That is the right answer for its own question (reading a
 * file is not typing prose, so ⌘N should still open the New Agent dialog over it) and it is exactly
 * why it cannot answer this one: ⌘F must reach CodeMirror's own find panel, and no classification
 * of the ACTION in `WORKS_IN_TEXT_FIELD` can express that, because the flag it keys off is already
 * false.
 *
 * Same family as `isTextField`'s `.xterm` escape hatch: the keymap routes by which surface has the
 * keyboard, and this is the second surface it has to know about.
 */
export function isCodeEditor(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('.cm-editor') !== null;
}

/** One ⌘ chord, in exactly the two fields `match` reads off a `KeyLike`. */
export interface Chord {
  /**
   * `KeyboardEvent.key`, **lowercased**. macOS reports 'N' for ⇧n and `match` lowercases before it
   * compares, so every entry here is written lowercase and `⌘⇧N` is `{ key: 'n', shiftKey: true }`.
   */
  readonly key: string;
  readonly shiftKey: boolean;
}

export type ShortcutSection = 'Agents' | 'Panes' | 'Panels' | 'Find';

export interface Shortcut {
  readonly chord: Chord;
  readonly action: KeymapAction;
  /** What it does, in the cheatsheet's own words. */
  readonly does: string;
  /** The cheatsheet heading this row sits under. Rows of one section must be CONTIGUOUS below. */
  readonly section: ShortcutSection;
  /**
   * Hand-written prose for a shortcut whose behaviour no table in this file can express — the one
   * case is ⌘⇧G, where the fact worth telling the user is about `@codemirror/search`'s bindings and
   * lives in another package entirely. It sits ON the binding so that rebinding the combo puts the
   * caveat in front of whoever does it.
   */
  readonly caveat?: string;
}

/** `readonly [T, ...T[]]`: `[]` is a type ERROR, so a kind cannot be "described" by nothing. */
type NonEmpty<T> = readonly [T, ...T[]];

/**
 * **The table `match` matches on, and the table the UI reads its key captions from.** One array,
 * two consumers, so a rebinding cannot leave a tooltip or a cheatsheet row lying about a key.
 *
 * Before this existed `match` was a ladder of `if (key === 'n') …` and every caption in the app was
 * a hand-typed string — `<Kbd>⌘N</Kbd>` in `Sidebar.tsx` and `EmptyPane.tsx`, `⌘⇧K` in the sidebar
 * search placeholder, `(⌘⇧W)` in `applyKeymapAction`'s own toast. All five now render through
 * `chordLabel` off this table. `keymap.test.ts` sweeps the ENTIRE ⌘ keyspace in both directions
 * (every chord here is claimed by `matchKeymap`; nothing `matchKeymap` claims is missing here), so
 * the rewrite of `match` below is pinned rather than assumed.
 *
 * A `Record` over `KeymapAction['kind']` for the same reason `WORKS_IN_TEXT_FIELD` is one: a
 * new action fails to compile until it is given a key, a description and a section. The
 * `NonEmpty` value type closes the loophole that a `Record` alone leaves open — `[]` would satisfy
 * `Shortcut[]` and silently omit the new action from the cheatsheet, which is the failure mode a
 * cheatsheet has to be incapable of.
 *
 * **Order is load-bearing**: `cheatsheetSections` walks this in insertion order and starts a new
 * heading whenever `section` changes, so a section split across two runs would render its heading
 * twice. `ShortcutsPanel.test.tsx` asserts the headings are unique.
 */
export const SHORTCUTS: Record<KeymapAction['kind'], NonEmpty<Shortcut>> = {
  'new-agent': [{ chord: { key: 'n', shiftKey: false }, action: { kind: 'new-agent' }, does: 'New agent', section: 'Agents' }],
  'new-folder': [{ chord: { key: 'n', shiftKey: true }, action: { kind: 'new-folder' }, does: 'New folder', section: 'Agents' }],
  'new-agent-linear': [{ chord: { key: 'l', shiftKey: true }, action: { kind: 'new-agent-linear' }, does: 'New agent from a Linear ticket', section: 'Agents' }],
  'quick-switcher': [{ chord: { key: 'k', shiftKey: false }, action: { kind: 'quick-switcher' }, does: 'Jump to an agent', section: 'Agents' }],
  'focus-search': [{ chord: { key: 'k', shiftKey: true }, action: { kind: 'focus-search' }, does: 'Focus the sidebar search box', section: 'Agents' }],
  'focus-pane': [
    { chord: { key: '1', shiftKey: false }, action: { kind: 'focus-pane', index: 0 }, does: 'Focus pane 1', section: 'Panes' },
    { chord: { key: '2', shiftKey: false }, action: { kind: 'focus-pane', index: 1 }, does: 'Focus pane 2', section: 'Panes' },
    { chord: { key: '3', shiftKey: false }, action: { kind: 'focus-pane', index: 2 }, does: 'Focus pane 3', section: 'Panes' },
    { chord: { key: '4', shiftKey: false }, action: { kind: 'focus-pane', index: 3 }, does: 'Focus pane 4', section: 'Panes' },
  ],
  'add-pane': [{ chord: { key: 'd', shiftKey: true }, action: { kind: 'add-pane' }, does: 'Add an empty pane (up to four)', section: 'Panes' }],
  'close-pane': [{ chord: { key: 'w', shiftKey: true }, action: { kind: 'close-pane' }, does: 'Close the focused pane — the session keeps running', section: 'Panes' }],
  // Plan 09. Unshifted, beside ⌘⇧D (add a pane) — the two are different keys and both are listed.
  dictate: [{
    chord: { key: 'd', shiftKey: false },
    action: { kind: 'dictate' },
    does: 'Dictate into the focused pane',
    section: 'Panes',
    caveat: 'Taken from the code viewer too, which wants ⌘D to select the next occurrence — it has no other key for that there.',
  }],
  'toggle-sidebar': [{ chord: { key: 'b', shiftKey: false }, action: { kind: 'toggle-sidebar' }, does: 'Show or hide the sidebar', section: 'Panels' }],
  'toggle-drawer': [{ chord: { key: 'e', shiftKey: false }, action: { kind: 'toggle-drawer' }, does: 'Show or hide the drawer', section: 'Panels' }],
  'drawer-tab': [
    { chord: { key: 'f', shiftKey: true }, action: { kind: 'drawer-tab', tab: 'files' }, does: 'Drawer: Files', section: 'Panels' },
    {
      chord: { key: 'g', shiftKey: true },
      action: { kind: 'drawer-tab', tab: 'diff' },
      does: 'Drawer: Diff',
      section: 'Panels',
      caveat: 'Taken from the code viewer, which wants ⌘⇧G for find-previous — use ⇧F3 there instead.',
    },
    { chord: { key: 'm', shiftKey: true }, action: { kind: 'drawer-tab', tab: 'notes' }, does: 'Drawer: Notes', section: 'Panels' },
  ],
  shortcuts: [{ chord: { key: '/', shiftKey: false }, action: { kind: 'shortcuts' }, does: 'This list', section: 'Panels' }],
  'terminal-search': [{ chord: { key: 'f', shiftKey: false }, action: { kind: 'terminal-search' }, does: 'Find in the focused pane’s terminal', section: 'Find' }],
};

/** Flattened once, because `match` runs on every ⌘ keydown and `Object.values().flat()` allocates. */
const ALL_SHORTCUTS: readonly Shortcut[] = Object.values(SHORTCUTS).flat();

/**
 * Which actions still fire while the caret is in a text field, split by what the action DOES.
 *
 * Window chrome — show or hide a panel, move focus, pick a drawer tab — is not a text operation
 * and none of it can destroy anything, so it stays live everywhere. Task 6 originally narrowed to
 * ⌘K alone; Task 7 measured the consequence and it is a trap: with the caret in the drawer's own
 * notes textarea, ⌘E could not close the drawer the textarea lives in, and ⌘⇧F/G/M could not
 * switch away from the tab holding it. Spec §12.5 writes that shortcut as "Toggle ⌘E",
 * unqualified.
 *
 * Creating and closing things stay blocked: ⌘N, ⌘⇧N, ⌘⇧D and ⌘⇧W are all a surprise mid-sentence,
 * and ⌘⇧W would close the pane behind the box being typed in.
 *
 * A `Record` rather than a `Set`, so adding a `KeymapAction` kind without deciding which side it
 * is on fails to compile rather than defaulting to one.
 *
 * **Exported** so the cheatsheet can show the split rather than implying a uniformity that does not
 * exist. It is read there, never re-stated: the "while typing" marker on a row is this boolean.
 */
export const WORKS_IN_TEXT_FIELD: Record<KeymapAction['kind'], boolean> = {
  // ⌘K. It opens a modal, which is the shape of the blocked half below — but what it DOES is
  // navigate, and it destroys nothing and creates nothing. It is also the shortcut most worth
  // having from inside the sidebar's own search box, which is the text field a user is most
  // likely to be in when they want it. Its predecessor (`focus-search`, then bound to ⌘K) was
  // live in text fields for the same reason, so this is continuity rather than a new ruling.
  'quick-switcher': true,
  'focus-search': true,     // ⌘⇧K — "focus the search box" is exactly what it means here
  'toggle-sidebar': true,   // ⌘B
  'toggle-drawer': true,    // ⌘E
  'focus-pane': true,       // ⌘1–4 — moves the keyboard to a terminal, which is the point
  'drawer-tab': true,       // ⌘⇧F/G/M
  // ⌘/ — a read-only reference panel. It creates nothing, destroys nothing, and the moment a user
  // most wants it is mid-way through a form they do not know the shortcut for.
  shortcuts: true,
  'new-agent': false,       // ⌘N
  'new-folder': false,      // ⌘⇧N
  // ⌘⇧L — creational like ⌘N, so inert in a text field, and that includes the Linear dialog's own link
  // field: with the caret there ⌘⇧L cannot toggle the dialog shut (Escape or Cancel does), exactly as
  // ⌘N cannot from the New Agent dialog's name field. From anywhere else in the dialog it still toggles.
  'new-agent-linear': false,
  'add-pane': false,        // ⌘⇧D
  'close-pane': false,      // ⌘⇧W — would close the pane behind the box being typed in
  'terminal-search': false, // ⌘F — see OWNED_BY_CODE_EDITOR; a surface with no find does not claim it
  // ⌘D — Plan 09. **This row is NOT what makes ⌘D work at a terminal prompt**, and that is the part
  // worth knowing. A focused terminal is not a text field: `isTextField` returns false for anything
  // inside `.xterm`, even though xterm types into a real `<textarea>`, so ⌘D reaches
  // `applyKeymapAction` from the terminal whatever this says (`keymap.test.ts` dispatches it at a
  // live xterm's own textarea to prove it). What this row decides is a REAL text field — the notes
  // textarea, the sidebar search, a rename box, the find bar — and there the answer is no, for the
  // reason ⌘⇧W is no: the caret says where typed words go, and a dictation types into the focused
  // PANE's terminal instead, somewhere the caret is not. Unclaimed, it falls through to Chromium,
  // which binds nothing to ⌘D in a text field. A run already going can still be stopped from there
  // with the pane's mic button, and it stops itself at 120 s.
  dictate: false,
};

/**
 * Which actions the drawer's CodeMirror viewer owns while it has the keyboard.
 *
 * Routing by SURFACE rather than a special case for one key, and the table is the point: ⌘F means
 * "find in the thing I am looking at", so the editor keeps it while the editor is what you are
 * looking at, and everything else in the app keeps working over the editor unchanged. ⌘N, ⌘B, ⌘E,
 * ⌘K, ⌘1–4 and ⌘⇧F/G/M are all window chrome and all stay Hangar's — `keymap.test.ts` asserts a
 * sample of them explicitly, so widening this table into a blanket "ignore everything inside
 * `.cm-editor`" fails rather than quietly deadening the app over one panel.
 *
 * This SUPERSEDES half of Plan 04 Task 4's finding (P4-4). That sweep read `@codemirror/search`'s
 * bindings against §12.3 and recorded that ⌘F, ⌘G and ⌘D were unclaimed and reached CodeMirror
 * intact, with ⌘⇧G the single collision. ⌘F is now claimed — Plan 05 Task 3 spends it on terminal
 * search — so the guarantee is no longer "unclaimed" but "unclaimed HERE". ⌘G is still unclaimed
 * everywhere and ⌘⇧G is still Hangar's Diff tab. **⌘D is no longer unclaimed**: Plan 09 spends it on
 * dictation, and in the viewer too — see its row below.
 *
 * A `Record` over the action kinds for the same reason `WORKS_IN_TEXT_FIELD` is one: a new
 * `KeymapAction` fails to compile until someone decides which surface owns it.
 *
 * **Exported** for the cheatsheet, which marks the rows this table claims. The note it prints is
 * deliberately generic ("the code viewer keeps this one while it has focus") rather than "⌘F finds
 * in the file": widening this table must not turn the note into a lie about a different key.
 */
export const OWNED_BY_CODE_EDITOR: Record<KeymapAction['kind'], boolean> = {
  'terminal-search': true,  // ⌘F — @codemirror/search's Mod-f opens the editor's own find panel
  shortcuts: false,
  'quick-switcher': false,
  'focus-search': false,
  'toggle-sidebar': false,
  'toggle-drawer': false,
  'focus-pane': false,
  'drawer-tab': false,
  'new-agent': false,
  'new-folder': false,
  'new-agent-linear': false,
  'add-pane': false,
  'close-pane': false,
  // ⌘D — Plan 09. HANGAR wins over the viewer, settled the way ⌘⇧G is rather than the way ⌘F is.
  // `searchKeymap` binds Mod-d to `selectNextOccurrence`, which in a read-only viewer builds a
  // multi-cursor selection for an edit that can never happen — its one remaining use is selecting
  // several matches to copy. ⌘F went the other way because "find in the thing I am looking at" has
  // an honest answer in the viewer; "dictate into the focused pane" has only one answer anywhere,
  // and the drawer is SCOPED to the focused pane (§12.3), so the agent ⌘D dictates into is the one
  // whose code is open. Reading its code and talking to it about that code is the case worth having.
  // The loss is printed on the binding (`SHORTCUTS.dictate`'s caveat), as ⌘⇧G's is.
  dictate: false,
};

/** The `ui.dialog` kinds, i.e. `DialogState` minus the `null` that means "no dialog is up". */
type DialogKind = NonNullable<DialogState>['kind'];

/**
 * Which `ui.dialog` an action RAISES, or null for one that raises none.
 *
 * This is the table that makes a dialog-opening shortcut a **toggle**. `installKeymap` stands the
 * whole keymap down while a modal is up — see the comment there for why, it is a deliberate ruling
 * and it stays — with exactly one exception: the combo that opens the dialog you are already
 * looking at closes it instead of being swallowed. ⌘/ ⌘/ opens and shuts the cheatsheet, ⌘K ⌘K
 * opens and shuts the switcher, and Escape still works because Escape was never in this file.
 *
 * A rule rather than two special cases: ⌘/ and ⌘K are the only dialog-openers *bound* today, but
 * ⌘N and ⌘⇧N are dialog-openers too and a new action that raises a dialog gets the toggle
 * by naming its dialog here — there is no per-key branch anywhere.
 *
 * **What `tsc` enforces here, and what it does not.** The `Record` over `KeymapAction['kind']` is
 * the same gate `WORKS_IN_TEXT_FIELD` and `OWNED_BY_CODE_EDITOR` are: a new action fails to
 * compile until it is given an entry. Measured — widening `KeymapAction` by one member with no
 * other change now gives `tsc -p tsconfig.web.json` exit **2** with **4** `TS2741`s rather than
 * X5-1's three, this table being the fourth. The `DialogKind` value type catches the other half of
 * a bad entry: `shortcuts: 'shortcut'` is exit **2**, `TS2820`.
 *
 * What neither can do is force an entry to be RIGHT. `SHORTCUTS` closes G73's loophole with a
 * `NonEmpty` tuple because `[]` is never a legitimate answer there; `null` IS the legitimate answer
 * for ten of the fourteen rows below, so a new dialog-opening action typed `null` typechecks clean
 * and quietly reintroduces the bug. G73's standing advice is to keep the run-time half, and here
 * that half is not "is it non-empty" but a cross-check against reality: `keymap.test.ts` →
 * "OPENS_DIALOG names the dialog each action actually opens" drives EVERY action in `SHORTCUTS`
 * through `applyKeymapAction` against the real store and asserts the dialog that appears — or does
 * not — is the one this table names. A wrong entry fails there in either direction, and a table of
 * all-nulls paired with an `applyKeymapAction` that opened nothing fails its last line.
 */
export const OPENS_DIALOG: Record<KeymapAction['kind'], DialogKind | null> = {
  'new-agent': 'new-agent',            // ⌘N — via `openNewAgentDialog`, which picks the folder first
  'new-folder': 'new-folder',          // ⌘⇧N
  'new-agent-linear': 'linear',        // ⌘⇧L — Plan 06
  'quick-switcher': 'quick-switcher',  // ⌘K — an overlay rather than a `<dialog>` (G62), toggled the same
  // ⌘/ USED TO READ `'shortcuts'` HERE. The cheatsheet is no longer a dialog at all — it is a
  // non-modal floating panel you can drag, resize and leave open (`ShortcutsPanel.tsx`), held in
  // `ui.shortcutsOpen` — so it raises no `ui.dialog` and needs no exception from a stand-down it is
  // no longer behind. Its toggle moved to `applyKeymapAction`, where `toggle-sidebar` and
  // `toggle-drawer` have always kept theirs: it is window chrome now, not a modal. `null` is the
  // honest answer to the question this table asks, and the cross-check in `keymap.test.ts`
  // enforces it in both directions — a `'shortcuts'` here would fail because no dialog appears.
  shortcuts: null,
  'focus-search': null,                // moves focus to a box that is already on screen
  'terminal-search': null,             // the focused pane's own find bar, which is not a modal
  'focus-pane': null,
  'add-pane': null,
  'close-pane': null,
  'toggle-sidebar': null,
  'toggle-drawer': null,
  'drawer-tab': null,
  dictate: null,                       // ⌘D — the pane's mic and its pill, neither of them a modal
};

/**
 * The whole table, pure. Returns null for anything Hangar does not claim — the caller must then
 * leave the event completely alone.
 *
 * `inTextField` drops the creational and destructive half of the table; see WORKS_IN_TEXT_FIELD.
 * `inCodeEditor` drops the handful the drawer's viewer owns; see OWNED_BY_CODE_EDITOR. It is
 * checked FIRST, because CodeMirror's find PANEL is both a code editor and a real `<input>` — it is
 * a text field by `isTextField` — and the editor must keep ⌘F in its own panel too.
 *
 * `inCodeEditor` defaults to false so the 40-odd call sites in the tests that are asking about the
 * table itself stay readable. There is exactly one production caller (`installKeymap`, below) and
 * the guard against it drifting is not the signature but a test that dispatches a real event from
 * inside a `.cm-editor` and asserts nothing was claimed.
 */
export function matchKeymap(e: KeyLike, inTextField: boolean, inCodeEditor = false): KeymapAction | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  const action = match(e);
  if (action === null) return null;
  if (inCodeEditor && OWNED_BY_CODE_EDITOR[action.kind]) return null;
  if (inTextField && !WORKS_IN_TEXT_FIELD[action.kind]) return null;
  return action;
}

/**
 * A lookup in `SHORTCUTS`, not a ladder of `if`s — that is the whole anti-drift mechanism: the
 * captions the UI draws and the keys this function answers to are the same array, so there is no
 * second place a rebinding could fail to reach.
 *
 * `e.key` is lowercased because with Shift held macOS reports 'N', not 'n'. The old ladder read the
 * DIGITS off the raw `e.key` instead, guarding against ⇧1 ('!') counting as pane 1; the uniform
 * rule below is equivalent and the equivalence is measured rather than assumed. Two independent
 * reasons ⌘⇧1 still returns null: on macOS `e.key` is '!', which is in no entry, and every digit
 * entry carries `shiftKey: false`, which the comparison requires. `keymap.test.ts` keeps its
 * "does not read a shifted digit as a pane number" case, and asserts both spellings — `'!'` and a
 * hypothetical layout reporting `'1'` with Shift.
 *
 * Ordering notes that used to live in the ladder now live on the table's rows: ⌘K is the palette
 * (spec §12.3 Phase 3) and the sidebar search moved to the previously-unclaimed ⌘⇧K; ⌘F unshifted
 * is terminal search and ⌘⇧F is the Files tab. Whether ⌘F reaches the terminal or CodeMirror is
 * not decided here — `matchKeymap`'s surface gate decides it.
 */
function match(e: KeyLike): KeymapAction | null {
  const key = e.key.toLowerCase();
  return ALL_SHORTCUTS.find((s) => s.chord.key === key && s.chord.shiftKey === e.shiftKey)?.action ?? null;
}

/** '⌘N', '⌘⇧W', '⌘1', '⌘/'. The one place a key is turned into text a human reads. */
export function chordLabel(chord: Chord): string {
  return `⌘${chord.shiftKey ? '⇧' : ''}${chord.key.toUpperCase()}`;
}

/**
 * Every field of a `KeymapAction` payload is a primitive today (`index: number`, `tab: DrawerTab`),
 * so a shallow key-by-key comparison IS deep equality here. Asserted in `keymap.test.ts` by walking
 * the table rather than trusted: a future action carrying an object payload fails that test rather
 * than silently matching the wrong row.
 */
function sameAction(a: KeymapAction, b: KeymapAction): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * The binding for one specific action, payload and all — `focus-pane` index 2 is ⌘3, not ⌘1.
 *
 * Null for an action nothing is bound to (`{ kind: 'focus-pane', index: 8 }`). Callers render the
 * plain label in that case, which is the honest answer: there is no key to name.
 */
export function shortcutFor(action: KeymapAction): Shortcut | null {
  return SHORTCUTS[action.kind].find((s) => sameAction(s.action, action)) ?? null;
}

/** '⌘⇧F' for an action, or null when nothing is bound to it. For `<Kbd>` captions. */
export function keyLabel(action: KeymapAction): string | null {
  const found = shortcutFor(action);
  return found === null ? null : chordLabel(found.chord);
}

/**
 * A button `title` that carries its key: `withShortcut('Files', …)` → `'Files (⌘⇧F)'`.
 *
 * The WORDS are the caller's — a tooltip that restates a visible label is noise, so this is only
 * used where the key is the part the label does not already say — and the KEY comes from
 * `SHORTCUTS`. Unbound actions come back as the bare text rather than an invented caption.
 */
export function withShortcut(text: string, action: KeymapAction): string {
  const label = keyLabel(action);
  return label === null ? text : `${text} (${label})`;
}

export function applyKeymapAction(action: KeymapAction): void {
  const ui = useUi.getState();
  const layout = layoutStore.getState();
  switch (action.kind) {
    case 'new-agent':
      // Not `openDialog` directly: spec §12.6 defaults the folder to the focused agent's, and
      // that lookup lives with the other dialog-raising actions.
      openNewAgentDialog();
      return;
    case 'new-folder':
      ui.openDialog({ kind: 'new-folder', parentId: null });
      return;
    case 'new-agent-linear':
      ui.openDialog({ kind: 'linear' });
      return;
    case 'quick-switcher':
      ui.openDialog({ kind: 'quick-switcher' });
      return;
    case 'focus-search':
      ui.requestSearchFocus();
      return;
    case 'terminal-search': {
      // `focusedAgent`, not `panes[focusedIndex]`: it clamps an out-of-range index and collapses a
      // sparse hole, the same reason `bootstrap.ts` uses it. With no agent in the focused pane
      // there is nothing to search and the toggle is skipped — the combo is still claimed and
      // swallowed, exactly as ⌘4 with two panes open is.
      const agentId = focusedAgent(layout.layout);
      if (agentId !== null) useTerminalSearch.getState().toggle(agentId);
      return;
    }
    case 'focus-pane': {
      // ⌘4 with two panes open is still Hangar's key — `matchKeymap` claimed it and the caller has
      // already swallowed it — it just has nothing to focus. Bounds-checked here rather than in
      // the table so the "which keys does Hangar take from the terminal" answer stays static.
      const panes = layout.layout.panes;
      if (action.index >= panes.length) return;
      layout.focusPane(action.index);
      // Moving focus without moving the KEYBOARD leaves the outline on one pane and the typing in
      // another. The registry is what makes this reachable from outside the React tree.
      const agentId: Id | null = panes[action.index] ?? null;
      if (agentId !== null) focusTerminal(agentId);
      return;
    }
    case 'add-pane':
      // Same message and the same reason as `openAgent`'s in agent-actions.ts: `addEmptyPane`
      // returns false at four panes, and a shortcut that silently does nothing reads as broken.
      //
      // The key is INTERPOLATED off the table rather than typed into the string. It used to read
      // "(⌘⇧W)" literally, which is the same class of bug as a hardcoded tooltip: rebinding
      // close-pane would have left this toast telling the user to press a key that does nothing.
      if (!layout.addEmptyPane()) ui.toast({ level: 'warn', title: 'All four panes are in use', detail: `Close a pane (${chordLabel(SHORTCUTS['close-pane'][0].chord)}) first.` });
      return;
    case 'close-pane':
      layout.closePane(layout.layout.focusedIndex);
      return;
    case 'toggle-sidebar':
      layout.setSidebar({ visible: !layout.layout.sidebarVisible });
      return;
    case 'toggle-drawer':
      layout.setDrawer({ open: !layout.layout.drawerOpen });
      return;
    case 'drawer-tab':
      layout.setDrawer({ open: true, tab: action.tab });
      return;
    case 'dictate': {
      // The FOCUSED pane's agent, through `focusedAgent` for the reason ⌘F uses it. An empty pane
      // claims the combo and does nothing, like ⌘F. Everything else — which request, and the two
      // refusals (another agent's run, no running session) — is `toggleDictation`'s, the same
      // function the pane's mic button calls, so the key and the button cannot disagree.
      const agentId = focusedAgent(layout.layout);
      if (agentId !== null) toggleDictation(agentId);
      return;
    }
    case 'shortcuts':
      // A TOGGLE here, not an open — the same shape as `toggle-sidebar` and `toggle-drawer` two
      // cases up, and for the same reason: the cheatsheet is a non-modal panel now, so "show or
      // hide it" is the whole action and there is no dialog whose opener needs an exception.
      //
      // While it was a dialog the toggle lived in `installKeymap` instead (via `OPENS_DIALOG`),
      // because the stand-down swallowed the second ⌘/ before it could reach here. Nothing stands
      // down for this panel any more, so the toggle belongs with the action — which also means the
      // toolbar button and ⌘/ go through one code path rather than two.
      ui.toggleShortcuts();
      return;
  }
}

export function installKeymap(): () => void {
  const handler = (e: KeyboardEvent): void => {
    const action = matchKeymap(e, isTextField(e.target), isCodeEditor(e.target));
    if (action === null) return;
    // **A modal owns the keyboard, except for its own opener.**
    //
    // The first half is a Plan 03 Task 8 ruling and it stays: while a dialog is up, every Hangar
    // shortcut is inert. ⌘N inside the New Agent dialog must not raise a second one, ⌘⇧W must not
    // close a pane behind the modal, ⌘⇧D must not add one, and Escape belongs to `<dialog>`'s own
    // `cancel` event (and to `QuickSwitcher`'s own `onKeyDown`, which is not a `<dialog>`) rather
    // than to this table.
    //
    // That ruling was written as a flat `if (useUi.getState().dialog !== null) return;`, which was
    // too broad in one specific way: it also swallowed the keystroke that opened the dialog in
    // front of you. ⌘/ ⌘/ left the cheatsheet sitting there and ⌘K ⌘K left the switcher up, and
    // every user reads a key that opens a panel as the key that shuts it. Reported by the owner
    // and reproduced in the running app over CDP; Escape was the only way out of either.
    //
    // So the exception, and it is a RULE rather than a case for ⌘/ and one for ⌘K: an action is
    // still claimed while a dialog is up if `OPENS_DIALOG` says it raises THAT dialog, and it then
    // closes it rather than raising it again. Everything else returns untouched — no
    // `preventDefault`, no `stopPropagation`, exactly as before, so an unclaimed combo still
    // reaches Chromium and the terminal.
    //
    // `matchKeymap` runs FIRST now (it is pure, so the reorder costs nothing), because the
    // question "is this the key that opened you" cannot be asked before the key has been matched
    // to an action. The mode test still lives here rather than inside `matchKeymap` for the
    // original reason: the pure table stays a statement about keys alone, and a dialog is a mode.
    //
    // Note what `matchKeymap` has already decided by this point: `WORKS_IN_TEXT_FIELD` is
    // consulted first, so ⌘N with the caret in the New Agent dialog's own name field never gets
    // here at all (`'new-agent': false`) and is inert rather than a toggle — which is where that
    // dialog puts focus. ⌘K and ⌘/ are `true` there, so the switcher's query box and the
    // cheatsheet both toggle from wherever focus happens to be.
    const dialog = useUi.getState().dialog;
    const togglesTheOpenDialog = dialog !== null && OPENS_DIALOG[action.kind] === dialog.kind;
    if (dialog !== null && !togglesTheOpenDialog) return;
    // BOTH, and only for a combo we actually claimed. `preventDefault` drops Chromium's own
    // default for the combo; `stopPropagation` from a window-capture listener is what stops the
    // event ever reaching xterm's textarea. An unclaimed combo gets neither, so ⌘C/⌘V reach the
    // terminal and ⌘Q/⌘W/⌘, reach Electron's menu.
    e.preventDefault();
    e.stopPropagation();
    // A HELD ⌘D is one press. Dictation is press-to-start, press-to-stop (spec §4.1) and it replaces
    // Claude Code's hold-to-talk — so a hand used to holding the key will hold it, and the key
    // repeats: start, then (once `starting` has come back) cancel, then start again. The repeats are
    // still claimed above, so none of them reaches the terminal either.
    if (e.repeat && action.kind === 'dictate') return;
    if (togglesTheOpenDialog) useUi.getState().closeDialog();
    else applyKeymapAction(action);
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
