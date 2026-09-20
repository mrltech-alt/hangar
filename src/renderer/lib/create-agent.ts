// The four-step create sequence — spec 2026-09-15 §7, called by BOTH the New Agent dialog and the
// whole-cycle run (spec 2026-09-17 §4, "the single-ticket path, called in a loop").
//
// It lives here rather than in `NewAgentDialog` because the second caller arrived. Four pieces of
// behaviour hang off these four calls and every one of them was learned the hard way:
//   1. `PROJECT_EXISTS` is a SUCCESS — the repo was registered since the draft was made.
//   2. The folder is RE-CHECKED before it is created — the owner may have made it since, and the
//      cycle run relies on this to make `Cycle 33` exactly once across a whole run.
//   3. An `agent:create` that fails AFTER emitting `saved` left an agent that EXISTS. Retrying it
//      makes a second one, so the outcome says `saved` and the caller must not offer a retry.
//   4. A notes failure does NOT roll the agent back.
// A second implementation would have to get all four right and stay right. This one is UI-free —
// no toasts, no dialog, no navigation — so each caller draws its own answer from the outcome.
import type { ProgressEvent } from '../../../shared/ipc-contract.ts';
import { findTopLevelFolder, type DraftFolder } from '../../../shared/linear-draft.ts';
import type { Agent, Id, PermissionMode, Project } from '../../../shared/types.ts';
import { agentWasSaved, progressAgentId } from '../components/dialogs/logic.ts';
import { useWorkspace } from '../stores/workspace.ts';
import { api, runResult, type IpcFailure, type RunResult } from './api.ts';

/**
 * A row is a registered project picked from the select, or — only ever from a ticket draft — a repo
 * that is not a project yet and is registered with `project:add` when the sequence runs.
 */
export type CreateRow =
  | { kind: 'existing'; projectId: Id; baseBranch: string }
  | { kind: 'new'; repoPath: string; name: string; baseBranch: string };

export interface CreateAgentRequest {
  name: string;
  folder: DraftFolder;
  rows: readonly CreateRow[];
  notes: string;
  permissionMode: PermissionMode | null;
  startNow: boolean;
}

export type CreateAgentOutcome =
  | {
      ok: true;
      agent: Agent;
      /** The notes could not be saved. The agent exists and is fine; the caller decides whether to say so. */
      notesFailed: string | null;
    }
  | {
      ok: false;
      message: string;
      /**
       * The agent record was committed before the failure (`agent:create` emitted `saved` and then
       * threw — `startNow` against a disconnected host is the measured case). Retrying makes a
       * SECOND agent, so a caller that offers a retry must not offer it when this is true.
       */
      saved: boolean;
      agentId: Id | null;
    };

export const describeFailure = (e: IpcFailure): string => (e.detail ? `${e.message}\n${e.detail}` : e.message);

/**
 * The `opId`s that in-flight sequences have already bound themselves to.
 *
 * `agent:progress` is a BROADCAST with no addressing, and two creates can genuinely overlap: the
 * whole-cycle run is strictly sequential, but the New Agent dialog stays reachable while it runs.
 * Without this, the dialog's create donates its `saved` step and its agent id to whichever sequence
 * is listening — which would make the run refuse a Retry that is actually safe, and offer an agent
 * it never created. `agent-service.ts`'s `progressFor` mints one `opId` per operation and stamps it
 * on every event, so binding to one `opId` is binding to one create.
 */
const RECORDING_OPS = new Set<Id>();

/**
 * Spec 2026-09-15 §7 step 1, for one row. PROJECT_EXISTS is not a failure: the repo was registered
 * since the draft was made (by "Add project…", or by an earlier Create that failed further on), so the
 * project is resolved by repoPath from the snapshot as it is NOW — read, not subscribed to.
 */
export async function projectFor(repoPath: string): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
  const added = await runResult('project:add', { repoPath }, () => undefined);
  if (added.ok) return { ok: true, project: added.value };
  if (added.error.code === 'PROJECT_EXISTS') {
    const known = useWorkspace.getState().snapshot?.workspace.projects.find((p) => p.repoPath === repoPath);
    if (known) return { ok: true, project: known };
  }
  return { ok: false, message: describeFailure(added.error) };
}

/**
 * §7 step 2: re-check for the top-level folder first — the owner may have made it since the draft was.
 *
 * This is also what makes the cycle run's "created once if missing" true without the run tracking
 * anything: the second ticket's sequence finds the folder the first one made.
 */
