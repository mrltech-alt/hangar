/**
 * The terminal registry: the two gotchas that live inside a `Terminal` the rest of the app can
 * never reach (G19 Shift+Enter, G20 ⌘-combos), the G8 fit guard, and the G17 WebGL fallback.
 *
 * `attachCustomKeyEventHandler` is called once, deep inside `createTerminal`, and there is no
 * getter for it — which is why `classifyTerminalKey` is exported and pure. The last block then
 * dispatches a REAL keydown at xterm's own helper textarea, so "the pure function says newline"
 * and "the terminal actually calls onShiftEnter" are two separate claims, both checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyTerminalKey, createTerminal, focusTerminal, MIN_FIT_PX, terminals, type TerminalHandle,
} from './terminal-registry.ts';

const key = (patch: Partial<Parameters<typeof classifyTerminalKey>[0]> = {}) => ({
  type: 'keydown', key: 'a', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...patch,
});

const open: TerminalHandle[] = [];
const hosts: HTMLElement[] = [];

function make(patch: Partial<Parameters<typeof createTerminal>[0]> = {}): { handle: TerminalHandle; el: HTMLElement; shiftEnter: () => void; openLink: (url: string) => void } {
  const shiftEnter = vi.fn();
  const openLink = vi.fn();
  const handle = createTerminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 1234, onShiftEnter: shiftEnter, onOpenLink: openLink, onEscape: () => false, ...patch });
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  open.push(handle);
  return { handle, el, shiftEnter, openLink };
}

afterEach(() => {
  for (const h of open.splice(0)) h.dispose();
  for (const el of hosts.splice(0)) el.remove();
  terminals.clear();
});

describe('classifyTerminalKey (G19 — Shift+Enter)', () => {
  // xterm sends a bare `\r` for Shift+Enter, identical to Enter, so Claude submits the prompt.
  it('claims Shift+Enter so the caller can send \\n instead', () => {
    expect(classifyTerminalKey(key({ key: 'Enter', shiftKey: true }))).toBe('newline');
  });

  it('leaves plain Enter to the terminal', () => {
    expect(classifyTerminalKey(key({ key: 'Enter' }))).toBe('terminal');
  });

  // The same handler receives keyup. Acting on both would send two newlines for one keypress.
  it('ignores everything that is not a keydown', () => {
    expect(classifyTerminalKey(key({ type: 'keyup', key: 'Enter', shiftKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ type: 'keypress', key: 'Enter', shiftKey: true }))).toBe('terminal');
  });

  // ⌥Enter is `macOptionIsMeta`'s job (Meta+Enter to Claude) and ⌃⇧Enter is the shell's.
  it('does not claim Shift+Enter with another modifier held', () => {
    expect(classifyTerminalKey(key({ key: 'Enter', shiftKey: true, altKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'Enter', shiftKey: true, metaKey: true }))).toBe('app');
  });
});

describe('classifyTerminalKey (G20 — ⌘ combos)', () => {
  it('keeps ⌘C and ⌘V with the terminal so copy and paste stay native', () => {
    for (const k of ['c', 'v', 'C', 'V']) expect(classifyTerminalKey(key({ key: k, metaKey: true }))).toBe('terminal');
  });

  it('declines every other ⌘ combo, including ones the keymap does not claim', () => {
    // The keymap's own table (⌘N, ⌘K, ⌘1, ⌘⇧D…) plus ⌘A/⌘Z/⌘,, which belong to Chromium and
    // Electron's menu. Either way the answer is the same: not the PTY's.
    for (const k of ['n', 'k', '1', 'b', 'e', 'a', 'z', ',']) expect(classifyTerminalKey(key({ key: k, metaKey: true }))).toBe('app');
    expect(classifyTerminalKey(key({ key: 'D', metaKey: true, shiftKey: true }))).toBe('app');
  });

  it('leaves ⌃ combos and ordinary characters alone', () => {
    expect(classifyTerminalKey(key({ key: 'c', ctrlKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'r', ctrlKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'a' }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'ArrowUp' }))).toBe('terminal');
  });
});

describe('classifyTerminalKey (Plan 09 — Escape)', () => {
  it('asks the caller about a bare Escape keydown', () => {
    expect(classifyTerminalKey(key({ key: 'Escape' }))).toBe('escape');
  });

  // Only the keydown: acting on keyup too would send two cancels for one press.
  it('leaves keyup and keypress to the terminal', () => {
    expect(classifyTerminalKey(key({ type: 'keyup', key: 'Escape' }))).toBe('terminal');
    expect(classifyTerminalKey(key({ type: 'keypress', key: 'Escape' }))).toBe('terminal');
  });

  // ⌥Esc is Meta+Esc to a TUI (`macOptionIsMeta`) and ⌃/⇧Esc are different keys too; none of them
  // is "cancel the dictation", so none of them is ever asked about.
  it('never asks about an Escape with a modifier held', () => {
    expect(classifyTerminalKey(key({ key: 'Escape', altKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'Escape', ctrlKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'Escape', shiftKey: true }))).toBe('terminal');
    expect(classifyTerminalKey(key({ key: 'Escape', metaKey: true }))).toBe('app');
  });
});

describe('terminal options', () => {
  it('passes the config store\'s font and scrollback through, and turns on Unicode 11 (G18)', () => {
    const { handle } = make();
    expect(handle.term.options.scrollback).toBe(1234);
    expect(handle.term.options.fontSize).toBe(13);
    expect(handle.term.options.fontFamily).toBe('Menlo, monospace');
    // ⌥ as Meta is G19's other half: Option+Enter has to reach Claude as a meta key.
    expect(handle.term.options.macOptionIsMeta).toBe(true);
    // G18: Claude Code's spinners and emoji are laid out on Unicode 11 widths.
    expect(handle.term.unicode.activeVersion).toBe('11');
  });
});

describe('fitIfVisible (G8)', () => {
  const size = (el: HTMLElement, w: number, h: number): void => {
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  };

  /**
   * THE G8 test, and the reason the guard cannot be "FitAddon handles it".
   *
   * Measured here: with a zero-size container, `FitAddon.proposeDimensions()` returns `undefined`
   * and `fit()` is a silent no-op — it neither throws nor produces NaN. So `term.cols`/`term.rows`
   * still read 80 x 24, the constructor's defaults, and a `fitIfVisible` that trusted them would
   * hand main a plausible-looking size that measured nothing. The assertion on `term.cols` below
   * is what makes that the point of the test rather than a coincidence.
   */
  it('returns null for a container that has not been laid out, even though term.cols reads fine', () => {
    const { handle, el } = make();
    handle.term.open(el);
    expect(el.clientWidth).toBe(0);
    expect(handle.term.cols).toBe(80);
    expect(handle.fitIfVisible(el)).toBeNull();
  });

  it('refuses anything under MIN_FIT_PX in either axis', () => {
    const { handle, el } = make();
    handle.term.open(el);
    size(el, MIN_FIT_PX - 1, 400);
    expect(handle.fitIfVisible(el)).toBeNull();
    size(el, 400, MIN_FIT_PX - 1);
    expect(handle.fitIfVisible(el)).toBeNull();
  });

  // Above the threshold it returns a size, and every size it returns is one a PTY can take:
  // positive integers, never NaN, Infinity or a fraction.
  it('returns a positive integer pair once the container is big enough', () => {
    const { handle, el } = make();
    handle.term.open(el);
    size(el, 800, 400);
    const dims = handle.fitIfVisible(el);
    expect(dims).not.toBeNull();
    expect(Number.isInteger(dims?.cols)).toBe(true);
    expect(Number.isInteger(dims?.rows)).toBe(true);
    expect(dims && dims.cols > 0 && dims.rows > 0).toBe(true);
  });
});

