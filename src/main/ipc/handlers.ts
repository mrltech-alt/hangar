// One function per IPC request key — spec §7. No Electron imports: Electron APIs arrive via `bridge`.
import { LINEAR_CREATE_UNCONFIRMED, type IpcEvents, type IpcRequestKey, type IpcRequests } from '../../../shared/ipc-contract.ts';
import type { HostStatus, Id, Project, SessionState, Workspace, WorkspaceSnapshot } from '../../../shared/types.ts';
import type { ElectronBridge } from '../electron-bridge.ts';
import type { AgentService } from '../services/agent-service.ts';
import type { ConfigStore } from '../services/config-store.ts';
import { dictationMessage, textToWrite, type DictationOutcome } from '../../../shared/dictation.ts';
import type { DictationService, DictationUpdate } from '../services/dictation.ts';
import type { DiffService } from '../services/diff-service.ts';
import { listDir, readFileForViewer } from '../services/fs-browse.ts';
import type { GitService } from '../services/git.ts';
import type { HostClient } from '../services/host-client.ts';
import {
  cleanTicketTitle, emptyTicketFields, listCycleIssuesArgs, listCyclesArgs, listIssuesArgs, listTeamsArgs, mergeIssuePages, mergeTicketFields,
  parseCreatedIssue, parseCyclesPayload, parseIssuesPayload, parseTeamsPayload, saveIssueArgs,
  ticketFieldsProblem, parseStampedCursor, stampCursor, withCycleNumbers,
  type DraftedTicketFields, type LinearCycle, type LinearIssue, type LinearTeam, type TicketFields,
} from '../../../shared/linear-issues.ts';
import { sortCycles } from '../../../shared/linear-cycle-run.ts';
import { LinearError, type LinearMcp } from '../services/linear-mcp.ts';
import type { LinearTicketDraft } from '../services/linear-ticket-draft.ts';
import type { LinearTriage } from '../services/linear-triage.ts';
import type { Logger } from '../services/logger.ts';
import type { HangarPaths } from '../services/paths.ts';
import type { SessionRegistry } from '../services/session-registry.ts';
import type { ShellEnv } from '../services/shell-env.ts';
import {
  createFolder, deleteFolder, moveAgent, moveFolder, removeProject, requireAgent, setLayout, updateAgent, updateFolder, updateProject,
} from '../services/workspace-ops.ts';
import type { WorkspaceStore } from '../services/workspace-store.ts';
import { freeBytes } from '../util/disk.ts';
import type { Exec } from '../util/exec.ts';
import { IpcError } from './errors.ts';

export interface HandlerDeps {
  store: WorkspaceStore;
  agents: AgentService;
  registry: SessionRegistry;
  hostClient: HostClient;
  git: GitService;
  diff: DiffService;
  /** Read by `app:diskFree`, which measures `paths.worktreesDir` — see the handler for why that one. */
  paths: HangarPaths;
  config: ConfigStore;
  bridge: ElectronBridge;
  exec: Exec;
  /**
   * The sanitised child environment (`cleanEnv(process.env)` in `index.ts`, with `PATH` replaced by
   * the resolved login-shell PATH once `resolveShellEnv` answers). It is the SAME object
   * `GitService` and `DiffService` were built with, deliberately: `fs:list` shells out to
   * `git check-ignore` and must not be able to disagree with `git diff` about which git, which
   * `HOME`, or which config it is talking to. Passed in rather than read from `process.env` here so
   * that no handler depends on ambient state, and so a test can supply a deterministic env — the
   * `check-ignore` argv assertion in `handlers.test.ts` is checking exactly that this arrives.
   */
  env: Record<string, string>;
  shellEnv: () => ShellEnv;
  snapshot: () => WorkspaceSnapshot;
  hostStatus: () => HostStatus;
  restartHost: (killSessions: boolean) => Promise<void>;
  /**
   * Plan 06's Linear look-up. A service of its own because it spawns a process and keeps a cancel
   * registry; the two `linear:*` handlers only route to it.
   */
  triage: LinearTriage;
  /**
   * Plan 07's line to Linear, with no model anywhere in it. Only `linear:*` handlers touch it, and
   * `save_issue` is reached from exactly one of them (`linear:createTicket`, Task 6).
   */
  linear: LinearMcp;
  /** Plan 07's `Draft with Claude` run. A service of its own because it spawns a process and keeps a cancel registry. */
  ticketDraft: LinearTicketDraft;
  /**
   * Plan 09 Task 7. BUILDS the dictation service, handed the one `onUpdate` that can serve it: only
   * this file knows which agent a run was started for, and so only this file can stamp an event with
   * it or know whose session a transcript belongs in. `createHandlers` calls it exactly once, which is
   * what makes the service's lifetime the app run's. `index.ts` keeps what it returns, to `dispose()`
   * on quit.
   */
  createDictation: (onUpdate: (update: DictationUpdate) => void) => DictationService;
  /**
   * Plan 09. Hands `listener` every session state the registry broadcasts, as it changes — the
   * registry's `onState`, fanned out in `index.ts`. `createHandlers` subscribes exactly once, so that
   * a dictation run whose session stops or exits under it is cancelled then and there, rather than
   * holding the microphone for words that could only be dropped.
   */
  onSessionState: (listener: (agentId: Id, state: SessionState) => void) => void;
  /** For `dictation:event`, the one broadcast a handler sends. Main's queued `emit` (`index.ts`). */
  emit: <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => void;
  log: Logger;
  uuid?: () => string;
  now?: () => Date;
}

/**
 * How many `list_teams` pages one `linear:teams` follows. A stop, not a limit anyone should reach:
 * 100 teams a page is already far more than a workspace has, and a server that kept answering
 * `hasNextPage` would otherwise loop for ever inside one IPC reply.
 */
const TEAM_PAGES_MAX = 10;

/**
 * How many `list_issues` pages one `linear:cycleIssues` follows. A stop, not a limit: 50 a page
 * against a measured 7 tickets assigned to the owner in cycle 33 (26 in the cycle altogether).
 */
const CYCLE_PAGES_MAX = 5;

/**
 * `linear:draftTicket`'s answer, cleaned and bounded before it leaves main.
 *
 * `linear-ticket-draft.ts` bounds the LENGTH of what the model wrote, and says in as many words that
 * CLEANING it is `mergeTicketFields`'s job because that is what puts the text in the form — and
 * `mergeTicketFields` runs in the RENDERER. So the one IPC reply in this feature that carries
 * model-written prose crossed the boundary with its control bytes and invisible formatting characters
 * still in it, on the promise that the receiver would clean them. Nothing renders it unmerged today;
 * "nothing renders it today" is not a property, and a main process that hands the renderer text it
 * has not cleaned is one `<pre>` away from being wrong.
 *
 * So the merge runs here too, over an EMPTY `TicketFields` — the same function, not a second copy of
 * its rules, so the two sides cannot drift about what cleaning means. Every step of it is idempotent
 * (strip, trim, slice, round-or-drop), so the renderer's own merge is unchanged and simply has
 * nothing left to do: it stays the thing that decides which of the owner's fields to leave alone.
 *
 * It also makes the boundary independent of the draft service's own bounds: a `LinearTicketDraft` is
 * an injected interface, and this handler is where the wire's guarantee has to hold whatever is
 * behind it.
 */
