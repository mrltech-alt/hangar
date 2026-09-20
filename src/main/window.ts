import { BrowserWindow, app, shell } from 'electron';
import { join } from 'node:path';
import { rendererCsp } from '../../shared/csp.ts';
import { externalUrlToOpen, isInternalUrl } from './util/url-guard.ts';
import type { WindowState } from './services/window-state.ts';

/** Severity for `opts.log`. Omitted means `warn`, which is what every origin-lock message is. */
export type WindowLogLevel = 'info' | 'warn' | 'error';

/**
 * `initialState` is where the window was last left (spec §13), already fitted onto the connected
 * displays by `fitToDisplays`; `null` opens at the 1400x900 default, centred.
 */
export function createMainWindow(opts: {
  title: string;
  onFocusChange: (focused: boolean) => void;
  log: (line: string, level?: WindowLogLevel) => void;
  initialState: WindowState | null;
}): BrowserWindow {
  const win = new BrowserWindow({
    title: opts.title,
    ...(opts.initialState ? opts.initialState.bounds : { width: 1400, height: 900 }),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    // Order matters (§13). `maximize()` shows this still-hidden window by itself (measured, Electron
    // 44.2.0), so maximising here rather than after `show()` is one reveal instead of a normal-size
    // window that then zooms; the `show()` after it is a no-op in that case and is what reveals a
    // window that is not maximised. Full screen only once the window is on screen:
    // macOS native full screen moves a window into its own Space, which a window that is not on
    // screen does not have, so `setFullScreen(true)` on a hidden window is not something to rely on.
    // The owner sees the window at its restored rectangle for the length of the system's own
    // full-screen animation — the same entrance any macOS app restored into full screen makes.
    if (opts.initialState?.maximized) win.maximize();
    win.show();
    if (opts.initialState?.fullScreen) win.setFullScreen(true);
  });
  win.on('focus', () => opts.onFocusChange(true));
  win.on('blur', () => opts.onFocusChange(false));

  // Renderer console -> app.log. Without this a renderer failure is invisible in BOTH places: the
  // UI shows a blank or half-drawn window, and `app.log` records a perfectly healthy
  // "window created" / "host connected" / "quit" sequence, because nothing in main ever observed
  // the renderer. Every uncaught rejection this file's own reviewers found — an unhandled
  // `IpcCallError`, a CSP refusal — was invisible to the logs until this line existed.
  // `details` object form, not the legacy positional `(event, level, message, line, sourceId)`:
  // Electron 44 prints "'console-message' arguments are deprecated" for the positional listener.
  // Severity is mapped rather than flattened: logging `[vite] connecting...` as a WARN, which is
  // what a level-less `opts.log` did, trains readers to skim the warnings this file's origin-lock
  // messages are actually for.
  const CONSOLE_LEVELS: Record<string, WindowLogLevel> = { error: 'error', warning: 'warn', info: 'info', debug: 'info' };
  win.webContents.on('console-message', (details) => {
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
    opts.log(`[renderer:${details.level}] ${details.message}${where}`, CONSOLE_LEVELS[details.level] ?? 'warn');
  });

  // Origin lock. `contextIsolation` + `sandbox` isolate the JS context; they do NOT pin the origin
  // the preload is injected into, and Electron re-injects it after every navigation. So without
  // these two guards a single `location.href = 'https://…'` — from a link in rendered repository
  // content, from an xterm web-link, from anything — hands a remote page the whole IPC surface,
  // `session:write` included, which types bytes into a live `$SHELL -il` PTY.
  const guard = win.webContents;
  guard.setWindowOpenHandler(({ url }) => {
    // Never `action: 'allow'`. An allowed open creates a real BrowserWindow with no webPreferences
    // of ours and a live `window.opener` handle back into this one.
    const external = externalUrlToOpen(url);
    if (external === null) {
      opts.log(`blocked window.open to ${url}`);
      return { action: 'deny' };
    }
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  const blockNavigation = (e: { preventDefault: () => void }, url: string): void => {
    if (isInternalUrl(url, process.env.ELECTRON_RENDERER_URL)) return;
    e.preventDefault();
    opts.log(`blocked navigation to ${url}`);
  };
  guard.on('will-navigate', blockNavigation);
  // Subframes too: `will-navigate` covers only the top-level frame, and an iframe that reaches a
  // remote origin is still a renderer process holding this window's preload.
  guard.on('will-frame-navigate', (e) => blockNavigation(e, e.url));
  guard.on('will-attach-webview', (e) => {
    e.preventDefault();
    opts.log('blocked <webview> attach');
  });

  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // Production only: deliver the CSP as a real response header as well as the <meta> the build
    // hardens. A meta policy governs only what is parsed after it, so it depends on the meta
    // staying above every other element — see shared/csp.ts and spec G56. A header has no such
    // ordering dependency, and it is enforced over `file://`: measured in Electron 44, a
    // standalone harness registering this listener saw it fire for a `file://` document and the
    // header's `script-src 'self'` blocked an inline script inside it.
    //
    // Not registered in dev, deliberately: `@vitejs/plugin-react` injects an inline react-refresh
    // preamble that a whole-document `script-src 'self'` would refuse, blanking the dev window.
    // The production document has no inline script at all — electron.vite.config.ts asserts that
    // at build time, which is what makes this header safe to apply here.
    const csp = rendererCsp('production');
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}
