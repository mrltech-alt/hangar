import { CLI_REPLY_TIMEOUT_MS } from '../../shared/constants.ts';
import type { CliContext } from '../context.ts';
import { requestOnce } from '../socket.ts';

export type NoteMode = 'append' | 'replace' | 'clear';

export function parseNoteArgs(args: string[]): { mode: NoteMode; text: string } {
  let mode: NoteMode = 'append';
  const words: string[] = [];
  for (const a of args) {
    if (a === '--replace') mode = 'replace';
    else if (a === '--clear') mode = 'clear';
    else words.push(a);
  }
  return { mode, text: mode === 'clear' ? '' : words.join(' ').trim() };
}

export async function runNote(args: string[], ctx: CliContext): Promise<number> {
  const { mode, text } = parseNoteArgs(args);
  if (mode !== 'clear' && text.length === 0) {
    ctx.stderr.write('usage: hangar note <text> | hangar note --replace <text> | hangar note --clear\n');
    return 1;
  }
  if (ctx.agentId === null) {
    ctx.stderr.write('hangar: not inside a Hangar agent (HANGAR_AGENT_ID unset; use --agent <id>)\n');
    return 1;
  }
  const reply = await requestOnce(ctx.socketPath, { t: 'cli', agentId: ctx.agentId, cmd: 'note', payload: { mode, text } }, CLI_REPLY_TIMEOUT_MS);
  if (reply === null || reply.t !== 'ok') {
    ctx.stderr.write(`hangar: session host not reachable at ${ctx.socketPath}\n`);
    return 1;
  }
  ctx.stdout.write(mode === 'clear' ? 'notes cleared\n' : 'note saved\n');
  return 0;
}
