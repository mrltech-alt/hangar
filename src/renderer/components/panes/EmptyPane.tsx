import type { KeymapAction } from '../../lib/keymap.ts';
import { useLayout } from '../../stores/layout.ts';
import { useUi } from '../../stores/ui.ts';
import { Button } from '../ui/Button.tsx';
import { ShortcutKbd } from '../ui/Kbd.tsx';

// Module scope, so the props below are stable references. Not a G59 hazard — nothing here reaches
// a zustand selector — but there is no reason to allocate three objects per render either.
const QUICK_SWITCHER: KeymapAction = { kind: 'quick-switcher' };
const NEW_AGENT: KeymapAction = { kind: 'new-agent' };
const CLOSE_PANE: KeymapAction = { kind: 'close-pane' };

/** A pane with `agentId === null` — a first-class state (§12.3), not an error. */
export function EmptyPane({ index }: { index: number }) {
  // Every selector here returns either a zustand action (defined once in the store initializer, so
  // its identity survives every `set`) or a number. Nothing allocates, so nothing loops (G59).
  const openDialog = useUi((s) => s.openDialog);
  const closePane = useLayout((s) => s.closePane);
  const count = useLayout((s) => s.layout.panes.length);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-2">
      <div className="text-[13px]">Choose an agent for pane {index + 1}</div>
      <div className="flex gap-2">
        {/* §12.3: "centred 'Choose an agent' with the quick switcher button". Until Plan 05 this
            raised `requestSearchFocus` instead, because ⌘K was Phase 1's stopgap binding for the
            sidebar search — and it did nothing at all when the sidebar was hidden (⌘B), which is
            precisely when an empty pane most needs a way to pick an agent. */}
        <Button onClick={() => openDialog({ kind: 'quick-switcher' })}>Jump to agent <ShortcutKbd action={QUICK_SWITCHER} /></Button>
        <Button variant="primary" onClick={() => openDialog({ kind: 'new-agent', folderId: null })}>New agent <ShortcutKbd action={NEW_AGENT} /></Button>
      </div>
      {/* `closePane` blanks a lone pane rather than removing it (shared/layout.ts), so offering the
          button at count 1 would be a control that visibly does nothing on the only pane that is
          already blank. */}
      {count > 1 ? <Button variant="ghost" onClick={() => closePane(index)}>Close pane <ShortcutKbd action={CLOSE_PANE} /></Button> : null}
    </div>
  );
}
