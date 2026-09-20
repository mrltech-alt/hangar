import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { manualDraft } from '../../../../shared/linear-draft.ts';
import {
  agentForIssue, emptyTicketFields, filterIssues, isDoneOrCancelled,
  type LinearIssue, type TicketFields,
} from '../../../../shared/linear-issues.ts';
import { parseLinearRef } from '../../../../shared/linear-ref.ts';
import type { Agent } from '../../../../shared/types.ts';
import { openAgent } from '../../lib/agent-actions.ts';
import { run, runResult } from '../../lib/api.ts';
import { useConfig } from '../../stores/config.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Field, TextInput } from '../ui/Field.tsx';
import { CycleRun } from './CycleRun.tsx';
import { NewTicketForm } from './NewTicketForm.tsx';

const INVALID_REF = "That doesn't look like a Linear link or ticket ID.";
const PICKER_TITLE = 'Choose your repos folder';

/**
 * Hoisted, and not a `?? []` inside the selector — G61. The fallback path is reachable exactly once,
 * before `workspace:get` answers, which is also the only moment a ⌘⇧L can land on an empty store; an
 * inline literal there is a new array on every commit and zustand 5 re-renders forever.
 */
const EMPTY_AGENTS: readonly Agent[] = [];

/**
 * The create form's fields before anything is typed. Hoisted for the same reason as `EMPTY_AGENTS`
 * (G61): `?? emptyTicketFields()` inside a selector is a new object on every commit, and zustand 5
 * re-renders for ever on one of those. Nothing mutates it — every update makes a new object.
 */
const NO_TICKET: TicketFields = emptyTicketFields();

let lastRequest = 0;
/**
 * The id `linear:cancel` names a run by. A time and a counter rather than `crypto.randomUUID()`: it
 * only has to be unique within this renderer, it satisfies `IdSchema`'s charset by construction, and
 * it does not depend on the page being a secure context.
 */
function nextRequestId(): string {
  lastRequest += 1;
  return `triage-${Date.now().toString(36)}-${lastRequest}`;
}

interface Failure {
  message: string;
  /** `detail` from main — for a failed `claude -p`, "Is Linear connected? Check with: claude mcp list". */
  hint: string | null;
}

