import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { assertNoInlineScript, hardenCspMeta } from './shared/csp.ts';

// Build-only. `src/renderer/index.html` carries the DEV policy, because dev needs Vite's HMR
// socket in `connect-src`; the built renderer loads from `file://` and talks only through
// `window.hangar`, so shipping `ws://localhost:* http://localhost:*` in the artefact opened all of
// localhost to a compromised renderer for no benefit. `enforce: 'post'` so this sees the final
// HTML, after every other plugin has injected into it — which is also what makes the inline-script
// assertion meaningful: it is checking the emitted document, not the source.
const hardenRendererCsp: Plugin = {
  name: 'hangar:harden-renderer-csp',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml(html) {
    const hardened = hardenCspMeta(html);
    assertNoInlineScript(hardened);
    return hardened;
  },
};

// Root package.json has no "type": "module", so main and preload are emitted as CommonJS (sandboxed preloads require CJS).
//
// `externalizeDeps: false` overrides electron-vite's default of externalising every entry in
// `dependencies`. With the default, `out/main/index.js` ended in `require("zod")` — measured — and
// a packaged app can only satisfy that by shipping a `node_modules` inside the asar, which
// electron-builder fills with the WHOLE production dependency tree (react, @codemirror/*,
// @xterm/*, and node-pty, a native module built for the system Node's ABI that CLAUDE.md rule 3
// says must never reach the Electron side). Bundling instead costs 180 kB in `out/main/index.js`
// and took the asar from 59 MB to 5.4 MB. `scripts/package.mjs` asserts the bundles stay free of
// node_modules requires, so a dependency that cannot be bundled fails the package build loudly
// rather than at first launch.
//
// `minify: false` is electron-vite's own default, restated here as a decision rather than left as
// an inherited one. The renderer chunk is ~2.3 MB unminified against an Electron runtime of ~350 MB,
// so minifying would shave under 0.3% of the app; readable stack traces are worth more in a
// local-first tool that the agents running inside it are meant to modify. G67 measured the other
// half: esbuild strips comments either way, so nothing in the tree's prose ships regardless.
export default defineConfig({
  main: { build: { externalizeDeps: false, minify: false } },
  preload: { build: { externalizeDeps: false, minify: false } },
  renderer: {
    build: { minify: false },
    plugins: [react(), tailwindcss(), hardenRendererCsp],
  },
});
