import { afterEach, describe, expect, it } from 'vitest';
import {
  LOOKUP_SECONDS, RUN_MESSAGE_MAX, buttonLabel, currentCycle, cycleLabel, estimateText, failedIdentifiers,
  initialSelection, planSummary, rowStatusText, runSummary, selectedIdentifiers, setAll, sortCycles,
  type TicketRowState,
} from './linear-cycle-run.ts';
import { cycleFolderName } from './linear-draft.ts';
import type { LinearCycle, LinearIssue } from './linear-issues.ts';
import type { Agent } from './types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

/**
 * Cycle 33 as MEASURED, not as invented: Linear sends the team's local midnight, which was
 * `2026-09-28T22:00:00.000Z` (UTC+2) for a cycle Linear itself labels 29 Sep – 12 Oct, and the end
 * is the EXCLUSIVE boundary — the identical instant cycle 34 starts at.
 */
const cycle = (number: number, patch: Partial<LinearCycle> = {}): LinearCycle => ({
  id: `cy-${number}`, number, startsAt: '2026-09-28T22:00:00.000Z', endsAt: '2026-10-12T22:00:00.000Z',
  isCurrent: false, teamId: 't1', teamName: 'Acme', ...patch,
});

/** Built at run time, never typed as an escape (G51). */
const BELL = String.fromCodePoint(7);
const NL = String.fromCodePoint(10);

const issue = (identifier: string, patch: Partial<LinearIssue> = {}): LinearIssue => ({
  identifier, title: `${identifier} thing`, state: 'Todo', stateType: 'unstarted', teamId: 't1', teamName: 'Acme',
  cycleId: 'cy-33', cycleNumber: 33, updatedAt: ISO, url: '', ...patch,
});

