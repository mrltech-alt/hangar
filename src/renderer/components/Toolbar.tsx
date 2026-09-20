import { Keyboard, Ticket } from 'lucide-react';
import { withShortcut, type KeymapAction } from '../lib/keymap.ts';
import { useUi } from '../stores/ui.ts';
import { IconButton } from './ui/Button.tsx';

/**
 * The bar above the pane grid. It existed before this file — as an empty `drag-region h-10` div in
 * `App.tsx`, there purely to give the window something to drag by — and it is where the cheatsheet
 * button belongs: the one piece of chrome that is not scoped to a pane, an agent or a drawer tab.
 *
 * **Traffic lights.** With the sidebar hidden (⌘B) the macOS buttons float over this bar's first
 * ~78px, which is why the original comment said an empty bar was fine. The content here is
 * `justify-end`, so it never shares that space; do not left-align anything into it.
 *
 * `drag-region` makes the bar a window drag handle, and `IconButton` carries `no-drag` in its own
 * base class, so the button stays clickable without this file saying anything about it.
 */
const SHOW_SHORTCUTS: KeymapAction = { kind: 'shortcuts' };
const NEW_AGENT_LINEAR: KeymapAction = { kind: 'new-agent-linear' };

export function Toolbar() {
  // Zustand actions — one identity each for the life of the store — so neither selector can loop
  // React (G59). Nothing else is read: this component must not re-render when a snapshot arrives, and
  // deliberately NOT `shortcutsOpen`, which would re-render the toolbar on every ⌘/.
  const toggleShortcuts = useUi((s) => s.toggleShortcuts);
  const openDialog = useUi((s) => s.openDialog);
  return (
    <div className="drag-region flex h-10 shrink-0 items-center justify-end gap-1 border-b border-line bg-bg-1 px-2">
      {/* Plan 06. The same dialog ⌘⇧L opens; the key in the tooltip comes from `SHORTCUTS`. */}
      <IconButton title={withShortcut('New agent from Linear ticket', NEW_AGENT_LINEAR)} onClick={() => openDialog({ kind: 'linear' })}>
        <Ticket size={14} />
      </IconButton>
      {/* The key comes from `SHORTCUTS` via `withShortcut`, never typed here: this tooltip is the
          smallest possible version of the bug the cheatsheet exists to prevent. */}
      {/* A toggle, the same one ⌘/ runs — the panel is chrome you leave open, not a dialog you
          raise, so the button that shows it is the button that hides it. */}
      <IconButton title={withShortcut('Keyboard shortcuts', SHOW_SHORTCUTS)} onClick={toggleShortcuts}>
        <Keyboard size={14} />
      </IconButton>
    </div>
  );
}
