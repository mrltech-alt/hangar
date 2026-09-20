import { useEffect, useRef, useState } from 'react';
import { type ProgressEvent } from '../../../../shared/ipc-contract.ts';
import { type DraftFolder, type TicketDraft } from '../../../../shared/linear-draft.ts';
import { slugify } from '../../../../shared/slug.ts';
import type { Id, PermissionMode, Project } from '../../../../shared/types.ts';
import { AgentNameSchema } from '../../../../shared/workspace-schema.ts';
import { addProjectFlow, openAgentAfterCreate } from '../../lib/agent-actions.ts';
import { api, runResult } from '../../lib/api.ts';
import { createAgentSequence, type CreateRow } from '../../lib/create-agent.ts';
import { useConfig } from '../../stores/config.ts';
import { useUi } from '../../stores/ui.ts';
import { useFolders, useProjects } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Checkbox, Field, Select, TextArea, TextInput } from '../ui/Field.tsx';
import {
  agentWasSaved, branchOptions, duplicateRowIndexes, failStalledSteps, progressAgentId,
  reduceProgress,
} from './logic.ts';
import { ProgressList } from './ProgressList.tsx';

const MODES: { value: PermissionMode | ''; label: string }[] = [
  { value: '', label: 'Default (ask for permissions)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions (dangerous)' },
];

/** `agent:create`'s own cap (`ipc-schemas.ts`: `.min(1).max(8)`), so the button stops where main does. */
const MAX_WORKSPACES = 8;

/** The folder select's value for a draft's `Cycle N (new)`. `IdSchema` forbids `:`, so no real folder id can equal it. */
const NEW_FOLDER_VALUE = ':new';

function rowsFromDraft(draft: TicketDraft): CreateRow[] {
  return draft.rows.map((r): CreateRow => (r.kind === 'existing' ? { kind: 'existing', projectId: r.projectId, baseBranch: '' } : { kind: 'new', repoPath: r.repoPath, name: r.name, baseBranch: '' }));
}

/**
 * What the duplicate check compares. A "will be added" row counts as the project it will become once a
 * project with that repoPath exists — "Add project…" inside this dialog can register it first.
 */
function rowKey(row: CreateRow, projects: readonly Project[]): string {
  if (row.kind === 'existing') return row.projectId;
  return projects.find((p) => p.repoPath === row.repoPath)?.id ?? `new:${row.repoPath}`;
}