describe('enableWebgl (G17)', () => {
  /**
   * jsdom has no `WebGL2RenderingContext` at all (measured: `undefined`), which is the same shape
   * as a Chromium that has run out of WebGL contexts — G17's "too many contexts" half. Either way
   * the terminal must keep working on the DOM renderer instead of throwing out of the effect that
   * mounts the pane.
   */
  it('falls back silently when WebGL2 is unavailable, and the terminal still writes', () => {
    const { handle, el } = make();
    handle.term.open(el);
    expect(typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext).toBe('undefined');
    expect(() => handle.enableWebgl()).not.toThrow();
    expect(() => handle.term.write('hello')).not.toThrow();
  });

  // The pre-check must not be the only guard: a browser that HAS the constructor can still refuse
  // the context. Standing in one in and letting the addon throw proves the try/catch is live.
  it('also survives a WebGL2 that exists but cannot be created', () => {
    const globals = globalThis as { WebGL2RenderingContext?: unknown };
    globals.WebGL2RenderingContext = class {};
    try {
      const { handle, el } = make();
      handle.term.open(el);
      expect(() => handle.enableWebgl()).not.toThrow();
      expect(() => handle.term.write('hello')).not.toThrow();
    } finally {
      delete globals.WebGL2RenderingContext;
    }
  });
});

