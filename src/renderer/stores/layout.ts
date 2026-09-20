import { createStore, useStore } from 'zustand';
import { api } from '../lib/api.ts';
import {
  addEmptyPane, closePane, focusPane, normalizeLayout, openInFocused, openInNewPane, paneOf, removeAgent, setArrangement, swapPanes,
} from '../../../shared/layout.ts';
import { defaultLayout, type Arrangement, type Id, type Layout, type PanelRect } from '../../../shared/types.ts';

export interface LayoutState {
  layout: Layout;
  hydrated: boolean;
  hydrate: (layout: Layout) => void;
  openInFocused: (agentId: Id) => void;
  openInNewPane: (agentId: Id) => boolean;
  addEmptyPane: () => boolean;
  closePane: (index: number) => void;
  focusPane: (index: number) => void;
  swapPanes: (i: number, j: number) => void;
  setArrangement: (a: Arrangement) => void;
  removeAgent: (agentId: Id) => void;
  setSidebar: (patch: { width?: number; visible?: boolean }) => void;
  setDrawer: (patch: { width?: number; open?: boolean; tab?: Layout['drawerTab'] }) => void;
  /**
   * The cheatsheet panel's remembered geometry. The caller passes a rect it has ALREADY clamped
   * (`clampPanelRect`), because `apply` pushes straight to `layout:set` and `LayoutInputSchema` is
   * strict about the bounds — an unclamped rect would be a rejected request and a lost position,
   * not a silently repaired one. Called on every mousemove of a drag; the store's own 100 ms
   * debounce is what makes that one write rather than one per frame, exactly as the sidebar and
   * drawer resizes already rely on.
   */
  setShortcutsPanel: (rect: PanelRect) => void;
  paneOf: (agentId: Id) => number | null;
}

/** `push` receives every new layout (debounced 100 ms) — the app wires it to `layout:set`. */
export function createLayoutStore(push: (layout: Layout) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return createStore<LayoutState>((set, get) => {
    const apply = (next: Layout | null): boolean => {
      if (next === null) return false;
      set({ layout: next });
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        push(get().layout);
      }, 100);
      return true;
    };
    return {
      layout: defaultLayout(),
      hydrated: false,
      hydrate: (layout) => set({ layout: normalizeLayout(layout), hydrated: true }),
      openInFocused: (id) => void apply(openInFocused(get().layout, id)),
      openInNewPane: (id) => apply(openInNewPane(get().layout, id)),
      addEmptyPane: () => apply(addEmptyPane(get().layout)),
      closePane: (i) => void apply(closePane(get().layout, i)),
      focusPane: (i) => void apply(focusPane(get().layout, i)),
      swapPanes: (i, j) => void apply(swapPanes(get().layout, i, j)),
      setArrangement: (a) => void apply(setArrangement(get().layout, a)),
      removeAgent: (id) => void apply(removeAgent(get().layout, id)),
      setSidebar: (p) => void apply({ ...get().layout, sidebarWidth: p.width ?? get().layout.sidebarWidth, sidebarVisible: p.visible ?? get().layout.sidebarVisible }),
      setDrawer: (p) => void apply({ ...get().layout, drawerWidth: p.width ?? get().layout.drawerWidth, drawerOpen: p.open ?? get().layout.drawerOpen, drawerTab: p.tab ?? get().layout.drawerTab }),
      setShortcutsPanel: (rect) => void apply({ ...get().layout, shortcutsPanel: rect }),
      paneOf: (id) => paneOf(get().layout, id),
    };
  });
}

export const layoutStore = createLayoutStore((layout) => {
  // The WRAPPED `api`, never `window.hangar`: the raw bridge resolves a Result envelope and never
  // rejects (Plan 02 deviation P2-18b), so a `.catch` on it is dead code and every failed
  // `layout:set` — a disconnected host, a rejected payload — disappears without a line in the log.
  void api.invoke('layout:set', layout).catch((e: unknown) => console.error('layout:set failed', e));
});

export const useLayout = <T>(selector: (s: LayoutState) => T): T => useStore(layoutStore, selector);
