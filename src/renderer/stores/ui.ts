import { create } from 'zustand';
import type { ToastEvent } from '../../../shared/ipc-contract.ts';
import type { TicketDraft } from '../../../shared/linear-draft.ts';
import { emptyTicketFields, type TicketFields } from '../../../shared/linear-issues.ts';
import type { Id } from '../../../shared/types.ts';

export type DialogState =
  // `draft` (Plan 06): a Linear ticket read into a filled-in form. Absent, the dialog is unchanged.
  | { kind: 'new-agent'; folderId: Id | null; draft?: TicketDraft }
  | { kind: 'new-folder'; parentId: Id | null }
  | { kind: 'project-settings'; projectId: Id }
  | { kind: 'delete-agent'; agentId: Id }
  | { kind: 'add-workspace'; agentId: Id }
  | { kind: 'remove-workspace'; agentId: Id; workspaceId: Id }
  | { kind: 'host-panel' }
  // Not a `<dialog>` like the five above — it renders a plain overlay (see QuickSwitcher.tsx) —
  // but it IS a modal for every purpose this store serves: `installKeymap` stands the whole
  // shortcut table down while `dialog !== null`, keeping back only ⌘K itself, which toggles this
  // shut (`OPENS_DIALOG` in keymap.ts). Both halves are exactly right for a palette.
  | { kind: 'quick-switcher' }
  // Plan 06. A `<dialog>`, so the stand-down applies; ⌘⇧L toggles it through `OPENS_DIALOG`.
  | { kind: 'linear' }
  | null;
// The keyboard cheatsheet USED TO BE a member of this union — a `<dialog>` opened with
// `showModal()`, mounted from `DialogHost`. It is not one any more; it is `shortcutsOpen` below.
// See `ShortcutsPanel.tsx` for why, and `keymap.ts` for what that means for the stand-down.

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  children?: MenuItem[];
}

export interface Toast extends ToastEvent {
  id: number;
}

export interface Banner {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  action?: { label: string; onClick: () => void };
}

interface UiState {
  dialog: DialogState;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  /**
   * Is the ⌘/ cheatsheet showing?
   *
   * **Not in `dialog`, and that is the whole point of the change.** `installKeymap` stands the
   * entire shortcut table down while `dialog !== null` — a deliberate ruling that still holds for
   * real modals — so while the cheatsheet was a `DialogState` member, every shortcut it documents
   * was inert on the screen documenting it. You could not try a shortcut while reading about it.
   * A separate flag keeps the stand-down exactly as strict as it was for modals and leaves the
   * keyboard live behind this panel.
   *
   * **Not in `Layout` either**, unlike the panel's position and size: geometry survives a restart,
   * openness does not. A reference sheet that reopens itself over your terminals every launch is
   * the drawer's behaviour applied to something that is not the drawer.
   */
  shortcutsOpen: boolean;
  /** ⌘/ and the toolbar button. A toggle, like `toggle-sidebar` and `toggle-drawer` — this panel
   *  is window chrome now, not a dialog, so it toggles in `applyKeymapAction` like the others. */
  toggleShortcuts: () => void;
  closeShortcuts: () => void;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  showContextMenu: (x: number, y: number, items: MenuItem[]) => void;
  hideContextMenu: () => void;
  toasts: Toast[];
  toast: (t: ToastEvent) => void;
  dismissToast: (id: number) => void;
  banners: Banner[];
  // Split from the original `setBanner(b: Banner | null, id?: string)`, where `id` was optional and
  // so `setBanner(null)` typechecked, read as "clear the banner" and cleared nothing: `key` came out
  // `undefined` and the filter kept every banner. It only worked because the single caller passed
  // `'host'` explicitly. Two functions, each with a required argument, make that unspellable.
  setBanner: (b: Banner) => void;
  clearBanner: (id: string) => void;
  search: string;
  setSearch: (s: string) => void;
  renamingId: Id | null;
  setRenaming: (id: Id | null) => void;
  /**
   * The agent whose sidebar row the pointer is over, or null. Spec §3: sweeping the list brightens
   * the matching pane's rail, so the panes answer the row you are about to click.
   *
   * **An ID, and that is load-bearing.** Everything that reads this compares it to an id it already
   * has (`s.hoveredAgentId === agentId`), so every selector returns a primitive and zustand 5's
   * `Object.is` settles it. A `{ hoveredAgentId }`, a `hoveredAgents: Id[]` or a
   * `hoveredAgentId ?? ''`-flavoured fallback would each allocate inside the selector, which is
   * G59/G61's infinite render loop and not merely a wasted object — and this is the worst field in
   * the store to make that mistake on, because it changes on every pointer move between rows.
   * `Sidebar.test.tsx` holds both halves: a hover must commit NOTHING in the sidebar, and the
   * control beside it proves an allocating selector on this very field still hangs React.
   *
   * Not in `Layout` and not persisted: where the pointer is does not survive a restart.
   */
  hoveredAgentId: Id | null;
  setHoveredAgent: (id: Id | null) => void;
  searchFocusRequest: number;
  requestSearchFocus: () => void;
  /**
   * The Linear ticket being typed in ⌘⇧L's create form, or null when there is none.
   *
   * It lives out here, and not in `LinearDialog`, because of the one failure that asks the owner to
   * leave: a create that timed out (`LINEAR_CREATE_UNCONFIRMED`) tells them to go and check Linear,
   * and Escape is one key away. Closing the dialog would otherwise throw away the ticket they were
   * told to keep. Not in `DialogState` either — that is cleared on close, which is exactly the
   * moment this has to survive — and deliberately not persisted: it is an app-run scratchpad, not a
   * draft store.
   */
  linearTicket: TicketFields | null;
  /** An UPDATER, so a draft answer merges into what the form holds now rather than a stale copy. */
  updateLinearTicket: (update: (current: TicketFields) => TicketFields) => void;
  clearLinearTicket: () => void;
}

let nextToast = 1;

export const useUi = create<UiState>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  shortcutsOpen: false,
  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  contextMenu: null,
  showContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  hideContextMenu: () => set({ contextMenu: null }),
  toasts: [],
  toast: (t) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    if (!t.sticky) setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 6_000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  banners: [],
  setBanner: (b) => set((s) => ({ banners: [...s.banners.filter((x) => x.id !== b.id), b] })),
  clearBanner: (id) => set((s) => ({ banners: s.banners.filter((x) => x.id !== id) })),
  search: '',
  setSearch: (search) => set({ search }),
  renamingId: null,
  setRenaming: (renamingId) => set({ renamingId }),
  hoveredAgentId: null,
  setHoveredAgent: (hoveredAgentId) => set({ hoveredAgentId }),
  searchFocusRequest: 0,
  requestSearchFocus: () => set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
  linearTicket: null,
  updateLinearTicket: (update) => set((s) => ({ linearTicket: update(s.linearTicket ?? emptyTicketFields()) })),
  clearLinearTicket: () => set({ linearTicket: null }),
}));
