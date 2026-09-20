import { LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LINEAR_CREATE_UNCONFIRMED } from '../../../../shared/ipc-contract.ts';
import {
  PRIORITY_LABELS, TICKET_DESCRIPTION_MAX, TICKET_TITLE_MAX, cleanTicketTitle, mergeTicketFields,
  ticketFieldsProblem, type LinearTeam, type TicketFields,
} from '../../../../shared/linear-issues.ts';
import { run, runResult } from '../../lib/api.ts';
import { Button } from '../ui/Button.tsx';
import { DialogActions } from '../ui/Dialog.tsx';
import { Field, Select, TextArea, TextInput } from '../ui/Field.tsx';

let lastDraft = 0;
/** As `LinearDialog`'s ids: unique within this renderer, `IdSchema`-safe, no secure context needed. */
function nextDraftId(): string {
  lastDraft += 1;
  return `draft-${Date.now().toString(36)}-${lastDraft}`;
}

const INVISIBLE_TITLE = 'A title needs at least one visible character.';

/**
 * The one thing `ticketFieldsProblem` cannot SAY, rather than something it cannot see: a title of
 * nothing but invisible characters is refused by it too, as `A title is required.`, and a form where
 * the owner can see text in the box deserves the more specific sentence.
 *
 * `cleanTicketTitle` is the shared cleaner `saveIssueArgs` sends through and the guard checks with —
 * not a second copy of the rule, which is what this was until the review: a form cleaning a title
 * one way while the wire cleans it another is how a title that looked fine gets filed empty.
 */
const isInvisibleTitle = (raw: string): boolean => raw.trim() !== '' && cleanTicketTitle(raw) === '';

/**
 * Spec 2026-09-16 §5 — a new Linear ticket, from a title.
 *
 * It lives INSIDE the ⌘⇧L dialog rather than being a dialog of its own: §5 says that dialog is the
 * only home for it, and a second `DialogState` member would be a second modal to stand the keyboard
 * down for.
 *
 * Two fields are shown and not editable — Assignee `you` and State `Backlog` — and they are not
 * merely disabled inputs: `TicketFields` types them as literals and the IPC schema pins them, so
 * nothing this form can do files a ticket for someone else or in another state.
 *
 * **`Draft with Claude` is the only thing here that costs anything**, and only when pressed. It fills
 * the fields that are empty (`mergeTicketFields`) and touches nothing the owner typed — including on
 * a second press after they have edited what the first one wrote.
 *
 * The fields themselves are the DIALOG's state, not this component's: `Back`, and the check offered
 * after an unconfirmed create, both unmount this form, and a ticket someone has typed out must not
 * be the price of going to look at the list.
 */
