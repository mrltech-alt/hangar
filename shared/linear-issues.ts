// What Linear's MCP answers become before anything draws them — spec 2026-09-16 §3.3, §4, §5. Pure.
//
// Every field here was written by somebody else, so nothing is trusted: strings are
// `stripUntrustedText`-cleaned and capped, a state name is classified by code, a URL has to be a link
// to the ticket it claims to be, and a row whose identifier is not an identifier is dropped. A
// malformed payload is an empty list, never a throw — the dialog shows a line and keeps working.
import { z } from 'zod';
import { stripUntrustedText, stripUntrustedTextKeepNewlinesAndTabs } from './agent-name.ts';
import { linearIssueUrl, parseLinearRef } from './linear-ref.ts';
import type { Agent } from './types.ts';

/** One page of `list_issues`; §4's "50 at a time with Load more". */
export const LINEAR_PAGE_SIZE = 50;
/** The wire bound on a cursor, in `ipc-schemas.ts` and in `stampCursor` — one number for both. */
export const CURSOR_MAX = 4096;
/** One page of `list_teams`. Its schema DOES take `limit` (measured from `tools/list`) — unlike `list_cycles`. */
export const TEAMS_PAGE_SIZE = 100;
/** How many recent tickets the draft prompt is calibrated on (§5). */
export const CALIBRATION_LIMIT = 20;
/** A ticket title as shown in the list. Linear allows more; a row is one line. */
export const ISSUE_TITLE_MAX = 200;
export const STATE_NAME_MAX = 40;
export const TEAM_NAME_MAX = 60;
export const PROJECT_NAME_MAX = 80;
/** A Linear id (team, cycle) as carried anywhere in this file — and what `TicketFieldsSchema` allows. */
export const TEAM_ID_MAX = 200;
/** The create form's own bounds. */
export const TICKET_TITLE_MAX = 250;
export const TICKET_DESCRIPTION_MAX = 20_000;
export const TICKET_ESTIMATE_MAX = 100;

/** Linear's own priority scale, 0-4. The form shows the labels; the wire carries the number. */
export const PRIORITY_LABELS: readonly string[] = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
/**
 * The highest priority number there is — DERIVED from the labels, and the single source for both
 * `TicketFieldsSchema` and `ticketFieldsProblem`.
 *
 * They were a literal `4` and `PRIORITY_LABELS.length - 1` written out separately, which agreed only
 * by coincidence: adding a sixth label would have made the form offer a level the wire refuses, and
 * the refusal would have been an opaque `BAD_REQUEST` in the one place this feature works hardest to
 * avoid one.
 */
export const TICKET_PRIORITY_MAX = PRIORITY_LABELS.length - 1;

/** Linear's own `statusType` values, measured, plus `unknown` for anything this build has not seen. */
export type LinearStateType = 'backlog' | 'triage' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'unknown';

export interface LinearIssue {
  /** `AC-3462`. From the payload's `id` field — see `readIdentifier`. */
  identifier: string;
  title: string;
  /** The status's display name, from `status` (`Todo`, `Design in Progress`). May be empty. */
  state: string;
  /** From `statusType`. The only thing dimming keys off. */
  stateType: LinearStateType;
  /** From `teamId`. Carried because `list_cycles` is addressed by team, not because the UI shows it. */
  teamId: string;
  /** From `team`, which is the team's NAME: `list_teams` returns no key, so there is no `AC` to show. */
  teamName: string;
  /** From `cycleId`, a uuid. The row carries no cycle NUMBER at all (measured). */
  cycleId: string | null;
  /** Filled by `withCycleNumbers` from a `list_cycles` map, or left null — then the row shows no cycle. */
  cycleNumber: number | null;
  updatedAt: string;
  /** A verified link to this ticket, or `''`. Never a link the payload merely claimed. */
  url: string;
}

/** `list_teams` returns `{ id, name, icon, visibility, createdAt, updatedAt }` — and no key (measured). */
export interface LinearTeam {
  id: string;
  name: string;
}

/** One recent ticket, as the draft prompt sees it (§5's calibration data). */
export interface CalibrationRow {
  title: string;
  estimate: number | null;
  priority: number | null;
  team: string;
  project: string;
}

