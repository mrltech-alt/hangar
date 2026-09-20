import { describe, expect, it } from 'vitest';
import { reduceSession } from '../../../shared/status.ts';
import { initialSessionState, type Activity, type Id, type SessionState } from '../../../shared/types.ts';
import { attentionBody, createNotifier, shouldNotify, type NotificationRequest, type NotifyMode } from './notifications.ts';

const s = (activity: Activity, attachedPane: number | null = null, patch: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState('a'), activity, attachedPane, ...patch,
});

const ALL_ACTIVITIES: readonly Activity[] = ['stopped', 'starting', 'shell', 'working', 'waiting', 'needs-permission', 'idle', 'exited'];

describe('attentionBody', () => {
  it('names the two attention states and nothing else', () => {
    const bodies = Object.fromEntries(ALL_ACTIVITIES.map((a) => [a, attentionBody(a)]));
    expect(bodies).toEqual({
      stopped: null, starting: null, shell: null, working: null, idle: null, exited: null,
      waiting: 'Finished — waiting for you', 'needs-permission': 'Needs permission',
    });
  });
});

describe('shouldNotify', () => {
  it('fires on transitions into attention states when the user is not looking', () => {
    expect(shouldNotify(s('working'), s('waiting'), 'attention', false)).toBe('Finished — waiting for you');
    expect(shouldNotify(s('working'), s('needs-permission'), 'attention', true)).toBe('Needs permission');
    expect(shouldNotify(s('working'), s('waiting', 0), 'attention', true)).toBeNull(); // visible and window focused
    expect(shouldNotify(s('waiting'), s('waiting'), 'attention', false)).toBeNull(); // no transition
    expect(shouldNotify(s('working'), s('idle'), 'attention', false)).toBeNull();
  });

  it('honours the config', () => {
    expect(shouldNotify(s('working'), s('waiting'), 'off', false)).toBeNull();
    expect(shouldNotify(s('working'), s('waiting', 0), 'all', true)).toBe('Finished — waiting for you');
  });

  it('treats a detached pane and a blurred window as equally "not looking"', () => {
    // The two halves of `windowFocused && attachedPane !== null`, each on its own.
    expect(shouldNotify(s('working'), s('waiting', 0), 'attention', false)).toBe('Finished — waiting for you');
    expect(shouldNotify(s('working'), s('waiting', null), 'attention', true)).toBe('Finished — waiting for you');
  });

  it('never notifies for a repeat of the same activity, whatever else changed', () => {
    // The exact shape `session-registry.ts` rebroadcasts on: same activity, a different rendered
    // field. Every one of these is a real broadcast the notifier will see.
    const sat = s('needs-permission');
    for (const patch of [{ unread: true }, { title: 'x' }, { pid: 42 }, { lastOutputAt: 9 }, { hooksSeen: true }, { attachedPane: 1 }]) {
      expect(shouldNotify(sat, { ...sat, ...patch }, 'attention', false)).toBeNull();
      expect(shouldNotify(sat, { ...sat, ...patch }, 'all', false)).toBeNull();
    }
  });

  it('mode "off" beats everything, and "all" only lifts the looking suppression', () => {
    expect(shouldNotify(s('working'), s('needs-permission'), 'off', false)).toBeNull();
    expect(shouldNotify(s('waiting'), s('waiting'), 'all', false)).toBeNull(); // "all" is not "no transition check"
    expect(shouldNotify(s('working'), s('idle'), 'all', false)).toBeNull(); // nor "any activity"
  });

  it('unread is not a substitute for windowFocused && attached (measured)', () => {
    // Why `shouldNotify` takes `windowFocused` rather than reading `next.unread`. `reduceSession`'s
    // `flag()` is `s.unread || s.attachedPane === null || !ctx.windowFocused`, so unread STICKS.
    const prev = s('working', 0, { unread: true, hooksSeen: true });
    const next = reduceSession(prev, { kind: 'hook', name: 'Stop', at: 1 }, { windowFocused: true });
    expect(next.activity).toBe('waiting');
    expect(next.unread).toBe(true); // the user IS looking, and unread is true anyway
    expect(shouldNotify(prev, next, 'attention', true)).toBeNull();
  });
});

interface Harness {
  shown: NotificationRequest[];
  agents: Map<Id, string>;
  logged: string[];
  focused: Id[];
  windowShown: number;
  mode: NotifyMode;
  windowFocused: boolean;
}

function harness(opts: { agents?: [Id, string][]; mode?: NotifyMode; windowFocused?: boolean } = {}) {
  const h: Harness = {
    shown: [], agents: new Map(opts.agents ?? [['a1', 'Alpha']]), logged: [], focused: [], windowShown: 0,
    mode: opts.mode ?? 'attention', windowFocused: opts.windowFocused ?? false,
  };
  const notifier = createNotifier({
    present: (n) => h.shown.push(n),
    mode: () => h.mode,
    windowFocused: () => h.windowFocused,
    agentName: (id) => h.agents.get(id) ?? null,
    showWindow: () => {
      h.windowShown += 1;
    },
    focusAgent: (id) => h.focused.push(id),
    log: (l) => h.logged.push(l),
  });
  return { h, notifier };
}

