import { CLI_REPLY_TIMEOUT_MS } from '../../shared/constants.ts';
import type { CliContext } from '../context.ts';
import { requestOnce } from '../socket.ts';

export async function runHost(args: string[], ctx: CliContext): Promise<number> {
  const sub = args[0];
  if (sub === 'status') {
    const reply = await requestOnce(ctx.socketPath, { t: 'list', seq: 1 }, CLI_REPLY_TIMEOUT_MS);
    if (reply === null || reply.t !== 'sessions') {
      ctx.stdout.write(`host: not running (${ctx.socketPath})\n`);
      return 1;
    }
    ctx.stdout.write(`host: running, ${reply.sessions.length} session(s)\n`);
    for (const s of reply.sessions) {
      const state = s.exited ? `exited(${s.exitCode})` : 'running';
      ctx.stdout.write(`- ${s.id} pid=${s.pid} ${state} ${s.cols}x${s.rows} attached=${s.attached} ${s.cwd}\n`);
    }
    return 0;
  }
  if (sub === 'stop') {
    const reply = await requestOnce(ctx.socketPath, { t: 'shutdown', killSessions: true, seq: 1 }, CLI_REPLY_TIMEOUT_MS);
    if (reply === null) {
      ctx.stdout.write(`host: not running (${ctx.socketPath})\n`);
      return 1;
    }
    ctx.stdout.write('host: shutdown requested; all sessions will be stopped\n');
    return 0;
  }
  ctx.stderr.write('usage: hangar host status|stop\n');
  return 1;
}