/**
 * What the create form holds and `linear:createTicket` sends.
 *
 * `assigneeSelf` and `state` are fixed by the design (§5) and typed as LITERALS so no caller can spell
 * anything else: this feature files tickets for the owner, in Backlog, and nothing else. `teamId`
 * carries a team id from `list_teams`; `projectId` carries a project NAME taken from the owner's own
 * recent tickets, because Hangar never calls `list_projects` (§3.2's four-tool limit) and so has no
 * id for it — Linear's `save_issue` accepts either.
 */
export interface TicketFields {
  title: string;
  description: string;
  estimate: number | null;
  priority: number | null;
  teamId: string | null;
  projectId: string | null;
  assigneeSelf: true;
  state: 'Backlog';
}

export const TicketFieldsSchema = z.object({
  title: z.string().min(1).max(TICKET_TITLE_MAX),
  description: z.string().max(TICKET_DESCRIPTION_MAX),
  estimate: z.number().int().min(0).max(TICKET_ESTIMATE_MAX).nullable(),
  priority: z.number().int().min(0).max(TICKET_PRIORITY_MAX).nullable(),
  teamId: z.string().min(1).max(TEAM_ID_MAX).nullable(),
  projectId: z.string().min(1).max(PROJECT_NAME_MAX).nullable(),
  assigneeSelf: z.literal(true),
  state: z.literal('Backlog'),
});

export const emptyTicketFields = (): TicketFields => ({
  title: '', description: '', estimate: null, priority: null, teamId: null, projectId: null, assigneeSelf: true, state: 'Backlog',
});

