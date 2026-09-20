import { AlertTriangle, StickyNote } from 'lucide-react';
import { useEffect, type MouseEvent } from 'react';
import { paneChipLabel, paneHue } from '../../../../shared/pane-hues.ts';
import { relativeTime } from '../../../../shared/relative-time.ts';
import type { Agent } from '../../../../shared/types.ts';
import { agentMenuItems, openAgent } from '../../lib/agent-actions.ts';
import { run } from '../../lib/api.ts';
import { useNow } from '../../lib/time.ts';
import { useLayout } from '../../stores/layout.ts';
import { useSession } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { StatusDot } from '../ui/StatusDot.tsx';
import { InlineRename } from './InlineRename.tsx';

export function AgentRow({ agent, depth, dropHint }: { agent: Agent; depth: number; dropHint: 'before' | 'after' | null }) {
  // Every selector below returns either a stored reference or a primitive. zustand 5 hands the
  // selector to `useSyncExternalStore`, which re-runs it after each commit and commits again when
  // the identity differs — Task 2 measured a fresh-object selector at 55 renders before React threw
  // "Maximum update depth exceeded". `useSession` is memoised per id in the store for that reason,
  // and `paneOf(...)` only LOOKS like the trap: it returns `number | null`, compared by value.
  // The two derivations that DO allocate (`projects`, `missing`) happen below, after subscribing.
  const state = useSession(agent.id);
  const snapshot = useWorkspace((s) => s.snapshot);
  const renaming = useUi((s) => s.renamingId === agent.id);
  const setRenaming = useUi((s) => s.setRenaming);
  const showMenu = useUi((s) => s.showContextMenu);
  // A zustand action: one identity for the life of the store, so subscribing to it is free. The row
  // deliberately does NOT subscribe to `hoveredAgentId` itself — nothing here changes when the
  // pointer moves, and reading the id would re-render every row in the tree on every row crossed.
  const setHovered = useUi((s) => s.setHoveredAgent);
  /**
   * A row that disappears from under the pointer lets go of the hover. React fires no
   * `pointerleave` for an element that UNMOUNTS beneath the pointer — the search filtering it out,
   * ⌘B hiding the sidebar, its folder collapsing — so without this `hoveredAgentId` stayed on the
   * vanished row and its pane's rail stayed at full strength until the pointer happened to cross
   * another row. Only while the hover is still THIS row's: another row may have taken it already.
   *
   * Read with `getState()` at unmount, never subscribed — the row still does not render from the
   * hovered id (G59/G61, and a re-render of every row per pointer move). `agent.id` as the key, so a
   * row re-pointed at another agent releases the old id the same way.
   */
  useEffect(() => () => {
    if (useUi.getState().hoveredAgentId === agent.id) useUi.getState().setHoveredAgent(null);
  }, [agent.id]);
  const paneIndex = useLayout((s) => s.paneOf(agent.id));
  const now = useNow();
  /**
   * Spec §3's colour spine, the sidebar half. `paneOf` already answered "which pane", so this is a
   * lookup rather than a second opinion, and it is the SAME table the pane's own rail reads.
   *
   * **Null when the agent is in no pane, and then nothing is drawn** — no rail and no tint. That is
   * deliberately the opposite of the pane rule, where an EMPTY pane still shows its colour: the hue
   * names the pane, so a pane owns one always, and a row only borrows it while it holds one. A
   * sidebar of forty agents wearing forty colours would say nothing at all; four rows wearing the
   * four pane colours say exactly which rows are on screen right now (§3, "a row with no pane open
   * has no rail, so the sidebar stays quiet").
   */
  const hue = paneIndex === null ? null : paneHue(paneIndex);
  if (!snapshot) return null;
  const projects = agent.workspaces.map((w) => snapshot.workspace.projects.find((p) => p.id === w.projectId)?.name ?? '?').join(' + ');
  const missing = agent.workspaces.some((w) => snapshot.runtime[w.id]?.worktreeMissing);
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    // `stopPropagation`, not just `preventDefault`. The whole tree sits inside `Sidebar`'s
    // `<aside>`, which carries its own `onContextMenu` for the background (root items). React events
    // bubble, so without this the row's `showMenu(...)` runs FIRST and the ancestor's immediately
    // overwrites it: every right-click in the sidebar opened "New agent / New folder / Add project…"
    // and every per-row action — rename, delete, open in pane, stop — was unreachable by the gesture
    // the spec expects them to be reached by. Measured in the built app against a seeded
    // ~/.hangar-dev before the fix. `preventDefault` alone does not stop propagation.
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, agentMenuItems(agent, state, snapshot));
  };
  return (
    <div
      className={`group relative flex h-11 cursor-default items-center gap-2 pr-2 hover:bg-bg-2 ${paneIndex !== null ? 'bg-bg-2/60' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={(e) => openAgent(agent.id, e.metaKey)}
      onContextMenu={onContext}
      // §3: "hovering a sidebar row brightens its pane's rail". Set unconditionally, even for an
      // agent in no pane — `Pane` decides whether any pane matches, and a row that quietly skipped
      // the write would leave the PREVIOUS row's pane lit while the pointer sat somewhere else.
      //
      // Enter/leave, never over/out: over and out fire again for every child crossed inside the
      // row (the name, the chip, the timestamp), so the pointer moving from the name to the chip
      // would clear the hover and set it again — a flicker on the pane's rail from a gesture that
      // never left the row. React synthesises this pair from `pointerover`/`pointerout` and
      // dispatches the leave of the row being left before the enter of the row being entered, so
      // the unconditional `null` cannot land on top of the next row's write.
      onPointerEnter={() => setHovered(agent.id)}
      onPointerLeave={() => setHovered(null)}
    >
      {dropHint ? <div className={`pointer-events-none absolute right-2 left-2 h-0.5 bg-accent ${dropHint === 'before' ? 'top-0' : 'bottom-0'}`} /> : null}
      {/*
        The pane's rail, on the row that holds it — 3px of the same hue down the row's left edge,
        which is what makes a sidebar row and a terminal read as one thing.

        Absolutely positioned inside the row's existing `relative`, like the pane's own rail and for
        a smaller version of the same reason: the row's left padding is `10 + depth * 14`, so a
        border or a flex sibling would shift every label in a nested folder by three pixels and the
        indentation would stop lining up with the rows around it. Out of flow, the rail changes no
        box at all.

        Full strength, with no focused/unfocused dimming: that rule belongs to the panes, where four
        rails are on screen at once and one of them owns the keyboard. Here the rail is a fact about
        one row — this agent is in pane N — and a dimmed version would read as a different, weaker
        claim rather than the same one.

        Decorative, hence `aria-hidden`: the `⧉N` chip below is the text that carries the meaning,
        and `pointer-events-none` keeps the three pixels from eating a click on the row.
      */}
      {hue ? <div aria-hidden data-testid="row-rail" className="pointer-events-none absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: hue }} /> : null}
      {missing ? <AlertTriangle size={14} className="shrink-0 text-amber" /> : <StatusDot activity={state.activity} />}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <InlineRename value={agent.name} onCancel={() => setRenaming(null)} onCommit={(name) => { setRenaming(null); void run('agent:update', { id: agent.id, patch: { name } }); }} />
        ) : (
          <div className={`truncate text-[12.5px] ${state.unread ? 'font-semibold text-fg' : 'text-fg'}`} onDoubleClick={() => setRenaming(agent.id)} title={missing ? 'A worktree directory is missing' : state.title || agent.name}>
            {agent.name}
          </div>
        )}
        <div className="truncate text-[11px] text-muted">
          {projects} · {agent.workspaces[0]?.branch}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-muted">
        {agent.notes.trim().length > 0 ? <StickyNote size={11} /> : null}
        {/* §3's "never colour alone": the chip this row already carried, now tinted to the rail's
            hue and drawn from the same `shared/pane-hues.ts` as the pane header's copy of it — so
            the number, which is also the ⌘1–⌘4 key, still says everything the colour does. The
            `bg-bg-3`/`text-fg-2` it used to wear are gone rather than overridden: a class and an
            inline style saying different things about the same pixel is the next person's puzzle.
            Both halves of the condition are spelled out so `paneIndex` narrows to a number here;
            `hue` is non-null only when it already is one. */}
        {hue !== null && paneIndex !== null ? <span data-testid="row-pane-chip" className="rounded px-1 text-[10px]" style={{ backgroundColor: `${hue}22`, color: hue }}>{paneChipLabel(paneIndex)}</span> : null}
        <span title={agent.lastOpenedAt ? new Date(agent.lastOpenedAt).toLocaleString() : 'never opened'}>{relativeTime(agent.lastOpenedAt, now)}</span>
      </div>
    </div>
  );
}
