/**
 * The wire format of the login-shell probe: how `src/main/services/shell-env.ts` and
 * `cli/commands/doctor.ts` frame a `printf` payload and read it back (spec §9, G4/G5).
 *
 * One home for the framing, because both call sites had drifted into separate copies of it and each
 * copy grew its own defects. Pure string work — no `node:*` and no Node globals — so house rule 9
 * holds and both tsconfig projects can reach it. The random nonce is supplied by the caller for
 * that reason.
 */

/**
 * Field separator between payload fields, and the same character as an escape for the shell's
 * `printf` FORMAT STRING.
 *
 * ASCII Unit Separator (U+001F), not `|`: `|` is legal inside a PATH entry, and measured with
 * `PATH="/we|ird:$PATH"` every field sheared (path=`/we`, nodeBin=`ird:…`, claudeVersion=a path)
 * while the result was still reported as `source: 'shell'`.
 *
 * Octal `\037`, not `\x1f`: measured, `\x1f` yields the 1f byte under zsh, bash and sh but is
 * emitted literally by dash's builtin printf (`a\x1fb`) and by `/usr/bin/printf` (`ax1fb`), while
 * `\037` is POSIX and produced 1f under all four.
 */
// Written as an escape, never as the literal byte: a raw 0x1f in source renders as nothing in
// every diff, review and terminal, and one careless reformat silently changes the wire format.
export const FIELD_SEP = '\u001f';
export const FIELD_SEP_PRINTF = '\\037';

export interface Sentinels {
  begin: string;
  end: string;
}

/**
 * The sentinel pair for ONE probe, framed by a caller-supplied random nonce (hex, so it needs no
 * shell quoting).
 *
 * A fixed sentinel is forgeable by the very rc files this probe has to read past, and no position
 * is safe. A `.zshrc` printing the BEGIN marker beat `indexOf`; and because `$SHELL -ilc` is a
 * LOGIN shell, `.zlogout` runs AFTER the command, so its output beats `lastIndexOf` — measured, a
 * one-line `.zlogout` returned `/evil/node`, version `9.9.9` and `source: 'shell'`. The nonce is
 * the actual defence.
 *
 * It is NOT a trust boundary, and must not be mistaken for one. The shell can read the nonce out of
 * its own command line (`$ZSH_EXECUTION_STRING`, `ps`), and an rc file that does so can forge a
 * payload — verified. That costs nothing, because anyone who can write `.zlogout` can equally put
 * `/evil` first on `PATH` or define `node` as a function; the probe is downstream of total control
 * of the login shell. What the nonce buys is immunity to the accidents this actually sees: banners,
 * `.zlogout` greetings, an rc file echoing a literal marker, and collisions.
 */
export function sentinels(nonce: string): Sentinels {
  return { begin: `__HANGAR_${nonce}_BEGIN__`, end: `__HANGAR_${nonce}_END__` };
}

/**
 * The payload between one sentinel pair, or null if the pair is not present.
 *
 * `lastIndexOf` for `begin` is belt-and-braces only, now that the nonce does the real work: it
 * costs nothing and keeps a shell that somehow echoes the command line from winning over the
 * output it then produced.
 */
export function extractBetween(output: string, begin: string, end: string): string | null {
  const b = output.lastIndexOf(begin);
  if (b === -1) return null;
  const e = output.indexOf(end, b + begin.length);
  if (e === -1) return null;
  return output.slice(b + begin.length, e);
}
