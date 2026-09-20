/**
 * Plan 09 — the renderer's half of dictation, below the components: the store that holds the one
 * run and whose it is, what a press asks main for, what Escape does, and what a finished run says.
 *
 * `dictation:event` is a broadcast (G89), so most of what is asserted here is CORRELATION: an event
 * for one agent must never be read as another's — not by a selector, not by a press, not by Escape.
 *
 * Same loading dance as every renderer test: `lib/api.ts` reads `window.hangar` at module-evaluation
 * time, so the bridge goes in first and everything is imported after `vi.resetModules()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DICTATION_IDLE, dictationMessage, type DictationOutcome, type DictationState } from '../../../shared/dictation.ts';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../shared/ipc-contract.ts';
import { initialSessionState } from '../../../shared/types.ts';

/** `refuse`: every dictation request is answered with this IPC error, as main's handler would throw it. */
async function load(refuse: { code: string; message: string } | null = null) {
  const calls: { channel: IpcRequestKey; payload: unknown }[] = [];
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      if (refuse !== null && channel.startsWith('dictation:')) return Promise.resolve({ ok: false, error: refuse });
      return Promise.resolve({ ok: true, value: undefined as IpcRequests[K]['res'] });
    },
    on<K extends IpcEventKey>(_channel: K, _handler: (payload: IpcEvents[K]) => void): () => void {
      return () => undefined;
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  vi.resetModules();
  const [lib, store, ui, sessions, api] = await Promise.all([
    import('./dictation.ts'),
    import('../stores/dictation.ts'),
    import('../stores/ui.ts'),
    import('../stores/sessions.ts'),
    import('./api.ts'),
  ]);
  const heard = (agentId: string, state: DictationState, outcome: DictationOutcome | null = null): void => lib.receiveDictation({ agentId, state, outcome });
  const live = (id: string): void => sessions.useSessions.getState().setOne(id, { ...initialSessionState(id), activity: 'idle' });
  const toasts = () => ui.useUi.getState().toasts.map((x) => [x.level, x.title]);
  const channels = () => calls.map((c) => c.channel);
  return { ...lib, ...store, ui, sessions, api, calls, heard, live, toasts, channels };
}

let t: Awaited<ReturnType<typeof load>>;
beforeEach(async () => {
  t = await load();
});

const RECORDING: DictationState = { phase: 'recording', partial: 'so far' };
const ended = (outcome: DictationOutcome): DictationState => ({ phase: 'idle', outcome });

describe('the store: one run, and whose it is (G89)', () => {
  it('reads a run as its own agent\'s, and as idle for every other agent and for an empty pane', () => {
    t.heard('a1', RECORDING);
    const s = t.useDictation.getState();
    expect(t.dictationFor(s, 'a1')).toEqual(RECORDING);
    // `toEqual`: the test's static import of `shared/dictation.ts` is a different module instance
    // from the one `vi.resetModules()` gave the store, so its `DICTATION_IDLE` is a different object.
    expect(t.dictationFor(s, 'a2')).toEqual(DICTATION_IDLE);
    expect(t.dictationFor(s, null)).toEqual(DICTATION_IDLE);
    expect(t.partialFor(s, 'a1')).toBe('so far');
    expect(t.partialFor(s, 'a2')).toBeNull();
  });

  // G59/G61: a selector built on these must never allocate. Both answers are either the STORED
  // object or the module constant, so two reads of an unchanged store are identical.
  it('hands back the stored state or the idle constant, never a fresh object', () => {
    t.heard('a1', RECORDING);
    const s = t.useDictation.getState();
    expect(t.dictationFor(s, 'a1')).toBe(s.state);
    expect(t.dictationFor(s, 'a1')).toBe(t.dictationFor(t.useDictation.getState(), 'a1'));
    expect(t.dictationFor(s, 'a2')).toBe(t.dictationFor(t.useDictation.getState(), 'a2'));
    expect(t.dictationFor(s, 'a2')).toBe(t.dictationFor(s, null));
  });

  it('knows another agent\'s LIVE run is in the way, and an ended one is not', () => {
    t.heard('a1', { phase: 'starting' });
    expect(t.dictatingElsewhere(t.useDictation.getState(), 'a2')).toBe(true);
    expect(t.dictatingElsewhere(t.useDictation.getState(), 'a1')).toBe(false);
    t.heard('a1', ended({ kind: 'cancelled' }), { kind: 'cancelled' });
    expect(t.dictatingElsewhere(t.useDictation.getState(), 'a2')).toBe(false);
  });

  it('starts with no run at all', () => {
    const s = t.useDictation.getState();
    expect(s.agentId).toBeNull();
    expect(t.dictatingElsewhere(s, 'a1')).toBe(false);
  });
});

