/**
 * Project actions (spec §15.4). The security-relevant half of this module is `actionKeystrokes`:
 * it produces the bytes handed to `session:write`, which go straight into a live `$SHELL -il` PTY,
 * so the tests below are about what it CANNOT emit rather than what it formats.
 *
 * Every control character in these tests is written as an escape, never as a literal byte (G46/G48:
 * a literal one passes vitest, tsc and eslint while making `grep`, `diff` and `file(1)` treat this
 * file as binary).
 */
import { describe, expect, it } from 'vitest';
import { ACTION_COMMAND_MAX, ACTION_LABEL_MAX, PROJECT_ACTIONS_MAX } from './constants.ts';
import { actionKeystrokes, actionsProblem, addDirKeystrokes, formatActionLines, parseActionLines } from './project-actions.ts';
import type { ProjectAction } from './types.ts';

const CONTROL_CHARS = [
  '\u0000', // NUL - G48; also ERR_INVALID_ARG_VALUE anywhere near Node's fs layer
  '\u0003', // ^C, send-break: the line editor discards the buffer before any parser runs (G33)
  '\u0015', // ^U, kill-line: same, and it eats what was already typed
  '\u001b', // ESC: an escape sequence to xterm, and "interrupt" to Claude Code's TUI
  '\r',     // the one that matters most: it PRESSES ENTER for the user
  '\n',
  '\u007f', // DEL
];

describe('actionKeystrokes', () => {
  it('leaves an ordinary command exactly as written', () => {
    expect(actionKeystrokes('npm test -- --run')).toBe('npm test -- --run');
    // Shell metacharacters are NOT escaped and must not be: the user is authoring a command line,
    // the same way `postCreate` is, and quoting it would turn this into one unrunnable word.
    expect(actionKeystrokes('npm ci && npm run build | tee $LOG')).toBe('npm ci && npm run build | tee $LOG');
  });

  // THE test. Everything else in this feature is convenience; this is the whole safety model.
  it('cannot emit a byte that submits the line or that the line editor eats first', () => {
    for (const ch of CONTROL_CHARS) {
      const out = actionKeystrokes(`echo hi${ch}rm -rf ~`);
      expect(out, `for U+${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`).not.toContain(ch);
      // Replaced with a space, not deleted: deleting would splice `hi` onto `rm` and quietly
      // produce a DIFFERENT command (`echo hirm -rf ~`) rather than an obviously inert one.
      expect(out).toBe('echo hi rm -rf ~');
    }
  });

  it('strips a trailing carriage return rather than leaving a command that runs itself', () => {
    // The shape a hostile hand-edited workspace.json would use: the payload looks innocent in the
    // menu, and the CR at the end submits it the instant it is typed.
    expect(actionKeystrokes('npm test\r')).toBe('npm test');
    expect(actionKeystrokes('npm test\r\n')).toBe('npm test');
  });

  it('trims after stripping, because trim alone does not touch interior control characters', () => {
    expect(actionKeystrokes('  \u0003 npm test \u0015  ')).toBe('npm test');
  });

  it('slices by code point, so an over-long command cannot end in a lone surrogate', () => {
    // A high surrogate not followed by a low one, or a low one not preceded by a high one.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // One ASCII character first, so the naive UTF-16 cut lands at an ODD offset and therefore
    // inside a surrogate pair — an all-emoji string is cut cleanly at an even limit and would make
    // the control below vacuous.
    const long = `x${'🚀'.repeat(ACTION_COMMAND_MAX + 10)}`;
    const out = actionKeystrokes(long);
    expect(Array.from(out).length).toBe(ACTION_COMMAND_MAX);
    expect(loneSurrogate.test(out)).toBe(false);
    expect(out.startsWith('x🚀')).toBe(true);
    expect(out.endsWith('🚀')).toBe(true);
    // The control: the obvious `command.slice(0, ACTION_COMMAND_MAX)` cuts a surrogate pair in half
    // on this exact input, and a lone surrogate is invalid UTF-8 the moment it reaches a PTY. Without
    // this line the assertion above would pass for any implementation, including a naive one.
    expect(loneSurrogate.test(long.slice(0, ACTION_COMMAND_MAX))).toBe(true);
  });

  it('is total: empty and all-control input produce nothing to type', () => {
    expect(actionKeystrokes('')).toBe('');
    expect(actionKeystrokes('\u0003\u0015\r\n')).toBe('');
  });
});