function cleanDrafted(drafted: DraftedTicketFields): DraftedTicketFields {
  const merged = mergeTicketFields(emptyTicketFields(), drafted);
  return {
    description: merged.description, estimate: merged.estimate, priority: merged.priority,
    teamId: merged.teamId, projectId: merged.projectId,
  };
}

/**
 * A dictation run as `dictation:start` began it: the agent it types into, and that agent's session
 * pid at the time — so a session stopped and started again mid-run is not mistaken for the one the
 * words were meant for.
 */
interface DictationRun {
  agentId: Id;
  pid: number | null;
}

export type Handlers = { [K in IpcRequestKey]: (req: IpcRequests[K]['req']) => Promise<IpcRequests[K]['res']> };

export function createHandlers(deps: HandlerDeps): Handlers {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  /**
   * Plan 07's app-run caches — spec §4's "fetched when the dialog opens and cached for the app run".
   *
   * Here rather than in the renderer because `DialogHost` mounts a fresh `LinearDialog` on every open,
   * so a component-level cache is no cache at all; and rather than in `linear-mcp.ts` because that
   * file is a transport and has no idea what a page or "the owner's list" is. `createHandlers` runs
   * exactly once per app run (`index.ts`), which is what makes this closure the right lifetime.
   *
   * Nothing invalidates them but `refresh` and quitting. That is deliberate: a background refresh is
   * still a REQUEST the owner did not ask for, and §2's rule is that nothing happens unless they
   * press something. `linear:createTicket` prepends its own new ticket (Task 6) so the one change
   * Hangar itself makes is never missing from the list.
   */
  let issueCache: { issues: LinearIssue[]; nextCursor: string | null } | null = null;
  let teamCache: { teams: LinearTeam[] } | null = null;
  /** Plan 08's cycle picker, cached for the app run and dropped by the same `refresh` the list is. */
  let cycleCache: { cycles: LinearCycle[] } | null = null;
  /**
   * Bumped by every `refresh`, and captured before each fetch. A `Load more` and a `Refresh` can be
   * in flight together — the button is one click away from the link — and the page that lands second
   * used to be MERGED into the refreshed list: the owner saw a fresh first page with a stale second
   * one under it, and `nextCursor` came from the chain the refresh had already abandoned, so the next
   * `Load more` paged the old list. A fetch whose generation is no longer the current one writes
   * nothing.
   */
  let cacheGeneration = 0;
  /**
   * What a caller is answered with when its page, or its cursor, belongs to a generation this
   * cache has left behind: the list as main holds it RIGHT NOW, never an empty one invented for
   * the occasion. A refresh does not clear the list, so that is the previous list while the
   * refresh is in flight. Task 4's list can therefore treat every answer as the whole truth — an
   * empty `issues` means the owner has no tickets, not that something is still loading — and the
   * `nextCursor` it carries always belongs to the current chain.
   */
  const cachedList = (): { issues: LinearIssue[]; nextCursor: string | null } => issueCache ?? { issues: [], nextCursor: null };
  /**
   * Every ticket `linear:createTicket` made this app run, newest first.
   *
   * §4 promises that the list the owner is sent back to contains what they have just made, and a
   * one-shot prepend could not keep that promise: a `Refresh` pressed just before Save replaces
   * `issueCache` wholesale when its page lands, and the created row — written before that page
   * arrived — simply vanished. Measured in review. Keeping the rows instead means the promise holds
   * whichever of the two lands second, and it costs one array that grows only when the owner creates
   * a ticket.
   *
   * De-duplicated by identifier against whatever list is being written, and the SERVER's row wins:
   * as soon as a refresh returns the real ticket, the real state, team name and cycle replace the
   * placeholder below. The placeholder only persists while Linear has not yet handed the row back —
   * see `forgetCreated`, without which it persisted for ever and that was its own bug.
   */
  const createdThisRun: LinearIssue[] = [];
  const withCreated = (issues: readonly LinearIssue[]): LinearIssue[] => {
    if (createdThisRun.length === 0) return [...issues];
    const have = new Set(issues.map((i) => i.identifier));
    return [...createdThisRun.filter((i) => !have.has(i.identifier)), ...issues];
  };
  /**
   * Retires a placeholder the moment a server page has carried its identifier.
   *
   * Remembering for ever was the bug: a ticket created this app run was re-prepended to every list
   * written afterwards, so once the owner DELETED it in Linear it came back on the next refresh and
   * no amount of refreshing could clear it — a row for a ticket that does not exist, pinned to the
   * top, for the rest of the app run. The placeholder only ever existed to cover the window between
   * `save_issue` answering and Linear listing the row; a page that carries the identifier closes
   * that window, and from then on the list is Linear's to be right about.
   *
   * PRESENCE is what retires it and absence never does: a `Load more` page legitimately does not
   * contain a ticket that lives on page one, and reading that as a deletion would undo the fix this
   * whole mechanism is.
   */
  const forgetCreated = (rows: readonly LinearIssue[]): void => {
    if (createdThisRun.length === 0) return;
    const returned = new Set(rows.map((i) => i.identifier));
    for (let i = createdThisRun.length - 1; i >= 0; i -= 1) {
      if (returned.has(createdThisRun[i]!.identifier)) createdThisRun.splice(i, 1);
    }
  };
  /**
   * `cycleId -> the whole cycle`. One read per team per app run, serving BOTH callers.
   *
   * It was a `cycleId -> number` map, which was all a ticket row needed. Plan 08's picker needs the
   * dates and `isCurrent` from the same rows, and a second cache for them would be a second read of
   * the same tool that could disagree with this one about the same cycle. The number map
   * `withCycleNumbers` takes is derived from this at the call instead — a handful of entries, built
   * once per page.
   */
  const cycleRows = new Map<string, LinearCycle>();
  const cycleNumberMap = (): Map<string, number> => new Map([...cycleRows].map(([id, c]) => [id, c.number] as const));
  /**
   * The `list_cycles` read per team, memoised by its PROMISE rather than by a "we asked" flag.
   *
   * The flag was set BEFORE the await, so two dialogs opening together both passed the guard: the
   * second saw the team as already fetched, waited for nothing and answered `cycleNumber: null` while
   * the first answered `32`. Two callers disagreeing about the same ticket is a wrong answer, not
   * merely a wasted call, so the second caller now awaits the FIRST caller's read. A team whose read
   * failed keeps its (resolved) entry and is not asked again this app run.
   */
  const cyclesRead = new Map<string, Promise<void>>();
  /**
   * The last `list_cycles` failure per team, so the cycle PICKER can say what went wrong.
   *
   * The ticket list swallows these on purpose — it has a list to show either way. The picker has
   * nothing else, and a blank select reads as "you have no cycles" when the truth is "Linear could
   * not be reached", which sends the owner looking in the wrong place. Cleared with `cyclesRead`.
   */
  const cycleReadErrors = new Map<string, LinearError>();

  const readCycles = (teamId: string, teamName: string): Promise<void> => {
    const pending = cyclesRead.get(teamId);
    if (pending !== undefined) return pending;
    const read = (async (): Promise<void> => {
      try {
        for (const cycle of parseCyclesPayload(await deps.linear.call('list_cycles', listCyclesArgs(teamId)))) {
          // The team is stamped HERE, by the caller that knew which team it asked about: the payload
          // says nothing about it, and a picker offering two teams' "cycle 3" has to tell them apart.
          cycleRows.set(cycle.id, { ...cycle, teamId, teamName });
        }
      } catch (e) {
        // A dead token is the one failure NOT swallowed: it is the owner's to fix, every later call
        // fails the same way, and a silently cycle-less list would hide the reconnect they need to
        // do. The entry is dropped first, so reconnecting is enough to make the next open work.
        if (e instanceof LinearError && e.code === 'LINEAR_REAUTH') {
          cyclesRead.delete(teamId);
          throw e;
        }
        // Everything else is swallowed HERE and remembered: a ticket list with no cycle numbers is a
        // small loss, and failing the whole list because a secondary look-up timed out is a large one.
        // But the cycle PICKER is about nothing else, and an empty select is indistinguishable from
        // "you have no cycles" — so `readCycleList` reads this map and surfaces the failure rather
        // than answering with a blank list. `warn`, not `info`: a request failed and something is
        // silently poorer for it.
        if (e instanceof LinearError) cycleReadErrors.set(teamId, e);
        deps.log.warn(`list_cycles: no cycles for team ${teamId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    cyclesRead.set(teamId, read);
    return read;
  };

  /** Every team on these rows, with the name each row carried — the input to one `readCycles` per team. */
  const teamsOf = (issues: readonly LinearIssue[]): { teamId: string; teamName: string }[] => {
    const teams = new Map<string, string>();
    // `id !== ''` because a row whose `teamId` did not parse would otherwise send `{ teamId: '' }`,
    // a request that can only be refused — once for every team-less row in the list.
    for (const i of issues) if (i.teamId !== '' && !teams.has(i.teamId)) teams.set(i.teamId, i.teamName);
    return [...teams].map(([teamId, teamName]) => ({ teamId, teamName }));
  };

  /** Fills `cycleRows` for every team on this page not already read, then hands the rows back. */
  const resolveCycles = async (issues: readonly LinearIssue[]): Promise<readonly LinearIssue[]> => {
    const wanted = issues.filter((i) => i.cycleId !== null && !cycleRows.has(i.cycleId));
    for (const { teamId, teamName } of teamsOf(wanted)) await readCycles(teamId, teamName);
    return issues;
  };

  /**
   * The application's one write to Linear, sent ONCE.
   *
   * `linear-mcp.ts` keeps `save_issue` out of `RETRYABLE_TOOLS`, so the transport does not resend it;
   * this is the other half of the same rule. A write whose answer never arrived is not a failed write
   * — the request may well have reached Linear and made the ticket — so it is given a code of its own
   * rather than the `LINEAR_TIMEOUT`/`LINEAR_FAILED` every read in this feature uses to mean "press it
   * again". Without that, the renderer's honest response is another Save, and the owner ends up with
   * two tickets and no way to know which press made which.
   *
   * WHICH failures those are is `LinearError.outcome`'s to say, not this file's to infer from a code.
   * Reading it off the code was the original bug and it was live: `LINEAR_FAILED` is raised both for
   * a refusal Linear spelled out and for a 502 or an unreadable 200 body, and the last two were SENT.
   * Answering those as refusals is what puts a Save button back in front of the owner and files the
   * second ticket. So the rule is one line — a request that may have taken effect is never a failure
   * the owner should answer by pressing Save again.
   *
   * The handshake this call may have to make first is itself retried inside `linear-mcp.ts`, and a
   * timeout there provably created nothing. It is not distinguished: over-warning costs the owner one
   * look at Linear, and under-warning costs them a duplicate ticket.
   */
  const unconfirmed = (why: string): IpcError => {
    deps.log.warn(`linear:createTicket: ${why}; the ticket may or may not have been created`);
    return new IpcError(LINEAR_CREATE_UNCONFIRMED, "Linear didn't confirm the ticket, so it may or may not have been created. Check Linear before saving again.");
  };

  const saveIssue = async (args: Record<string, unknown>): Promise<string> => {
    try {
      return await deps.linear.call('save_issue', args);
    } catch (e) {
      if (e instanceof LinearError && e.outcome === 'unknown') throw unconfirmed(`save_issue failed with ${e.code}`);
      throw e;
    }
  };

  /**
   * The create in flight, and the exact request it is sending — see the guard in `linear:createTicket`.
   *
   * The key is the `save_issue` arguments themselves rather than a flag, because an unkeyed guard is
   * how the first version of this lost a ticket: a second Save carrying DIFFERENT fields was handed
   * the first one's answer, so ticket B was never filed and its caller was told it had succeeded as
   * A's identifier. Keying on the request means only a resend of the SAME request is shared.
   */
  let createInFlight: { key: string; promise: Promise<{ identifier: string; url: string }> } | null = null;

  const createTicket = async (fields: TicketFields, args: Record<string, unknown>): Promise<{ identifier: string; url: string }> => {
    // The args are built by the caller and passed in, not rebuilt here, so the request that is sent
    // and the key it was deduplicated under cannot be two different things.
    const created = parseCreatedIssue(await saveIssue(args));
    // A 200 whose payload names no ticket. `save_issue` ANSWERED — this is not a transport failure —
    // so the ticket almost certainly exists and Hangar simply cannot name it. The plan called this
    // `LINEAR_FAILED`; that is the code the form answers with another Save, which is the one thing
    // that must not happen here (deviation P7-6c).
    if (created === null) throw unconfirmed('save_issue answered without an identifier');
    // `teamName` is a DISPLAY field and there is no way to learn it without a request the owner did
    // not ask for (§2), so an app run that has never fetched the teams leaves it empty and the row
    // simply shows no team — the same choice `cycleNumber` already makes. In practice it is filled:
    // the create form's own team picker is `linear:teams`, so anything that could have reached this
    // line has populated the cache.
    const teamName = teamCache?.teams.find((t) => t.id === fields.teamId)?.name ?? '';
    // `cleanTicketTitle`, the same function `saveIssueArgs` sent the title through, and NOT
    // `fields.title.trim()`. This is the one `LinearIssue` in the application that is built rather
    // than parsed, so it is the one that can disagree with the others: trimming alone left a pasted
    // U+202E in the row — reversing everything drawn after it — beside rows `parseIssuesPayload` had
    // cleaned, and showed a title that was not the one Linear had just stored.
    const fresh: LinearIssue = {
      identifier: created.identifier, title: cleanTicketTitle(fields.title), state: 'Backlog', stateType: 'backlog',
      teamId: fields.teamId ?? '', teamName, cycleId: null, cycleNumber: null, updatedAt: now().toISOString(), url: created.url,
    };
    // Remembered first, then applied: the owner goes straight back to a list that must contain what
    // they just made, and a full re-fetch would be a request they did not ask for (§2). Remembering
    // it is what makes that survive a `Refresh` landing after this point — see `createdThisRun`.
    createdThisRun.unshift(fresh);
    if (issueCache !== null) issueCache = { issues: withCreated(issueCache.issues), nextCursor: issueCache.nextCursor };
    return created;
  };

  /** One `list_teams` chain, in flight at most once — two dialogs opening together share it. */
  let teamsRead: Promise<{ teams: LinearTeam[] }> | null = null;

  const readTeams = async (): Promise<{ teams: LinearTeam[] }> => {
    const generation = cacheGeneration;
    const teams: LinearTeam[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < TEAM_PAGES_MAX; page += 1) {
      const answer = parseTeamsPayload(await deps.linear.call('list_teams', listTeamsArgs(cursor)));
      teams.push(...answer.teams);
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    const read = { teams };
    // Cached only after every await, and never over a refresh that happened while they were in
    // flight — the same rule the issue list follows.
    if (generation === cacheGeneration) teamCache = read;
    return read;
  };

  /**
   * `linear:myIssues`, as a function, because `linear:cycles` needs the same cached first page to
   * know which TEAMS to ask `list_cycles` about — and calling it through the handler map from inside
   * another handler would be a second way to reach this logic that nothing checks.
   */
  const readMyIssues = async (req: { cursor?: string; refresh?: boolean }): Promise<{ issues: LinearIssue[]; nextCursor: string | null }> => {
    const refresh = req.refresh === true;
    if (refresh) {
      // Refresh is the owner asking for the current truth, so every DERIVED cache goes: a cycle or
      // a team created since the app started would otherwise never resolve, and a `/mcp` reconnect
      // to a different workspace would leave the old one's names on the rows. The list itself is
      // NOT dropped here — it is replaced when its replacement arrives, so nothing in flight and
      // nothing on screen is ever answered with an empty list that means "still loading".
      teamCache = null;
      cycleRows.clear();
      cyclesRead.clear();
      cycleReadErrors.clear();
      cycleCache = null;
      cacheGeneration += 1;
    }
    // Refresh beats cursor. The pair passes the schema (both fields are optional and independent),
    // and honouring both would collapse the whole list to one page of a chain that no longer exists.
    const sent = refresh ? undefined : req.cursor;
    const paging = sent === undefined ? null : parseStampedCursor(sent);
    // A cursor from a superseded generation is IGNORED rather than fetched. `Load more` and
    // `Refresh` are one click apart and either order reaches here: this is the order where the
    // refresh lands FIRST and the owner then presses a `Load more` button still showing the old
    // list. Its cursor is a position in a chain this cache has abandoned, so paging it would put
    // stale rows under fresh ones and hand back the old chain's next cursor. An unreadable cursor
    // is treated the same way. Both answer from the cache, whose `nextCursor` belongs to the
    // current chain — so the button corrects itself without the renderer having to disable it.
    if (sent !== undefined && (paging === null || paging.generation !== cacheGeneration)) return cachedList();
    const cursor = paging?.cursor ?? null;
    // A cursor is `Load more` and always fetches; no cursor is the dialog opening, which must not.
    if (!refresh && cursor === null && issueCache !== null) return issueCache;
    const generation = cacheGeneration;
    const page = parseIssuesPayload(await deps.linear.call('list_issues', listIssuesArgs(cursor)));
    // A LINEAR_REAUTH from the cycle look-up throws from here and DISCARDS this page, deliberately:
    // the token died between the two calls, so the owner has to reconnect, and caching the page
    // would hide that recovery behind a `Refresh` — the next open would serve the stale, cycle-less
    // list without asking Linear anything. One repeated read is the cheaper loss.
    const rows = withCycleNumbers(await resolveCycles(page.issues), cycleNumberMap());
    // Superseded while this page was in flight — the other order: `Load more` first, `Refresh`
    // second. Dropped for the same reason, and answered the same way.
    if (generation !== cacheGeneration) return cachedList();
    // Assigned AFTER the awaits, so a failed call — a failed REFRESH included — leaves the list the
    // owner was looking at exactly as it was, rather than emptying it.
    // Retired before the write, so a placeholder Linear has now listed stops being re-prepended and
    // a later DELETE of that ticket can actually clear it. Only on pages this cache keeps: a page
    // dropped by the generation guard above is not evidence of anything.
    forgetCreated(rows);
    // `withCreated` is applied to BOTH arms, so a ticket made this app run survives a refresh that
    // replaces the list and a `Load more` that appends to it — and is dropped from the front the
    // moment Linear's own row for it appears in the page.
    issueCache = {
      issues: withCreated(cursor === null ? rows : mergeIssuePages(issueCache?.issues ?? [], rows)),
      nextCursor: stampCursor(generation, page.nextCursor),
    };
    return issueCache;
  };

  /**
   * Spec 2026-09-17 §3 step 2 — the cycles of the teams the owner's tickets are in.
   *
   * The ticket list is read first because it is the only thing that says which teams those ARE, and
   * it is the CACHED FIRST PAGE and only that: opening the cycle step after the dialog has listed
   * tickets costs one `list_cycles` per team and nothing else. The consequence is deliberate — a
   * team whose only assigned ticket sits on a `Load more` page the owner never pressed is not asked
   * about, so its cycles are not offered. Paging the whole list here to widen that would spend reads
   * on every open for a case the owner can fix by pressing `Load more` first. No model is involved
   * on any path through here.
   */
  const readCycleList = async (refresh: boolean): Promise<{ cycles: LinearCycle[] }> => {
    if (refresh) {
      cycleRows.clear();
      cyclesRead.clear();
      cycleReadErrors.clear();
      cycleCache = null;
    }
    if (cycleCache !== null) return cycleCache;
    // Captured BEFORE either await, and re-checked before the cache is written. A
    // `linear:myIssues({refresh: true})` landing mid-fan-out CLEARS `cycleRows`, so the rows this
    // call then assembles are whatever happened to land after the clear — a half-rebuilt list. That
    // is a fine answer to this one caller (it is what main holds right now) and a terrible thing to
    // keep: without this guard it became the app run's cycle list, and only another `refresh` could
    // dislodge it. Same rule as `readTeams` and the issue list.
    const generation = cacheGeneration;
    // This can throw a `LINEAR_*` of its own (the token is dead, Linear is unreachable) and it is
    // deliberately not caught: the picker cannot be built without knowing the teams, and "couldn't
    // reach Linear" is the answer, not an empty select.
    const list = await readMyIssues({});
    const teams = teamsOf(list.issues);
    // Sequential, not `Promise.all`: these are the owner's own account and one dialog's worth of
    // reads, and the ticket list already fans out this way. A `LINEAR_REAUTH` from any team throws.
    for (const { teamId, teamName } of teams) await readCycles(teamId, teamName);
    const cycles = sortCycles([...cycleRows.values()]);
    /**
     * Nothing came back AND something failed: surface the failure instead of an empty list.
     *
     * The three cases this separates are the whole point. **No teams** — the owner has no assigned
     * tickets at all — is an honest empty answer and is NOT an error: there was nothing to ask about
     * and nothing failed. **Some teams answered** is a partial list, which is better than a failure:
     * the cycles that are there are real, and the owner can run one. **Every team failed** is a
     * failure, and it is thrown with Linear's own `LINEAR_*` code and message so the step shows §6's
     * wording — including the reconnect hint for `LINEAR_REAUTH` — rather than a blank select.
     */
    const firstError = [...cycleReadErrors.values()][0];
    if (cycles.length === 0 && firstError !== undefined) throw firstError;
    const read = { cycles };
    if (generation === cacheGeneration) cycleCache = read;
    return read;
  };

  /**
   * §3 step 3 — one cycle's tickets assigned to the owner, all of them.
   *
   * `CYCLE_PAGES_MAX` is a stop, not a limit anyone should reach: 50 a page against a measured 7
   * assigned in cycle 33 (26 in the cycle in total), so five pages is 250 and a server that kept
   * answering `hasNextPage` would otherwise loop for ever inside one IPC reply.
   */
  const readCycleIssues = async (cycleId: string): Promise<{ issues: LinearIssue[] }> => {
    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < CYCLE_PAGES_MAX; page += 1) {
      const answer = parseIssuesPayload(await deps.linear.call('list_issues', listCycleIssuesArgs(cycleId, cursor)));
      issues.push(...answer.issues);
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    // The stop was reached with pages still to come, so this answer is NOT the whole cycle the
    // contract promises — and every count the step then shows (the tick boxes, `Select all`, the
    // number in the button) is short by however much was left. Silently returning a truncated list
    // would make that look like the cycle. `warn`, not `error`: the answer is still usable.
    if (cursor !== null) deps.log.warn(`linear:cycleIssues: cycle ${cycleId} has more than ${CYCLE_PAGES_MAX} pages; the list is truncated`);
    // Deliberately NOT `resolveCycles`: every row here is in the cycle that was asked for, so the
    // only number that could be wanted is one `readCycleList` has already read. A ticket whose cycle
    // this app run has never seen simply shows none, exactly as the ⌘⇧L list does.
    return { issues: withCycleNumbers(issues, cycleNumberMap()) };
  };

  const project = (id: Id): Project => {
    const p = deps.store.get().projects.find((x) => x.id === id);
    if (!p) throw new IpcError('NOT_FOUND', `no project ${id}`);
    return p;
  };
  /**
   * The (project, workspace) pair behind an agent/workspace id pair — the ONLY way any handler in
   * this file learns a filesystem path.
   *
   * Nothing the renderer sends is ever a path to a root. `fs-browse.ts`'s jail is only as strong as
   * the root it is handed, so a handler that took `worktreePath` from the payload would still LOOK
   * jailed while handing back every property Task 1 exists to provide; the same goes for
   * `repoPath`, which decides which repository `git:changes` reads. Both come from the store, keyed
   * by ids that `IdSchema` has already constrained to a filename-safe charset.
   *
   * The PAIRING is what is checked, not the two ids separately: both can exist without belonging
   * together, and checking them independently would open agent a1's drawer onto a worktree owned by
   * a2 (`app:openExternal`'s test has recorded that since Plan 02; the four Phase 2 handlers are
   * asserted against the same case).
   *
   * The workspace's PROJECT is deliberately not resolved here. Returning `{ project, workspace }`
   * and deriving `workspacePath` from it looks tidier and is a behaviour change: a project removed
   * while an agent still references it (`project:remove` does not cascade) would then break
   * `app:openExternal` and the whole Files tab, neither of which needs a project at all. Measured —
   * the eager version failed the pre-existing `app:openExternal` pairing test with `no project p1`.
   * The two `git:*` handlers, which genuinely need `repoPath` and `defaultBranch`, call `project()`
   * themselves and NOT_FOUND is the right answer there.
   */
  const workspaceOf = (agentId: Id, workspaceId: Id): Workspace => {
    const a = deps.store.get().agents.find((x) => x.id === agentId);
    const w = a?.workspaces.find((x) => x.id === workspaceId);
    if (!w) throw new IpcError('NOT_FOUND', `no workspace ${workspaceId} on agent ${agentId}`);
    return w;
  };
  const workspacePath = (agentId: Id, workspaceId: Id): string => workspaceOf(agentId, workspaceId).worktreePath;
  const requireHost = (): void => {
    if (!deps.hostClient.isConnected()) throw new IpcError('HOST_DOWN', 'the session host is not connected');
  };
  /**
   * Spec §16: ids are checked to exist. The realistic caller is not a hostile renderer but a STALE
   * id — an agent deleted while its host session outlived it (§10.5 orphans). Unchecked, `attach`
   * forwarded that id and the host answered with a real snapshot of a session we no longer model, so
   * the pane painted once and then went permanently silent: `session-registry` filters `on('data')`
   * by `knownAgent`, so no later byte, error or exit card ever arrived. `requireAgent` throws
   * `StoreError('NOT_FOUND')`, whose code `toIpcError` forwards unchanged — the same shape
   * `workspacePath` below already produces.
   */
  const requireSessionAgent = (agentId: Id): void => {
    requireAgent(deps.store.get(), agentId);
  };
  /** §6.5: `stopped` and `exited` are the two states with no PTY behind them. */
  const sessionLive = (agentId: Id): boolean => {
    const activity = deps.registry.get(agentId).activity;
    return activity !== 'stopped' && activity !== 'exited';
  };
  /**
   * Text into a session's PTY: the host message `session:write` sends, and the only place in this
   * file that builds it — a dictated transcript goes through here too, so "typed into the pane" means
   * one thing. `data` is sent exactly as given. Nothing is appended, least of all a CR or LF, which
   * the PTY would take as Enter.
   */
  const writeToSession = (agentId: Id, data: string): void => {
    deps.hostClient.send({ t: 'write', id: agentId, data });
  };

  /**
   * Plan 09 Task 7 — which agent each dictation run belongs to, keyed by the service's `runId`.
   *
   * `dictation:event` is a BROADCAST, and G89 is what an unaddressed broadcast costs: a listener that
   * could not tell whose event it was took someone else's result. So main stamps every event with the
   * agent the run was started for, and never with anything it had to infer. An entry is made when a
   * run is claimed and deleted by the update that carries its outcome, so a map entry exists exactly
   * while its run is alive — and a run that has ended can neither be written for again nor lend its
   * agent to the next run.
   */
  const dictationRuns = new Map<number, DictationRun>();
  /**
   * The agent a `dictation:start` is starting a run for, held only while `dictation.start()` runs.
   *
   * The binding cannot wait for `start()` to return the run's id: the service dispatches the run's
   * first update SYNCHRONOUSLY inside `start()`, and a helper that cannot even be spawned reports the
   * whole run, outcome included, before `start()` returns. So the run's own first update claims it.
   */
  let dictationClaim: DictationRun | null = null;
  /**
   * The newest run ever claimed. A claim binds only a run NEWER than this, so an update from a run
   * that has already ended — which the service says cannot arrive, and which would otherwise find
   * the next start's claim waiting — is never stamped with the new agent's id.
   */
  let lastClaimedRun = 0;

  /**
   * Why the session a run was started for can no longer take its transcript, or null if it can. Read
   * when the final ARRIVES, not at start: up to 120 s of speech and a finalize lie between the two,
   * and in that time the agent can be stopped, deleted, or stopped and started again. The last is
   * the pid check — the same agent id, but a PTY that was never dictated into (both pids known and
   * different; a live session whose pid was not yet known at start is given the benefit of the doubt).
   */
  const dictationTargetGone = (run: DictationRun): string | null => {
    if (!deps.hostClient.isConnected()) return 'the session host is not connected';
    if (!deps.store.get().agents.some((a) => a.id === run.agentId)) return 'the agent has been deleted';
    if (!sessionLive(run.agentId)) return 'its session has ended';
    const pid = deps.registry.get(run.agentId).pid;
    if (run.pid !== null && pid !== null && pid !== run.pid) return 'its session was restarted';
    return null;
  };

  /**
   * The transcript into the pane: once, into the session the run was started for, or not at all —
   * and never into a prompt that is waiting for an answer. Returns the outcome to BROADCAST: the
   * service's `write` when the words were typed (or dropped), `copied` when they went to the clipboard
   * instead, so the renderer is never told "typed" about words that were not.
   *
   * **`textToWrite` runs AGAIN here, immediately before either write.** The reducer has already run
   * it, so for the real service this changes nothing; it is here so that "never a control byte in a
   * dictated write" holds at the boundary itself, whatever produced the outcome — `DictationService`
   * is an injected interface, and a CR that reached the PTY would be Enter on a sentence nobody has
   * read. A text that cleans to nothing is the reducer's own rule applied again: `Nothing heard.`, and
   * nothing written. What is broadcast carries the text as it was cleaned, which is what was typed.
   *
   * A session that has gone costs the words and a warning, never a throw and never a write somewhere
   * else. The text itself is never logged.
   *
   * **A permission prompt takes the words as KEYS.** The write is raw keystrokes into the PTY, and a
   * Claude Code permission or approval menu reads a digit or a letter as a choice — "2 files" could
   * answer `2`, and a sentence starting with `y` could approve. That is a misheard sentence starting
   * work by another door (spec §4.3), so while the session's activity is `needs-permission` the text
   * goes to the clipboard, and the renderer says so (`COPIED`). The activity is read at the moment
   * the final ARRIVES, the only moment that matters. It is the hook-reported state, and it stays
   * `needs-permission` until the next hook — after the owner has answered, until the turn ends — so it
   * can copy when typing would have been safe, never the reverse; the words are kept either way.
   */
  const deliverTranscript = (run: DictationRun, outcome: { kind: 'write'; text: string }): DictationOutcome => {
    const text = textToWrite(outcome.text);
    if (text === '') return { kind: 'nothing', message: dictationMessage('NOTHING_HEARD') };
    const typed: DictationOutcome = text === outcome.text ? outcome : { kind: 'write', text };
    const gone = dictationTargetGone(run);
    if (gone !== null) {
      deps.log.warn(`dictation: transcript for agent ${run.agentId} dropped (${text.length} characters): ${gone}`);
      return typed;
    }
    if (deps.registry.get(run.agentId).activity === 'needs-permission') {
      try {
        deps.bridge.writeClipboard(text);
      } catch (e) {
        // Nothing typed, nothing copied: the words are lost, and the renderer must not be told either
        // happened. `CRASHED` is the sentence for a run that did not finish (`Dictation stopped
        // unexpectedly.`). Caught rather than thrown: a throw here would lose the broadcast too, and
        // the pill would sit in `finalizing` for good.
        deps.log.warn(`dictation: transcript for agent ${run.agentId} not copied: ${e instanceof Error ? e.message : String(e)}`);
        return { kind: 'error', code: 'CRASHED', message: dictationMessage('CRASHED') };
      }
      deps.log.info(`dictation: transcript for agent ${run.agentId} copied to the clipboard, not typed (${text.length} characters): the agent is waiting on a permission prompt`);
      return { kind: 'copied', message: dictationMessage('COPIED') };
    }
    try {
      writeToSession(run.agentId, text);
    } catch (e) {
      deps.log.warn(`dictation: transcript for agent ${run.agentId} not written: ${e instanceof Error ? e.message : String(e)}`);
    }
    return typed;
  };

  const onDictationUpdate = (update: DictationUpdate): void => {
    let run = dictationRuns.get(update.runId);
    if (run === undefined && dictationClaim !== null && update.runId > lastClaimedRun) {
      run = dictationClaim;
      dictationRuns.set(update.runId, run);
      lastClaimedRun = update.runId;
    }
    if (run === undefined) {
      // Dropped, not stamped with a guess. With no claim to bind it to, there is no agent this event
      // is known to belong to, and a wrong `agentId` is the one thing this broadcast must not carry.
      deps.log.warn(`dictation: an update for run ${update.runId}, which no dictation:start claimed or which has ended, was dropped`);
      return;
    }
    let { state, outcome } = update;
    if (outcome !== null) {
      // Forgotten BEFORE the write, so that a second delivery of this final finds no run and writes
      // nothing: `outcome` is set on one update per run, and this makes that true here as well.
      dictationRuns.delete(update.runId);
      // Only `write` writes. `cancelled`, `nothing` and `error` are nothing to type. What is broadcast
      // is what HAPPENED to the words, so a `write` that went to the clipboard goes out as `copied` —
      // on the ending `idle` as well, which is what the renderer keeps drawing from.
      if (outcome.kind === 'write') {
        const delivered = deliverTranscript(run, outcome);
        if (delivered !== outcome) {
          outcome = delivered;
          state = { phase: 'idle', outcome: delivered };
        }
      }
    }
    // After the write, so a renderer told the run is over is never ahead of the text it produced.
    deps.emit('dictation:event', { agentId: run.agentId, state, outcome });
  };
  const dictation = deps.createDictation(onDictationUpdate);
  /**
   * A run whose session ENDS under it — `stopped` or `exited`, the two states with no PTY behind them
   * — is cancelled at once. Its words could only be dropped when the final arrived
   * (`dictationTargetGone`), so every second more of listening held the microphone open for nothing,
   * and the pill kept saying `Esc cancels` over an exit card where Escape reaches no terminal. The
   * run is found by its AGENT in `dictationRuns`, which holds an entry exactly while a run is alive,
   * so a session ending after its run has already ended cancels nothing — and neither does another
   * agent's.
   */
  deps.onSessionState((agentId, state) => {
    if (state.activity !== 'stopped' && state.activity !== 'exited') return;
    if (![...dictationRuns.values()].some((r) => r.agentId === agentId)) return;
    deps.log.info(`dictation: the session of agent ${agentId} ${state.activity === 'exited' ? 'exited' : 'stopped'} mid-run; cancelling the run`);
    dictation.cancel();
  });

  return {
    'workspace:get': async () => deps.snapshot(),
    'config:get': async () => deps.config.get(),
    'config:set': async (patch) => deps.config.set(patch),

    'project:add': (req) => deps.agents.addProject(req.repoPath),
    'project:update': async (req) => {
      deps.store.update((ws) => updateProject(ws, req.id, req.patch));
      return project(req.id);
    },
    'project:remove': async (req) => {
      deps.store.update((ws) => removeProject(ws, req.id));
    },
    'project:listBranches': (req) => deps.git.listBranches(project(req.id).repoPath),

    'folder:create': async (req) => {
      const id = uuid();
      deps.store.update((ws) => createFolder(ws, { id, name: req.name, parentId: req.parentId }));
      return deps.store.get().folders.find((f) => f.id === id)!;
    },
    'folder:update': async (req) => {
      deps.store.update((ws) => updateFolder(ws, req.id, req.patch));
      return deps.store.get().folders.find((f) => f.id === req.id)!;
    },
    'folder:move': async (req) => {
      deps.store.update((ws) => moveFolder(ws, req.id, req.parentId, req.beforeId));
    },
    'folder:delete': async (req) => {
      deps.store.update((ws) => deleteFolder(ws, req.id));
    },

    'agent:create': (req) => deps.agents.createAgent(req),
    'agent:update': async (req) => {
      deps.store.update((ws) => updateAgent(ws, req.id, req.patch));
      return deps.store.get().agents.find((a) => a.id === req.id)!;
    },
    'agent:move': async (req) => {
      deps.store.update((ws) => moveAgent(ws, req.id, req.folderId, req.beforeId));
    },
    'agent:delete': (req) => deps.agents.deleteAgent(req.id, req.options),
    'agent:inspectDelete': (req) => deps.agents.inspectDelete(req.id),
    'agent:start': (req) => deps.agents.startAgent(req.id, req.mode),
    'agent:stop': (req) => deps.agents.stopAgent(req.id),
    'agent:markOpened': async (req) => {
      deps.store.update((ws) => updateAgent(ws, req.id, { lastOpenedAt: now().toISOString() }));
    },
    'agent:markViewed': async (req) => {
      requireSessionAgent(req.id);
      deps.registry.apply(req.id, { kind: 'viewed' });
    },
    'agent:addWorkspace': (req) => deps.agents.addWorkspace(req.id, req.projectId, req.baseBranch),
    'agent:inspectRemoveWorkspace': (req) => deps.agents.inspectRemoveWorkspace(req.id, req.workspaceId),
    'agent:removeWorkspace': (req) => deps.agents.removeWorkspace(req.id, req.workspaceId, req.options),

    'layout:set': async (layout) => {
      deps.store.update((ws) => setLayout(ws, layout));
    },

    'session:attach': async (req) => {
      // `requireHost` stays first: with the host down, "the host is not connected" is the more
      // actionable of the two truths, and it is the one the renderer's reconnect banner keys off.
      requireHost();
      requireSessionAgent(req.agentId);
      const reply = await deps.hostClient.request({ t: 'attach', id: req.agentId, cols: req.cols, rows: req.rows });
      if (reply.t !== 'snapshot') throw new IpcError('ATTACH_FAILED', `unexpected reply ${reply.t}`);
      deps.registry.apply(req.agentId, { kind: 'attached', paneIndex: req.paneIndex });
      return { snapshot: reply.data, title: reply.title };
    },
    // Deliberately no `requireHost` here, unlike its three neighbours: detach is cleanup, and it is
    // the one call the renderer makes implicitly (closing a pane). Failing it while the host is down
    // would raise an error toast for a no-op AND skip the local `detached` bookkeeping, which is the
    // half that still matters with no host to talk to.
    'session:detach': async (req) => {
      requireSessionAgent(req.agentId);
      deps.hostClient.send({ t: 'detach', id: req.agentId });
      deps.registry.apply(req.agentId, { kind: 'detached' });
    },
    // `send` is fire-and-forget, so without `requireHost` these resolved `{ok:true}` while the
    // keystroke or the new geometry went nowhere — a silent drop the renderer had no way to notice.
    'session:write': async (req) => {
      requireHost();
      requireSessionAgent(req.agentId);
      writeToSession(req.agentId, req.data);
    },
    'session:resize': async (req) => {
      requireHost();
      requireSessionAgent(req.agentId);
      deps.hostClient.send({ t: 'resize', id: req.agentId, cols: req.cols, rows: req.rows });
    },

    // Spec §12.5. Every one of these four resolves its root from the STORE and passes the renderer's
    // `relPath` only as a path RELATIVE to that root, so `jailPath` is always given a root the
    // renderer did not choose. `shared/ipc-schemas.ts` has already refused an absolute path, a `..`
    // segment and a control character on the wire; that check is lexical, and the jail underneath is
    // physical (it realpaths), which is why both exist.
    //
    // `async` on all four, including the one whose body is a single call: `workspacePath` throws
    // SYNCHRONOUSLY on an unknown id, so a bare `(req) => listDir(...)` threw past the `Promise` its
    // own `Handlers` type promises. `register.ts` happens to `await` inside a `try` and would have
    // caught it, but nothing else that calls a handler is obliged to.
    'fs:list': async (req) => listDir(workspacePath(req.agentId, req.workspaceId), req.relPath, deps.exec, deps.env),
    'fs:read': async (req) => readFileForViewer(workspacePath(req.agentId, req.workspaceId), req.relPath),
    'git:changes': async (req) => {
      const workspace = workspaceOf(req.agentId, req.workspaceId);
      const p = project(workspace.projectId);
      return deps.diff.changes(p.repoPath, workspace.worktreePath, p.defaultBranch);
    },
    'git:fileDiff': async (req) => {
      const workspace = workspaceOf(req.agentId, req.workspaceId);
      const p = project(workspace.projectId);
      // `mergeBaseFor`, not a local copy of the `origin/<default>` rule: the renderer clicks a row
      // from `git:changes`, so the two calls must agree on the base or the file's diff describes a
      // different comparison than the list that offered it. The base is resolved in MAIN rather
      // than round-tripped through the renderer for the same reason the roots above are.
      const mergeBase = await deps.diff.mergeBaseFor(p.repoPath, workspace.worktreePath, p.defaultBranch);
      return deps.diff.fileDiff(workspace.worktreePath, mergeBase, req.relPath);
    },

    // Plan 06. A `TriageError` rejects straight through: `register.ts`'s `toIpcError` keeps its
    // `code` and `detail`, and the renderer needs `CANCELLED` intact to show nothing (spec §8).
    'linear:triage': (req) => deps.triage.run(req.requestId, req.ref),
    // Both registries: the payload is a request id, an unknown id is a no-op in each, and a second
    // key whose only difference is which map it looks in would be a way to cancel the wrong thing.
    'linear:cancel': async (req) => {
      deps.triage.cancel(req.requestId);
      deps.ticketDraft.cancel(req.requestId);
    },
    'linear:myIssues': (req) => readMyIssues(req),
    'linear:cycles': (req) => readCycleList(req.refresh === true),
    'linear:cycleIssues': (req) => readCycleIssues(req.cycleId),
    'linear:teams': async () => {
      if (teamCache !== null) return teamCache;
      teamsRead ??= readTeams().finally(() => { teamsRead = null; });
      return teamsRead;
    },
    // Cleaned on the way out — see `cleanDrafted`. A `DraftError` rejects straight through, the way
    // `linear:triage`'s does: `toIpcError` keeps its `code`, and the form needs `CANCELLED` intact.
    'linear:draftTicket': async (req) => cleanDrafted(await deps.ticketDraft.draft(req.requestId, req.title)),
    /**
     * The only `save_issue` in the codebase. The checks before it are not ceremony: `ticketFieldsProblem`
     * is the same function the form's Save button is gated on, so a create that could not be a ticket
     * never reaches Linear even if the renderer is wrong about its own button.
     */
    'linear:createTicket': async (req) => {
      const problem = ticketFieldsProblem(req.fields);
      // Per call, and BEFORE the guard below: a second press carrying fields that could not be a
      // ticket is its own answer, not something to share the first press's ticket with.
      if (problem !== null) throw new IpcError('BAD_REQUEST', problem);
      /**
       * Single-flight, keyed on the request. Two Saves at once sent two `save_issue` calls and made
       * two tickets (measured), and the form disabling its own button is not the guarantee: this
       * file's rule is that the form is a courtesy and the wire is what has to hold.
       *
       * Only an IDENTICAL resend is shared — a double-click asked for one ticket, so one ticket is
       * what it gets. A concurrent press carrying different fields is a different ticket, and it is
       * refused as `BUSY` rather than handed this one's answer: the first version of this guard was
       * unkeyed and did hand it over, which meant a ticket the owner watched succeed did not exist
       * and they had no reason ever to look for it. `BUSY` leaves their typing in the form to press
       * again in a moment, which is the recoverable failure of the two.
       */
      const args = saveIssueArgs(req.fields);
      const key = JSON.stringify(args);
      if (createInFlight !== null) {
        if (createInFlight.key !== key) throw new IpcError('BUSY', 'Another ticket is still being created. Wait for it to finish, then save this one.');
        return createInFlight.promise;
      }
      const promise = createTicket(req.fields, args).finally(() => { createInFlight = null; });
      createInFlight = { key, promise };
      return promise;
    },

    // Plan 09 Task 7 (spec 2026-09-18 §4).
    'dictation:start': async (req) => {
      // `session:write`'s two guards, in its order, and then the one it can do without: a keystroke
      // sent to a dead session is lost at once, but a dictation would hold the microphone open for up
      // to 120 s to type into nothing. All three refuse before anything is spawned. Their messages
      // are for the log; the renderer says `dictationRefusal(code)` from `shared/dictation.ts`.
      requireHost();
      requireSessionAgent(req.agentId);
      if (!sessionLive(req.agentId)) throw new IpcError('NOT_RUNNING', 'the agent has no running session to dictate into');
      dictationClaim = { agentId: req.agentId, pid: deps.registry.get(req.agentId).pid };
      try {
        // `DICTATION_BUSY` and `DICTATION_DISPOSED` reject straight through with their codes. A
        // refused start reports nothing, so its claim is never taken and the `finally` drops it.
        dictation.start();
      } finally {
        dictationClaim = null;
      }
    },
    // No guards on these two: stopping and cancelling have to work whatever state the host or the
    // agent is in — cancel is what lets go of the microphone. A press that races the run's own end
    // is a no-op, and the broadcast has already told the renderer where things stand.
    'dictation:stop': async () => {
      dictation.stop();
    },
    'dictation:cancel': async () => {
      dictation.cancel();
    },

    'app:pickFolder': (req) => deps.bridge.pickFolder(req?.title),
    'app:openExternal': async (req) => {
      const path = workspacePath(req.agentId, req.workspaceId);
      const env = { PATH: deps.shellEnv().path };
      if (req.target === 'finder') {
        deps.bridge.showItemInFolder(path);
      } else if (req.target === 'terminal') {
        await deps.exec('open', ['-a', 'Terminal', path], { env });
      } else {
        try {
          await deps.exec('code', [path], { env });
        } catch (e) {
          // Both arms can fail, and until this was logged the whole operation was invisible even in
          // `app.log` — the user saw a button that did nothing. The fallback's own failure still
          // propagates to the renderer as a toast.
          deps.log.warn(`app:openExternal: 'code' failed for ${path}: ${e instanceof Error ? e.message : String(e)}; trying 'open -a'`);
          await deps.exec('open', ['-a', 'Visual Studio Code', path], { env });
        }
      }
    },
    'app:copyToClipboard': async (req) => {
      deps.bridge.writeClipboard(req.text);
    },
    'app:windowFocused': async (req) => {
      deps.registry.setWindowFocused(req.focused);
    },
    /**
     * §12.8's free-space figure, and the only measurement behind §12.7's low-disk banner.
     *
     * WHICH volume: `worktreesDir`, the same path `agent-service.create`'s 2 GB preflight measures.
     * A project's repo can sit on another volume, but the bytes an agent consumes land under
     * HANGAR_HOME — the worktree, the copied `node_modules`, the cloned dirs — so this is the
     * volume that fills. Measuring anything else would let the strip read healthy while Create
     * refuses, or the reverse.
     *
     * Synchronous, and that is the reason this is a REQUEST rather than a field on the snapshot:
     * `WorkspaceSnapshot` is rebuilt and broadcast on every workspace and session change, and a
     * `statfs` on each of those would put a syscall on the hot path for a number that changes on a
     * human timescale. The renderer asks once a minute while its window is visible.
     */
    'app:diskFree': async () => ({ freeBytes: freeBytes(deps.paths.worktreesDir), path: deps.paths.worktreesDir }),
    'host:status': async () => deps.hostStatus(),
    'host:restart': (req) => deps.restartHost(req.killSessions),
  };
}
