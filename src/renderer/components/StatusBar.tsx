import { useEffect, useRef, useState } from 'react';
import { DISK_BANNER_ID, INITIAL_DISK_BANNER, LOW_DISK_WARN, diskBannerStep, formatFreeGb } from '../../../shared/disk.ts';
import type { HostStatus, Id, SessionState } from '../../../shared/types.ts';
import { isRunning } from '../lib/agent-actions.ts';
import { run } from '../lib/api.ts';
import { useSessions } from '../stores/sessions.ts';
import { useUi } from '../stores/ui.ts';
import { useWorkspace } from '../stores/workspace.ts';

/**
 * Spec §12.8's strip: `host: connected · 5 sessions · node v24.15.0 · 9.1 GB free`, clicking opens
 * the host panel.
 *
 * The helpers below are exported and tested as pure functions because the component itself is only
 * allowed to be a thin wrapper around them — see the G59/G61 note on the store reads. The free-space
 * figure adds the one piece of state this component owns; its decisions live in `shared/disk.ts`.
 */

export interface SessionCounts {
  running: number;
  attention: number;
}

/**
 * G61 is why this is a plain function and not a selector: counting means DERIVING, and a selector
 * that derives allocates a fresh value on every call, which zustand 5 hands to
 * `useSyncExternalStore` as a new snapshot and re-renders forever. `Object.values(s.sessions)
 * .filter(...).length` — the obvious spelling — is that loop even though it ends in a number,
 * because `Object.values` and `.filter` both allocate before `.length` reads it. Called from the
 * render body instead, where allocating costs nothing.
 *
 * `s === undefined` first: the record mirrors `WorkspaceSnapshot['sessions']`, whose values are
 * `SessionState | undefined` (absent = stopped, §6.5), so an unguarded `s.activity` is a TS18048.
 *
 * `attention` is deliberately not gated on `isRunning`: an agent that exited with an unread
 * attention event is exactly something the user has not seen yet, and the badge in the sidebar
 * counts it the same way.
 */
export function sessionCounts(sessions: Record<Id, SessionState | undefined>): SessionCounts {
  let running = 0;
  let attention = 0;
  for (const s of Object.values(sessions)) {
    if (s === undefined) continue;
    if (isRunning(s)) running += 1;
    if (s.activity === 'needs-permission' || s.unread) attention += 1;
  }
  return { running, attention };
}

export interface HostLabel {
  text: string;
  dot: 'green' | 'amber' | 'red';
  /** `lastError`, when there is one — the button's tooltip and nothing else; the panel shows it in full. */
  detail: string | null;
}

/**
 * Four reachable host states, not the three the plan drew.
 *
 * `connected: true` WITH a `lastError` is the protocol-mismatch case in `src/main/index.ts`:
 * `hostClient.on('connected')` sets `connected: true, lastError: null`, and then the
 * `checkProtocolVersion` verdict writes `lastError` back while the socket stays up — the app is
 * connected to a host it may not drive (§8.3 step 4). The plan's `host.connected ? 'connected' :
 * …` painted that green and said "connected", hiding the one state the spec calls out by name
 * ("host disconnected/outdated", §12.7). `bootstrap.ts` raises the matching banner.
 */
export function hostLabel(host: HostStatus): HostLabel {
  if (host.connected) return host.lastError === null ? { text: 'connected', dot: 'green', detail: null } : { text: 'outdated', dot: 'amber', detail: host.lastError };
  if (host.lastError !== null) return { text: 'failed', dot: 'red', detail: host.lastError };
  // No retry clock: `HostStatus` carries no next-attempt time. host-client reconnects on its own
  // 200 ms floor and only ever reports the two booleans, so "connecting…" is the whole truth
  // available here — inventing a countdown would be inventing data.
  return { text: 'connecting…', dot: 'amber', detail: null };
}

const VERSION_SEGMENT = /^v\d+(\.\d+)*$/;

/**
 * The version to show for a node BINARY PATH — there is no version field in `HostStatus`, only the
 * path main resolved with `pickNodeBin`.
 *
 * The plan took `split('/').slice(-3, -2)[0]`, which is right for the nvm/fnm/asdf shape it had in
 * mind (`…/versions/node/v24.15.0/bin/node` -> `v24.15.0`) and wrong for every other one it meets:
 * `/opt/homebrew/bin/node` renders as "node: homebrew" and `/usr/local/bin/node` as "node: local",
 * neither of which is a version. Matching the segment instead means a version is shown when the
 * path contains one and the honest path is shown when it does not.
 */
export function nodeLabel(nodeBin: string | null): string | null {
  if (nodeBin === null || nodeBin === '') return null;
  return nodeBin.split('/').find((seg) => VERSION_SEGMENT.test(seg)) ?? nodeBin;
}

/**
 * §12.8's free-space figure is measured once a minute, not on every snapshot broadcast — see the
 * `app:diskFree` handler for why it is a request rather than a field on `WorkspaceSnapshot`.
 */
const DISK_POLL_MS = 60_000;

interface DiskFree {
  freeBytes: number;
  path: string;
}