export async function folderNamed(name: string): Promise<{ ok: true; folderId: Id } | { ok: false; message: string }> {
  const existing = findTopLevelFolder(useWorkspace.getState().snapshot?.workspace.folders ?? [], name);
  if (existing) return { ok: true, folderId: existing.id };
  const made = await runResult('folder:create', { name, parentId: null }, () => undefined);
  return made.ok ? { ok: true, folderId: made.value.id } : { ok: false, message: describeFailure(made.error) };
}

/**
 * The whole sequence, stopping at the first failure.
 *
 * Whatever an earlier step made — a registered project, a folder — is harmless and stays: a retry
 * finds it again through `PROJECT_EXISTS` and the folder re-check, which is exactly why those two
 * behaviours are in here rather than in a caller.
 *
 * `onProgress` is optional and exists for the New Agent dialog's live list. The sequence keeps its
 * OWN record regardless, because `saved` has to be knowable even when no caller is listening — a
 * dialog closed mid-create still has to tell "not created" from "created, did not start".
 */
export async function createAgentSequence(req: CreateAgentRequest, onProgress?: (p: ProgressEvent) => void): Promise<CreateAgentOutcome> {
  // 1. Register the "will be added" repos.
  const workspaces: { projectId: Id; baseBranch: string | null }[] = [];
  for (const row of req.rows) {
    const typed = row.baseBranch.trim() === '' ? null : row.baseBranch.trim();
    if (row.kind === 'existing') {
      workspaces.push({ projectId: row.projectId, baseBranch: typed });
      continue;
    }
    const added = await projectFor(row.repoPath);
    if (!added.ok) return { ok: false, message: `${row.name}: ${added.message}`, saved: false, agentId: null };
    workspaces.push({ projectId: added.project.id, baseBranch: typed ?? added.project.defaultBranch });
  }

  // 2. The folder, unless it exists by now.
  let folderId: Id | null = req.folder.kind === 'existing' ? req.folder.folderId : null;
  if (req.folder.kind === 'new') {
    const made = await folderNamed(req.folder.name);
    if (!made.ok) return { ok: false, message: made.message, saved: false, agentId: null };
    folderId = made.folderId;
  }

  // 3. The agent. `runResult`, not a bare `api.invoke`: the failure belongs to the caller, and the
  // no-op `onError` is what suppresses the global toast sink.
  //
  // The recorder binds to exactly ONE operation — see `RECORDING_OPS`. `events[0]` IS the claim:
  // the first event this sequence accepted, and the only `opId` it accepts from then on.
  const events: ProgressEvent[] = [];
  const stopRecording = api.on('agent:progress', (p) => {
    const claimed = events[0];
    if (claimed === undefined) {
      if (RECORDING_OPS.has(p.opId)) return;   // another in-flight sequence's create, not ours
      RECORDING_OPS.add(p.opId);
    } else if (p.opId !== claimed.opId) {
      return;
    }
    events.push(p);
    onProgress?.(p);
  });
  let result: RunResult<Agent>;
  try {
    result = await runResult('agent:create', {
      // Trimmed HERE and not only in the dialog: `agent:create` names the branch after the agent,
      // and the cycle run would otherwise have to remember to trim what it composed from a ticket.
      name: req.name.trim(),
      folderId,
      workspaces,
      permissionMode: req.permissionMode,
      startNow: req.startNow,
    }, () => undefined);
  } finally {
    // In a `finally` because both halves must happen on every path: a listener left subscribed
    // outlives every sequence that made one, and a claim left standing would make the NEXT create
    // skip its own events and report `saved: false` for an agent that exists.
    stopRecording();
    const claimed = events[0];
    if (claimed !== undefined) RECORDING_OPS.delete(claimed.opId);
  }
  if (!result.ok) {
    return { ok: false, message: describeFailure(result.error), saved: agentWasSaved(events), agentId: progressAgentId(events) };
  }

  // 4. The notes. The agent exists now, so a failure here does not roll it back (§7 step 4).
  let notesFailed: string | null = null;
  if (req.notes.trim() !== '') {
    const saved = await runResult('agent:update', { id: result.value.id, patch: { notes: req.notes } }, () => undefined);
    if (!saved.ok) notesFailed = describeFailure(saved.error);
  }
  return { ok: true, agent: result.value, notesFailed };
}
