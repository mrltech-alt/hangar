/**
 * The parts of spec §12.6's four dialogs that are decisions rather than markup: the progress-list
 * reduction, the delete force-confirm gate, the base-branch suggestions and the two small list
 * transforms Project Settings needs. Pure, so each can be tested without a React root — the
 * components above them are then thin enough that their own tests can stay about rendering and
 * event routing.
 */
import { PROGRESS_STEP_ROLLBACK, PROGRESS_STEP_SAVED, type DeleteInspection, type ProgressEvent } from '../../../../shared/ipc-contract.ts';
import type { Id, Project, Workspace } from '../../../../shared/types.ts';

/** Spec §12.6: "spinner / ✓ / ⚠ / ✗". */
export const PROGRESS_GLYPH: Record<ProgressEvent['status'], string> = {
  running: '…',
  done: '✓',
  warn: '⚠',
  error: '✗',
};

/**
 * Fold one `agent:progress` event into the list the dialog renders.
 *
 * A step is emitted at least twice — `running`, then `done`/`warn`/`error` — so this is an UPSERT
 * keyed by `(opId, step)`, not an append: appending shows "fetch" twice, once forever spinning.
 * `opId` is part of the key because `agent-service.ts` mints a fresh one per operation, so a Retry
 * must not silently overwrite the previous attempt's lines if they are still on screen.
 *
 * Order is insertion order and the update keeps the step's original slot: a step that finishes
 * after a later one started must not jump to the bottom of the list.
 */
export function reduceProgress(list: readonly ProgressEvent[], event: ProgressEvent): ProgressEvent[] {
  const i = list.findIndex((x) => x.opId === event.opId && x.step === event.step);
  return i === -1 ? [...list, event] : list.map((x, j) => (j === i ? event : x));
}

/**
 * The step that actually failed never gets a terminal event: `provisionWorkspace` emits
 * `running` and then throws, so it is left mid-spinner while `rollback` below it reads ✓ and the
 * only ✗ is the trailing `failed` line. Spec §12.6 asks for "the failing step highlighted", so
 * once the call has rejected, anything still `running` is retroactively an error.
 *
 * Call this ONLY after the promise settles. Applied mid-flight it would mark the step currently
 * in progress as failed.
 */
export function failStalledSteps(list: readonly ProgressEvent[]): ProgressEvent[] {
  return list.map((p) => (p.status === 'running' ? { ...p, status: 'error' as const } : p));
}

/**
 * Did the failed create nevertheless leave an agent behind?
 *
 * `createAgent` awaits `startAgent(id, 'auto')` AFTER committing the agent record, with no catch
 * of its own, so `startNow` plus a disconnected host rejects `agent:create` for an agent that
 * exists and was never rolled back. Retrying that would create a second one, so the dialog offers
 * Close rather than Retry when this is true.
 */
export function agentWasSaved(list: readonly ProgressEvent[]): boolean {
  return list.some((p) => p.step === PROGRESS_STEP_SAVED && p.status === 'done');
}

/** The id the operation was creating, for the "it exists anyway" path above. */
export function progressAgentId(list: readonly ProgressEvent[]): Id | null {
  for (const p of list) if (p.agentId !== null) return p.agentId;
  return null;
}

/** Whether the failed attempt tore its own worktrees down again — the precondition for a safe Retry. */
export function rollbackRan(list: readonly ProgressEvent[]): boolean {
  return list.some((p) => p.step === PROGRESS_STEP_ROLLBACK);
}

/**
 * Base-branch suggestions for the datalist, as BARE branch names.
 *
 * `project:listBranches` answers `{ local: ['main', …], remote: ['origin/main', …] }` (git.ts
 * strips only `refs/remotes/`), but the value goes to `agent:create`'s `baseBranch`, and
 * `agent-service.baseRefFor` resolves it as `refs/remotes/origin/<base>` then `refs/heads/<base>`.
 * So offering `origin/main` verbatim — which the plan's `[...b.local, ...b.remote]` does — makes
 * the suggestion the user is most likely to pick resolve to `refs/remotes/origin/origin/main`,
 * then `refs/heads/origin/main`, and fail with BASE_NOT_FOUND every time.
 *
 * Locals first (they are what the user usually means), then remote-only names, de-duplicated.
 */
