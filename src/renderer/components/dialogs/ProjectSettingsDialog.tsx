import { useRef, useState } from 'react';
import { actionsProblem, formatActionLines, parseActionLines } from '../../../../shared/project-actions.ts';
import type { Id } from '../../../../shared/types.ts';
import { DirSegmentSchema } from '../../../../shared/workspace-schema.ts';
import { run } from '../../lib/api.ts';
import { useUi } from '../../stores/ui.ts';
import { useProject, useWorkspace } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Checkbox, Field, TextArea, TextInput } from '../ui/Field.tsx';
import { linesOf } from './logic.ts';

export function ProjectSettingsDialog({ projectId }: { projectId: Id }) {
  const close = useUi((s) => s.closeDialog);
  const project = useProject(projectId);
  // A NUMBER out of the selector, never the filtered array: zustand 5 hands the selector to
  // `useSyncExternalStore`, and a fresh array per call is G59's infinite render loop.
  const inUse = useWorkspace((s) => s.snapshot?.workspace.agents.filter((a) => a.workspaces.some((w) => w.projectId === projectId)).length ?? 0);
  const [name, setName] = useState(project?.name ?? '');
  const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? 'main');
  const [fetchFirst, setFetchFirst] = useState(project?.setup.fetchBeforeBranch ?? true);
  const [copy, setCopy] = useState(project?.setup.copyPatterns.join('\n') ?? '');
  const [clone, setClone] = useState(project?.setup.cloneDirs.join('\n') ?? '');
  const [postCreate, setPostCreate] = useState(project?.setup.postCreate ?? '');
  const [claudeArgs, setClaudeArgs] = useState(project?.claudeArgs.join('\n') ?? '');
  const [actionText, setActionText] = useState(formatActionLines(project?.actions ?? []));
  // `?? false`, so a project saved before §11.9 renders unchecked rather than making the input
  // uncontrolled — `checked={undefined}` would hand React an uncontrolled checkbox for one render.
  const [shareMemory, setShareMemory] = useState(project?.shareClaudeMemory ?? false);
  // Every control here is a form field and the only destructive one (`Remove project`) sits in
  // the footer, so the first field is both the least destructive target and the one someone
  // opening "Project settings" is most likely to have come to change.
  const nameRef = useRef<HTMLInputElement>(null);
  if (!project) return null;

  // `project:update` validates `name` with `DirSegmentSchema` — the project name becomes a
  // directory segment under HANGAR_HOME/worktrees (spec §6.2), so `a/b` is rejected on arrival.
  // Reusing the schema means the Save button says so before the round trip rather than after it.
  const nameOk = DirSegmentSchema.safeParse(name).success;
  const branchOk = defaultBranch.trim().length > 0;
  // Parsed once per render and used for BOTH the problem message and the payload, so the button's
  // enablement and what Save sends can never be computed from two different readings of the text.
  const actions = parseActionLines(actionText);
  // A REPORT, not a repair: `parseActionLines` already dropped blank lines and stripped control
  // characters (invisible to intent), but an over-long command is refused rather than truncated —
  // running the first 500 characters of a command line is a different command. `project:update`
  // enforces the same bounds, so this only moves the refusal ahead of the round trip.
  const actionProblem = actionsProblem(actions);
  const save = async (): Promise<void> => {
    // Unreachable through the UI, and measured to be: removing this whole line — including the
    // pre-existing name/branch clauses — leaves all 73 dialog tests green, because the Save button
    // is the only caller and it carries the same three conditions. Kept anyway, and the actions
    // clause added to it, so the guard and the button cannot drift if `save` ever gains a second
    // caller (an Enter-to-submit handler is the obvious one). Do not read it as tested defence.
    if (!nameOk || !branchOk || actionProblem !== null) return;
    const updated = await run('project:update', {
      id: projectId,
      patch: {
        name: name.trim(),
        defaultBranch: defaultBranch.trim(),
        setup: {
          fetchBeforeBranch: fetchFirst,
          copyPatterns: linesOf(copy),
          cloneDirs: linesOf(clone),
          postCreate: postCreate.trim() === '' ? null : postCreate.trim(),
        },
        claudeArgs: linesOf(claudeArgs),
        actions,
        shareClaudeMemory: shareMemory,
      },
    });
    if (updated) close();
  };
  const remove = async (): Promise<void> => {
    // `project:remove` has `res: void`, so `run` resolves `undefined` on SUCCESS and `null` on
    // failure — `!== null` is the difference, and `if (r)` would never close the dialog.
    const result = await run('project:remove', { id: projectId });
    if (result !== null) close();
  };
  return (
    <Dialog open title={`Project: ${project.name}`} onClose={close} width={560} initialFocus={nameRef}>
      <Field label="Name" hint={nameOk ? undefined : 'A single directory segment: no "/", and not "." or ".."'}>
        <TextInput ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Repository" hint="read-only"><TextInput value={project.repoPath} readOnly /></Field>
      <Field label="Default branch"><TextInput value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} /></Field>
      <Checkbox label="Fetch origin before creating a branch" checked={fetchFirst} onChange={(e) => setFetchFirst(e.target.checked)} />
      <Field label="Files to copy into new worktrees (one pattern per line)" hint="gitignored files agents need: .env, .claude/settings.local.json…">
        <TextArea rows={3} value={copy} onChange={(e) => setCopy(e.target.value)} />
      </Field>
      <Field label="Directories to clone (APFS copy-on-write, one per line)">
        <TextArea rows={2} value={clone} onChange={(e) => setClone(e.target.value)} />
      </Field>
      <Field label="Post-create command" hint="runs in an interactive login shell inside the new worktree, e.g. npm ci">
        <TextInput value={postCreate} onChange={(e) => setPostCreate(e.target.value)} />
      </Field>
      <Field label="Extra claude arguments (one per line)" hint="e.g. --model then opus on the next line">
        <TextArea rows={2} value={claudeArgs} onChange={(e) => setClaudeArgs(e.target.value)} />
      </Field>
      {/* §11.9. Off by default because it is a FALLBACK, not a fix: Claude Code already keys
          auto-memory by the canonical git repository root, resolving a worktree's `.git` pointer
          back to the main checkout, so worktrees of one repo share a memory directory without this.
          Turn it on for a repo where that resolution does not hold. It takes effect the next time an
          agent on this project starts — the per-agent settings file is generated at launch. */}
      <Checkbox
        label="Share Claude auto-memory with the main checkout"
        checked={shareMemory}
        onChange={(e) => setShareMemory(e.target.checked)}
      />
      <p className="mb-3 text-[11px] text-muted">
        Pins every agent on this project to <code>{project.repoPath}</code>&apos;s memory. Claude normally shares it across worktrees already; applies at the next start.
      </p>
      {/* The hint says "types" and "without running it" on purpose: that is the whole safety model
          of §15.4, and a user who believes the button RUNS the command will write a different
          command. The first `=` splits the line, so `Env = FOO=1 npm test` works. */}
      <Field
        label="Actions (one per line: label = command)"
        hint={actionProblem ?? 'buttons in the pane header ⋯ menu that TYPE the command at the agent’s prompt without running it, e.g. Tests = npm test'}
      >
        <TextArea rows={3} value={actionText} onChange={(e) => setActionText(e.target.value)} />
      </Field>
      <DialogActions>
        <Button variant="danger" disabled={inUse > 0} title={inUse > 0 ? `used by ${inUse} agent(s)` : 'Remove this project'} onClick={() => void remove()}>Remove project</Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!nameOk || !branchOk || actionProblem !== null} onClick={() => void save()}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
