import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { IconButton } from './Button.tsx';

/**
 * What `showModal()` focuses, and why `autoFocus` cannot be the answer here.
 *
 * Measured in Chrome 152 over CDP against a faithful reduction of this file's DOM (header Close
 * button first, name input second):
 *
 *   A. input.focus() while the dialog is still CLOSED, then showModal()
 *        before → activeElement = BODY          (the focus() did nothing at all)
 *        after  → activeElement = BUTTON#close  (showModal picked the first focusable)
 *   B. input carrying the literal `autofocus` ATTRIBUTE, then showModal()
 *        after  → activeElement = INPUT
 *   C. showModal(), then input.focus()
 *        after  → activeElement = INPUT
 *
 * React's `autoFocus` prop is case A twice over. React does not render an `autofocus` attribute —
 * it calls `.focus()` during commit — and at commit time this `<dialog>` has not been shown yet,
 * so it is `display: none` and the call is a no-op. `showModal()` then runs the HTML "dialog
 * focusing steps", which look for the `autofocus` *attribute* (absent) and otherwise take the
 * first focusable descendant. So every dialog opened with `autoFocus` on its first field put focus
 * on the header Close button instead, and one Space closed the dialog: measured, a single Space
 * keyUp dispatched with Close focused fired its click handler and left `dialog.open === false`.
 *
 * The fix is case C — focus AFTER `showModal()`, from the one place that calls it. `initialFocus`
 * names the control each dialog wants; the fallback is the first focusable element in the BODY,
 * never the header.
 */
const FOCUSABLE = [
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Dialog({ open, onClose, title, children, width = 520, initialFocus }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number; initialFocus?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // `initialFocus` can be null here on purpose: a dialog may name a control that is not
      // rendered yet (DeleteAgentDialog's confirm box appears only once the inspection arrives),
      // and the body's first focusable is the right stand-in until it does.
      const target = initialFocus?.current ?? body.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      target?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, initialFocus]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="rounded-lg border border-line bg-bg-1 p-0 text-fg shadow-2xl"
      style={{ width, maxWidth: '90vw' }}
    >
      {/*
        The wrapper carries `relative`, not the `<dialog>`. A modal dialog is centred by the UA
        stylesheet's `position: absolute; inset: 0; margin: auto`, so putting Tailwind's `relative`
        on the element itself would take it out of the top layer's centring and drop it into normal
        flow.
      */}
      <div className="relative">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {/* Holds the Close button's 24x24 box so the header keeps the height it had while the
              button itself lives at the end of the DOM (see below). */}
          <span aria-hidden className="h-6 w-6" />
        </div>
        <div ref={body} className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {/*
          LAST in DOM order, positioned back into the header. Tab order follows the DOM, and CSS
          `order` / `flex-row-reverse` do not change it — only the DOM does. Being first made this
          button the default focus target of `showModal()` (see the measurements above) and it is
          still the first thing Tab reaches from anywhere in a body with no focusable controls.
          Last, the first Tab stop is a form field and Close is where a Close button belongs: at the
          end, next to Escape and the footer's own Cancel.
        */}
        <IconButton title="Close" className="absolute right-4 top-3" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>;
}
