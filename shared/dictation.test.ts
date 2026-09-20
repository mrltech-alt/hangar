/**
 * Dictation's protocol, state machine and words — spec 2026-09-18 §4.
 *
 * The lines here are spelled the way `mac/dictate/main.swift` writes them (`t` first, its own JSON
 * escapes), and the sentences are quoted literally: editing one in the spec and the code has to
 * change this file too.
 */
import { describe, expect, it } from 'vitest';
import {
  DICTATION_IDLE, DICTATION_PHASES, HELPER_COMMANDS, HELPER_ERROR_CODES, MIC_BUTTON_TITLES, PILL_ESCAPE_HINT, PILL_LISTENING, PILL_MAX_CHARS,
  createDictationParser, dictationMessage, dictationReducer, dictationRefusal, endedWith, isActive, isAllowed, outcomeNotice, parseDictationLine,
  pillText, textToWrite, toggleRequest,
  type DictationAction, type DictationEvent, type DictationOutcome, type DictationPhase, type DictationRequest, type DictationState,
} from './dictation.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const ev = (event: DictationEvent): DictationAction => ({ type: 'event', event });
const run = (actions: DictationAction[], from: DictationState = DICTATION_IDLE): DictationState => actions.reduce(dictationReducer, from);

/** One state per phase. A `Record`, so a new phase fails to compile here until it has a sample. */
const SAMPLE: Record<DictationPhase, DictationState> = {
  idle: DICTATION_IDLE,
  starting: { phase: 'starting' },
  preparing: { phase: 'preparing' },
  recording: { phase: 'recording', partial: 'so far' },
  finalizing: { phase: 'finalizing', partial: 'so far' },
};
const ACTIVE = DICTATION_PHASES.filter((p) => p !== 'idle');

