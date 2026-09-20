import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_WORKSPACES_MAX } from '../../../../shared/constants.ts';
import type { ProgressEvent } from '../../../../shared/ipc-contract.ts';
import { addDirKeystrokes } from '../../../../shared/project-actions.ts';
import type { Id } from '../../../../shared/types.ts';
import { isRunning } from '../../lib/agent-actions.ts';
import { api, run, runResult } from '../../lib/api.ts';
import { focusTerminal } from '../../lib/terminal-registry.ts';
import { useSession } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useAgent, useProjects } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Field, Select, TextInput } from '../ui/Field.tsx';
import { addableProjects, branchOptions, failStalledSteps, reduceProgress } from './logic.ts';
import { ProgressList } from './ProgressList.tsx';

/**
 * Spec §10.3 / §12.6: give an agent that already has a workspace a second (or third) project.
 *
 * The provisioning is `agent-service.addWorkspace`, unchanged — the same `provisionWorkspace` the
 * New Agent dialog drives, with the same `agent:progress` stream, the same rollback ledger and the
 * same slug decision. This dialog adds no provisioning of its own; a second route that drifted from
 * the first is the failure the service's own comments are written against.
 *
 * Three things it must not get wrong, all of them decided in main and only *reported* here:
 *
 * - **The primary workspace stays primary.** `addWorkspace` appends, so `workspaces[0]` — the PTY's
 *   cwd (§6.4), and the project whose §15.4 actions the pane header offers — is untouched. Nothing
 *   in this dialog can reorder it, and there is deliberately no control that would.
 * - **A duplicate project is unspellable**, because `addableProjects` removes it from the one
 *   `<select>` there is. Main rejects it too (INVALID); this is the same rule where the user is.
 * - **A full agent gets a reason, not a disabled button.** `AGENT_WORKSPACES_MAX` is enforced in
 *   `agent-service.addWorkspace` and by the persisted `AgentSchema`; offering a picker that can only
 *   fail is the worse half of that. The form is replaced by the same closing panel the
 *   "every project is already added" case uses.
 * - **A failed add leaves nothing behind.** `addWorkspace` rolls its worktree and branch back and
 *   writes the agent record only on success, so the form stays open on an error and re-submitting
 *   is the retry — there is no half-added workspace to clean up first.
 */
