import { paneHue } from '../../../../shared/pane-hues.ts';
import type { WorkspaceRuntime } from '../../../../shared/types.ts';
import { isRunning } from '../../lib/agent-actions.ts';
import { useLayout } from '../../stores/layout.ts';
import { useSession } from '../../stores/sessions.ts';
import { useUi } from '../../stores/ui.ts';
import { useAgent, useWorkspace } from '../../stores/workspace.ts';
import { DictationPill } from './DictationPill.tsx';
import { EmptyPane } from './EmptyPane.tsx';
import { ExitCard } from './ExitCard.tsx';
import { PaneHeader } from './PaneHeader.tsx';
import { TerminalView } from './TerminalView.tsx';

/**
 * Hoisted, and typed from `WorkspaceSnapshot['runtime']` rather than re-spelled.
 *
 * Hoisted because `snapshot?.runtime ?? {}` inside the render body allocates a fresh object every
 * render, which is harmless here (the derivation is below the subscription) but becomes G59's
 * infinite loop the moment someone moves it into a selector — and a module constant cannot be
 * moved there by accident. Typed from the snapshot because the plan spelled it
 * `Record<string, { workspaceId: string; worktreeMissing: boolean }>`, which is structurally
 * compatible today and would stop being so the day `WorkspaceRuntime` gains a field.
 */
const EMPTY_RUNTIME: Record<string, WorkspaceRuntime | undefined> = {};

