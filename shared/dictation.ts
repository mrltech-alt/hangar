// Dictation — spec 2026-09-18 §4. Pure: no IPC, no React, no Node (Rule 9).
//
// The ONE place that knows the helper's protocol (`mac/dictate/main.swift`) and every sentence a
// dictation shows the user. Main (`src/main/services/dictation.ts`) owns the process: it feeds the
// helper's stdout through `createDictationParser` and drives `dictationReducer` with what it sees and
// what it sends. The renderer draws the button and the pill from the `DictationState` main hands it.
// Neither parses a line, decides an outcome or writes a sentence of its own, so the three cannot drift.
import { stripUntrustedText } from './agent-name.ts';

// ─── The protocol ──────────────────────────────────────────────────────────────────────────────

/** The `code` of an `error` line — exactly the four `main.swift` can emit. */
export const HELPER_ERROR_CODES = ['MIC_DENIED', 'NO_MODEL', 'NO_INPUT', 'FAILED'] as const;
export type HelperErrorCode = (typeof HELPER_ERROR_CODES)[number];

/**
 * One stdout line from the helper, validated. A `final` or an `error` is always the helper's last
 * line; a cancel ends it with no line at all.
 *
 * `message` on an error is the helper's own diagnostic, for a log. It is never shown: what the user
 * reads is `dictationMessage(code)`.
 */
export type DictationEvent =
  | { t: 'ready' }
  | { t: 'preparing' }
  | { t: 'partial'; text: string }
  | { t: 'final'; text: string }
  | { t: 'error'; code: HelperErrorCode; message: string };

/**
 * What main writes to the helper's stdin, newline-terminated because the helper reads lines. A
 * SIGTERM, or closing stdin, is also a cancel.
 */
export const HELPER_COMMANDS = { stop: 'stop\n', cancel: 'cancel\n' } as const;

function isHelperErrorCode(value: unknown): value is HelperErrorCode {
  return (HELPER_ERROR_CODES as readonly unknown[]).includes(value);
}

/**
 * One line of text → one event, or `null` for anything that is not exactly a line the helper writes:
 * blank, not JSON, JSON that is not an object, an unknown `t`, or a known `t` whose field is missing
 * or of the wrong type (an `error` whose `code` is not one of the four included). Never throws —
 * junk on stdout is ignored, and if the run then ends without a final or an error, THAT is what
 * reports it (`Dictation stopped unexpectedly.`).
 *
 * Extra fields are dropped rather than refused, so the helper can add one without breaking an app
 * that does not read it yet.
 */
export function parseDictationLine(line: string): DictationEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  switch (o.t) {
    case 'ready':
      return { t: 'ready' };
    case 'preparing':
      return { t: 'preparing' };
    case 'partial':
      return typeof o.text === 'string' ? { t: 'partial', text: o.text } : null;
    case 'final':
      return typeof o.text === 'string' ? { t: 'final', text: o.text } : null;
    case 'error':
      return isHelperErrorCode(o.code) && typeof o.message === 'string' ? { t: 'error', code: o.code, message: o.message } : null;
    default:
      return null;
  }
}

/**
 * How much of an unterminated line the parser will hold. The helper's longest line is a partial
 * carrying the whole transcript of at most 120 s of speech — a few KB — so this is only ever reached
 * by output that is not the protocol, and it bounds what that output can cost main.
 */
export const MAX_HELPER_LINE_BYTES = 1024 * 1024;

export interface DictationParser {
  /**
   * Raw stdout BYTES, exactly as the pipe delivered them (a Node `Buffer` is a `Uint8Array`). Returns
   * the events of every line this chunk completed, in order; an incomplete tail is kept for the next
   * call. Do not `setEncoding` the stream: a string is refused with a TypeError, because a chunk
   * decoded on its own has already lost any character the pipe split in two.
   */
  feed(chunk: Uint8Array): DictationEvent[];
  /**
   * The stream has ended. Parses a last line that arrived without its newline (it still has to be a
   * whole, valid line to count), then forgets it. Call it before dispatching `closed`.
   */
  end(): DictationEvent[];
}

const NEWLINE = 0x0a;
const NO_BYTES = new Uint8Array(0);

