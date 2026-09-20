import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// The renderer boundary (spec §16, CLAUDE.md rule 9). `tsconfig.web.json`'s `"types": []` was
// believed to enforce this and does NOT: it suppresses automatic *global* @types inclusion only,
// while an explicit `import … from 'electron'` still resolves through node_modules like any other
// package. Measured on this tree: a one-line `src/renderer/__leak.ts` containing
// `import { ipcRenderer } from 'electron';` gave `tsc -p tsconfig.web.json --noEmit` = 0,
// `eslint .` = 0 and `npm run build` = 0 — every gate green with the whole ipcRenderer surface
// imported into the renderer. Lint is where it gets caught instead; `boundary.test.ts` asserts
// this block still bites, so deleting it fails the suite rather than silently reopening the hole.
const RENDERER_BOUNDARY = 'src/renderer/ may not import Electron or Node builtins — it is sandboxed and reaches main only through window.hangar (spec §16, CLAUDE.md rule 9).';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'docs/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Enabled explicitly, not via js.configs.recommended (which would need a Node globals
      // config and flag `process`/`console` everywhere). Several files deliberately match
      // control characters — stripping them is a real security control, see spec §16 — so the
      // rule needs to be ON for the `eslint-disable-next-line no-control-regex` comments beside
      // those regexes to mean anything. Without it they are dead text.
      'no-control-regex': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        // `builtinModules` rather than a hand-list: a hand-list silently goes stale every time
        // Node adds a module, and this is a security boundary.
        paths: [...builtinModules, 'electron'].map((name) => ({ name, message: RENDERER_BOUNDARY })),
        patterns: [{ group: ['node:*', 'electron', 'electron/*'], message: RENDERER_BOUNDARY }],
      }],
    },
  },
);
