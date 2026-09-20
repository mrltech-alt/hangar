// xterm.js instances live here, outside React state (spec §12.4, §13). One handle per attached
// agent, keyed by agent id rather than pane index: a pane is a slot and an agent moves between
// slots, so the registry is what `focusTerminal` (the ⌘1…⌘4 keymap) and the ⌘F find bar
// (`TerminalSearch`, which looks its handle up by id on every keystroke) address without knowing
// where the agent is currently shown.
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Id } from '../../../shared/types.ts';

/**
 * The palette, duplicated from `theme.css`'s `@theme` block because xterm takes a JS object and
 * cannot read a CSS custom property. `background`/`foreground`/`cursor` are `--color-bg-0` and
 * `--color-fg`; the ANSI 16 are the status quartet extended to a full set. If the theme tokens
 * move, these must move with them — there is no mechanism that will tell you.
 */
export const TERMINAL_THEME = {
  background: '#0f1115', foreground: '#d6d9e0', cursor: '#d6d9e0', cursorAccent: '#0f1115', selectionBackground: '#2f3b55',
  black: '#1c2029', red: '#ff6b6b', green: '#3ddc84', yellow: '#f5b83d', blue: '#6ea8fe', magenta: '#c792ea', cyan: '#7fdbca', white: '#d6d9e0',
  brightBlack: '#667089', brightRed: '#ff8787', brightGreen: '#5ee89a', brightYellow: '#ffd166', brightBlue: '#8fbcff', brightMagenta: '#d7a8ff', brightCyan: '#9eeadb', brightWhite: '#ffffff',
};

/**
 * The smallest container this will fit into, in CSS px.
 *
 * Measured in Electron 44's own Blink (`show:false` window, `about:blank`, dpr 1): one Menlo cell
 * at the default `fontSize: 13` is **7.828125 x 15.00 px**, and at 12 px it is 7.234375 x 14.00.
 * So 20 px is two columns and one row of headroom — small enough that a genuinely narrow pane
 * still fits, large enough that a container which has not been laid out yet (0 x 0) is refused.
 *
 * The guard is not redundant with FitAddon's own. Measured under jsdom with a zero-size container:
 * `proposeDimensions()` returns `undefined` and `fit()` is a silent **no-op** — it does not throw
 * and it does not produce NaN, so `term.cols`/`term.rows` are left at whatever they were (80 x 24
 * on a fresh terminal). That is the shape of G8 in xterm 6: not a NaN PTY size, but a STALE size
 * reported as though it had just been measured. Hence `fitIfVisible` returns `null` instead of
 * reading `term.cols` back after a fit it has no evidence actually happened.
 */
export const MIN_FIT_PX = 20;

export interface TerminalHandle {
  term: Terminal;
  /**
   * The find bar's engine (⌘F). Exposed on the handle rather than held by the React component
   * that renders the bar, because the terminal outlives that component: `TerminalSearch` looks the
   * handle up by agent id at EVENT time, so a search still runs against the live terminal after a
   * pane move has disposed and rebuilt it underneath an open bar.
   */
  search: SearchAddon;
  /** Fits to the container; null when the container is too small to have been laid out (G8). */
  fitIfVisible(el: HTMLElement): { cols: number; rows: number } | null;
  /** Call after `term.open()`; falls back to the DOM renderer on failure or context loss (G17). */
  enableWebgl(): void;
  dispose(): void;
}

export interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  onShiftEnter: () => void;
  onOpenLink: (url: string) => void;
  /**
   * A bare Escape, asked BEFORE the terminal sees it. Return true to consume it (xterm then sends
   * nothing to the PTY), false to let it through untouched. `TerminalView` answers true only while
   * its agent is being dictated to (Plan 09: Escape cancels) — at every other time Escape is the
   * terminal's, and Claude Code uses it to interrupt. Required rather than optional so a caller
   * cannot forget the question and silently lose the cancel.
   */
  onEscape: () => boolean;
}

/**
 * What xterm should do with a keydown.
 *
 * - `terminal` — xterm handles it and the bytes go to the PTY.
 * - `newline` — G19: xterm sends a bare `\r` for Shift+Enter, identical to Enter, so Claude
 *   submits instead of inserting a line break. The caller writes `\n` (Ctrl-J, the newline every
 *   terminal documents) and xterm is told to stay out of it.
 * - `app` — G20: xterm swallows ⌘ combos unless told not to. Everything except ⌘C and ⌘V is
 *   Hangar's, so xterm declines it and `keymap.ts`'s window-capture listener has already claimed
 *   the ones it knows. ⌘C and ⌘V stay with xterm so copy/paste behave natively.
 * - `escape` — a bare Escape keydown, which the caller is ASKED about (`onEscape`) and which goes
 *   to the terminal unless the caller consumes it. Plan 09: Escape cancels a dictation, and the
 *   pill that shows one never has focus, so the only handler that ever sees the keystroke is this
 *   one — the terminal's own, the same place Shift+Enter is settled. Never a `window` listener:
 *   Escape belongs to the terminal at every moment a dictation is not running into it.
 *
 * Pure and exported so G19 and G20 are testable without a DOM: `attachCustomKeyEventHandler` is
 * called once, deep inside `createTerminal`, and is otherwise unreachable from a test.
 */