/**
 * The stdout line parser. It takes BYTES and splits them on `\n` BEFORE decoding anything, which is
 * what makes a multi-byte character split across chunks safe: in UTF-8 every byte of a multi-byte
 * sequence is ≥ 0x80, so 0x0A is only ever a newline, and a line is decoded only once all of its
 * bytes are here. There is no decoder state carried between chunks to get wrong.
 *
 * Invalid UTF-8 decodes to U+FFFD rather than throwing (the decoder is not `fatal`). An unterminated
 * tail that grows past `maxLineBytes` is dropped, and so is everything after it up to the next
 * newline, so the remains of a discarded line can never be mistaken for a line of their own. (A line
 * that arrives whole in one chunk is parsed however long it is, as `host-protocol.ts`'s parser does:
 * the cap bounds what is HELD, and refusing a complete line would be the worst thing it could do.)
 */
export function createDictationParser(maxLineBytes: number = MAX_HELPER_LINE_BYTES): DictationParser {
  const decoder = new TextDecoder('utf-8');
  let pending: Uint8Array = NO_BYTES;
  let discarding = false;

  const parseInto = (bytes: Uint8Array, events: DictationEvent[]): void => {
    const event = parseDictationLine(decoder.decode(bytes));
    if (event) events.push(event);
  };

  return {
    feed(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('createDictationParser().feed takes the raw stdout bytes; do not setEncoding the stream');
      }
      const events: DictationEvent[] = [];
      let buf = chunk;
      if (pending.length > 0) {
        buf = new Uint8Array(pending.length + chunk.length);
        buf.set(pending);
        buf.set(chunk, pending.length);
      }
      let start = 0;
      for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
        if (discarding) discarding = false;
        else parseInto(buf.subarray(start, nl), events);
        start = nl + 1;
      }
      // A copy, not a view: a view would pin the caller's whole chunk for as long as the tail waits.
      pending = discarding || start === buf.length ? NO_BYTES : new Uint8Array(buf.subarray(start));
      if (pending.length > maxLineBytes) {
        pending = NO_BYTES;
        discarding = true;
      }
      return events;
    },
    end() {
      const events: DictationEvent[] = [];
      if (!discarding && pending.length > 0) parseInto(pending, events);
      pending = NO_BYTES;
      discarding = false;
      return events;
    },
  };
}

// ─── The words ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every outcome that is not text to write. The helper's four codes, plus three only main can see:
 * an empty final, a helper that is not there, and a helper that ended without saying how.
 */
export type DictationErrorCode = HelperErrorCode | 'NOT_BUILT' | 'CRASHED';
/**
 * Every sentence `dictationMessage` can say: the outcomes above, plus the two reasons the mic button
 * cannot START a run — which are not outcomes (nothing ran), so they are not `DictationErrorCode`s —
 * `COPIED`, the one outcome that is neither text typed nor an error (see `DictationOutcome`), and
 * `BUSY`, main refusing a start (`dictationRefusal`).
 */
export type DictationMessageCode = DictationErrorCode | 'NOTHING_HEARD' | 'NOT_RUNNING' | 'ELSEWHERE' | 'COPIED' | 'BUSY';

/**
 * Spec §4's error table, verbatim. `FAILED` has no row of its own there: it is the helper failing in
 * a way the user cannot act on (the analyzer would not start, the transcriber stopped, macOS is older
 * than 26), which is the "helper crashes" row, so it reads the same sentence.
 *
 * The last two are Hangar's own, because the spec names the case and gives no words. `NOT_RUNNING`
 * is its last row ("No focused pane with a session — the button is disabled, with a tooltip saying
 * why"). `ELSEWHERE` is the single-flight rule seen from a second pane: only one run is alive
 * app-wide, so while another agent is being dictated to this pane's button cannot start one. Both
 * are the mic button's tooltip AND ⌘D's toast — a key cannot be disabled, so it says the same thing
 * out loud instead.
 *
 * `COPIED` is Hangar's too: the transcript arrived while the agent was showing a permission prompt,
 * so main put it on the clipboard rather than type it into the menu (`DictationOutcome`'s `copied`).
 * It says where the words went and what to do with them, because nothing else on screen does.
 *
 * `BUSY` is main refusing a start with `DICTATION_BUSY` — the last run has ended but its helper has
 * not exited yet (at most `EXIT_GRACE_MS`), so a press straight after one run ends can meet it. See
 * `dictationRefusal`.
 */
