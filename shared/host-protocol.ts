// Session host wire protocol — spec §8. NDJSON over a Unix socket.
//
// Client->host messages are validated with zod: the host accepts connections from any process
// running as this user, so every field crossing that boundary is untrusted. Host->client messages
// are plain TypeScript types, deliberately — they come from a binary shipped in the same commit and
// gated by the §8.3 version handshake, so clients JSON.parse and cast. Do NOT add a HostMessageSchema.
//
// Correlation: a client may set `seq` on a message; the reply echoes it as `re`. `write` and `resize`
// are the two exceptions — they have no reply, so they carry no `seq`. Use `RequestMessage` (below)
// for anything awaiting a reply, so "await a write" is a compile error rather than a 5 s timeout.
import { z } from 'zod';
import { MAX_SOCKET_PATH_LEN } from './constants.ts';

export const PROTOCOL_VERSION = 1;
/**
 * Line cap, in UTF-16 code units (what JS actually allocates) — NOT bytes. Non-ASCII content can
 * therefore occupy up to ~3x this on the wire. The cap exists to bound host memory, and memory is
 * measured in code units, so converting it to a byte count would mean re-encoding a growing
 * multi-megabyte buffer on every 64 KB chunk for no safety gain.
 */
export const MAX_LINE_CHARS = 4 * 1024 * 1024;

const id = z.string().min(1).max(200);
const cols = z.number().int().min(2).max(1000);
const rows = z.number().int().min(1).max(1000);
const seq = z.number().int().optional();

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), role: z.enum(['app', 'cli']), version: z.number().int(), clientId: z.string(), seq }),
  z.object({
    t: z.literal('spawn'),
    id,
    cwd: z.string().min(1),
    file: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cols,
    rows,
    startupCommand: z.string().optional(),
    seq,
  }),
  z.object({ t: z.literal('attach'), id, cols, rows, seq }),
  z.object({ t: z.literal('detach'), id, seq }),
  z.object({ t: z.literal('write'), id, data: z.string() }),
  z.object({ t: z.literal('resize'), id, cols, rows }),
  z.object({ t: z.literal('kill'), id, signal: z.enum(['SIGHUP', 'SIGTERM', 'SIGKILL']).optional(), seq }),
  z.object({ t: z.literal('dispose'), id, seq }),
  z.object({ t: z.literal('list'), seq }),
  z.object({ t: z.literal('cli'), agentId: id, cmd: z.enum(['event', 'rename', 'note']), payload: z.unknown(), seq }),
  z.object({ t: z.literal('shutdown'), killSessions: z.boolean(), seq }),
  z.object({ t: z.literal('ping'), seq }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Messages that get a reply. `write` and `resize` are fire-and-forget and carry no `seq`. */
export type RequestMessage = Exclude<ClientMessage, { t: 'write' } | { t: 'resize' }>;

export type CliCommand = 'event' | 'rename' | 'note';

/**
 * Every error code the host can send. Typed rather than free strings because clients branch on
 * these (Plan 02's host-client surfaces them as `HostRequestError.code`), and across five plans a
 * silently renamed code is a behaviour change no typecheck would catch.
 */
export type HostErrorCode =
  | 'EXISTS'            // spawn on an id that is already live
  | 'NOT_FOUND'         // no session with that id
  | 'SPAWN_FAILED'      // pty.spawn threw (bad cwd, missing shell)
  | 'BAD_JSON'          // line was not JSON
  | 'BAD_MESSAGE'       // JSON, but failed the schema
  | 'UNSUPPORTED'       // a message type this host build does not handle
  | 'INTERNAL'          // a handler threw
  | 'LINE_TOO_LONG'     // inbound line exceeded MAX_LINE_CHARS
  | 'FRAME_TOO_LARGE'   // outbound frame would exceed MAX_LINE_CHARS
  | 'CLIENT_TOO_SLOW';  // client stopped reading and its write buffer passed the cap

export interface SessionInfo {
  id: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
  exited: boolean;
  exitCode: number | null;
  /**
   * Signal that killed the PTY, if any — for `hangar status` and the host's own logging.
   *
   * It does NOT survive the §8.3 step 5 reconnect rebuild, contrary to what this comment used to
   * claim: §6.1's `SessionState` has no `signal` field, so `session-registry.resetFromHello` drops
   * it, and the registry ignores the third argument of `HostClientEvents.exit` for the same reason.
   * Nothing renders it. Corrected rather than adding a field nothing reads (Plan 02 Task 15 review).
   */
  signal: number | null;
  title: string;
  attached: number;
}

export type HostMessage =
  | { t: 'hello'; version: number; hostPid: number; sessions: SessionInfo[]; re?: number }
  | { t: 'spawned'; id: string; pid: number; re?: number }
  | { t: 'snapshot'; id: string; data: string; title: string; re?: number }
  | { t: 'ok'; re?: number }
  | { t: 'pong'; re?: number }
  | { t: 'sessions'; sessions: SessionInfo[]; re?: number }
  | { t: 'data'; id: string; data: string }
  | { t: 'title'; id: string; title: string }
  | { t: 'bell'; id: string }
  | { t: 'exit'; id: string; exitCode: number; signal: number | null }
  | { t: 'agentEvent'; agentId: string; cmd: CliCommand; payload: unknown; at: string }
  | { t: 'error'; id?: string; code: HostErrorCode; message: string; re?: number };

export function encode(msg: ClientMessage | HostMessage): string {
  return JSON.stringify(msg) + '\n';
}

export interface LineParser {
  push(chunk: string): void;
}

/**
 * Splits a stream into newline-terminated lines. Empty lines are ignored. Over-long lines trigger
 * onOverflow and reset the buffer.
 *
 * Two caveats for callers:
 * - `onLine` does NOT guarantee `line.length <= maxChars`. The overflow check runs on the residual
 *   buffer after complete lines are drained, so a line that arrives whole (with its newline) in one
 *   chunk is delivered however long it is. That ordering is deliberate: rejecting a complete,
 *   well-formed line is the worst thing this could do. Never size an allocation off an `onLine`
 *   string, and never treat "no overflow" as proof the line was small.
 * - After an overflow the buffer is cleared, so the tail of the discarded line arrives as a junk
 *   `onLine`. Harmless where the caller destroys the socket; worth knowing where it does not.
 */
export function createLineParser(
  handlers: { onLine: (line: string) => void; onOverflow: () => void },
  maxChars: number = MAX_LINE_CHARS,
): LineParser {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) handlers.onLine(line);
        idx = buffer.indexOf('\n');
      }
      if (buffer.length > maxChars) {
        buffer = '';
        handlers.onOverflow();
      }
    },
  };
}

/** macOS limits Unix socket paths to 104 bytes (spec G9). */
export function assertSocketPathLength(socketPath: string): void {
  // TextEncoder, not Buffer: `shared/` must stay free of Node globals (spec §5.1), and
  // tsconfig.web.json sets "types": [] so `Buffer` does not typecheck there.
  const bytes = new TextEncoder().encode(socketPath).length;
  if (bytes > MAX_SOCKET_PATH_LEN) {
    throw new Error(`socket path too long (${bytes} > ${MAX_SOCKET_PATH_LEN}): ${socketPath}`);
  }
}