/** One row of the `Assigned to you` list (spec 2026-09-16 §4). */
function TicketRow({ issue, hasAgent, disabled, onPick }: { issue: LinearIssue; hasAgent: boolean; disabled: boolean; onPick: () => void }) {
  const dim = isDoneOrCancelled(issue);
  return (
    <button
      type="button"
      data-ticket={issue.identifier}
      disabled={disabled}
      onClick={onPick}
      className={`flex w-full items-baseline gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-bg-3 disabled:pointer-events-none disabled:opacity-40${dim ? ' opacity-50' : ''}`}
    >
      <span className="shrink-0 font-medium text-fg">{issue.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-fg-2">{issue.title}</span>
      {issue.state === '' ? null : <span className="shrink-0 text-[11px] text-muted">{issue.state}</span>}
      {issue.cycleNumber === null ? null : <span className="shrink-0 text-[11px] text-muted">cycle {issue.cycleNumber}</span>}
      {hasAgent ? <span className="shrink-0 rounded bg-bg-3 px-1 text-[10px] text-accent">agent exists</span> : null}
    </button>
  );
}

/**
 * Spec 2026-09-15 §3 and 2026-09-16 §4: paste a Linear link or ID — or PICK one from the owner's own
 * tickets — read the ticket in the background, and hand the draft to the New Agent dialog, which
 * REPLACES this one because `ui.dialog` holds exactly one dialog.
 *
 * Two halves with very different costs, and the difference is the feature's standing promise:
 * **the list costs nothing** (an MCP call, no model), and the look-up is a paid `claude -p`. So the
 * list is fetched on open and cached by main for the app run, `Refresh` and `Load more` are the only
 * things that re-ask, and nothing here polls.
 *
 * Nothing in this file decides anything about a ticket. Main parses the reference again, runs
 * `claude -p`, filters the repo picks against the candidate list and builds the draft
 * (`linear-triage.ts`, `shared/linear-draft.ts`); this dialog parses the input early so a paste that
 * can never work is refused inline without a round trip (§8's first row), and shows what came back.
 *
 * A look-up takes about half a minute (measured 33 s on one ticket), so the field locks, a counter
 * shows the seconds, and Cancel aborts the child through `linear:cancel`. Closing the dialog cancels
 * too: a `claude -p` nobody is waiting for is still running and still spending usage.
 */
export function LinearDialog() {
  const close = useUi((s) => s.closeDialog);
  const openDialog = useUi((s) => s.openDialog);
  const toast = useUi((s) => s.toast);
  // The ticket being typed outlives this component on purpose — see `linearTicket` in the ui store.
  const ticket = useUi((s) => s.linearTicket ?? NO_TICKET);
  const updateTicket = useUi((s) => s.updateLinearTicket);
  const clearTicket = useUi((s) => s.clearLinearTicket);
  // A string or null — stable on every path, including before `config:get` has answered (G59/G61).
  const reposDir = useConfig((s) => s.config.reposDir);
  const setConfig = useConfig((s) => s.set);
  const agents = useWorkspace((s) => s.snapshot?.workspace.agents ?? EMPTY_AGENTS);
  const [text, setText] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  /**
   * The ticket the visible failure is about — what `Continue manually` names the draft after.
   *
   * NOT re-parsed from the field. A pick deliberately does not write the identifier into the field
   * (that fed the filter and collapsed the list under the owner), so after a failed pick the field
   * holds whatever they were filtering by, or nothing — and either would draft the wrong agent.
   */
  const [subject, setSubject] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly LinearIssue[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /**
   * True until a read has LANDED, and again whenever one is outstanding — so the empty line under
   * the list ("No tickets are assigned to you.") is only ever shown about a list that has genuinely
   * arrived. Two reads can overlap now that `Check the ticket list` refreshes from inside the create
   * form, where the dialog's own opening fetch may still be running, and main answers a read whose
   * page chain a refresh has superseded with the list as it holds it right now — which, before the
   * first page has ever landed, is an EMPTY list. Cleared by the counter below rather than by
   * whichever read happens to answer first.
   */
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  /**
   * Which half of the dialog is showing. Not a `DialogState` member: §5 says ⌘⇧L is the only home for
   * creating a ticket, and a second member would be a second modal for `installKeymap` to stand the
   * keyboard down for — the same call `ShortcutsPanel` got wrong once already.
   */
  const [mode, setMode] = useState<'pick' | 'create' | 'created' | 'cycle'>('pick');
  const [created, setCreated] = useState<{ identifier: string; url: string } | null>(null);
  // `initialFocus`, never `autoFocus` (G62).
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const openAgentRef = useRef<HTMLButtonElement>(null);
  /** The run this dialog is waiting on. A ref, because the unmount cleanup has to read it after state is gone. */
  const pending = useRef<string | null>(null);
  /**
   * The run Cancel was pressed for. Main answers a cancelled run with `CANCELLED` — unless its draft
   * was already on its way, and that answer must not open New Agent after the owner said stop.
   */
  const cancelled = useRef<string | null>(null);
  const wasBusy = useRef(false);
  const hadFolder = useRef(reposDir !== null);
  /** Still mounted? A list answer that arrives after the dialog closed has nothing to set. */
  const alive = useRef(true);
  /** Numbers the list reads, so an answer from one a later read has replaced is dropped, not drawn. */
  const listSeq = useRef(0);
  /** How many list reads are outstanding. A ref: it decides `listBusy`, it is not drawn itself. */
  const listLoads = useRef(0);

  // The seconds counter lives exactly as long as a look-up: the cleanup runs when the answer clears
  // `requestId` and when the dialog unmounts mid-look-up.
  useEffect(() => {
    if (requestId === null) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, [requestId]);

  // The field is `disabled` while a look-up runs, and Chromium drops focus from a control that becomes
  // disabled. Hand it back once the look-up settles without leaving (a failure, a cancel), so the
  // typo → Enter → error → retype loop needs no click. A success replaces this dialog, so never gets here.
  useEffect(() => {
    if (requestId === null && wasBusy.current) inputRef.current?.focus();
    wasBusy.current = requestId !== null;
  }, [requestId]);

  useEffect(() => {
    // Set on the way IN as well as cleared on the way out: a ref survives StrictMode's simulated
    // remount, so a flag only ever set to false would leave the real mount dead and its list empty
    // (G65). Declared before the fetch effect so it is true again by the time that one runs.
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current !== null) void run('linear:cancel', { requestId: pending.current });
      pending.current = null;
    };
  }, []);

  // Each step that REPLACES the dialog's body has to place the caret itself: `Dialog` applies
  // `initialFocus` once, on `showModal()`, and the created step did not exist then — so without this
  // it opened with focus on `<body>` and neither Enter nor Space reached the offer (G62).
  useEffect(() => {
    if (mode === 'created') openAgentRef.current?.focus();
  }, [mode]);

  // The folder step ends by mounting the field, after `Dialog` has already applied `initialFocus`
  // (it focuses once, on `showModal()`); put the caret in it as `initialFocus` would have.
  useEffect(() => {
    if (reposDir !== null && !hadFolder.current) inputRef.current?.focus();
    hadFolder.current = reposDir !== null;
  }, [reposDir]);

  /**
   * Stable by construction — it closes over nothing but state SETTERS and refs, both of which React
   * keeps identical for the life of the component. That is what lets the mount effect below depend on it honestly
   * and still run exactly once, the shape `DiffTab`'s `refresh` already uses, instead of an
   * exhaustive-deps suppression for a rule this repo does not even configure.
   */
  const loadIssues = useCallback(async (payload: { cursor?: string; refresh?: boolean }): Promise<void> => {
    const seq = listSeq.current + 1;
    listSeq.current = seq;
    listLoads.current += 1;
    // Already true on the first read, so the mount commits once (`render counts`) rather than twice.
    setListBusy(true);
    // A no-op `onError`: a list that would not load is a line above the list, not a toast — the link
    // field still works and the owner may not care about the list at all.
    const result = await runResult('linear:myIssues', payload, () => undefined);
    if (!alive.current) return;
    listLoads.current -= 1;
    // Still loading while another read is outstanding — which is what stops a superseded answer from
    // declaring the list empty while the refresh that replaced it is still running.
    setListBusy(listLoads.current > 0);
    // A read a later one has replaced. Its answer is about a page chain this dialog has left behind,
    // and main answers a superseded read with whatever it holds right now — nothing at all, before
    // the first page lands. So it neither becomes the list nor clears the loading state on its own.
    if (seq !== listSeq.current) return;
    if (!result.ok) {
      setListError(result.error.message);
      return;
    }
    setListError(null);
    setIssues(result.value.issues);
    setNextCursor(result.value.nextCursor);
  }, []);

  /**
   * §4: fetched when the dialog opens. Main answers the no-cursor call from its app-run cache, so the
   * second and later opens cost one IPC round trip and no request to Linear.
   */
  useEffect(() => {
    void loadIssues({});
  }, [loadIssues]);

  const chooseReposDir = async (): Promise<void> => {
    // `run` flattens a failed pick and a cancelled one to null; both mean "nothing to save", and a
    // failure has already gone to the toast sink.
    const path = await run('app:pickFolder', { title: PICKER_TITLE });
    if (path) await setConfig({ reposDir: path });
  };

  const lookUp = async (raw: string): Promise<void> => {
    if (pending.current !== null) return;
    const ref = parseLinearRef(raw);
    if (ref === null) {
      setSubject(null);
      setFailure({ message: INVALID_REF, hint: null });
      return;
    }
    const id = nextRequestId();
    pending.current = id;
    setSubject(ref);
    setFailure(null);
    setElapsed(0);
    setRequestId(id);
    // A no-op `onError`: the failure belongs in this dialog, beside Continue manually, not in a toast.
    const result = await runResult('linear:triage', { requestId: id, ref }, () => undefined);
    // Closed (and so cancelled) while it ran: nothing is waiting for this answer any more.
    if (pending.current !== id) return;
    pending.current = null;
    setRequestId(null);
    // Cancelled while the answer was already on its way: whatever it says, the owner asked for nothing.
    if (cancelled.current === id) {
      cancelled.current = null;
      return;
    }
    if (result.ok) {
      openDialog({ kind: 'new-agent', folderId: null, draft: result.value });
      return;
    }
    // §8: a cancel shows nothing; the field simply unlocks.
    if (result.error.code === 'CANCELLED') return;
    setFailure({ message: result.error.message, hint: result.error.detail ?? null });
  };

  /**
   * §4: picking a row runs the look-up immediately — identical to pressing Look up for that ticket —
   * unless an agent for it already exists, in which case that agent is what the owner wanted.
   */
  const pick = (issue: LinearIssue): void => {
    // A look-up is already running. `lookUp` would refuse anyway, but silently — and a second pick
    // that starts nothing would still have moved what `Continue manually` drafts onto the wrong
    // ticket if this wrote any state first. The rows are `disabled` while busy too; this is the half
    // that does not depend on the DOM.
    if (pending.current !== null) return;
    const existing = agentForIssue(agents, issue.identifier);
    if (existing !== undefined) {
      openAgent(existing.id, false);
      close();
      return;
    }
    // Deliberately NOT `setText(issue.identifier)`: the field is the filter query, so writing the
    // identifier there narrows the list to the one row just picked and leaves it narrowed after a
    // failure, with nothing saying why. `lookUp` takes the identifier directly and `subject`
    // remembers it for `Continue manually`.
    void lookUp(issue.identifier);
  };

  const cancel = (): void => {
    if (pending.current === null) return;
    cancelled.current = pending.current;
    void run('linear:cancel', { requestId: pending.current });
  };

  const continueManually = (): void => openDialog({ kind: 'new-agent', folderId: null, draft: manualDraft(subject) });

  const busy = requestId !== null;
  /**
   * Derived AFTER subscribing, never inside a selector (G59): `filterIssues` allocates.
   *
   * A field holding a real link or identifier filters by what it PARSES to, so a pasted URL narrows
   * to that ticket's row instead of matching nothing.
   */
  const shown = useMemo(() => filterIssues(issues, parseLinearRef(text) ?? text), [issues, text]);

  return (
    <Dialog open title={mode === 'cycle' ? 'Agents for a whole cycle' : mode === 'pick' ? 'New agent from a Linear ticket' : 'New Linear ticket'} onClose={close} width={560} initialFocus={reposDir === null ? chooseRef : inputRef}>
      {reposDir === null ? (
        <div>
          <p className="mb-3 text-[12px] text-fg-2">
            Hangar picks a ticket&apos;s repos from the git repositories directly inside one folder, plus the projects you have already added. Choose that folder first.
          </p>
          <DialogActions>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button ref={chooseRef} variant="primary" onClick={() => void chooseReposDir()}>Choose your repos folder…</Button>
          </DialogActions>
        </div>
      ) : mode === 'create' ? (
        <NewTicketForm
          fields={ticket}
          onFields={updateTicket}
          onBack={() => setMode('pick')}
          /**
           * The answer to an unconfirmed create: ask Linear again, and show what it says. A refresh
           * rather than a cached read — the whole question is whether the ticket is there — and the
           * typed ticket stays in `ticket`, so `New ticket` brings it straight back.
           */
          onCheckList={() => { setMode('pick'); void loadIssues({ refresh: true }); }}
          onCreated={(issue) => {
            setCreated(issue);
            setMode('created');
            // Filed. The next `New ticket` starts from a blank form, not from this one's ghost.
            clearTicket();
            // No `Copy link` action on the toast — `ToastEvent` has none; the button is on the step below.
            toast({ level: 'info', title: `Created ${issue.identifier}` });
          }}
        />
      ) : mode === 'cycle' ? (
        /**
         * A `mode`, not a `DialogState` member — the same call `NewTicketForm` made, for the same
         * reason: `installKeymap` stands the WHOLE shortcut table down for anything in
         * `DialogState`, and spec §3 gives this step one home, which is the ⌘⇧L dialog.
         */
        <CycleRun onBack={() => setMode('pick')} onDone={close} />
      ) : mode === 'created' && created !== null ? (
        <div>
          <p className="mb-3 text-[12px] text-fg">Created {created.identifier}. Open an agent for it?</p>
          <DialogActions>
            {created.url === '' ? null : <Button variant="ghost" onClick={() => void run('app:copyToClipboard', { text: created.url })}>Copy link</Button>}
            <span className="flex-1" />
            <Button variant="ghost" onClick={close}>Not now</Button>
            {/* As a pick does, and deliberately NOT through the link field: that field is the
                filter, and writing the identifier into it would collapse the list to this one row
                and leave it collapsed if the look-up failed. */}
            <Button ref={openAgentRef} variant="primary" onClick={() => { setMode('pick'); void lookUp(created.identifier); }}>Open an agent</Button>
          </DialogActions>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void lookUp(text); }}>
          <Field label="Ticket">
            <TextInput
              ref={inputRef}
              aria-label="Linear link or ticket ID"
              placeholder="Linear link or ticket ID (AC-3461)"
              value={text}
              disabled={busy}
              onChange={(e) => { setText(e.target.value); setFailure(null); }}
            />
          </Field>
          <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
            <span className="min-w-0 truncate" title={reposDir}>Repos folder: {reposDir}</span>
            <button type="button" className="shrink-0 text-accent hover:underline disabled:opacity-40" disabled={busy} onClick={() => void chooseReposDir()}>Change…</button>
          </div>
          {busy ? (
            <p role="status" className="mb-3 flex items-center gap-1.5 text-[12px] text-fg-2">
              <LoaderCircle aria-hidden size={12} className="animate-spin" />
              Reading ticket… {elapsed}s
            </p>
          ) : null}
          {failure ? (
            <div className="mb-3 rounded-md bg-red/10 p-2 text-[11px] select-text">
              <p className="text-red">{failure.message}</p>
              {failure.hint ? <p className="mt-1 text-muted">{failure.hint}</p> : null}
            </div>
          ) : null}

          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-medium text-fg-2">Assigned to you</span>
            {listBusy ? <LoaderCircle aria-hidden size={11} className="animate-spin text-muted" /> : null}
            <span className="flex-1" />
            <Button variant="ghost" className="h-5 px-1.5 text-[11px]" disabled={busy || listBusy} onClick={() => void loadIssues({ refresh: true })}>
              <RefreshCw aria-hidden size={11} />
              Refresh
            </Button>
          </div>
          {/* `role="status"`, like the look-up's own line: the spinner beside the heading is
              `aria-hidden`, so without this a list that would not load is announced to nobody. */}
          {listError ? <p role="status" className="mb-2 text-[11px] text-red select-text">{listError}</p> : null}
          <div className="mb-3 max-h-56 overflow-y-auto rounded-md border border-line">
            {shown.map((issue) => (
              <TicketRow key={issue.identifier} issue={issue} hasAgent={agentForIssue(agents, issue.identifier) !== undefined} disabled={busy} onPick={() => pick(issue)} />
            ))}
            {shown.length === 0 && !listBusy && listError === null ? (
              <p className="px-2 py-2 text-[11px] text-muted">{issues.length === 0 ? 'No tickets are assigned to you.' : 'No ticket matches that.'}</p>
            ) : null}
            {/* Gated on the cursor ALONE. `&& shown.length > 0` hid this exactly when it was most
                needed: a filter that matches nothing on page 1 made the ticket on page 2 — the one
                the owner is filtering for — unreachable without first clearing the filter. */}
            {nextCursor !== null ? (
              <div className="border-t border-line p-1">
                <Button variant="ghost" className="h-5 w-full justify-center px-1.5 text-[11px]" disabled={busy || listBusy} onClick={() => void loadIssues({ cursor: nextCursor })}>Load more</Button>
              </div>
            ) : null}
          </div>

          <DialogActions>
            {failure ? <Button variant="ghost" onClick={continueManually}>Continue manually</Button> : null}
            <Button variant="ghost" disabled={busy} onClick={() => setMode('create')}>New ticket</Button>
            {/* Free to open: the cycle step's two reads are MCP-only, with no model in them. */}
            <Button variant="ghost" disabled={busy} onClick={() => setMode('cycle')}>Whole cycle…</Button>
            <span className="flex-1" />
            <Button variant="ghost" onClick={busy ? cancel : close}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || text.trim() === ''}>Look up</Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
