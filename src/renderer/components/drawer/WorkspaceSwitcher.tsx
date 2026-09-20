import type { Agent, Id } from '../../../../shared/types.ts';
import { useProjects } from '../../stores/workspace.ts';

/**
 * The segmented project switcher shown when an agent has more than one workspace (spec §12.5).
 *
 * `useProjects()` is the store subscription and it is already stable — it hoists its empty-array
 * fallback to module scope (`EMPTY_PROJECTS` in stores/workspace.ts) precisely so it cannot loop
 * React (G59). The `.map` and `.find` below run in the RENDER body, after subscribing, which is
 * where allocation is free; moving either into a selector — `useWorkspace((s) => agent.workspaces
 * .map(...))` is the natural-looking version — is the infinite loop, not a wasted allocation.
 */
export function WorkspaceSwitcher({ agent, value, onChange }: { agent: Agent; value: Id; onChange: (workspaceId: Id) => void }) {
  const projects = useProjects();
  if (agent.workspaces.length < 2) return null;
  return (
    <div className="mb-2 flex shrink-0 gap-1 rounded-md bg-bg-0 p-0.5">
      {agent.workspaces.map((w) => (
        <button
          key={w.id}
          type="button"
          className={`no-drag flex-1 truncate rounded px-2 py-1 text-[11px] ${w.id === value ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg'}`}
          onClick={() => onChange(w.id)}
          title={w.worktreePath}
        >
          {projects.find((p) => p.id === w.projectId)?.name ?? '?'}
        </button>
      ))}
    </div>
  );
}
