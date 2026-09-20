import { useEffect, useId, useRef, useState } from 'react';
import type { DeleteInspection } from '../../../../shared/ipc-contract.ts';
import type { Agent, Id, Workspace } from '../../../../shared/types.ts';
import { isRunning } from '../../lib/agent-actions.ts';
import { runResult } from '../../lib/api.ts';
import { useSession } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useAgent, useProjects } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Checkbox, Field, TextInput } from '../ui/Field.tsx';
import { InspectionList } from './InspectionList.tsx';
import { canConfirmDelete, deleteIsRisky } from './logic.ts';

/**
 * Spec 2026-09-15 §11: take one non-primary project off an agent — the Delete dialog for a single
 * workspace. The same inspection line (`InspectionList`), the same two checkboxes with the same
 * defaults, and the same typed-name gate from `logic.ts`, unchanged, fed `{ workspaces: [thatOne] }`
 * by `agent:inspectRemoveWorkspace`. Confirmed by the AGENT's name: the agent is what the user is
 * looking at in the sidebar.
 *
 * Unlike Delete it does NOT stop the session (§11.1). A running Claude was launched with this folder
 * as an `--add-dir` and keeps it until it restarts, and the dialog says so rather than pretending.
 *
 * Two things it does that Delete does not: after a failure it re-runs the inspection, so the counts
 * the gate arms on are not stale; and it closes when the workspace disappears (removed from elsewhere,
 * or by this very request).
 *
 * Main drops the record BEFORE its branch delete (Task 9's `onWorktreeGone`), and `store.subscribe`
 * broadcasts synchronously, so the snapshot without the workspace normally arrives while the request
 * is still in flight. Hence `held` (keep drawing what was confirmed until the reply decides) and
 * `unreported` (whether that reply's failure has been reported by anything that outlives the dialog).
 */
