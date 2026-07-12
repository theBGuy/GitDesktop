// Shared Jira duration helpers, used by the time-tracking UI for inline
// validation and overage formatting. The backend re-validates every duration it
// receives; these run client-side so a bad grammar surfaces as a field warning
// before any network call.

/** One duration token: a number (optionally fractional) followed by a single
 *  unit — weeks/days/hours/minutes. Mirrors the Rust-side validator exactly. */
const JIRA_DURATION_TOKEN = /^\d+(\.\d+)?[wdhm]$/;

/** True when `s` is a valid Jira duration: one or more whitespace-separated
 *  tokens, each `<number><w|d|h|m>` (e.g. `"3h"`, `"1d 5h"`, `"2.5h"`), with at
 *  least one token. Mirrors the Rust-side validator so the inline field warning
 *  matches what the backend accepts. */
export function isValidJiraDuration(s: string): boolean {
  const tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => JIRA_DURATION_TOKEN.test(t));
}

/** Format a positive second-count as an overage delta in HOURS and MINUTES only
 *  (e.g. `"9h 30m"`, `"45m"`). Deliberately never days/weeks: the tenant's
 *  day-length is unknown to the client, so we never guess how many hours make a
 *  "day" — the caller appends " over". A zero/negative count yields `"0m"`. */
export function formatHmDelta(seconds: number): string {
  if (seconds <= 0) return "0m";
  // Round to whole minutes FIRST so the minute part stays in 0–59 (rounding the
  // remainder alone could emit "60m", e.g. 3570s).
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(m, 1)}m`;
}