const oneLine = (s: string, max: number): string => Array.from(stripUntrustedText(s).replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Code points, not UTF-16 units — measured on zod 4.5: `z.string().max(250)` accepts 250 emoji (500
 * units) and rejects 4 code points, so every length this file enforces has to be counted the same way
 * as `TicketFieldsSchema` counts it or the form and the schema disagree. Slicing units would also cut
 * a surrogate pair in half.
 */
const countChars = (s: string): number => Array.from(s).length;

const capChars = (s: string, max: number): string => Array.from(s).slice(0, max).join('');

/**
 * A ticket title as this application shows it, checks it and SENDS it — one rule, used everywhere.
 *
 * A title is one line, so `oneLine` is the whole of it: control characters spaced, C1 controls and
 * invisible formatting characters removed (a U+202E reverses everything after it, a zero-width space
 * makes one title pass for another), whitespace collapsed, and capped by code point.
 *
 * Exported and used by `saveIssueArgs` because the title goes OUT of Hangar into a ticket other
 * people read, and until Task 7 flagged it the only thing that ever cleaned it was the renderer's
 * form — the same dependency `linear:draftTicket` removed for the drafted description.
 */
export const cleanTicketTitle = (title: string): string => oneLine(title, TICKET_TITLE_MAX);

/**
 * A ticket description, by the same rule: cleaned, capped, but with its NEWLINES AND TABS kept — it
 * is markdown, where both are structure. Flattening the newlines would be a silent data change, and
 * spacing out the tabs turned a pasted indented code block into a paragraph, which is the same
 * change one level down. Safe here for the reason `stripControlCharsKeepNewlinesAndTabs` gives: this
 * text reaches a textarea and Linear, never a shell.
 *
 * `.trimEnd()` after the cap, not only the `.trim()` before it, because this runs more than once on
 * the same text — at the IPC boundary and again in the form — and capping a trimmed string can cut
 * inside a run of spaces and leave a trailing one for the next pass to remove. Without it a 20 000
 * character description came back one character shorter each time it was cleaned.
 */
export const cleanTicketDescription = (description: string): string =>
  capChars(stripUntrustedTextKeepNewlinesAndTabs(description).trim(), TICKET_DESCRIPTION_MAX).trimEnd();

/**
 * A model's number as something `TicketFieldsSchema` accepts, or null. A fraction is rounded — `3.4`
 * story points is a usable 3 — but anything outside the range is DROPPED rather than clamped: an
 * estimate of 999999.5 is not a 100-point ticket, it is an answer to throw away, and leaving the
 * field empty says so to the owner, who can still type one.
 */
const boundedInt = (value: number, max: number): number | null => {
  const rounded = Math.round(value);
  return Number.isFinite(rounded) && rounded >= 0 && rounded <= max ? rounded : null;
};

/**
 * `statusType`, mapped to the closed set this build understands. Measured values are `completed`,
 * `canceled`, `started`, `unstarted`, `backlog` and `triage`.
 *
 * Anything else — a value Linear adds later, a workspace with a type this build has not seen — is
 * `unknown`, and `unknown` renders NORMALLY. Guessing from the display name was the earlier design and
 * is deliberately gone: it would dim a workflow state called "Complete when merged" that is still
 * live work, and the machine type is right here in the payload.
 */
export function classifyStatusType(raw: unknown): LinearStateType {
  const type = asString(raw).toLowerCase();
  if (type === 'backlog' || type === 'triage' || type === 'unstarted' || type === 'started' || type === 'completed' || type === 'canceled') return type;
  // Linear's own spelling is the single-l `canceled`; accept the other in case a workspace differs.
  if (type === 'cancelled') return 'canceled';
  return 'unknown';
}

/**
 * The ticket's human identifier.
 *
 * **Measured: `list_issues` puts it in `id`** (`"AC-3462"`), with the UUID under `uuid`.
 * `parseLinearRef` is the gate — it is already what decides what a ticket reference is — so a payload
 * that one day puts a UUID in `id` yields null here and the row is dropped rather than drawn as one.
 */
function readIdentifier(row: Record<string, unknown>): string | null {
  for (const key of ['id', 'identifier']) {
    const ref = parseLinearRef(asString(row[key]));
    if (ref !== null) return ref;
  }
  return null;
}

const isRow = (r: unknown): r is Record<string, unknown> => typeof r === 'object' && r !== null;

const rowsOf = (payload: unknown, keys: readonly string[]): Record<string, unknown>[] => {
  if (typeof payload !== 'object' || payload === null) return [];
  for (const key of keys) {
    const found = (payload as Record<string, unknown>)[key];
    if (Array.isArray(found)) return found.filter(isRow);
  }
  return [];
};

/**
 * As `rowsOf`, but a BARE ARRAY is rows too. `list_cycles` answers with one and `list_teams` with
 * `{teams}` (both measured), and a reader that knows only its own shape is one server change away
 * from an empty list — the tolerance is a line and costs nothing.
 */
const rowsOfAny = (payload: unknown, keys: readonly string[]): Record<string, unknown>[] =>
  (Array.isArray(payload) ? payload.filter(isRow) : rowsOf(payload, keys));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * The cursor for the next page. Measured: the payload's top level is exactly `issues`, `hasNextPage`
 * and `cursor` — no `pageInfo`, no `nextCursor`. The cursor is offered only when `hasNextPage` is
 * true, so a stale cursor on the last page cannot leave a `Load more` button that fetches nothing.
 */
function readCursor(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { cursor, hasNextPage } = payload as { cursor?: unknown; hasNextPage?: unknown };
  if (hasNextPage !== true) return null;
  return typeof cursor === 'string' && cursor !== '' ? cursor : null;
}

export function parseIssuesPayload(text: string): { issues: LinearIssue[]; nextCursor: string | null } {
  const payload = parseJson(text);
  const issues: LinearIssue[] = [];
  for (const row of rowsOf(payload, ['issues', 'nodes'])) {
    const identifier = readIdentifier(row);
    if (identifier === null) continue;
    issues.push({
      identifier,
      title: oneLine(asString(row.title), ISSUE_TITLE_MAX),
      // `status`, not `state`: there is no `state` field on a list row (measured).
      state: oneLine(asString(row.status), STATE_NAME_MAX),
      stateType: classifyStatusType(row.statusType),
      teamId: oneLine(asString(row.teamId), TEAM_ID_MAX),
      // `team` IS the name. `list_teams` returns no key, so there is no short form to prefer.
      teamName: oneLine(asString(row.team), TEAM_NAME_MAX),
      // A uuid, not a number — the number comes later, from `list_cycles`, or not at all.
      cycleId: oneLine(asString(row.cycleId), TEAM_ID_MAX) || null,
      cycleNumber: null,
      updatedAt: oneLine(asString(row.updatedAt), 40),
      url: linearIssueUrl(oneLine(asString(row.url), 2048), identifier) ?? '',
    });
  }
  return { issues, nextCursor: readCursor(payload) };
}

/**
 * `list_teams` takes `limit` and `cursor` — measured from `tools/list`, whose parameters for this tool
 * are cursor, includeArchived, limit, orderBy, query, updatedAt. `list_cycles` is the one that REFUSES
 * `limit`; the two tools do not share a schema, and the difference was measured rather than assumed.
 */
export function listTeamsArgs(cursor: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = { limit: TEAMS_PAGE_SIZE };
  if (cursor !== null) args.cursor = cursor;
  return args;
}

/**
 * The teams, and the cursor for the next page when the payload offers one.
 *
 * The measured payload is `{ teams, hasNextPage }` with no cursor beside it, so `nextCursor` is
 * normally null and the caller stops after one page. It is read the same way `parseIssuesPayload`
 * reads it — one rule for both — so a workspace with more teams than a page pages properly if the
 * server ever does send one, rather than silently losing every team after the first hundred.
 */
export function parseTeamsPayload(text: string): { teams: LinearTeam[]; nextCursor: string | null } {
  const payload = parseJson(text);
  const teams: LinearTeam[] = [];
  for (const row of rowsOfAny(payload, ['teams', 'nodes'])) {
    const id = oneLine(asString(row.id), TEAM_ID_MAX);
    if (id === '') continue;
    teams.push({ id, name: oneLine(asString(row.name), TEAM_NAME_MAX) });
  }
  return { teams, nextCursor: readCursor(payload) };
}

/**
 * `list_cycles` is addressed by team, and its rows are what turn a `cycleId` into `cycle 32`.
 *
 * `{ teamId }` and nothing else. Measured: the tool's schema requires `teamId` and otherwise accepts
 * only `type` (`current | previous | next`); **`limit` is REJECTED** — `{teamId, limit: 3}` came back
 * as a tool error reading `Unrecognized key: "limit"`. So there is no page size to set and no cursor
 * to follow, and adding either would break every cycle number in the list.
 */
export const listCyclesArgs = (teamId: string): Record<string, unknown> => ({ teamId });

/**
 * One cycle, as the picker shows it.
 *
 * `teamId`/`teamName` are NOT in the payload — `list_cycles` is addressed BY team and says nothing
 * about which one answered — so they are filled by the caller that knew which team it asked. They
 * exist because two teams can both have a "cycle 3", and a picker listing both needs to say which.
 */
export interface LinearCycle {
  id: string;
  number: number;
  /** ISO, or `''` when the payload carried none. */
  startsAt: string;
  endsAt: string;
  isCurrent: boolean;
  teamId: string;
  teamName: string;
}

/**
 * Measured: this one answers with a **bare JSON array**, newest first, not an object with a `cycles`
 * member — each element `{ id, number, startsAt, endsAt, isCurrent }` plus four long history arrays
 * that are read and dropped here rather than carried anywhere. The `{cycles}`/`{nodes}` branch below
 * is a tolerance for the shape changing, not a description of what it sends today.
 *
 * The dates and `isCurrent` are kept as of Plan 08: the cycle PICKER labels a row
 * `Cycle 33 · 28 Sep – 12 Oct (current)`, and those are the only three fields that can say so. The
 * result is still a superset of `{id, number}`, which is what keeps `linear:myIssues`' own
 * `cycleId -> number` map reading exactly as it did.
 */
export function parseCyclesPayload(text: string): LinearCycle[] {
  const cycles: LinearCycle[] = [];
  for (const row of rowsOfAny(parseJson(text), ['cycles', 'nodes'])) {
    const id = oneLine(asString(row.id), TEAM_ID_MAX);
    const number = asNumber(row.number);
    if (id === '' || number === null) continue;
    cycles.push({
      id,
      number,
      // A date is shown, never parsed for logic beyond formatting, so it is cleaned and capped like
      // every other string here rather than validated as a date.
      startsAt: oneLine(asString(row.startsAt), 40),
      endsAt: oneLine(asString(row.endsAt), 40),
      isCurrent: row.isCurrent === true,
      teamId: '',
      teamName: '',
    });
  }
  return cycles;
}

/**
 * Fills `cycleNumber` from a `cycleId -> number` map. A cycle the map does not know keeps `null`, and
 * the row then simply shows no cycle — §4's row is better without the field than wrong about it.
 */
export function withCycleNumbers(issues: readonly LinearIssue[], numbers: ReadonlyMap<string, number>): LinearIssue[] {
  return issues.map((i) => (i.cycleId !== null && numbers.has(i.cycleId) ? { ...i, cycleNumber: numbers.get(i.cycleId)! } : i));
}

/** `save_issue`'s answer, as much of it as the toast and the offer need. */
export function parseCreatedIssue(text: string): { identifier: string; url: string } | null {
  const payload = parseJson(text);
  if (typeof payload !== 'object' || payload === null) return null;
  const inner = (payload as { issue?: unknown }).issue;
  const row = (typeof inner === 'object' && inner !== null ? inner : payload) as Record<string, unknown>;
  const identifier = readIdentifier(row);
  if (identifier === null) return null;
  return { identifier, url: linearIssueUrl(oneLine(asString(row.url), 2048), identifier) ?? '' };
}

export function parseCalibrationRows(text: string): CalibrationRow[] {
  // `team` and `project` are plain NAME strings on a list row (measured), and `estimate`/`priority`
  // are plain numbers — so this reads the same rows `parseIssuesPayload` does, for different fields.
  return rowsOf(parseJson(text), ['issues', 'nodes']).slice(0, CALIBRATION_LIMIT).map((row) => ({
    title: oneLine(asString(row.title), ISSUE_TITLE_MAX),
    estimate: asNumber(row.estimate),
    priority: asNumber(row.priority),
    team: oneLine(asString(row.team), TEAM_NAME_MAX),
    project: oneLine(asString(row.project), PROJECT_NAME_MAX),
  }));
}

/**
 * §4: everything assigned to the owner, most recently updated first, a page at a time.
 *
 * `orderBy: 'updatedAt'` returns newest first on its own (measured 2026-09-16: 17:02, 12:54, 09:52).
 * There is no direction parameter to send and none is sent.
 */
export function listIssuesArgs(cursor: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = { assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE };
  if (cursor !== null) args.cursor = cursor;
  return args;
}

/**
 * The same list, narrowed to one cycle — spec 2026-09-17 §3 step 3.
 *
 * `cycle` takes the cycle's UUID (measured: `list_issues` has a `cycle` parameter and the id on a
 * row is `cycleId`, a uuid). A sibling of `listIssuesArgs` rather than a parameter on it: these two
 * requests answer different questions, and one function with a flag is how an edit meant for the
 * cycle list changes what the ⌘⇧L list asks for.
 */
export function listCycleIssuesArgs(cycleId: string, cursor: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = { cycle: cycleId, assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE };
  if (cursor !== null) args.cursor = cursor;
  return args;
}

/**
 * The cursor Hangar hands the renderer: Linear's own opaque string with the generation of the cache
 * it belongs to in front of it, `<generation>:<cursor>`.
 *
 * It exists because `Load more` and `Refresh` are one click apart, and either order used to corrupt
 * the list. A cursor is a position in ONE chain of pages; a refresh starts another. Stamping lets the
 * handler recognise a cursor from a chain it has abandoned — the button still on screen from before
 * the refresh — and ignore it, instead of splicing that chain's next page into the new list. The
 * renderer never reads it: it hands back whatever it was given, exactly as it does with Linear's own.
 */
export function stampCursor(generation: number, cursor: string | null): string | null {
  if (cursor === null) return null;
  const stamped = `${generation}:${cursor}`;
  // A cursor so long that stamping breaks the wire bound is dropped rather than handed back
  // unusable: no `Load more` is a better answer than one that can only come back as BAD_REQUEST.
  return stamped.length > CURSOR_MAX ? null : stamped;
}

/** The other half of `stampCursor`. Null for anything this process did not stamp. */
export function parseStampedCursor(text: string): { generation: number; cursor: string } | null {
  // The FIRST colon: Linear's own cursor is opaque and may well contain one of its own.
  const at = text.indexOf(':');
  if (at <= 0 || at === text.length - 1) return null;
  const generation = text.slice(0, at);
  if (!/^\d{1,9}$/.test(generation)) return null;
  return { generation: Number(generation), cursor: text.slice(at + 1) };
}

export const isDoneOrCancelled = (issue: LinearIssue): boolean => issue.stateType === 'completed' || issue.stateType === 'canceled';

/** §4: a plain substring over identifier, title and state. No request, no fuzzy matching. */
export function filterIssues(issues: readonly LinearIssue[], query: string): LinearIssue[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...issues];
  return issues.filter((i) => `${i.identifier} ${i.title} ${i.state}`.toLowerCase().includes(q));
}

