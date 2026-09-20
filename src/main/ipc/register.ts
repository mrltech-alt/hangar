// Binds the handler map to ipcMain with zod validation and structured error replies (spec §16).
import { ipcMain } from 'electron';
import { IPC_REQUEST_KEYS } from '../../../shared/ipc-contract.ts';
import { IpcSchemas } from '../../../shared/ipc-schemas.ts';
import type { DraftErrorCode } from '../services/linear-ticket-draft.ts';
import type { TriageErrorCode } from '../services/linear-triage.ts';
import type { Logger } from '../services/logger.ts';
import { toIpcError } from './errors.ts';
import type { Handlers } from './handlers.ts';

/**
 * One line naming the offending field. NOT `error.message.split('\n')[0]`: under zod 4 that message
 * is a pretty-printed JSON array, so its first line is the literal `[` and every rejected payload
 * logged the same useless character.
 */
export function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  if (issues.length === 0) return 'invalid';
  // `map(String)` rather than a bare `join`: zod types a path segment as PropertyKey, and
  // Array.prototype.join THROWS on a symbol rather than coercing it.
  return issues.map((i) => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)).join('; ');
}

/**
 * Failure codes that are the user's own choice rather than something going wrong: the reply is the
 * same, but the log line goes out at info so `app.log`'s warnings stay worth reading. `satisfies`
 * ties each entry to the code its emitter actually throws.
 */
const EXPECTED_FAILURE_CODES: ReadonlySet<string> = new Set(['CANCELLED' satisfies TriageErrorCode & DraftErrorCode]);

export function registerIpc(handlers: Handlers, log: Logger): void {
  for (const key of IPC_REQUEST_KEYS) {
    ipcMain.handle(key, async (_event, payload: unknown) => {
      const parsed = IpcSchemas[key].safeParse(payload);
      if (!parsed.success) {
        const summary = describeIssues(parsed.error.issues);
        log.warn(`${key}: invalid payload: ${summary}`);
        return { ok: false, error: { code: 'BAD_REQUEST', message: `invalid payload for ${key}`, detail: summary } };
      }
      try {
        const value = await (handlers[key] as (req: unknown) => Promise<unknown>)(parsed.data);
        return { ok: true, value };
      } catch (e) {
        const error = toIpcError(e);
        // `toIpcError` deliberately never copies `stack`: this reply crosses to the renderer and
        // is rendered in a toast, and main-process paths are not the user's to read.
        log[EXPECTED_FAILURE_CODES.has(error.code) ? 'info' : 'warn'](`${key} failed: ${error.code} ${error.message}`);
        return { ok: false, error };
      }
    });
  }
}
