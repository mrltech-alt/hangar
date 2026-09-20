// A Linear ticket reference — spec 2026-09-15 (linear agent) §4. Pure; runs under raw Node.

/**
 * `AC-3461`: a team key (a letter, then up to nine letters or digits), a hyphen, and a number of up
 * to nine digits with no leading zero — Linear numbers issues from 1, so `AC-0` and `AC-007` are not
 * identifiers and must not canonicalise to one.
 */
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,9})-([1-9]\d{0,8})$/;

const canonical = (m: RegExpExecArray): string => `${m[1]!.toUpperCase()}-${m[2]!}`;

/**
 * `https://linear.app/<workspace>/issue/<ID>[/<slug>][?…][#…]` or a bare `abc-123`, as `ABC-123`;
 * anything else is null.
 *
 * Strict on purpose. The identifier is interpolated into a model prompt, so this is the gate that
 * decides whether a look-up runs at all: `https:` only, the `linear.app` host exactly (a
 * `linear.app.evil.example` is a different host), and `/issue/` rather than `/project/`, which is the
 * other thing Linear's sidebar links to and the likeliest wrong paste.
 */
export function parseLinearRef(input: string): string | null {
  const text = input.trim();
  const bare = IDENTIFIER.exec(text);
  if (bare) return canonical(bare);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app') return null;
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length < 3 || segments.length > 4 || segments[1] !== 'issue') return null;
  const id = IDENTIFIER.exec(segments[2]!);
  return id ? canonical(id) : null;
}

/**
 * `text` as `origin + pathname`, but only when it is an https link to EXACTLY `ref` — otherwise null.
 *
 * Extracted from `linear-draft.ts`, where it was the private `ticketUrl`, because two features now
 * show a ticket link (the Notes block a triage writes, and the list row a pick comes from) and a
 * second copy of this rule is how one of them ends up laxer than the other. Userinfo is refused
 * outright: `https://evil.example.com@linear.app/…` does go to linear.app but reads as another host.
 * A query or fragment the source appended is dropped by rebuilding from origin and path.
 *
 * `text` is expected to be whitespace-collapsed already; callers with model- or API-supplied text
 * clean it first.
 */
export function linearIssueUrl(text: string, ref: string): string | null {
  if (parseLinearRef(text) !== ref) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null; // a bare `AC-3461` is a valid ref but not a URL
  }
  if (url.username !== '' || url.password !== '') return null;
  return `${url.origin}${url.pathname}`;
}
