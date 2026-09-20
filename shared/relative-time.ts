const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact relative time for sidebar rows: now, 4m, 2h, Mon, 28 Aug.
 *
 * Weekday and date are formatted in LOCAL time, because that is the clock the user is reading.
 * Formatting in UTC would show the wrong day for any timestamp whose UTC date differs from the
 * viewer's — half of all timestamps at UTC+12, about 29% at UTC-7. Test determinism does not
 * require UTC: `nowMs` is injected, and `vitest.config.ts` pins `TZ=UTC` for the run.
 */
export function relativeTime(iso: string | null, nowMs: number = Date.now()): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, nowMs - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const d = new Date(then);
  if (days < 7) return WEEKDAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
