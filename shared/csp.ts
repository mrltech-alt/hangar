// The renderer's Content-Security-Policy, in one place because it is delivered TWICE and the two
// must not drift: `src/renderer/index.html`'s `<meta http-equiv>` (rewritten to the production
// policy at build time by `electron.vite.config.ts`) and, in production only, a real response
// header set in `src/main/window.ts`.
//
// Why both. A meta-delivered policy is only enforced for content parsed AFTER the meta element,
// and in dev `@vitejs/plugin-react` injects its react-refresh preamble as the FIRST child of
// <head>, above ours — measured on the transformed dev HTML (spec G56). That preamble is why the
// meta policy cannot simply be tightened to cover the whole document in dev. A response header has
// no such ordering dependency, and it does apply over `file://`: measured in Electron 44 with a
// standalone harness, `session.webRequest.onHeadersReceived` fired for a `file://` document and
// the header's `script-src 'self'` blocked an inline script in it. So production, which loads from
// `file://` and (per the build-time assertion in electron.vite.config.ts) contains no inline
// script at all, gets the header as well and stops depending on element order.
//
// Dev is the only mode that needs `ws://localhost:*` / `http://localhost:*` — that is Vite's HMR
// socket. The built renderer's traffic all goes through `window.hangar`, so shipping those tokens
// in the production artefact opened every port on localhost to a compromised renderer for nothing.

const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // These three do NOT fall back to `default-src`, so omitting them left them unrestricted:
  // `base-uri` reparents every relative URL in the document (an injected `<base href>` is honoured
  // for resolution and only then caught by `script-src`), `form-action` is not covered by
  // `default-src` at all, and `object-src` re-enables plugin content on browsers that still take
  // it. All three are `'none'` because the renderer uses none of them.
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
];

export type RendererMode = 'development' | 'production';

/** The full policy string for `mode`, for either delivery mechanism. */
export function rendererCsp(mode: RendererMode): string {
  const connect = mode === 'development' ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'";
  return [...DIRECTIVES, connect].join('; ');
}

/** Matches the CSP meta element in `src/renderer/index.html`; capture groups bracket its content. */
export const CSP_META_PATTERN = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/;

/**
 * Rewrites that meta element to the production policy. Throws rather than silently doing nothing
 * if the element is not found — a build that quietly stopped hardening the policy is the failure
 * mode worth being loud about.
 */
export function hardenCspMeta(html: string): string {
  if (!CSP_META_PATTERN.test(html)) {
    throw new Error('hangar: no Content-Security-Policy <meta> found in the renderer HTML to harden');
  }
  return html.replace(CSP_META_PATTERN, `$1${rendererCsp('production')}$2`);
}

/**
 * A `<script>` element with no `src` attribute, i.e. one carrying inline code.
 *
 * The lookahead requires WHITESPACE before `src`, not `\b`: `\bsrc` also matches inside
 * `data-src`, because `-` is a non-word character, so `<script data-src="x">alert(1)</script>`
 * read as an external script and sailed through. Caught by the test below, which is why it is
 * there.
 */
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>/i;

/**
 * The invariant the production `script-src 'self'` rests on. Asserted against the emitted HTML at
 * build time: if a plugin ever injects an inline preamble into the production bundle the way the
 * react plugin does in dev, the app would ship a policy that refuses its own bootstrap, and the
 * only symptom is a blank window.
 */
export function assertNoInlineScript(html: string): void {
  if (INLINE_SCRIPT.test(html)) {
    throw new Error("hangar: the built renderer HTML contains an inline <script>, which the production CSP's script-src 'self' will refuse");
  }
}
