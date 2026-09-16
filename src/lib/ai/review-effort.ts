import type { AiProviderId } from "./types";

/** The reasoning levels that carry a real setting, in render order. Every effort
 *  surface derives its rows from this list, so a rename can't drift between
 *  them; the "no level" row stays per-surface, since both its stored value and
 *  its copy differ (`""`, a `"default"` sentinel, "the CLI's own setting"). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/** A reasoning level with a setting behind it — `ReviewEffort` minus `"auto"`. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** The words every effort picker shows. Record-typed against the derived union,
 *  so a level without a label and a label without a level are both compile
 *  errors. */
export const EFFORT_LEVEL_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};

/** The Review-effort choices offered in Settings, in render order. The
 *  `ReviewEffort` union derives from this list, so the Settings labels map
 *  stays exhaustive and the menu can't silently drop an option. */
export const REVIEW_EFFORTS = ["auto", ...EFFORT_LEVELS] as const;

/** How hard an agent-CLI review reasons. `"auto"` sends nothing — the CLI's
 *  own configured default governs, exactly as before the setting existed. */
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** The agent CLIs whose review path maps the Review-effort setting onto a real
 *  lever (Claude a thinking keyword, Copilot `--effort`, opencode `--variant`).
 *  Deliberately an allow-list, so a newly added CLI stays effort-hidden until
 *  `agent_review` actually maps its level. Codex is out — its reasoning config
 *  tops out at "high", so the scale's Max would overpromise — and the HTTP
 *  providers have no effort plumbing at all. */
const EFFORT_CLI_PROVIDERS: readonly AiProviderId[] = [
  "claude-cli",
  "copilot-cli",
  "opencode-cli",
];

/** Whether `provider`'s reviews honor the Review-effort setting. */
export function reviewEffortCapable(provider: AiProviderId): boolean {
  return EFFORT_CLI_PROVIDERS.includes(provider);
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
