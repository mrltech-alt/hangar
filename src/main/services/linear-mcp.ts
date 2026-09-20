// Hangar's own line to Linear — spec 2026-09-16 (linear two-way) §3. JSON-RPC over plain HTTPS with
// the OAuth token Claude Code already holds.
//
// NO MODEL RUNS HERE. Listing the owner's tickets, refreshing, paging and creating a ticket all go
// through this file, and none of them spends a token of the owner's subscription — that is §2's rule,
// and the runbook states it as a promise to the user.
//
// Three standing constraints, all of them enforced here rather than by convention:
//   1. The bearer token is read per call, lives in a local, and is never written to disk, never
//      logged, and never returned to the renderer.
//   2. Only `LINEAR_TOOLS` is reachable, and `save_issue` is reached only from the create form's Save.
//   3. Everything that comes back was written by other people, so any of it that becomes a MESSAGE is
//      `stripUntrustedText`-cleaned and capped here (payload FIELDS are cleaned in shared/linear-issues.ts).
import { stripUntrustedText } from '../../../shared/agent-name.ts';
import type { Exec } from '../util/exec.ts';

export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
/** The version the measured handshake used. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const LINEAR_TIMEOUT_MS = 10_000;
export const KEYCHAIN_TIMEOUT_MS = 5_000;
/** How much of Linear's own words a message quotes. */
export const LINEAR_DETAIL_MAX = 300;

/**
 * The only four tools Hangar ever calls (spec §3.2), three of them read-only.
 *
 * `list_cycles` is here because a `list_issues` row carries only a `cycleId` (a uuid) and no cycle
 * NUMBER — measured — so the number on a list row can only come from mapping that id. It is the same
 * read-only tool Plan 06's triage already uses, for the same missing field.
 *
 * `list_projects` and `list_users` exist on the server and are deliberately absent: the project
 * choices a create form offers come from the owner's own recent tickets, not from a directory
 * listing of the workspace.
 */
export const LINEAR_TOOLS = ['list_issues', 'list_cycles', 'list_teams', 'save_issue'] as const;
export type LinearTool = (typeof LINEAR_TOOLS)[number];

/**
 * The tools whose TRANSPORT failures may be retried. `save_issue` is deliberately absent, and that is
 * the whole point of the set: a POST that reached Linear and whose ANSWER was lost has already created
 * the ticket, so retrying it creates a second one — the owner would find two tickets and Hangar would
 * report the id of whichever reply came back. A lost read costs a round trip and nothing else.
 */
export const RETRYABLE_TOOLS: ReadonlySet<LinearTool> = new Set<LinearTool>(['list_issues', 'list_cycles', 'list_teams']);

export type LinearErrorCode = 'LINEAR_NOT_CONNECTED' | 'LINEAR_REAUTH' | 'LINEAR_TIMEOUT' | 'LINEAR_FAILED';

/** Spec §6's first three rows, written once so the dialog, the tests and the runbook cannot drift. */
export const LINEAR_MESSAGES = {
  LINEAR_NOT_CONNECTED: "Linear isn't connected in Claude Code. Run /mcp in any agent to connect it.",
  LINEAR_REAUTH: 'Linear needs reconnecting in Claude Code — run /mcp in any agent, then try again.',
  LINEAR_TIMEOUT: "Couldn't reach Linear (timed out). Check your connection and try again.",
} as const;

/**
 * Whether the request this error describes may have TAKEN EFFECT.
 *
 * `refused` means Linear answered and said no, or nothing was sent at all — the request provably did
 * not happen. `unknown` means it was sent and the answer was lost or could not be read: a timeout, a
 * 502, a 200 whose body is not an MCP reply.
 *
 * For the three READS the distinction does not exist — ask again either way — which is exactly why
 * one code covered both for so long. For the one WRITE this application makes they are opposites:
 * `linear:createTicket` offers another Save after a refusal and sends the owner to Linear after an
 * unknown, because the second press on an unknown is what files a duplicate ticket. So the fact is
 * recorded HERE, where it is known, rather than guessed from a code in the handler.
 */
