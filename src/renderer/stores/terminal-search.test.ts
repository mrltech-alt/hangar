/**
 * The ⌘F find-bar store (Plan 05 Task 3).
 *
 * Small enough to test as pure state, and the two properties worth pinning are both invisible from
 * a component: that `close` on an already-closed agent produces NO new state — which is what makes
 * it safe in an effect cleanup StrictMode invokes twice, and what stops every terminal teardown
 * re-rendering the whole grid — and that the flag is per agent, which is the bug the store exists
 * to make unspellable. The render-count half (G59/G61) lives with the consumer, in
 * `components/panes/TerminalView.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalSearch } from './terminal-search.ts';

const open = (): string[] => [...useTerminalSearch.getState().open];

beforeEach(() => {
  useTerminalSearch.setState({ open: new Set() });
});

describe('toggle', () => {
  it('opens, then closes, the agent it is given', () => {
    useTerminalSearch.getState().toggle('a1');
    expect(open()).toEqual(['a1']);
    useTerminalSearch.getState().toggle('a1');
    expect(open()).toEqual([]);
  });

  /**
   * The reason the store exists. `PaneGrid` keys its panes by slot, so a `useState` in
   * `TerminalView` belongs to the pane and an agent moving into that pane inherits it. Two agents
   * with independent flags is the shape that cannot happen positionally.
   */
  it('keeps one flag per agent', () => {
    useTerminalSearch.getState().toggle('a1');
    useTerminalSearch.getState().toggle('a2');
    expect(open().sort()).toEqual(['a1', 'a2']);
    useTerminalSearch.getState().toggle('a1');
    expect(open()).toEqual(['a2']);
  });

  // Immutable update: zustand compares by identity, so mutating the stored Set in place would
  // change the app's state without notifying a single subscriber.
  it('replaces the Set rather than mutating it', () => {
    const before = useTerminalSearch.getState().open;
    useTerminalSearch.getState().toggle('a1');
    expect(useTerminalSearch.getState().open).not.toBe(before);
    expect([...before]).toEqual([]);
  });
});

describe('close', () => {
  it('closes an open agent', () => {
    useTerminalSearch.getState().toggle('a1');
    useTerminalSearch.getState().close('a1');
    expect(open()).toEqual([]);
  });

  /**
   * The idempotence that `TerminalView`'s teardown effect relies on, asserted as the property that
   * actually matters rather than as "it does not throw": no new state object, so no subscriber is
   * notified. Deleting the early return in `close` leaves the `toEqual([])` assertions green and
   * fails both of these — measured by reverting it.
   */
  it('is a no-op for an agent that is not open, allocating no new state', () => {
    const before = useTerminalSearch.getState().open;
    const notified = vi.fn();
    const off = useTerminalSearch.subscribe(notified);
    try {
      useTerminalSearch.getState().close('never-opened');
      useTerminalSearch.getState().close('never-opened');
      expect(useTerminalSearch.getState().open).toBe(before);
      expect(notified).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('notifies once when it does close something, and not again on a repeat', () => {
    useTerminalSearch.getState().toggle('a1');
    const notified = vi.fn();
    const off = useTerminalSearch.subscribe(notified);
    try {
      useTerminalSearch.getState().close('a1');
      useTerminalSearch.getState().close('a1');
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('leaves every other agent alone', () => {
    useTerminalSearch.getState().toggle('a1');
    useTerminalSearch.getState().toggle('a2');
    useTerminalSearch.getState().close('a1');
    expect(open()).toEqual(['a2']);
  });
});
