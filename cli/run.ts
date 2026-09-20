import { createContext, type CliContext, type CliIo } from './context.ts';
import { runEvent } from './commands/event.ts';
import { runRename } from './commands/rename.ts';
import { runNote } from './commands/note.ts';
import { runStatus } from './commands/status.ts';
import { runDoctor } from './commands/doctor.ts';
import { runHost } from './commands/host.ts';

export const USAGE = `usage: hangar <command> [options]

  event                 read a Claude Code hook payload on stdin and forward it (always exits 0)
  rename <name>         rename this agent in the Hangar sidebar
  note <text>           append a note to this agent (--replace to overwrite, --clear to empty)
  status [--json]       show this agent's name, projects, branches and worktrees
  doctor                check node-pty, the session host, node/claude versions and disk space
  host status|stop      inspect or stop the session host

  global options: --agent <id>  --home <dir>
`;

export type Command = (args: string[], ctx: CliContext) => Promise<number>;

/** Commands whose trailing arguments are free text written by an agent, not flags. */
const TEXT_COMMANDS = new Set(['rename', 'note']);

/**
 * Splits `--agent` / `--home` out of argv.
 *
 * Free text is NOT scanned for flags. `hangar note Blocked on --home support` used to lose two
 * words from the note AND silently repoint the socket at `support/run/host.sock`, so the agent got
 * a truncated note it never saved plus a "host not reachable" error with nothing to do with the
 * real cause. `rename` and `note` take text authored by an LLM, and §11.3's system prompt is what
 * teaches it to call them, so this is a live case rather than a pedantic one.
 *
 * The rules: options are read from the prefix before the command word, and after it only up to the
 * first non-flag token of a text command. `--` ends option parsing anywhere and is removed.
 */
export function splitGlobalOptions(argv: string[]): { rest: string[]; agent?: string; home?: string } {
  const rest: string[] = [];
  let agent: string | undefined;
  let home: string | undefined;
  let literal = false;   // everything after `--`
  let sawCommand = false;
  let textCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (literal) {
      rest.push(a);
      continue;
    }
    if (a === '--') {
      literal = true;
      continue;
    }
    if (a === '--agent' && i + 1 < argv.length) {
      agent = argv[++i];
      continue;
    }
    if (a === '--home' && i + 1 < argv.length) {
      home = argv[++i];
      continue;
    }
    if (!sawCommand && !a.startsWith('-')) {
      sawCommand = true;
      textCommand = TEXT_COMMANDS.has(a);
      rest.push(a);
      continue;
    }
    // First free-text token of `rename`/`note`: everything from here is the text.
    if (sawCommand && textCommand && !a.startsWith('-')) {
      literal = true;
    }
    rest.push(a);
  }
  return { rest, agent, home };
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { rest, agent, home } = splitGlobalOptions(argv);
  const ctx = createContext(env, io, { agent, home });
  const [cmd, ...args] = rest;
  switch (cmd) {
    case 'event':
      return runEvent(args, ctx);
    case 'rename':
      return runRename(args, ctx);
    case 'note':
      return runNote(args, ctx);
    case 'status':
      return runStatus(args, ctx);
    case 'doctor':
      return runDoctor(args, ctx);
    case 'host':
      return runHost(args, ctx);
    case undefined:
      io.stdout.write(USAGE);
      return 1;
    case 'help':
    case '-h':
    case '--help':
      io.stdout.write(USAGE);
      return 0;
    default:
      io.stderr.write(`hangar: unknown command "${cmd}"\n${USAGE}`);
      return 1;
  }
}
