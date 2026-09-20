/**
 * Two browser APIs jsdom 30 does not implement, installed for the `renderer` vitest project only
 * (`vitest.config.ts` → `setupFiles`).
 *
 * Measured on this tree (jsdom 30.0.1, vitest 5): `typeof ResizeObserver`, `typeof matchMedia`,
 * `typeof WebGL2RenderingContext` and `typeof WebGLRenderingContext` are all `undefined`. Without
 * the first two, mounting a real xterm does not merely degrade, it throws:
 *   - `Terminal.open()` → `TypeError: this._parentWindow.matchMedia is not a function`
 *     (`CoreBrowserService.devicePixelRatio`), so every pane with a running session fails.
 *   - `new ResizeObserver(...)` in `TerminalView` → `ReferenceError`.
 * Chromium has both, so a suite that skipped them would be testing a component the app never runs.
 *
 * WebGL is deliberately NOT stubbed. `enableWebgl()` checks for `WebGL2RenderingContext` and skips,
 * which exercises the same DOM-renderer fallback G17 specifies for a context loss — a real
 * behaviour worth running rather than papering over.
 *
 * The `ResizeObserver` here is a shape, not an implementation: it never fires. That is deliberate
 * for the tests that merely need a terminal to mount. `TerminalView.test.tsx` replaces it with a
 * capturing version for the two tests that actually drive a resize, because jsdom reports 0 for
 * every box and a real observer would have nothing to report.
 */

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globals = globalThis as unknown as { ResizeObserver?: unknown };
globals.ResizeObserver ??= InertResizeObserver;

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  // xterm reads `matchMedia('(resolution: …dppx)')` to watch for a devicePixelRatio change. It only
  // ever needs `matches` and the listener methods; `addListener`/`removeListener` are the
  // deprecated pair, kept because xterm's own feature test still reaches for them.
  const noop = (): void => undefined;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * `HTMLDialogElement.showModal()` and `.close()`, which jsdom 30 does not implement at all.
 *
 * Measured on jsdom 30.0.1: `HTMLDialogElement.prototype` carries exactly `['constructor',
 * 'open']`, so `components/ui/Dialog.tsx`'s mount effect (`if (open && !d.open) d.showModal()`)
 * throws `d.showModal is not a function` and every dialog test would fail before rendering
 * anything. Chromium has both, so — like `matchMedia` above — skipping them would mean testing a
 * component the app never runs.
 *
 * This is a shape, not the top layer: it moves the `open` attribute, which is what makes the
 * dialog's content visible and what `Dialog.tsx` reads, and fires the `close` event that the real
 * `close()` fires. It deliberately does NOT implement the modal parts jsdom has no concept of —
 * inertness of the rest of the page, focus trapping, or Escape raising `cancel`. A test that wants
 * the Escape path dispatches `cancel` itself, which is exactly the event the browser delivers.
 */
if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal !== 'function') {
  const setOpen = (el: HTMLDialogElement, open: boolean): void => {
    if (open) el.setAttribute('open', '');
    else el.removeAttribute('open');
  };
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true, writable: true,
      value(this: HTMLDialogElement) { setOpen(this, true); },
    },
    show: {
      configurable: true, writable: true,
      value(this: HTMLDialogElement) { setOpen(this, true); },
    },
    close: {
      configurable: true, writable: true,
      value(this: HTMLDialogElement, returnValue?: string) {
        if (returnValue !== undefined) this.returnValue = returnValue;
        setOpen(this, false);
        this.dispatchEvent(new Event('close'));
      },
    },
  });
}
