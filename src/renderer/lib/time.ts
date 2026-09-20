import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Wall-clock `hh:mm` for the drawer's "Saved · 12:04" stamp (spec §12.5).
 *
 * Both accessors are LOCAL — never `getHours()` with `getUTCMinutes()` (G54). The suite pins
 * `TZ=UTC`, where the two families always agree, so `time.test.ts` re-runs this under
 * `Asia/Kolkata`: 09:05Z is 14:35 there, and a mixed pair renders 14:05.
 *
 * Not `toLocaleTimeString`, which the plan reached for: under `en-US` it returns "10:00 AM", so the
 * indicator would read "Saved · 10:00 AM" rather than the spec's "Saved · 12:04", and the string
 * would change shape with the machine's locale.
 */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
