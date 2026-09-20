// Which URLs the renderer is allowed to become, and which may be handed to the OS (spec §16).
// Pure and electron-free so it can be tested without a BrowserWindow; `window.ts` is the only caller.

/**
 * True only for the app's OWN document. Everything else must be refused, because the preload is
 * re-injected after a navigation: a renderer that reaches a remote origin keeps `window.hangar`,
 * and with it `session:write` (bytes typed straight into a live `$SHELL -il` PTY), `fs:read` and
 * `agent:create`. `contextIsolation` and `sandbox` do not help — they isolate the JS context, not
 * the origin the context is granted the bridge on.
 *
 * `rendererUrl` is `ELECTRON_RENDERER_URL` in dev (the Vite server) and undefined once built. The
 * two cases cannot share a rule: `new URL('file:///x').origin` is the string `'null'`, so an
 * origin comparison would either reject every built navigation or — worse, if `'null'` were
 * accepted — match any other opaque origin too. Built builds are matched on the `file:` protocol.
 */
export function isInternalUrl(target: string, rendererUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (rendererUrl !== undefined && rendererUrl !== '') {
    let dev: URL;
    try {
      dev = new URL(rendererUrl);
    } catch {
      return false;
    }
    return url.origin === dev.origin && url.origin !== 'null';
  }
  return url.protocol === 'file:';
}

/**
 * The URL to hand `shell.openExternal`, or null to drop the request entirely. §16 allows exactly
 * `http(s)` and `mailto`; anything else — `file:`, `javascript:`, `vscode:`, an arbitrary
 * registered handler — is a way to make the OS run something on a click inside a repo the user is
 * only reading, so it is refused rather than forwarded.
 */
export function externalUrlToOpen(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? target : null;
}
