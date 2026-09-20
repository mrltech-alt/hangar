import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { keyLabel, type KeymapAction } from '../../lib/keymap.ts';
import { useUi } from '../../stores/ui.ts';

const FOCUS_SEARCH: KeymapAction = { kind: 'focus-search' };

/**
 * `"Search agents  ⌘⇧K"`, with the key read off `SHORTCUTS` rather than typed in — ⌘⇧K is a NEW
 * binding (Plan 05 Task 1 moved the sidebar search off ⌘K), which is precisely the kind of move
 * that leaves a hand-typed placeholder pointing at the wrong key. `trimEnd` covers the unbound
 * case: no key, no trailing gap.
 */
const PLACEHOLDER = `Search agents  ${keyLabel(FOCUS_SEARCH) ?? ''}`.trimEnd();

export function SearchBox() {
  // Three selectors, each returning a stored reference or a primitive. `searchFocusRequest` is a
  // COUNTER rather than a boolean flag precisely so ⌘⇧K works twice in a row: a boolean would have
  // to be reset, and the reset is another render that can race the effect.
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const focusRequest = useUi((s) => s.searchFocusRequest);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest > 0) ref.current?.focus();
  }, [focusRequest]);
  return (
    <div className="relative mx-2 mb-2">
      <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
      <input
        ref={ref}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setSearch('');
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={PLACEHOLDER}
        className="no-drag w-full rounded-md border border-line bg-bg-0 py-1 pr-6 pl-6 text-[12px] text-fg outline-none placeholder:text-muted focus:border-accent"
      />
      {search ? (
        <button type="button" className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted hover:text-fg" onClick={() => setSearch('')} aria-label="Clear search">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
