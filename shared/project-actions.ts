/**
 * Project actions (spec §15.4): user-authored command buttons.
 *
 * ## Where an action runs
 *
 * It does not run. Clicking one **types** the command at the agent's own prompt over
 * `session:write` and stops there; the user reads what appeared and presses Enter. The alternative
 * — a detached `execFile`/`spawn` the way `worktree-setup.runPostCreate` does it — was weighed and
 * rejected: that path needs a 64 KiB-capped line forwarder, a timeout that SIGKILLs the whole
 * descendant tree (an interactive shell ignores SIGTERM, G43, and a job-controlled child has its own
 * process group, G38), a place to put the output, and a way for the user to interrupt it. The PTY
 * already has all four, plus the login shell, the env and the worktree cwd the user expects.
 * `runPostCreate` carries that machinery because it runs unattended at worktree creation; an action
 * is a button a human just pressed while looking at the terminal it types into.
 *
 * ## What that costs
 *
 * The whole model rests on the typed bytes being unable to submit themselves. A `\r` in a command
 * would press Enter for the user; U+0003 (send-break) or U+0015 (kill-line) would be eaten by the
 * line editor before any parser saw them, and U+001B would be read as an escape sequence by
 * whatever TUI is at the prompt (G33 — quoting cannot defend against a byte the line editor
 * consumes first, verified on this project against a real PTY). Quoting is therefore not the tool
 * here, and neither is `shellQuote`: the command is a whole command line, not an argument, exactly
 * like `postCreate`, and wrapping it would turn `npm test && npm run lint` into one unrunnable word.
 *
 * So `actionKeystrokes` — the ONLY function that may produce the bytes handed to `session:write` —
 * strips the control-character class, and `ProjectActionSchema` (shared/workspace-schema.ts)
 * refuses to persist or accept a command containing one. Two independent guards on purpose: the
 * schema stops a hostile value from ever being stored, and the strip means that even a value that
 * reached a `Project` some other way (a future migration, a `.catch()` recovery, a fixture) cannot
 * reach the line editor.
 *
 * Pure and zod-free so `shared/module-load.test.ts` can load it under raw Node and so the renderer
 * gets it without a schema dependency.
 */
import { stripControlChars } from './agent-name.ts';
import { ACTION_COMMAND_MAX, ACTION_LABEL_MAX, PROJECT_ACTIONS_MAX } from './constants.ts';
import type { ProjectAction } from './types.ts';

/** The separator between a label and its command in the settings textarea, e.g. `Tests = npm test`. */
const SEPARATOR = '=';

/**
 * The exact bytes an action types into the PTY.
 *
 * Total by construction — it never throws and never returns something that can submit itself —
 * because it is the last thing between a stored string and a live interactive shell, and the two
 * callers upstream of it (the schema and the settings dialog) are both bypassable in principle.
 *
 * The slice is by CODE POINT, not UTF-16 unit: cutting 500 units through a surrogate pair leaves a
 * lone surrogate, which is invalid UTF-8 when written to a PTY. Same reasoning as `cleanAgentName`.
 */
export function actionKeystrokes(command: string): string {
  // Strip first, then trim: `.trim()` does not touch interior control characters, and the strip
  // REPLACES each with a space rather than deleting it, so `npm test\rrm -rf ~` becomes the single
  // harmless line `npm test rm -rf ~` instead of silently concatenating into `npm testrm -rf ~`.
  const cleaned = stripControlChars(command).trim();
  return Array.from(cleaned).slice(0, ACTION_COMMAND_MAX).join('');
}

/**
 * The bytes the "add a project to this agent" flow (§12.6) types at a RUNNING session's prompt.
 *
 * The second caller of `session:write` in the app, and it goes through `actionKeystrokes` rather
 * than building its own string for the reason that function's header gives: a worktree path is
 * data, the bytes land in a live line editor, and one sanitiser with one set of tests is the only
 * way the two writers cannot drift. There is no trailing newline here either — the user reads what
 * appeared and presses Enter, exactly as for an action.
 *
 * Why anything is typed at all: `--add-dir` is composed once at launch
 * (`src/main/services/claude-launch.ts`), so a workspace added to a session that is already running
 * is not in that session's argv and cannot be. `/add-dir` is Claude Code's own command for handing
 * one over afterwards; what happens when the user submits it is Claude Code's business, and the
 * dialog's toast is worded as an instruction rather than a promise because this side cannot observe
 * the result.
 */
export function addDirKeystrokes(worktreePath: string): string {
  return actionKeystrokes(`/add-dir ${worktreePath}`);
}

/**
 * One settings-textarea line → an action, or null when the line carries no action.
 *
 * `indexOf`, not `split`: a command may itself contain `=` (`FOO=1 npm test`), and only the FIRST
 * separator divides label from command. A line with no separator at all is taken as a command whose
 * label is the command — the shortest useful thing to do with `npm test` typed on its own.
 */
function parseActionLine(line: string): ProjectAction | null {
  const cut = line.indexOf(SEPARATOR);
  const rawLabel = cut === -1 ? line : line.slice(0, cut);
  const rawCommand = cut === -1 ? line : line.slice(cut + 1);
  // Both sides go through the same strip as the keystrokes, so what the dialog shows back after a
  // save is what the button will actually type — a label sanitised on one path and not the other is
  // how a user ends up trusting a preview that does not match.
  const label = stripControlChars(rawLabel).trim();
  const command = stripControlChars(rawCommand).trim();
  if (label.length === 0 || command.length === 0) return null;
  return { label, command };
}

/** The settings textarea (one `label = command` per line) → the list the contract stores. */
export function parseActionLines(text: string): ProjectAction[] {
  const out: ProjectAction[] = [];
  for (const line of text.split('\n')) {
    const action = parseActionLine(line);
    if (action !== null) out.push(action);
  }
  return out;
}

/** The list → the settings textarea. Round-trips: `parseActionLines(formatActionLines(a))` is `a`
 *  for any list this module produced (see `project-actions.test.ts`). */
export function formatActionLines(actions: readonly ProjectAction[]): string {
  return actions.map((a) => `${a.label} ${SEPARATOR} ${a.command}`).join('\n');
}

/**
 * Why this list cannot be saved, or null.
 *
 * Deliberately a REPORT rather than a repair. `parseActionLines` already sanitises (control
 * characters, whitespace, empty lines) because those changes are invisible to the user's intent,
 * but a command that is too long must not be silently truncated: running the first 500 characters
 * of a 600-character command line is a different command, and `npm test && rm -rf build` truncated
 * mid-word is exactly the shape that goes wrong quietly. So the dialog disables Save and says which
 * line is at fault, the same way it already does for a project name that is not a directory segment.
 */
export function actionsProblem(actions: readonly ProjectAction[]): string | null {
  if (actions.length > PROJECT_ACTIONS_MAX) return `at most ${PROJECT_ACTIONS_MAX} actions (there are ${actions.length})`;
  for (const a of actions) {
    if (a.label.length > ACTION_LABEL_MAX) return `label "${a.label.slice(0, 20)}…" is longer than ${ACTION_LABEL_MAX} characters`;
    if (a.command.length > ACTION_COMMAND_MAX) return `the command for "${a.label}" is longer than ${ACTION_COMMAND_MAX} characters`;
  }
  return null;
}
