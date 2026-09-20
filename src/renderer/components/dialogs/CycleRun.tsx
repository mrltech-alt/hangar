import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOW_DISK_WARN, lowDiskText } from '../../../../shared/disk.ts';
import {
  buttonLabel, currentCycle, cycleLabel, failedIdentifiers, initialSelection, planSummary,
  rowStatusText, runSummary, selectedIdentifiers, setAll, sortCycles,
  type RunStop, type TicketRowState,
} from '../../../../shared/linear-cycle-run.ts';
import { cycleFolderName } from '../../../../shared/linear-draft.ts';
import { agentForIssue, isDoneOrCancelled, type LinearCycle, type LinearIssue } from '../../../../shared/linear-issues.ts';
import type { Agent } from '../../../../shared/types.ts';
import { run, runResult } from '../../lib/api.ts';
import { createAgentSequence } from '../../lib/create-agent.ts';
import { useConfig } from '../../stores/config.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { DialogActions } from '../ui/Dialog.tsx';
import { Field, Select } from '../ui/Field.tsx';

/** Hoisted, never a `?? []` inside a selector — G61. */
const EMPTY_AGENTS: readonly Agent[] = [];

/** The ticket list's accessible name — a group of tick boxes with no name is a group of nothing. */
const TICKETS_LABEL = 'Assigned to you in this cycle';

let lastRun = 0;
/**
 * The id `linear:cancel` names a look-up by. A time and a counter, as `LinearDialog`'s ids are:
 * unique within this renderer, `IdSchema`-safe by construction, no secure context needed.
 */
function nextRunId(): string {
  lastRun += 1;
  return `cycle-${Date.now().toString(36)}-${lastRun}`;
}

/**
 * Spec 2026-09-17 — a folder of agents from one Linear cycle.
 *
 * Two halves with very different costs, and the whole step is built around the difference.
 * **Choosing a cycle and ticking boxes is free**: `linear:cycles` and `linear:cycleIssues` are MCP
 * reads with no model in them at all. Pressing the button spends ~33 s and ~$0.22-equivalent per
 * ticked ticket, which is why the line above it says the count and a rough time before anything runs.
 *
 * Nothing here decides anything: `shared/linear-cycle-run.ts` owns the labels, the tick-box defaults,
 * the plan order and every sentence this component shows.
 */
