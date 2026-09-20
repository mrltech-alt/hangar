import { useEffect, useId, useRef, useState } from 'react';
import type { DeleteInspection } from '../../../../shared/ipc-contract.ts';
import type { Id } from '../../../../shared/types.ts';
import { run, runResult } from '../../lib/api.ts';
import { layoutStore } from '../../stores/layout.ts';
import { useUi } from '../../stores/ui.ts';
import { useAgent } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Checkbox, Field, TextInput } from '../ui/Field.tsx';
import { InspectionList } from './InspectionList.tsx';
import { canConfirmDelete, deleteIsRisky } from './logic.ts';

export function DeleteAgentDialog({ agentId }: { agentId: Id }) {
  const close = useUi((s) => s.closeDialog);
  const agent = useAgent(agentId);
  const [inspection, setInspection] = useState<DeleteInspection | null>(null);
  const [inspectFailed, setInspectFailed] = useState(false);
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const branchHintId = useId();

  useEffect(() => {
    let live = true;
    // A no-op `onError`: the failure is shown inside this dialog, where it changes what the
    // buttons do, rather than as a toast behind a modal.
    void runResult('agent:inspectDelete', { id: agentId }, () => undefined).then((r) => {
      if (!live) return;
      // On failure the inspection is set to an EMPTY list, not left null — null means "still
      // asking" and would leave Delete disabled forever. `inspectFailed` is what then arms the
      // typed-name gate, because an unanswered question is not an answer of zero.
      setInspection(r.ok ? r.value : { workspaces: [] });
      setInspectFailed(!r.ok);
    });
    return () => { live = false; };
  }, [agentId]);

  const gate = { inspection, inspectFailed, removeWorktrees, deleteBranches };
  const risky = deleteIsRisky(gate);

  /**
   * The force gate arms ASYNCHRONOUSLY. `Dialog` focuses `cancelRef` when it opens, because at
   * that moment `inspection` is still null, nothing is known to be at risk, and the least
   * destructive control is the one that dismisses. When `agent:inspectDelete` comes back and says
   * work would be lost, the confirm box appears and focus moves to it — the only control that can
   * make Delete pressable.
   *
   * Not `autoFocus` on that input. It would in fact work here (the element mounts into a dialog
   * that is ALREADY open, which is the one case React's commit-time `.focus()` survives), but that
   * distinction is exactly the trap `ui/Dialog.tsx` documents, so both paths use one mechanism.
   */
  useEffect(() => {
    if (risky) confirmRef.current?.focus();
  }, [risky]);

  if (!agent) return null;

  const canConfirm = canConfirmDelete({ ...gate, agentName: agent.name, typed, busy });

  const confirm = async (): Promise<void> => {
    if (!canConfirm) return;
    setBusy(true);
    // `force` follows `risky` exactly: git refuses to remove a dirty worktree or delete an
    // unmerged branch without it, and those are precisely the cases the typed name has just
    // unlocked. `agent:delete` has `res: void`, so `!== null` is what distinguishes success.
    const result = await run('agent:delete', { id: agentId, options: { removeWorktrees, deleteBranches, force: risky } });
    setBusy(false);
    if (result !== null) {
      layoutStore.getState().removeAgent(agentId);
      close();
    }
  };

  return (
    <Dialog open title={`Delete ${agent.name}`} onClose={busy ? () => undefined : close} width={560} initialFocus={cancelRef}>
      <p className="mb-3 text-[12px] text-fg-2">The Claude session will be stopped first.</p>
      {inspection === null ? <div className="mb-3 text-[12px] text-muted">Inspecting worktrees…</div> : null}
      {inspectFailed ? (
        <p className="mb-3 rounded-md bg-red/10 p-2 text-[11px] text-red">
          The worktrees could not be inspected, so there is no way to tell what would be lost. Deleting will force.
        </p>
      ) : null}
      {inspection !== null ? <InspectionList workspaces={inspection.workspaces} /> : null}
      {/* A kept worktree still has its branch checked out, so git always refuses to delete it (measured
          in Plan 06's Task 9 review): keeping the directories clears and disables Delete branch(es)
          rather than offering a combination that can only fail. Same rule as RemoveWorkspaceDialog. */}
      <Checkbox
        label="Remove worktree directory(ies)"
        checked={removeWorktrees}
        onChange={(e) => {
          setRemoveWorktrees(e.target.checked);
          if (!e.target.checked) setDeleteBranches(false);
        }}
      />
      <Checkbox
        label="Delete branch(es)"
        checked={deleteBranches}
        disabled={!removeWorktrees}
        aria-describedby={removeWorktrees ? undefined : branchHintId}
        onChange={(e) => setDeleteBranches(e.target.checked)}
      />
      {removeWorktrees ? null : (
        <p id={branchHintId} className="mb-2 ml-6 text-[11px] text-muted">Branches stay: git will not delete a branch while a worktree still has it checked out.</p>
      )}
      {risky ? (
        <Field label={`This discards work. Type the agent's name (${agent.name}) to confirm:`}>
          <TextInput ref={confirmRef} aria-label="Type the agent's name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      ) : null}
      <DialogActions>
        <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? 'Deleting…' : 'Delete'}</Button>
      </DialogActions>
    </Dialog>
  );
}
