// The only place handlers touch Electron UI APIs — keeps handlers.ts testable.
import { BrowserWindow, clipboard, dialog, shell } from 'electron';

/**
 * No `openExternalUrl` here: `window.ts` opens external URLs, and the scheme check that decides
 * which ones may go to the OS is `util/url-guard.ts`'s `externalUrlToOpen` (a real `URL` parse).
 * A second, unused one on this interface guarded by a `/^(https?:|mailto:)/` prefix match — which
 * `https:evil` and a `\n`-prefixed string both slip past — was the obviously-named trap for
 * whoever wires terminal web-links next. Use `externalUrlToOpen`.
 */
export interface ElectronBridge {
  pickFolder(title?: string): Promise<string | null>;
  showItemInFolder(path: string): void;
  writeClipboard(text: string): void;
}

export function createElectronBridge(getWindow: () => BrowserWindow | null): ElectronBridge {
  return {
    async pickFolder(title = 'Choose a git repository') {
      const win = getWindow();
      // `message` as well as `title`: Electron documents `title` as not displayed by macOS open
      // panels and `message` as the macOS-only line shown above the file list. Per the docs, not
      // measured here — see docs/RELEASE-CHECKLIST.md.
      const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], title, message: title };
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    writeClipboard: (text) => clipboard.writeText(text),
  };
}