const agent = (name: string): Agent => ({
  id: name, name, slug: name, folderId: null, sortKey: 0, notes: '',
  workspaces: [{ id: 'w', projectId: 'p1', branch: 'b', worktreePath: '/wt', baseRef: 'main', createdAt: ISO }],
  claude: { sessionId: 's', hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

describe('cycleLabel', () => {
  it('reads Cycle 33 · 29 Sep – 12 Oct, and says which one is current', () => {
    expect(cycleLabel(cycle(33))).toBe('Cycle 33 · 29 Sep – 12 Oct');
    expect(cycleLabel(cycle(33, { isCurrent: true }))).toBe('Cycle 33 · 29 Sep – 12 Oct (current)');
  });

  it('drops the date range rather than printing a broken one', () => {
    expect(cycleLabel(cycle(7, { startsAt: '', endsAt: '' }))).toBe('Cycle 7');
    expect(cycleLabel(cycle(7, { startsAt: 'not a date', endsAt: '2026-10-12T00:00:00.000Z' }))).toBe('Cycle 7');
  });

  it('names the team only when two teams offer the same cycle number', () => {
    const both = [cycle(3), cycle(3, { id: 'cy-3b', teamId: 't2', teamName: 'Platform' })];
    expect(cycleLabel(both[0]!, both)).toBe('Cycle 3 · 29 Sep – 12 Oct · Acme');
    expect(cycleLabel(both[1]!, both)).toBe('Cycle 3 · 29 Sep – 12 Oct · Platform');
    expect(cycleLabel(cycle(9), both)).toBe('Cycle 9 · 29 Sep – 12 Oct');
  });

  it('falls back to the team ID when the team has no name, rather than saying nothing', () => {
    const both = [cycle(3, { teamName: '' }), cycle(3, { id: 'cy-3b', teamId: 't2', teamName: 'Platform' })];
    expect(cycleLabel(both[0]!, both)).toBe('Cycle 3 · 29 Sep – 12 Oct · t1');
  });

  it('is not ambiguous because the SAME cycle was listed twice', () => {
    // The fan-out can repeat a cycle; two ids at one number is what means two teams.
    const twice = [cycle(3), cycle(3)];
    expect(cycleLabel(twice[0]!, twice)).toBe('Cycle 3 · 29 Sep – 12 Oct');
  });
});

describe('the dates, as Linear itself renders them', () => {
  const TZ = process.env.TZ;
  afterEach(() => { process.env.TZ = TZ; });

  it('snaps to midday, so a boundary stored as the team\'s local midnight reads as that day', () => {
    // Measured: cycle 33 starts at `2026-09-28T22:00:00.000Z` and Linear shows 29 Sep. Reading the
    // UTC day of the instant itself would say 28 Sep, and so would London local time.
    expect(cycleLabel(cycle(33))).toBe('Cycle 33 · 29 Sep – 12 Oct');
  });

  it('treats endsAt as EXCLUSIVE — a cycle ends the day before the next one starts', () => {
    // Measured: cycle 32's `endsAt` and cycle 33's `startsAt` are the identical instant.
    const boundary = '2026-09-28T22:00:00.000Z';
    const c32 = cycle(32, { startsAt: '2026-09-14T22:00:00.000Z', endsAt: boundary });
    const c33 = cycle(33, { startsAt: boundary });
    expect(cycleLabel(c32)).toBe('Cycle 32 · 15 Sep – 28 Sep');
    expect(cycleLabel(c33)).toBe('Cycle 33 · 29 Sep – 12 Oct');
  });

  it('survives the DST change, where the same boundary moves to 23:00Z', () => {
    // 25 Oct 2026 puts Europe on UTC+1, so local midnight becomes 23:00Z the day before. A constant
    // offset would be a day out from here on; the midday snap is not.
    const c = cycle(34, { startsAt: '2026-10-26T23:00:00.000Z', endsAt: '2026-11-09T23:00:00.000Z' });
    expect(cycleLabel(c)).toBe('Cycle 34 · 27 Oct – 9 Nov');
  });

  it('reads the same in every zone, including the two the snap alone cannot cover', () => {
    // `vitest.config.ts` pins TZ=UTC for the whole suite, so this is the only way the formatting is
    // genuinely pinned rather than passing because the machine happens to agree.
    //
    // The EXTREME zones are the point. A midday snap puts the instant at noon in the TEAM's zone, so
    // reading local calendar fields instead of UTC ones agrees with the right answer everywhere
    // within twelve hours of that team — measured: with `getDate()` in place of `getUTCDate()`, New
    // York, London and Tokyo all still printed `29 Sep` and this test passed while the bug was live.
    // Kiritimati (UTC+14) and Midway (UTC-11) are 12 and 13 hours from the team's UTC+2, which is
    // where the local day finally differs: they print `30 Sep` and `28 Sep` if the formatting slips.
    for (const zone of ['America/New_York', 'Europe/London', 'Pacific/Kiritimati', 'Pacific/Midway']) {
      process.env.TZ = zone;
      expect(cycleLabel(cycle(33)), zone).toBe('Cycle 33 · 29 Sep – 12 Oct');
    }
  });

  it('drops the range for a date that will not parse, in either field', () => {
    expect(cycleLabel(cycle(7, { startsAt: '', endsAt: '' }))).toBe('Cycle 7');
    expect(cycleLabel(cycle(7, { endsAt: 'not a date' }))).toBe('Cycle 7');
  });
});

describe('sortCycles', () => {
  it('is newest first and drops a cycle listed twice', () => {
    const rows = [cycle(31), cycle(33), cycle(32), cycle(33)];
    expect(sortCycles(rows).map((c) => c.number)).toEqual([33, 32, 31]);
  });

  it('keeps both when two TEAMS have the same number', () => {
    const rows = [cycle(3), cycle(3, { id: 'cy-3b', teamId: 't2', teamName: 'Platform' })];
    expect(sortCycles(rows)).toHaveLength(2);
  });

  it('is newest by DATE, so one team\'s high number cannot outrank another team\'s recent cycle', () => {
    const january = cycle(33, { id: 'cy-jan-33', teamId: 't2', startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-19T00:00:00.000Z' });
    expect(sortCycles([january, cycle(4)]).map((c) => c.id)).toEqual(['cy-4', 'cy-jan-33']);
  });

  it('puts a cycle with no usable date last, whatever its number', () => {
    // THREE rows, not two: with two, V8 calls the comparator once and only one of the two
    // null branches ever runs — measured, `return 1` and `return -1` are interchangeable there.
    const dateless = cycle(99, { id: 'cy-99', startsAt: '' });
    const january = cycle(33, { id: 'cy-jan-33', startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-19T00:00:00.000Z' });
    expect(sortCycles([dateless, january, cycle(4)]).map((c) => c.id)).toEqual(['cy-4', 'cy-jan-33', 'cy-99']);
    expect(sortCycles([january, cycle(4), dateless]).map((c) => c.id)).toEqual(['cy-4', 'cy-jan-33', 'cy-99']);
  });
});

describe('currentCycle', () => {
  const NOW = Date.parse('2026-10-01T09:00:00.000Z');

  it('is the newest cycle FLAGGED current, since the flag is per team and several can carry it', () => {
    const older = cycle(30, { id: 'cy-30', teamId: 't2', startsAt: '2026-08-17T22:00:00.000Z', endsAt: '2026-08-31T22:00:00.000Z', isCurrent: true });
    expect(currentCycle([older, cycle(33, { isCurrent: true }), cycle(32, { id: 'cy-32' })], NOW)?.id).toBe('cy-33');
  });

  it('falls back to the cycle spanning now when a gap means nothing is flagged', () => {
    const next = cycle(34, { id: 'cy-34', startsAt: '2026-10-12T22:00:00.000Z', endsAt: '2026-10-26T22:00:00.000Z' });
    expect(currentCycle([next, cycle(33)], NOW)?.id).toBe('cy-33');
  });

  it('believes the FLAG over the dates, even when the flagged cycle is over', () => {
    // Linear's own per-team flag is the answer the owner sees in Linear; a stale-looking window is
    // not a reason to overrule it. Without this, dropping the flag check entirely still passes,
    // because a flagged cycle usually spans `now` as well.
    const flaggedButOver = cycle(30, { id: 'cy-30', startsAt: '2026-08-17T22:00:00.000Z', endsAt: '2026-08-31T22:00:00.000Z', isCurrent: true });
    expect(currentCycle([cycle(33), flaggedButOver], NOW)?.id).toBe('cy-30');
  });

  it('gives the shared boundary instant to the LATER cycle, never to both', () => {
    // `endsAt` is exclusive, so the instant cycle 32 ends at is the instant cycle 33 begins.
    const boundary = Date.parse('2026-09-28T22:00:00.000Z');
    const c32 = cycle(32, { id: 'cy-32', startsAt: '2026-09-14T22:00:00.000Z', endsAt: '2026-09-28T22:00:00.000Z' });
    expect(currentCycle([c32, cycle(33)], boundary)?.id).toBe('cy-33');
    // And with the later cycle MISSING from the list, the ended one must not claim the instant
    // either: nothing spans it, so the answer is the newest cycle there is. This is the case that
    // can tell a half-open window from a closed one — with both cycles present, the later one is
    // checked first and answers the same way whichever the comparison is.
    const c34 = cycle(34, { id: 'cy-34', startsAt: '2026-10-12T22:00:00.000Z', endsAt: '2026-10-26T22:00:00.000Z' });
    expect(currentCycle([c34, c32], boundary)?.id).toBe('cy-34');
  });

  it('falls back to the newest when nothing is flagged and nothing spans now', () => {
    expect(currentCycle([cycle(32, { id: 'cy-32', startsAt: '2026-09-14T22:00:00.000Z', endsAt: '2026-09-28T22:00:00.000Z' })], NOW)?.id).toBe('cy-32');
    expect(currentCycle([cycle(33), cycle(32, { id: 'cy-32', startsAt: '2026-09-14T22:00:00.000Z', endsAt: '2026-09-28T22:00:00.000Z' })], Date.parse('2027-01-01T00:00:00.000Z'))?.id).toBe('cy-33');
  });

  it('is null for no cycles at all', () => {
    expect(currentCycle([], NOW)).toBeNull();
  });
});

describe('the tick boxes', () => {
  const issues = [issue('AC-1'), issue('AC-2', { state: 'Done', stateType: 'completed' }), issue('AC-3', { state: 'Cancelled', stateType: 'canceled' }), issue('AC-4')];

  it('ticks everything but Done, Cancelled and a ticket that already has an agent', () => {
    expect(initialSelection(issues, [agent('AC-4 something')])).toEqual({ 'AC-1': true, 'AC-2': false, 'AC-3': false, 'AC-4': false });
  });

  it('Select all and Select none move every box, including the unticked ones', () => {
    expect(setAll(issues, true)).toEqual({ 'AC-1': true, 'AC-2': true, 'AC-3': true, 'AC-4': true });
    expect(setAll(issues, false)).toEqual({ 'AC-1': false, 'AC-2': false, 'AC-3': false, 'AC-4': false });
  });

  it('keeps the LIST order, not the selection order, and ignores a box for a ticket not on the list', () => {
    expect(selectedIdentifiers(issues, { 'AC-4': true, 'AC-1': true, 'AC-9': true })).toEqual(['AC-1', 'AC-4']);
  });
});

describe('what the step says before it starts', () => {
  it('estimates at the measured look-up time, and never says zero minutes', () => {
    expect(LOOKUP_SECONDS).toBe(33);
    expect(estimateText(7)).toBe('about 4 minutes');
    expect(estimateText(1)).toBe('about 1 minute');
    expect(estimateText(0)).toBe('about 1 minute');
  });

  it('states the count, the time, the folder and that nothing starts', () => {
    expect(planSummary(7, 33)).toBe('7 tickets · about 4 minutes · folder "Cycle 33" · agents are not started');
    expect(planSummary(1, 33)).toBe('1 ticket · about 1 minute · folder "Cycle 33" · agents are not started');
    // The folder is named in ONE place — the same function the create sequence uses.
    expect(planSummary(7, 33)).toContain(`folder "${cycleFolderName(33)}"`);
  });

  it('says nothing is ticked rather than quoting a minute for no work', () => {
    expect(planSummary(0, 33)).toBe('Nothing ticked');
  });

  it('tracks the tick boxes in the button', () => {
    expect(buttonLabel(7)).toBe('Create 7 agents');
    expect(buttonLabel(1)).toBe('Create 1 agent');
    expect(buttonLabel(0)).toBe('Create 0 agents');
  });
});

describe('a row while the run goes', () => {
  it('says what is happening to it, and nothing at all while it waits', () => {
    expect(rowStatusText({ kind: 'waiting' })).toBe('');
    expect(rowStatusText({ kind: 'looking-up' })).toBe('looking up…');
    expect(rowStatusText({ kind: 'creating' })).toBe('creating…');
    expect(rowStatusText({ kind: 'created', name: 'AC-1 fix the thing' })).toBe('created AC-1 fix the thing');
    expect(rowStatusText({ kind: 'skipped' })).toBe('skipped: agent exists');
    expect(rowStatusText({ kind: 'cancelled' })).toBe('cancelled');
    expect(rowStatusText({ kind: 'failed', message: "couldn't read the ticket" })).toBe("failed: couldn't read the ticket");
  });

  it('says out loud that a saved failure left an agent behind, and cleans that message too', () => {
    // `create-agent.ts`: the agent record was committed and the call failed after it. The agent
    // EXISTS, so the row must not read like a failure that can simply be run again.
    expect(rowStatusText({ kind: 'saved', message: 'the session host is not connected' }))
      .toBe('created, then failed: the session host is not connected — not retried');
    expect(rowStatusText({ kind: 'saved', message: `two${NL}lines${BELL}` })).toBe('created, then failed: two lines — not retried');
  });

  it('cleans and caps a failure message, which is somebody else\'s text', () => {
    expect(rowStatusText({ kind: 'failed', message: `two${NL}lines${BELL} and a bell` })).toBe('failed: two lines and a bell');
    expect(rowStatusText({ kind: 'failed', message: 'x'.repeat(RUN_MESSAGE_MAX + 50) })).toBe(`failed: ${'x'.repeat(RUN_MESSAGE_MAX)}`);
  });
});

describe('the summary, and Retry failed', () => {
  it('counts what was made out of what was attempted', () => {
    expect(runSummary({ created: 6, attempted: 7, cycleNumber: 33, stopped: null })).toBe('Created 6 of 7 agents in "Cycle 33"');
    expect(runSummary({ created: 2, attempted: 7, cycleNumber: 33, stopped: 'cancel' })).toBe('Stopped. Created 2 of 7.');
    expect(runSummary({ created: 2, attempted: 7, cycleNumber: 33, stopped: 'disk' })).toBe('Stopped: low disk. Created 2 of 7.');
  });

  it('accounts for an agent that exists but whose create did not finish, however the run ended', () => {
    // Counted among the created — the agent is there — and then named, because "6 of 7" on its own
    // would hide the one row the owner has to go and look at.
    expect(runSummary({ created: 6, attempted: 7, cycleNumber: 33, stopped: null, unfinished: 1 }))
      .toBe('Created 6 of 7 agents in "Cycle 33" · 1 was created but not finished');
    expect(runSummary({ created: 6, attempted: 7, cycleNumber: 33, stopped: 'cancel', unfinished: 2 }))
      .toBe('Stopped. Created 6 of 7. · 2 were created but not finished');
    expect(runSummary({ created: 6, attempted: 7, cycleNumber: 33, stopped: null, unfinished: 0 }))
      .toBe('Created 6 of 7 agents in "Cycle 33"');
  });

  it('re-runs only the failures — never a skip and never a success', () => {
    const rows: Record<string, TicketRowState> = {
      'AC-1': { kind: 'created', name: 'AC-1 a' },
      'AC-2': { kind: 'failed', message: 'nope' },
      'AC-3': { kind: 'skipped' },
      'AC-4': { kind: 'failed', message: 'also nope' },
      'AC-5': { kind: 'waiting' },
      // The agent EXISTS. Re-running this one makes a second agent for the same ticket, which is
      // the one thing `Retry failed` must never do.
      'AC-6': { kind: 'saved', message: 'could not be started' },
      'AC-7': { kind: 'cancelled' },
    };
    expect(failedIdentifiers([issue('AC-1'), issue('AC-2'), issue('AC-3'), issue('AC-4'), issue('AC-5'), issue('AC-6'), issue('AC-7')], rows)).toEqual(['AC-2', 'AC-4']);
  });
});
