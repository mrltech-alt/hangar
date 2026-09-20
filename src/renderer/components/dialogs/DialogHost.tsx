import { useUi } from '../../stores/ui.ts';
import { HostPanel } from '../HostPanel.tsx';
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx';
import { DeleteAgentDialog } from './DeleteAgentDialog.tsx';
import { LinearDialog } from './LinearDialog.tsx';
import { NewAgentDialog } from './NewAgentDialog.tsx';
import { NewFolderDialog } from './NewFolderDialog.tsx';
import { ProjectSettingsDialog } from './ProjectSettingsDialog.tsx';
import { QuickSwitcher } from './QuickSwitcher.tsx';
import { RemoveWorkspaceDialog } from './RemoveWorkspaceDialog.tsx';

/**
 * The renderer for `ui.dialog`. Until this existed, every menu entry and shortcut that opened a
 * dialog set the store and nothing appeared — `New agent`, `New folder` and `Delete…` were all
 * live in the menus and all silently did nothing.
 *
 * `dialog.kind` is switched exhaustively with no `default`, so a new `DialogState` member fails to
 * compile here rather than rendering nothing at run time. Each case mounts a DIFFERENT component
 * type, so switching dialogs remounts and no per-dialog state survives into the next one.
 *
 * The ⌘/ cheatsheet used to be the eighth case here. It is not a dialog any more — it is a
 * non-modal floating panel mounted from `App` off `ui.shortcutsOpen`, so that `installKeymap`'s
 * "a modal owns the keyboard" stand-down does not deaden the very shortcuts it lists. See
 * `components/ShortcutsPanel.tsx`.
 */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  if (dialog === null) return null;
  switch (dialog.kind) {
    case 'new-agent':
      return <NewAgentDialog folderId={dialog.folderId} draft={dialog.draft} />;
    case 'new-folder':
      return <NewFolderDialog parentId={dialog.parentId} />;
    case 'project-settings':
      return <ProjectSettingsDialog projectId={dialog.projectId} />;
    case 'delete-agent':
      return <DeleteAgentDialog agentId={dialog.agentId} />;
    case 'add-workspace':
      return <AddWorkspaceDialog agentId={dialog.agentId} />;
    case 'remove-workspace':
      return <RemoveWorkspaceDialog agentId={dialog.agentId} workspaceId={dialog.workspaceId} />;
    case 'host-panel':
      return <HostPanel />;
    // The one member that is not a `<dialog>`. It still belongs here: it is a mode of the window,
    // the exhaustive switch is what guarantees it is reachable, and mounting it from `ui.dialog`
    // is what makes `installKeymap`'s stand-down — and its ⌘K toggle — apply to it.
    case 'quick-switcher':
      return <QuickSwitcher />;
    case 'linear':
      return <LinearDialog />;
  }
}
