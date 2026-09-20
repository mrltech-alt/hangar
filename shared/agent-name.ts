import { AGENT_NAME_MAX } from './constants.ts';

/**
 * The single place this control-character class is defined. Four call sites had their own copy of
 * it: `hangar rename`, the `agent:update` zod schema, `cleanAgentName` below, and the
 * startup-command composer (`src/main/services/claude-launch.ts`) — which strips it from every
 * composed argument, not just the agent name, and cannot reuse `cleanAgentName` verbatim because
 * that function also trims and truncates. A narrowed class in a future edit to any one copy is
 * exactly the failure this consolidation removes: with one shared definition, a test pinning
 * membership here (see `agent-name.test.ts`) also protects the composer.
 *
 * Control characters are replaced, not merely trimmed. A name — or any composed shell argument — is
 * typed into the agent's login shell on every start, and quoting cannot contain a control byte
 * there: the line editor consumes U+0003 (send-break) or U+0015 (kill-line) before the shell parser
 * sees the opening quote, and a following carriage return then submits whatever remains as a fresh
 * command. Verified on this machine against a real PTY.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * As `stripControlChars`, but keeps `\n`. For text that is STORED and displayed rather than typed
 * into a shell — agent notes are the only such case today.
 *
 * This lives here, beside the class it narrows, precisely because the comment above warns that a
 * second private copy is the failure the consolidation removed. Newlines are the one exception worth
 * making: `hangar note --replace "$(cat plan.md)"` is a legitimate multi-line write, and flattening
 * it to a single line is a silent data change. `\r` is NOT kept — a lone CR would let a note rewrite
 * the current line when `hangar status` echoes it into a terminal.
 */
export function stripControlCharsKeepNewlines(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
}

/**
 * As `stripControlCharsKeepNewlines`, but keeps TAB as well — for MARKDOWN, which today is the Linear
 * ticket description and nothing else.
 *
 * In markdown a tab is not decoration: it opens an indented code block and it indents a nested list,
 * so spacing it out turns an owner's pasted code block into a paragraph. It is kept for the same
 * reason the newline above is, and it is safe for the same reason — this variant is only ever applied
 * to text that is shown in a textarea and sent over HTTPS, never typed into a PTY, where a tab is a
 * completion key and belongs in the stripped class.
 *
 * Written as its own narrowing of the one shared class rather than as a private copy somewhere else,
 * which is what the comment above warns against; the two helpers it sits beside are untouched.
 */
export function stripControlCharsKeepNewlinesAndTabs(value: string): string {
  // \u0009 (tab) and \u000a (newline) are the two gaps left in the range.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

/**
 * What `stripUntrustedText` removes on top of the control-character class: the C1 controls, spaced
 * like C0, then the invisible formatting characters, deleted outright.
 */
const withoutC1AndInvisibles = (value: string): string =>
  value.replace(/[\u0080-\u009f]/g, ' ').replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{E0000}-\u{E007F}]/gu, '');

/**
 * For text an untrusted party wrote and Hangar will DISPLAY — today a `claude -p` triage answer, which
 * repeats a Linear ticket anyone with access to it could have written (spec 2026-09-15 linear agent
 * §9). The control-character class above is about what a PTY line editor eats; displayed text also
 * has to lose what a terminal or a text renderer acts on:
 *
 * - **C1 controls, U+0080–U+009F**, replaced with a space as C0 is. U+009B is a one-byte CSI: in
 *   review it was measured clearing an `@xterm/headless` screen when followed by `2J`.
 * - **Invisible format characters**, deleted: the Arabic letter mark U+061C, zero-width and
 *   directional marks U+200B–U+200F, embeddings and overrides U+202A–U+202E, the word joiner and
 *   invisible operators U+2060–U+2064, isolates U+2066–U+2069, the zero-width no-break space U+FEFF,
 *   and the tag characters U+E0000–U+E007F. They draw nothing, so they let one string pass for
 *   another — U+202E reverses what follows — and `AgentNameSchema` accepts every one of them. Tag
 *   characters are worse than invisible: each mirrors an ASCII character, so a ticket can carry
 *   whole sentences a reader cannot see and a model reading the notes back (`hangar status`) can.
 *   Deleted rather than spaced because nothing visible was there. Two costs, accepted: U+200D goes,
 *   so an emoji ZWJ sequence comes out as its separate emoji, and the tag characters go, so a
 *   subdivision flag such as Scotland's comes out as a plain black flag.
 * - **U+2028/U+2029 are left alone** — measured harmless in `@xterm/headless`, and `\s` already
 *   collapses them in one-line text.
 *
 * The two helpers above are deliberately left as they are: `hangar rename`, the startup-command
 * composer and project actions depend on exactly that class, and `agent-name.test.ts` pins it.
 */
export function stripUntrustedText(value: string): string {
  return withoutC1AndInvisibles(stripControlChars(value));
}

/** As `stripUntrustedText`, but keeps `\n`, as `stripControlCharsKeepNewlines` does — for notes. */
export function stripUntrustedTextKeepNewlines(value: string): string {
  return withoutC1AndInvisibles(stripControlCharsKeepNewlines(value));
}

/**
 * As `stripUntrustedTextKeepNewlines`, but keeps TABS too — for markdown. See
 * `stripControlCharsKeepNewlinesAndTabs` for why a tab is kept and why that is safe here.
 */
export function stripUntrustedTextKeepNewlinesAndTabs(value: string): string {
  return withoutC1AndInvisibles(stripControlCharsKeepNewlinesAndTabs(value));
}

/**
 * The single place an agent name is sanitised: strip, then trim, then truncate.
 *
 * `.trim()` does not touch interior control characters, so `stripControlChars` must run first
 * (spec §16).
 *
 * Truncation is by code point, not UTF-16 code unit: slicing 60 emoji at `AGENT_NAME_MAX` units
 * would leave a lone surrogate, which renders as U+FFFD and is invalid UTF-8 when typed into a PTY.
 */
export function cleanAgentName(raw: string): string {
  const stripped = stripControlChars(raw).trim();
  return Array.from(stripped).slice(0, AGENT_NAME_MAX).join('').trim();
}

/** True if `raw` is already a legal agent name — for zod's `.refine`, where mutation is not wanted. */
export function isCleanAgentName(raw: string): boolean {
  return raw.length > 0 && cleanAgentName(raw) === raw;
}