/**
 * §4's "an agent already exists for this ticket": an agent whose NAME STARTS with the identifier at a
 * word boundary. That is exactly the shape `composeAgentName` produces (`AC-3461 0 click payments`),
 * and the boundary is what stops `AC-346` from claiming `AC-3461` — and `AC-3461` from claiming
 * `AC-34610`. A mention INSIDE a name is not a match: an agent called `Rewrite AC-77` is about
 * something else, and focusing it instead of reading the ticket would be the wrong answer.
 */
export function agentForIssue(agents: readonly Agent[], identifier: string): Agent | undefined {
  const lower = identifier.toLowerCase();
  return agents.find((a) => {
    const name = a.name.toLowerCase();
    if (!name.startsWith(lower)) return false;
    const rest = name.slice(lower.length);
    // The next CODE POINT, so an astral letter is a letter rather than a lone surrogate that tests as
    // punctuation. `\p{L}\p{N}\p{M}` and the hyphen are all non-boundaries: `AC-34` must not claim
    // `AC-34-5 …` (Linear's own sub-ticket spelling), `AC-345 …`, `AC-34abc` or an `AC-34` followed by
    // a combining mark, which draws as a different word and would read as one.
    const next = rest === '' ? '' : String.fromCodePoint(rest.codePointAt(0)!);
    return next === '' || !/[\p{L}\p{N}\p{M}-]/u.test(next);
  });
}