describe('the registry map', () => {
  it('focuses the terminal registered for an agent', () => {
    const { handle, el } = make();
    handle.term.open(el);
    const focus = vi.spyOn(handle.term, 'focus');
    terminals.set('a1', handle);
    focusTerminal('a1');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  // ⌘3 on a pane whose agent is not running reaches here. A throw would take the keymap with it.
  it('does nothing for an agent with no terminal', () => {
    expect(() => focusTerminal('nobody')).not.toThrow();
  });
});

/**
 * The wiring, not the classifier: `attachCustomKeyEventHandler` is called inside `createTerminal`
 * and nothing exposes it, so this dispatches a real keydown at the textarea xterm actually listens
 * on. Without this, `classifyTerminalKey` could be perfect and unreferenced.
 */
describe('the custom key handler is actually attached', () => {
  const press = (el: HTMLElement, init: KeyboardEventInit): void => {
    const target = el.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
    if (!target) throw new Error('xterm helper textarea not found');
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  };

  it('calls onShiftEnter for Shift+Enter and nothing for plain Enter', () => {
    const { handle, el, shiftEnter } = make();
    handle.term.open(el);
    press(el, { key: 'Enter', shiftKey: true });
    expect(shiftEnter).toHaveBeenCalledTimes(1);
    press(el, { key: 'Enter' });
    expect(shiftEnter).toHaveBeenCalledTimes(1);
  });

  /**
   * Escape, both ways, through the real handler. `keyCode: 27` because xterm's keyboard evaluator
   * reads the legacy `keyCode`, not `key` — without it xterm sends nothing for an Escape and the
   * pass-through half below would pass vacuously.
   */
  it('lets Escape through to the PTY as ESC when the caller does not consume it', () => {
    const onEscape = vi.fn(() => false);
    const { handle, el } = make({ onEscape });
    handle.term.open(el);
    const data: string[] = [];
    handle.term.onData((d) => void data.push(d));
    press(el, { key: 'Escape', keyCode: 27 });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(data).toEqual([String.fromCharCode(27)]);
  });

  it('sends the PTY nothing for an Escape the caller consumes, and asks exactly once per press', () => {
    let consume = true;
    const onEscape = vi.fn(() => consume);
    const { handle, el } = make({ onEscape });
    handle.term.open(el);
    const data: string[] = [];
    handle.term.onData((d) => void data.push(d));
    press(el, { key: 'Escape', keyCode: 27 });
    handle.term.element?.querySelector('textarea.xterm-helper-textarea')?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', keyCode: 27 }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(data).toEqual([]);
    // The answer is asked per press, not fixed at construction: once the caller stops consuming
    // (the run has ended), the very next Escape is the terminal's again.
    consume = false;
    press(el, { key: 'Escape', keyCode: 27 });
    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(data).toEqual([String.fromCharCode(27)]);
  });

  it('does not write Shift+Enter to the PTY itself — the caller sends \\n', () => {
    const { handle, el } = make();
    handle.term.open(el);
    const data: string[] = [];
    handle.term.onData((d) => void data.push(d));
    press(el, { key: 'Enter', shiftKey: true });
    expect(data).toEqual([]);
  });
});
