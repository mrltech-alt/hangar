import { useEffect } from 'react';
import { Banners } from './components/Banners.tsx';
import { Drawer } from './components/drawer/Drawer.tsx';
import { DialogHost } from './components/dialogs/DialogHost.tsx';
import { PaneGrid } from './components/panes/PaneGrid.tsx';
import { ShortcutsPanel } from './components/ShortcutsPanel.tsx';
import { Sidebar } from './components/sidebar/Sidebar.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Toolbar } from './components/Toolbar.tsx';
import { ContextMenuHost } from './components/ui/Menu.tsx';
import { ToastHost } from './components/ui/ToastHost.tsx';
import { bootstrap } from './lib/bootstrap.ts';
import { installKeymap } from './lib/keymap.ts';
import { useLayout } from './stores/layout.ts';

export function App() {
  // Task 1's inline subscribe/fetch moved into `bootstrap()` in Task 2, which owns the ordering
  // rules that mattered there (subscribe before fetch; a slow reply must not clobber a newer pushed
  // snapshot) plus the ones the stores added. It returns its own unsubscribe, so this is the whole
  // wiring. Every part of the window is real from here.
  //
  // Task 9 took the workspace subscription OUT of this component along with the inline status bar
  // it fed: `App` now re-renders only when the sidebar is toggled, and `StatusBar` — the one piece
  // of chrome that reads the snapshot — re-renders alone. Measured with the commit counter in
  // `status.test.tsx`: a snapshot arriving used to commit the whole App subtree.
  const sidebarVisible = useLayout((s) => s.layout.sidebarVisible);
  // Both teardowns run, and the keymap's is not optional: `installKeymap` adds a CAPTURE listener
  // to `window`, which outlives this component. Leaking one across a StrictMode double-mount would
  // fire every shortcut twice — ⌘⇧D would add two panes.
  useEffect(() => {
    const offBootstrap = bootstrap();
    const offKeys = installKeymap();
    return () => {
      offBootstrap();
      offKeys();
    };
  }, []);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {sidebarVisible ? <Sidebar /> : null}
        <main className="flex min-w-0 flex-1 flex-col bg-bg-0">
          {/* When the sidebar is hidden the traffic lights overlap this drag bar's left end; the
              toolbar's content is right-aligned, so nothing is ever underneath them. */}
          <Toolbar />
          {/* §12.7 puts banners at the top of the PANE GRID, not of the window: they belong to the
              work area, and the sidebar and drawer keep their full height beside them. */}
          <Banners />
          <PaneGrid />
        </main>
        <Drawer />
      </div>
      <StatusBar />
      <ContextMenuHost />
      <DialogHost />
      {/* A sibling of the whole layout, never a descendant of `main` or of a pane: it is
          `position: fixed` and draggable, and `Pane`'s `onMouseDownCapture` must not see the drag
          (G60). Above `DialogHost` in z-order it is not — a real modal covers it — which is
          deliberate: this panel is not modal and does not claim the top layer. */}
      <ShortcutsPanel />
      <ToastHost />
    </div>
  );
}
