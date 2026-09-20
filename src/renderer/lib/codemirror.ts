// CodeMirror 6 factories for the drawer: the read-only file viewer (spec §12.5) and the unified
// diff the Diff tab mounts. Both are async because the LANGUAGE is lazy — `@codemirror/language-data`
// describes 143 languages and loads each grammar through a dynamic `import()`, which Rollup splits
// into its own chunk.
//
// Measured on this tree with `npm run build`: the entry chunk went 1,454.50 kB → 2,182.93 kB
// (+728.43 kB) and 118 new lazy chunks appeared, 1,734.80 kB in total. The +728 kB is the CodeMirror
// CORE, which is statically imported below and cannot be anything else: view 480k + state 144k +
// language 100k + commands 84k + search 48k + merge 72k + one-dark 8k + language-data's description
// table 36k + @lezer/common 84k + @lezer/highlight 32k = 1,088 kB of unminified source. No GRAMMAR
// is in it — `grep -c lang-python` and `grep -c '@lezer/python'` over the entry chunk are both 0 —
// so "lazy-loaded" in §12.5 is satisfied. Moving the core itself behind a dynamic `import()` in
// `FileViewer` would take the entry back to ~1.45 MB; it is deliberately NOT done, because then a
// chunk that fails to load costs the user the file's text rather than only its colours.
import { defaultKeymap } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView } from '@codemirror/merge';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';

/**
 * Chrome for the editor, in the app's own tokens.
 *
 * `var(--color-…)` rather than the hex literals: `theme.css`'s `@theme` block emits every one of
 * these on `:root`, and CodeMirror injects this rule set into the same document, so retuning a
 * token retunes the viewer with it. The values were `#0f1115`/`#d6d9e0`/`#667089`/`#2a3040`/
 * `#151821` — bg-0, fg, muted, line, bg-1 exactly, so this is the same picture, not a new one.
 *
 * `.cm-content { user-select: text }` is load-bearing, not tidiness: `theme.css` puts
 * `user-select: none` on `body` as the chrome default, and a code viewer whose text cannot be
 * selected is useless. A directly-applied declaration beats an inherited one whatever the
 * specificity, so this wins over the body rule without needing `.select-text`.
 *
 * The two diff tints are `color-mix()` because a CSS variable's alpha cannot be adjusted any other
 * way — `var(--color-accent)` is an opaque hex and these must sit UNDER the text. `color-mix()` is
 * Chromium 111+; this app's floor is Electron 44.2.0, whose framework binary reports
 * `Chrome/152.0.7977.76` (measured with `grep -a` on `Electron Framework`).
 */
export const hangarTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--color-bg-0)', color: 'var(--color-fg)', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: 'var(--color-bg-0)', color: 'var(--color-muted)', borderRight: '1px solid var(--color-line)' },
    '.cm-activeLine': { backgroundColor: 'var(--color-bg-1)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--color-bg-1)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { userSelect: 'text' },
    '.cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' },
    '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--color-red) 12%, transparent)' },
    '.cm-collapsedLines': { backgroundColor: 'var(--color-bg-2)', color: 'var(--color-fg-2)' },
  },
  { dark: true },
);

/**
 * The grammar for a file, resolved lazily, or `[]` for "plain text".
 *
 * Two lookups, in this order, because neither alone covers what the drawer is handed:
 *
 *  - `matchFilename` is the broad one. It knows all 143 of language-data's descriptions, including
 *    the ~40 extensions `fs-browse.ts`'s `EXT_LANG` table has no row for (`.hs`, `.clj`, `.scala`,
 *    `.jl`, `.erl`, `.ml`, `CMakeLists.txt` … all measured resolving here).
 *  - `languageName` is main's own answer (`FsFile.language`), and it is the only thing that
 *    resolves a file whose NAME carries no hint: `.env` is `NO MATCH` by filename and `Shell` by
 *    name. Measured across every value in main's two tables — all resolve by name except `svelte`,
 *    `graphql`, `hcl` and `makefile`, which language-data 6.5.2 simply does not ship (`.tf` and
 *    `Makefile` therefore render as plain text, and that is the honest answer rather than a guess).
 *
 * A failed dynamic import degrades to plain text rather than blanking the viewer: the grammar is a
 * separate chunk, so this is a real failure mode (a stale asset after a rebuild) and it must not
 * cost the user the file's CONTENT.
 */
export async function languageExtension(filename: string, languageName?: string | null): Promise<Extension> {
  const desc =
    LanguageDescription.matchFilename(languages, filename) ??
    (languageName != null && languageName !== '' ? LanguageDescription.matchLanguageName(languages, languageName) : null);
  if (desc === null) return [];
  try {
    return await desc.load();
  } catch {
    return [];
  }
}

/**
 * What both factories share.
 *
 * `contentAttributes: { tabindex: '0' }` is what makes a NON-EDITABLE editor reachable. With
 * `EditorView.editable.of(false)` the content div is `contenteditable="false"` and CodeMirror gives
 * it no tab index of its own (only `scrollDOM.tabIndex = -1`), so it can never take focus — and a
 * view that never takes focus never sees a key, which would leave every binding in `searchKeymap`
 * (⌘F, ⌘G) dead code. Measured under jsdom in `codemirror.test.ts`: `contentDOM.focus()` leaves
 * `activeElement` on BODY without this line and lands on the content with it.
 *
 * `defaultKeymap` is harmless on a read-only doc — every editing command it binds returns false
 * against `EditorState.readOnly` — and it is what supplies arrow/Home/End/⌘A navigation.
 *
 * Deliberately NOT here: `drawSelection`. It replaces the browser's native selection with a drawn
 * one, which only makes sense for an editable view; the native selection is what ⌘C copies from.
 */
function base(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    oneDark,
    hangarTheme,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
  ];
}

/** The Files tab's viewer. `languageName` is `FsFile.language` — main's answer, used as a fallback. */
export async function createViewer(parent: HTMLElement, doc: string, filename: string, languageName?: string | null): Promise<EditorView> {
  const lang = await languageExtension(filename, languageName);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: [...base(), lang] }) });
}

/**
 * The Diff tab's viewer: `newText` as the document with `oldText` merged in as deletions above the
 * lines that replaced them (spec §12.5). `mergeControls: false` because nothing here is editable —
 * the accept/reject gutter buttons would be live controls on a read-only drawer.
 */
export async function createUnifiedDiff(parent: HTMLElement, oldText: string, newText: string, filename: string, languageName?: string | null): Promise<EditorView> {
  const lang = await languageExtension(filename, languageName);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: newText,
      extensions: [...base(), lang, unifiedMergeView({ original: oldText, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } })],
    }),
  });
}
