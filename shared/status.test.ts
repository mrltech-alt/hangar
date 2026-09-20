import { describe, expect, it } from 'vitest';
import { initialSessionState } from './types.ts';
import { IDLE_AFTER_MS, isHookName, isPermissionNotification, reduceSession, statusVisual, type SessionEvent } from './status.ts';

const T0 = 1_000_000;
const focused = { windowFocused: true };
const unfocused = { windowFocused: false };
const spawned = (): ReturnType<typeof reduceSession> => reduceSession(initialSessionState('a'), { kind: 'spawned', pid: 42, at: T0 });
// `Extract`, not a bare conditional: `SessionEvent` is a concrete union, so
// `SessionEvent extends {kind:'hook'} ? … : never` does NOT distribute — it resolves to `never`
// and every call below fails to typecheck.
const hook = (name: Extract<SessionEvent, { kind: 'hook' }>['name'], extra: Partial<{ notificationType: string; message: string }> = {}): SessionEvent =>
  ({ kind: 'hook', name, at: T0 + 10, ...extra }) as SessionEvent;

describe('reduceSession', () => {
  it('spawned → starting with pid and cleared flags', () => {
    const s = spawned();
    expect(s).toMatchObject({ activity: 'starting', pid: 42, hooksSeen: false, unread: false, exitCode: null });
  });

  it('hooks drive activity and mark hooksSeen', () => {
    let s = spawned();
    s = reduceSession(s, hook('SessionStart'));
    expect(s).toMatchObject({ activity: 'idle', hooksSeen: true, lastHookAt: T0 + 10 });
    s = reduceSession(s, hook('UserPromptSubmit'));
    expect(s.activity).toBe('working');
    s = reduceSession(s, hook('Stop'));
    expect(s.activity).toBe('waiting');
    s = reduceSession(s, hook('Notification', { notificationType: 'permission_prompt' }));
    expect(s.activity).toBe('needs-permission');
    s = reduceSession(s, hook('Notification', { message: 'Claude needs your permission to run Bash' }));
    expect(s.activity).toBe('needs-permission');
    s = reduceSession(s, hook('Notification', { message: 'Claude is waiting for your input' }));
    expect(s.activity).toBe('waiting');
    s = reduceSession(s, hook('StopFailure'));
    expect(s.activity).toBe('waiting');
    s = reduceSession(s, hook('SessionEnd'));
    expect(s.activity).toBe('shell');
  });

  it('unread is set by attention events only when not attached or window unfocused', () => {
    const detached = spawned();
    expect(reduceSession(detached, hook('Stop')).unread).toBe(true);
    const attached = reduceSession(detached, { kind: 'attached', paneIndex: 0 });
    expect(reduceSession(attached, hook('Stop'), focused).unread).toBe(false);
    expect(reduceSession(attached, hook('Stop'), unfocused).unread).toBe(true);
    expect(reduceSession(attached, hook('UserPromptSubmit'), unfocused).unread).toBe(false);
    const flagged = reduceSession(attached, hook('Stop'), unfocused);
    expect(reduceSession(flagged, { kind: 'viewed' }).unread).toBe(false);
    expect(reduceSession(flagged, { kind: 'attached', paneIndex: 1 }).unread).toBe(false);
  });

  it('output heuristic applies only until the first hook is seen', () => {
    let s = spawned();
    s = reduceSession(s, { kind: 'output', at: T0 + 100 });
    expect(s).toMatchObject({ activity: 'working', lastOutputAt: T0 + 100 });
    s = reduceSession(s, { kind: 'tick', at: T0 + 100 + IDLE_AFTER_MS + 1 });
    expect(s.activity).toBe('idle');
    s = reduceSession(s, hook('UserPromptSubmit'));
    s = reduceSession(s, { kind: 'output', at: T0 + 5000 });
    expect(s.activity).toBe('working');
    s = reduceSession(s, { kind: 'tick', at: T0 + 50_000 });
    expect(s.activity).toBe('working'); // hooks seen → no idle heuristic
  });

  it('output after SessionStart moves starting → idle without claiming work', () => {
    let s = spawned();
    s = reduceSession(s, hook('SessionStart'));
    s = reduceSession(s, { kind: 'output', at: T0 + 1 });
    expect(s.activity).toBe('idle');
  });

  it('bell marks unread and, without hooks, means waiting', () => {
    const s = reduceSession(spawned(), { kind: 'bell', at: T0 + 5 });
    expect(s).toMatchObject({ activity: 'waiting', unread: true });
    const withHooks = reduceSession(reduceSession(spawned(), hook('UserPromptSubmit')), { kind: 'bell', at: T0 + 6 });
    expect(withHooks).toMatchObject({ activity: 'working', unread: true });
  });

  it('exit → exited with code; later output does not resurrect it', () => {
    let s = reduceSession(spawned(), { kind: 'exit', exitCode: 130, at: T0 + 9 });
    expect(s).toMatchObject({ activity: 'exited', exitCode: 130, pid: null });
    s = reduceSession(s, { kind: 'output', at: T0 + 10 });
    expect(s.activity).toBe('exited');
  });

  it('title, attached and detached update their fields', () => {
    let s = reduceSession(spawned(), { kind: 'title', title: '✳ Fixing hooks' });
    expect(s.title).toBe('✳ Fixing hooks');
    s = reduceSession(s, { kind: 'attached', paneIndex: 2 });
    expect(s.attachedPane).toBe(2);
    s = reduceSession(s, { kind: 'detached' });
    expect(s.attachedPane).toBeNull();
  });
});

