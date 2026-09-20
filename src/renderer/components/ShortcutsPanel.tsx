import { X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { clampPanelRect, defaultShortcutsRect, movePanelRect, resizePanelRect, type Viewport } from '../../../shared/layout.ts';
import type { PanelRect } from '../../../shared/types.ts';
import { OWNED_BY_CODE_EDITOR, SHORTCUTS, WORKS_IN_TEXT_FIELD, chordLabel, type Shortcut, type ShortcutSection } from '../lib/keymap.ts';
import { useLayout } from '../stores/layout.ts';
import { useUi } from '../stores/ui.ts';
import { IconButton } from './ui/Button.tsx';
import { Kbd } from './ui/Kbd.tsx';

/**
 * The cheatsheet's rows, grouped for display.
 *
 * **Exhaustive by construction, at three levels.** `SHORTCUTS` is a `Record` over
 * `KeymapAction['kind']`, so a twelfth action fails `tsc` in `keymap.ts` until it is given a key,
 * a description and a section (measured: adding `| { kind: 'fake' }` to the union produces
 * `TS2741: Property 'fake' is missing` on `SHORTCUTS`, `WORKS_IN_TEXT_FIELD`, `OWNED_BY_CODE_EDITOR`
 * and `OPENS_DIALOG` — four errors, no test run needed). Its value type is a NON-EMPTY tuple, so the
 * obvious way round that — `fake: []` — is also a type error rather than a silent omission. And this
 * function flattens the whole record with no filter of any kind, so there is no third place a row
 * could be dropped. A cheatsheet that quietly omits a shortcut teaches the wrong thing, which is
 * worse than having none. **None of that changed when the panel stopped being a dialog** — it is a
 * property of the table and of this function, not of how the rows are presented.
 *
 * Grouping is positional on purpose: a new heading starts whenever `section` changes, so a section
 * split across two runs of the table renders its heading twice instead of silently reordering the
 * user's mental model. The test asserts the headings are unique, which is what makes the table's
 * ordering a checked property rather than a convention.
 */
export function cheatsheetSections(): { title: ShortcutSection; rows: Shortcut[] }[] {
  const out: { title: ShortcutSection; rows: Shortcut[] }[] = [];
  for (const s of Object.values(SHORTCUTS).flat()) {
    const last = out[out.length - 1];
    if (last !== undefined && last.title === s.section) last.rows.push(s);
    else out.push({ title: s.section, rows: [s] });
  }
  return out;
}

/** The window, read at the moment it is asked for. Not reactive on its own — see `ShortcutsPanel`. */
function viewportNow(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Spec §12.3's table, rendered from the table the keymap actually matches on (⌘/, or the toolbar's
 * keyboard button) — as a **floating panel you can drag, resize and leave open**.
 *
 * **It stopped being a modal, and that reverses part of X5-1/X5-2.** It used to be a `<dialog>`
 * opened with `showModal()`, mounted from `DialogHost` off a `ui.dialog` member. That was right for
 * a modal and wrong for this, and it had a self-defeating consequence: `installKeymap` returns
 * early while `ui.dialog !== null`, so **every shortcut this panel documents was inert while it was
 * open**. You could not try a shortcut while reading about it, which is most of the point of a
 * cheatsheet. It is now `ui.shortcutsOpen`, `ui.dialog` stays null, and the whole keymap stays live
 * behind it.
 *
 * **What that did NOT relax.** The stand-down itself is untouched: a real modal still owns the
 * keyboard, so ⌘N inside New Agent still cannot stack a second dialog, ⌘⇧W still cannot close a
 * pane behind it and ⌘⇧D still cannot add one. This panel simply is not one of those any more.
 * ⌘/ still toggles — the toggle moved from `OPENS_DIALOG` (which only existed to punch a hole in
 * the stand-down) into `applyKeymapAction`, beside `toggle-sidebar` and `toggle-drawer`, which is
 * where a piece of non-modal window chrome has always kept its toggle.
 *
 * **G62 does not apply any more.** That gotcha is specifically about `showModal()`: React's
 * `autoFocus` is a no-op on a `display:none` dialog, and `showModal()`'s own focusing steps then
 * park focus on the first focusable descendant — the header Close button, which Space activates.
 * There is no `showModal()` here, so there are no focusing steps and nothing is focused at mount at
 * all: **the panel deliberately takes no focus**, leaving the keyboard wherever it was, which is
 * what makes "try the shortcut while you read it" true rather than a slogan. The Space-closes-it
 * failure is structurally unreachable rather than defended against — the same shape as
 * `QuickSwitcher`, which avoids G62 by not being a `<dialog>` either (it then focuses its input
 * explicitly, because a palette is useless without the caret in it; this panel wants the opposite).
 * The scroll container keeps `tabIndex={-1}` for a different reason than before: so a click can
 * focus it and arrow keys scroll the list. Whether Chromium really focuses a `tabindex="-1"` div on
 * click is a CDP question (G66) — jsdom has no focusability rule at all.
 *
 * **Geometry.** Default: the sidebar's width, at the sidebar's left edge, top edge at 50% of the
 * window height — the owner's words read literally, so the panel opens as the lower half of the
 * sidebar. It is derived, not stored, so it keeps following the sidebar until the first drag;
 * `Layout.shortcutsPanel` is `null` until then. Everything about where it may sit is a pure
 * function in `shared/layout.ts` (`defaultShortcutsRect`, `clampPanelRect`, `movePanelRect`,
 * `resizePanelRect`) and is tested there directly, because jsdom has no layout engine and every
 * element's geometry is zero (G66) — what the DOM tests here can prove is that the store and the
 * inline `style` carry the numbers those functions returned.
 *
 * **Off-screen is the classic failure of a draggable panel**, and it is clamped in the one place
 * that can see the window: `clampPanelRect` is applied to what is DRAWN, not only to what is
 * stored, so a rect saved on a larger display is corrected on the first render rather than on the
 * first drag. A `resize` listener writes the correction back while the panel is open. Because the
 * clamp keeps the panel wholly inside the viewport, the title bar is always on screen and the panel
 * can always be dragged back — which matters because dragging is the only way to move it.
 *
 * **G60.** No ancestor steals these events. The panel is mounted from `App` as a sibling of the
 * pane grid, not inside it, so `Pane`'s `onMouseDownCapture` (which focuses a pane on any mousedown
 * within it) never sees the drag: it is a React ancestor test, and this is not a descendant of any
 * pane however the boxes overlap on screen. `App`'s root div and `main` carry no mouse handlers at
 * all. So no `stopPropagation()` guard is added here — Plan 03 Tasks 7-9 and Plan 04 Task 4 reached
 * the same conclusion for the drawer and the Files tab, and an unnecessary guard is worse than
 * none. `ShortcutsPanel.test.tsx` pins the PLACEMENT so that stays true.
 *
 * **G59/G61.** Two selectors return zustand ACTIONS (one identity for the life of the store), one
 * returns a boolean, one a number, and one the STORED rect object — never a fresh `{x,y,w,h}`
 * literal, which is exactly the shape that renders forever. Every derivation, the clamp included,
 * happens below the subscriptions.
 */
