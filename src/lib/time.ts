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
