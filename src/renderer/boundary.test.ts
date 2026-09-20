// Guards the renderer's Node/Electron boundary (spec §16, CLAUDE.md rule 9).
//
// This runs the real ESLint against the repo's real flat config rather than asserting the config
// object has some shape, because the thing worth protecting is the OUTCOME, not the spelling. It
// exists because the boundary was, until this test, enforced by nothing at all: with
// `src/renderer/__leak.ts` containing `import { ipcRenderer } from 'electron';` on this tree,
//   tsc -p tsconfig.web.json --noEmit  -> 0
//   eslint .                           -> 0
//   npm run build                      -> 0
// all three gates passed. `"types": []` in tsconfig.web.json suppresses only automatic *global*
// @types inclusion; an explicit module import still resolves through node_modules.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// No `cwd` option: ESLint defaults it to `process.cwd()`, and `process` is not a name this file
// may use — tsconfig.web.json typechecks `src/renderer/**` with `"types": []`, so referencing it
// is a TS2591 here. That is the renderer boundary catching its own guard, which is a good sign.
const eslint = new ESLint();

async function lint(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? '?'}: ${m.message}`);
}

describe('renderer import boundary', () => {
  it.each([
    ['electron', "import { ipcRenderer } from 'electron';\nexport const x = ipcRenderer;\n"],
    ['node: prefixed builtin', "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n"],
    ['bare builtin', "import { spawn } from 'child_process';\nexport const x = spawn;\n"],
    ['bare fs', "import { readFileSync } from 'fs';\nexport const x = readFileSync;\n"],
  ])('rejects an import of %s from src/renderer', async (_label, code) => {
    const messages = await lint('src/renderer/__boundary_probe.ts', code);
    expect(messages.some((m) => m.startsWith('no-restricted-imports:'))).toBe(true);
  });

  it('still allows the imports the renderer legitimately needs', async () => {
    const code = [
      "import { useState } from 'react';",
      "import { createHangarApi } from '../../shared/ipc-client.ts';",
      'export const x = [useState, createHangarApi];',
      '',
    ].join('\n');
    expect(await lint('src/renderer/__boundary_probe.ts', code)).toEqual([]);
  });

  it('does not restrict these imports outside src/renderer', async () => {
    const code = "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n";
    const messages = await lint('src/main/__boundary_probe.ts', code);
    expect(messages.some((m) => m.startsWith('no-restricted-imports:'))).toBe(false);
  });
});
