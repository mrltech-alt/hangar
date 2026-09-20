import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote, shellJoin } from './shell-quote.ts';

function roundTrip(value: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
}

describe('shellQuote', () => {
  it('wraps plain words in single quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'");
  });
  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it.each(['plain', 'two words', "it's", '$HOME `id` "x"', 'new\nline', 'back\\slash', ''])(
    'round-trips %j through /bin/sh',
    (value) => {
      expect(roundTrip(value)).toBe(value);
    },
  );
});

describe('shellJoin', () => {
  it('joins quoted args with spaces', () => {
    expect(shellJoin(['claude', '--name', 'Fix it'])).toBe("'claude' '--name' 'Fix it'");
  });
  it('returns an empty string for no args', () => {
    expect(shellJoin([])).toBe('');
  });
  it('escapes inside a join, not only in isolation', () => {
    expect(shellJoin(['--name', "it's"])).toBe("'--name' 'it'\\''s'");
  });
  // `set --` rather than `for a in $x`, so an empty argument survives word splitting.
  it('round-trips a whole argv through /bin/sh, empty argument included', () => {
    const argv = ['plain', "it's", '$HOME `id`', 'two words', '', 'new\nline'];
    const script = `set -- ${shellJoin(argv)}; for a in "$@"; do printf '%s\\n' "$a"; done`;
    const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    expect(out).toBe(argv.join('\n') + '\n');
  });
});
