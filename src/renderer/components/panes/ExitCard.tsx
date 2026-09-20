import { AlertTriangle } from 'lucide-react';
import { primaryWorkspace, type Agent, type SessionState } from '../../../../shared/types.ts';
import { startAgent } from '../../lib/agent-actions.ts';
import { Button } from '../ui/Button.tsx';

/**
 * What the card says, extracted so the three-way choice can be tested without a DOM.
 *
 * `missing` outranks the activity: a worktree that is gone is why the session cannot run, and
 * "Session not running" on top of it would send the user to the Start buttons that cannot work
 * (main disables start for a missing worktree — §6, `WorkspaceRuntime.worktreeMissing`).
 *
 * `exitCode ?? '?'` covers a session killed by a signal, where the host reports a null code.
 */
export function exitCardTitle(state: SessionState, missing: boolean): string {
  if (missing) return 'Worktree directory is missing';
  if (state.activity === 'exited') return `Session exited with code ${state.exitCode ?? '?'}`;
  return 'Session not running';
}

export function ExitCard({ agent, state, missing }: { agent: Agent; state: SessionState; missing: boolean }) {
  // `primaryWorkspace(agent)`, not `agent.workspaces[0]?.worktreePath`. §6 guarantees at least one
  // workspace; the helper names the agent if that invariant is ever broken, where the optional chain
  // would silently render "undefined no longer exists" — a sentence that helps nobody debug it.
  // Same correction Task 4 made in `agentMenuItems` (P3-4e).
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-2">
      <div className="flex items-center gap-2 text-[13px]">
        {missing ? <AlertTriangle size={14} className="text-amber" /> : null}
        {exitCardTitle(state, missing)}
      </div>
      {missing ? (
        <div className="max-w-md text-center text-[12px] text-muted">
          {primaryWorkspace(agent).worktreePath} no longer exists. Delete this agent, or recreate the directory with git.
        </div>
      ) : agent.claude.hasStartedOnce ? (
        // §11.6: `--resume` only makes sense once a session id exists. A never-started agent gets
        // the two-button form, or "Resume conversation" would ask Claude for a conversation that
        // has never happened and surface its "no conversation found" error in the terminal.
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void startAgent(agent.id, 'resume')}>Resume conversation</Button>
          <Button onClick={() => void startAgent(agent.id, 'fresh')}>Start fresh</Button>
          <Button variant="ghost" onClick={() => void startAgent(agent.id, 'shell-only')}>Shell only</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void startAgent(agent.id, 'auto')}>Start Claude</Button>
          <Button variant="ghost" onClick={() => void startAgent(agent.id, 'shell-only')}>Shell only</Button>
        </div>
      )}
    </div>
  );
}