export type TerminalKeyVerdict = 'terminal' | 'newline' | 'app' | 'escape';

export interface KeyLike {
  type?: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function classifyTerminalKey(e: KeyLike): TerminalKeyVerdict {
  // keyup/keypress are handed to the same handler; only keydown decides anything, and acting on
  // keyup as well would fire `onShiftEnter` twice for one Shift+Enter.
  if (e.type !== undefined && e.type !== 'keydown') return 'terminal';
  if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return 'newline';
  // Bare only: ⌥Esc and ⌃Esc are the shell's, and a modifier makes it a different key to a TUI.
  if (e.key === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return 'escape';
  if (e.metaKey) {
    const k = e.key.toLowerCase();
    return k === 'c' || k === 'v' ? 'terminal' : 'app';
  }
  return 'terminal';
}

export function createTerminal(opts: TerminalOptions): TerminalHandle {
  const term = new Terminal({
    allowProposedApi: true, // required by Unicode11Addon
    cursorBlink: true,
    macOptionIsMeta: true, // G19's other half: Option+Enter reaches Claude as Meta+Enter
    scrollback: opts.scrollback,
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    fontWeightBold: '600',
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Decorations need `allowProposedApi` (`registerMarker`/`registerDecoration`), which is already
  // set above for Unicode11. Not disposed explicitly the way the WebGL addon is: that one is
  // ordered by hand because it parents a canvas to the terminal's element, whereas xterm's addon
  // manager disposes this one with the terminal and it owns nothing outside it.
  const search = new SearchAddon();
  term.loadAddon(search);
  // G18: Claude Code's spinners and emoji are laid out on Unicode 11 widths; xterm's default
  // tables are Unicode 6 and misalign the whole TUI by a column at a time.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // ⌘-click only. A bare click in a terminal is a cursor/selection gesture, and Claude Code's
      // output is full of URLs the user is reading, not following.
      if (event.metaKey) opts.onOpenLink(uri);
    }),
  );
  term.attachCustomKeyEventHandler((e) => {
    const verdict = classifyTerminalKey(e);
    if (verdict === 'newline') {
      opts.onShiftEnter();
      return false;
    }
    // Consumed → false, and xterm sends nothing. Not consumed → true, exactly as `terminal`: the
    // Escape reaches the PTY as it always did.
    if (verdict === 'escape') return !opts.onEscape();
    return verdict === 'terminal';
  });
  let webgl: WebglAddon | null = null;
  return {
    term,
    search,
    fitIfVisible(el) {
      if (el.clientWidth < MIN_FIT_PX || el.clientHeight < MIN_FIT_PX) return null;
      try {
        fit.fit();
      } catch {
        // `Terminal.resize` verifies its arguments are integers and throws otherwise, so a
        // dimension FitAddon computed from a degenerate cell size surfaces here rather than as a
        // corrupt PTY size. Nothing to report: the ResizeObserver will try again on the next frame
        // that changes the box.
        return null;
      }
      const { cols, rows } = term;
      // The second half of the G8 guard, and the one that catches a fit that silently did nothing:
      // only a positive integer pair is a size worth sending to a PTY.
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
      return { cols, rows };
    },
    enableWebgl() {
      // G17: the WebGL renderer loses its context on sleep or a GPU reset, and Chromium caps the
      // number of live contexts — with four panes that cap is in reach. Both paths land on xterm's
      // DOM renderer, which is what the terminal falls back to when no addon is loaded.
      //
      // The `typeof` pre-check is not defensive noise: measured under jsdom, `WebGL2RenderingContext`
      // is `undefined` and `loadAddon` throws `Error: WebGL2 not supported` only AFTER
      // `HTMLCanvasElement.getContext` has logged jsdom's "Not implemented" warning once per
      // terminal. Checking first keeps the renderer test output readable and costs one property
      // read in Electron, where the constructor is always defined.
      if (typeof WebGL2RenderingContext === 'undefined') return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webgl = null;
      }
    },
    dispose() {
      // Ordered: the addon holds a canvas parented to the terminal's element, and disposing the
      // terminal first leaves it to tear down against a detached tree.
      webgl?.dispose();
      webgl = null;
      term.dispose();
    },
  };
}

/**
 * Live terminals by agent id. A plain module-level Map, deliberately not React state: re-rendering
 * a pane must never recreate a `Terminal` (G26), and the keymap needs to reach a terminal from
 * outside the tree.
 */
export const terminals = new Map<Id, TerminalHandle>();

export function focusTerminal(agentId: Id): void {
  terminals.get(agentId)?.term.focus();
}
