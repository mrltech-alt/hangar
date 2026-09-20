import { describe, expect, it } from 'vitest';
import { FIELD_SEP, FIELD_SEP_PRINTF, extractBetween, sentinels } from './shell-probe.ts';

describe('sentinels', () => {
  it('frames the payload with the nonce, so a different nonce cannot see it', () => {
    const a = sentinels('aaaaaaaaaaaaaaaa');
    const b = sentinels('bbbbbbbbbbbbbbbb');
    expect(a.begin).not.toBe(b.begin);
    expect(a.end).not.toBe(b.end);

    // The invariant the whole design rests on: rc files can only forge a marker they can PREDICT.
    // Position is not a defence — `.zshrc` output precedes ours and `.zlogout` output follows it —
    // so a payload framed with one nonce must be invisible to another's sentinels.
    const payload = `${a.begin}/real/bin${FIELD_SEP}/real/node${a.end}`;
    expect(extractBetween(payload, b.begin, b.end)).toBeNull();
    expect(extractBetween(payload, a.begin, a.end)).toBe(`/real/bin${FIELD_SEP}/real/node`);
  });
});

describe('extractBetween', () => {
  it('returns the text between sentinels, ignoring noise on both sides', () => {
    const { begin, end } = sentinels('0123456789abcdef');
    // Noise AFTER matters as much as noise before: `$SHELL -ilc` is a login shell, so `.zlogout`
    // prints once the command has already produced its output.
    expect(extractBetween(`banner\n${begin}a${FIELD_SEP}b${end}\nGoodbye.`, begin, end)).toBe(`a${FIELD_SEP}b`);
    expect(extractBetween('no sentinels', begin, end)).toBeNull();
    // An opened but unclosed payload is not a payload — that omission let trailing shell output
    // land inside doctor's last field.
    expect(extractBetween(`${begin}a${FIELD_SEP}b`, begin, end)).toBeNull();
  });
});

describe('FIELD_SEP', () => {
  it('is U+001F, with an octal printf escape', () => {
    expect(FIELD_SEP).toHaveLength(1);
    expect(FIELD_SEP.codePointAt(0)).toBe(0x1f);
    // Octal because `\x1f` is a bash/zsh extension: measured, dash's builtin printf and
    // /usr/bin/printf both emit it literally.
    expect(FIELD_SEP_PRINTF).toBe('\\037');
  });
});
