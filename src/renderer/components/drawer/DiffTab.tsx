import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeSet } from '../../../../shared/ipc-contract.ts';
import type { Agent, Workspace } from '../../../../shared/types.ts';
import { run } from '../../lib/api.ts';
import { useSession } from '../../stores/sessions.ts';
import { useProject } from '../../stores/workspace.ts';
import { IconButton } from '../ui/Button.tsx';
import { Resizer } from '../ui/Resizer.tsx';
import { DiffList } from './DiffList.tsx';
import { DiffView } from './DiffView.tsx';

/** Spec §12.5's "every 30 s while visible". */
export const DIFF_REFRESH_MS = 30_000;

/** The list column. Same bounds reasoning as `FilesTab`'s tree: both columns stay usable at the
 *  drawer's own 420 px minimum, and below 160 a path column shows nothing but ellipses. */
export const LIST_DEFAULT_WIDTH = 240;
export const LIST_MIN_WIDTH = 160;
export const LIST_MAX_WIDTH = 480;

/** "1 file", "2 files" — the header is read at a glance and "1 file(s)" is noise. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Spec §12.5's Diff tab.
 *
 * **Auto-refresh, and the clause that decides the implementation.** §12.5: refresh when the tab is
 * visible and (a) it was just opened, (b) a `Stop`/`SessionEnd` hook arrives for this agent, (c) the
 * workspace switcher changes, (d) every 30 s while visible — **never while hidden**.
 *
 * "Visible" here means the drawer is open AND the Diff tab is selected, and that is exactly when
 * `Drawer` renders this component: it returns `null` for a closed drawer and renders the Notes or
 * Files tab otherwise, so *mounted* and *visible* are the same condition. Every trigger therefore
 * lives inside the component's own lifetime, and the interval's `clearInterval` cleanup is what
 * makes (d) stop when the tab is hidden — a `setInterval` without it would keep calling
 * `git:changes` on a torn-down component for as long as the app is open, which is the obvious
 * implementation and the wrong one. `DiffTab.test.tsx` switches the drawer to Files and advances
 * 90 s of fake time to prove nothing further is sent.
 *
 * (b) is per-agent, and the renderer never sees hook events directly — main broadcasts reduced
 * `SessionState`. The observable signal is therefore `lastHookAt` moving while `activity` is one of
 * the two states those hooks produce (`shared/status.ts`: `Stop`/`StopFailure` → `waiting`,
 * `SessionEnd` → `shell`). `lastHookAt` rather than `activity` alone because a second `Stop` while
 * already `waiting` moves no activity and is still a turn ending. `useSession(agent.id)` returns a
 * referentially stable object for one agent, so another agent's session update re-runs the selector,
 * compares equal and never reaches this component at all — the per-agent half is the store's, not a
 * comparison here, and there is a test that a hook for a second agent refreshes nothing.
 */
export function DiffTab({ agent, workspace }: { agent: Agent; workspace: Workspace }) {
  const [set, setSet] = useState<ChangeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [listWidth, setListWidth] = useState(LIST_DEFAULT_WIDTH);
  const session = useSession(agent.id);
  // The project, for the base branch NAME in the header. `useProject` selects an element of the
  // stored array, so it is referentially stable and cannot loop React (G59); deriving an object
  // here instead would be the bug. `git:changes` measures against `project.defaultBranch`
  // (`handlers.ts`), not `workspace.baseRef`, so this reads the same field main does.
  const project = useProject(workspace.projectId);
  const baseBranch = project?.defaultBranch ?? workspace.baseRef;

  /**
   * Deliberately NOT dependent on `selected`: it changes identity only with the agent or the
   * workspace, which is what lets the mount effect below own the interval without an exhaustive-deps
   * suppression, and what stops the 30 s timer being torn down and re-armed every time the user
   * clicks a different row.
   */
  const refresh = useCallback(async () => {
    const r = await run('git:changes', { agentId: agent.id, workspaceId: workspace.id }, (e) => setError(e.message));
    if (r === null) return;
    setError(null);
    setSet(r);
    // What makes the OPEN file re-read too, not just the list.
    setRefreshKey((k) => k + 1);
    // The agent deletes and commits files under the drawer constantly, so the row the user has open
    // disappearing is ordinary. Read through the updater rather than off `selected`, so this
    // callback stays stable.
    setSelected((cur) => (cur !== null && !r.files.some((f) => f.relPath === cur) ? null : cur));
  }, [agent.id, workspace.id]);

  // (a) just opened, (c) workspace (or agent) changed, (d) every 30 s while visible.
  useEffect(() => {
    setSet(null);
    setSelected(null);
    setError(null);
    void refresh();
    const timer = setInterval(() => void refresh(), DIFF_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // (b) a Stop/SessionEnd hook for THIS agent.
  const lastHook = useRef<{ agentId: string; at: number | null }>({ agentId: agent.id, at: session.lastHookAt });
  useEffect(() => {
    const prev = lastHook.current;
    lastHook.current = { agentId: agent.id, at: session.lastHookAt };
    // A different agent is a fresh subject: its `lastHookAt` is not a hook that just arrived, and
    // the effect above has already refreshed for the switch. Without this the switch refreshes twice.
    if (prev.agentId !== agent.id || prev.at === session.lastHookAt) return;
    if (session.activity === 'waiting' || session.activity === 'shell') void refresh();
  }, [agent.id, session, refresh]);

  const selectedFile = set?.files.find((f) => f.relPath === selected) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 text-[11px] text-fg-2">
        {set !== null ? (
          <>
            {/* `stats` arrives complete from main: `changes()` adds the lines of untracked files to
                `git diff --shortstat`, which answers the EMPTY STRING when the only changes are
                untracked — "+0 −0" for exactly the agent that has just written a pile of new files.
                Nothing is re-derived here. */}
            <span className="text-green">+{set.stats.insertions}</span>
            <span className="text-red">−{set.stats.deletions}</span>
            <span className="truncate text-muted">
              · {count(set.files.length, 'file')} · {count(set.aheadCommits, 'commit')} ahead of {baseBranch}
            </span>
          </>
        ) : error === null ? (
          <span className="text-muted">loading…</span>
        ) : null}
        {/* Shown even once a change set has loaded: a refresh that fails after a good one would
            otherwise leave a stale list on screen with nothing saying it had stopped updating. */}
        {error !== null ? <span className="truncate text-red">{error}</span> : null}
        <span className="flex-1" />
        <IconButton title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 shrink-0 flex-col border-r border-line" style={{ width: listWidth }}>
          {set !== null ? <DiffList set={set} selected={selected} onSelect={setSelected} /> : null}
          {/* `onResize` reports one INCREMENTAL delta per mousemove, so each is added to the width
              this render holds. `onDone` has nothing to do: like the Files tab's split, this width
              is local state — §12.5 persists the DRAWER width and `layout:set` has no field for
              this one. */}
          <Resizer
            side="right"
            onResize={(d) => setListWidth((w) => Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, w + d)))}
            onDone={() => undefined}
          />
        </div>
        <div className="min-w-0 flex-1">
          {selectedFile !== null ? (
            <DiffView
              agentId={agent.id}
              workspaceId={workspace.id}
              relPath={selectedFile.relPath}
              status={selectedFile.status}
              refreshKey={refreshKey}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-muted">Select a changed file</div>
          )}
        </div>
      </div>
    </div>
  );
}
