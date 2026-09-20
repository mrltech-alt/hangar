import { CLI_REPLY_TIMEOUT_MS } from '../../shared/constants.ts';
import { cleanAgentName } from '../../shared/agent-name.ts';
import type { CliContext } from '../context.ts';
import { requestOnce } from '../socket.ts';

export async function runRename(args: string[], ctx: CliContext): Promise<number> {
  // cleanAgentName, not a local regex: this is the only strip on the CLI relay path (main's relay
  // handler does not re-run the zod schema), and it is what stops a name breaking out of shellQuote
  // when it is typed into the login shell on the next start. See shared/agent-name.ts.
  const name = cleanAgentName(args.join(' '));
  if (name.length === 0) {
    ctx.stderr.write('usage: hangar rename <name>\n');
    return 1;
  }
  if (ctx.agentId === null) {
    ctx.stderr.write('hangar: not inside a Hangar agent (HANGAR_AGENT_ID unset; use --agent <id>)\n');
    return 1;
  }
  const reply = await requestOnce(ctx.socketPath, { t: 'cli', agentId: ctx.agentId, cmd: 'rename', payload: { name } }, CLI_REPLY_TIMEOUT_MS);
  if (reply === null || reply.t !== 'ok') {
    ctx.stderr.write(`hangar: session host not reachable at ${ctx.socketPath}\n`);
    return 1;
  }
  ctx.stdout.write(`renamed to: ${name}\n`);
  return 0;
}
