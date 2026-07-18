// Small presentational formatters. No dependency — the desktop uses its own
// date libs, but the companion keeps its bundle tiny.

/** A compact relative time ("just now", "5m", "3h", "2d", "4w"). Empty/invalid
 *  input → "". */
export function timeAgo(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  const years = Math.floor(days / 365);
  // Guard on years, not weeks: at day 364, weeks is already 52 but years still
  // floors to 0 — a weeks-based cutoff would render "0y ago" for that window.
  if (years < 1) return `${weeks}w ago`;
  return `${years}y ago`;
}
