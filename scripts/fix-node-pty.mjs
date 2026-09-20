#!/usr/bin/env node
// Postinstall: node-pty's prebuilt spawn-helper ships without the execute bit (spec G3).
import { ensureSpawnHelperExecutable } from '../host/pty-fix.ts';

const result = ensureSpawnHelperExecutable();
if (result.packageDir === null) {
  console.log('[fix-node-pty] node-pty not installed yet; nothing to do');
} else if (result.checked.length === 0) {
  // Not an error: a future node-pty may drop spawn-helper entirely, at which point G3 no longer applies.
  console.log(`[fix-node-pty] node-pty at ${result.packageDir} has no spawn-helper at the expected paths; nothing to do`);
} else if (result.fixed.length === 0 && result.failed.length === 0) {
  console.log('[fix-node-pty] spawn-helper already executable');
} else {
  for (const p of result.fixed) console.log(`[fix-node-pty] chmod +x ${p}`);
  for (const f of result.failed) console.warn(`[fix-node-pty] could not chmod ${f.path}: ${f.error}`);
}