/** Appends a page, keeping the first appearance of a ticket that moved between pages. */
export function mergeIssuePages(existing: readonly LinearIssue[], incoming: readonly LinearIssue[]): LinearIssue[] {
  const seen = new Set(existing.map((i) => i.identifier));
  return [...existing, ...incoming.filter((i) => !seen.has(i.identifier))];
}

const isEmptyField = (value: string | number | null): boolean => value === null || (typeof value === 'string' && value.trim() === '');

/**
 * §5: the draft "fills the empty fields and leaves anything the owner has already typed alone".
 *
 * The title is not in here at all — the owner types it to run the draft, so there is nothing for the
 * model to fill and nothing of theirs for it to overwrite.
 */
export type DraftedTicketFields = Partial<Pick<TicketFields, 'description' | 'estimate' | 'priority' | 'teamId' | 'projectId'>>;

export function mergeTicketFields(current: TicketFields, drafted: DraftedTicketFields): TicketFields {
  const next = { ...current };
  // The same helper `saveIssueArgs` cleans with, so the text the owner is shown in the form and the
  // text Linear is sent cannot be cleaned by two different rules.
  if (isEmptyField(next.description) && drafted.description !== undefined) next.description = cleanTicketDescription(drafted.description);
  if (next.estimate === null && drafted.estimate !== undefined && drafted.estimate !== null) next.estimate = boundedInt(drafted.estimate, TICKET_ESTIMATE_MAX);
  if (next.priority === null && drafted.priority !== undefined && drafted.priority !== null) next.priority = boundedInt(drafted.priority, 4);
  // The ids get the same cleaning every other model-written string in this build gets: a schema-shaped
  // answer still carries whatever text the model put in it, and these two go on to the form, to
  // `saveIssueArgs` and out to Linear. Cleaned away to nothing leaves the field EMPTY rather than
  // `''`, which `TicketFieldsSchema` rejects and the form could not show as a choice anyway.
  if (next.teamId === null && drafted.teamId !== undefined && drafted.teamId !== null) next.teamId = oneLine(drafted.teamId, TEAM_ID_MAX) || null;
  if (next.projectId === null && drafted.projectId !== undefined && drafted.projectId !== null) next.projectId = oneLine(drafted.projectId, PROJECT_NAME_MAX) || null;
  return next;
}