export function CycleRun({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const agents = useWorkspace((s) => s.snapshot?.workspace.agents ?? EMPTY_AGENTS);
  const [cycles, setCycles] = useState<readonly LinearCycle[]>([]);
  const [cyclesBusy, setCyclesBusy] = useState(true);
  const [cyclesError, setCyclesError] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly LinearIssue[]>([]);
  const [issuesBusy, setIssuesBusy] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  // `'choosing'` is the picker; `'running'` locks it; `'done'` is the summary. Not three components:
  // the rows are the same list with a status column, and re-mounting them would lose the tick boxes.
  const [phase, setPhase] = useState<'choosing' | 'running' | 'done'>('choosing');
  const [rows, setRows] = useState<Record<string, TicketRowState>>({});
  const [stopped, setStopped] = useState<RunStop | null>(null);
  /** The banner's own sentence when the run stopped for disk — spec §4 says the same message. */
  const [diskText, setDiskText] = useState<string | null>(null);
  const defaultMode = useConfig((s) => s.config.defaultPermissionMode);
  /** Cancel was pressed (or the dialog closed). A ref: the loop reads it between tickets, not on a render. */
  const cancelling = useRef(false);
  /** The look-up in flight, so Cancel and the unmount cleanup can abort it. */
  const pending = useRef<string | null>(null);
  /** `initialFocus` ran at `showModal()`, long before this step existed — it takes the caret itself (G62). */
  const cycleRef = useRef<HTMLSelectElement>(null);
  /** Once, when the list first arrives — never again, or every re-list would steal the caret back. */
  const placedCaret = useRef(false);
  /** Still mounted? An answer that lands after the step is gone has nothing to set. Set on the way IN too (G65). */
  const alive = useRef(true);
  /** Numbers the ticket reads, so an answer from a cycle the owner has since left is dropped, not drawn. */
  const issueSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // A `claude -p` nobody is watching is still running and still spending usage — the same reason
      // `LinearDialog` cancels a single look-up on unmount. Agents already created stay.
      cancelling.current = true;
      if (pending.current !== null) void run('linear:cancel', { requestId: pending.current });
      pending.current = null;
    };
  }, []);

  /**
   * Stable by construction — it closes over nothing but setters and refs, which React keeps
   * identical for the life of the component. That is what lets the effects below depend on it
   * honestly and still run once each, the shape `LinearDialog`'s `loadIssues` already uses.
   */
  const loadIssues = useCallback(async (id: string): Promise<void> => {
    const seq = issueSeq.current + 1;
    issueSeq.current = seq;
    setIssuesBusy(true);
    setIssuesError(null);
    // A no-op `onError`: a cycle that would not list is a line in this step, not a toast behind it.
    const result = await runResult('linear:cycleIssues', { cycleId: id }, () => undefined);
    if (!alive.current || seq !== issueSeq.current) return;
    setIssuesBusy(false);
    if (!result.ok) {
      setIssues([]);
      setSelection({});
      setIssuesError(result.error.message);
      return;
    }
    setIssues(result.value.issues);
    // The tick boxes are computed against the agents as they are RIGHT NOW. The run re-checks each
    // one again immediately before it creates (§4), because "now" moves while a run is going.
    setSelection(initialSelection(result.value.issues, useWorkspace.getState().snapshot?.workspace.agents ?? []));
  }, []);

  /**
   * The cycles. §2: this runs because the owner pressed `Whole cycle…`, so it is a read they asked
   * for — and it is the same call `Retry` makes, which is why it is a callback rather than an
   * effect body. Stable by construction (setters and refs only), so the mount effect below depends
   * on it honestly and still runs once.
   */
  const loadCycles = useCallback(async (refresh: boolean): Promise<void> => {
    setCyclesBusy(true);
    setCyclesError(null);
    // A no-op `onError`: the failure belongs in this step, beside the Retry that answers it.
    const result = await runResult('linear:cycles', { refresh }, () => undefined);
    if (!alive.current) return;
    setCyclesBusy(false);
    if (!result.ok) {
      // Linear's own §6 wording, including the `run /mcp in any agent` hint a LINEAR_REAUTH carries.
      // Distinct from an empty-but-successful answer below, which is not a failure and offers no Retry.
      setCyclesError(result.error.message);
      setCycles([]);
      setCycleId(null);
      setIssues([]);
      setSelection({});
      return;
    }
    setCyclesError(null);
    setCycles(result.value.cycles);
    // `currentCycle` decides, not this component: `isCurrent` is a per-TEAM flag, so a fan-out can
    // bring back three rows claiming to be current and a team between cycles brings back none.
    // Choosing for the owner is the point — "get cycle 33 down" is meant to be one press.
    const start = currentCycle(result.value.cycles);
    if (start === null) {
      setCycleId(null);
      setIssues([]);
      setSelection({});
      return;
    }
    setCycleId(start.id);
    await loadIssues(start.id);
  }, [loadIssues]);

  useEffect(() => {
    void loadCycles(false);
  }, [loadCycles]);

  /**
   * The caret, once the select has options to move through.
   *
   * Deliberately an effect and not a `focus()` inside `loadCycles`: the select is `disabled` until
   * there is something to choose, and at the moment that answer lands the state that un-disables it
   * has not committed yet — so focusing there is a call on a still-disabled control, which a browser
   * ignores. (jsdom would not notice either way: it implements no focusability rule at all, G66.)
   */
  useEffect(() => {
    if (cycles.length === 0 || placedCaret.current) return;
    placedCaret.current = true;
    cycleRef.current?.focus();
  }, [cycles]);

  /**
   * Derived AFTER subscribing, never inside a selector (G59): every one of these allocates.
   *
   * `ordered` is memoised rather than sorted in the render body because `cycleLabel`'s ambiguity
   * memo is keyed on the ARRAY's identity — a fresh array per render would re-run its O(n²) scan
   * every time. Main sorts too; sorting again is what makes the picker's order this component's own
   * promise rather than a handler's, and `sortCycles` de-duplicates a cycle two teams both returned.
   */
  const ordered = useMemo(() => sortCycles(cycles), [cycles]);
  const chosen = ordered.find((c) => c.id === cycleId) ?? null;
  const hasAgent = useMemo(() => new Set(issues.filter((i) => agentForIssue(agents, i.identifier) !== undefined).map((i) => i.identifier)), [issues, agents]);
  /**
   * The plan, re-derived from the agents as they are NOW rather than from the tick boxes alone.
   *
   * A ticket that gains an agent while this step is open — another window, a single-ticket create —
   * is one the run will skip, so counting it would make `Create 7 agents` a promise of seven when
   * six is what would happen. Its box unticks and disables for the same reason.
   */
  const picked = useMemo(() => selectedIdentifiers(issues, selection).filter((i) => !hasAgent.has(i)), [issues, selection, hasAgent]);
  /**
   * The summary's numbers, counted from the ROWS rather than kept in counters beside them.
   *
   * That is what makes `Retry failed` finish the run it is retrying instead of describing itself:
   * the rows are merged across passes, so the ticket the first pass created is still one of the
   * three. A `saved` row counts as created — the agent exists — and is named separately, because
   * "3 of 3" would otherwise hide the one the owner has to go and look at.
   */
  const tally = useMemo(() => {
    let done = 0;
    let unfinished = 0;
    for (const row of Object.values(rows)) {
      if (row.kind === 'created') done += 1;
      else if (row.kind === 'saved') { done += 1; unfinished += 1; }
    }
    return { created: done, attempted: Object.keys(rows).length, unfinished };
  }, [rows]);

  const toggle = (identifier: string): void => setSelection((s) => ({ ...s, [identifier]: s[identifier] !== true }));

  /** `setRows` for one ticket. A function update, because the loop writes between renders. */
  const mark = (identifier: string, state: TicketRowState): void => setRows((r) => ({ ...r, [identifier]: state }));

  /** The agents as they are NOW, not as the last commit saw them: the loop runs between renders. */
  const agentExists = (identifier: string): boolean =>
    agentForIssue(useWorkspace.getState().snapshot?.workspace.agents ?? [], identifier) !== undefined;

  /**
   * §3 step 5 and §4 — the run.
   *
   * **Strictly sequential.** Each iteration awaits its own look-up before the next starts, and there
   * is deliberately no `Promise.all` anywhere near this: each look-up is a `claude -p`, the owner's
   * machine is also running their own agents, and one at a time is what keeps the running cost
   * legible as well as the machine usable.
   */
  const runTickets = async (plan: readonly string[]): Promise<void> => {
    cancelling.current = false;
    setPhase('running');
    setStopped(null);
    setDiskText(null);
    // MERGED, not replaced: a `Retry failed` is the same run carrying on, so the tickets it is not
    // re-running keep their rows and their place in the count.
    setRows((r) => ({ ...r, ...Object.fromEntries(plan.map((id) => [id, { kind: 'waiting' } as TicketRowState])) }));
    for (const identifier of plan) {
      if (cancelling.current) {
        if (alive.current) setStopped('cancel');
        break;
      }
      // §4's "never twice", the cheap half: an agent that is already there costs this ticket
      // nothing at all — not a look-up, not even a `statfs`. The expensive half is the re-check
      // below, which is the one the rule is actually about.
      if (agentExists(identifier)) {
        if (alive.current) mark(identifier, { kind: 'skipped' });
        continue;
      }
      // §4's disk stop, BEFORE the look-up rather than after it: a look-up that cannot become an
      // agent is 33 s and $0.22 spent for nothing. The banner's own threshold and its own sentence —
      // `shared/disk.ts` is the one place either is written.
      const disk = await runResult('app:diskFree', undefined, () => undefined);
      if (!alive.current) return;
      if (disk.ok && disk.value.freeBytes < LOW_DISK_WARN) {
        setStopped('disk');
        setDiskText(lowDiskText(disk.value.freeBytes));
        break;
      }
      // An unknown free-space figure carries on rather than stopping the run: `app:diskFree` is a
      // `statfsSync` that has no business ending a run of agents, and `agent:create` enforces
      // LOW_DISK itself. It is logged, though — spending on a guess is worth being able to see.
      if (!disk.ok) console.warn('cycle run: could not read free space, carrying on', disk.error.message);
      // Cancel is a press, and a press lands whenever it lands — including inside the await above.
      // Without this, a cancelled run still started a fresh `claude -p` and still made an agent.
      if (cancelling.current) {
        setStopped('cancel');
        break;
      }
      const requestId = nextRunId();
      pending.current = requestId;
      if (alive.current) mark(identifier, { kind: 'looking-up' });
      // A no-op `onError`: a failure belongs in this ticket's own row, not in a toast over the run.
      const draft = await runResult('linear:triage', { requestId, ref: identifier }, () => undefined);
      pending.current = null;
      if (!alive.current) return;
      if (!draft.ok) {
        // §3 step 5: a failed ticket does not stop the run. A CANCELLED look-up is the owner's own
        // stop, so the row says `cancelled` rather than accusing the ticket of failing — and rather
        // than sitting on `looking up…` for ever, which is what it did before.
        if (draft.error.code === 'CANCELLED') mark(identifier, { kind: 'cancelled' });
        else mark(identifier, { kind: 'failed', message: draft.error.message });
        if (cancelling.current) {
          setStopped('cancel');
          break;
        }
        continue;
      }
      // The look-up answered anyway — `linear:cancel` is a race main can lose — and the draft is
      // thrown away rather than turned into an agent the owner has just said they do not want.
      if (cancelling.current) {
        mark(identifier, { kind: 'cancelled' });
        setStopped('cancel');
        break;
      }
      /**
       * §4's "never twice" again, and this is the check the rule means: re-checked against the
       * CURRENT snapshot rather than the one the tick boxes — or the check above — were computed
       * from. A look-up is half a minute long, and an agent for this ticket can appear inside it:
       * another window, a single-ticket create, or this run's own earlier pass after a
       * `Retry failed`. Read through `getState()`, not the subscribed `agents`, because this loop
       * runs between renders and the subscribed value is as old as the last commit.
       */
      if (agentExists(identifier)) {
        mark(identifier, { kind: 'skipped' });
        continue;
      }
      mark(identifier, { kind: 'creating' });
      const outcome = await createAgentSequence({
        name: draft.value.name,
        // The RUN's folder, not the draft's: a draft carries the folder for the ticket's own cycle
        // (or root, when triage found none), and this run is about the cycle the owner chose.
        // `folderNamed`'s re-check is what makes it exactly once across the whole run.
        folder: chosen === null ? { kind: 'root' } : { kind: 'new', name: cycleFolderName(chosen.number) },
        rows: draft.value.rows.map((r) => (r.kind === 'existing' ? { kind: 'existing' as const, projectId: r.projectId, baseBranch: '' } : { kind: 'new' as const, repoPath: r.repoPath, name: r.name, baseBranch: '' })),
        notes: draft.value.notes,
        permissionMode: defaultMode === null || defaultMode === 'default' ? null : defaultMode,
        // §1: worktrees are created, Claude is not started — for a whole folder of agents at once,
        // that is not a preference, it is the difference between a folder and a fork bomb.
        startNow: false,
      });
      if (!alive.current) return;
      if (!outcome.ok) {
        // `create-agent.ts`: `saved` means the agent record was committed before the failure, so the
        // agent EXISTS. Running this ticket again would make a SECOND agent for it, which is why it
        // gets a row of its own that `failedIdentifiers` — and so `Retry failed` — leaves alone.
        mark(identifier, outcome.saved ? { kind: 'saved', message: outcome.message } : { kind: 'failed', message: outcome.message });
        continue;
      }
      // The agent exists and is usable either way; its notes are not worth failing the row over, and
      // a toast per ticket in a run of seven would bury the run itself.
      mark(identifier, { kind: 'created', name: outcome.notesFailed === null ? outcome.agent.name : `${outcome.agent.name} (notes not saved)` });
    }
    if (!alive.current) return;
    setPhase('done');
    pending.current = null;
  };

  const cancelRun = (): void => {
    cancelling.current = true;
    if (pending.current !== null) void run('linear:cancel', { requestId: pending.current });
  };

  /**
   * Back to the picker, and the run that was showing is OVER.
   *
   * Everything the run left has to go with it, because `runTickets` MERGES: rows, the stop and its
   * banner line. Without this, cycle 33's two agents were counted into the next press — measured,
   * `Created 3 of 3 agents in "Cycle 32"` for a run of one — and a low-disk line from the last run
   * sat over a picker it had nothing to do with.
   *
   * Clearing rather than filtering the tally by the current `issues`: a press of `Create N agents`
   * is a new run, and only `Retry failed` continues one. Filtering would still fold the old rows in
   * when the owner comes back to the SAME cycle, and it would not touch `stopped` or `diskText`.
   */
  const backToPicker = (): void => {
    setPhase('choosing');
    setRows({});
    setStopped(null);
    setDiskText(null);
  };

  const retry = failedIdentifiers(issues, rows);

  return (
    <div>
      <Field label="Cycle">
        <Select
          ref={cycleRef}
          aria-label="Cycle"
          value={cycleId ?? ''}
          // Locked while a run goes: re-listing would leave the run's rows keyed to a cycle the run
          // is not about, and its plan is already a list of identifiers this one may not contain.
          disabled={cyclesBusy || ordered.length === 0 || phase !== 'choosing'}
          onChange={(e) => { setCycleId(e.target.value); void loadIssues(e.target.value); }}
        >
          {ordered.map((c) => <option key={c.id} value={c.id}>{cycleLabel(c, ordered)}</option>)}
        </Select>
      </Field>
      {cyclesError ? (
        <div className="mb-3 flex items-baseline gap-2">
          {/* `role="status"`, like the ticket list's own failure line: the spinners here are
              aria-hidden, so without it a step that would not load is announced to nobody. */}
          <p role="status" className="min-w-0 flex-1 text-[11px] text-red select-text">{cyclesError}</p>
          {/* `refresh: true`, not a plain re-read: main caches the picker for the app run — a team
              whose `list_cycles` failed keeps its entry — so a bare re-read rethrows the same
              failure without asking Linear anything, and the button would do nothing for ever. */}
          <Button variant="ghost" className="h-5 shrink-0 px-1.5 text-[11px]" disabled={cyclesBusy} onClick={() => void loadCycles(true)}>Retry</Button>
        </div>
      ) : null}

      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium text-fg-2">{TICKETS_LABEL}</span>
        {cyclesBusy || issuesBusy ? <LoaderCircle aria-hidden size={11} className="animate-spin text-muted" /> : null}
        <span className="flex-1" />
        <Button variant="ghost" className="h-5 px-1.5 text-[11px]" disabled={issues.length === 0 || phase !== 'choosing'} onClick={() => setSelection(setAll(issues, true))}>Select all</Button>
        <Button variant="ghost" className="h-5 px-1.5 text-[11px]" disabled={issues.length === 0 || phase !== 'choosing'} onClick={() => setSelection(setAll(issues, false))}>Select none</Button>
      </div>
      {issuesError ? <p role="status" className="mb-2 text-[11px] text-red select-text">{issuesError}</p> : null}
      {/* A named group, and `aria-busy` rather than the spinner alone: that spinner is `aria-hidden`,
          so a list that is still loading is otherwise announced to nobody. */}
      <div role="group" aria-label={TICKETS_LABEL} aria-busy={cyclesBusy || issuesBusy} className="mb-3 max-h-56 overflow-y-auto rounded-md border border-line">
        {issues.map((issue) => {
          const dim = isDoneOrCancelled(issue);
          return (
            <label key={issue.identifier} className={`flex w-full items-baseline gap-1.5 px-2 py-1 text-[12px]${dim ? ' opacity-50' : ''}`}>
              <input
                type="checkbox"
                data-ticket={issue.identifier}
                className="accent-accent"
                // A ticket that already has an agent is not plannable — the run skips it — so the
                // box says so instead of staying ticked over a promise the run will not keep.
                checked={selection[issue.identifier] === true && !hasAgent.has(issue.identifier)}
                disabled={phase !== 'choosing' || hasAgent.has(issue.identifier)}
                onChange={() => toggle(issue.identifier)}
              />
              <span className="shrink-0 font-medium text-fg">{issue.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{issue.title}</span>
              {issue.state === '' ? null : <span className="shrink-0 text-[11px] text-muted">{issue.state}</span>}
              {hasAgent.has(issue.identifier) ? <span className="shrink-0 rounded bg-bg-3 px-1 text-[10px] text-accent">agent exists</span> : null}
              {rows[issue.identifier] === undefined ? null : (
                <span className="shrink-0 text-[11px] text-muted">{rowStatusText(rows[issue.identifier]!)}</span>
              )}
            </label>
          );
        })}
        {issues.length === 0 && !issuesBusy && !cyclesBusy && issuesError === null && cyclesError === null ? (
          <p className="px-2 py-2 text-[11px] text-muted">
            {/* Three different truths, three different sentences, and BOTH failure states are
                gated out above — a cycle list that would not load leaves `cycles` empty, so without
                `cyclesError === null` the step said "no cycles found" directly beneath Linear's own
                "couldn't reach Linear", which is the one confusion §3 step 2 exists to prevent. */}
            {ordered.length === 0 ? 'No cycles found for your teams.' : 'No tickets in this cycle are assigned to you.'}
          </p>
        ) : null}
      </div>

      {/* `role="status"`: this line changes under the owner every time a box is ticked, and with a
          bare <p> that change is silent to a screen reader.

          Announced in every phase but `running`, where the same line is a LIVE tally: "Created 0 of
          3 agents" read out while the run is still going says the run has finished and made nothing,
          and it would say it again at every ticket. The rows carry the run; the summary announces
          how it ended. */}
      {chosen === null ? null : (
        <p role={phase === 'running' ? undefined : 'status'} className={`mb-3 text-[11px] ${phase === 'done' ? 'text-fg' : 'text-muted'}`}>
          {phase === 'choosing'
            ? planSummary(picked.length, chosen.number)
            : runSummary({ created: tally.created, attempted: tally.attempted, cycleNumber: chosen.number, stopped, unfinished: tally.unfinished })}
        </p>
      )}
      {/* The banner's own sentence, verbatim, so the two places that talk about low disk agree. */}
      {diskText === null ? null : <p className="mb-3 rounded-md bg-red/10 p-2 text-[11px] text-red select-text">{diskText}</p>}
      <DialogActions>
        {/* Two Backs, one place: out of the step while choosing, and back to the picker from the
            summary — a finished run otherwise leaves Done as the only way out, so choosing another
            cycle means reopening the dialog. The run goes with it: see `backToPicker`. */}
        {phase === 'choosing' ? <Button variant="ghost" onClick={onBack}>Back</Button> : null}
        {phase === 'done' ? <Button variant="ghost" onClick={backToPicker}>Back</Button> : null}
        <span className="flex-1" />
        {phase === 'choosing' ? (
          <>
            <Button variant="ghost" onClick={onDone}>Cancel</Button>
            <Button variant="primary" disabled={picked.length === 0 || chosen === null} onClick={() => void runTickets(picked)}>{buttonLabel(picked.length)}</Button>
          </>
        ) : phase === 'running' ? (
          // Not "Cancel": the dialog's own Cancel is one row up in every other step, and a run that
          // has already made agents is not cancelled in the sense that word usually promises.
          <Button variant="primary" onClick={cancelRun}>Cancel run</Button>
        ) : (
          <>
            {retry.length === 0 ? null : <Button variant="ghost" onClick={() => void runTickets(retry)}>Retry failed</Button>}
            <Button variant="primary" onClick={onDone}>Done</Button>
          </>
        )}
      </DialogActions>
    </div>
  );
}