export function NewTicketForm({ fields, onFields, onCreated, onBack, onCheckList }: {
  fields: TicketFields;
  onFields: (update: (current: TicketFields) => TicketFields) => void;
  onCreated: (created: { identifier: string; url: string }) => void;
  onBack: () => void;
  onCheckList: () => void;
}) {
  const [teams, setTeams] = useState<readonly LinearTeam[]>([]);
  const [drafting, setDrafting] = useState(false);
  /**
   * The team list's own failure, kept APART from `error`.
   *
   * They shared one slot, and the team list answers whenever it answers: a list that failed late
   * overwrote the message a draft or a save had just put on screen, so the owner was told why their
   * teams would not load in the place that had been telling them their ticket was not created.
   */
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The create timed out, so the ticket MAY exist (`LINEAR_CREATE_UNCONFIRMED`). Every other failure
   * here is one where Save is the right button again; this is the one where pressing it is how the
   * owner ends up with two tickets.
   */
  const [unconfirmed, setUnconfirmed] = useState(false);
  // `initialFocus`, never `autoFocus` (G62).
  const titleRef = useRef<HTMLInputElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const pendingDraft = useRef<string | null>(null);
  /**
   * What a FINISHED RUN asked to have the caret, once the fields it disabled are enabled again.
   *
   * A ref consumed by the commit effect below, rather than an effect keyed on `error`: the team list
   * also writes `error`, and it arrives whenever it arrives — a late team failure keyed that way
   * took the caret out of the Description box mid-sentence. Only `draft` and `save` set this, so
   * only a run the owner started can move their caret.
   */
  const focusAfterRun = useRef<'title' | 'check' | null>(null);
  /** Still mounted? Set on the way IN as well, so StrictMode's simulated remount leaves it true (G65). */
  const alive = useRef(true);

  const loadTeams = async (): Promise<void> => {
    // No toast: a team list that would not load shows as the inline error the Save button already
    // points at, and main answers from its app-run cache after the first time.
    const result = await runResult('linear:teams', undefined, () => undefined);
    if (!alive.current) return;
    setTeamsError(result.ok ? null : result.error.message);
    if (result.ok) setTeams(result.value.teams);
  };

  // The dialog's `initialFocus` ran once, on `showModal()`, long before this form existed — so it
  // takes the caret itself, exactly as the repos-folder step does when it hands over (G62).
  useEffect(() => {
    alive.current = true;
    titleRef.current?.focus();
    void loadTeams();
    return () => {
      alive.current = false;
      // A draft nobody is waiting for is still a `claude -p` that is running and spending usage.
      if (pendingDraft.current !== null) void run('linear:cancel', { requestId: pendingDraft.current });
      pendingDraft.current = null;
    };
    // Mount only. `loadTeams` closes over nothing but state setters and is not a dependency anyone
    // could honour: this repo configures no `react-hooks` rules, so there is no suppression to add.
  }, []);

  /**
   * A run that ended badly left the fields `disabled`, and Chromium drops focus from a control that
   * becomes disabled — so the caret has to be put back. It goes to the title, the one control that
   * is always there and always safe to type in, except after an unconfirmed create, where the button
   * that goes and LOOKS is what should be under the owner's hands.
   *
   * No dependency list: this runs after every commit and does nothing unless a run queued a target,
   * which is what makes it the run's focus call rather than a reaction to some piece of state.
   */
  useEffect(() => {
    const target = focusAfterRun.current;
    if (target === null) return;
    focusAfterRun.current = null;
    (target === 'check' ? checkRef.current : titleRef.current)?.focus();
  });

  const draft = async (): Promise<void> => {
    if (pendingDraft.current !== null) return;
    const id = nextDraftId();
    pendingDraft.current = id;
    setDrafting(true);
    setError(null);
    const result = await runResult('linear:draftTicket', { requestId: id, title: cleanTicketTitle(fields.title) }, () => undefined);
    if (pendingDraft.current !== id) return;
    pendingDraft.current = null;
    setDrafting(false);
    if (!result.ok) {
      // §6: the form stays, fields untouched.
      if (result.error.code !== 'CANCELLED') {
        setError(result.error.message);
        focusAfterRun.current = 'title';
      }
      return;
    }
    // Read through the updater, not the closure: the owner can type while a draft runs, and what
    // counts as "already filled" is what is in the form NOW, not what it held when the button went down.
    onFields((current) => mergeTicketFields(current, result.value));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setUnconfirmed(false);
    // The CLEANED title: what the owner sees is their own typing, but what is filed is what every
    // other untrusted string in this feature is put through first.
    const result = await runResult('linear:createTicket', { fields: { ...fields, title: cleanTicketTitle(fields.title) } }, () => undefined);
    if (!alive.current) return;
    setSaving(false);
    if (!result.ok) {
      // §6: the form keeps everything typed — for an unconfirmed create, for a `BUSY` refusal that
      // sent nothing at all, and for Linear's own `no`. None of them is a reason to lose a ticket.
      const isUnconfirmed = result.error.code === LINEAR_CREATE_UNCONFIRMED;
      setUnconfirmed(isUnconfirmed);
      setError(result.error.message);
      focusAfterRun.current = isUnconfirmed ? 'check' : 'title';
      return;
    }
    onCreated(result.value);
  };

  const problem = isInvisibleTitle(fields.title) ? INVISIBLE_TITLE : ticketFieldsProblem(fields);
  const busy = drafting || saving;
  const set = (patch: Partial<TicketFields>): void => onFields((f) => ({ ...f, ...patch }));
  /** '' is a real answer for both numeric selects — "not set" — and is not the number 0. */
  const asNumber = (value: string): number | null => (value === '' ? null : Number(value));

  return (
    // While the create is unconfirmed, Enter does NOTHING: it is the shape a blind retry would take.
    <form onSubmit={(e) => { e.preventDefault(); if (problem === null && !busy && !unconfirmed) void save(); }}>
      <Field label="Title">
        <div className="flex gap-2">
          <TextInput
            ref={titleRef}
            aria-label="Title"
            placeholder="What needs doing?"
            maxLength={TICKET_TITLE_MAX}
            value={fields.title}
            disabled={busy}
            onChange={(e) => set({ title: e.target.value })}
          />
          {/* One gate for "empty" and for "nothing visible in it": both mean there is no title to
              draft from, and a draft run is the one thing on this form that spends usage. */}
          <Button variant="default" className="shrink-0" disabled={busy || cleanTicketTitle(fields.title) === ''} onClick={() => void draft()}>
            {drafting ? <LoaderCircle aria-hidden size={12} className="animate-spin" /> : <Sparkles aria-hidden size={12} />}
            {drafting ? 'Drafting…' : 'Draft with Claude'}
          </Button>
        </div>
      </Field>
      <Field label="Description">
        <TextArea aria-label="Description" rows={5} maxLength={TICKET_DESCRIPTION_MAX} value={fields.description} disabled={busy} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label="Estimate">
            <TextInput aria-label="Estimate" type="number" min={0} max={100} value={fields.estimate ?? ''} disabled={busy} onChange={(e) => set({ estimate: asNumber(e.target.value) })} />
          </Field>
        </div>
        <div className="flex-1">
          <Field label="Priority">
            <Select aria-label="Priority" value={fields.priority ?? ''} disabled={busy} onChange={(e) => set({ priority: asNumber(e.target.value) })}>
              <option value="">Not set</option>
              {PRIORITY_LABELS.map((label, value) => <option key={label} value={value}>{label}</option>)}
            </Select>
          </Field>
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label="Team">
            <Select aria-label="Team" value={fields.teamId ?? ''} disabled={busy} onChange={(e) => set({ teamId: e.target.value === '' ? null : e.target.value })}>
              <option value="">Choose a team…</option>
              {/* The NAME is all there is: `list_teams` returns no key (measured), so there is no `AC` to show. */}
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex-1">
          <Field label="Project" hint="Optional. Type it exactly as Linear spells it.">
            <TextInput aria-label="Project" value={fields.projectId ?? ''} disabled={busy} onChange={(e) => set({ projectId: e.target.value === '' ? null : e.target.value })} />
          </Field>
        </div>
      </div>
      {/* The team list's failure, in its own slot beside the picker it is about — `role="status"`,
          because nobody asked for it just now and it must not interrupt a run's own answer. */}
      {teamsError ? <p role="status" className="mb-3 text-[11px] text-red select-text">{teamsError}</p> : null}
      <p className="mb-3 text-[11px] text-muted">Assignee: you · State: Backlog</p>
      {/* `role="alert"`, not `status`: this is the answer to something the owner just pressed, and an
          assertive region is what interrupts to say a save did not happen. */}
      {error ? <p role="alert" className="mb-3 rounded-md bg-red/10 p-2 text-[11px] text-red select-text">{error}</p> : null}
      <DialogActions>
        <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
        <span className="flex-1" />
        {/* Polite, and always in the DOM: a live region added at the same moment as its text is not
            reliably announced, and this one changes as the form is filled in rather than at a press. */}
        <span role="status" className="self-center text-[11px] text-muted">{problem ?? ''}</span>
        {unconfirmed ? (
          <>
            {/* Demoted on purpose. The ticket may already exist, so saving again is something to
                decide, not the button the hand falls on. */}
            <Button variant="ghost" disabled={busy || problem !== null} onClick={() => void save()}>Save anyway</Button>
            <Button ref={checkRef} variant="primary" onClick={onCheckList}>Check the ticket list</Button>
          </>
        ) : (
          <Button variant="primary" type="submit" disabled={busy || problem !== null}>{saving ? 'Saving…' : 'Save'}</Button>
        )}
      </DialogActions>
    </form>
  );
}
