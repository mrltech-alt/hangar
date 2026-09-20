/**
 * Plan 09 (spec §4) — the mic button in every pane header and the pill above the pane's bottom edge.
 *
 * Mounted through the REAL `PaneGrid` → `Pane` → `PaneHeader`, with a live xterm in every running
 * pane, because the claims are about panes side by side: `dictation:event` is a BROADCAST (G89), so
 * the thing most worth proving is that an event for one agent lights that agent's pane and no other.
 *
 * **G59/G61.** Every selector the two components use returns a primitive. The render-count block at
 * the end asserts that a stream of partials re-renders nothing that did not change, with a
 * deliberately allocating control beside it to prove the counter can see a loop at all.
 *
 * **G66 — jsdom has no focusability rules and no tooltips.** "The pill takes no focus" is asserted
 * as what makes it true in Chromium — nothing focusable inside it, `pointer-events-none` on it — and
 * as `document.activeElement` staying on the terminal through a whole run. The second half alone
 * would pass with or without the first (jsdom moves focus only when something calls `focus()`), so
 * it is the attributes that carry the claim; real focus behaviour is a CDP question. Likewise the
 * disabled button's tooltip is asserted as the `title` on the wrapper the pointer actually lands on.
 */
import { act, Profiler, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictationMessage, MIC_BUTTON_TITLES, PILL_ESCAPE_HINT, PILL_LISTENING, type DictationOutcome, type DictationState } from '../../../../shared/dictation.ts';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';
import {
  defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type Id, type Project, type SessionState, type WorkspaceSnapshot,
} from '../../../../shared/types.ts';
import { micButtonState } from './MicButton.tsx';

const ISO = '2026-09-18T10:00:00.000Z';

const project = (id: string, name: string): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO,
});