export function ShortcutsPanel() {
  const open = useUi((s) => s.shortcutsOpen);
  const close = useUi((s) => s.closeShortcuts);
  // The STORED reference or `null` — both stable. `?? defaultShortcutsRect(…)` would allocate on
  // the null path only, which is G61's exact latent shape, so the fallback is applied below the
  // subscription rather than inside the selector.
  const stored = useLayout((s) => s.layout.shortcutsPanel);
  const sidebarWidth = useLayout((s) => s.layout.sidebarWidth);
  const setRect = useLayout((s) => s.setShortcutsPanel);
  const [viewport, setViewport] = useState<Viewport>(viewportNow);
  const rect = clampPanelRect(stored ?? defaultShortcutsRect(viewport, sidebarWidth), viewport);
  // The one place the Resizer's ref trick is still needed: the `resize` listener below is installed
  // once per open and would otherwise close over the first render's values. The DRAG handlers do
  // not need it — they capture their base rect at mousedown and work in TOTAL deltas from it, which
  // removes the staleness rather than tracking around it (see `movePanelRect`).
  const latest = useRef({ stored, setRect });
  latest.current = { stored, setRect };
  useEffect(() => {
    if (!open) return undefined;
    const onResize = (): void => {
      const next = viewportNow();
      setViewport(next);
      // Persist the correction, but only when the window actually pushed the panel: a resize that
      // leaves a legal rect legal must not write, or every window drag would queue a `layout:set`.
      const saved = latest.current.stored;
      if (saved === null) return;
      const clamped = clampPanelRect(saved, next);
      if (clamped.x !== saved.x || clamped.y !== saved.y || clamped.w !== saved.w || clamped.h !== saved.h) latest.current.setRect(clamped);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);
  if (!open) return null;

  /**
   * One gesture, two geometries. `window` listeners rather than React handlers because the pointer
   * leaves the 4 px handle immediately — that is `ui/Resizer.tsx`'s pattern and the reason for it.
   * `start` is captured here and never re-read, so a re-render mid-drag (there is one per mousemove,
   * since the store is written every move) cannot move the base out from under the arithmetic.
   */
  const beginDrag = (e: ReactMouseEvent, apply: (start: PanelRect, dx: number, dy: number, v: Viewport) => PanelRect): void => {
    const startX = e.clientX;
    const startY = e.clientY;
    const start = rect;
    const move = (ev: MouseEvent): void => void latest.current.setRect(apply(start, ev.clientX - startX, ev.clientY - startY, viewportNow()));
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    // `preventDefault` only: it stops the drag selecting the text under the pointer. NOT
    // `stopPropagation` — nothing above this listens for mousedown (see G60 above).
    e.preventDefault();
  };

  return (
    // `no-drag`: this sits over the toolbar's `drag-region`, and a title bar that moved the WINDOW
    // instead of the panel is the obvious way to get that wrong.
    <div
      className="no-drag fixed z-30 flex flex-col overflow-hidden rounded-lg border border-line bg-bg-1 text-fg shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-testid="shortcuts-panel"
      onKeyDown={(e) => {
        // Escape, only from inside the panel. A `<dialog>` used to give this for free via its
        // `cancel` event; a window-level listener must NOT replace it, because Escape belongs to
        // the terminal (vim is one keystroke away from every pane).
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        close();
      }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line pr-1">
        {/* The drag handle IS the title bar, and the Close button is its sibling rather than its
            child, so a click on Close can never start a drag. */}
        <div className="flex-1 cursor-move px-3 py-2 text-[13px] font-semibold select-none" data-testid="shortcuts-titlebar" onMouseDown={(e) => beginDrag(e, movePanelRect)}>
          Keyboard shortcuts
        </div>
        <IconButton title="Close" onClick={close}>
          <X size={14} />
        </IconButton>
      </div>
      <div tabIndex={-1} data-testid="shortcuts-body" className="flex-1 overflow-y-auto p-3 outline-none">
        {cheatsheetSections().map((section) => (
          <div key={section.title} className="mb-3 last:mb-0">
            <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-muted">{section.title.toUpperCase()}</div>
            <ul>
              {section.rows.map((s) => (
                // The chord label is the key as well as the caption: every chord in the table is
                // distinct (asserted), and using it here means a duplicate binding shows up as
                // React's own duplicate-key warning rather than as two identical rows.
                <li key={chordLabel(s.chord)} data-testid="shortcut-row" className="flex items-baseline gap-2 py-[3px] text-[12px]">
                  <span className="w-14 shrink-0 text-right">
                    <Kbd>{chordLabel(s.chord)}</Kbd>
                  </span>
                  <span className="min-w-0 flex-1 text-fg-2">
                    {s.does}
                    {s.caveat === undefined ? null : <span className="block text-[11px] text-muted">{s.caveat}</span>}
                    {OWNED_BY_CODE_EDITOR[s.action.kind] ? <span className="block text-[11px] text-muted">The drawer’s code viewer keeps this one while it has focus.</span> : null}
                  </span>
                  {/* Read off `WORKS_IN_TEXT_FIELD`, not restated. The legend below says what it
                      means; the marker itself stays two words so seventeen rows stay scannable. */}
                  <span className="w-[68px] shrink-0 text-right text-[10.5px] text-muted">{WORKS_IN_TEXT_FIELD[s.action.kind] ? 'while typing' : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
          <span className="text-fg-2">while typing</span> marks the shortcuts that still fire with the caret in a text box; the rest stand down there so they cannot interrupt a sentence. Everything without ⌘ belongs to the terminal. They all work while this panel is open — that is why it is not a modal.
        </p>
      </div>
      {/* Bottom-right corner, the one convention every floating panel shares. */}
      <div
        className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
        data-testid="shortcuts-resize"
        onMouseDown={(e) => beginDrag(e, resizePanelRect)}
      />
    </div>
  );
}
