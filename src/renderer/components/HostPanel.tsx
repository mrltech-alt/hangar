import { useRef, useState } from 'react';
import { copyText } from '../lib/agent-actions.ts';
import { runResult } from '../lib/api.ts';
import { useSessions } from '../stores/sessions.ts';
import { useUi } from '../stores/ui.ts';
import { useWorkspace } from '../stores/workspace.ts';
import { hostLabel, sessionCounts } from './StatusBar.tsx';
import { Button } from './ui/Button.tsx';
import { Dialog, DialogActions } from './ui/Dialog.tsx';
import { Checkbox } from './ui/Field.tsx';

/**
 * Hoisted out of the component body. Declared inside it — as the plan had it — this is a NEW
 * component type on every render, so React unmounts and remounts all seven rows (and their copy
 * buttons) whenever `busy` or `ack` changes, discarding focus and any in-flight selection.
 */
function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[12px]">
      <span className="w-28 shrink-0 text-fg-2">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg select-text" title={value ?? ''}>{value ?? '—'}</span>
      {value === null ? null : <Button variant="ghost" onClick={() => void copyText(value)}>copy</Button>}
    </div>
  );
}

/**
 * Spec §12.8's host panel: socket path, node path, log paths, and *Restart session host* behind
 * its kill warning.
 *
 * Renders with `snapshot === null` rather than returning null for it. The panel is reachable from
 * a banner (`bootstrap.ts` gives the host banner a "Details" action) and that banner can exist
 * BEFORE the first snapshot does — `host:status` arriving before `workspace:get` answers is a case
 * bootstrap already holds a `pendingHost` for — so returning null would make that button a dead
 * click in exactly the situation the panel is for. Every field falls back to `—`.
 */
export function HostPanel() {
  const close = useUi((s) => s.closeDialog);
  // Stored references only; the counting happens in the render body (G59/G61 — a `.filter(...)`
  // inside either selector is an infinite render loop, and `status.test.tsx` counts commits here
  // with no snapshot and no sessions at all, which is the state this dialog can genuinely open in).
  const snapshot = useWorkspace((s) => s.snapshot);
  const sessions = useSessions((s) => s.sessions);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  // A read-only diagnostics panel. Left to itself the first focusable control is a row's `copy`
  // button, and the danger zone's acknowledgement checkbox is two Tab stops from `Restart host`,
  // so the footer's own Close is the least surprising place for focus to start.
  const closeRef = useRef<HTMLButtonElement>(null);
  const host = snapshot?.host ?? null;
  const home = snapshot?.profile.home ?? null;
  const { running } = sessionCounts(sessions);
  const status = host === null ? 'connecting…' : host.connected ? `${hostLabel(host).text}${host.version === null ? '' : ` (protocol v${host.version})`}${host.lastError === null ? '' : ` — ${host.lastError}`}` : host.lastError ?? 'connecting…';
  const restart = async (): Promise<void> => {
    setBusy(true);
    // `runResult`, not `run`: a failed restart already toasts through the error sink, and closing
    // the panel on top of that would take away the only place that says what the host is doing.
    const r = await runResult('host:restart', { killSessions: true });
    setBusy(false);
    if (r.ok) close();
  };
  return (
    <Dialog open title="Session host" onClose={close} width={600} initialFocus={closeRef}>
      <Row label="Status" value={status} />
      <Row label="Sessions" value={`${running} running in this app · ${host === null ? '—' : host.sessions} known to the host when it connected`} />
      <Row label="Socket" value={host?.socketPath ?? null} />
      <Row label="Node" value={host?.nodeBin ?? null} />
      <Row label="App log" value={home === null ? null : `${home}/logs/app.log`} />
      <Row label="Host log" value={home === null ? null : `${home}/logs/host.log`} />
      {/* Separate from host.log on purpose (`services/paths.ts`): this one catches a host that dies
          before it opens its own logger — a wrong-ABI node, a Node that cannot parse `.ts` — which
          is the failure that brings someone to this panel in the first place. */}
      <Row label="Host stdio log" value={home === null ? null : `${home}/logs/host-stdio.log`} />
      <p className="mt-3 text-[11.5px] text-muted">
        Diagnostics: run <span className="font-mono text-fg-2">hangar doctor</span> in any agent terminal. The host keeps running when Hangar quits; use <span className="font-mono text-fg-2">Hangar → Quit and Stop All Agents</span> to stop everything.
      </p>
      <div className="mt-4 rounded-md border border-red/40 p-3">
        <div className="mb-2 text-[12px] font-semibold text-red">Restart session host</div>
        <p className="mb-2 text-[11.5px] text-fg-2">Kills every running agent session ({running}). Their conversations can be resumed afterwards with Restart → Resume conversation.</p>
        <Checkbox label="I understand that running agents will be stopped" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <Button variant="danger" disabled={!ack || busy} onClick={() => void restart()}>{busy ? 'Restarting…' : 'Restart host'}</Button>
      </div>
      <DialogActions>
        <Button ref={closeRef} variant="ghost" onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
