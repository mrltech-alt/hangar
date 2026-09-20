import { describe, expect, it } from 'vitest';
import { externalUrlToOpen, isInternalUrl } from './url-guard.ts';

const DEV = 'http://localhost:5173';

describe('isInternalUrl (dev: renderer served over http)', () => {
  it('allows the dev server origin, on any path or query', () => {
    expect(isInternalUrl('http://localhost:5173/', DEV)).toBe(true);
    expect(isInternalUrl('http://localhost:5173/index.html?x=1#y', DEV)).toBe(true);
  });
  it('refuses every other origin, including a different port and https on the same host', () => {
    for (const u of ['https://example.com/', 'http://localhost:5174/', 'https://localhost:5173/', 'http://127.0.0.1:5173/']) {
      expect(isInternalUrl(u, DEV)).toBe(false);
    }
  });
  it('refuses file: while a dev server is in use', () => {
    expect(isInternalUrl('file:///Users/me/code/hangar/out/renderer/index.html', DEV)).toBe(false);
  });
});

describe('isInternalUrl (built: renderer loaded from disk)', () => {
  it('allows file: URLs', () => {
    expect(isInternalUrl('file:///Users/me/code/hangar/out/renderer/index.html', undefined)).toBe(true);
  });
  it('refuses remote origins', () => {
    expect(isInternalUrl('https://example.com/', undefined)).toBe(false);
    expect(isInternalUrl('http://localhost:5173/', undefined)).toBe(false);
  });
  it('treats an empty ELECTRON_RENDERER_URL as unset rather than as an origin', () => {
    // `process.env.X` is '' for an exported-but-empty var; `new URL('')` throws, and an early
    // `return false` there would block the built app's own document.
    expect(isInternalUrl('file:///x/index.html', '')).toBe(true);
  });
});

describe('isInternalUrl (hostile input)', () => {
  it('refuses unparseable targets rather than throwing', () => {
    for (const u of ['', 'not a url', '//evil.com', 'javascript:alert(1)']) {
      expect(isInternalUrl(u, DEV)).toBe(false);
      expect(isInternalUrl(u, undefined)).toBe(false);
    }
  });
  it("never matches an opaque origin against another opaque origin", () => {
    // Both sides stringify to 'null'; without the explicit guard this pair would compare equal
    // and let a data: document count as the app's own.
    expect(isInternalUrl('data:text/html,<script>1</script>', 'data:text/html,x')).toBe(false);
  });
});

describe('externalUrlToOpen', () => {
  it('passes http, https and mailto through unchanged', () => {
    expect(externalUrlToOpen('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(externalUrlToOpen('http://example.com/')).toBe('http://example.com/');
    expect(externalUrlToOpen('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
  it('refuses every scheme that can make the OS run something', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'smb://host/share', 'data:text/html,x', 'not a url']) {
      expect(externalUrlToOpen(u)).toBeNull();
    }
  });
});
