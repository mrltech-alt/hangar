/**
 * POSIX single-quote quoting: safe as shell *syntax* for zsh/bash/sh. Empty string → ''.
 *
 * Produces exactly ONE shell word. `shellQuote('--model opus')` is a single argument, not two;
 * callers that want two must pass two array elements (this is why the project-args UI asks for
 * one argument per line).
 *
 * NOT sufficient to make a value safe to *type* into a live interactive shell. Hangar's PTY
 * startup command is typed rather than exec'd (spec §8.2), and the line editor consumes control
 * bytes before the parser sees these quotes — `\x03` or `\x15` discards the buffer including the
 * opening quote. Stripping control characters is the caller's job; `composeStartupCommand` does it.
 *
 * Do not use this to build a command for `execFile`/`spawn` — pass an argument array instead —
 * and never apply it to a value that is already a whole command line (e.g. a project's
 * `postCreate` script, which is passed as one argument to `$SHELL -ilc`).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Joins arguments into a shell-safe command line. Every argument is quoted, including ones that
 * would not strictly need it: a "quote only when necessary" variant needs a safe-character
 * allowlist, and that allowlist is the only place a quoting bug could hide. The cosmetic cost in
 * the user's scrollback is worth having nothing to get wrong.
 *
 * Does not include a command word — see `composeStartupCommand`, which leaves that unquoted.
 */
export function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(' ');
}
