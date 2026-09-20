// The actions a sidebar row, a pane header and the command palette all need, in one place so the
// three cannot drift. Nothing here holds state: every function reads the stores through
// `getState()` and is safe to call from an event handler.
import type { StartMode } from '../../../shared/ipc-contract.ts';
import { primaryWorkspace, type Agent, type Id, type Project, type SessionState, type WorkspaceSnapshot } from '../../../shared/types.ts';
import { layoutStore } from '../stores/layout.ts';
import { useUi, type MenuItem } from '../stores/ui.ts';
import { useWorkspace } from '../stores/workspace.ts';
import { run } from './api.ts';

export function openAgent(agentId: Id, inNewPane: boolean): void {
  const layout = layoutStore.getState();
  if (inNewPane) {
    // `openInNewPane` returns false when all four panes are taken (§12.3). Silently doing nothing
    // reads as a broken click, so say why.
    if (!layout.openInNewPane(agentId)) {
      useUi.getState().toast({ level: 'warn', title: 'All four panes are in use', detail: 'Close a pane (⌘⇧W) or click the agent to open it in the focused pane.' });
      return;
    }
  } else {
    layout.openInFocused(agentId);
  }
  void run('agent:markOpened', { id: agentId });
}

/**
 * Where a just-created agent lands. Spec §12.6: "the agent opens in the focused pane (or a new
 * pane if the focused one is occupied and < 4 panes)".
 *
 * Not `openAgent(id, true)`: that toasts "All four panes are in use" when the grid is full, which
 * is wrong here — at four panes the spec's own fallback is the focused pane, and the toast would
 * arrive alongside the "Created …" one for an agent that did open.
 */
export function openAgentAfterCreate(agentId: Id): void {
  const layout = layoutStore.getState();
  const { panes, focusedIndex } = layout.layout;
  const focusedOccupied = (panes[focusedIndex] ?? null) !== null;
  if (focusedOccupied && layout.openInNewPane(agentId)) {
    void run('agent:markOpened', { id: agentId });
    return;
  }
  openAgent(agentId, false);
}

/**
 * Spec §12.6's default folder for a New Agent dialog raised WITHOUT a folder in mind (⌘N, the
 * sidebar background menu): "the folder of the currently focused agent, or Root". A folder's own
 * "New agent here" passes its id explicitly and does not come through here.
 */
export function openNewAgentDialog(): void {
  const { panes, focusedIndex } = layoutStore.getState().layout;
  const focused = panes[focusedIndex] ?? null;
  const agents = useWorkspace.getState().snapshot?.workspace.agents ?? [];
  const folderId = focused === null ? null : (agents.find((a) => a.id === focused)?.folderId ?? null);
  useUi.getState().openDialog({ kind: 'new-agent', folderId });
}

export const startAgent = (id: Id, mode: StartMode) => run('agent:start', { id, mode });
export const stopAgent = (id: Id) => run('agent:stop', { id });
export const openExternal = (agentId: Id, workspaceId: Id, target: 'vscode' | 'finder' | 'terminal') => run('app:openExternal', { agentId, workspaceId, target });
export const copyText = (text: string) => run('app:copyToClipboard', { text });

/** "Running" for menu purposes: there is a PTY. `stopped` and `exited` are the two states without one (§6.5). */
export function isRunning(state: SessionState): boolean {
  return state.activity !== 'stopped' && state.activity !== 'exited';
}

/**
 * One entry per NON-primary workspace, labelled by project name. Two entries can only read the same
 * when both projects have been removed from Hangar — project names are unique and an agent cannot hold
 * one project twice — and both then read "missing project".
 *
 * NOT the branch to tell those apart: every workspace of an agent is on the agent's own branch
 * (`agent/<slug>`), so it is the same for both. The worktree's location is not —
 * `<worktreesDir>/<project name when added>/<slug>` (`paths.ts` → `worktreePath`) — so its last two
 * segments name the project each one was made for.
 */
function removableWorkspaceItems(agent: Agent, projects: readonly Project[]): MenuItem[] {
  const ui = useUi.getState();
  const rest = agent.workspaces.slice(1);
  const names = rest.map((w) => projects.find((p) => p.id === w.projectId)?.name ?? 'missing project');
  return rest.map((w, i) => {
    const name = names[i]!;
    const shared = names.filter((n) => n === name).length > 1;
    return { label: shared ? `${name} (${worktreeTail(w.worktreePath)})` : name, onSelect: () => ui.openDialog({ kind: 'remove-workspace', agentId: agent.id, workspaceId: w.id }) };
  });
}

/** `/h/worktrees/acmeapi/pair` → `acmeapi/pair`. Split by hand: the renderer cannot import `node:path`. */
function worktreeTail(path: string): string {
  return path.split('/').filter((s) => s !== '').slice(-2).join('/');
}