export type LinearOutcome = 'refused' | 'unknown';

/** `code` and `detail` survive `toIpcError` (src/main/ipc/errors.ts), exactly as `TriageError`'s do. */
export class LinearError extends Error {
  readonly code: LinearErrorCode;
  readonly detail?: string;
  /** See `LinearOutcome`. Defaults to `refused`, so only a site that has thought about it says otherwise. */
  readonly outcome: LinearOutcome;
  constructor(code: LinearErrorCode, message: string, detail?: string, outcome: LinearOutcome = 'refused') {
    super(message);
    this.name = 'LinearError';
    this.code = code;
    this.detail = detail;
    // A TIMEOUT is `unknown` whatever the caller passed, and that is not a convenience: there is no
    // timeout in this file that proves the request was not sent, bar the pre-send abort check in
    // `call()` — which the create path cannot reach, because it passes no signal. Deciding it here
    // rather than at five throw sites is what stops a later edit from adding a sixth that reads as
    // safe to retry simply by leaving an argument off. Over-warning costs the owner a look at
    // Linear; under-warning costs them a second ticket.
    this.outcome = code === 'LINEAR_TIMEOUT' ? 'unknown' : outcome;
  }
}

/**
 * A failure at the transport, AFTER the request went out: the answer is missing or unreadable, so
 * what Linear did with it is not known. The code stays `LINEAR_FAILED` — the dialog's message for
 * the three reads does not change, and neither does spec §6's error table — and only `outcome` is
 * different, which is the one thing the create path reads.
 */
const sentButUnreadable = (message: string): LinearError => new LinearError('LINEAR_FAILED', message, undefined, 'unknown');

/**
 * The JSON-RPC error codes decided BEFORE the method runs: the request could not be parsed, was not
 * a request, named no such method, or carried arguments the server would not take. Nothing happened,
 * so the owner may safely press Save again.
 *
 * Everything else is `unknown`, and `-32603` is why: an internal error is raised BY the method, which
 * for `save_issue` can be after the issue was written and while the answer was being built. The
 * server-defined `-32000`..`-32099` range is the same shape, and so is an error carrying no code at
 * all. Over-warning costs the owner a look at Linear; under-warning costs them a second ticket.
 */
const PRE_EXECUTION_RPC_ERRORS: ReadonlySet<number> = new Set([-32700, -32600, -32601, -32602]);

/** The smallest shape of a fetch response this file needs — so a test fakes an object, not a `Response`. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * The smallest shape of `fetch`. The platform's own `fetch` is assignable to it (a test asserts that
 * at compile time), and a fake needs four properties rather than the whole Fetch API.
 *
 * It is INJECTED rather than reached for, so nothing in this file decides which fetch the app runs
 * on. Wiring (Task 3) makes that choice: the global `fetch` Node 24 / Electron 44 already provide, or
 * Electron's own `net.fetch`, which goes through Chromium's network stack and so picks up the system
 * proxy and certificate store. Either satisfies this type; a test satisfies it with a plain object.
 */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<HttpResponse>;

export interface LinearToken {
  accessToken: string;
  /** ms epoch, or null when the entry carries none — then only a 401 can tell us it has expired. */
  expiresAt: number | null;
}

