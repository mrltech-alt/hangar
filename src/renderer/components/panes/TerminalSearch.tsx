import type { ISearchOptions } from '@xterm/addon-search';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Id } from '../../../../shared/types.ts';
import { terminals } from '../../lib/terminal-registry.ts';
import { IconButton } from '../ui/Button.tsx';

/**
 * Match highlighting, in the palette's yellow (`TERMINAL_THEME.yellow`, `#f5b83d`).
 *
 * The alpha suffixes are deliberate and they are load-bearing: a decoration is painted BEHIND the
 * cell, so an opaque yellow under `#d6d9e0` text is unreadable. `@xterm/addon-search`'s own typedoc
 * says these "must use #RRGGBB format", which is wrong for xterm 6.0.0 — measured in
 * `@xterm/xterm/lib/xterm.js`, `css.toColor` switches on the string's length and `case 9:` parses
 * `#RRGGBBAA` into an rgba with the alpha kept (`parseInt(e.slice(1), 16) >>> 0`), where `case 7:`
 * is the documented form and forces alpha to 255. So eight digits are supported, just undocumented.
 *
 * The two overview-ruler colours are opaque because the ruler is a separate strip beside the
 * scrollbar with nothing behind it, and they are REQUIRED by `ISearchDecorationOptions` — the two
 * background fields are optional and these two are not.
 *
 * Module scope, not rebuilt per render: it is a constant, and rebuilding it would hand xterm a new
 * object on every keystroke for no reason.
 */
const SEARCH_OPTIONS: ISearchOptions = {
  regex: false,
  caseSensitive: false,
  decorations: {
    matchBackground: '#f5b83d55',
    activeMatchBackground: '#f5b83daa',
    matchOverviewRuler: '#f5b83d',
    activeMatchColorOverviewRuler: '#f5b83d',
  },
};

/** `incremental` expands the current selection while the term is still growing, so typing does not
 *  jump the viewport away from a match the user is in the middle of spelling. `findPrevious`
 *  ignores it (the addon's own typedoc), which is why only the typing path passes it. */
const INCREMENTAL: ISearchOptions = { ...SEARCH_OPTIONS, incremental: true };

/**
 * The ⌘F find bar for one terminal pane.
 *
 * Takes an AGENT ID, not a `TerminalHandle`. The handle is looked up in the registry at event time
 * because the terminal does not survive a pane move: `TerminalView`'s effect is keyed
 * `[agentId, paneIndex]`, so moving a pane disposes the `Terminal` and builds a new one, addon and
 * decorations included. A handle captured as a prop would go stale and every keystroke would then
 * be searching a disposed terminal. A lookup per keystroke is a `Map.get`.
 *
 * It also removes the defect in the shape this was planned as: `terminals.get(agentId)` in a render
 * body reads a plain `Map`, which is not reactive, so a render that happened to land between one
 * effect's teardown and the next one's setup could read a disposed handle — or nothing — with
 * no re-render scheduled to correct it. Nothing here reads the registry during render.
 *
 * `found === false` is the only result state shown. `findNext` returns a boolean and that answers
 * the question a user actually has ("is it in here at all?"); the addon's richer
 * `onDidChangeResults` event would give an n-of-m counter at the cost of a subscription to dispose,
 * which is not worth it for a bar that has no counter in the spec.
 */
export function TerminalSearch({ agentId, onClose }: { agentId: Id; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const search = (term: string, dir: 'next' | 'prev', opts: ISearchOptions): void => {
    const addon = terminals.get(agentId)?.search;
    // An empty box is not "no matches" — it is no query. Clearing here is what makes deleting the
    // term back to nothing put the terminal back the way it was found.
    if (term === '') {
      addon?.clearDecorations();
      setFound(true);
      return;
    }
    setFound(addon !== undefined && (dir === 'next' ? addon.findNext(term, opts) : addon.findPrevious(term, opts)));
  };

  const dismiss = (): void => {
    const handle = terminals.get(agentId);
    handle?.search.clearDecorations();
    onClose();
    // Hand the keyboard back. Closing the bar without this leaves focus on a removed input, which
    // Chromium resets to BODY — so the next thing the user types goes nowhere rather than to Claude.
    handle?.term.focus();
  };

  return (
    <div className="absolute top-1 right-3 z-10 flex items-center gap-1 rounded-md border border-line bg-bg-2 p-1 shadow-lg">
      <input
        ref={input}
        value={q}
        aria-label="Find in terminal"
        placeholder="Find"
        className={`w-48 bg-transparent px-1 text-[12px] outline-none ${found ? 'text-fg' : 'text-red'}`}
        onChange={(e) => {
          setQ(e.target.value);
          search(e.target.value, 'next', INCREMENTAL);
        }}
        onKeyDown={(e) => {
          // Not `stopPropagation`: `installKeymap`'s listener captures on `window`, so it has
          // already run by the time this fires and stopping here would change nothing. This input
          // IS a text field by `isTextField`, so the keymap's own text-field gate is what keeps
          // ⌘N and ⌘⇧W off it.
          if (e.key === 'Enter') search(q, e.shiftKey ? 'prev' : 'next', SEARCH_OPTIONS);
          if (e.key === 'Escape') dismiss();
        }}
      />
      <IconButton title="Previous match" onClick={() => search(q, 'prev', SEARCH_OPTIONS)}><ChevronUp size={12} /></IconButton>
      <IconButton title="Next match" onClick={() => search(q, 'next', SEARCH_OPTIONS)}><ChevronDown size={12} /></IconButton>
      <IconButton title="Close find" onClick={dismiss}><X size={12} /></IconButton>
    </div>
  );
}
