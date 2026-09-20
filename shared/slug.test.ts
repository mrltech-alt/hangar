import { describe, expect, it } from 'vitest';
import { slugCandidate, slugify } from './slug.ts';

describe('slugify', () => {
  it('lowercases and replaces runs of non-alphanumerics with single dashes', () => {
    expect(slugify('Fix Billing Webhooks')).toBe('fix-billing-webhooks');
    expect(slugify('AcmeApi:  fix / retries!!')).toBe('acmeapi-fix-retries');
  });
  it('strips quotes, unicode and leading/trailing dashes', () => {
    expect(slugify(`"Émigré's" café ☕ --test--`)).toBe('migr-s-caf-test');
  });
  it('falls back to "agent" when nothing survives', () => {
    expect(slugify('☕☕☕')).toBe('agent');
    expect(slugify('   ')).toBe('agent');
  });
  it('caps length at 40 without a trailing dash', () => {
    const s = slugify('a'.repeat(38) + '-bcdef');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
  // The case above cuts mid-word, so it never reaches the post-truncation dash strip.
  // This one truncates to exactly 40 chars ending in '-', exercising that branch, and
  // asserts the exact value so shortening the slice would fail rather than stay green.
  it('strips a dash left exactly on the truncation boundary', () => {
    expect(slugify('c'.repeat(39) + ' d')).toBe('c'.repeat(39));
  });
});

describe('slugCandidate', () => {
  it('returns the base unchanged for n <= 1', () => {
    expect(slugCandidate('fix-webhooks', 1)).toBe('fix-webhooks');
    expect(slugCandidate('fix-webhooks', 0)).toBe('fix-webhooks');
  });
  it('appends the suffix for n > 1', () => {
    expect(slugCandidate('fix-webhooks', 2)).toBe('fix-webhooks-2');
  });
  it('makes room for the suffix instead of overflowing SLUG_MAX', () => {
    const base = slugify('e'.repeat(45));
    expect(base).toHaveLength(40);
    expect(slugCandidate(base, 2)).toHaveLength(40);
    expect(slugCandidate(base, 999)).toHaveLength(40);
  });
  it('never leaves a doubled dash where the suffix meets a truncated base', () => {
    expect(slugCandidate('f'.repeat(37) + '-gh', 2)).toBe('f'.repeat(37) + '-2');
  });
  it('produces a distinct candidate for every n, even at max length', () => {
    const base = slugify('e'.repeat(45));
    const all = new Set(Array.from({ length: 999 }, (_, i) => slugCandidate(base, i + 1)));
    expect(all.size).toBe(999);
  });
});