describe('receiveDictation — what a finished run says', () => {
  it('says nothing for a write — the text at the prompt is the answer — and nothing for a cancel', () => {
    t.heard('a1', ended({ kind: 'write', text: 'hello' }), { kind: 'write', text: 'hello' });
    t.heard('a1', ended({ kind: 'cancelled' }), { kind: 'cancelled' });
    expect(t.toasts()).toEqual([]);
  });

  it('says "Nothing heard." as information', () => {
    const nothing = { kind: 'nothing', message: dictationMessage('NOTHING_HEARD') } as const;
    t.heard('a1', ended(nothing), nothing);
    expect(t.toasts()).toEqual([['info', 'Nothing heard.']]);
  });

  it('says each error\'s own sentence, once per run', () => {
    for (const code of ['MIC_DENIED', 'NO_MODEL', 'NO_INPUT', 'NOT_BUILT', 'CRASHED', 'FAILED'] as const) {
      const outcome = { kind: 'error', code, message: dictationMessage(code) } as const;
      t.heard('a1', { phase: 'starting' });
      t.heard('a1', ended(outcome), outcome);
    }
    expect(t.toasts()).toEqual(['MIC_DENIED', 'NO_MODEL', 'NO_INPUT', 'NOT_BUILT', 'CRASHED', 'FAILED'].map((c) => ['error', dictationMessage(c as 'MIC_DENIED')]));
  });

  // Main put the words on the clipboard because a permission prompt was up: said once, and sticky,
  // because nothing else on screen says where they went.
  it('says a copied transcript as a sticky warning with the table\'s sentence', () => {
    const copied = { kind: 'copied', message: 'whatever main sent' } as const;
    t.heard('a1', ended(copied), copied);
    expect(t.ui.useUi.getState().toasts.map((x) => [x.level, x.title, x.sticky])).toEqual([
      ['warn', 'The agent is waiting for an answer, so your dictation was copied instead of typed. Paste it with ⌘V when you\'re ready.', true],
    ]);
  });

  // The outcome crossed a process boundary; the sentence comes from the table by CODE.
  it('never shows the message an outcome carries — only the table\'s sentence for its code', () => {
    const outcome = { kind: 'error', code: 'MIC_DENIED', message: 'AVAudioSession error -50 (helper stderr)' } as const;
    t.heard('a1', ended(outcome), outcome);
    expect(t.toasts()).toEqual([['error', dictationMessage('MIC_DENIED')]]);
  });

  // `outcome` is null on every event but the last; a state that merely LOOKS ended says nothing.
  it('says nothing for an event without an outcome', () => {
    t.heard('a1', ended({ kind: 'nothing', message: 'Nothing heard.' }));
    expect(t.toasts()).toEqual([]);
  });
});

