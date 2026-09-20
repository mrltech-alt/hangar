import { useEffect, useRef, useState } from 'react';

/**
 * The in-place editor shared by folder and agent rows. Commits on Enter or blur, cancels on Escape,
 * and treats an empty or unchanged name as a cancel so a stray click never renames anything to ''.
 *
 * Every key event is stopped: the row underneath and the window-level shortcuts (⌘K, ⌘N) must not
 * see what is being typed into a rename box.
 */
export function InlineRename({ value, onCommit, onCancel }: { value: string; onCommit: (next: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const t = text.trim();
    if (t.length === 0 || t === value) onCancel();
    else onCommit(t);
  };
  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onCancel();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded border border-accent bg-bg-0 px-1 text-[12px] text-fg outline-none"
    />
  );
}
