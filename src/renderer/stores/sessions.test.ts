import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { initialSessionState, type SessionState } from '../../../shared/types.ts';
import { useSession, useSessions } from './sessions.ts';

describe('sessions store tick', () => {
  // Spec §13's renderer half. Main throttles `session:state` to changes the user can see, so between
  // broadcasts nothing here ages — and the 3 s decay from `working` to `idle` is exactly what must.
  it('ages a working session to idle without a broadcast from main', () => {
    const working = { ...initialSessionState('a1'), activity: 'working' as const, lastOutputAt: 1_000, hooksSeen: false };
    useSessions.getState().setAll({ a1: working });
    useSessions.getState().tick(2_000); // 1 s of silence: not yet
    expect(useSessions.getState().sessions.a1?.activity).toBe('working');
    useSessions.getState().tick(5_000); // 4 s: past IDLE_AFTER_MS
    expect(useSessions.getState().sessions.a1?.activity).toBe('idle');
  });

  // A 1 s interval that re-rendered the whole sidebar every time would be worse than the staleness
  // it fixes, so `tick` must return the SAME object when nothing moved — that is what zustand uses
  // to skip the re-render.
  it('returns the identical state object when no session changed', () => {
    useSessions.getState().setAll({ a1: { ...initialSessionState('a1'), activity: 'idle' } });
    const before = useSessions.getState().sessions;
    useSessions.getState().tick(9_999);
    expect(useSessions.getState().sessions).toBe(before);
  });
});

describe('setOne', () => {
  // The whole `session:state` path runs through this one line, and nothing asserted it: replacing
  // the body with a no-op left the suite green while every status dot in the app froze.
  it('replaces one session and leaves the others alone', () => {
    useSessions.getState().setAll({ a1: initialSessionState('a1'), a2: initialSessionState('a2') });
    const a2Before = useSessions.getState().sessions.a2;
    useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'working', pid: 42 });
    expect(useSessions.getState().sessions.a1).toMatchObject({ activity: 'working', pid: 42 });
    expect(useSessions.getState().sessions.a2).toBe(a2Before);
  });

  it('adds a session that was not in the record', () => {
    useSessions.getState().setAll({});
    useSessions.getState().setOne('new', { ...initialSessionState('new'), activity: 'starting' });
    expect(useSessions.getState().sessions.new?.activity).toBe('starting');
  });
});

describe('useSession', () => {
  // zustand 5 passes the selector to `useSyncExternalStore`, which requires a referentially stable
  // snapshot. Returning a fresh `initialSessionState(...)` per call made React re-render forever.
  // With this exact probe against the unmemoised version: 55 renders, then "Maximum update depth
  // exceeded", plus React's own "The result of getSnapshot should be cached to avoid an infinite
  // loop". Both inputs are ordinary — an empty pane (§12.3) and an agent absent from the record
  // ("absent = stopped", §6.5).
  function mount(probe: () => null): { root: ReturnType<typeof createRoot> } {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(probe)));
    return { root };
  }

  it('does not loop React when the session is missing', () => {
    useSessions.getState().setAll({});
    let renders = 0;
    const { root } = mount(() => {
      renders += 1;
      useSession(null);
      useSession('gone');
      return null;
    });
    expect(renders).toBe(1);
    act(() => root.unmount());
  });

  it('returns the identical object across renders per id, and a distinct one per id', () => {
    useSessions.getState().setAll({});
    const forNull: SessionState[] = [];
    const forGone: SessionState[] = [];
    const Probe = (): null => {
      forNull.push(useSession(null));
      forGone.push(useSession('gone'));
      return null;
    };
    const { root } = mount(Probe);
    act(() => root.render(createElement(Probe)));
    expect(forNull.length).toBeGreaterThanOrEqual(2);
    expect(forNull[0]).toBe(forNull[1]);
    expect(forGone[0]).toBe(forGone[1]);
    // Distinct per id, so two empty panes are never mistaken for one another.
    expect(forNull[0]).not.toBe(forGone[0]);
    expect(forGone[0]?.agentId).toBe('gone');
    act(() => root.unmount());
  });

  it('prefers a present session over the memoised stand-in', () => {
    const live = { ...initialSessionState('a1'), activity: 'waiting' as const };
    useSessions.getState().setAll({ a1: live });
    let seen: SessionState | null = null;
    const { root } = mount(() => {
      seen = useSession('a1');
      return null;
    });
    expect(seen).toBe(live);
    act(() => root.unmount());
  });
});