const agent = (id: string, name: string): Agent => ({
  id, name, slug: name, folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `hangar/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: true, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null,
});

const running = (id: Id): SessionState => ({ ...initialSessionState(id), activity: 'idle' });

function snapshotWith(panes: (Id | null)[], sessions: Record<Id, SessionState | undefined>, focusedIndex = 0): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: [project('p1', 'hangar')],
      agents: [agent('a1', 'alpha'), agent('a2', 'beta')],
      layout: { ...defaultLayout(), panes, focusedIndex },
    },
    sessions,
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

/**
 * The bridge every renderer test builds, answering every request `ok` (with an attach snapshot for
 * `session:attach`) so no failure toast can be charged to the component under test.
 */
async function load(snapshot: WorkspaceSnapshot) {
  const calls: { channel: IpcRequestKey; payload: unknown }[] = [];
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const value = (channel === 'session:attach' ? { snapshot: '', title: '' } : undefined) as IpcRequests[K]['res'];
      return Promise.resolve({ ok: true, value });
    },
    on<K extends IpcEventKey>(_channel: K, _handler: (payload: IpcEvents[K]) => void): () => void {
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [panes, workspace, sessions, layout, ui, registry, dictation, lib, pill, mic] = await Promise.all([
    import('./PaneGrid.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
    import('../../lib/terminal-registry.ts'),
    import('../../stores/dictation.ts'),
    import('../../lib/dictation.ts'),
    import('./DictationPill.tsx'),
    import('./MicButton.tsx'),
  ]);
  workspace.useWorkspace.getState().setSnapshot(snapshot);
  sessions.useSessions.getState().setAll(snapshot.sessions);
  layout.layoutStore.getState().hydrate(snapshot.workspace.layout);
  /** One `dictation:event`, through the same function `bootstrap.ts` hands the broadcast to. */
  const heard = (agentId: Id, state: DictationState, outcome: DictationOutcome | null = null): void => {
    act(() => lib.receiveDictation({ agentId, state, outcome }));
  };
  const dictationCalls = () => calls.filter((c) => c.channel.startsWith('dictation:'));
  return { ...panes, workspace, sessions, layout, ui, registry, dictation, lib, pill, mic, calls, heard, dictationCalls };
}

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
});

function mount(node: ReactNode): { el: HTMLElement; commits: () => number } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>));
  return { el, commits: () => commits };
}

/** Mounts the grid and flushes the terminals' attach round trips. */
async function grid(t: Awaited<ReturnType<typeof load>>) {
  const mounted = mount(<t.PaneGrid />);
  await act(async () => undefined);
  return mounted;
}

const sections = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('section')];
const micIn = (pane: HTMLElement | undefined): HTMLButtonElement => {
  const button = pane?.querySelector<HTMLButtonElement>('[data-testid="mic"] button');
  if (!button) throw new Error('no mic button in this pane');
  return button;
};
const wrapperOf = (button: HTMLButtonElement): HTMLElement => button.parentElement as HTMLElement;
const pillIn = (pane: HTMLElement | undefined): HTMLElement | null => pane?.querySelector<HTMLElement>('[data-testid="dictation-pill"]') ?? null;

const RECORDING = (partial = ''): DictationState => ({ phase: 'recording', partial });

describe('micButtonState (pure)', () => {
  it('is disabled with its reason when the agent has no running session', () => {
    expect(micButtonState('idle', false, false, true)).toEqual({ disabled: true, title: 'Start the agent to dictate into it.' });
    // No running session outranks another agent's run: it would still be disabled once that ends.
    expect(micButtonState('idle', false, true, true)).toEqual({ disabled: true, title: dictationMessage('NOT_RUNNING') });
  });

  it('is disabled — not pressable-then-refused — while another agent is being dictated to', () => {
    expect(micButtonState('idle', true, true, true)).toEqual({ disabled: true, title: 'Already dictating into another agent. Stop that one first.' });
  });

  it('names ⌘D on the focused pane only, and only where a press is a start or a stop', () => {
    expect(micButtonState('idle', true, false, true)).toEqual({ disabled: false, title: 'Dictate (⌘D)' });
    expect(micButtonState('idle', true, false, false)).toEqual({ disabled: false, title: 'Dictate' });
    expect(micButtonState('recording', true, false, true)).toEqual({ disabled: false, title: 'Stop dictating (⌘D)' });
    expect(micButtonState('starting', true, false, true)).toEqual({ disabled: false, title: MIC_BUTTON_TITLES.starting });
    expect(micButtonState('preparing', true, false, true)).toEqual({ disabled: false, title: MIC_BUTTON_TITLES.preparing });
  });

  // `toggleRequest` asks for nothing while finalizing: the stop is sent and the words are coming.
  it('is disabled while finalizing', () => {
    expect(micButtonState('finalizing', true, false, true)).toEqual({ disabled: true, title: MIC_BUTTON_TITLES.finalizing });
  });

  // A run that is already this agent's must stay stoppable when its session ends under it.
  it('keeps this agent\'s own run stoppable after its session has ended', () => {
    expect(micButtonState('recording', false, false, true).disabled).toBe(false);
    expect(micButtonState('preparing', false, false, true).disabled).toBe(false);
  });
});

describe('the mic in the pane header', () => {
  it('is disabled, and says why on the element the pointer can reach, when the agent is not running', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a2: running('a2') }));
    const { el } = await grid(t);
    const [dead, live] = sections(el);
    const deadMic = micIn(dead);
    expect(deadMic.disabled).toBe(true);
    expect(deadMic.title).toBe(dictationMessage('NOT_RUNNING'));
    // `IconButton` is `disabled:pointer-events-none`, so the tooltip that SHOWS is the wrapper's.
    expect(deadMic.className).toContain('disabled:pointer-events-none');
    expect(wrapperOf(deadMic).title).toBe(dictationMessage('NOT_RUNNING'));
    // The control: a running agent's mic is live.
    expect(micIn(live).disabled).toBe(false);
    expect(micIn(live).title).toBe('Dictate');
  });

  it('pulses while this pane\'s agent is recording, and only then', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    const { el } = await grid(t);
    const mic = () => micIn(sections(el)[0]);
    expect(mic().dataset.dictation).toBe('idle');
    expect(mic().className).not.toContain('pulse');
    t.heard('a1', RECORDING('hi'));
    expect(mic().dataset.dictation).toBe('recording');
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(mic().className).toContain('pulse');
    expect(mic().className).toContain('!text-red');
    expect(mic().title).toBe('Stop dictating (⌘D)');
    t.heard('a1', { phase: 'idle', outcome: { kind: 'write', text: 'hi' } }, { kind: 'write', text: 'hi' });
    expect(mic().dataset.dictation).toBe('idle');
    expect(mic().className).not.toContain('pulse');
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  // First-use model download: a spinner instead of the mic, amber rather than red, and no pulse —
  // it must not look like it is listening, because it is not yet.
  it('shows a distinct preparing look during the model download', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    const { el } = await grid(t);
    t.heard('a1', { phase: 'preparing' });
    const mic = micIn(sections(el)[0]);
    expect(mic.dataset.dictation).toBe('preparing');
    expect(mic.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
    expect(mic.className).toContain('!text-amber');
    expect(mic.className).not.toContain('pulse');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(mic.title).toBe(MIC_BUTTON_TITLES.preparing);
    expect(pillIn(sections(el)[0])).toBeNull();
    // …and recording is a different look: the mic, not the spinner.
    t.heard('a1', RECORDING());
    expect(micIn(sections(el)[0]).querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');
  });

  it('sends toggleRequest for THIS pane\'s agent: start, then stop, and cancel before ready', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    const { el } = await grid(t);
    act(() => micIn(sections(el)[1]).click());
    expect(t.dictationCalls()).toEqual([{ channel: 'dictation:start', payload: { agentId: 'a2' } }]);
    t.heard('a2', { phase: 'starting' });
    act(() => micIn(sections(el)[1]).click());
    t.heard('a2', RECORDING());
    act(() => micIn(sections(el)[1]).click());
    expect(t.dictationCalls().map((c) => c.channel)).toEqual(['dictation:start', 'dictation:cancel', 'dictation:stop']);
  });

  // Escape — the cancel — lives in the terminal's key handler, so a press must not leave the keyboard
  // on the button: mousedown's default (focusing the button) is prevented, and the terminal is focused.
  it('keeps the keyboard in the terminal when pressed', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    const { el } = await grid(t);
    const handle = t.registry.terminals.get('a1');
    expect(handle, 'a running pane should have registered a terminal').toBeDefined();
    const focus = vi.spyOn(handle!.term, 'focus');
    const mic = micIn(sections(el)[0]);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => mic.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    const before = focus.mock.calls.length;
    act(() => mic.click());
    expect(focus.mock.calls.length - before).toBe(1);
  });
});

describe('one agent\'s run never lights another agent\'s pane (G89)', () => {
  it('shows the run in its own pane, and makes every other pane\'s mic say why it cannot start', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    const { el } = await grid(t);
    t.heard('a1', RECORDING('hello there'));
    const [one, two] = sections(el);
    expect(micIn(one).dataset.dictation).toBe('recording');
    expect(pillIn(one)?.textContent).toContain('hello there');
    // Agent B's pane: no pulse, no pill, and a disabled mic with the reason.
    expect(micIn(two).dataset.dictation).toBe('idle');
    expect(micIn(two).className).not.toContain('pulse');
    expect(pillIn(two)).toBeNull();
    expect(micIn(two).disabled).toBe(true);
    expect(wrapperOf(micIn(two)).title).toBe(dictationMessage('ELSEWHERE'));
  });

  it('moves with the agent, not the pane: the same event read from the other side', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    const { el } = await grid(t);
    t.heard('a2', RECORDING('second pane'));
    const [one, two] = sections(el);
    expect(pillIn(one)).toBeNull();
    expect(micIn(one).dataset.dictation).toBe('idle');
    expect(pillIn(two)?.textContent).toContain('second pane');
    expect(micIn(two).dataset.dictation).toBe('recording');
  });

  // The run after next belongs to someone else: the store must follow each event's agent, not keep
  // the first one it ever saw.
  it('lights the second agent\'s pane, and only that one, for the run after the first', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    const { el } = await grid(t);
    t.heard('a1', RECORDING('first'));
    t.heard('a1', { phase: 'idle', outcome: { kind: 'write', text: 'first' } }, { kind: 'write', text: 'first' });
    t.heard('a2', RECORDING('second'));
    const [one, two] = sections(el);
    expect(pillIn(one)).toBeNull();
    expect(micIn(one).dataset.dictation).toBe('idle');
    expect(micIn(one).disabled).toBe(true);
    expect(pillIn(two)?.textContent).toContain('second');
    expect(micIn(two).dataset.dictation).toBe('recording');
  });

  it('frees every other pane\'s mic the moment the run ends', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    const { el } = await grid(t);
    t.heard('a1', RECORDING());
    expect(micIn(sections(el)[1]).disabled).toBe(true);
    t.heard('a1', { phase: 'idle', outcome: { kind: 'cancelled' } }, { kind: 'cancelled' });
    expect(micIn(sections(el)[1]).disabled).toBe(false);
    expect(micIn(sections(el)[1]).title).toBe('Dictate');
  });
});

describe('the pill', () => {
  it('shows the live partial above the pane\'s bottom edge, replacing it as it grows', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    const { el } = await grid(t);
    const pane = () => sections(el)[0];
    expect(pillIn(pane())).toBeNull();
    t.heard('a1', { phase: 'starting' });
    expect(pillIn(pane())).toBeNull();
    t.heard('a1', RECORDING());
    expect(pillIn(pane())?.querySelector('[data-testid="dictation-partial"]')?.textContent).toBe(PILL_LISTENING);
    t.heard('a1', RECORDING('fix the'));
    t.heard('a1', RECORDING('fix the flaky test'));
    expect(pillIn(pane())?.querySelector('[data-testid="dictation-partial"]')?.textContent).toBe('fix the flaky test');
    expect(pillIn(pane())?.textContent).toContain(PILL_ESCAPE_HINT);
    // Positioned against the body's `relative` wrapper, at the bottom, out of flow (no re-fit).
    expect(pillIn(pane())?.className).toMatch(/\babsolute\b/);
    expect(pillIn(pane())?.className).toMatch(/\bbottom-3\b/);
    // Still up while finalizing — the words are on their way in.
    t.heard('a1', { phase: 'finalizing', partial: 'fix the flaky test' });
    expect(pillIn(pane())?.textContent).toContain('fix the flaky test');
    t.heard('a1', { phase: 'idle', outcome: { kind: 'write', text: 'fix the flaky test' } }, { kind: 'write', text: 'fix the flaky test' });
    expect(pillIn(pane())).toBeNull();
  });

  it('takes no focus: nothing focusable in it, no pointer events, and the terminal keeps the keyboard', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    const { el } = await grid(t);
    const textarea = sections(el)[0]?.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
    if (!textarea) throw new Error('no terminal textarea');
    act(() => textarea.focus());
    expect(document.activeElement).toBe(textarea);
    t.heard('a1', RECORDING('one'));
    t.heard('a1', RECORDING('one two'));
    const pill = pillIn(sections(el)[0]);
    expect(pill).not.toBeNull();
    // What makes it true in Chromium (G66): nothing in it can be focused, and it is not hit-tested.
    expect(pill?.className).toMatch(/\bpointer-events-none\b/);
    expect(pill?.hasAttribute('tabindex')).toBe(false);
    expect(pill?.querySelectorAll('[tabindex], button, input, textarea, select, a[href], [contenteditable]').length).toBe(0);
    // And what jsdom can see: the keyboard never moved.
    expect(document.activeElement).toBe(textarea);
    t.heard('a1', { phase: 'idle', outcome: { kind: 'write', text: 'one two' } }, { kind: 'write', text: 'one two' });
    expect(document.activeElement).toBe(textarea);
  });

  // A run the session ended under is still this pane's to show — over the exit card — until main's
  // cancel lands. But there is no terminal there to take an Escape, so the pill must not offer one.
  it('shows over the exit card too, without promising an Escape no terminal is there to take', async () => {
    const t = await load(snapshotWith(['a1'], {}));
    const { el } = await grid(t);
    t.heard('a1', RECORDING('still here'));
    const pill = pillIn(sections(el)[0]);
    expect(pill?.textContent).toContain('still here');
    expect(sections(el)[0]?.querySelector('.xterm')).toBeNull();
    expect(pill?.textContent).not.toContain(PILL_ESCAPE_HINT);
  });

  // The other way to have no terminal: a live session whose worktree has gone shows a card too.
  it('offers no Escape over the missing-worktree card either, and does over the live terminal', async () => {
    const snapshot = snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') });
    const t = await load({ ...snapshot, runtime: { 'w-a1': { workspaceId: 'w-a1', worktreeMissing: true } } });
    const { el } = await grid(t);
    t.heard('a1', RECORDING('lost worktree'));
    expect(pillIn(sections(el)[0])?.textContent).toContain('lost worktree');
    expect(pillIn(sections(el)[0])?.textContent).not.toContain(PILL_ESCAPE_HINT);
    t.heard('a2', RECORDING('live terminal'));
    expect(pillIn(sections(el)[1])?.textContent).toContain(PILL_ESCAPE_HINT);
  });
});

describe('outcomes, as a pane sees them', () => {
  // The words are main's to write and the prompt's to show: a `write` is silent, and so is a cancel.
  // Nothing and every error are said once, through the ordinary toast, from the table.
  it('toasts "Nothing heard." and an error\'s sentence, and nothing for a write or a cancel', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    await grid(t);
    const end = (outcome: DictationOutcome): void => {
      t.heard('a1', RECORDING('x'));
      t.heard('a1', { phase: 'idle', outcome }, outcome);
    };
    end({ kind: 'write', text: 'x' });
    end({ kind: 'cancelled' });
    expect(t.ui.useUi.getState().toasts).toEqual([]);
    end({ kind: 'nothing', message: 'Nothing heard.' });
    end({ kind: 'error', code: 'NO_MODEL', message: 'raw helper text' });
    expect(t.ui.useUi.getState().toasts.map((x) => [x.level, x.title])).toEqual([
      ['info', 'Nothing heard.'],
      ['error', dictationMessage('NO_MODEL')],
    ]);
    // The renderer never writes the transcript itself — main already has.
    expect(t.calls.filter((c) => c.channel === 'session:write')).toEqual([]);
  });
});

describe('render commits (G59/G61)', () => {
  it('commits once for a grid with a run already live, and loops nowhere', async () => {
    const t = await load(snapshotWith(['a1', 'a2', null], { a1: running('a1'), a2: running('a2') }));
    act(() => t.dictation.useDictation.getState().receive({ agentId: 'a1', state: RECORDING('x'), outcome: null }));
    const { commits } = await grid(t);
    expect(commits()).toBe(1);
  });

  // A partial arrives several times a second. The button selects a phase and a boolean, so a new
  // partial changes neither and re-renders neither button; the OTHER agent's pill selects null
  // throughout. Only the recording agent's own pill has anything to draw.
  it('re-renders neither mic nor the other agent\'s pill on a new partial', async () => {
    const t = await load(snapshotWith(['a1', 'a2'], { a1: running('a1'), a2: running('a2') }));
    t.heard('a1', RECORDING('a'));
    const own = mount(<t.mic.MicButton agentId="a1" running focused />);
    const other = mount(<t.mic.MicButton agentId="a2" running focused={false} />);
    const otherPill = mount(<t.pill.DictationPill agentId="a2" escapeCancels />);
    const ownPill = mount(<t.pill.DictationPill agentId="a1" escapeCancels />);
    const before = [own.commits(), other.commits(), otherPill.commits(), ownPill.commits()];
    for (const p of ['a b', 'a b c', 'a b c d']) t.heard('a1', RECORDING(p));
    expect([own.commits(), other.commits(), otherPill.commits()]).toEqual(before.slice(0, 3));
    expect(ownPill.commits() - (before[3] ?? 0)).toBe(3);
  });

  // The control: the same store with a selector that allocates must hang React, or the counts
  // above could simply mean the probe is blind.
  it('catches a selector that allocates — what the mic and the pill must not do', async () => {
    const t = await load(snapshotWith(['a1'], { a1: running('a1') }));
    function Allocating() {
      const s = t.dictation.useDictation((x) => ({ agentId: x.agentId, phase: x.state.phase }));
      return <span>{s.phase}</span>;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Allocating />)).toThrow(/Maximum update depth/);
    } finally {
      spy.mockRestore();
    }
  });
});