export function RemoveWorkspaceDialog({ agentId, workspaceId }: { agentId: Id; workspaceId: Id }) {
  const close = useUi((s) => s.closeDialog);
  const toast = useUi((s) => s.toast);
  const agent = useAgent(agentId);
  const session = useSession(agentId);
  const projects = useProjects();
  // Derived below the subscriptions, never inside a selector (G59). `.find` returns a stored object.
  const workspace = agent?.workspaces.find((w) => w.id === workspaceId);
  const [inspection, setInspection] = useState<DeleteInspection | null>(null);
  const [inspectFailed, setInspectFailed] = useState(false);
  const [inspectRun, setInspectRun] = useState(0);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was on screen when Remove was pressed. While the request is in flight the workspace may
  // vanish from the snapshot BECAUSE of it; the dialog keeps drawing this until the reply decides,
  // rather than rendering nothing with `ui.dialog` still set (a blank modal state).
  const [held, setHeld] = useState<{ agent: Agent; workspace: Workspace } | null>(null);
  // The failure of the last attempt, until something shows it cannot have dropped the record: a
  // re-inspection that FINDS the workspace. Not the `error` state — that stays on screen after a
  // failure that kept the record, and a later removal from elsewhere must not be reported as this one.
  const unreported = useRef<string | null>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const branchHintId = useId();

  const gone = agent === undefined || workspace === undefined;

  useEffect(() => {
    // Nothing to ask about: main could only answer NOT_FOUND, and the effect below is closing.
    if (gone) return;
    let live = true;
    // A no-op `onError` for the reason DeleteAgentDialog gives: the failure changes what the buttons
    // do, so it belongs in this dialog, not in a toast behind it.
    void runResult('agent:inspectRemoveWorkspace', { id: agentId, workspaceId }, () => undefined).then((r) => {
      if (!live) return;
      // Main found it, so the failed attempt kept the record: nothing of it is left to report.
      if (r.ok) unreported.current = null;
      setInspection(r.ok ? r.value : { workspaces: [] });
      setInspectFailed(!r.ok);
    });
    return () => { live = false; };
  }, [agentId, workspaceId, inspectRun, gone]);

  useEffect(() => {
    // While the request is in flight the reply decides, not the snapshot.
    if (!gone || busy) return;
    // A REMOVE_INCOMPLETE whose record main dropped anyway (§11.2 step 3) vanishes WITH the error on
    // screen. Closing over it silently would lose the only report of what was left behind.
    const failure = unreported.current;
    unreported.current = null;
    if (failure !== null) toast({ level: 'error', title: 'The project was removed, but not cleanly', detail: failure, sticky: true });
    close();
  }, [gone, busy, close, toast]);

  const gate = { inspection, inspectFailed, removeWorktrees: removeWorktree, deleteBranches: deleteBranch };
  const risky = deleteIsRisky(gate);

  // Same asynchronous arming as DeleteAgentDialog: focus starts on Cancel and moves to the confirm
  // box only once the inspection says work would be lost.
  useEffect(() => {
    if (risky) confirmRef.current?.focus();
  }, [risky]);

  const shown = agent !== undefined && workspace !== undefined ? { agent, workspace } : busy ? held : null;
  if (shown === null) return null;

  const projectName = projects.find((p) => p.id === shown.workspace.projectId)?.name ?? 'missing project';
  const agentName = shown.agent.name;
  const canConfirm = canConfirmDelete({ ...gate, agentName, typed, busy });

  const confirm = async (): Promise<void> => {
    if (!canConfirm) return;
    setHeld(shown);
    setBusy(true);
    setError(null);
    unreported.current = null;
    // `force` follows `risky`, exactly as Delete's does: git refuses a dirty worktree or an unmerged
    // branch without it, and those are the cases the typed name has just unlocked.
    const result = await runResult('agent:removeWorkspace', {
      id: agentId,
      workspaceId,
      options: { removeWorktrees: removeWorktree, deleteBranches: deleteBranch, force: risky },
    }, () => undefined);
    if (result.ok) {
      toast({ level: 'info', title: `Removed ${projectName} from ${agentName}` });
      close();
      return;
    }
    const message = result.error.detail ? `${result.error.message}\n${result.error.detail}` : result.error.message;
    unreported.current = message;
    setError(message);
    // Ask again: part of the teardown may have happened, and the gate must arm on what is there now.
    // `inspectFailed` goes too — nothing is known while asking, and the red note would otherwise sit
    // beside "Inspecting the worktree…".
    setInspection(null);
    setInspectFailed(false);
    setInspectRun((n) => n + 1);
    setBusy(false);
  };

  return (
    <Dialog open title={`Remove ${projectName} from ${agentName}`} onClose={busy ? () => undefined : close} width={560} initialFocus={cancelRef}>
      <p className="mb-3 text-[12px] text-fg-2">
        {agentName} keeps its other projects. Its terminal runs in its first project, which is never removed here.
      </p>
      {isRunning(session) ? (
        <p className="mb-3 text-[12px] text-amber">The running session was launched with this folder and keeps it until it restarts.</p>
      ) : null}
      {inspection === null ? <div className="mb-3 text-[12px] text-muted">Inspecting the worktree…</div> : null}
      {inspectFailed ? (
        <p className="mb-3 rounded-md bg-red/10 p-2 text-[11px] text-red">
          The worktree could not be inspected, so there is no way to tell what would be lost. Removing will force.
        </p>
      ) : null}
      {inspection !== null ? <InspectionList workspaces={inspection.workspaces} /> : null}
      {/* A kept worktree still has the branch checked out, so git always refuses to delete it (measured
          in the Task 9 review): keeping the directory clears and disables Delete branch rather than
          offering a combination that can only fail. Same rule as DeleteAgentDialog. */}
      <Checkbox
        label="Remove worktree directory"
        checked={removeWorktree}
        onChange={(e) => {
          setRemoveWorktree(e.target.checked);
          if (!e.target.checked) setDeleteBranch(false);
        }}
      />
      <Checkbox
        label="Delete branch"
        checked={deleteBranch}
        disabled={!removeWorktree}
        aria-describedby={removeWorktree ? undefined : branchHintId}
        onChange={(e) => setDeleteBranch(e.target.checked)}
      />
      {removeWorktree ? null : (
        <p id={branchHintId} className="mb-2 ml-6 text-[11px] text-muted">The branch stays: git will not delete a branch while a worktree still has it checked out.</p>
      )}
      {risky ? (
        <Field label={`This discards work. Type the agent's name (${agentName}) to confirm:`}>
          <TextInput ref={confirmRef} aria-label="Type the agent's name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      ) : null}
      {error ? <pre className="mt-3 rounded-md bg-red/10 p-2 font-mono text-[11px] text-red select-text whitespace-pre-wrap">{error}</pre> : null}
      <DialogActions>
        <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? 'Removing…' : 'Remove'}</Button>
      </DialogActions>
    </Dialog>
  );
}
