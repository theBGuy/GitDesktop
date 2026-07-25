/** How long an agent-CLI review may run before the backend kills it, in
 *  minutes. `"auto"` keeps the backend's tier defaults (5 minutes for a plain
 *  review, 20 for an agentic one); the others pin a fixed limit. Stored as
 *  strings so the value binds to the settings `Select` directly. */
export type ReviewTimeout = "auto" | "10" | "15" | "20" | "30" | "45" | "60";

/** The `agent_review` override in seconds, or `null` for `"auto"`/absent (the
 *  backend's tier defaults apply). The backend clamps to 60–7200. */
export function reviewTimeoutSecs(t: ReviewTimeout | undefined): number | null {
  if (!t || t === "auto") return null;
  // Don't trust the union at runtime — settings.json is hand-editable.
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n * 60 : null;
}
