import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoInlineScript, hardenCspMeta, rendererCsp } from './csp.ts';

const indexHtml = readFileSync(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)), 'utf8');

/** The policy string out of a document's CSP meta element — the comment around it is not policy. */
const metaPolicy = (html: string): string | undefined => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];

describe('rendererCsp', () => {
  it('opens localhost in development only — that is Vite HMR, and nothing else needs it', () => {
    expect(rendererCsp('development')).toContain("connect-src 'self' ws://localhost:* http://localhost:*");
    expect(rendererCsp('production')).toContain("connect-src 'self'");
    expect(rendererCsp('production')).not.toContain('localhost');
  });

  it('sets the three directives that do not fall back to default-src', () => {
    for (const mode of ['development', 'production'] as const) {
      expect(rendererCsp(mode)).toContain("base-uri 'none'");
      expect(rendererCsp(mode)).toContain("form-action 'none'");
      expect(rendererCsp(mode)).toContain("object-src 'none'");
    }
  });

  it('keeps script-src free of unsafe-inline and unsafe-eval in both modes', () => {
    for (const mode of ['development', 'production'] as const) {
      const scriptSrc = rendererCsp(mode).split('; ').find((d) => d.startsWith('script-src '));
      expect(scriptSrc).toBe("script-src 'self'");
    }
  });
});

describe('the meta in index.html', () => {
  it('is byte-identical to rendererCsp("development")', () => {
    // The one place the policy is written twice. Without this, adding a directive in csp.ts
    // silently hardens production while dev keeps the old policy (or the reverse), and the
    // divergence only ever shows up as a refusal in one mode and not the other.
    expect(metaPolicy(indexHtml)).toBe(rendererCsp('development'));
  });
});

describe('hardenCspMeta', () => {
  it('rewrites the real index.html meta to the production policy', () => {
    // Not a synthetic fixture: the point is that the pattern still matches the file the build
    // actually transforms. If someone reformats that meta element, this fails here rather than
    // silently shipping the dev policy.
    expect(metaPolicy(indexHtml)).toContain('ws://localhost:*');
    // Asserted on the extracted policy, not the whole document: the explanatory HTML comment
    // beside the meta says the word "localhost" too, and a substring check over the file passes
    // or fails on prose rather than on the thing being tested.
    expect(metaPolicy(hardenCspMeta(indexHtml))).toBe(rendererCsp('production'));
    expect(metaPolicy(hardenCspMeta(indexHtml))).not.toContain('localhost');
  });

  it('leaves the rest of the document alone', () => {
    const hardened = hardenCspMeta(indexHtml);
    expect(hardened).toContain('<div id="root"></div>');
    expect(hardened).toContain('<script type="module" src="./main.tsx"></script>');
  });

  it('throws rather than silently doing nothing when the meta is missing', () => {
    expect(() => hardenCspMeta('<!doctype html><html><head></head><body></body></html>')).toThrow(/no Content-Security-Policy/);
  });
});

describe('assertNoInlineScript', () => {
  it('accepts the source index.html, which only has src= scripts', () => {
    expect(() => assertNoInlineScript(indexHtml)).not.toThrow();
  });

  it('rejects the exact shape @vitejs/plugin-react injects in dev', () => {
    // Copied from the transformed dev HTML this project actually serves (spec G56).
    const devHead = '<script type="module">import { injectIntoGlobalHook } from "/@react-refresh";\ninjectIntoGlobalHook(window);</script>';
    expect(() => assertNoInlineScript(devHead)).toThrow(/inline <script>/);
  });

  it('is not fooled by an attribute ordering that puts src last, or by a data attribute', () => {
    expect(() => assertNoInlineScript('<script type="module" src="./main.tsx"></script>')).not.toThrow();
    expect(() => assertNoInlineScript('<script data-src="x">alert(1)</script>')).toThrow(/inline <script>/);
  });
});
