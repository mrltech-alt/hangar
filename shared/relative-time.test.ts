import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time.ts';

const now = new Date('2026-09-07T12:00:00Z').getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('relativeTime', () => {
  it('returns — for null', () => expect(relativeTime(null, now)).toBe('—'));
  it('< 60s → now', () => expect(relativeTime(ago(30_000), now)).toBe('now'));
  it('minutes', () => expect(relativeTime(ago(4 * 60_000), now)).toBe('4m'));
  it('hours', () => expect(relativeTime(ago(2 * 3_600_000), now)).toBe('2h'));
  it('< 7 days → weekday', () => expect(relativeTime(ago(3 * 86_400_000), now)).toBe('Fri'));
  it('≥ 7 days → day + short month', () => expect(relativeTime(ago(10 * 86_400_000), now)).toBe('28 Aug'));
  it('future timestamps clamp to now', () => expect(relativeTime(ago(-5_000), now)).toBe('now'));

  // Without this, the whole suite runs under the TZ=UTC pin in vitest.config.ts, where
  // getDay() and getUTCDay() agree for every input — so reverting to the UTC getters would
  // leave every other test green. This is the only assertion that can tell them apart.
  it('formats weekday/date in the viewer local zone, not UTC', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      expect(relativeTime('2026-09-04T12:00:00Z', now)).toBe('Sat');    // 'Fri' in UTC
      expect(relativeTime('2026-08-28T12:00:00Z', now)).toBe('29 Aug'); // '28 Aug' in UTC
    } finally {
      process.env.TZ = prev;
    }
  });
});