describe('statusVisual', () => {
  it('maps every activity', () => {
    expect(statusVisual('working')).toEqual({ label: 'Working', color: 'green', pulse: true, hollow: false, badge: null });
    expect(statusVisual('needs-permission')).toEqual({ label: 'Needs permission', color: 'amber', pulse: false, hollow: false, badge: '!' });
    expect(statusVisual('waiting')).toEqual({ label: 'Waiting for you', color: 'blue', pulse: false, hollow: false, badge: null });
    expect(statusVisual('idle')).toEqual({ label: 'Idle', color: 'grey', pulse: false, hollow: false, badge: null });
    expect(statusVisual('shell')).toEqual({ label: 'Shell (claude exited)', color: 'grey', pulse: false, hollow: false, badge: null });
    expect(statusVisual('starting')).toEqual({ label: 'Starting', color: 'grey', pulse: true, hollow: false, badge: null });
    expect(statusVisual('stopped')).toEqual({ label: 'Stopped', color: 'grey', pulse: false, hollow: true, badge: null });
    expect(statusVisual('exited')).toEqual({ label: 'Exited', color: 'red', pulse: false, hollow: true, badge: null });
  });
});

describe('isHookName', () => {
  it('accepts only the six wired hook names', () => {
    expect(isHookName('Stop')).toBe(true);
    expect(isHookName('PreToolUse')).toBe(false);
    expect(isHookName(42)).toBe(false);
  });
  // Task 15's tick() loop is `if (next !== state)`, over every session every second. A refactor to
  // `return { ...state }` would emit a full SessionState per agent per second and no other test
  // here or in session-registry.test.ts would notice.
  it('returns the SAME object when nothing changed, not a copy', () => {
    const s = reduceSession(spawned(), hook('SessionStart'), focused);
    expect(reduceSession(s, { kind: 'tick', at: T0 + 20 }, focused)).toBe(s);
    const dead = reduceSession(s, { kind: 'exit', exitCode: 0, at: T0 + 30 }, focused);
    expect(reduceSession(dead, { kind: 'bell', at: T0 + 40 }, focused)).toBe(dead);
  });

  // The TERMINAL guard's whole reason for existing was unasserted, so a refactor could delete it
  // invisibly. A late hook is the sharp case: it used to flip `exited` -> `shell`, which makes
  // isRunning() true, hides the exit card and disables every restart option in the UI.
  it('ignores events that arrive on a session that has already exited', () => {
    const dead = reduceSession(reduceSession(initialSessionState('a'), { kind: 'spawned', pid: 1, at: T0 }, focused),
      { kind: 'exit', exitCode: 3, at: T0 + 10 }, focused);
    expect(dead).toMatchObject({ activity: 'exited', exitCode: 3 });
    for (const ev of [hook('SessionEnd'), hook('Stop'), { kind: 'bell', at: T0 + 20 } as SessionEvent, { kind: 'output', at: T0 + 20 } as SessionEvent]) {
      expect(reduceSession(dead, ev, focused).activity, `${ev.kind} after exit`).toBe('exited');
    }
    // ...but a restart clears it, so the guard cannot wedge a session.
    expect(reduceSession(dead, { kind: 'spawned', pid: 9, at: T0 + 30 }, focused)).toMatchObject({ activity: 'starting', exitCode: null });
  });

  // Pre-spawn is the other half of the guard: output/bell arriving before we know the session
  // exists must not invent an activity. `output` still records lastOutputAt (harmless, and it is
  // what the idle heuristic reads once the session does start), so only `bell` is identity.
  it('does not invent an activity from output or bell before anything has spawned', () => {
    const s = initialSessionState('a');
    expect(reduceSession(s, { kind: 'output', at: T0 }, focused)).toMatchObject({ activity: 'stopped', lastOutputAt: T0 });
    expect(reduceSession(s, { kind: 'bell', at: T0 }, focused)).toBe(s);
  });

  // Both main and the renderer run this over objects the registry keeps for diffing.
  it('never mutates the state it is given', () => {
    const frozen = Object.freeze(reduceSession(spawned(), hook('SessionStart'), focused));
    const events: SessionEvent[] = [
      { kind: 'spawned', pid: 2, at: T0 }, hook('Stop'), { kind: 'bell', at: T0 },
      { kind: 'output', at: T0 }, { kind: 'tick', at: T0 + 99_999 },
      { kind: 'exit', exitCode: 1, at: T0 }, { kind: 'viewed' }, { kind: 'attached', paneIndex: 0 },
    ];
    for (const ev of events) expect(() => reduceSession(frozen, ev, unfocused), ev.kind).not.toThrow();
  });
});

// §23 item 2 is resolved: Claude Code's Notification stdin really does carry `notification_type`,
// `permission_prompt` is one of its values, and `idle_prompt` is the common non-permission case.
// The message regex stays as a fallback for versions that omit the field.
describe('isPermissionNotification', () => {
  it('prefers the type field, falls back to the message, and defaults to false', () => {
    expect(isPermissionNotification({ notificationType: 'permission_prompt' })).toBe(true);
    expect(isPermissionNotification({ notificationType: 'idle_prompt' })).toBe(false);
    expect(isPermissionNotification({ message: 'Claude needs your Permission to run Bash' })).toBe(true);
    expect(isPermissionNotification({ message: 'Claude is waiting for your input' })).toBe(false);
    expect(isPermissionNotification({})).toBe(false);
  });
});