export function agentMenuItems(agent: Agent, state: SessionState, snapshot: WorkspaceSnapshot): MenuItem[] {
  const ui = useUi.getState();
  const running = isRunning(state);
  // `primaryWorkspace`, not `agent.workspaces[0]!`: the non-null assertion turns the §6 invariant
  // into a `Cannot read properties of undefined` inside a contextmenu handler, where React 19
  // reports it as an unhandled error with no hint of which agent. The helper names the agent.
  const primary = primaryWorkspace(agent);
  const folders = snapshot.workspace.folders;
  const moveTargets: MenuItem[] = [
    { label: 'Root', disabled: agent.folderId === null, onSelect: () => void run('agent:move', { id: agent.id, folderId: null, beforeId: null }) },
    ...folders.map((f) => ({ label: f.name, disabled: agent.folderId === f.id, onSelect: () => void run('agent:move', { id: agent.id, folderId: f.id, beforeId: null }) })),
  ];
  return [
    { label: 'Open in new pane', onSelect: () => openAgent(agent.id, true) },
    { label: 'Rename', onSelect: () => ui.setRenaming(agent.id) },
    { label: 'Move to', children: moveTargets },
    // NOT "Add project…": that exact label is the sidebar BACKGROUND menu's, where it registers a
    // new git repository with Hangar, and `PaneGrid.test.tsx` uses it as the marker that an
    // ancestor has not stolen this menu. Two menus, two different operations, two labels.
    { label: 'Add project to this agent…', onSelect: () => ui.openDialog({ kind: 'add-workspace', agentId: agent.id }) },
    {
      label: 'Remove project from this agent',
      // Spec 2026-09-15 §11.1. The primary is never listed — it is the terminal's cwd, and main refuses
      // it with PRIMARY_WORKSPACE — so a one-project agent has nothing to offer, and a submenu with no
      // children is an unopenable dead entry (the rule `rootMenuItems`' "Project settings" follows).
      disabled: agent.workspaces.length <= 1,
      children: removableWorkspaceItems(agent, snapshot.workspace.projects),
    },
    { separator: true, label: '' },
    {
      label: 'Restart',
      disabled: running,
      children: [
        { label: 'Resume conversation', onSelect: () => void startAgent(agent.id, 'resume') },
        { label: 'Start fresh', onSelect: () => void startAgent(agent.id, 'fresh') },
        { label: 'Shell only', onSelect: () => void startAgent(agent.id, 'shell-only') },
      ],
    },
    { label: 'Stop', disabled: !running, onSelect: () => void stopAgent(agent.id) },
    { separator: true, label: '' },
    { label: 'Open in VS Code', onSelect: () => void openExternal(agent.id, primary.id, 'vscode') },
    { label: 'Reveal in Finder', onSelect: () => void openExternal(agent.id, primary.id, 'finder') },
    { label: 'Open in Terminal', onSelect: () => void openExternal(agent.id, primary.id, 'terminal') },
    { label: 'Copy worktree path', onSelect: () => void copyText(primary.worktreePath) },
    { separator: true, label: '' },
    { label: 'Delete…', danger: true, onSelect: () => ui.openDialog({ kind: 'delete-agent', agentId: agent.id }) },
  ];
}

export function folderMenuItems(folderId: Id): MenuItem[] {
  const ui = useUi.getState();
  return [
    { label: 'New agent here', onSelect: () => ui.openDialog({ kind: 'new-agent', folderId }) },
    { label: 'New folder here', onSelect: () => ui.openDialog({ kind: 'new-folder', parentId: folderId }) },
    { label: 'Rename', onSelect: () => ui.setRenaming(folderId) },
    { separator: true, label: '' },
    { label: 'Delete folder (children move up)', danger: true, onSelect: () => void run('folder:delete', { id: folderId }) },
  ];
}

/** Read at menu-BUILD time, so the submenu lists the projects that exist when the menu is opened. */
const snapshotProjects = (): Project[] => useWorkspace.getState().snapshot?.workspace.projects ?? [];

export function rootMenuItems(): MenuItem[] {
  const ui = useUi.getState();
  const projects = snapshotProjects();
  return [
    { label: 'New agent', onSelect: () => openNewAgentDialog() },
    { label: 'New folder', onSelect: () => ui.openDialog({ kind: 'new-folder', parentId: null }) },
    { label: 'Add project…', onSelect: () => void addProjectFlow() },
    {
      label: 'Project settings',
      // A submenu with no children renders as an unopenable dead entry, so it is disabled until
      // there is a project to settle.
      disabled: projects.length === 0,
      children: projects.map((p) => ({ label: p.name, onSelect: () => ui.openDialog({ kind: 'project-settings', projectId: p.id }) })),
    },
  ];
}

export async function addProjectFlow(): Promise<void> {
  // `run`, not `runResult`, even though `app:pickFolder` is the one request whose own result type
  // includes null (api.ts says the flattening is lossy there): "the user cancelled" and "the call
  // failed" both mean do nothing here, and a failure has already produced a toast via the error
  // sink by the time this returns.
  const path = await run('app:pickFolder');
  if (!path) return;
  const project = await run('project:add', { repoPath: path });
  if (project) useUi.getState().toast({ level: 'info', title: `Added project ${project.name}`, detail: `default branch: ${project.defaultBranch}` });
}
