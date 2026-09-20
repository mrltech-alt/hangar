// Session activity reducer — spec §11.5. Pure; main and renderer both run it.
import type { Activity, SessionState } from './types.ts';

export const HOOK_NAMES = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export function isHookName(x: unknown): x is HookName {
  return typeof x === 'string' && (HOOK_NAMES as readonly string[]).includes(x);
}

export type SessionEvent =
  | { kind: 'spawned'; pid: number; at: number }
  | { kind: 'output'; at: number }
  | { kind: 'title'; title: string }
  | { kind: 'bell'; at: number }
  | { kind: 'hook'; name: HookName; notificationType?: string; message?: string; at: number }
  | { kind: 'exit'; exitCode: number; at: number }
  | { kind: 'attached'; paneIndex: number }
  | { kind: 'detached' }
  | { kind: 'viewed' }
  | { kind: 'tick'; at: number };

export interface ReduceContext {
  windowFocused: boolean;
}

/** With no hook signal, "working" decays to "idle" after this much silence. */
export const IDLE_AFTER_MS = 3_000;

export function isPermissionNotification(ev: { notificationType?: string; message?: string }): boolean {
  return ev.notificationType === 'permission_prompt' || /permission/i.test(ev.message ?? '');
}

const TERMINAL: readonly Activity[] = ['exited', 'stopped'];

export function reduceSession(state: SessionState, ev: SessionEvent, ctx: ReduceContext = { windowFocused: true }): SessionState {
  // An attention event is "unread" unless the user is looking at this session right now.
  const flag = (s: SessionState): boolean => s.unread || s.attachedPane === null || !ctx.windowFocused;

  switch (ev.kind) {
    case 'spawned':
      return { ...state, activity: 'starting', pid: ev.pid, exitCode: null, hooksSeen: false, unread: false, lastOutputAt: null, lastHookAt: null };

    case 'hook': {
      // A hook that arrives AFTER the PTY exited must not resurrect the session. Hook events come
      // via a separately-spawned `bin/hangar` process (node startup, socket connect, up to a 300 ms
      // wait) while `exit` arrives instantly on the host's own channel, so a `Stop` or `SessionEnd`
      // landing late is ordinary, not exotic. Without this guard the state reads `activity: 'shell'`
      // with an exit code still set, `isRunning()` says true, the exit card is hidden, and every
      // restart option in the menus is disabled — a dead PTY the user cannot restart.
      //
      // Guarded on `exited` alone, NOT the whole TERMINAL set: `stopped` means "we have not learned
      // about this session yet", where a hook is real signal worth keeping. Restart is unaffected —
      // it goes through `spawned`, which clears `exitCode` and `hooksSeen` unconditionally.
      if (state.activity === 'exited') return state;
      const base: SessionState = { ...state, hooksSeen: true, lastHookAt: ev.at };
      switch (ev.name) {
        case 'SessionStart':
          return { ...base, activity: 'idle' };
        case 'UserPromptSubmit':
          return { ...base, activity: 'working' };
        case 'Stop':
        case 'StopFailure':
          return { ...base, activity: 'waiting', unread: flag(state) };
        case 'Notification':
          return { ...base, activity: isPermissionNotification(ev) ? 'needs-permission' : 'waiting', unread: flag(state) };
        case 'SessionEnd':
          return { ...base, activity: 'shell' };
      }
      // No trailing `return base`: without it, adding a seventh name to HOOK_NAMES is a compile
      // error here. With it, the new hook would be wired into settings.json, relayed by the CLI and
      // accepted by isHookName — and then silently do nothing. Fully plumbed and inert is the worst
      // failure shape.
    }

    case 'bell': {
      if (TERMINAL.includes(state.activity)) return state;
      return state.hooksSeen ? { ...state, unread: flag(state) } : { ...state, unread: flag(state), activity: 'waiting' };
    }

    case 'exit':
      return { ...state, activity: 'exited', exitCode: ev.exitCode, pid: null };

    case 'output': {
      if (TERMINAL.includes(state.activity)) return { ...state, lastOutputAt: ev.at };
      if (!state.hooksSeen) return { ...state, lastOutputAt: ev.at, activity: 'working' };
      return { ...state, lastOutputAt: ev.at, activity: state.activity === 'starting' ? 'idle' : state.activity };
    }

    case 'tick': {
      if (!state.hooksSeen && state.activity === 'working' && state.lastOutputAt !== null && ev.at - state.lastOutputAt > IDLE_AFTER_MS) {
        return { ...state, activity: 'idle' };
      }
      return state;
    }

    case 'title':
      return { ...state, title: ev.title };
    case 'attached':
      return { ...state, attachedPane: ev.paneIndex, unread: false };
    case 'detached':
      return { ...state, attachedPane: null };
    case 'viewed':
      return { ...state, unread: false };
  }
}

export interface StatusVisual {
  label: string;
  color: 'green' | 'amber' | 'blue' | 'grey' | 'red';
  pulse: boolean;
  hollow: boolean;
  badge: '!' | null;
}

export function statusVisual(activity: Activity): StatusVisual {
  switch (activity) {
    case 'working':
      return { label: 'Working', color: 'green', pulse: true, hollow: false, badge: null };
    case 'needs-permission':
      return { label: 'Needs permission', color: 'amber', pulse: false, hollow: false, badge: '!' };
    case 'waiting':
      return { label: 'Waiting for you', color: 'blue', pulse: false, hollow: false, badge: null };
    case 'idle':
      return { label: 'Idle', color: 'grey', pulse: false, hollow: false, badge: null };
    case 'shell':
      return { label: 'Shell (claude exited)', color: 'grey', pulse: false, hollow: false, badge: null };
    case 'starting':
      return { label: 'Starting', color: 'grey', pulse: true, hollow: false, badge: null };
    case 'stopped':
      return { label: 'Stopped', color: 'grey', pulse: false, hollow: true, badge: null };
    case 'exited':
      return { label: 'Exited', color: 'red', pulse: false, hollow: true, badge: null };
  }
}
