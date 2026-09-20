import type { Readable } from 'node:stream';
import { HOOK_REPLY_TIMEOUT_MS, HOOK_STDIN_TIMEOUT_MS, NOTE_MAX } from '../../shared/constants.ts';
import type { CliContext } from '../context.ts';
import { requestOnce } from '../socket.ts';

/** Only these hook fields are forwarded (spec §11.4). */
export const HOOK_FIELDS = ['hook_event_name', 'notification_type', 'message', 'session_id', 'cwd', 'matcher', 'title'] as const;

export function pickHookFields(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const key of HOOK_FIELDS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // Truncate here, not at the host: the host queues up to EVENT_QUEUE_LIMIT of these per agent
    // while no app is connected, and `payload: z.unknown()` means it will hold whatever it is sent.
    out[key] = typeof value === 'string' ? value.slice(0, NOTE_MAX) : value;
  }
  return out;
}

/**
 * Reads a stream to EOF, or gives up after `timeoutMs`.
 *
 * On finishing it detaches its listeners and pauses the stream. Without that, a hook whose stdin
 * is a pipe nobody closes keeps the process alive long after the promise resolves — measured at
 * 8 s against a 2 s timeout — which blows through the hook's own `timeout: 5` and, worse, holds up
 * Claude's turn (spec G16). The listeners are what ref the handle, so removing them is the fix.
 */
export function readAll(stream: Readable, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const onData = (chunk: string): void => {
      data += chunk;
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', finish);
      stream.off('error', finish);
      stream.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

/** Never fails: a broken hook must never slow Claude down (spec G16). */
/**
 * A Claude Code hook. ALWAYS returns 0 (spec G16): a hook that fails loudly, or slowly, delays the
 * agent's turn for no user benefit. The outer try/catch is deliberate belt-and-braces — the
 * guarantee should not depend on every call below happening not to throw.
 */
export async function runEvent(args: string[], ctx: CliContext): Promise<number> {
  try {
    return await runEventInner(args, ctx);
  } catch {
    return 0;
  }
}

async function runEventInner(_args: string[], ctx: CliContext): Promise<number> {
  if (ctx.agentId === null) return 0;
  // 2 s, not HOOK_REPLY_TIMEOUT_MS: G16's ~300 ms budget describes the normal path, where Claude
  // writes the payload and closes stdin immediately (measured ~0.10 s end to end). This cap only
  // fires when stdin is a pipe nobody closes, and it stays well inside the hook's own `timeout: 5`.
  const text = await readAll(ctx.stdin, HOOK_STDIN_TIMEOUT_MS);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 0;
  }
  const payload = pickHookFields(raw);
  if (typeof payload.hook_event_name !== 'string') return 0;
  await requestOnce(ctx.socketPath, { t: 'cli', agentId: ctx.agentId, cmd: 'event', payload }, HOOK_REPLY_TIMEOUT_MS);
  return 0;
}