export function branchOptions(branches: { local: string[]; remote: string[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const b of branches.local) push(b);
  // `origin/feature/x` → `feature/x`: strip the remote, which is always the first segment, not
  // every segment. A `slice(lastIndexOf('/'))` would offer `x`, which is a different branch.
  // An entry with NO slash is the remote itself rather than a branch on it — git.ts's own comment
  // records that `%(refname:short)` collapses `refs/remotes/origin/HEAD` to a bare `origin`, and
  // `indexOf('/') + 1` is 0 for that, which would offer "origin" as a base branch.
  for (const r of branches.remote) {
    const cut = r.indexOf('/');
    if (cut !== -1) push(r.slice(cut + 1));
  }
  return out;
}

/** A textarea of one-per-line values → the trimmed, non-empty list the contract stores. */
export function linesOf(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Rows whose project was already chosen by an EARLIER row. Spec §12.6: "Duplicate projects
 * rejected" — `agent-service.createAgent` throws INVALID for it, so catching it here is what turns
 * a failed round trip into a disabled button with a reason next to the offending row.
 */
export function duplicateRowIndexes(projectIds: readonly Id[]): number[] {
  const seen = new Set<Id>();
  const dupes: number[] = [];
  for (const [i, id] of projectIds.entries()) {
    if (seen.has(id)) dupes.push(i);
    else seen.add(id);
  }
  return dupes;
}

/**
 * The projects an agent can still be given a workspace on (spec §12.6's "Duplicate projects
 * rejected", read from the other side).
 *
 * `agent-service.addWorkspace` throws INVALID for a project the agent already has, so this does not
 * close a hole — it is the same rule stated where the user can act on it, exactly as
 * `duplicateRowIndexes` is for the New Agent dialog. Filtering the OPTIONS rather than validating
 * the choice is what makes the duplicate unspellable instead of a failed round trip: there is only
 * one field, so a rejected value would leave the dialog with nothing valid to offer.
 *
 * Order is `projects` order, so the list reads the same as everywhere else in the app.
 */
export function addableProjects(projects: readonly Project[], workspaces: readonly Workspace[]): Project[] {
  const taken = new Set<Id>(workspaces.map((w) => w.projectId));
  return projects.filter((p) => !taken.has(p.id));
}

export interface DeleteGate {
  inspection: DeleteInspection | null;
  /** `agent:inspectDelete` itself rejected — we know nothing at all about what is on disk. */
  inspectFailed: boolean;
  removeWorktrees: boolean;
  deleteBranches: boolean;
}

/**
 * Does this delete discard work? Spec §12.6 arms the typed-name gate when "any workspace is dirty
 * or has unmerged commits and the corresponding checkbox is on".
 *
 * `inspectionFailed` (per workspace) and a wholesale inspect failure arm it REGARDLESS of the
 * checkboxes. The contract's own comment on the field says why: a broken `.git` link answers "not
 * a git repository", so every count reads 0 while real files sit in a directory that
 * `worktreeMissing` reports as present. A count of 0 that git could not establish must read as
 * "unknown", and unknown arms the gate rather than disarming it — this is the only gate on the
 * operation. It costs a user three seconds of typing in the case where nothing was at risk.
 */
export function deleteIsRisky(g: DeleteGate): boolean {
  if (g.inspectFailed) return true;
  return (g.inspection?.workspaces ?? []).some((w) =>
    w.inspectionFailed
    || (g.removeWorktrees && w.dirtyFiles > 0)
    || (g.deleteBranches && w.unmergedCommits > 0));
}

/**
 * The confirm button's enablement. Never before the inspection has answered — the checkboxes are
 * on by default, so a click during the round trip would delete under numbers nobody had seen.
 *
 * `typed` is trimmed before comparison: agent names are trimmed on the way in
 * (`AgentNameSchema`), so a trailing space from a copy-paste can never be part of the real name,
 * and leaving it un-trimmed only produces a gate that looks broken. The gate is still an exact
 * match on the name itself.
 */
export function canConfirmDelete(g: DeleteGate & { agentName: string; typed: string; busy: boolean }): boolean {
  if (g.inspection === null || g.busy) return false;
  return !deleteIsRisky(g) || g.typed.trim() === g.agentName.trim();
}