describe('toggleDictation — the button and ⌘D', () => {
  it('asks to start for an idle agent with a running session', () => {
    t.live('a1');
    t.toggleDictation('a1');
    expect(t.calls).toEqual([{ channel: 'dictation:start', payload: { agentId: 'a1' } }]);
  });

  it('asks for exactly what toggleRequest says in each phase of THIS agent\'s run', () => {
    t.live('a1');
    for (const state of [RECORDING, { phase: 'starting' }, { phase: 'preparing' }, { phase: 'finalizing', partial: 'x' }] as DictationState[]) {
      t.heard('a1', state);
      t.toggleDictation('a1');
    }
    expect(t.channels()).toEqual(['dictation:stop', 'dictation:cancel', 'dictation:cancel']);
  });

  it('refuses a start while another agent is being dictated to, with the button\'s sentence', () => {
    t.live('a1');
    t.live('a2');
    t.heard('a1', RECORDING);
    t.toggleDictation('a2');
    expect(t.calls).toEqual([]);
    expect(t.toasts()).toEqual([['warn', dictationMessage('ELSEWHERE')]]);
  });

  // "Absent = stopped" (§6.5), and an exited session is not running either.
  it('refuses a start for an agent with no running session, with the button\'s sentence', () => {
    t.toggleDictation('a1');
    t.sessions.useSessions.getState().setOne('a1', { ...initialSessionState('a1'), activity: 'exited' });
    t.toggleDictation('a1');
    expect(t.calls).toEqual([]);
    expect(t.toasts()).toEqual([['warn', dictationMessage('NOT_RUNNING')], ['warn', dictationMessage('NOT_RUNNING')]]);
  });

  // A run that is already this agent's must stay stoppable after its session ends under it.
  it('still stops this agent\'s own run when its session has ended', () => {
    t.heard('a1', RECORDING);
    t.toggleDictation('a1');
    expect(t.channels()).toEqual(['dictation:stop']);
  });

  // Another agent's run ENDED is not in the way: the next start is this agent's to make.
  it('lets a start through once the other agent\'s run has ended', () => {
    t.live('a2');
    t.heard('a1', ended({ kind: 'cancelled' }), { kind: 'cancelled' });
    t.toggleDictation('a2');
    expect(t.calls).toEqual([{ channel: 'dictation:start', payload: { agentId: 'a2' } }]);
  });
});

/**
 * Main refuses a start with a code and a sentence written for its LOG. The ordinary error sink toasts
 * the sentence, so without a dictation error path main's wording reached the screen. Every word this
 * feature shows is `shared/dictation.ts`'s.
 */
describe('a request main refuses — said in the feature\'s own words', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it.each([
    ['DICTATION_BUSY', 'Dictation is still running. Wait for it to finish.', 'The last dictation is still finishing. Try again in a moment.'],
    ['NOT_RUNNING', 'the agent has no running session to dictate into', 'Start the agent to dictate into it.'],
  ])('says %s as the table\'s sentence, never main\'s', async (code, mainSaid, shown) => {
    t = await load({ code, message: mainSaid });
    const sink = vi.fn();
    t.api.setErrorSink(sink);
    t.live('a1');
    t.toggleDictation('a1');
    await settle();
    expect(t.toasts()).toEqual([['warn', shown]]);
    expect(sink).not.toHaveBeenCalled();
  });

  // A code dictation has no words for is the ordinary sink's, exactly as `run` would have sent it.
  it('passes any other code to the ordinary error sink untouched', async () => {
    t = await load({ code: 'HOST_DOWN', message: 'the session host is not connected' });
    const sink = vi.fn();
    t.api.setErrorSink(sink);
    t.heard('a1', RECORDING);
    expect(t.cancelDictationOnEscape('a1')).toBe(true);
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ code: 'HOST_DOWN', message: 'the session host is not connected' });
    expect(t.toasts()).toEqual([]);
  });
});

describe('cancelDictationOnEscape — Escape in the terminal', () => {
  it('consumes Escape and cancels while THIS agent is recording', () => {
    t.heard('a1', RECORDING);
    expect(t.cancelDictationOnEscape('a1')).toBe(true);
    expect(t.channels()).toEqual(['dictation:cancel']);
  });

  // Every phase that takes a cancel: before `ready` a press is already a cancel, and finalizing is
  // where Escape drops a transcript on its way in.
  it('consumes it in every phase that takes a cancel', () => {
    for (const state of [{ phase: 'starting' }, { phase: 'preparing' }, { phase: 'finalizing', partial: 'x' }] as DictationState[]) {
      t.heard('a1', state);
      expect(t.cancelDictationOnEscape('a1')).toBe(true);
    }
    expect(t.channels()).toEqual(['dictation:cancel', 'dictation:cancel', 'dictation:cancel']);
  });

  // Escape is the terminal's at every other moment — Claude Code interrupts with it.
  it('lets it through when idle, when ANOTHER agent is recording, and once the run has ended', () => {
    expect(t.cancelDictationOnEscape('a1')).toBe(false);
    t.heard('a2', RECORDING);
    expect(t.cancelDictationOnEscape('a1')).toBe(false);
    t.heard('a1', RECORDING);
    t.heard('a1', ended({ kind: 'write', text: 'x' }), { kind: 'write', text: 'x' });
    expect(t.cancelDictationOnEscape('a1')).toBe(false);
    expect(t.calls).toEqual([]);
  });
});
