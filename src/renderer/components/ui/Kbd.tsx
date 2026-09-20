import { keyLabel, type KeymapAction } from '../../lib/keymap.ts';

export function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-line bg-bg-3 px-1 font-sans text-[10px] text-fg-2">{children}</kbd>;
}

/**
 * A `<Kbd>` whose caption comes from `SHORTCUTS` instead of being typed in.
 *
 * Three of these were hardcoded — `<Kbd>⌘N</Kbd>` in `Sidebar.tsx` and `<Kbd>⌘K</Kbd>` /
 * `<Kbd>⌘N</Kbd>` / `<Kbd>⌘⇧W</Kbd>` in `EmptyPane.tsx` — which is a caption that a rebinding in
 * `keymap.ts` would silently have left lying. They all render through this now.
 *
 * Renders NOTHING when the action has no binding, rather than an empty box or an invented key: a
 * button with no shortcut simply shows its label.
 */
export function ShortcutKbd({ action }: { action: KeymapAction }) {
  const label = keyLabel(action);
  return label === null ? null : <Kbd>{label}</Kbd>;
}