describe('createNotifier', () => {
  it('shows one banner per transition, titled with the agent name', () => {
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    expect(h.shown.map((n) => [n.title, n.body])).toEqual([['Alpha', 'Finished — waiting for you']]);
  });

  it('does not repeat while an agent sits in needs-permission across many broadcasts', () => {
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('needs-permission'));
    // Ten more broadcasts of the same condition — the shape `tick()` and every `unread`/`title`
    // change produce while the user is away from the machine.
    for (let i = 0; i < 10; i += 1) notifier.observe('a1', s('needs-permission', null, { lastOutputAt: i, unread: true, title: `t${i}` }));
    expect(h.shown).toHaveLength(1);
  });

  it('records the previous state on the suppressed paths too', () => {
    // Suppressed because the user was looking. The transition is spent: tabbing away afterwards
    // must not fire a banner for a turn they already saw finish.
    const { h, notifier } = harness({ windowFocused: true });
    notifier.observe('a1', s('working', 0));
    notifier.observe('a1', s('waiting', 0));
    expect(h.shown).toHaveLength(0);
    h.windowFocused = false;
    notifier.observe('a1', s('waiting', 0));
    expect(h.shown).toHaveLength(0);
  });

  it('records the previous state while notifications are off', () => {
    const { h, notifier } = harness({ mode: 'off' });
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    h.mode = 'attention';
    notifier.observe('a1', s('waiting', null, { unread: true }));
    expect(h.shown).toHaveLength(0);
  });

  it('reads the mode and the focus flag at decision time, not at construction', () => {
    const { h, notifier } = harness({ mode: 'off', windowFocused: true });
    notifier.observe('a1', s('working', 0));
    h.mode = 'all';
    notifier.observe('a1', s('needs-permission', 0));
    expect(h.shown.map((n) => n.body)).toEqual(['Needs permission']);
  });

  it('keeps agents apart', () => {
    const { h, notifier } = harness({ agents: [['a1', 'Alpha'], ['a2', 'Beta']] });
    notifier.observe('a1', s('working'));
    notifier.observe('a2', s('working'));
    notifier.observe('a1', s('waiting'));
    notifier.observe('a2', s('needs-permission'));
    expect(h.shown.map((n) => [n.agentId, n.body])).toEqual([['a1', 'Finished — waiting for you'], ['a2', 'Needs permission']]);
  });

  it('shows nothing for an agent that has left the workspace', () => {
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    h.agents.delete('a1');
    notifier.observe('a1', s('waiting'));
    expect(h.shown).toHaveLength(0);
  });

  it('forgets a deleted agent, so no state outlives it', () => {
    // WHY the line exists: without it main keeps one SessionState per agent ever deleted for the
    // life of the process. `session-registry.ts`'s `tick()` prunes its own map on exactly this
    // condition, and this one mirrors it.
    //
    // HOW it is measured — read this as the proxy it is, not as a scenario. Nothing on the public
    // surface reports the map's size, so the observable stand-in is that a forgotten id is seeded
    // from `initialSessionState` (`stopped`) again: observing `waiting` for a remembered id is not
    // a transition and shows nothing, while observing it for a forgotten one is and shows a banner.
    // Ids are never reused in the app, so this sequence is the instrument, not a real case.
    // Measured: with `previous.delete(agentId)` removed, this test is the only one of the 1125
    // that fails.
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    expect(h.shown).toHaveLength(1);
    h.agents.delete('a1');
    notifier.observe('a1', s('waiting')); // the observation that must clear the remembered `waiting`
    h.agents.set('a1', 'Alpha again');
    notifier.observe('a1', s('waiting'));
    expect(h.shown.map((n) => n.title)).toEqual(['Alpha', 'Alpha again']);
  });

  it('clicking raises the window and focuses the agent', () => {
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    h.shown[0]!.onClick();
    expect(h.windowShown).toBe(1);
    expect(h.focused).toEqual(['a1']);
  });

  it('clicking still raises the window when the agent is gone, but focuses nothing', () => {
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    h.agents.delete('a1'); // deleted between the banner appearing and the click
    h.shown[0]!.onClick();
    expect(h.windowShown).toBe(1);
    expect(h.focused).toEqual([]);
    expect(h.logged.join('\n')).toContain('no longer in the workspace');
  });

  it('clicking focuses an agent whose session has since ended', () => {
    // The session ending is not the agent going away: the pane shows the exit card, which is
    // exactly what the user clicked the banner to see.
    const { h, notifier } = harness();
    notifier.observe('a1', s('working'));
    notifier.observe('a1', s('waiting'));
    notifier.observe('a1', s('exited'));
    h.shown[0]!.onClick();
    expect(h.focused).toEqual(['a1']);
  });
});
