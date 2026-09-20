import { ArrowLeftRight, Columns2, FileText, GitCompare, MoreHorizontal, RotateCw, Rows2, StickyNote, X } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { paneChipLabel, paneHue } from '../../../../shared/pane-hues.ts';
import { actionKeystrokes } from '../../../../shared/project-actions.ts';
import type { Agent, DrawerTab, SessionState } from '../../../../shared/types.ts';
import { agentMenuItems, copyText, isRunning, startAgent, stopAgent } from '../../lib/agent-actions.ts';
import { run } from '../../lib/api.ts';
import { withShortcut, type KeymapAction } from '../../lib/keymap.ts';
import { focusTerminal } from '../../lib/terminal-registry.ts';
import { useLayout } from '../../stores/layout.ts';
import { useUi } from '../../stores/ui.ts';
import { useWorkspace } from '../../stores/workspace.ts';
import { IconButton } from '../ui/Button.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';
import { InlineRename } from '../sidebar/InlineRename.tsx';
import { MicButton } from './MicButton.tsx';

/**
 * Spec §12.3's 32px pane header.
 *
 * `h-8` is **26px**, not 32 — `theme.css` sets `font-size: 13px` on `html`, so Tailwind 4's
 * `--spacing` resolves to **3.25px** and every spacing utility is at 81.25% of nominal (G-note from
 * Task 3; Task 4 measured the `h-11` agent row at 35.75px for the same reason).
 *
 * Measured, not reasoned about — this exact markup, rendered by these components and laid out in
 * Electron 44's own Blink with the emitted `theme.css`, `document.documentElement` reporting
 * `font-size: 13px` and `--spacing: .25rem`:
 *
 *     header                              26.00px
 *     ├─ StatusDot (size 8 -> 8+6)        14.00px
 *     ├─ agent name (12.5px)              18.75px
 *     ├─ terminal title (11px)           <18.75px   <- the two used to share one baseline box, and
 *     │                                                that box is what measured 18.75px. The title
 *     │                                                is now its own child; NOT re-measured in
 *     │                                                Blink, but it is the same span with a
 *     │                                                smaller font, so it cannot become the
 *     │                                                tallest child.
 *     ├─ workspace chips (py-0.5)         19.00px
 *     └─ button row (IconButton h-6)      19.50px   <- tallest child
 *
 * 6.50px of headroom, which is real margin rather than Task 4's 0.50px. Do not "fix" this to
 * `h-[32px]`: it would make the pane header the one piece of furniture in the app measured on a
 * different scale from everything beside it.
 *
 * **Width, and who gives it up first.** The row used to be `[name + title] flex-1 min-w-0` beside
 * `shrink-0` chips, which is backwards under pressure: `flex-1` is flex-basis **0**, so in a narrow
 * pane (three panes on a laptop) the AGENT NAME collapsed to nothing while the branch chip sat at
 * its full `max-w-[180px]` and the header read as a branch and nothing else — you could not tell
 * which agent a pane was. The order it degrades in now, first to yield first:
 *
 *   1. terminal title  — the only GROWING item (`flex-1` -> basis 0). It lives on leftover space,
 *                        so it hands all of it back before anything else moves.
 *   2. workspace chips — `shrink` + `min-w-0`, capped at 180px instead of pinned there.
 *   3. agent name      — `shrink-0`: it never gives space back at all, up to `max-w-[45%]`.
 *
 * 45%, and the ceiling is arithmetic rather than taste. Everything right of the name is fixed-width
 * (dot 14 + up to eight 19.5px icon buttons + gaps + `px-2`, ~220px), so a cap of `c` overflows any
 * header narrower than 220/(1 - c): 400px at 45%, 489px at 55%. Below ~400px the button row alone
 * is over half the header and the row overflows whatever the name does — already true before this
 * change, where the 180px chips did the pushing. 45% of a two-pane header in the smallest window
 * (1024px wide, default 260px sidebar -> ~382px) is ~170px of name, well past the dozen characters
 * it takes to tell two agents apart.
 *
 * **Plan 09 added a ninth button, the mic** (`MicButton`), and it is `shrink-0` with the rest of the
 * row. Arithmetic, NOT re-measured in Blink: one more 19.5px button plus one `gap-0.5` (~1.6px) is
 * ~21px on the fixed side, and with the `⧉N` chip's ~30px (below) the fixed furniture is ~271px, so
 * the 45% cap now overflows a header narrower than ~271/0.55 ≈ 493px, where it was ~455px. The same
 * statement as the chip's: a real cost, stated; the degradation ORDER is unchanged — title first,
 * chips second, the name never — and the tightest arrangement the spec allows (~382px) was already
 * past the line. The mic's wrapper span (see `MicButton`) is `inline-flex` around the button and
 * adds no width of its own.
 *
 * The title's span renders even when `state.title` is empty, because it is also the spacer that
 * keeps the chips and buttons hard right. `ml-auto` on the chips would read better and be wrong:
 * auto margins absorb free space BEFORE flex-grow, so a title that IS present would lay out at
 * zero width.
 *
 * None of that is what `PaneGrid.test.tsx` checks — jsdom has no layout engine (G66's family), so
 * the suite pins the DOM order and the classes this priority is made of, and says so in place.
 */