/** One display-safe line, as `linear-triage.ts`'s `displayLine`: controls and invisibles gone, whitespace collapsed, cut by code point. */
function displayLine(text: string, max: number): string {
  return Array.from(stripUntrustedText(text).replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

/**
 * The Linear entry inside Claude Code's keychain item.
 *
 * The item is one JSON object holding `claudeAiOauth` (Claude's OWN login — never touched here) and
 * `mcpOAuth`, a map keyed `"<server>|<hash>"`. The key is not the selector: the entry is chosen by
 * `serverUrl`, because a server can be registered under any name and only the URL says which service
 * the token is for. Anything malformed is null, not a throw: the caller turns null into the one
 * actionable message there is.
 */
export function findLinearToken(raw: string): LinearToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const map = (parsed as { mcpOAuth?: unknown }).mcpOAuth;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null;
  for (const value of Object.values(map as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as { serverUrl?: unknown; accessToken?: unknown; expiresAt?: unknown };
    if (entry.serverUrl !== LINEAR_MCP_URL) continue;
    if (typeof entry.accessToken !== 'string' || entry.accessToken === '') return null;
    return { accessToken: entry.accessToken, expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null };
  }
  return null;
}

/**
 * The JSON-RPC envelope out of a response body, whether it arrived as plain JSON or as SSE.
 *
 * Measured: the server answers either way for the same request. An SSE body is `event:`/`data:` lines,
 * and the answer is the first `data:` payload that is a JSON-RPC reply — a keep-alive comment or a
 * progress notification on an earlier line is skipped rather than mistaken for the answer.
 */
export function parseMcpBody(body: string): unknown | null {
  const isReply = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && ('result' in v || 'error' in v);
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isReply(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  // Two passes over the SSE body, because both shapes are legal. Linear's own answers arrive as ONE
  // `data:` line (measured), so the per-line pass runs first — it is what lets a keep-alive comment or
  // a progress notification on an earlier line be SKIPPED rather than concatenated into nonsense. Only
  // if no single line was a reply is each event's `data:` lines joined with a newline, which is how the
  // transport carries a payload that does not fit on one line.
  let current: string[] = [];
  const events: string[][] = [current];
  for (const raw of body.split('\n')) {
    // CRLF is as legal as LF here, and a stray `\r` would break both JSON.parse and the blank-line test.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      // A blank line ends the event; what follows belongs to the next one.
      current = [];
      events.push(current);
      continue;
    }
    if (!line.startsWith('data:')) continue;
    // SSE strips exactly ONE leading space after the colon. Trimming further would damage a fragment
    // of a split payload that legitimately ends or begins with a space.
    const payload = line.slice('data:'.length).replace(/^ /, '');
    current.push(payload);
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isReply(parsed)) return parsed;
    } catch {
      // Not this line's payload on its own; it may be one fragment of a multi-line one.
    }
  }
  for (const event of events) {
    if (event.length < 2) continue;
    try {
      const parsed: unknown = JSON.parse(event.join('\n'));
      if (isReply(parsed)) return parsed;
    } catch {
      // Not this event either; keep reading.
    }
  }
  return null;
}

/** A tool result's first text block — where `list_issues` puts its JSON payload (measured). */
export function toolText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return null;
}

export interface LinearMcpDeps {
  exec: Exec;
  fetch: Fetch;
  /** Main's sanitised child env — the one `security` is spawned with. */
  env: Record<string, string>;
  log: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface LinearMcp {
  /** The tool's first text block. Parsing it is `shared/linear-issues.ts`'s job, not this file's. */
  call(tool: LinearTool, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<string>;
}

export function createLinearMcp(deps: LinearMcpDeps): LinearMcp {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LINEAR_TIMEOUT_MS;
  let nextId = 1;
  /**
   * The `initialize` round trip, cached for the app run and only once it has SUCCEEDED. The measured
   * server returned no `Mcp-Session-Id`, so it is stateless and this handshake carries no session to
   * invalidate; it is sent because the transport says a client initializes first, and cached so that
   * is one round trip per app run rather than one per call. On failure the field goes back to null,
   * so the next call retries instead of replaying a rejected promise for the life of the process.
   */
  let handshake: Promise<void> | null = null;

  const failed = (detail: string, outcome: LinearOutcome = 'refused'): LinearError =>
    new LinearError('LINEAR_FAILED', `Linear rejected that: ${displayLine(detail, LINEAR_DETAIL_MAX) || 'it would not say why'}`, undefined, outcome);

  async function readToken(): Promise<LinearToken> {
    let raw: string;
    try {
      // A child process, not a keychain API: macOS's per-application prompt is answered by an
      // Apple-signed binary the item already trusts, and the read was measured to need no prompt.
      ({ stdout: raw } = await deps.exec('/usr/bin/security', ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE], { env: deps.env, timeoutMs: KEYCHAIN_TIMEOUT_MS }));
    } catch {
      // Nothing from the failure is logged: `security`'s stderr echoes what it was asked for, and the
      // only useful answer is the same either way.
      throw new LinearError('LINEAR_NOT_CONNECTED', LINEAR_MESSAGES.LINEAR_NOT_CONNECTED);
    }
    const token = findLinearToken(raw);
    if (token === null) throw new LinearError('LINEAR_NOT_CONNECTED', LINEAR_MESSAGES.LINEAR_NOT_CONNECTED);
    // Hangar does NOT refresh: rotating the refresh token would break Claude Code's own Linear
    // connection, which is the thing this feature borrows. An expired token is the owner's to renew.
    if (token.expiresAt !== null && token.expiresAt <= now()) throw new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH);
    return token;
  }

