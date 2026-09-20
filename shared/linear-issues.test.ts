import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_LIMIT, CURSOR_MAX, LINEAR_PAGE_SIZE, PRIORITY_LABELS, PROJECT_NAME_MAX, TEAM_ID_MAX, TEAMS_PAGE_SIZE,
  TICKET_DESCRIPTION_MAX, TICKET_ESTIMATE_MAX, TICKET_PRIORITY_MAX, TICKET_TITLE_MAX, TicketFieldsSchema, agentForIssue,
  cleanTicketDescription, cleanTicketTitle, emptyTicketFields,
  filterIssues, isDoneOrCancelled, listCycleIssuesArgs, listCyclesArgs, listIssuesArgs, listTeamsArgs, mergeIssuePages, mergeTicketFields,
  parseCalibrationRows, parseCreatedIssue, parseCyclesPayload, parseIssuesPayload, parseTeamsPayload,
  parseStampedCursor, saveIssueArgs, stampCursor, ticketFieldsProblem, withCycleNumbers, type LinearIssue, type TicketFields,
} from './linear-issues.ts';
import type { Agent } from './types.ts';

const ISO = '2026-09-16T10:00:00.000Z';

/** Built at run time, never typed as an escape (G51): a right-to-left override, a BEL and a NUL. */
const BIDI = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BELL = String.fromCodePoint(7);
const NUL = String.fromCodePoint(0);
const NL = String.fromCodePoint(10);

