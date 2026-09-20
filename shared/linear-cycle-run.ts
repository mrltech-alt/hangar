// The whole-cycle run's rules — spec 2026-09-17 §3–§5. Pure: no IPC, no React, no Node (Rule 9).
//
// Everything the cycle step DECIDES is here, so the component is state plus markup. That split is
// what makes the awkward half testable without a React root: which cycles are offered and in what
// order, which boxes start ticked, what the button reads, how long it will take, and what the
// summary says when the run stops early.
import { stripUntrustedText } from './agent-name.ts';
import { cycleFolderName } from './linear-draft.ts';
import { agentForIssue, isDoneOrCancelled, type LinearCycle, type LinearIssue } from './linear-issues.ts';
import type { Agent } from './types.ts';

/**
 * One repo look-up, in seconds. Measured 2026-09-17 on the owner's machine: ~33 s and ~$0.22 of
 * subscription-equivalent usage per ticket. It is the ONLY number behind the time the step quotes,
 * so a re-measurement changes the promise in one place.
 */
export const LOOKUP_SECONDS = 33;

/** §2: what the step says a run costs, before the owner starts one. */
export const LOOKUP_COST_TEXT = 'about $0.22 of subscription usage each';

/**
 * Where one ticket has got to. `waiting` is the whole list before the run starts.
 *
 * `saved` and `failed` are deliberately different states for what is the same rejected call.
 * `create-agent.ts` reports `saved: true` when the agent record was committed before the failure —
 * the agent EXISTS — and re-running that ticket would make a SECOND agent for it. So it is a row of
 * its own that `failedIdentifiers` leaves out, rather than a failure `Retry failed` would pick up.
 */
