import { SLUG_MAX } from './constants.ts';

/**
 * Agent display name → directory/branch-safe slug: [a-z0-9-], ≤ SLUG_MAX chars, never empty.
 *
 * The result is NOT unique. `Agent.slug` must be unique per project (spec §6.2), and it is
 * immutable once set, so callers creating an agent must resolve collisions with
 * `slugCandidate` rather than appending a suffix themselves.
 */
export function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/g, '');
  return s.length === 0 ? 'agent' : s;
}

/**
 * The nth unique-slug candidate for `base` (n ≤ 1 → `base` unchanged), still ≤ SLUG_MAX chars.
 *
 * Do NOT write `slugify(`${base}-${n}`)` instead: for a base already at SLUG_MAX that truncates
 * the suffix straight back off and returns `base` for every n, so a caller probing for a free
 * name would test the same taken candidate 999 times. Room for the suffix is made here.
 */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '') + suffix;
}
