import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relativeTime } from '../../shared/relative-time.ts';
import type { AgentMirror } from '../../shared/types.ts';
import type { CliContext } from '../context.ts';

/** Shape-checks a parsed mirror. The file is written by main, but it can also be stale, hand-edited,
 *  copied between profiles, or written by a different Hangar version. */
export function isAgentMirror(v: unknown): v is AgentMirror {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<AgentMirror>;
  return typeof m.id === 'string' && typeof m.name === 'string' && typeof m.slug === 'string'
    && typeof m.notes === 'string' && Array.isArray(m.workspaces);
}

export function formatMirror(m: AgentMirror): string {
  const lines = [`agent:  ${m.name} (${m.id})`, `slug:   ${m.slug}`, `updated: ${relativeTime(m.updatedAt)}`];
  for (const w of m.workspaces) lines.push(`- ${w.projectName}  ${w.branch}  ${w.worktreePath}`);
  if (m.notes.trim().length > 0) lines.push('notes:', ...m.notes.split('\n').map((l) => `  ${l}`));
  return lines.join('\n') + '\n';
}

export async function runStatus(args: string[], ctx: CliContext): Promise<number> {
  if (ctx.agentId === null) {
    ctx.stderr.write('hangar: not inside a Hangar agent (HANGAR_AGENT_ID unset; use --agent <id>)\n');
    return 1;
  }
  const file = join(ctx.home, 'state', 'agents', `${ctx.agentId}.json`);
  if (!existsSync(file)) {
    ctx.stderr.write(`hangar: no state for agent ${ctx.agentId} (${file})\n`);
    return 1;
  }
  // Every other error path in this CLI emits one `hangar: …` line; without this, a corrupt or
  // foreign mirror prints a raw Node stack trace into the agent's own terminal.
  let mirror: unknown;
  try {
    mirror = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    ctx.stderr.write(`hangar: state for agent ${ctx.agentId} is unreadable (${file}): ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (!isAgentMirror(mirror)) {
    ctx.stderr.write(`hangar: state for agent ${ctx.agentId} is not in the expected format (${file})\n`);
    return 1;
  }
  ctx.stdout.write(args.includes('--json') ? JSON.stringify(mirror, null, 2) + '\n' : formatMirror(mirror));
  return 0;
}