  /** One POST, with our own timeout and the caller's cancel folded into a single signal. */
  async function post(body: unknown, token: string, signal: AbortSignal | undefined): Promise<unknown> {
    const controller = new AbortController();
    // A timeout and a caller cancel are the same outcome for the user (§6's network row), so there is
    // no flag to tell them apart — both abort this controller and surface as LINEAR_TIMEOUT.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // An ALREADY-aborted signal dispatches no `abort` event, so the listener above would never fire and
    // the request would go out for a caller that has already given up. `exec.ts` guards the same trap
    // the same way. The guard inside the try then turns it into the answer rather than a request.
    if (signal?.aborted === true) controller.abort();
    let response: HttpResponse;
    let bodyText: string;
    try {
      if (controller.signal.aborted) throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
      response = await deps.fetch(LINEAR_MCP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // The BODY read is inside the timeout, not after it. Headers can arrive promptly and the body
      // never: clearing the timer first left a hanging body hanging for ever, with no timeout left to
      // abort it and the dialog spinning until the app was quit.
      bodyText = await response.text();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    // 401/403 are the one non-OK pair that is a REFUSAL: an unauthenticated request is rejected at
    // the edge and never runs, so the owner may safely retry it once they have reconnected.
    if (response.status === 401 || response.status === 403) throw new LinearError('LINEAR_REAUTH', LINEAR_MESSAGES.LINEAR_REAUTH);
    // Every other non-OK status, and every body that is not an MCP reply, is `unknown`: the request
    // was SENT. A 502 or a 504 from a proxy says nothing about whether Linear behind it did the work,
    // and an HTTP 200 carrying a proxy's HTML error page says it almost certainly did.
    if (!response.ok) throw sentButUnreadable(`Couldn't reach Linear (HTTP ${response.status}).`);
    const reply = parseMcpBody(bodyText);
    if (reply === null) throw sentButUnreadable("Linear's answer could not be read.");
    const error = (reply as { error?: { message?: unknown; code?: unknown } }).error;
    if (error !== undefined) {
      // Split by the code, not treated as one thing: see `PRE_EXECUTION_RPC_ERRORS`. The message the
      // owner reads is the same either way; only `outcome` differs, and only the create path reads it.
      const decidedBeforeRunning = typeof error.code === 'number' && PRE_EXECUTION_RPC_ERRORS.has(error.code);
      throw failed(typeof error.message === 'string' ? error.message : 'unknown error', decidedBeforeRunning ? 'refused' : 'unknown');
    }
    return (reply as { result?: unknown }).result;
  }

  /**
   * `post` with spec §3.2's one retry. A LinearError is the server's own answer and is never retried —
   * only a transport failure is, and never after the caller's own signal aborted, because the caller
   * has stopped wanting the answer.
   *
   * `retry` is false for a WRITE (see `RETRYABLE_TOOLS`): a transport failure says the answer was lost,
   * not that the request was, so retrying `save_issue` risks a second ticket.
   */
  async function send(body: unknown, token: string, signal: AbortSignal | undefined, retry: boolean): Promise<unknown> {
    const attempts = retry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await post(body, token, signal);
      } catch (e) {
        if (e instanceof LinearError) throw e;
        if (signal?.aborted === true || attempt === attempts - 1) throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
  }

  /**
   * A tool-level refusal is an HTTP 200 with a normal `result` carrying `isError` and the reason as
   * text — NOT a JSON-RPC `error`. Measured: `list_cycles` with an unrecognised `limit` came back
   * exactly this way. A caller that reads the text without checking this reads a refusal as an answer.
   */
  function resultError(result: unknown): string | null {
    if (typeof result !== 'object' || result === null) return null;
    if ((result as { isError?: unknown }).isError !== true) return null;
    return toolText(result) ?? 'unknown error';
  }

  /**
   * The handshake is sent with NO caller signal. It is cached for every later call, so letting the
   * first caller's cancel abort it made one dialog closing fail the next caller with LINEAR_TIMEOUT.
   * Its own `timeoutMs` still bounds it, so it cannot hang.
   */
  function initialize(token: string): Promise<void> {
    handshake ??= send({
      jsonrpc: '2.0', id: nextId++, method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'hangar', version: '1' } },
    }, token, undefined, true).then((result) => {
      // A handshake can be refused the same way a tool call can, and an unchecked refusal here would
      // be CACHED as a success for the life of the app run.
      const refusal = resultError(result);
      if (refusal !== null) throw failed(refusal);
      // The server answers with the version it will actually speak. A mismatch is logged rather than
      // fatal: the measured server echoed ours, and failing hard on a future bump would take the whole
      // feature down, where a log line explains an unrecognised tool call if one ever follows.
      const version = typeof result === 'object' && result !== null ? (result as { protocolVersion?: unknown }).protocolVersion : undefined;
      if (typeof version === 'string' && version !== MCP_PROTOCOL_VERSION) {
        deps.log(`initialize: server speaks MCP ${displayLine(version, 40)}, we asked for ${MCP_PROTOCOL_VERSION}`);
      }
    }).catch((e: unknown) => {
      handshake = null;
      throw e;
    });
    return handshake;
  }

