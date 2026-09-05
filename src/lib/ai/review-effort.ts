import { isCliProvider } from "./providers";
import type { AiProviderId } from "./types";

/** The Review-effort choices offered in Settings, in render order. The
 *  `ReviewEffort` union derives from this list, so the Settings labels map
 *  stays exhaustive and the menu can't silently drop an option. */
export const REVIEW_EFFORTS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** How hard an agent-CLI review reasons. `"auto"` sends nothing — the CLI's
 *  own configured default governs, exactly as before the setting existed. */
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** Whether `provider`'s reviews honor the Review-effort setting: the agent
 *  CLIs with a reasoning lever the review path drives (Claude a thinking
 *  keyword, Copilot `--effort`, opencode `--variant`). Codex is deliberately
 *  out — its reasoning config tops out at "high", so the scale's Max would
 *  overpromise — and the HTTP providers have no effort plumbing at all. */
export function reviewEffortCapable(provider: AiProviderId): boolean {
  return isCliProvider(provider) && provider !== "codex-cli";
}

/** The `agent_review` effort level for a review on `provider`, or `""` (the
 *  CLI's own default — Rust then omits the flag/keyword). Don't trust the
 *  union at runtime: settings.json is hand-editable, so anything outside the
 *  known levels resolves to `""`, and a non-capable provider always does. */
export function reviewEffortLevel(
  provider: AiProviderId,
  effort: ReviewEffort | undefined,
): string {
  if (!effort || effort === "auto" || !reviewEffortCapable(provider)) {
    return "";
  }
  return REVIEW_EFFORTS.includes(effort) ? effort : "";
}