const CLOSE_PANE: KeymapAction = { kind: 'close-pane' };

export function PaneHeader({ agent, state, index, focused }: { agent: Agent; state: SessionState; index: number; focused: boolean }) {
  // Every selector returns a stored reference (`s.snapshot`), a zustand action (stable identity for
  // the life of the store) or a primitive. The derivations that allocate happen below, after the
  // subscriptions — G59: a selector that allocates is an infinite render loop, not a wasted object.
  const snapshot = useWorkspace((s) => s.snapshot);
  const setDrawer = useLayout((s) => s.setDrawer);
  const drawerOpen = useLayout((s) => s.layout.drawerOpen);
  const drawerTab = useLayout((s) => s.layout.drawerTab);
  const focusPane = useLayout((s) => s.focusPane);
  const closePane = useLayout((s) => s.closePane);
  const swapPanes = useLayout((s) => s.swapPanes);
  const paneCount = useLayout((s) => s.layout.panes.length);
  const arrangement = useLayout((s) => s.layout.arrangement);
  const setArrangement = useLayout((s) => s.setArrangement);
  const showMenu = useUi((s) => s.showContextMenu);
  const [renaming, setRenaming] = useState(false);
  const running = isRunning(state);
  const projectName = (id: string) => snapshot?.workspace.projects.find((p) => p.id === id)?.name ?? '?';
  // Same source as `Pane`'s rail, so the chip and the spine beside it cannot disagree by an entry.
  const hue = paneHue(index);

  /**
   * Spec §15.4's actions come from the agent's PRIMARY workspace's project — `workspaces[0]`, the
   * one whose worktree is the PTY's cwd (§6.4). An agent with a second workspace on another project
   * does not get that project's actions, and that is the point: `npm test` typed into a shell
   * sitting in repo A must be repo A's `npm test`. The `--add-dir` workspaces are visible to Claude,
   * not to the shell.
   *
   * Derived AFTER the subscriptions above, from the stored `snapshot` reference — putting this
   * `.find` in a selector is G59's infinite render loop, not a wasted object.
   */
  const primaryProject = snapshot?.workspace.projects.find((p) => p.id === agent.workspaces[0]?.projectId);
  const actions = primaryProject?.actions ?? [];

  /**
   * The shortcut is named ONLY on the focused pane, and that is not fussiness.
   *
   * ⌘⇧F/G/M act on whatever pane has focus, so on an UNfocused pane header the key does something
   * different from the button beside it — it would open the OTHER pane's Files tab. A tooltip that
   * said "Files (⌘⇧F)" there would be a caption pointing at the wrong pane, which is the exact
   * failure this whole change exists to remove; naming the key only where the two really coincide
   * is the honest version. (The button then goes further than the key: it focuses this pane first,
   * so on the focused pane it is `setDrawer` on the same target the shortcut would pick.)
   */
  const drawerButton = (tab: DrawerTab, label: string, Icon: typeof FileText) => (
    <IconButton
      title={focused ? withShortcut(label, { kind: 'drawer-tab', tab }) : label}
      className={focused && drawerOpen && drawerTab === tab ? 'bg-bg-3 text-fg' : ''}
      onClick={() => {
        // Focus first: the drawer is scoped to the focused pane (§12.3), so a drawer button on an
        // UNfocused pane means "show me this pane's files", not "toggle the other pane's drawer".
        // That also makes the toggle one-way for an unfocused pane — `focused` is false in this
        // closure, so the expression below is always `open: true`, which is the wanted behaviour.
        focusPane(index);
        setDrawer({ open: !(focused && drawerOpen && drawerTab === tab), tab });
      }}
    >
      <Icon size={13} />
    </IconButton>
  );

  // The SAME menu as the sidebar row's (`agentMenuItems`), because it is the same agent and §12.2's
  // list is the agent's menu, not the sidebar's. `stopPropagation` is the G60 discipline even
  // though nothing above this header handles `contextmenu` today: the handler that opens a menu
  // owns the event, and `PaneGrid.test.tsx` dispatches a real bubbling event through the whole
  // mounted `App` so a future ancestor handler fails the suite instead of silently winning.
  //
  // Suppressed while renaming so a right-click inside the rename input still gets the platform's
  // own cut/copy/paste menu — replacing that with "Delete agent…" mid-edit is a trap.
  const onContextMenu = (e: MouseEvent) => {
    if (renaming || !snapshot) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, agentMenuItems(agent, state, snapshot));
  };

  return (
    <header
      className={`flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 ${focused ? 'bg-bg-2' : 'bg-bg-1'}`}
      onContextMenu={onContextMenu}
    >
      <StatusDot activity={state.activity} />
      {renaming ? (
        // The rename box keeps the old `flex-1`: it is a text field being typed into, so here the
        // name really should take every pixel the row can spare.
        <div className="min-w-0 flex-1">
          <InlineRename value={agent.name} onCancel={() => setRenaming(false)} onCommit={(name) => { setRenaming(false); void run('agent:update', { id: agent.id, patch: { name } }); }} />
        </div>
      ) : (
        <>
          <span className="max-w-[45%] shrink-0 truncate text-[12.5px] font-semibold text-fg" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{agent.name}</span>
          {/* Always rendered — the spacer half of the header comment above. `title` is dropped when
              there is no title so an empty span cannot tooltip a name at the empty middle. */}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={state.title ? 'Terminal title' : undefined}>{state.title}</span>
        </>
      )}
      <div className="flex min-w-0 shrink items-center gap-1">
        {/*
          Spec §3's "never colour alone": the `⧉N` the sidebar row already carries, tinted to the
          rail's hue, so the pane is identified by a NUMBER as well as by a colour — and the number
          is the ⌘1–⌘4 key, which is why `paneChipLabel` is one-based.

          Placed among the chips and `shrink-0`, which the header's width comment above is the
          reason for. It is the only thing in this row that must never be squeezed into an
          unreadable sliver (a half-rendered `⧉` says nothing), and it is small enough to pin: the
          degradation order it joins is unchanged — the terminal title still yields first, the
          workspace chips second, and the agent name still never yields at all.

          Not re-measured in Blink; arithmetic off the figures in the header comment above.
          HEIGHT: 10px text with `leading-none` and `py-0.5` (3.25px a side — `--spacing` is
          3.25px here) is ~16.5px against a 19.5px tallest child, so it cannot grow the 26px row.
          WIDTH: ~30px, chip plus one `gap-1`, added to the ~220px of fixed furniture right of the
          name, which moves the 220/(1 - 0.45) threshold from ~400px to ~455px. That is a real
          cost and it is stated rather than hidden: a header narrower than ~455px now overflows
          where ~400px was the line before. What it does not do is change WHICH item pays — the
          title still yields first, then the branch chips, and the name still never yields — and
          in the tightest arrangement the spec allows (two panes, 1024px window, 260px sidebar,
          ~382px each) the row was already past its threshold before this chip existed.
        */}
        {hue ? (
          <span
            data-testid="pane-chip"
            className="shrink-0 rounded px-1 py-0.5 text-[10px] leading-none"
            style={{ backgroundColor: `${hue}22`, color: hue }}
            title={withShortcut(`Pane ${index + 1}`, { kind: 'focus-pane', index })}
          >
            {paneChipLabel(index)}
          </span>
        ) : null}
        {agent.workspaces.map((w, i) => (
          <button
            key={w.id}
            type="button"
            className="no-drag min-w-0 max-w-[180px] shrink truncate rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2 hover:text-fg"
            title={`${w.worktreePath}\nclick to copy path`}
            onClick={() => void copyText(w.worktreePath)}
          >
            {i === 0 ? w.branch : `+ ${projectName(w.projectId)}`}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Plan 09 (spec §4). First in the row: it is the one button used while looking at the
            terminal rather than away from it. */}
        <MicButton agentId={agent.id} running={running} focused={focused} />
        {drawerButton('files', 'Files', FileText)}
        {drawerButton('diff', 'Diff', GitCompare)}
        {drawerButton('notes', 'Notes', StickyNote)}
        {/* Hidden rather than disabled when the project has no actions: an always-present ⋯ that
            opens an empty menu is a control that does nothing, which §12.3 rules out for the swap
            button for the same reason. */}
        {actions.length > 0 ? (
          <IconButton
            title="Project actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showMenu(r.left, r.bottom + 4, actions.map((a) => ({
                label: a.label,
                // A stopped agent has no PTY to type into. `session:write` would answer HOST_DOWN or
                // route to a session the host does not have; disabling says so before the toast.
                disabled: !running,
                onSelect: () => {
                  // `actionKeystrokes`, never `a.command`: the bytes go straight into a live
                  // interactive shell, where a `\r` would press Enter on the user's behalf and
                  // U+0003/U+0015 are consumed by the line editor before any parser runs (G33).
                  // No trailing newline — §15.4 is explicit that the user reviews and submits.
                  void run('session:write', { agentId: agent.id, data: actionKeystrokes(a.command) });
                  // The typed text is useless if the next keypress goes to the menu that was just
                  // dismissed: pressing Enter IS the rest of this gesture.
                  focusTerminal(agent.id);
                },
              })));
            }}
          >
            <MoreHorizontal size={13} />
          </IconButton>
        ) : null}
        <IconButton
          title="Restart / stop"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: 'Resume conversation', disabled: running, onSelect: () => void startAgent(agent.id, 'resume') },
              { label: 'Start fresh', disabled: running, onSelect: () => void startAgent(agent.id, 'fresh') },
              { label: 'Shell only', disabled: running, onSelect: () => void startAgent(agent.id, 'shell-only') },
              { separator: true, label: '' },
              { label: 'Stop', disabled: !running, danger: true, onSelect: () => void stopAgent(agent.id) },
            ]);
          }}
        >
          <RotateCw size={13} />
        </IconButton>
        {/* §12.3: "the ⇄ swap button is disabled on the last pane (the reducer's no-op is
            indistinguishable from a swap)". The wrap-around target reaches the same end by a
            different route — the last pane swaps with pane 0, which is a real move — so the button
            never no-ops and stays live everywhere except a single pane, where there is nothing to
            swap with. `% paneCount` is unreachable at paneCount 0 (a layout always has >= 1 pane)
            and unreachable at 1 (the button is disabled), which are the only two divisors that
            would misbehave. */}
        <IconButton title="Swap with next pane" disabled={paneCount < 2} onClick={() => swapPanes(index, (index + 1) % paneCount)}>
          <ArrowLeftRight size={13} />
        </IconButton>
        {/* Only the two-pane case has a free h/v choice (§12.3); 3 and 4 panes are fixed shapes. */}
        {paneCount === 2 ? (
          <IconButton title={arrangement === 'split-v' ? 'Side by side' : 'Stacked'} onClick={() => setArrangement(arrangement === 'split-v' ? 'split-h' : 'split-v')}>
            {arrangement === 'split-v' ? <Columns2 size={13} /> : <Rows2 size={13} />}
          </IconButton>
        ) : null}
        {/* Same focused-only rule as `drawerButton`, and for the same reason: ⌘⇧W closes the
            FOCUSED pane, so on any other header the key and the button do different things. */}
        <IconButton title={`${focused ? withShortcut('Close pane', CLOSE_PANE) : 'Close pane'} — the session keeps running`} onClick={() => closePane(index)}>
          <X size={13} />
        </IconButton>
      </div>
    </header>
  );
}