export function NewAgentDialog({ folderId: initialFolder, draft }: { folderId: Id | null; draft?: TicketDraft }) {
  const close = useUi((s) => s.closeDialog);
  const projects = useProjects();
  const folders = useFolders();
  // Spec 2026-09-15 §6: only a TRIAGE draft changes how the form behaves. A manual draft ("Continue
  // manually") is the plain dialog with the name prefilled — first row seeded, "No projects yet"
  // hint, Start Claude immediately on.
  const fromTriage = draft?.fromTriage === true;
  const [name, setName] = useState(draft?.name ?? '');
  const [folder, setFolder] = useState<DraftFolder>(() => draft?.folder ?? (initialFolder === null ? { kind: 'root' } : { kind: 'existing', folderId: initialFolder }));
  const [rows, setRows] = useState<CreateRow[]>(() => {
    const drafted = draft ? rowsFromDraft(draft) : [];
    // Seeded here as well as in the effect below, so a dialog that already has projects mounts with
    // its row in ONE commit rather than rendering row-less first.
    return drafted.length === 0 && !fromTriage && projects[0] ? [{ kind: 'existing', projectId: projects[0].id, baseBranch: '' }] : drafted;
  });
  const [notes, setNotes] = useState(draft?.notes ?? '');
  // Spec 2026-09-15 §5.1/§6: the select STARTS at `config.defaultPermissionMode`, for a manual create and
  // a draft alike. A primitive selector (G59/G61). Only the initial value: a config that lands after the
  // dialog opened must not move a choice under the user. `'default'` has no option in MODES and means
  // what `''` means — no `--permission-mode` flag — so it starts there.
  const defaultMode = useConfig((s) => s.config.defaultPermissionMode);
  const [mode, setMode] = useState<PermissionMode | ''>(defaultMode === null || defaultMode === 'default' ? '' : defaultMode);
  // Off for a triage draft (spec §6): the owner is reviewing a filled-in form, and a session starting
  // behind the dialog is one more thing to notice before they have.
  const [startNow, setStartNow] = useState(!fromTriage);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Spec §12.6: "Name (required, autofocus)". `autoFocus` does not deliver that inside a
  // `<dialog>` opened with `showModal()` — `ui/Dialog.tsx` records the measurement — so the
  // field is named here and `Dialog` focuses it once the dialog is actually shown.
  const nameRef = useRef<HTMLInputElement>(null);

  /**
   * Whether this dialog is still on screen. The create sequence is several awaits long and the dialog
   * can go away in the middle of it — ⌘N toggles a busy New Agent dialog shut (`installKeymap`), and
   * `onClose` is only guarded for the header button and Escape. The sequence still finishes (spec §6,
   * "Closing mid-create"); this is what lets it tell whether its failure has a dialog to land in.
   * Set in the effect body too, so a StrictMode remount does not leave it false.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * True only while THIS instance's `submit` is running. `agent:progress` is a broadcast with no way
   * to address one dialog, and a create started in a dialog that was since closed keeps emitting — so
   * after ⌘N twice (close, reopen) the fresh dialog heard the old sequence's steps, and one `saved`
   * event swapped its form for a finished progress list with only Close on it, for good. A dialog
   * that has not pressed Create has no steps to show.
   */
  const creating = useRef(false);
  useEffect(() => api.on('agent:progress', (p) => {
    if (creating.current) setProgress((list) => reduceProgress(list, p));
  }), []);

  /**
   * Base-branch suggestions, cached per PROJECT and fetched at most once each.
   *
   * The plan kept the branch list inside each row and re-fetched whenever `rows.branches` was
   * still empty. Two ways that spins: a repo with no branches at all never fills, so the effect
   * re-fires forever; and a `project:listBranches` that FAILS also never fills, so every keystroke
   * in the base-branch box fires another round trip. The `requested` ref is the fix — it records
   * that we asked, which is the thing that must not repeat, rather than that we got an answer.
   * A "will be added" row has no project to ask about yet.
   */
  const [branches, setBranches] = useState<Record<Id, string[]>>({});
  const requested = useRef<Set<Id>>(new Set());
  useEffect(() => {
    for (const row of rows) {
      if (row.kind !== 'existing' || requested.current.has(row.projectId)) continue;
      const projectId = row.projectId;
      requested.current.add(projectId);
      // A no-op `onError`: a repo whose branches cannot be listed still creates fine (the base
      // falls back to the project's default branch), so this must not raise a toast.
      void runResult('project:listBranches', { id: projectId }, () => undefined).then((r) => {
        if (r.ok) setBranches((m) => ({ ...m, [projectId]: branchOptions(r.value) }));
      });
    }
  }, [rows]);

  // "Add project…" from inside this dialog is the one way `projects` grows under it, and the row
  // list is seeded lazily at mount — so an empty workspace would otherwise stay row-less after the
  // first project was added, with no way to choose it.
  //
  // NOT for a triage draft (spec §6): one with no rows means triage picked none, and silently adding
  // `projects[0]` would be a guess the owner did not see being made. A manual draft is seeded.
  useEffect(() => {
    if (!fromTriage && rows.length === 0 && projects[0]) setRows([{ kind: 'existing', projectId: projects[0].id, baseBranch: '' }]);
  }, [fromTriage, projects, rows.length]);

  const projectOf = (id: Id) => projects.find((p) => p.id === id);
  const duplicates = duplicateRowIndexes(rows.map((r) => rowKey(r, projects)));
  const nameOk = AgentNameSchema.safeParse(name).success;
  const usable = rows.length > 0 && nameOk && duplicates.length === 0;

  const setRow = (i: number, next: CreateRow): void => setRows((rs) => rs.map((r, j) => (j === i ? next : r)));

  // Narrowed through a const, so the option below can read `.name` without testing `draft` again.
  const draftFolder = draft?.folder;
  const newFolderName = draftFolder?.kind === 'new' ? draftFolder.name : null;
  const folderValue = folder.kind === 'root' ? '' : folder.kind === 'existing' ? folder.folderId : NEW_FOLDER_VALUE;
  const chooseFolder = (value: string): void => {
    if (value === '') setFolder({ kind: 'root' });
    else if (value === NEW_FOLDER_VALUE && newFolderName !== null) setFolder({ kind: 'new', name: newFolderName });
    else setFolder({ kind: 'existing', folderId: value });
  };

  /**
   * Spec 2026-09-15 §7, stopping at the first failure. Without a draft only step 3 has anything to do,
   * which is exactly the create this dialog always ran.
   *
   * A failure in step 1 or 2 lands in this dialog's error area with Retry / Edit details, like any
   * failed create. Whatever those steps already made — a registered project, a folder — is harmless
   * and stays; Retry finds it again through PROJECT_EXISTS and the folder re-check.
   *
   * If the dialog is closed while this runs (spec §6, "Closing mid-create"), the sequence carries on.
   * `opened` is the dialog this Create was pressed in: the final `close()` only fires while that is
   * still the open dialog, so it cannot shut one the user opened since. A failure with no dialog left
   * to show it in becomes an error toast rather than a state update nobody sees. It is sticky: for a
   * triage draft the toast is the only place what was typed or looked up still shows.
   */
  const submit = async (): Promise<void> => {
    // `creating` as well as `busy`: the ref is set synchronously, `busy` only after the next render.
    if (!usable || busy || creating.current) return;
    creating.current = true;
    try {
      await runCreate();
    } finally {
      creating.current = false;
    }
  };

  const runCreate = async (): Promise<void> => {
    const opened = useUi.getState().dialog;
    const agentName = name.trim();
    setBusy(true);
    setError(null);
    setProgress([]);
    const fail = (message: string): void => {
      if (!mounted.current) {
        useUi.getState().toast({ level: 'error', title: `Could not create ${agentName}`, detail: message, sticky: true });
        return;
      }
      setError(message);
      setBusy(false);
    };

    // The four steps themselves live in `lib/create-agent.ts`, because the whole-cycle run calls the
    // same sequence (spec 2026-09-17 §4). Everything below the call is this dialog's alone: the
    // progress list, the Retry / Open the agent split, and where a failure lands once the dialog is
    // gone. The helper keeps its own progress record, which is what makes `outcome.saved` knowable
    // after the component's listener has been torn down with it.
    const outcome = await createAgentSequence({
      name: agentName,
      folder,
      rows,
      notes,
      permissionMode: mode === '' ? null : mode,
      startNow,
    });
    if (!outcome.ok) {
      // The agent EXISTS and only the last step failed — `startNow` against a disconnected host is
      // the measured case. The dialog offers the agent instead of a Retry that would make a second.
      if (!mounted.current && outcome.saved) {
        useUi.getState().toast({ level: 'error', title: `Created ${agentName}, but it could not be started`, detail: outcome.message, sticky: true });
        return;
      }
      // Anything still spinning is the step that threw — see `failStalledSteps`.
      if (mounted.current) setProgress(failStalledSteps);
      return fail(outcome.message);
    }
    if (outcome.notesFailed !== null) {
      useUi.getState().toast({ level: 'warn', title: 'Agent created, but its notes could not be saved', detail: outcome.notesFailed });
    }

    useUi.getState().toast({
      level: 'info',
      title: `Created ${outcome.agent.name}`,
      detail: startNow ? 'Claude may ask you to trust the new folder — press Enter in the terminal.' : undefined,
    });
    if (useUi.getState().dialog === opened) close();
    openAgentAfterCreate(outcome.agent.id);
  };

  /**
   * Spec §12.6 offers *Retry* on a fatal error because "rollback already performed" — nothing the
   * failed attempt made survives, so re-running the identical input is safe.
   *
   * It is safe only while that holds. `createAgent` commits the agent record, emits `saved`, and
   * only THEN awaits `startAgent(id, 'auto')` with no catch of its own, so `startNow` against a
   * disconnected host rejects `agent:create` for an agent that EXISTS and was never rolled back.
   * Retrying there would make a second agent, so this path offers the agent instead.
   */
  const saved = agentWasSaved(progress);
  const savedAgentId = progressAgentId(progress);
  const openTheSavedAgent = (): void => {
    close();
    if (savedAgentId !== null) openAgentAfterCreate(savedAgentId);
  };

  /**
   * `error !== null` is part of the condition, not just `busy || progress.length > 0`.
   * `agent:create` can reject BEFORE emitting a single step — a payload `ipc-schemas.ts` rejects,
   * LOW_DISK, an unknown folder, "the same project cannot be selected twice" — and with only the
   * first two terms the dialog fell straight back to the form, which renders no error, so the
   * failure vanished silently. Measured: a failing `agent:create` with no `agent:progress` events
   * left the form on screen and nothing else.
   */
  const showProgress = busy || progress.length > 0 || error !== null;
  return (
    <Dialog open title="New agent" onClose={busy ? () => undefined : close} width={600} initialFocus={nameRef}>
      {showProgress ? (
        <div>
          <ProgressList items={progress} />
          {busy && progress.length === 0 ? <div className="text-[12px] text-muted">Starting…</div> : null}
          {error ? <pre className="mt-3 rounded-md bg-red/10 p-2 font-mono text-[11px] text-red select-text whitespace-pre-wrap">{error}</pre> : null}
          {error && saved ? (
            <p className="mt-2 text-[11px] text-amber">The agent was created — only the last step failed. Retrying would create a second one.</p>
          ) : null}
          <DialogActions>
            {error && !saved ? <Button variant="ghost" onClick={() => { setProgress([]); setError(null); }}>Edit details</Button> : null}
            <span className="flex-1" />
            {error && !saved ? <Button variant="primary" onClick={() => void submit()}>Retry</Button> : null}
            {error && saved ? <Button variant="primary" onClick={openTheSavedAgent}>Open the agent</Button> : null}
            <Button variant="ghost" disabled={busy} onClick={close}>Close</Button>
          </DialogActions>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Name" hint={name.trim() ? `branch: agent/${slugify(name)} (suffixed if taken)` : 'Describe the task, e.g. "AcmeApi: fix Billing webhook retries"'}>
            <TextInput ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Folder">
            <Select aria-label="Folder" value={folderValue} onChange={(e) => chooseFolder(e.target.value)}>
              {newFolderName !== null ? <option value={NEW_FOLDER_VALUE}>{`${newFolderName} (new)`}</option> : null}
              <option value="">Root</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Field>
          {projects.length === 0 && rows.length === 0 ? (
            <p className="mb-3 rounded-md border border-line p-3 text-[12px] text-muted">
              No projects yet. Add the git repository this agent should work in.
            </p>
          ) : null}
          {rows.map((row, i) => {
            const project = row.kind === 'existing' ? projectOf(row.projectId) : undefined;
            return (
              <div key={i} className="mb-3 rounded-md border border-line p-3">
                <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-fg-2">
                  <span>{i === 0 ? 'Primary project (terminal runs here)' : `Additional project ${i + 1}`}</span>
                  {i > 0 || row.kind === 'new' ? <Button variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</Button> : null}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {row.kind === 'existing' ? (
                    <Select aria-label={`Project ${i + 1}`} value={row.projectId} onChange={(e) => setRow(i, { kind: 'existing', projectId: e.target.value, baseBranch: '' })}>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 text-[12px]" title={row.repoPath}>
                      <span className="truncate text-fg">{row.name}</span>
                      <span className="shrink-0 rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-muted">will be added</span>
                    </div>
                  )}
                  <TextInput
                    aria-label={`Base branch ${i + 1}`}
                    list={`branches-${i}`}
                    placeholder={row.kind === 'existing' ? `base: ${project?.defaultBranch ?? 'default'}` : 'base: detected when added'}
                    value={row.baseBranch}
                    onChange={(e) => setRow(i, { ...row, baseBranch: e.target.value })}
                  />
                  <datalist id={`branches-${i}`}>
                    {(row.kind === 'existing' ? (branches[row.projectId] ?? []) : []).map((b) => <option key={b} value={b} />)}
                  </datalist>
                </div>
                {duplicates.includes(i) ? (
                  <div className="mt-2 text-[11px] text-red">Already chosen above — the same project cannot be used twice.</div>
                ) : null}
                {project ? (
                  <div className="mt-2 text-[11px] text-muted">
                    {project.setup.fetchBeforeBranch ? 'fetch origin · ' : ''}
                    copy {project.setup.copyPatterns.join(', ') || 'nothing'} · clone {project.setup.cloneDirs.join(', ') || 'nothing'}
                    {project.setup.postCreate ? ` · then: ${project.setup.postCreate}` : ''}
                    <button type="button" className="ml-2 text-accent hover:underline" onClick={() => useUi.getState().openDialog({ kind: 'project-settings', projectId: project.id })}>settings</button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {draft !== undefined && draft.droppedRepos.length > 0 ? (
            // `break-all`: a dropped pick is a path of up to 200 characters with no spaces to wrap at.
            <p className="mb-3 break-all text-[11px] text-muted">Ignored repos not in your repos folder: {draft.droppedRepos.join(', ')}</p>
          ) : null}
          <div className="mb-3 flex gap-2">
            <Button
              variant="ghost"
              disabled={projects.length === 0 || rows.length >= MAX_WORKSPACES}
              onClick={() => setRows((rs) => [...rs, { kind: 'existing', projectId: projects[0]!.id, baseBranch: '' }])}
            >
              + Add another project
            </Button>
            <Button variant="ghost" onClick={() => void addProjectFlow()}>Add project…</Button>
          </div>
          {draft !== undefined ? (
            <Field label="Notes" hint="Saved to the agent's notes once it is created.">
              <TextArea aria-label="Notes" rows={7} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Permission mode">
            <Select aria-label="Permission mode" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode | '')}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </Field>
          <Checkbox label="Start Claude immediately" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          <DialogActions>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!usable}>Create</Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