export function AddWorkspaceDialog({ agentId }: { agentId: Id }) {
  const close = useUi((s) => s.closeDialog);
  const toast = useUi((s) => s.toast);
  const agent = useAgent(agentId);
  const session = useSession(agentId);
  const projects = useProjects();
  // Derived AFTER the subscriptions, never inside a selector: a `.filter(...)` handed to zustand 5
  // is G59's infinite render loop, not a wasted allocation. The `useMemo` is NOT part of that fix
  // and nothing depends on it — it keeps the identity stable so the repair effect below re-runs
  // when the workspace changes rather than on every render, and that effect is idempotent either
  // way. Measured: dropping the memo leaves every test in this feature green.
  const options = useMemo(() => addableProjects(projects, agent?.workspaces ?? []), [projects, agent]);

  // Seeded lazily from the first addable project rather than left empty for the effect below to
  // fill: setting it from an effect costs a second commit on every open, and shows an empty picker
  // for one frame.
  const [projectId, setProjectId] = useState(() => options[0]?.id ?? '');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<Record<Id, string[]>>({});
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `autoFocus` is a measured no-op inside a `<dialog>` opened with `showModal()` (G62), so the
  // control that should have focus is named for `Dialog` to focus after it is shown.
  const projectRef = useRef<HTMLSelectElement>(null);

  /**
   * Repairs the selection when the chosen project stops being addable: the snapshot arriving after
   * a pre-bootstrap open (where `options` started empty, so the lazy seed above got nothing), or
   * the project being removed under the dialog. Without it the first case stays on `''` — Add
   * disabled — with a populated picker on screen.
   */
  useEffect(() => {
    if (options.length > 0 && !options.some((p) => p.id === projectId)) setProjectId(options[0]!.id);
  }, [options, projectId]);

  /**
   * `agent:progress` is a broadcast, not a reply: `createAgent` for some other agent emits into it
   * too, and `reduceProgress` keys on `(opId, step)`, so an unfiltered subscription would interleave
   * another operation's steps into this list. The service stamps every event with the agent it is
   * working on, which is the only thing here that can tell them apart.
   */
  useEffect(() => api.on('agent:progress', (p) => {
    if (p.agentId !== agentId) return;
    setProgress((list) => reduceProgress(list, p));
  }), [agentId]);

  // Cached per project and asked at most once each, for the same reason NewAgentDialog's version
  // is: a repo with no branches, or one whose listing fails, never fills the map, so keying the
  // effect on "the list is still empty" re-fires forever.
  const requested = useRef<Set<Id>>(new Set());
  useEffect(() => {
    if (projectId === '' || requested.current.has(projectId)) return;
    requested.current.add(projectId);
    // A no-op `onError`: an unlistable repo still adds fine (the base falls back to the project's
    // default branch), so this must not raise a toast.
    void runResult('project:listBranches', { id: projectId }, () => undefined).then((r) => {
      if (r.ok) setBranches((m) => ({ ...m, [projectId]: branchOptions(r.value) }));
    });
  }, [projectId]);

  if (agent === undefined) return null;
  // Read AFTER the early return so `agent` is narrowed; it is a plain length comparison, not a
  // subscription, so there is no G59 exposure in it.
  const full = agent.workspaces.length >= AGENT_WORKSPACES_MAX;

  const submit = async (): Promise<void> => {
    if (busy || projectId === '') return;
    setBusy(true);
    setError(null);
    setProgress([]);
    const result = await runResult('agent:addWorkspace', {
      id: agentId,
      projectId,
      baseBranch: baseBranch.trim() === '' ? null : baseBranch.trim(),
    }, () => undefined);
    if (!result.ok) {
      // Anything still spinning is the step that threw; the form stays on screen, so editing the
      // base branch and pressing Add again IS the retry (main rolled the failed attempt back).
      setProgress(failStalledSteps);
      setError(result.error.detail ? `${result.error.message}\n${result.error.detail}` : result.error.message);
      setBusy(false);
      return;
    }
    const name = projects.find((p) => p.id === projectId)?.name ?? 'the project';
    if (isRunning(session)) {
      /**
       * A running session cannot be given the directory from here. `--add-dir` is composed once, at
       * launch (`claude-launch.composeClaudeArgs`), from `workspaces.slice(1)` — so this worktree,
       * which did not exist when the session started, is not in its argv and nothing this app does
       * will put it there. The two honest options are a restart (which would discard the running
       * conversation) or letting the session take it itself, so the `/add-dir` line is TYPED at the
       * prompt with no newline and the user submits it, exactly as a §15.4 project action is.
       *
       * The toast says what was typed rather than claiming the directory was added: whether the
       * session accepts it is Claude Code's business, and nothing here can observe the answer.
       */
      void run('session:write', { agentId, data: addDirKeystrokes(result.value.worktreePath) });
      // Pressing Enter is the rest of this gesture, and the dialog is about to close — without this
      // the keystroke goes to whatever the dialog was covering. A no-op when the agent is not open
      // in a pane, which is exactly right: there is nothing to press Enter in.
      focusTerminal(agentId);
      toast({
        level: 'info',
        title: `Added ${name} to ${agent.name}`,
        detail: 'The running session was started without this directory. `/add-dir …` is typed at its prompt — press Enter to hand it over, or restart the agent.',
      });
    } else {
      toast({
        level: 'info',
        title: `Added ${name} to ${agent.name}`,
        detail: 'Claude gets it with --add-dir the next time this agent starts.',
      });
    }
    close();
  };

  const project = options.find((p) => p.id === projectId);
  return (
    <Dialog open title={`Add a project to ${agent.name}`} onClose={busy ? () => undefined : close} width={520} initialFocus={projectRef}>
      {full || options.length === 0 ? (
        <div>
          <p className="text-[12px] text-muted">
            {full
              ? `${agent.name} already has the maximum of ${AGENT_WORKSPACES_MAX} projects. Remove one (right-click the agent → Remove project from this agent), or create a second agent for the rest.`
              : projects.length === 0
                ? 'No projects yet — add a git repository from the sidebar first.'
                : `Every project is already part of ${agent.name}.`}
          </p>
          <DialogActions>
            <Button variant="ghost" onClick={close}>Close</Button>
          </DialogActions>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Project" hint={`a second worktree on branch agent/${agent.slug} (suffixed if that branch is taken in this repo)`}>
            <Select ref={projectRef} aria-label="Project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setBaseBranch(''); }} disabled={busy}>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Base branch">
            <TextInput
              aria-label="Base branch"
              list="add-workspace-branches"
              placeholder={`base: ${project?.defaultBranch ?? 'default'}`}
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={busy}
            />
            <datalist id="add-workspace-branches">
              {(branches[projectId] ?? []).map((b) => <option key={b} value={b} />)}
            </datalist>
          </Field>
          {project ? (
            <div className="mb-3 text-[11px] text-muted">
              {project.setup.fetchBeforeBranch ? 'fetch origin · ' : ''}
              copy {project.setup.copyPatterns.join(', ') || 'nothing'} · clone {project.setup.cloneDirs.join(', ') || 'nothing'}
              {project.setup.postCreate ? ` · then: ${project.setup.postCreate}` : ''}
            </div>
          ) : null}
          {/* The agent's shell stays where it is. §15.4's actions come from `workspaces[0]`'s
              project for the same reason, and saying so here is cheaper than the surprise. */}
          <p className="mb-3 text-[11px] text-muted">
            {agent.name}&apos;s terminal keeps running in its first worktree. An added project is a directory Claude can read and write, not a second shell.
          </p>
          {progress.length > 0 ? <ProgressList items={progress} /> : null}
          {error ? <pre className="mt-3 rounded-md bg-red/10 p-2 font-mono text-[11px] text-red select-text whitespace-pre-wrap">{error}</pre> : null}
          <DialogActions>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || projectId === ''}>{busy ? 'Adding…' : 'Add'}</Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