const DICTATION_MESSAGES: Readonly<Record<DictationMessageCode, string>> = {
  MIC_DENIED: 'Microphone access is denied. System Settings → Privacy & Security → Microphone.',
  NO_MODEL: 'Could not prepare the dictation model. Check your connection and try again.',
  NO_INPUT: 'No audio from the microphone. Check the input device in System Settings → Sound.',
  NOTHING_HEARD: 'Nothing heard.',
  NOT_BUILT: 'Dictation is not built. Run npm run build:dictate.',
  CRASHED: 'Dictation stopped unexpectedly.',
  FAILED: 'Dictation stopped unexpectedly.',
  NOT_RUNNING: 'Start the agent to dictate into it.',
  ELSEWHERE: 'Already dictating into another agent. Stop that one first.',
  COPIED: 'The agent is waiting for an answer, so your dictation was copied instead of typed. Paste it with ⌘V when you\'re ready.',
  BUSY: 'The last dictation is still finishing. Try again in a moment.',
};

export function dictationMessage(code: DictationMessageCode): string {
  return DICTATION_MESSAGES[code];
}

/**
 * What the user reads when main REFUSES a dictation request, by the IPC error's code — or `null` for
 * a code that is not dictation's to explain, which the ordinary error toast then says as it says it
 * for every request (`HOST_DOWN` is the app's one sentence for a lost host, with its banner).
 *
 * Main's own `message` on these two is written for a log (`the agent has no running session to
 * dictate into`), and the renderer's ordinary error path toasts `message` — so without this, main's
 * wording reached the screen. `NOT_RUNNING` reads as the disabled button's own tooltip, since it is
 * the same refusal arriving by the other road (a session that ended between the press and main).
 */
export function dictationRefusal(code: string): string | null {
  switch (code) {
    case 'DICTATION_BUSY':
      return dictationMessage('BUSY');
    case 'NOT_RUNNING':
      return dictationMessage('NOT_RUNNING');
    default:
      return null;
  }
}

/**
 * The mic button's tooltip in each phase, when it CAN be pressed (or, finalizing, when there is
 * nothing a press could do). The renderer appends the key (`(⌘D)`) on the focused pane only, and
 * says `dictationMessage('NOT_RUNNING' | 'ELSEWHERE')` instead when a start is impossible.
 *
 * `starting` and `preparing` say "press to cancel" because that is what `toggleRequest` makes a
 * press there — a stop before `ready` would come back as NO_INPUT.
 */
export const MIC_BUTTON_TITLES: Readonly<Record<DictationPhase, string>> = {
  idle: 'Dictate',
  starting: 'Starting dictation — press to cancel',
  preparing: 'Preparing the dictation model (first use only) — press to cancel',
  recording: 'Stop dictating',
  finalizing: 'Writing what was heard…',
};

/** The pill before the first partial arrives: capture is running, nothing has been recognised yet. */
export const PILL_LISTENING = 'Listening…';
/**
 * The pill's reminder that Escape cancels. It is the only place that says so: the pill never takes
 * focus, and the cancel lives in the terminal's own key handler, so nothing else on screen shows it.
 */
export const PILL_ESCAPE_HINT = 'Esc cancels';
/** How much of the live transcript the pill shows, in code points (the newest end). */
export const PILL_MAX_CHARS = 160;

/**
 * The pill's text: the live partial, or `PILL_LISTENING` before there is one. A long partial keeps
 * its NEWEST end — the words being spoken now are the ones that prove it is hearing you — cut on a
 * code-point boundary (G85) and marked with a leading `…`.
 */