/**
 * The strip's free-space figure, and the writer behind §12.7's low-disk banner.
 *
 * **Cadence.** The timer lives and dies with this component AND with the window's visibility, which
 * are two different "nothing is watching". The mount half is the Diff tab's lesson (Plan 04 Task 5):
 * a `setInterval` with no `clearInterval` cleanup keeps calling main from a torn-down component for
 * as long as the app is open. The visibility half is the one that actually bites here, because —
 * unlike the Diff tab — `StatusBar` is mounted for the whole life of the window, so the cleanup
 * alone would be a guard that never runs outside its own test. `document.visibilityState` gating is
 * measured by the tests below only in jsdom, where the test drives the property and the event
 * directly; what Chromium does with an Electron window that is merely BEHIND another app (rather
 * than minimised or occluded) is not measured here, so this is a floor on the saving, not a claim
 * about it. Coming back to visible re-polls immediately, so the figure is never stale on return.
 *
 * **`live`.** A reply can land after unmount — the interval is cleared, the in-flight promise is
 * not — and writing a banner from a torn-down component is a state change nobody owns. `run`'s
 * error sink is silenced with a no-op `onError`: a poll that fails every 60 s must not become a
 * toast every 60 s, and the figure simply stops updating.
 *
 * **Store reads go through `getState()`**, not a selector: this component must not re-render when
 * an unrelated banner appears, and reading at call time is also what makes the dismissal probe see
 * the CURRENT banner list rather than one captured when the effect was set up.
 */
function useDiskFree(): DiskFree | null {
  const [disk, setDisk] = useState<DiskFree | null>(null);
  const banner = useRef(INITIAL_DISK_BANNER);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async (): Promise<void> => {
      const r = await run('app:diskFree', undefined, () => undefined);
      if (!live || r === null) return;
      setDisk(r);
      const ui = useUi.getState();
      const step = diskBannerStep(banner.current, r.freeBytes, ui.banners.some((b) => b.id === DISK_BANNER_ID));
      banner.current = step.state;
      if (step.effect.kind === 'raise') ui.setBanner({ id: DISK_BANNER_ID, level: 'warn', text: step.effect.text });
      else if (step.effect.kind === 'clear') ui.clearBanner(DISK_BANNER_ID);
    };
    const start = (): void => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => void poll(), DISK_POLL_MS);
    };
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return disk;
}

const DOT = { green: 'bg-green', amber: 'bg-amber', red: 'bg-red' } as const;

export function StatusBar() {
  // Every selector returns a STORED reference (or a function), never a derived value: zustand 5
  // re-runs these after each commit and commits again when the identity differs (G59, measured on
  // this project at ~55 renders then "Maximum update depth exceeded"). The counting happens below,
  // after the subscription. No `?? []` either — the nullish path of one of those allocates and is
  // a loop that only appears before bootstrap answers (G61).
  const snapshot = useWorkspace((s) => s.snapshot);
  const sessions = useSessions((s) => s.sessions);
  const openDialog = useUi((s) => s.openDialog);
  // Before the early return below, because hooks may not be conditional — and because the banner
  // is worth raising even while the app is still waiting for its first snapshot.
  const disk = useDiskFree();
  // `h-6` on both branches, so the pane grid does not resize under the user when the first
  // snapshot lands. Computed from the emitted CSS rather than assumed: `.h-6` is
  // `calc(var(--spacing) * 6)` with `--spacing: .25rem`, and `theme.css` puts `font-size: 13px` on
  // `html`, so the strip is 1.5rem = 19.5px — NOT the 24px the same class means in a 16px document.
  // It holds `text-[11px]` (font-size only; the rule emits no line-height) and an `h-2` dot, so
  // nothing in it needs more.
  //
  // No `no-drag` on anything here: nothing in this subtree has a `drag-region` ancestor (App puts
  // that class on the pane column's title bar only), and `Button`/`IconButton` carry `no-drag` in
  // their own base classes regardless — an unreachable guard is worse than none.
  if (snapshot === null) return <div className="h-6 shrink-0 border-t border-line bg-bg-1" />;
  const { running, attention } = sessionCounts(sessions);
  const host = hostLabel(snapshot.host);
  const node = nodeLabel(snapshot.host.nodeBin);
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-bg-1 px-3 text-[11px] text-muted">
      <button type="button" className="flex items-center gap-1.5 hover:text-fg" onClick={() => openDialog({ kind: 'host-panel' })} title={host.detail ?? 'Session host details'}>
        <span className={`inline-block h-2 w-2 rounded-full ${DOT[host.dot]}`} />
        host: {host.text}
      </button>
      <span>
        {running} running{attention > 0 ? ` · ${attention} need attention` : ''}
      </span>
      {node === null ? null : <span className="truncate" title={snapshot.host.nodeBin ?? ''}>node: {node}</span>}
      {/* Amber at the same edge the banner uses, so the two cannot disagree about what "low" means.
          `title` names the measured directory: every path on a one-volume machine reports the same
          number, and this is the only place that says which one it is. */}
      {disk === null ? null : <span className={disk.freeBytes < LOW_DISK_WARN ? 'shrink-0 text-amber' : 'shrink-0'} title={`Free space on the volume holding ${disk.path}`}>{formatFreeGb(disk.freeBytes)} free</span>}
      {/* The profile only earns a slot when it is NOT the default one — which is precisely when
          knowing about it matters, because `npm run dev` runs against `~/.hangar-dev` and looks
          otherwise identical to the real app. */}
      <span className="ml-auto truncate" title={snapshot.profile.home}>{snapshot.profile.isDefault ? '' : `profile: ${snapshot.profile.home}`}</span>
    </div>
  );
}