describe('addDirKeystrokes', () => {
  it('types the slash command and the path, with nothing that could submit it', () => {
    expect(addDirKeystrokes('/wt/hangar/alpha')).toBe('/add-dir /wt/hangar/alpha');
  });

  // The reason this delegates instead of interpolating. A worktree path is `project.name` (a repo
  // BASENAME, whatever the filesystem allowed) joined with a slug, so it is not a literal this
  // module controls — and these bytes go to the same live line editor an action's do.
  it('cannot emit a byte that submits the line', () => {
    for (const ch of CONTROL_CHARS) {
      const out = addDirKeystrokes(`/wt/a${ch}rm -rf ~`);
      expect(out, `for U+${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`).not.toContain(ch);
      expect(out).toBe('/add-dir /wt/a rm -rf ~');
    }
  });

  // The control for the test above: the interpolation it replaced passes every other assertion
  // here and fails only this one, which is the whole point of routing through `actionKeystrokes`.
  it('is not a bare template literal — the naive form keeps the carriage return', () => {
    expect(`/add-dir ${'/wt/a\rrm -rf ~'}`).toContain('\r');
    expect(addDirKeystrokes('/wt/a\rrm -rf ~')).not.toContain('\r');
  });
});

describe('parseActionLines', () => {
  it('splits on the FIRST separator, so a command may contain one', () => {
    expect(parseActionLines('Env = FOO=1 npm test')).toEqual([{ label: 'Env', command: 'FOO=1 npm test' }]);
  });

  it('takes a line with no separator as its own label', () => {
    expect(parseActionLines('npm test')).toEqual([{ label: 'npm test', command: 'npm test' }]);
  });

  it('drops blank lines and lines with an empty half', () => {
    expect(parseActionLines('Tests = npm test\n\n   \n= npm run lint\nBuild =\n  Lint  =  npm run lint  ')).toEqual([
      { label: 'Tests', command: 'npm test' },
      { label: 'Lint', command: 'npm run lint' },
    ]);
  });

  // The parse and the keystrokes must sanitise identically, or the dialog shows the user a preview
  // of something other than what the button will type.
  it('sanitises both halves the same way actionKeystrokes does', () => {
    const [action] = parseActionLines('Te\u0003sts = npm test\u0015x');
    expect(action).toEqual({ label: 'Te sts', command: 'npm test x' });
    expect(actionKeystrokes(action!.command)).toBe(action!.command);
  });

  it('round-trips through formatActionLines', () => {
    const actions: ProjectAction[] = [
      { label: 'Tests', command: 'npm test' },
      { label: 'Env', command: 'FOO=1 npm test' },
      { label: 'Build', command: 'npm ci && npm run build' },
    ];
    expect(parseActionLines(formatActionLines(actions))).toEqual(actions);
  });

  it('formats an empty list as an empty textarea, not a blank line', () => {
    expect(formatActionLines([])).toBe('');
    expect(parseActionLines('')).toEqual([]);
  });
});

describe('actionsProblem', () => {
  const ok = (n: number): ProjectAction[] => Array.from({ length: n }, (_, i) => ({ label: `a${i}`, command: 'npm test' }));

  it('passes a list that is within every bound', () => {
    expect(actionsProblem([])).toBeNull();
    expect(actionsProblem(ok(PROJECT_ACTIONS_MAX))).toBeNull();
    expect(actionsProblem([{ label: 'x'.repeat(ACTION_LABEL_MAX), command: 'y'.repeat(ACTION_COMMAND_MAX) }])).toBeNull();
  });

  it('reports one over the bound on each of the three limits', () => {
    expect(actionsProblem(ok(PROJECT_ACTIONS_MAX + 1))).toContain(`at most ${PROJECT_ACTIONS_MAX}`);
    expect(actionsProblem([{ label: 'x'.repeat(ACTION_LABEL_MAX + 1), command: 'npm test' }])).toContain('label');
    expect(actionsProblem([{ label: 'Tests', command: 'y'.repeat(ACTION_COMMAND_MAX + 1) }])).toContain('Tests');
  });

  // Deliberately a report, not a repair: truncating a 600-character command to 500 runs a DIFFERENT
  // command, and `npm test && rm -rf build` cut mid-word is exactly how that goes wrong quietly.
  it('does not repair the list it complains about', () => {
    const tooLong = [{ label: 'Tests', command: 'y'.repeat(ACTION_COMMAND_MAX + 1) }];
    expect(actionsProblem(tooLong)).not.toBeNull();
    expect(tooLong[0]!.command.length).toBe(ACTION_COMMAND_MAX + 1);
  });
});