/**
 * Every bound `TicketFieldsSchema` enforces, said in a sentence — this is the ONLY thing that stops a
 * save, and everything else on the form is optional (§5).
 *
 * The checks are here rather than left to the schema so the form can say what is wrong INLINE:
 * reaching `TicketFieldsSchema` at the IPC boundary makes an over-long title, or an estimate of 500,
 * an opaque `BAD_REQUEST` with nothing to show the owner. The `min`/`max` attributes on the form's
 * number field do not cover it either — they raise a browser bubble on a SUBMIT, and the create can
 * be reached from a plain button (`Save anyway`), where nothing validates them at all.
 *
 * Every bound is the schema's own, counted the way the schema counts it (code points — see
 * `countChars`), and read against the raw field rather than a trimmed copy, because the raw field is
 * what the schema will see.
 */
const isWholeNumberWithin = (value: number, max: number): boolean => Number.isInteger(value) && value >= 0 && value <= max;

export function ticketFieldsProblem(fields: TicketFields): string | null {
  // CLEANED, not merely trimmed: a title of nothing but invisible formatting characters is not a
  // title, and `.trim()` does not touch one — U+200B and U+202E are not whitespace to it. Untreated,
  // that string passed this check and `saveIssueArgs` then filed a ticket with an empty title.
  if (cleanTicketTitle(fields.title) === '') return 'A title is required.';
  if (countChars(fields.title) > TICKET_TITLE_MAX) return `A title is at most ${TICKET_TITLE_MAX} characters.`;
  if (countChars(fields.description) > TICKET_DESCRIPTION_MAX) return `A description is at most ${TICKET_DESCRIPTION_MAX} characters.`;
  // `Number.isInteger` rather than a range test alone: it is false for 2.5, for NaN and for Infinity,
  // and the schema rejects all four the same way. A number field hands back whatever was typed.
  if (fields.estimate !== null && !isWholeNumberWithin(fields.estimate, TICKET_ESTIMATE_MAX)) {
    return `An estimate is a whole number between 0 and ${TICKET_ESTIMATE_MAX}.`;
  }
  // The form offers priority as a five-option select, so this is unreachable from it — and it is the
  // wire's bound, which a drafted answer and a future control both have to meet.
  if (fields.priority !== null && !isWholeNumberWithin(fields.priority, TICKET_PRIORITY_MAX)) {
    return "A priority is one of Linear's five levels.";
  }
  if (fields.teamId === null) return 'Choose a team.';
  return null;
}

/**
 * `save_issue`'s arguments — **with no `id`, which is what makes it a create** (measured: `save_issue`
 * WITH an `id` edits that issue instead). The absence is structural rather than accidental:
 * `TicketFields` has no field that could become one, and a test asserts the built object has no `id`
 * key at all.
 *
 * `teamId`/`projectId` go out as `team`/`project`, which is what the tool calls them.
 */
export function saveIssueArgs(fields: TicketFields): Record<string, unknown> {
  // Cleaned here, in the one function that builds what Linear is sent, rather than in each caller:
  // this text leaves Hangar and lands in a ticket other people read, and the form that used to be
  // the only thing cleaning it is a courtesy the wire cannot depend on.
  const args: Record<string, unknown> = { title: cleanTicketTitle(fields.title) };
  const description = cleanTicketDescription(fields.description);
  if (description !== '') args.description = description;
  if (fields.estimate !== null) args.estimate = fields.estimate;
  if (fields.priority !== null) args.priority = fields.priority;
  if (fields.teamId !== null) args.team = fields.teamId;
  if (fields.projectId !== null) args.project = fields.projectId;
  args.assignee = 'me';
  args.state = fields.state;
  return args;
}