export function pillText(partial: string, max: number = PILL_MAX_CHARS): string {
  const trimmed = partial.trim();
  if (trimmed === '') return PILL_LISTENING;
  // Pre-sliced by units before `Array.from` (G85), so a long partial is never expanded whole. A unit
  // slice can land inside a surrogate pair; the orphaned low half is dropped rather than drawn.
  let tail = trimmed.length > max * 2 ? trimmed.slice(-max * 2) : trimmed;
  const first = tail.charCodeAt(0);
  if (tail !== trimmed && first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  const chars = Array.from(tail);
  if (tail === trimmed && chars.length <= max) return trimmed;
  return `…${chars.slice(-max).join('').trimStart()}`;
}

/** A toast's worth: the renderer hands it to the ordinary toast path as it is. */
export interface DictationNotice {
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Stays until dismissed. Only where the notice is the one place the user learns where their words went. */
  sticky?: boolean;
}

/**
 * What the renderer SAYS when a run ends, or `null` for nothing at all.
 *
 * `write` needs no word — the text appearing at the prompt is the confirmation — and `cancelled` was
 * the user's own doing. The sentence is looked up from the outcome's CODE here, never read from
 * `outcome.message`: that string crossed a process boundary to get to the renderer, and the rule is
 * that no sentence the helper (or anything else) produced reaches the screen — only this table's.
 * An error code outside the table (a newer main, say) reads as the crash sentence rather than as
 * `undefined`.
 *
 * `copied` is a warning, and STICKY: the words are on the clipboard and this toast is the only thing
 * that says so. It arrives while the user is reading a permission prompt, and a toast that timed out
 * in the meantime would leave them believing the dictation was lost — or, worse, not knowing that the
 * next ⌘V pastes it.
 */
export function outcomeNotice(outcome: DictationOutcome): DictationNotice | null {
  switch (outcome.kind) {
    case 'write':
    case 'cancelled':
      return null;
    case 'nothing':
      return { level: 'info', text: dictationMessage('NOTHING_HEARD') };
    case 'copied':
      return { level: 'warn', text: dictationMessage('COPIED'), sticky: true };
    case 'error':
      return { level: 'error', text: (DICTATION_MESSAGES as Readonly<Record<string, string | undefined>>)[outcome.code] ?? dictationMessage('CRASHED') };
  }
}

// ─── The state machine ─────────────────────────────────────────────────────────────────────────

/**
 * `idle → starting → preparing → recording → finalizing → idle`. `preparing` is skipped when the
 * model is already installed (`ready` straight from `starting`), and every active phase can end in
 * `idle` early: an error line, a cancel, or the helper closing without a word.
 */
export const DICTATION_PHASES = ['idle', 'starting', 'preparing', 'recording', 'finalizing'] as const;
export type DictationPhase = (typeof DICTATION_PHASES)[number];

/** How a run ended. Exactly one of these per run, decided by whichever end arrives first. */
export type DictationOutcome =
  /** Write `text` into the pane's session, as if typed. Never followed by a newline (spec §4.3). */
  | { kind: 'write'; text: string }
  /** The user cancelled. Nothing is written and nothing is said. */
  | { kind: 'cancelled' }
  /** Audio arrived but no words: not an error, and nothing is written. */
  | { kind: 'nothing'; message: string }
  /**
   * The words went to the CLIPBOARD, not the session: when the final arrived the agent was showing a
   * permission prompt (`needs-permission`), where typed text is a menu selection — a digit or a letter
   * in the sentence would pick an option, which is starting work from a misheard sentence by another
   * route (spec §4.3). Never produced by the reducer: main turns a `write` into this at the write
   * boundary (`handlers.ts`), because only main knows the session's activity at that moment. It
   * carries no text — the transcript is on the clipboard, not on the wire.
   */
  | { kind: 'copied'; message: string }
  /** Nothing is written, and `message` says why. */
  | { kind: 'error'; code: DictationErrorCode; message: string };

/**
 * One dictation, as main tracks it and the renderer draws it. `partial` is the live transcript for
 * the pill; `outcome` on `idle` is how the LAST run ended (`null` before the first), so the renderer
 * can show its sentence, and a new `start` clears it.
 *
 * `idle` means the RUN is over, not that the helper has been reaped: a final is acted on the moment
 * it arrives, before the process has exited. Single-flight is on the process handle, in main
 * (spec §4) — never spawn a second helper just because this says `idle`.
 */
export type DictationState =
  | { phase: 'idle'; outcome: DictationOutcome | null }
  | { phase: 'starting' }
  | { phase: 'preparing' }
  | { phase: 'recording'; partial: string }
  | { phase: 'finalizing'; partial: string };

export const DICTATION_IDLE: DictationState = { phase: 'idle', outcome: null };

/** What the user can ask for. Main turns `stop`/`cancel` into `HELPER_COMMANDS`. */
export type DictationRequest = 'start' | 'stop' | 'cancel';

/**
 * Which requests each phase accepts. `stop` only once `ready` has been seen: the helper holds a stop
 * that arrives before capture starts and then ends it as NO_INPUT — the microphone blamed for the
 * user's timing (measured in Task 4). `cancel` in every active phase, including `finalizing`, where
 * it drops the transcript on its way in.
 */
const ALLOWED: Readonly<Record<DictationPhase, Readonly<Record<DictationRequest, boolean>>>> = {
  idle: { start: true, stop: false, cancel: false },
  starting: { start: false, stop: false, cancel: true },
  preparing: { start: false, stop: false, cancel: true },
  recording: { start: false, stop: true, cancel: true },
  finalizing: { start: false, stop: false, cancel: true },
};

export function isAllowed(state: DictationState, request: DictationRequest): boolean {
  return ALLOWED[state.phase][request];
}

export function isActive(state: DictationState): boolean {
  return state.phase !== 'idle';
}

/**
 * What one press of the mic button (or ⌘D) asks for. "Press again to stop" — except before `ready`,
 * where a stop would come back as NO_INPUT, so a second press there is a cancel. `null` while
 * finalizing: the stop has been sent and the transcript is on its way (Escape still cancels).
 */
export function toggleRequest(state: DictationState): DictationRequest | null {
  switch (state.phase) {
    case 'idle':
      return 'start';
    case 'starting':
    case 'preparing':
      return 'cancel';
    case 'recording':
      return 'stop';
    case 'finalizing':
      return null;
  }
}

/**
 * What main dispatches. `start`/`stop`/`cancel` as it acts on them (the reducer refuses — returns
 * the same state — whatever `isAllowed` refuses), `event` for each parsed stdout line, and `closed`
 * once per helper.
 *
 * `closed` comes from the child's `close` event, never `exit` — at `exit` stdout may still hold the
 * final — and after `parser.end()`'s events have been dispatched. `helperMissing` is for a spawn that
 * failed because the binary is not there (ENOENT), which is an unbuilt checkout, not a crash.
 */
export type DictationAction =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'event'; event: DictationEvent }
  | { type: 'closed'; helperMissing?: boolean };

