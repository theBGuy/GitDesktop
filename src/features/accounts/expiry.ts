/** Whole LOCAL calendar days from today until a `YYYY-MM-DD` date (negative when
 *  past). Pure date-to-date diff — no time-of-day/timezone math, so every surface
 *  shows the same count for the same stored date. Null when unparseable.
 *  A pre-Temporal runtime falls back to the legacy Date arithmetic rather than to
 *  null: this drives the Bitbucket token-expiry warning and macOS WKWebView ships
 *  no Temporal, so degrading would silence that warning on a whole platform. */
export function calendarDaysUntil(
  date: string | null | undefined,
): number | null {
  if (!date) return null;
  // Prefilter, not a formality: Temporal.PlainDate.from accepts more than the
  // stored contract allows (datetime strings among them).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  try {
    return Temporal.Now.plainDateISO().until(Temporal.PlainDate.from(date))
      .days;
  } catch {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    // LOCAL midnight of the stored date and of today; the difference is a whole number
    // of days once rounded (Math.round absorbs the ±1h DST wobble between the two).
    const target = new Date(year, month - 1, day).getTime();
    const now = new Date();
    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    return Math.round((target - today) / 86_400_000);
  }
}