describe('the line parser', () => {
  it('parses a line split across three chunks once, when it completes', () => {
    const p = createDictationParser();
    const line = utf8('{"t":"partial","text":"hello there"}\n');
    expect(p.feed(line.subarray(0, 7))).toEqual([]);
    expect(p.feed(line.subarray(7, 20))).toEqual([]);
    expect(p.feed(line.subarray(20))).toEqual([{ t: 'partial', text: 'hello there' }]);
    expect(p.end()).toEqual([]);
  });

  it('returns every line a chunk completes, in order, and keeps the tail for the next call', () => {
    const p = createDictationParser();
    expect(p.feed(utf8('{"t":"preparing"}\n{"t":"ready"}\n{"t":"partial","te'))).toEqual([{ t: 'preparing' }, { t: 'ready' }]);
    expect(p.feed(utf8('xt":"hi"}\n'))).toEqual([{ t: 'partial', text: 'hi' }]);
  });

  it('skips junk between two valid lines rather than throwing', () => {
    const p = createDictationParser();
    const junk = ['not json', '[1,2]', '"a string"', 'null', '42', '{"t":', '[dictate] locale: en-GB'];
    expect(p.feed(utf8(['{"t":"ready"}', ...junk, '{"t":"partial","text":"ok"}', ''].join('\n'))))
      .toEqual([{ t: 'ready' }, { t: 'partial', text: 'ok' }]);
  });

  it('ignores an unknown `t`, and an object with no `t` at all', () => {
    const p = createDictationParser();
    expect(p.feed(utf8('{"t":"volume","level":3}\n{"text":"no t"}\n{"t":7}\n'))).toEqual([]);
    expect(parseDictationLine('{"t":"FINAL","text":"case matters"}')).toBeNull();
  });

  it('ignores a known `t` whose field is missing or of the wrong type', () => {
    for (const line of [
      '{"t":"partial"}', '{"t":"partial","text":5}', '{"t":"final","text":null}', '{"t":"final"}',
      '{"t":"error","code":"NO_INPUT"}', '{"t":"error","code":"NO_INPUT","message":1}',
      '{"t":"error","message":"no code"}', '{"t":"error","code":3,"message":"x"}',
      '{"t":"error","code":"BOGUS","message":"not one of the four"}',
    ]) {
      expect(parseDictationLine(line), line).toBeNull();
    }
  });

  it('accepts exactly the four error codes the helper emits', () => {
    expect(HELPER_ERROR_CODES).toEqual(['MIC_DENIED', 'NO_MODEL', 'NO_INPUT', 'FAILED']);
    for (const code of HELPER_ERROR_CODES) {
      expect(parseDictationLine(`{"t":"error","code":"${code}","message":"why"}`)).toEqual({ t: 'error', code, message: 'why' });
    }
  });

  it('ignores blank lines and tolerates CRLF', () => {
    const p = createDictationParser();
    expect(p.feed(utf8('\n\n{"t":"ready"}\r\n   \n\r\n'))).toEqual([{ t: 'ready' }]);
  });

  it('drops fields it does not know rather than refusing the line', () => {
    expect(parseDictationLine('{"t":"ready","since":12}')).toEqual({ t: 'ready' });
    expect(parseDictationLine('{"t":"final","text":"x","confidence":0.9}')).toEqual({ t: 'final', text: 'x' });
  });

  it('decodes the escapes the helper writes', () => {
    // main.swift escapes `"` `\` \n \r \t and every other control as \u00XX.
    expect(parseDictationLine(String.raw`{"t":"final","text":"say \"hi\"\\ \n\t\u001b"}`))
      .toEqual({ t: 'final', text: 'say "hi"\\ \n\t\u001b' });
  });

  it('delivers a multi-byte character split across chunks intact, at every split point', () => {
    const text = 'café 👋 naïve';
    const line = utf8(`{"t":"partial","text":"${text}"}\n`);
    const wave = line.indexOf(0xf0); // the emoji's four-byte sequence starts here
    // The premise: decoding a chunk on its own at this split WOULD corrupt it, so the test below is
    // exercising a real split and not a lucky boundary.
    expect(new TextDecoder().decode(line.subarray(0, wave + 2))).toContain('\ufffd');

    for (let i = 1; i < line.length; i++) {
      const p = createDictationParser();
      expect([...p.feed(line.subarray(0, i)), ...p.feed(line.subarray(i))], `split at byte ${i}`).toEqual([{ t: 'partial', text }]);
    }
    const byteAtATime = createDictationParser();
    expect(Array.from(line, (b) => byteAtATime.feed(Uint8Array.of(b))).flat()).toEqual([{ t: 'partial', text }]);
  });

  it('takes a Node Buffer, and keeps its own copy of the tail', () => {
    const p = createDictationParser();
    const chunk = Buffer.from('{"t":"ready"}\n{"t":"partial","text":"ab');
    expect(p.feed(chunk)).toEqual([{ t: 'ready' }]);
    chunk.fill(0x20); // the caller reusing its buffer must not reach the tail the parser is holding
    expect(p.feed(Buffer.from('c"}\n'))).toEqual([{ t: 'partial', text: 'abc' }]);
  });

  it('refuses a string, because a chunk decoded on its own has already lost a split character', () => {
    const p = createDictationParser();
    expect(() => p.feed('{"t":"ready"}\n' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('turns invalid UTF-8 into U+FFFD rather than throwing', () => {
    const p = createDictationParser();
    const bad = Uint8Array.from([...utf8('{"t":"partial","text":"a'), 0xff, ...utf8('b"}\n')]);
    expect(p.feed(bad)).toEqual([{ t: 'partial', text: 'a\ufffdb' }]);
  });

  it('end() parses a last line that arrived without its newline, once', () => {
    const p = createDictationParser();
    expect(p.feed(utf8('{"t":"final","text":"done"}'))).toEqual([]);
    expect(p.end()).toEqual([{ t: 'final', text: 'done' }]);
    expect(p.end()).toEqual([]);
  });

  it('end() ignores a last line that was cut off', () => {
    const p = createDictationParser();
    p.feed(utf8('{"t":"final","text":"do'));
    expect(p.end()).toEqual([]);
  });

  it('drops an unterminated line that outgrows the cap — its tail included — and then carries on', () => {
    const p = createDictationParser(16);
    expect(p.feed(utf8('x'.repeat(40)))).toEqual([]);
    // What follows up to the next newline is still the discarded line, even though on its own it
    // would be a perfectly good one.
    expect(p.feed(utf8('{"t":"ready"}\n{"t":"preparing"}\n'))).toEqual([{ t: 'preparing' }]);
    p.feed(utf8('y'.repeat(40)));
    expect(p.end()).toEqual([]);
    expect(p.feed(utf8('{"t":"ready"}\n'))).toEqual([{ t: 'ready' }]);
  });
});

describe('the helper commands', () => {
  it('are the two lines main.swift reads from stdin, newline-terminated', () => {
    expect(HELPER_COMMANDS).toEqual({ stop: 'stop\n', cancel: 'cancel\n' });
  });
});

describe('dictationMessage — spec §4, verbatim', () => {
  it('says each sentence of the error table exactly', () => {
    expect(dictationMessage('MIC_DENIED')).toBe('Microphone access is denied. System Settings → Privacy & Security → Microphone.');
    expect(dictationMessage('NO_MODEL')).toBe('Could not prepare the dictation model. Check your connection and try again.');
    expect(dictationMessage('NO_INPUT')).toBe('No audio from the microphone. Check the input device in System Settings → Sound.');
    expect(dictationMessage('NOTHING_HEARD')).toBe('Nothing heard.');
    expect(dictationMessage('NOT_BUILT')).toBe('Dictation is not built. Run npm run build:dictate.');
    expect(dictationMessage('CRASHED')).toBe('Dictation stopped unexpectedly.');
  });

  it('reads the helper failing on its own terms (FAILED) as the crash sentence, the one row that fits', () => {
    expect(dictationMessage('FAILED')).toBe('Dictation stopped unexpectedly.');
  });

  // The spec's last row ("No focused pane with a session — the button is disabled, with a tooltip
  // saying why") names the case and gives no words, so these two are Hangar's. Quoted here all the
  // same: they are the button's tooltip and ⌘D's toast, and both are asserted against this function.
  it('says why the mic cannot start: no running session, or another agent already dictating', () => {
    expect(dictationMessage('NOT_RUNNING')).toBe('Start the agent to dictate into it.');
    expect(dictationMessage('ELSEWHERE')).toBe('Already dictating into another agent. Stop that one first.');
  });

  // Hangar's own: the words went to the clipboard because a permission prompt was waiting.
  // Main refusing a start: its own message is for the log, and these are what the user reads.
  it('says a refused request in the table\'s words, and leaves every other code to the ordinary toast', () => {
    expect(dictationMessage('BUSY')).toBe('The last dictation is still finishing. Try again in a moment.');
    expect(dictationRefusal('DICTATION_BUSY')).toBe('The last dictation is still finishing. Try again in a moment.');
    expect(dictationRefusal('NOT_RUNNING')).toBe('Start the agent to dictate into it.');
    for (const code of ['HOST_DOWN', 'NOT_FOUND', 'INTERNAL', '']) expect(dictationRefusal(code), code).toBeNull();
  });

  it('says where the words went when they were copied instead of typed, and what to do with them', () => {
    expect(dictationMessage('COPIED')).toBe('The agent is waiting for an answer, so your dictation was copied instead of typed. Paste it with ⌘V when you\'re ready.');
  });
});

describe('the mic button and the pill — their words', () => {
  it('titles the button by phase, and offers a cancel wherever a press IS a cancel', () => {
    expect(MIC_BUTTON_TITLES).toEqual({
      idle: 'Dictate',
      starting: 'Starting dictation — press to cancel',
      preparing: 'Preparing the dictation model (first use only) — press to cancel',
      recording: 'Stop dictating',
      finalizing: 'Writing what was heard…',
    });
    // The title may only promise what a press does: "cancel" exactly where `toggleRequest` says so.
    for (const p of DICTATION_PHASES) expect([p, MIC_BUTTON_TITLES[p].includes('press to cancel')]).toEqual([p, toggleRequest(SAMPLE[p]) === 'cancel']);
  });

  it('shows the live partial, or "Listening…" before there is one', () => {
    expect(PILL_LISTENING).toBe('Listening…');
    expect(PILL_ESCAPE_HINT).toBe('Esc cancels');
    expect(pillText('')).toBe('Listening…');
    expect(pillText('   ')).toBe('Listening…');
    expect(pillText(' so far ')).toBe('so far');
  });

  it('keeps the NEWEST end of a long partial, cut on a code point', () => {
    expect(pillText('abcdefghij', 4)).toBe('…ghij');
    expect(pillText('abcd', 4)).toBe('abcd');
    // Emoji are two UTF-16 units each; the cut counts code points and never halves one (G85).
    expect(pillText('👋👋👋👋👋', 3)).toBe('…👋👋👋');
    // A unit pre-slice that lands inside a pair must not draw its orphaned half.
    const long = `x${'👋'.repeat(10)}`;
    expect(pillText(long, 3)).toBe('…👋👋👋');
    expect(pillText(`a${'b'.repeat(PILL_MAX_CHARS)}`)).toBe(`…${'b'.repeat(PILL_MAX_CHARS)}`);
  });
});

describe('outcomeNotice — what a finished run says', () => {
  it('says nothing for a write (the text at the prompt is the answer) or a cancel (the user did it)', () => {
    expect(outcomeNotice({ kind: 'write', text: 'hello' })).toBeNull();
    expect(outcomeNotice({ kind: 'cancelled' })).toBeNull();
  });

  it('says "Nothing heard." as information, not as an error', () => {
    expect(outcomeNotice({ kind: 'nothing', message: 'ignored' })).toEqual({ level: 'info', text: 'Nothing heard.' });
  });

  // The toast is the only thing that says the words are on the clipboard, and it lands while the
  // owner is reading a permission prompt — so it waits to be dismissed rather than timing out.
  it('says a copy as a sticky warning, from the table', () => {
    expect(outcomeNotice({ kind: 'copied', message: '<raw>' })).toEqual({ level: 'warn', text: dictationMessage('COPIED'), sticky: true });
  });

  it('says every error\'s own sentence, looked up by code', () => {
    for (const code of [...HELPER_ERROR_CODES, 'NOT_BUILT', 'CRASHED'] as const) {
      expect(outcomeNotice({ kind: 'error', code, message: dictationMessage(code) })).toEqual({ level: 'error', text: dictationMessage(code) });
    }
  });

  // The outcome crossed a process boundary. Its `message` is never what the user reads — the helper's
  // own diagnostic, or anything else riding along, must not reach the screen.
  it('never shows the message the outcome carries, only the table\'s sentence', () => {
    expect(outcomeNotice({ kind: 'error', code: 'MIC_DENIED', message: 'helper said: AVAudioSession -50' })).toEqual({ level: 'error', text: dictationMessage('MIC_DENIED') });
    expect(outcomeNotice({ kind: 'nothing', message: '<raw>' })?.text).toBe('Nothing heard.');
    // An unknown code (a newer main) is the crash sentence, not `undefined`.
    const unknown = { kind: 'error', code: 'SOMETHING_NEW', message: 'x' } as unknown as DictationOutcome;
    expect(outcomeNotice(unknown)).toEqual({ level: 'error', text: 'Dictation stopped unexpectedly.' });
  });
});

describe('the state machine', () => {
  it('runs idle → starting → preparing → recording → finalizing → idle, ending in text to write', () => {
    const steps: DictationAction[] = [
      { type: 'start' }, ev({ t: 'preparing' }), ev({ t: 'ready' }), ev({ t: 'partial', text: 'fix the' }),
      { type: 'stop' }, ev({ t: 'final', text: 'fix the login bug' }), { type: 'closed' },
    ];
    const seen: DictationState[] = [];
    steps.reduce((s, a) => { const next = dictationReducer(s, a); seen.push(next); return next; }, DICTATION_IDLE);
    expect(seen.map((s) => s.phase)).toEqual(['starting', 'preparing', 'recording', 'recording', 'finalizing', 'idle', 'idle']);
    expect(seen.at(-1)).toEqual({ phase: 'idle', outcome: { kind: 'write', text: 'fix the login bug' } });
  });

  it('goes straight from starting to recording when the model is already installed', () => {
    expect(run([{ type: 'start' }, ev({ t: 'ready' })])).toEqual({ phase: 'recording', partial: '' });
  });

  it('replaces the previous partial with each new one, while recording and while finalizing', () => {
    const recording = run([{ type: 'start' }, ev({ t: 'ready' }), ev({ t: 'partial', text: 'hel' }), ev({ t: 'partial', text: 'hello' })]);
    expect(recording).toEqual({ phase: 'recording', partial: 'hello' });
    const finalizing = run([{ type: 'stop' }, ev({ t: 'partial', text: 'hello there' })], recording);
    expect(finalizing).toEqual({ phase: 'finalizing', partial: 'hello there' });
  });

  it('drops a partial before `ready`, so it cannot make `stop` legal', () => {
    const s = run([{ type: 'start' }, ev({ t: 'preparing' }), ev({ t: 'partial', text: 'early' })]);
    expect(s).toEqual({ phase: 'preparing' });
    expect(isAllowed(s, 'stop')).toBe(false);
  });

  it('ends on an error arriving mid-recording, with its sentence and nothing to write', () => {
    const recording = run([{ type: 'start' }, ev({ t: 'ready' }), ev({ t: 'partial', text: 'half a sen' })]);
    const s = dictationReducer(recording, ev({ t: 'error', code: 'FAILED', message: 'The transcriber stopped: …' }));
    expect(s).toEqual({ phase: 'idle', outcome: { kind: 'error', code: 'FAILED', message: 'Dictation stopped unexpectedly.' } });
    expect(endedWith(recording, s)).toEqual({ kind: 'error', code: 'FAILED', message: 'Dictation stopped unexpectedly.' });
  });

  it('ends on an error in every phase the helper can send one from', () => {
    expect(run([{ type: 'start' }, ev({ t: 'error', code: 'MIC_DENIED', message: 'refused' })])).toEqual({
      phase: 'idle', outcome: { kind: 'error', code: 'MIC_DENIED', message: 'Microphone access is denied. System Settings → Privacy & Security → Microphone.' },
    });
    expect(run([{ type: 'start' }, ev({ t: 'preparing' }), ev({ t: 'error', code: 'NO_MODEL', message: 'offline' })])).toEqual({
      phase: 'idle', outcome: { kind: 'error', code: 'NO_MODEL', message: 'Could not prepare the dictation model. Check your connection and try again.' },
    });
    // A stop with no buffer ever analysed: the helper reports it at finalize.
    expect(run([{ type: 'start' }, ev({ t: 'ready' }), { type: 'stop' }, ev({ t: 'error', code: 'NO_INPUT', message: 'no buffer' })])).toEqual({
      phase: 'idle', outcome: { kind: 'error', code: 'NO_INPUT', message: 'No audio from the microphone. Check the input device in System Settings → Sound.' },
    });
  });

  it('refuses a stop during preparing in favour of cancel', () => {
    for (const s of [SAMPLE.starting, SAMPLE.preparing]) {
      expect(isAllowed(s, 'stop')).toBe(false);
      expect(dictationReducer(s, { type: 'stop' })).toBe(s);
      expect(toggleRequest(s)).toBe('cancel');
      expect(isAllowed(s, 'cancel')).toBe(true);
      expect(dictationReducer(s, { type: 'cancel' })).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
    }
  });

  it('treats the silent exit a cancel produces as a clean end', () => {
    for (const phase of ACTIVE) {
      const cancelled = dictationReducer(SAMPLE[phase], { type: 'cancel' });
      expect(cancelled, phase).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
      const closed = dictationReducer(cancelled, { type: 'closed' });
      expect(closed, phase).toBe(cancelled);
      expect(endedWith(cancelled, closed)).toBeNull();
    }
  });

  it('never writes a final that raced a cancel', () => {
    const cancelled = run([{ type: 'start' }, ev({ t: 'ready' }), { type: 'stop' }, { type: 'cancel' }]);
    const late = run([ev({ t: 'final', text: 'too late' }), { type: 'closed' }], cancelled);
    expect(late).toBe(cancelled);
    expect(late).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
  });

  it('reads a silent exit without a cancel as `Dictation stopped unexpectedly.`', () => {
    for (const phase of ACTIVE) {
      expect(dictationReducer(SAMPLE[phase], { type: 'closed' }), phase).toEqual({
        phase: 'idle', outcome: { kind: 'error', code: 'CRASHED', message: 'Dictation stopped unexpectedly.' },
      });
    }
  });

  it('reads a helper that is not there as an unbuilt checkout, not a crash', () => {
    expect(run([{ type: 'start' }, { type: 'closed', helperMissing: true }])).toEqual({
      phase: 'idle', outcome: { kind: 'error', code: 'NOT_BUILT', message: 'Dictation is not built. Run npm run build:dictate.' },
    });
  });

  it('reads an empty and a whitespace-only final both as `Nothing heard.`, with nothing to write', () => {
    for (const text of ['', '   ', ' \n\t\r ']) {
      expect(dictationReducer(SAMPLE.finalizing, ev({ t: 'final', text })), JSON.stringify(text)).toEqual({
        phase: 'idle', outcome: { kind: 'nothing', message: 'Nothing heard.' },
      });
    }
  });

  it('accepts the final the helper sends by itself at its own 120 s cap, while still recording', () => {
    expect(dictationReducer(SAMPLE.recording, ev({ t: 'final', text: 'a long thought' })))
      .toEqual({ phase: 'idle', outcome: { kind: 'write', text: 'a long thought' } });
  });

  it('cancels from finalizing, dropping the transcript on its way in', () => {
    expect(dictationReducer(SAMPLE.finalizing, { type: 'stop' })).toBe(SAMPLE.finalizing);
    expect(toggleRequest(SAMPLE.finalizing)).toBeNull();
    expect(dictationReducer(SAMPLE.finalizing, { type: 'cancel' })).toEqual({ phase: 'idle', outcome: { kind: 'cancelled' } });
  });

  it('ignores a repeated ready or preparing', () => {
    expect(dictationReducer(SAMPLE.recording, ev({ t: 'ready' }))).toBe(SAMPLE.recording);
    expect(dictationReducer(SAMPLE.recording, ev({ t: 'preparing' }))).toBe(SAMPLE.recording);
    expect(dictationReducer(SAMPLE.preparing, ev({ t: 'preparing' }))).toBe(SAMPLE.preparing);
    expect(dictationReducer(SAMPLE.finalizing, ev({ t: 'ready' }))).toBe(SAMPLE.finalizing);
  });

  it('ignores everything after the end of a run until the next start', () => {
    const done: DictationState = { phase: 'idle', outcome: { kind: 'write', text: 'once' } };
    const after: DictationAction[] = [
      ev({ t: 'ready' }), ev({ t: 'preparing' }), ev({ t: 'partial', text: 'x' }), ev({ t: 'final', text: 'twice' }),
      ev({ t: 'error', code: 'FAILED', message: 'x' }), { type: 'stop' }, { type: 'cancel' }, { type: 'closed' },
      { type: 'closed', helperMissing: true },
    ];
    for (const a of after) expect(dictationReducer(done, a), JSON.stringify(a)).toBe(done);
  });

  it('clears the last outcome on a new start, and refuses a start while a run is active', () => {
    const last: DictationState = { phase: 'idle', outcome: { kind: 'nothing', message: 'Nothing heard.' } };
    expect(toggleRequest(last)).toBe('start');
    expect(dictationReducer(last, { type: 'start' })).toEqual({ phase: 'starting' });
    for (const phase of ACTIVE) expect(dictationReducer(SAMPLE[phase], { type: 'start' }), phase).toBe(SAMPLE[phase]);
  });

  it('reports the outcome of a run exactly once', () => {
    const steps: DictationAction[] = [
      { type: 'start' }, ev({ t: 'ready' }), { type: 'stop' }, ev({ t: 'final', text: 'hello' }),
      ev({ t: 'final', text: 'hello again' }), { type: 'closed' }, { type: 'cancel' },
    ];
    const outcomes: DictationOutcome[] = [];
    let s = DICTATION_IDLE;
    for (const a of steps) {
      const next = dictationReducer(s, a);
      const outcome = endedWith(s, next);
      if (outcome) outcomes.push(outcome);
      s = next;
    }
    expect(outcomes).toEqual([{ kind: 'write', text: 'hello' }]);
  });
});

describe('which requests each phase allows', () => {
  it('lets `stop` in only once recording, `cancel` in every active phase, and `start` only when idle', () => {
    const table = Object.fromEntries(DICTATION_PHASES.map((p) => [p, (['start', 'stop', 'cancel'] as const).filter((r) => isAllowed(SAMPLE[p], r))]));
    expect(table).toEqual({
      idle: ['start'],
      starting: ['cancel'],
      preparing: ['cancel'],
      recording: ['stop', 'cancel'],
      finalizing: ['cancel'],
    });
    for (const p of DICTATION_PHASES) expect(isActive(SAMPLE[p]), p).toBe(p !== 'idle');
  });

  it('changes state on a request exactly when the table allows it', () => {
    for (const p of DICTATION_PHASES) {
      for (const r of ['start', 'stop', 'cancel'] as const) {
        expect(dictationReducer(SAMPLE[p], { type: r }) !== SAMPLE[p], `${r} in ${p}`).toBe(isAllowed(SAMPLE[p], r));
      }
    }
  });

  it('makes the mic button ask for something the phase allows, or nothing', () => {
    const asks: Record<DictationPhase, DictationRequest | null> = {
      idle: 'start', starting: 'cancel', preparing: 'cancel', recording: 'stop', finalizing: null,
    };
    for (const p of DICTATION_PHASES) {
      const r = toggleRequest(SAMPLE[p]);
      expect(r, p).toBe(asks[p]);
      if (r) expect(isAllowed(SAMPLE[p], r), p).toBe(true);
    }
  });
});

describe('the text a final writes', () => {
  it('keeps the words exactly, accents and emoji included', () => {
    expect(textToWrite('Café, naïve — 👋 done.')).toBe('Café, naïve — 👋 done.');
  });

  it('can never submit or drive the prompt: controls become spaces, whitespace collapses, ends trim', () => {
    expect(textToWrite('fix the bug\r')).toBe('fix the bug');
    expect(textToWrite('one\ntwo\r\nthree')).toBe('one two three');
    const written = textToWrite('\u001b[2J\u0003hi\u0015\u009b there\u007f');
    expect(written).toBe('[2J hi there');
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('writes nothing for a final that is only controls and spaces', () => {
    expect(textToWrite('\r\n\u0003 \t')).toBe('');
    expect(dictationReducer(SAMPLE.finalizing, ev({ t: 'final', text: '\r\n\u0003' }))).toEqual({
      phase: 'idle', outcome: { kind: 'nothing', message: 'Nothing heard.' },
    });
  });
});

describe('the parser and the machine together, as main drives them', () => {
  it('turns a real helper transcript, chunked anywhere, into one write', () => {
    const stdout = utf8([
      '{"t":"preparing"}', '{"t":"ready"}', '{"t":"partial","text":"Ship"}', '{"t":"partial","text":"Ship the café"}',
      '{"t":"partial","text":"Ship the café fix"}', '{"t":"final","text":"Ship the café fix."}', '',
    ].join('\n'));
    for (const size of [1, 3, 17, 64, stdout.length]) {
      const p = createDictationParser();
      let s = dictationReducer(DICTATION_IDLE, { type: 'start' });
      const outcomes: DictationOutcome[] = [];
      const dispatch = (a: DictationAction): void => {
        const next = dictationReducer(s, a);
        const o = endedWith(s, next);
        if (o) outcomes.push(o);
        s = next;
      };
      for (let i = 0; i < stdout.length; i += size) {
        for (const e of p.feed(stdout.subarray(i, i + size))) {
          dispatch(ev(e));
          // Main sends `stop` the moment the machine allows it and the user has said their piece.
          if (s.phase === 'recording' && s.partial === 'Ship the café fix') dispatch({ type: 'stop' });
        }
      }
      for (const e of p.end()) dispatch(ev(e));
      dispatch({ type: 'closed' });
      expect(outcomes, `chunks of ${size}`).toEqual([{ kind: 'write', text: 'Ship the café fix.' }]);
    }
  });
});