/**
 * The text a final becomes when it is written into a terminal. It is TYPED into the session, so
 * every control character is a key: a CR or LF is Enter and would submit a sentence nobody has read
 * — exactly what spec §4.3 forbids — and ESC, ^C or ^U would act on the prompt. Controls (C0 and C1)
 * become spaces via the one shared class, whitespace runs collapse to one space and the ends are
 * trimmed. `''` means there is nothing to write.
 */
export function textToWrite(finalText: string): string {
  return stripUntrustedText(finalText).replace(/\s+/g, ' ').trim();
}

function ended(outcome: DictationOutcome): DictationState {
  return { phase: 'idle', outcome };
}

function failed(code: DictationErrorCode): DictationState {
  return ended({ kind: 'error', code, message: dictationMessage(code) });
}

function onEvent(state: DictationState, event: DictationEvent): DictationState {
  // After the end, nothing the helper says counts — least of all a final that raced a cancel.
  if (state.phase === 'idle') return state;
  switch (event.t) {
    case 'final': {
      const text = textToWrite(event.text);
      return text === '' ? ended({ kind: 'nothing', message: dictationMessage('NOTHING_HEARD') }) : ended({ kind: 'write', text });
    }
    case 'error':
      return failed(event.code);
    case 'preparing':
      return state.phase === 'starting' ? { phase: 'preparing' } : state;
    case 'ready':
      return state.phase === 'starting' || state.phase === 'preparing' ? { phase: 'recording', partial: '' } : state;
    case 'partial':
      // Each partial is the whole transcript so far, so it REPLACES. One before `ready` is dropped
      // rather than taken as proof of recording: `ready` is the one line that makes `stop` safe, and
      // the next partial carries everything this one did.
      if (state.phase === 'recording' || state.phase === 'finalizing') return { phase: state.phase, partial: event.text };
      return state;
  }
}

/**
 * The whole machine. Returns the SAME object for anything it ignores or refuses, so `prev !== next`
 * is "something changed" and `endedWith` fires exactly once per run.
 *
 * A run ends at the first of: a `final` line, an `error` line, a `cancel`, or the helper closing.
 * After that everything is ignored until the next `start` — which is why a final racing a cancel is
 * never written, and why the silent exit a cancel produces is a clean end rather than a crash.
 */
export function dictationReducer(state: DictationState, action: DictationAction): DictationState {
  switch (action.type) {
    case 'start':
      return isAllowed(state, 'start') ? { phase: 'starting' } : state;
    case 'stop':
      // `recording` is the one phase `ALLOWED` gives `stop`; the test sweep holds the two together.
      return state.phase === 'recording' ? { phase: 'finalizing', partial: state.partial } : state;
    case 'cancel':
      return isAllowed(state, 'cancel') ? ended({ kind: 'cancelled' }) : state;
    case 'event':
      return onEvent(state, action.event);
    case 'closed':
      // Still active means no final, no error and no cancel: the helper died without a word.
      if (state.phase === 'idle') return state;
      return failed(action.helperMissing === true ? 'NOT_BUILT' : 'CRASHED');
  }
}

/**
 * The outcome of the run this step ended, or `null` if it did not end one. Main writes on
 * `{ kind: 'write' }` and only then; because the reducer ignores everything after the end, this
 * returns an outcome at most once per run.
 */
export function endedWith(prev: DictationState, next: DictationState): DictationOutcome | null {
  return prev.phase !== 'idle' && next.phase === 'idle' ? next.outcome : null;
}