export function Pane({ index, agentId, focused }: { index: number; agentId: string | null; focused: boolean }) {
  const agent = useAgent(agentId);
  // Memoised per id inside the store — a fresh `initialSessionState(...)` per call is G59's loop,
  // and an empty pane (`agentId === null`) hits that path on every single render.
  const state = useSession(agentId);
  const snapshot = useWorkspace((s) => s.snapshot);
  const focusPane = useLayout((s) => s.focusPane);
  /**
   * §3: sweeping the sidebar makes the matching pane answer.
   *
   * The comparison happens INSIDE the selector on purpose, exactly as `AgentRow` already does with
   * `renamingId === agent.id`. What comes out is a boolean — a primitive, so zustand 5's `Object.is`
   * settles it and there is nothing to allocate (G59/G61). It is also the cheaper half of the
   * choice: reading the raw `hoveredAgentId` out here would re-render every open pane each time the
   * pointer crossed a row, while this one only re-renders the pane that just started or stopped
   * being the hovered agent's.
   *
   * `agentId !== null` is not defensive tidying — it is the bug this would otherwise have. An EMPTY
   * pane's `agentId` is null and so is `hoveredAgentId` when nothing is hovered, so `null === null`
   * would light every empty pane's rail whenever the pointer was off the sidebar entirely: the
   * feature backwards, brightest when nothing is being pointed at.
   */
  const hovered = useUi((s) => agentId !== null && s.hoveredAgentId === agentId);
  const runtime = snapshot?.runtime ?? EMPTY_RUNTIME;
  const missing = agent?.workspaces.some((w) => runtime[w.id]?.worktreeMissing) ?? false;
  /** Whether this pane shows a live terminal (and so takes Escape) rather than a card. */
  const terminal = isRunning(state) && !missing;
  // Null outside `0..MAX_PANES-1`, and then no rail at all rather than a wrapped colour claiming a
  // link to another pane (`shared/pane-hues.ts`). `relative` below is the rail's containing block.
  const hue = paneHue(index);
  return (
    <section
      className={`relative flex h-full min-h-0 flex-col bg-bg-0 ${focused ? 'outline-accent/70 outline outline-1 -outline-offset-1' : ''}`}
      // CAPTURE, and deliberately not a bubbling `onMouseDown`. §12.3: "clicking anywhere in a pane
      // focuses it", and from Task 6 there is an xterm covering most of the pane. Capture runs
      // before any descendant, so it cannot be stopped by one.
      //
      // Corrected in Task 6, having actually measured it: xterm 6.0.0 does NOT call
      // `stopPropagation()` on its mousedown (nor on keydown) — a mousedown dispatched at
      // `.xterm-screen` reaches a bubble-phase listener on `window` — so this is defence, not a
      // live fix, and reverting to `onMouseDown` passes every "click the terminal" test. What it
      // fails is the test below it that puts a consumer between the terminal and React's root,
      // which is what a selection gesture in any future xterm looks like. React attaches at the
      // ROOT and replays down its own tree, so a bubbling handler here would never see such an
      // event at all.
      //
      // It neither stops propagation nor prevents the default, so it is purely additive: the
      // header's buttons, the branch chips and the terminal all still receive the same event. That
      // is the other half of G60 — an ancestor handler must not consume what a descendant needs.
      onMouseDownCapture={() => {
        if (!focused) focusPane(index);
      }}
    >
      {/*
        Spec §3's colour spine: 3px of `paneHue(index)` down the whole left edge, full strength on
        the focused pane and 55% on the rest. Decorative, so `aria-hidden` — the number it doubles
        is in the header's `⧉N` chip, which is text.

        **An absolute overlay, and that is the whole point.** A `border-l-[3px]`, a `pl-[3px]` or a
        3px flex sibling all take three pixels off the pane's CONTENT box, and the terminal is
        measured from that box: `TerminalView`'s fit turns it into rows/cols, so a narrower pane is
        a real PTY reflow, not a repaint. Out of flow, the rail changes no box at all — the header,
        the body and every class on them keep the geometry they had, and `position: relative` on
        the section adds a containing block while moving nothing.

        Not taking space means the rail sits OVER the leftmost 3px of the pane. In the body that is
        the terminal container's `px-2` padding (8px), not its first text column, so no character is
        covered. It is `pointer-events-none` all the same: a click or drag starting hard against the
        left edge must reach what is under it, not the decoration.

        `z-20` rather than the bare stacking a positioned element gets. The rail comes FIRST in tree
        order, so at `z-index: auto` every positioned thing after it paints over it — the body's own
        `relative` wrapper, and xterm's layers, which go up to `z-index: 11` in `xterm.css`. 20
        clears those and still sits under the app's furniture: panel 30, toasts 40, menus and
        dialogs 50.

        Drawn on an EMPTY pane too. The hue names the PANE, not the agent in it (§3), and pane 3
        keeps its colour while you decide what to put there.
      */}
      {hue ? (
        <div
          aria-hidden
          data-testid="pane-rail"
          className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[3px]"
          // Hovering this pane's agent in the sidebar lifts the rail to full strength, the same
          // strength focus gives it — the row is asking "which one is this?" and half an answer is
          // no answer. It is a lift and never a dim: the focused pane stays at 1 while another
          // row is swept, because focus is a fact about the app and the hover is a question about
          // one row.
          style={{ backgroundColor: hue, opacity: focused || hovered ? 1 : 0.55 }}
        />
      ) : null}
      {agent ? (
        <>
          <PaneHeader agent={agent} state={state} index={index} focused={focused} />
          <div className="relative min-h-0 flex-1">
            {/* A missing worktree outranks a running session: the card explains why, and mounting a
                terminal for a session whose cwd is gone would attach to a PTY that cannot start. */}
            {terminal ? <TerminalView agentId={agent.id} paneIndex={index} focused={focused} /> : <ExitCard agent={agent} state={state} missing={missing} />}
            {/* Plan 09: the live partial while this agent is being dictated to. Rendered over the
                exit card too — a run the session ended under is still this pane's to show until
                main's cancel lands — but `Esc cancels` only where there is a terminal to take the
                Escape: the same `terminal` that mounted one, so the two cannot disagree. */}
            <DictationPill agentId={agent.id} escapeCancels={terminal} />
          </div>
        </>
      ) : (
        <EmptyPane index={index} />
      )}
    </section>
  );
}