  return {
    async call(tool, args, opts = {}) {
      // Before the keychain is touched, let alone the network: an unlisted tool is a Hangar bug, and
      // the allow-list is what makes "only these four tools are reachable" true rather than intended.
      if (!LINEAR_TOOLS.includes(tool)) {
        throw new LinearError('LINEAR_FAILED', 'Hangar tried to use a Linear tool it is not allowed to use.', tool);
      }
      // A caller that has already given up gets nothing spawned and nothing sent — not the keychain
      // read, not the handshake, not the request.
      if (opts.signal?.aborted === true) throw new LinearError('LINEAR_TIMEOUT', LINEAR_MESSAGES.LINEAR_TIMEOUT);
      const started = now();
      const token = (await readToken()).accessToken;
      await initialize(token);
      const result = await send(
        { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } },
        token,
        opts.signal,
        RETRYABLE_TOOLS.has(tool),
      );
      // Checked before the text is read, or a refusal reads as an empty answer.
      const refusal = resultError(result);
      if (refusal !== null) throw failed(refusal);
      const text = toolText(result);
      // Also `unknown`, and for the same reason as the unreadable body above: the tool RAN — this is
      // a JSON-RPC success with a result — and only its text is missing.
      if (text === null) throw sentButUnreadable('Linear answered with nothing to read.');
      // The tool name and a duration. Never the arguments (a ticket description) and never the token.
      deps.log(`${tool}: ${text.length} bytes in ${now() - started} ms`);
      return text;
    },
  };
}
