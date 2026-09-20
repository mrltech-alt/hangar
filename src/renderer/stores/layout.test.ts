import { describe, expect, it, vi } from 'vitest';
import { defaultLayout, type Layout } from '../../../shared/types.ts';
import { createLayoutStore } from './layout.ts';

describe('layout store', () => {
  it('applies reducer actions and pushes the result to main (debounced)', async () => {
    vi.useFakeTimers();
    const pushed: Layout[] = [];
    const store = createLayoutStore((l) => { pushed.push(l); });
    store.getState().hydrate(defaultLayout());
    store.getState().openInFocused('a');
    store.getState().openInNewPane('b');
    expect(store.getState().layout.panes).toEqual(['a', 'b']);
    expect(store.getState().layout.focusedIndex).toBe(1);
    expect(pushed.length).toBe(0);
    vi.advanceTimersByTime(150);
    expect(pushed.length).toBe(1);
    // WHAT is pushed, not merely that something was. This store is the only writer to main's
    // persisted `Layout`, and the payload was unasserted: swapping `push(get().layout)` for
    // `push(defaultLayout())` — which resets the user's saved layout on every interaction — passed
    // the whole suite.
    expect(pushed[0]).toEqual(store.getState().layout);
    expect(pushed[0]?.panes).toEqual(['a', 'b']);
    expect(pushed[0]?.focusedIndex).toBe(1);
    expect(store.getState().openInNewPane('c')).toBe(true);
    expect(store.getState().openInNewPane('d')).toBe(true);
    expect(store.getState().openInNewPane('e')).toBe(false); // full
    store.getState().closePane(3);
    expect(store.getState().layout.panes).toEqual(['a', 'b', 'c']);
    vi.useRealTimers();
  });

  it('coalesces a burst into one push carrying the final layout', () => {
    vi.useFakeTimers();
    const pushed: Layout[] = [];
    const store = createLayoutStore((l) => { pushed.push(l); });
    store.getState().hydrate(defaultLayout());
    store.getState().openInFocused('a');
    store.getState().setSidebar({ width: 300 });
    store.getState().setDrawer({ open: true });
    vi.advanceTimersByTime(150);
    expect(pushed.length).toBe(1);
    expect(pushed[0]).toMatchObject({ panes: ['a'], sidebarWidth: 300, drawerOpen: true });
    vi.useRealTimers();
  });

  // `hydrated` is the guard that stops a later `workspace:changed` stomping the live layout
  // (bootstrap.ts only hydrates while it is false). Nothing asserted it was ever set.
  it('marks itself hydrated', () => {
    const store = createLayoutStore(() => {});
    expect(store.getState().hydrated).toBe(false);
    store.getState().hydrate(defaultLayout());
    expect(store.getState().hydrated).toBe(true);
  });

  // hydrate() runs the layout through normalizeLayout, which is the repair path for a corrupt
  // persisted Layout (spec §12.3). Dropping the call left the clamp untested and out-of-range
  // values live in the UI.
  it('normalizes what it hydrates, repairing an out-of-range persisted layout', () => {
    const store = createLayoutStore(() => {});
    store.getState().hydrate({ ...defaultLayout(), panes: ['a', 'a', null], focusedIndex: 99, sidebarWidth: 9_999, drawerWidth: 1 });
    const l = store.getState().layout;
    expect(l.panes).toEqual(['a', null, null]); // duplicate agent id collapsed to an empty pane
    expect(l.focusedIndex).toBe(2);             // clamped to panes.length - 1
    expect(l.sidebarWidth).toBe(480);           // clamped to the 200..480 range
    expect(l.drawerWidth).toBe(420);            // clamped to the 420 minimum
    expect(l.arrangement).toBe('triple');       // derived from the pane count, never stored
  });

  it('does not push what it merely hydrated', () => {
    vi.useFakeTimers();
    const pushed: Layout[] = [];
    const store = createLayoutStore((l) => { pushed.push(l); });
    store.getState().hydrate(defaultLayout());
    vi.advanceTimersByTime(150);
    // Hydration is main telling US the layout; echoing it straight back would be a write loop.
    expect(pushed.length).toBe(0);
    vi.useRealTimers();
  });
});
