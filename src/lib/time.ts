// Largest-first. `rollupAt` is the whole count of this unit that equals one of
// the next-larger unit — the human conversion (60 min = 1 hour, 24 h = 1 day,
// 7 d = 1 week, 12 mo = 1 year). It's the intended conversion, NOT derived from
// the second ratios: 365/30 ≈ 12.16 and 30/7 ≈ 4.29 would misfire otherwise.
// `year` has no larger unit, so its rollup is unused (Infinity).
const UNITS: {
  unit: Intl.RelativeTimeFormatUnit;
  seconds: number;
  rollupAt: number;
}[] = [
  {
    unit: "year",
    seconds: 365 * 24 * 3600,
    rollupAt: Number.POSITIVE_INFINITY,
  },
  { unit: "month", seconds: 30 * 24 * 3600, rollupAt: 12 },
  // Weeks never reach a month here (max ~4.28w before the month unit takes
  // over), so 5 keeps a real "4 weeks ago" from collapsing to "1 month ago".
  { unit: "week", seconds: 7 * 24 * 3600, rollupAt: 5 },
  { unit: "day", seconds: 24 * 3600, rollupAt: 7 },
  { unit: "hour", seconds: 3600, rollupAt: 24 },
  { unit: "minute", seconds: 60, rollupAt: 60 },
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** A duration as a compact human string: `< 60s` → `"42s"` (seconds floored,
 *  minimum `"0s"`); `< 1h` → `"3m 12s"` (seconds unpadded); `>= 1h` → `"1h 2m"`.
 *  Non-finite or negative input clamps to `"0s"`. Used for run elapsed/duration
 *  where a coarse "how long" reads better than a precise timestamp. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

/** Whether `formatRelativeTime` can read this date. String-context callers must
 *  check it themselves — they compose the result into a larger string, so they
 *  get no benefit from `<RelativeTime>`'s own guard against "in NaN years".
 *  Deliberately string-only: `new Date(null)` is epoch-0, so a widened
 *  nullable predicate would call null "parseable" — nullable callers keep
 *  their `x && parseableDate(x)` prefix. */
export function parseableDate(iso: string): boolean {
  return !Number.isNaN(new Date(iso).getTime());
}

/** Whether an epoch-ms number is inside `Date`'s representable range, so
 *  `new Date(t).toISOString()` won't throw. Range, not finiteness, is the real
 *  gate: `JSON.parse("1e999")` mints `Infinity`, and an oversized finite like
 *  `1e20` clears `Number.isFinite` yet still throws past the ±8.64e15 bound. */
export function validEpochMs(t: number): boolean {
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15;
}

/** The span between two ISO timestamps, as `"42s"` / `"3m"` / `"3m 12s"` /
 *  `"1h 2m"` — the coarse CI-run format (a whole minute drops the seconds,
 *  unlike `formatDuration`). Returns `""` when either end is missing,
 *  unparseable, or out of order: an unfinished run has no span to state, and a
 *  live counter (`<ElapsedTime>`) is the caller's job. */
export function formatDurationBetween(start?: string, end?: string): string {
  if (!start || !end) return "";
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return "";
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "8 months ago", "2 hours ago", "just now". `now` defaults to the current
 *  time; callers that render many timestamps together (RelativeTime) pass one
 *  shared snapshot so simultaneously-mounted rows never disagree about the same
 *  date — and passing it explicitly keeps the React Compiler's memo key aware of
 *  the clock (a bare `Date.now()` read is invisible to it, freezing the output). */
export function formatRelativeTime(
  isoDate: string,
  now: number = Date.now(),
): string {
  const seconds = (now - new Date(isoDate).getTime()) / 1000;
  // Largest-first: pick the first unit the elapsed time reaches.
  for (let i = 0; i < UNITS.length; i++) {
    const { unit, seconds: unitSeconds, rollupAt } = UNITS[i];
    if (Math.abs(seconds) < unitSeconds) continue;
    const count = Math.round(seconds / unitSeconds);
    // Rounding can push the count up to the next-larger unit's boundary (23.6h
    // rounds to 24h, which is "1 day"). When it reaches that conversion, emit
    // the larger unit instead — never "24 hours"/"60 minutes"/"7 days"/etc.
    const larger = UNITS[i - 1];
    if (larger && Math.abs(count) >= rollupAt) {
      return rtf.format(-Math.round(seconds / larger.seconds), larger.unit);
    }
    return rtf.format(-count, unit);
  }
  return "just now";
}
