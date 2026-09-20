import { defineConfig } from 'vitest/config';

const shared = {
  // TZ pinned: relativeTime() formats in local time, so the suite must not vary by machine.
  env: { TZ: 'UTC' },
  testTimeout: 20_000,
  hookTimeout: 20_000,
  passWithNoTests: true,
};

export default defineConfig({
  test: {
    ...shared,
    projects: [
      {
        test: {
          ...shared,
          name: 'node',
          environment: 'node',
          // Collection is the DEFAULT here and non-collection is the deliberate exception. The
          // enumerated include list this replaces silently orphaned `src/preload/**` — not covered
          // by `src/main/**`, not renderer code — dropping `src/preload/index.test.ts` (6 tests)
          // while the suite still reported all-green, just 565 not 571. Any new top-level
          // directory would have repeated that. Now only `src/renderer/**`, which needs the jsdom
          // project below, has to be named.
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', 'out/**', 'dist/**', 'src/renderer/**'],
        },
      },
      {
        // `jsx: 'automatic'` is REQUIRED for `.test.tsx`, not a style preference. Vitest transforms
        // with esbuild, which reads the nearest `tsconfig.json` — the ROOT one, which sets no `jsx`
        // field, because `"jsx": "react-jsx"` lives in `tsconfig.web.json` and esbuild never looks
        // there. Without this every `<Sidebar />` in a test compiles to the classic
        // `React.createElement` and fails at run time with `ReferenceError: React is not defined`,
        // while `tsc -p tsconfig.web.json` stays green. The app build is unaffected either way:
        // `electron.vite.config.ts` runs `@vitejs/plugin-react`, which sets the automatic runtime
        // itself. Scoped to this project so the node project's transform is untouched.
        esbuild: { jsx: 'automatic' as const },
        test: {
          ...shared,
          name: 'renderer',
          environment: 'jsdom',
          // jsdom 30 implements neither `ResizeObserver` nor `matchMedia`, and a real xterm needs
          // both to `open()` — see the file's own comment for the two exact failures. Scoped to
          // this project so the node project's environment is untouched.
          setupFiles: ['src/renderer/test-setup.ts'],
          include: ['src/renderer/**/*.test.ts', 'src/renderer/**/*.test.tsx'],
        },
      },
    ],
  },
});
