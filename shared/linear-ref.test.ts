import { describe, expect, it } from 'vitest';
import { linearIssueUrl, parseLinearRef } from './linear-ref.ts';

describe('parseLinearRef', () => {
  it('reads the identifier out of an issue URL, with or without the slug, query and hash', () => {
    expect(parseLinearRef('https://linear.app/acme/issue/AC-3461')).toBe('AC-3461');
    expect(parseLinearRef('https://linear.app/acme/issue/AC-3461/0-click-payments-when-the-user-buys-a-subscription')).toBe('AC-3461');
    expect(parseLinearRef('https://linear.app/acme/issue/AC-3461/slug?utm=x#comment-1a2b')).toBe('AC-3461');
    expect(parseLinearRef('  https://linear.app/acme/issue/AC-3461/  ')).toBe('AC-3461');
  });

  it('accepts any workspace and any team key', () => {
    expect(parseLinearRef('https://linear.app/acme-inc/issue/ENG2-7/x')).toBe('ENG2-7');
  });

  it('accepts a bare identifier in any case, and uppercases it', () => {
    expect(parseLinearRef('AC-3461')).toBe('AC-3461');
    expect(parseLinearRef('ac-3461')).toBe('AC-3461');
    expect(parseLinearRef(' Ac-3461 ')).toBe('AC-3461');
  });

  it('bounds the team key at ten characters and the number at nine digits', () => {
    expect(parseLinearRef('ABCDEFGHIJ-1')).toBe('ABCDEFGHIJ-1');
    expect(parseLinearRef('ABCDEFGHIJK-1')).toBeNull();
    expect(parseLinearRef('AC-123456789')).toBe('AC-123456789');
    expect(parseLinearRef('AC-1234567890')).toBeNull();
  });

  // Linear never issues a zero or zero-padded number, so `AC-007` is not another spelling of `AC-7`.
  it('rejects a zero or zero-padded number, bare or in a URL', () => {
    for (const bad of ['AC-0', 'AC-007', 'https://linear.app/acme/issue/AC-007/slug', 'https://linear.app/acme/issue/AC-0']) {
      expect({ bad, ref: parseLinearRef(bad) }).toEqual({ bad, ref: null });
    }
    expect(parseLinearRef('AC-10')).toBe('AC-10');
  });

  // The URL parser lowercases the host, so a pasted `LINEAR.APP` is still Linear.
  it('accepts the host in any case', () => {
    expect(parseLinearRef('https://LINEAR.APP/acme/issue/AC-3461')).toBe('AC-3461');
    expect(parseLinearRef('HTTPS://Linear.App/acme/issue/ac-3461/slug')).toBe('AC-3461');
  });

  // A project URL is the likeliest wrong paste: it is the other thing a Linear sidebar links to.
  it('rejects project URLs, other hosts, other schemes and junk', () => {
    for (const bad of [
      '', '   ', 'AC', '3461', 'AC-', 'AC-34a', '-3461', 'AC 3461', 'AC-1 extra',
      'https://linear.app/acme/project/payments-3f2a1b',
      'https://linear.app/acme/issue/',
      'https://linear.app/acme/issue/not-an-id',
      'https://linear.app/acme/team/AC/active',
      'https://linear.app/acme/issue/AC-1/slug/extra',
      'http://linear.app/acme/issue/AC-1',
      'https://linear.app.evil.example/acme/issue/AC-1',
      'https://evil.example/acme/issue/AC-1',
      'linear.app/acme/issue/AC-1',
      'AC-1\nrm -rf ~',
    ]) {
      expect({ bad, ref: parseLinearRef(bad) }).toEqual({ bad, ref: null });
    }
  });
});

describe('linearIssueUrl', () => {
  it('rebuilds origin + path for a link to that exact ticket, dropping query and fragment', () => {
    expect(linearIssueUrl('https://linear.app/acme/issue/AC-3461/zero-click?x=1#c', 'AC-3461')).toBe('https://linear.app/acme/issue/AC-3461/zero-click');
    expect(linearIssueUrl('https://linear.app/acme/issue/AC-3461', 'AC-3461')).toBe('https://linear.app/acme/issue/AC-3461');
  });

  it('is null for a link to another ticket, a bare identifier, userinfo, and anything unparseable', () => {
    expect(linearIssueUrl('https://linear.app/acme/issue/AC-9/x', 'AC-3461')).toBeNull();
    expect(linearIssueUrl('AC-3461', 'AC-3461')).toBeNull();
    expect(linearIssueUrl('https://evil.example.com@linear.app/acme/issue/AC-3461/x', 'AC-3461')).toBeNull();
    expect(linearIssueUrl('', 'AC-3461')).toBeNull();
  });
});