const agent = (id: string, name: string): Agent => ({
  id, name, slug: id, folderId: null, sortKey: 0, workspaces: [], notes: '',
  claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

const issue = (patch: Partial<LinearIssue> = {}): LinearIssue => ({
  identifier: 'AC-3462', title: 'Zero click payments', state: 'Todo', stateType: 'unstarted',
  teamId: 'team-uuid-1', teamName: 'Acme', cycleId: null, cycleNumber: null,
  updatedAt: ISO, url: 'https://linear.app/acme/issue/AC-3462', ...patch,
});

describe('parseIssuesPayload', () => {
  it("takes the ticket's identifier from the payload's `id` field, and the UUID from nowhere", () => {
    // Exactly the shape measured on 2026-09-16, trimmed to the keys this reader looks at.
    const payload = JSON.stringify({
      issues: [{
        id: 'AC-3462', uuid: '0d6b7a6e-1111-2222-3333-444455556666', title: 'Zero click payments',
        description: 'long text', status: 'Todo', statusType: 'unstarted', team: 'Acme', teamId: 'team-uuid-1',
        project: 'Payments', projectId: 'proj-1', cycleId: 'cycle-uuid-9', estimate: 3, priority: 2,
        updatedAt: ISO, url: 'https://linear.app/acme/issue/AC-3462/zero-click',
      }],
      hasNextPage: true,
      cursor: 'cursor-2',
    });
    expect(parseIssuesPayload(payload)).toEqual({
      issues: [issue({ cycleId: 'cycle-uuid-9', url: 'https://linear.app/acme/issue/AC-3462/zero-click' })],
      nextCursor: 'cursor-2',
    });
  });

  it('classifies every measured statusType, and leaves an unknown one undimmed', () => {
    const payload = JSON.stringify({
      issues: [
        { id: 'AC-1', title: 'a', status: 'Design in Progress', statusType: 'started', team: 'Acme', teamId: 'tu1', updatedAt: ISO },
        { id: 'AB-2', title: 'b', status: 'Done', statusType: 'completed', team: 'Infra', teamId: 'tu2', updatedAt: ISO },
        { id: 'AB-3', title: 'c', status: 'Cancelled', statusType: 'canceled', updatedAt: ISO },
        { id: 'AB-4', title: 'd', status: 'Needs triage', statusType: 'triage', updatedAt: ISO },
        { id: 'AB-5', title: 'e', status: 'Somewhere new', statusType: 'a-type-we-do-not-know', updatedAt: ISO },
        { id: 'AB-6', title: 'f' },
      ],
    });
    const { issues, nextCursor } = parseIssuesPayload(payload);
    // `hasNextPage` absent means there is no next page — the cursor is not offered on its own.
    expect(nextCursor).toBeNull();
    expect(issues.map((i) => [i.identifier, i.state, i.stateType, i.teamName])).toEqual([
      ['AC-1', 'Design in Progress', 'started', 'Acme'],
      ['AB-2', 'Done', 'completed', 'Infra'],
      ['AB-3', 'Cancelled', 'canceled', ''],
      ['AB-4', 'Needs triage', 'triage', ''],
      ['AB-5', 'Somewhere new', 'unknown', ''],
      // Nothing but an id: the row still survives, with a blank state and no team.
      ['AB-6', '', 'unknown', ''],
    ]);
    expect(issues.filter(isDoneOrCancelled).map((i) => i.identifier)).toEqual(['AB-2', 'AB-3']);
  });

  it('carries cycleId through and fills the number only from list_cycles', () => {
    const payload = JSON.stringify({ issues: [{ id: 'AC-1', title: 'a', cycleId: 'cy-1', updatedAt: ISO }, { id: 'AC-2', title: 'b', cycleId: 'cy-2', updatedAt: ISO }] });
    const { issues } = parseIssuesPayload(payload);
    expect(issues.map((i) => [i.cycleId, i.cycleNumber])).toEqual([['cy-1', null], ['cy-2', null]]);
    // Only the cycle the map knows gets a number; the other one simply shows no cycle.
    expect(withCycleNumbers(issues, new Map([['cy-1', 32]])).map((i) => i.cycleNumber)).toEqual([32, null]);
  });

  it('reads the cycles payload — a BARE ARRAY, as measured — and a row still reads as id and number', () => {
    const measured = JSON.stringify([
      { id: 'cy-1', number: 32, startsAt: ISO, endsAt: ISO, isCurrent: true, scopeHistory: [1, 2, 3], issueCountHistory: [4, 5] },
      { id: 'cy-2' },
      { number: 9 },
    ]);
    // A superset of `{id, number}` since Plan 08 — the added fields are the cycles block below.
    expect(parseCyclesPayload(measured)).toMatchObject([{ id: 'cy-1', number: 32 }]);
    expect(parseCyclesPayload(measured)).toHaveLength(1);
    // Tolerated in case the shape ever changes, but not what the server sends today.
    expect(parseCyclesPayload('{"cycles":[{"id":"cy-3","number":33}]}')).toMatchObject([{ id: 'cy-3', number: 33 }]);
    expect(parseCyclesPayload('nope')).toEqual([]);
  });

  it('drops a row whose id is not a ticket identifier, and refuses a url that is not a link to that ticket', () => {
    const payload = JSON.stringify({
      issues: [
        { id: '0d6b7a6e-1111-2222-3333-444455556666', title: 'a uuid where the identifier belongs' },
        { id: 'AC-9', title: 'wrong link', url: 'https://linear.app/acme/issue/AC-8/x' },
        { id: 'AC-10', title: 'not linear at all', url: 'https://evil.example.com/AC-10' },
      ],
    });
    expect(parseIssuesPayload(payload).issues.map((i) => [i.identifier, i.url])).toEqual([['AC-9', ''], ['AC-10', '']]);
  });

  it('strips invisible and control characters from every string it keeps, and caps the title', () => {
    const payload = JSON.stringify({
      issues: [{ id: 'AC-11', title: `Pay${BIDI}ment${BELL} ${'x'.repeat(400)}`, status: `To${NUL}do`, updatedAt: ISO }],
    });
    const [only] = parseIssuesPayload(payload).issues;
    expect(only?.title.includes(BIDI)).toBe(false);
    expect(only?.title.startsWith('Payment')).toBe(true);
    expect(Array.from(only?.title ?? '')).toHaveLength(200);
    expect(only?.state).toBe('To do');
  });

  it("accepts the double-l `cancelled` spelling and does not care about the type's case", () => {
    const payload = JSON.stringify({ issues: [
      { id: 'AC-20', title: 'a', status: 'Cancelled', statusType: 'cancelled' },
      { id: 'AC-21', title: 'b', status: 'Done', statusType: 'COMPLETED' },
    ] });
    const { issues } = parseIssuesPayload(payload);
    expect(issues.map((i) => i.stateType)).toEqual(['canceled', 'completed']);
    expect(issues.every(isDoneOrCancelled)).toBe(true);
  });

  it('collapses every run of whitespace into one space and caps an over-long id', () => {
    const payload = JSON.stringify({
      issues: [{ id: 'AC-22', title: 'Two\nlines\t\tand   spaces', status: '  Todo  ', teamId: 't'.repeat(5000), cycleId: 'c'.repeat(5000), updatedAt: ISO }],
    });
    const [only] = parseIssuesPayload(payload).issues;
    expect(only?.title).toBe('Two lines and spaces');
    expect(only?.state).toBe('Todo');
    expect(only?.teamId).toHaveLength(TEAM_ID_MAX);
    expect(only?.cycleId).toHaveLength(TEAM_ID_MAX);
  });

  it('is empty for junk rather than throwing, and offers a cursor only when hasNextPage says so', () => {
    expect(parseIssuesPayload('not json')).toEqual({ issues: [], nextCursor: null });
    expect(parseIssuesPayload('{"issues":"nope"}')).toEqual({ issues: [], nextCursor: null });
    expect(parseIssuesPayload('{"issues":[],"hasNextPage":true,"cursor":"c9"}').nextCursor).toBe('c9');
    expect(parseIssuesPayload('{"issues":[],"hasNextPage":false,"cursor":"c9"}').nextCursor).toBeNull();
    expect(parseIssuesPayload('{"issues":[],"cursor":"c9"}').nextCursor).toBeNull();
  });
});

/**
 * Plan 07. The cursor Hangar hands out is Linear's own with the cache generation in front of it, so
 * the handler can tell a `Load more` for the list it is holding from one for a list a `Refresh`
 * replaced. The renderer never reads it — it hands back what it was given.
 */
describe('stampCursor / parseStampedCursor (Plan 07)', () => {
  it('stamps a cursor with its generation and reads it back', () => {
    expect(stampCursor(0, 'c2')).toBe('0:c2');
    expect(stampCursor(7, 'c2')).toBe('7:c2');
    expect(stampCursor(0, null)).toBeNull();
    expect(parseStampedCursor('7:c2')).toEqual({ generation: 7, cursor: 'c2' });
    // Linear's own cursor is opaque and may hold colons of its own: only the FIRST one is the stamp.
    expect(parseStampedCursor('7:a:b')).toEqual({ generation: 7, cursor: 'a:b' });
  });

  it('refuses anything it did not stamp, and drops a cursor too long to stamp', () => {
    for (const bad of ['c2', '', ':c2', '7:', 'x:c2', '-1:c2', '1234567890:c2', ' 7:c2']) {
      expect(parseStampedCursor(bad), bad).toBeNull();
    }
    // The wire bound is the same number the zod schema uses, so a stamped cursor always fits back
    // through it: one that would not is dropped, and the list simply offers no `Load more`.
    expect(stampCursor(0, 'x'.repeat(CURSOR_MAX - 2))).toBe(`0:${'x'.repeat(CURSOR_MAX - 2)}`);
    expect(stampCursor(0, 'x'.repeat(CURSOR_MAX - 1))).toBeNull();
    expect(stampCursor(0, 'x'.repeat(CURSOR_MAX))).toBeNull();
  });
});

describe('listIssuesArgs / parseTeamsPayload / parseCreatedIssue', () => {
  it('asks for everything assigned to the owner, newest first, a page at a time', () => {
    expect(listIssuesArgs(null)).toEqual({ assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE });
    expect(listIssuesArgs('c2')).toEqual({ assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE, cursor: 'c2' });
  });

  it('reads teams by id and NAME — the payload carries no key — and cleans the names', () => {
    const payload = JSON.stringify({ teams: [{ id: 't1', name: `Ac${ZWSP}me`, icon: 'x', visibility: 'public' }, { name: 'no id' }], hasNextPage: false });
    expect(parseTeamsPayload(payload)).toEqual({ teams: [{ id: 't1', name: 'Acme' }], nextCursor: null });
    // Tolerated in case the shape ever changes, as `list_cycles` already sends one today.
    expect(parseTeamsPayload('[{"id":"t2","name":"Infra"}]')).toEqual({ teams: [{ id: 't2', name: 'Infra' }], nextCursor: null });
    expect(parseTeamsPayload('nope')).toEqual({ teams: [], nextCursor: null });
  });

  /** The measured payload offers no cursor, so this is the tolerance, read by the same rule as issues. */
  it('pages the teams only when the payload offers both a next page and a cursor', () => {
    expect(listTeamsArgs(null)).toEqual({ limit: TEAMS_PAGE_SIZE });
    expect(listTeamsArgs('tc2')).toEqual({ limit: TEAMS_PAGE_SIZE, cursor: 'tc2' });
    expect(parseTeamsPayload('{"teams":[],"hasNextPage":true,"cursor":"tc2"}').nextCursor).toBe('tc2');
    expect(parseTeamsPayload('{"teams":[],"hasNextPage":true}').nextCursor).toBeNull();
    expect(parseTeamsPayload('{"teams":[],"hasNextPage":false,"cursor":"tc2"}').nextCursor).toBeNull();
  });

  it('reads the created ticket back, and is null when the answer names no ticket', () => {
    expect(parseCreatedIssue('{"id":"AC-3500","url":"https://linear.app/acme/issue/AC-3500/new"}')).toEqual({
      identifier: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/new',
    });
    // Wrapped in an `issue` member, and with no url: still enough to name it.
    expect(parseCreatedIssue('{"issue":{"id":"AC-3501"}}')).toEqual({ identifier: 'AC-3501', url: '' });
    expect(parseCreatedIssue('{"ok":true}')).toBeNull();
  });
});

describe('the list the dialog draws', () => {
  it('dims Done and Cancelled only', () => {
    expect(isDoneOrCancelled(issue({ stateType: 'completed' }))).toBe(true);
    expect(isDoneOrCancelled(issue({ stateType: 'canceled' }))).toBe(true);
    for (const t of ['backlog', 'unstarted', 'started', 'unknown'] as const) expect(isDoneOrCancelled(issue({ stateType: t }))).toBe(false);
  });

  it('filters on identifier, title and state, case-insensitively, and keeps everything for an empty query', () => {
    const issues = [issue(), issue({ identifier: 'AC-99', title: 'Refund flow', state: 'Done' })];
    expect(filterIssues(issues, '').length).toBe(2);
    expect(filterIssues(issues, '   ').length).toBe(2);
    expect(filterIssues(issues, 'ac-99').map((i) => i.identifier)).toEqual(['AC-99']);
    expect(filterIssues(issues, 'CLICK').map((i) => i.identifier)).toEqual(['AC-3462']);
    expect(filterIssues(issues, 'done').map((i) => i.identifier)).toEqual(['AC-99']);
    expect(filterIssues(issues, 'nothing here')).toEqual([]);
  });

  it('matches an agent by identifier PREFIX at a boundary, so AC-346 never claims AC-3461', () => {
    const agents = [agent('a1', 'AC-3461 0 click payments'), agent('a2', 'ac-99: refunds'), agent('a3', 'Rewrite AC-77')];
    expect(agentForIssue(agents, 'AC-3461')?.id).toBe('a1');
    expect(agentForIssue(agents, 'AC-99')?.id).toBe('a2');
    expect(agentForIssue(agents, 'AC-346')).toBeUndefined();
    expect(agentForIssue(agents, 'AC-34610')).toBeUndefined();
    // The identifier has to START the name — a mention inside it is not an agent for the ticket.
    expect(agentForIssue(agents, 'AC-77')).toBeUndefined();
  });

  it('will not take a hyphen, a letter or a combining mark as the boundary after the identifier', () => {
    const MARK = String.fromCodePoint(0x0301); // a combining acute, built at run time (G51)
    const ACUTE_E = String.fromCodePoint(0x00e9);
    const agents = [agent('a1', 'AC-34-5 a sub ticket'), agent('a2', `AC-35${MARK} odd`), agent('a3', `AC-36${ACUTE_E} accented`), agent('a4', 'AC-37: fine')];
    expect(agentForIssue(agents, 'AC-34')).toBeUndefined();
    expect(agentForIssue(agents, 'AC-35')).toBeUndefined();
    expect(agentForIssue(agents, 'AC-36')).toBeUndefined();
    // The control: a real boundary still matches.
    expect(agentForIssue(agents, 'AC-37')?.id).toBe('a4');
  });

  it('appends a page without duplicating a ticket that moved between pages', () => {
    const page1 = [issue({ identifier: 'AC-1' }), issue({ identifier: 'AC-2' })];
    const page2 = [issue({ identifier: 'AC-2', title: 'moved' }), issue({ identifier: 'AC-3' })];
    expect(mergeIssuePages(page1, page2).map((i) => [i.identifier, i.title])).toEqual([
      ['AC-1', 'Zero click payments'], ['AC-2', 'Zero click payments'], ['AC-3', 'Zero click payments'],
    ]);
  });
});

describe('TicketFields', () => {
  const filled: TicketFields = {
    title: 'Zero click payments', description: 'Charge a saved card.', estimate: 3, priority: 2,
    teamId: 't1', projectId: 'Payments', assigneeSelf: true, state: 'Backlog',
  };

  it('starts empty, with the two fixed fields already fixed', () => {
    expect(emptyTicketFields()).toEqual({ title: '', description: '', estimate: null, priority: null, teamId: null, projectId: null, assigneeSelf: true, state: 'Backlog' });
  });

  it('fills ONLY the fields the owner left empty', () => {
    const typed = { ...emptyTicketFields(), title: 'My own title', priority: 1 };
    expect(mergeTicketFields(typed, { description: 'drafted', estimate: 5, priority: 4, teamId: 't1', projectId: 'Payments' })).toEqual({
      ...typed, description: 'drafted', estimate: 5, teamId: 't1', projectId: 'Payments',
    });
    // A whitespace-only description still counts as empty.
    expect(mergeTicketFields({ ...filled, description: '   ' }, { description: 'drafted' })).toMatchObject({ description: 'drafted' });
    // Everything already filled: nothing the model offers changes anything.
    expect(mergeTicketFields(filled, { description: 'drafted', estimate: 8, priority: 0, teamId: 't9', projectId: 'Other' })).toEqual(filled);
  });

  it('names the one problem that stops a save, and nothing else', () => {
    expect(ticketFieldsProblem(filled)).toBeNull();
    expect(ticketFieldsProblem({ ...filled, title: '  ' })).toBe('A title is required.');
    expect(ticketFieldsProblem({ ...filled, teamId: null })).toBe('Choose a team.');
    expect(ticketFieldsProblem({ ...filled, description: '', estimate: null, priority: null, projectId: null })).toBeNull();
  });

  /**
   * Every one of these used to pass this function and die at `TicketFieldsSchema` instead, where the
   * owner is told `BAD_REQUEST` and nothing else. The form's `min`/`max` attributes are no answer:
   * they raise a browser bubble on a submit, and `Save anyway` is an ordinary button.
   */
  it('refuses a number the schema would refuse, in words rather than as a BAD_REQUEST', () => {
    const rejects = (fields: TicketFields): void => {
      expect(ticketFieldsProblem(fields)).not.toBeNull();
      expect(TicketFieldsSchema.safeParse(fields).success).toBe(false);
    };
    const estimateProblem = `An estimate is a whole number between 0 and ${TICKET_ESTIMATE_MAX}.`;
    expect(ticketFieldsProblem({ ...filled, estimate: TICKET_ESTIMATE_MAX + 400 })).toBe(estimateProblem);
    expect(ticketFieldsProblem({ ...filled, estimate: -1 })).toBe(estimateProblem);
    expect(ticketFieldsProblem({ ...filled, estimate: 2.5 })).toBe(estimateProblem);
    expect(ticketFieldsProblem({ ...filled, estimate: Number.NaN })).toBe(estimateProblem);
    expect(ticketFieldsProblem({ ...filled, estimate: Number.POSITIVE_INFINITY })).toBe(estimateProblem);
    rejects({ ...filled, estimate: 500 });
    rejects({ ...filled, estimate: 2.5 });

    expect(ticketFieldsProblem({ ...filled, priority: PRIORITY_LABELS.length })).toBe("A priority is one of Linear's five levels.");
    expect(ticketFieldsProblem({ ...filled, priority: -1 })).toBe("A priority is one of Linear's five levels.");
    rejects({ ...filled, priority: 9 });

    // The bounds themselves are allowed, on both sides.
    expect(ticketFieldsProblem({ ...filled, estimate: 0, priority: 0 })).toBeNull();
    expect(ticketFieldsProblem({ ...filled, estimate: TICKET_ESTIMATE_MAX, priority: TICKET_PRIORITY_MAX })).toBeNull();
  });

  /**
   * The guard and the schema have to agree at the EDGE, because one of them being one out is
   * invisible everywhere else: the form would offer a value the wire refuses as `BAD_REQUEST`, or
   * refuse one it would have taken. Both bounds now come from one constant, and `PRIORITY_LABELS` is
   * checked against it too — the select is built from those labels, so a sixth of them would other-
   * wise put an option on screen that cannot be saved.
   */
  it('gates the numbers on exactly the same bounds the schema does', () => {
    expect(PRIORITY_LABELS).toHaveLength(TICKET_PRIORITY_MAX + 1);
    const agree = (fields: TicketFields): void => {
      expect(ticketFieldsProblem(fields) === null).toBe(TicketFieldsSchema.safeParse(fields).success);
    };
    for (const priority of [0, TICKET_PRIORITY_MAX, TICKET_PRIORITY_MAX + 1, -1, 1.5]) agree({ ...filled, priority });
    for (const estimate of [0, TICKET_ESTIMATE_MAX, TICKET_ESTIMATE_MAX + 1, -1, 1.5]) agree({ ...filled, estimate });
    // And the form's own select cannot offer a level the guard would stop.
    for (let priority = 0; priority < PRIORITY_LABELS.length; priority += 1) agree({ ...filled, priority });
  });

  it('builds save_issue arguments with no id, the owner as assignee and Backlog as the state', () => {
    expect(saveIssueArgs(filled)).toEqual({
      title: 'Zero click payments', description: 'Charge a saved card.', estimate: 3, priority: 2,
      team: 't1', project: 'Payments', assignee: 'me', state: 'Backlog',
    });
    // No `id` key at ALL — its presence is what would turn a create into an edit of someone's ticket.
    expect(Object.keys(saveIssueArgs(filled))).not.toContain('id');
    // Empty optional fields are omitted rather than sent as null.
    expect(saveIssueArgs({ ...filled, description: '', estimate: null, priority: null, projectId: null })).toEqual({
      title: 'Zero click payments', team: 't1', assignee: 'me', state: 'Backlog',
    });
  });

  /**
   * The title and description go OUT of this application, into a ticket other people read, and until
   * now the only thing that cleaned them was the renderer's own `mergeTicketFields` — the same
   * dependency the drafted description had until the IPC boundary took it over. A caller that skips
   * the form (a future one, a test, a compromised renderer) could file a title carrying a bell
   * character, a right-to-left override that reverses what follows it, or a zero-width space that
   * makes one title pass for another.
   *
   * Cleaned HERE, in the one function that builds what Linear is sent, so every caller is covered by
   * one rule rather than each by its own. The title is `oneLine` — a title IS one line — and the
   * description keeps its newlines, both through the same helpers `mergeTicketFields` uses.
   */
  it('cleans and caps the title and description it sends, whatever the caller held', () => {
    const args = saveIssueArgs({
      ...filled,
      title: `  Zero${BIDI} click${BELL}payments${ZWSP}  ${'x'.repeat(TICKET_TITLE_MAX)}`,
      description: `  Line one${BIDI}\nLine${BELL}two${NUL}  `,
    });
    expect(args.title).toBe(`Zero click payments ${'x'.repeat(TICKET_TITLE_MAX)}`.slice(0, TICKET_TITLE_MAX));
    for (const ch of [BIDI, BELL, ZWSP, NUL]) {
      expect(String(args.title).includes(ch), `title still carries U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
      expect(String(args.description).includes(ch), `description still carries U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
    }
    // Newlines survive in the description and not in the title.
    expect(args.description).toBe('Line one\nLine two');
    expect(String(args.title).includes('\n')).toBe(false);
  });

  /**
   * A description is MARKDOWN, and in markdown a tab is indentation: it opens a code block and it
   * indents a nested list. Spacing it out — which the shared control-character class does, because
   * that class exists for text typed into a PTY, where a tab is a completion key — silently turned
   * an owner's indented code block into a paragraph. Newlines were already kept for exactly this
   * reason; the tab is the same argument, and it is safe for the same reason: this text goes to a
   * textarea and to Linear, never into a shell.
   */
  it('keeps the tabs in a description, so an indented code block survives', () => {
    const TAB = String.fromCodePoint(9);
    const code = `Repro:${NL}${NL}${TAB}npm run build${NL}${TAB}${TAB}--verbose`;
    expect(cleanTicketDescription(code)).toBe(code);
    expect(saveIssueArgs({ ...filled, description: code }).description).toBe(code);
    expect(mergeTicketFields(emptyTicketFields(), { description: code }).description).toBe(code);
    // And a tab is still the ONLY control character that survives: the rest are spaced as before.
    expect(cleanTicketDescription(`a${BELL}b${TAB}c`)).toBe(`a b${TAB}c`);
    // A TITLE is one line, so its tabs collapse into the surrounding whitespace as any space would.
    expect(cleanTicketTitle(`Zero${TAB}click`)).toBe('Zero click');
  });

  /** A title that is nothing but invisible characters is no title, and is refused before it is sent. */
  it('refuses a title that cleans away to nothing', () => {
    expect(ticketFieldsProblem({ ...filled, title: `${BIDI}${ZWSP}${BELL}` })).toBe('A title is required.');
    expect(saveIssueArgs({ ...filled, description: `${ZWSP}${BELL}  ` }).description).toBeUndefined();
  });

  it('cleans and caps the ids a model offers, and drops one that cleans away to nothing', () => {
    const merged = mergeTicketFields(emptyTicketFields(), {
      teamId: 'T'.repeat(5001),
      projectId: `Pay${BIDI}ments${BELL} ${'z'.repeat(200)}`,
    });
    expect(merged.teamId).toHaveLength(TEAM_ID_MAX);
    expect(merged.projectId?.includes(BIDI)).toBe(false);
    expect(merged.projectId?.includes(BELL)).toBe(false);
    expect(merged.projectId?.startsWith('Payments z')).toBe(true);
    expect(Array.from(merged.projectId ?? '')).toHaveLength(PROJECT_NAME_MAX);
    // Whatever the model said, what comes out is something the schema accepts.
    expect(TicketFieldsSchema.safeParse({ ...merged, title: 'x' }).success).toBe(true);
    // Cleaned away to nothing is not a value: the field stays empty rather than becoming ''.
    expect(mergeTicketFields(emptyTicketFields(), { teamId: '   ', projectId: NUL })).toMatchObject({ teamId: null, projectId: null });
  });

  it('cleans, keeps the newlines of and caps a drafted description', () => {
    const hostile = `Line one${BIDI}\nLine${BELL}two\n${'y'.repeat(TICKET_DESCRIPTION_MAX)}`;
    const merged = mergeTicketFields(emptyTicketFields(), { description: hostile });
    expect(merged.description.includes(BIDI)).toBe(false);
    expect(merged.description.includes(BELL)).toBe(false);
    expect(merged.description.startsWith('Line one\nLine two\n')).toBe(true);
    expect(Array.from(merged.description)).toHaveLength(TICKET_DESCRIPTION_MAX);
    expect(TicketFieldsSchema.safeParse({ ...merged, title: 'x', teamId: 't1' }).success).toBe(true);
  });

  /**
   * `mergeTicketFields` is now run TWICE on the same answer — once at the IPC boundary, so no raw
   * model text reaches the renderer, and once in the form, where it decides which of the owner's own
   * fields to leave alone. That only stays a free defence while it is idempotent, and it was not: the
   * description was trimmed BEFORE it was capped, so a cut that landed on a space left a trailing one
   * for the second pass to trim, and a 20 000-character description came back 19 999 characters long.
   * A visible character was lost to a second call that was supposed to do nothing.
   */
  it('cleans a description to the same string however many times it is applied', () => {
    // A cut that lands on whitespace: the cap falls inside a run of spaces, not on a letter.
    const draft = { description: `${'y'.repeat(TICKET_DESCRIPTION_MAX - 1)}   tail` };
    const once = mergeTicketFields(emptyTicketFields(), draft);
    const twice = mergeTicketFields(emptyTicketFields(), { description: once.description });
    expect(Array.from(once.description)).toHaveLength(TICKET_DESCRIPTION_MAX - 1);
    expect(twice.description).toBe(once.description);
    // And the same for an answer that needed no capping at all, cleaning included.
    const plain = mergeTicketFields(emptyTicketFields(), { description: `  Line one${BIDI}\nLine${BELL}two  ` });
    expect(mergeTicketFields(emptyTicketFields(), { description: plain.description }).description).toBe(plain.description);
  });

  it('drops a drafted number the schema would reject, and rounds a fractional one', () => {
    const wild = mergeTicketFields(emptyTicketFields(), { estimate: 999999.5, priority: 42 });
    expect(wild).toMatchObject({ estimate: null, priority: null });
    expect(TicketFieldsSchema.safeParse({ ...wild, title: 'x', teamId: 't1' }).success).toBe(true);
    expect(mergeTicketFields(emptyTicketFields(), { estimate: 3.4, priority: 1 })).toMatchObject({ estimate: 3, priority: 1 });
    expect(mergeTicketFields(emptyTicketFields(), { estimate: -1, priority: -2 })).toMatchObject({ estimate: null, priority: null });
    expect(mergeTicketFields(emptyTicketFields(), { estimate: Number.NaN, priority: Number.POSITIVE_INFINITY })).toMatchObject({ estimate: null, priority: null });
  });

  it('names an over-long title or description too, counting what the schema counts', () => {
    expect(ticketFieldsProblem({ ...filled, title: 'x'.repeat(TICKET_TITLE_MAX) })).toBeNull();
    expect(ticketFieldsProblem({ ...filled, title: 'x'.repeat(TICKET_TITLE_MAX + 1) })).toBe(`A title is at most ${TICKET_TITLE_MAX} characters.`);
    expect(ticketFieldsProblem({ ...filled, description: 'x'.repeat(TICKET_DESCRIPTION_MAX + 1) })).toBe(`A description is at most ${TICKET_DESCRIPTION_MAX} characters.`);
    // Code points, because that is what zod's `.max()` counts (measured on zod 4.5): 250 emoji are
    // 500 UTF-16 units, and a `.length` check here would report a problem the schema does not have.
    const emoji = String.fromCodePoint(0x1f600).repeat(TICKET_TITLE_MAX);
    expect(ticketFieldsProblem({ ...filled, title: emoji })).toBeNull();
    expect(TicketFieldsSchema.safeParse({ ...filled, title: emoji }).success).toBe(true);
  });

  it('has a zod schema that matches, with the two fixed fields pinned to their literals', () => {
    expect(TicketFieldsSchema.safeParse(filled).success).toBe(true);
    expect(TicketFieldsSchema.safeParse({ ...filled, assigneeSelf: false }).success).toBe(false);
    expect(TicketFieldsSchema.safeParse({ ...filled, state: 'Done' }).success).toBe(false);
    expect(TicketFieldsSchema.safeParse({ ...filled, estimate: 2.5 }).success).toBe(false);
    expect(TicketFieldsSchema.safeParse({ ...filled, priority: 9 }).success).toBe(false);
    expect(TicketFieldsSchema.safeParse({ ...filled, title: 'x'.repeat(251) }).success).toBe(false);
    expect(PRIORITY_LABELS[2]).toBe('High');
  });
});

describe('parseCalibrationRows', () => {
  it('reads the rows the draft prompt is calibrated on, capped and cleaned', () => {
    const rows = Array.from({ length: CALIBRATION_LIMIT + 5 }, (_, i) => ({
      id: `AC-${i + 1}`, title: `Ticket ${i + 1}`, estimate: 3, priority: 2, team: 'Acme', project: 'Payments',
    }));
    const parsed = parseCalibrationRows(JSON.stringify({ issues: rows }));
    expect(parsed).toHaveLength(CALIBRATION_LIMIT);
    expect(parsed[0]).toEqual({ title: 'Ticket 1', estimate: 3, priority: 2, team: 'Acme', project: 'Payments' });
  });

  it('keeps a row with nothing but a title, and is empty for junk', () => {
    expect(parseCalibrationRows('{"issues":[{"id":"AC-1","title":"only a title"}]}')).toEqual([
      { title: 'only a title', estimate: null, priority: null, team: '', project: '' },
    ]);
    expect(parseCalibrationRows('nope')).toEqual([]);
  });
});

describe('cycles (Plan 08)', () => {
  /** The BARE ARRAY `list_cycles` really sends, with the four history arrays it also sends. */
  const payload = JSON.stringify([
    { id: '8c34c582-526f-4c9a-b22b-59e98f110037', number: 33, startsAt: '2026-09-28T00:00:00.000Z', endsAt: '2026-10-12T00:00:00.000Z', isCurrent: true, issueCountHistory: [1, 2, 3], scopeHistory: [4, 5] },
    { id: '2ef9db9c-31e4-4840-9600-6a239aba3ada', number: 32, startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-09-28T00:00:00.000Z', isCurrent: false },
  ]);

  it('keeps the dates and the current flag, and still reads as {id, number}', () => {
    const cycles = parseCyclesPayload(payload);
    expect(cycles).toEqual([
      { id: '8c34c582-526f-4c9a-b22b-59e98f110037', number: 33, startsAt: '2026-09-28T00:00:00.000Z', endsAt: '2026-10-12T00:00:00.000Z', isCurrent: true, teamId: '', teamName: '' },
      { id: '2ef9db9c-31e4-4840-9600-6a239aba3ada', number: 32, startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-09-28T00:00:00.000Z', isCurrent: false, teamId: '', teamName: '' },
    ]);
    // The map `linear:myIssues` builds is unchanged by the extra fields.
    expect(new Map(cycles.map((c) => [c.id, c.number])).get('2ef9db9c-31e4-4840-9600-6a239aba3ada')).toBe(32);
  });

  it('drops a row with no id or no number, and tolerates missing dates', () => {
    const odd = JSON.stringify([{ id: 'c1', number: 1 }, { id: '', number: 2 }, { id: 'c3' }, { number: 4 }, 'nope']);
    expect(parseCyclesPayload(odd)).toEqual([{ id: 'c1', number: 1, startsAt: '', endsAt: '', isCurrent: false, teamId: '', teamName: '' }]);
  });

  it('is an empty list for a malformed payload, never a throw', () => {
    expect(parseCyclesPayload('{ not json')).toEqual([]);
    expect(parseCyclesPayload('null')).toEqual([]);
  });

  it('still accepts the {cycles} shape, in case the server ever sends one', () => {
    expect(parseCyclesPayload(JSON.stringify({ cycles: [{ id: 'c9', number: 9 }] }))).toHaveLength(1);
  });

  it('builds the cycle list request with cycle + assignee, and a cursor only when paging', () => {
    expect(listCycleIssuesArgs('cy-1', null)).toEqual({ cycle: 'cy-1', assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE });
    expect(listCycleIssuesArgs('cy-1', 'abc')).toEqual({ cycle: 'cy-1', assignee: 'me', orderBy: 'updatedAt', limit: LINEAR_PAGE_SIZE, cursor: 'abc' });
    // And never a `limit` on the CYCLES call — that one is refused (measured).
    expect(listCyclesArgs('t1')).toEqual({ teamId: 't1' });
  });
});