export type TicketRowState =
  | { kind: 'waiting' }
  | { kind: 'looking-up' }
  | { kind: 'creating' }
  | { kind: 'created'; name: string }
  | { kind: 'saved'; message: string }
  | { kind: 'skipped' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** Why a run ended early, or null when it simply finished. */
export type RunStop = 'cancel' | 'disk';

/** How much of a failure message a row shows. A row is one line, and the text is not ours. */
export const RUN_MESSAGE_MAX = 200;

/**
 * A row's message is somebody else's text — a model's answer, a git error, an OS message — so it is
 * cleaned before it is drawn: controls and invisibles out (`stripUntrustedText`), whitespace
 * collapsed so a newline cannot break the row out of its line, and capped in CODE POINTS (G85) so a
 * surrogate pair is never cut in half. Pre-sliced by units first, so a megabyte of error text is
 * never expanded into a million-element array.
 */
function cleanMessage(raw: string): string {
  const head = raw.length <= RUN_MESSAGE_MAX ? raw : raw.slice(0, RUN_MESSAGE_MAX * 2);
  return Array.from(stripUntrustedText(head).replace(/\s+/g, ' ').trim()).slice(0, RUN_MESSAGE_MAX).join('').trim();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const DAY_MS = 86_400_000;
const MIDDAY_MS = DAY_MS / 2;

/**
 * The instant, moved to the MIDDLE of the day it belongs to, or null for anything unparseable.
 *
 * A cycle boundary is a DATE, not a moment, and Linear stores it as the TEAM's local midnight:
 * measured, cycle 33 starts at `2026-09-28T22:00:00.000Z` for a cycle Linear itself labels 29 Sep.
 * Reading the UTC day of that instant says 28 Sep, and so does local time in London — the boundary
 * is nobody's midnight but the team's. Adding twelve hours lands inside the intended day for every
 * offset from UTC-11 to UTC+11, which is every zone a team is in, and it keeps working across the
 * DST change that moves the same boundary to 23:00Z on 26 Oct 2026, where a constant offset would
 * be a day out from then on.
 *
 * A month table and `getUTC*` rather than `toLocaleDateString`, so the label is identical on every
 * machine and a test can assert the string.
 */
function middayOf(iso: string): number | null {
  if (iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms + MIDDAY_MS;
}

const dayLabel = (midday: number): string => {
  const d = new Date(midday);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** The day a cycle STARTS: the snapped day itself. `29 Sep`, or null for no usable date. */
function startDayLabel(iso: string): string | null {
  const midday = middayOf(iso);
  return midday === null ? null : dayLabel(midday);
}

/**
 * The LAST day of a cycle — deliberately NOT the same helper as the start.
 *
 * `endsAt` is EXCLUSIVE: measured, cycle 32's `endsAt` and cycle 33's `startsAt` are the identical
 * instant (`2026-09-28T22:00:00.000Z`). Printing the snapped end day directly would end cycle 32 on
 * the day cycle 33 begins, so the label is the day BEFORE it. One shared formatter for both fields
 * is exactly the edit that would put that day back.
 */
function endDayLabel(iso: string): string | null {
  const midday = middayOf(iso);
  return midday === null ? null : dayLabel(midday - DAY_MS);
}

const NO_CYCLES: readonly LinearCycle[] = [];

/**
 * The cycle NUMBERS that more than one team offers, computed once per list.
 *
 * Memoised on the array itself because `cycleLabel` is called per row with the same list: rebuilding
 * it inside the label would be O(n²) over a list the picker re-renders. By ID, never by count — the
 * fan-out can hand the same cycle back twice, and that is one cycle, not two teams. (A list mutated
 * in place after being labelled would keep a stale answer; `sortCycles` returns a fresh array and
 * nothing here mutates one.)
 */
const ambiguousNumbers = new WeakMap<readonly LinearCycle[], ReadonlySet<number>>();

function isAmbiguous(all: readonly LinearCycle[], number: number): boolean {
  if (all.length < 2) return false;
  let shared = ambiguousNumbers.get(all);
  if (shared === undefined) {
    const idsByNumber = new Map<number, Set<string>>();
    for (const c of all) {
      const ids = idsByNumber.get(c.number) ?? new Set<string>();
      ids.add(c.id);
      idsByNumber.set(c.number, ids);
    }
    shared = new Set([...idsByNumber].filter(([, ids]) => ids.size > 1).map(([n]) => n));
    ambiguousNumbers.set(all, shared);
  }
  return shared.has(number);
}

/** The cycle's start in ms, or null when it carries no usable date. */
function startMs(cycle: LinearCycle): number | null {
  const ms = Date.parse(cycle.startsAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * §3 step 2's row: `Cycle 33 · 28 Sep – 12 Oct`, `(current)` on the current one.
 *
 * The team is appended ONLY when another offered cycle shares this number — two teams both have a
 * "cycle 3", and a picker listing both has to say which is which. Appending it always would put a
 * team name on every row of a workspace that has one team, which is noise.
 *
 * A date that will not parse drops the whole range rather than printing half of one: `Cycle 7` is
 * true, and `Cycle 7 · Invalid Date – 12 Oct` is not.
 */
export function cycleLabel(cycle: LinearCycle, all: readonly LinearCycle[] = NO_CYCLES): string {
  const parts = [`Cycle ${cycle.number}`];
  const from = startDayLabel(cycle.startsAt);
  const to = endDayLabel(cycle.endsAt);
  if (from !== null && to !== null) parts.push(`${from} – ${to}`);
  // The id is a poor label, and it is better than a row that cannot be told from the one above it.
  const team = cycle.teamName !== '' ? cycle.teamName : cycle.teamId;
  if (team !== '' && isAmbiguous(all, cycle.number)) parts.push(team);
  return `${parts.join(' · ')}${cycle.isCurrent ? ' (current)' : ''}`;
}

/**
 * Newest first by DATE, de-duplicated by ID.
 *
 * By date and not by number, because the list is a fan-out over the TEAMS the owner's tickets are
 * in and cycle numbers are per team: one team's January "cycle 33" would otherwise sit above
 * another team's September "cycle 4" and be offered as the newest thing there is. The number is the
 * tie-break, for one team's own list and for two cycles that really do start together, and a cycle
 * with no usable date sorts last rather than to the top on a NaN comparison.
 *
 * The de-duplication is by id and not by number on purpose: the same cycle arrives once per team it
 * was asked for, while two different teams' "cycle 3" are two real, different cycles that must both
 * stay.
 */
export function sortCycles(cycles: readonly LinearCycle[]): LinearCycle[] {
  const byId = new Map<string, LinearCycle>();
  for (const c of cycles) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    const at = startMs(a);
    const bt = startMs(b);
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return b.number - a.number;
  });
}

/**
 * Which cycle the picker opens on, or null when there are none.
 *
 * `isCurrent` cannot be believed on its own from either end: it is a per-TEAM flag, so a fan-out
 * over three teams brings back three rows claiming to be current, and between two cycles a team can
 * have none at all. So: the newest FLAGGED one, else the one whose window contains `now`, else
 * simply the newest. The window is half-open — `endsAt` is the exclusive boundary the next cycle
 * starts at, so the instant between two cycles belongs to the later one and never to both.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the rule is testable without a clock.
 */
export function currentCycle(cycles: readonly LinearCycle[], now: number = Date.now()): LinearCycle | null {
  const rows = sortCycles(cycles);
  if (rows.length === 0) return null;
  const flagged = rows.find((c) => c.isCurrent);
  if (flagged !== undefined) return flagged;
  const spanning = rows.find((c) => {
    const from = startMs(c);
    const to = Date.parse(c.endsAt);
    return from !== null && Number.isFinite(to) && from <= now && now < to;
  });
  return spanning ?? rows[0];
}

/**
 * §3 step 3: everything ticked, except a ticket that already has an agent and anything Done or
 * Cancelled.
 *
 * A record keyed by identifier rather than a `Set`, because React state is replaced rather than
 * mutated here and a plain object makes the "one box changed" update a one-line spread.
 */
export function initialSelection(issues: readonly LinearIssue[], agents: readonly Agent[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const issue of issues) {
    selection[issue.identifier] = !isDoneOrCancelled(issue) && agentForIssue(agents, issue.identifier) === undefined;
  }
  return selection;
}

/** `Select all` / `Select none`: every box, including the ones the defaults left off. */
export function setAll(issues: readonly LinearIssue[], on: boolean): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const issue of issues) selection[issue.identifier] = on;
  return selection;
}

/**
 * The run plan: the ticked tickets **in list order**.
 *
 * Driven by the ISSUES and filtered by the selection, never by iterating the selection object —
 * key order there is insertion order, which is the order boxes were TICKED, and §3 step 5 promises
 * the run goes down the list as the owner sees it. A key for a ticket not on the list is ignored,
 * which is what makes a stale selection from a previously chosen cycle harmless.
 */
export function selectedIdentifiers(issues: readonly LinearIssue[], selection: Readonly<Record<string, boolean>>): string[] {
  return issues.filter((i) => selection[i.identifier] === true).map((i) => i.identifier);
}

/** §2's rough time. Never "about 0 minutes": the smallest honest answer for a run with work in it is a minute. */
export function estimateText(count: number): string {
  const minutes = Math.max(1, Math.round((count * LOOKUP_SECONDS) / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * §3 step 4's line — with the folder named by `cycleFolderName`, the same function the create
 * sequence uses, so the promise and the folder that gets made cannot drift.
 *
 * Nothing ticked is its own sentence rather than `0 tickets · about 1 minute`, which quotes a
 * minute for a run that would do nothing.
 */
export function planSummary(count: number, cycleNumber: number): string {
  if (count === 0) return 'Nothing ticked';
  return `${count} ticket${count === 1 ? '' : 's'} · ${estimateText(count)} · folder "${cycleFolderName(cycleNumber)}" · agents are not started`;
}

/** §3 step 4: the button tracks the tick boxes. */
export function buttonLabel(count: number): string {
  return `Create ${count} agent${count === 1 ? '' : 's'}`;
}

/** §3 step 5 and §5's table, for one row. `waiting` says nothing: a run that has not reached it yet has no news. */
export function rowStatusText(state: TicketRowState): string {
  switch (state.kind) {
    case 'waiting': return '';
    case 'looking-up': return 'looking up…';
    case 'creating': return 'creating…';
    case 'created': return `created ${cleanMessage(state.name)}`;
    // The agent is there. Saying so first, and `not retried` last, is the whole point of the row:
    // this is the one state where running the ticket again is the wrong thing to do.
    case 'saved': return `created, then failed: ${cleanMessage(state.message)} — not retried`;
    case 'skipped': return 'skipped: agent exists';
    case 'cancelled': return 'cancelled';
    case 'failed': return `failed: ${cleanMessage(state.message)}`;
  }
}

/**
 * §3 step 7 and §5's last two rows.
 *
 * `attempted` is the size of the PLAN, not of the cycle: a run of 7 ticked out of 26 that stops
 * after 2 says "Created 2 of 7", because 7 is what the owner pressed the button for.
 */
export function runSummary(run: { created: number; attempted: number; cycleNumber: number; stopped: RunStop | null; unfinished?: number }): string {
  const tail = unfinishedClause(run.unfinished ?? 0);
  if (run.stopped === 'disk') return `Stopped: low disk. Created ${run.created} of ${run.attempted}.${tail}`;
  if (run.stopped === 'cancel') return `Stopped. Created ${run.created} of ${run.attempted}.${tail}`;
  return `Created ${run.created} of ${run.attempted} agents in "${cycleFolderName(run.cycleNumber)}"${tail}`;
}

/**
 * The `saved` rows, named in the summary.
 *
 * They are counted among the created ones — the agents exist — so without this clause the only
 * place a half-finished create is visible is a row the owner has to go looking for.
 */
function unfinishedClause(count: number): string {
  if (count <= 0) return '';
  return ` · ${count} ${count === 1 ? 'was' : 'were'} created but not finished`;
}

/**
 * What `Retry failed` re-runs: the failures, and only the failures.
 *
 * Not a skip — that ticket has an agent, and running it again would make a second one — and not a
 * `waiting` row either: a run that stopped early left those untouched, and "retry the failures" is
 * not "carry on with the rest". Nor a `saved` row, for the skip's reason exactly: that create got
 * far enough to commit an agent, so a retry would make a second one. In list order, like every
 * other plan this file builds.
 */
export function failedIdentifiers(issues: readonly LinearIssue[], rows: Readonly<Record<string, TicketRowState>>): string[] {
  return issues.filter((i) => rows[i.identifier]?.kind === 'failed').map((i) => i.identifier);
}
