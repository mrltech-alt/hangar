/**
 * The CodeMirror factories (spec §12.5).
 *
 * **What these tests do NOT prove.** CodeMirror measures the DOM — line heights, the viewport it
 * renders, gutter widths — and jsdom reports 0 for every box and implements no layout at all. So
 * everything here is about STATE and DOM STRUCTURE: the document, the facets, the attributes, the
 * injected style rules. That the viewer looks right, scrolls, highlights the active line, or shows
 * the search panel where the user can see it is not tested here and cannot be; it needs the real
 * app (G62's precedent: the autofocus bug was found and confirmed fixed over CDP, not in jsdom).
 *
 * What jsdom does carry honestly is the focusability rule the `tabindex` line below exists for —
 * `focus()` moves `activeElement` only for a focusable element — and the control in that test
 * proves the probe is not blind.
 */
import { language } from '@codemirror/language';
import { getOriginalDoc } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUnifiedDiff, createViewer, languageExtension } from './codemirror.ts';

const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

function track(v: EditorView): EditorView {
  views.push(v);
  return v;
}

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  for (const el of hosts.splice(0)) el.remove();
  vi.restoreAllMocks();
});

/** The language actually installed in a state, by name — `null` for plain text. */
function languageOf(ext: Awaited<ReturnType<typeof languageExtension>>): string | null {
  return EditorState.create({ extensions: [ext] }).facet(language)?.name ?? null;
}

describe('languageExtension', () => {
  it('resolves by FILENAME, including extensions main has no row for', async () => {
    expect(languageOf(await languageExtension('src/app.ts'))).toBe('typescript');
    expect(languageOf(await languageExtension('main.py'))).toBe('python');
    // `.hs` is not in `fs-browse.ts`'s EXT_LANG table, so main sends `language: null` for it and a
    // name-only lookup would render Haskell as plain text.
    expect(languageOf(await languageExtension('Lib.hs', null))).toBe('haskell');
  });

  it('falls back to main\'s language NAME when the filename says nothing', async () => {
    // The case that makes the fallback worth having: language-data has no filename rule for `.env`
    // (measured: `matchFilename` → no match), while `fs-browse.ts`'s NAME_LANG maps it to 'shell'.
    expect(languageOf(await languageExtension('.env'))).toBeNull();
    expect(languageOf(await languageExtension('.env', 'shell'))).toBe('shell');
  });

  it('is plain text for anything neither lookup knows', async () => {
    expect(await languageExtension('notes.txt')).toEqual([]);
    // Four of main's own values do not exist in language-data 6.5.2 — svelte, graphql, hcl,
    // makefile — so these two are the honest "no grammar" answer rather than a wrong guess.
    expect(await languageExtension('main.tf', 'hcl')).toEqual([]);
    expect(await languageExtension('Makefile', 'makefile')).toEqual([]);
  });

  it('degrades to plain text when the grammar CHUNK fails to load', async () => {
    // The real failure mode this guards: every grammar is a separate Rollup chunk fetched at run
    // time under `script-src 'self'` from `file://`, so a stale or refused chunk is a rejected
    // dynamic import. Without the try/catch it takes the whole viewer down — the user loses the
    // file's TEXT because its colours could not be fetched.
    vi.resetModules();
    vi.doMock('@codemirror/language-data', async () => {
      const { LanguageDescription } = await import('@codemirror/language');
      return {
        languages: [
          LanguageDescription.of({
            name: 'Exploding',
            extensions: ['boom'],
            load: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
          }),
        ],
      };
    });
    try {
      const mod = await import('./codemirror.ts');
      await expect(mod.languageExtension('a.boom')).resolves.toEqual([]);
    } finally {
      vi.doUnmock('@codemirror/language-data');
      vi.resetModules();
    }
  });
});

describe('createViewer', () => {
  it('shows the document and refuses every edit', async () => {
    const view = track(await createViewer(host(), 'const a = 1;\nconst b = 2;\n', 'a.ts'));
    expect(view.state.doc.toString()).toBe('const a = 1;\nconst b = 2;\n');
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(view.state.facet(language)?.name).toBe('typescript');
  });

  it('renders line numbers and the file\'s text into the parent', async () => {
    const parent = host();
    track(await createViewer(parent, 'one\ntwo\nthree', 'notes.txt'));
    expect(parent.querySelector('.cm-content')?.textContent).toContain('two');
    expect([...parent.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map((e) => e.textContent)).toContain('3');
  });

  it('carries tabindex="0" on its content — the only reason ⌘F can ever reach it', async () => {
    const view = track(await createViewer(host(), 'x', 'a.txt'));
    expect(view.contentDOM.getAttribute('tabindex')).toBe('0');

    // The control, and it is the whole test: a non-editable CodeMirror view WITHOUT
    // `contentAttributes` gets no tab index at all (measured — the content div's attributes are
    // style, spellcheck, autocorrect, autocapitalize, writingsuggestions, translate, contenteditable,
    // class, role, aria-multiline, aria-readonly, and nothing else), so `searchKeymap` would be
    // unreachable dead weight in a viewer that can never take focus.
    const bare = track(
      new EditorView({
        parent: host(),
        state: EditorState.create({ doc: 'x', extensions: [EditorView.editable.of(false), EditorState.readOnly.of(true)] }),
      }),
    );
    expect(bare.contentDOM.hasAttribute('tabindex')).toBe(false);

    // What this test deliberately does NOT do is call `focus()` and read `activeElement`. jsdom 30
    // implements no focusability rule whatsoever: measured on this tree, `focus()` on a bare
    // `<div>` with no tabindex moves `document.activeElement` to it, and so does `focus()` on the
    // control view's content div above. In Chromium neither would move focus. An assertion on
    // `activeElement` here would therefore pass with or without the fix — the exact shape of dead
    // guard G62 warns about — so the attribute is asserted instead, and whether the real viewer
    // takes focus and opens its search panel is a CDP question, not a jsdom one.
  });

  it('themes from the app\'s own tokens, and re-enables text selection', async () => {
    track(await createViewer(host(), 'x', 'a.txt'));
    const css = [...document.head.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    // `theme.css` emits every one of these on `:root`, so the viewer retunes with the app.
    expect(css).toContain('var(--color-bg-0)');
    expect(css).toContain('var(--color-fg)');
    expect(css).toContain('var(--font-mono)');
    // `theme.css` puts `user-select: none` on `body` as the chrome default. A code viewer whose
    // text cannot be selected (or copied) is useless, so the theme opts the content back in.
    expect(css).toMatch(/\.cm-content[^{]*\{[^}]*user-select: text/);
  });
});

describe('createUnifiedDiff', () => {
  it('holds the new text as the document and the old text as the merge original', async () => {
    const view = track(await createUnifiedDiff(host(), 'a\nb\n', 'a\nc\n', 'x.ts'));
    expect(view.state.doc.toString()).toBe('a\nc\n');
    expect(getOriginalDoc(view.state).toString()).toBe('a\nb\n');
    expect(view.state.readOnly).toBe(true);
  });

  it('takes the language the same way the viewer does', async () => {
    const view = track(await createUnifiedDiff(host(), '{}', '{"a":1}', 'pkg.json'));
    expect(view.state.facet(language)?.name).toBe('json');
  });
});
