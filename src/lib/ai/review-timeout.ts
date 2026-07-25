/** The Review-timeout choices offered in Settings, in render order — "auto"
 *  first (an integer-keyed object would enumerate numeric keys first and bury
 *  it). The `ReviewTimeout` union derives from this list, so the Settings
 *  labels map stays exhaustive and the menu can't silently drop an option. */
export const REVIEW_TIMEOUTS = [
  "auto",
  "10",
  "15",
  "20",
  "30",
  "45",
  "60",
] as const;

/** How long an agent-CLI review may run before the backend kills it, in
 *  minutes. `"auto"` keeps the backend's tier defaults (5 minutes for a plain
 *  review, 20 for an agentic one); the others pin a fixed limit. Stored as
 *  strings so the value binds to the settings `Select` directly. */
export type ReviewTimeout = (typeof REVIEW_TIMEOUTS)[number];

/** The `agent_review` override in seconds, or `null` for `"auto"`/absent (the
 *  backend's tier defaults apply). Don't trust the union at runtime —
 *  settings.json is hand-editable, and the wire needs an integral u64 (serde
 *  rejects fractional JSON numbers, which would fail every CLI review), so the
 *  value is rounded and saturated to the backend's accepted range here. The
 *  Rust clamp (60–7200) stays authoritative. */
export function reviewTimeoutSecs(t: ReviewTimeout | undefined): number | null {
  if (!t || t === "auto") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0
    ? Math.min(7200, Math.max(60, Math.round(n * 60)))
    : null;
}
