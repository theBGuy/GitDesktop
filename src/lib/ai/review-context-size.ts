/** The Review-context choices offered in Settings, in render order. The
 *  `ReviewContextSize` union derives from this list, so the Settings labels map
 *  stays exhaustive and the menu can't silently drop an option.
 *
 *  A leaf module rather than part of context-budget.ts, which the value list
 *  would otherwise pull into a cycle: settings/api.ts reads this list to heal a
 *  stored value, and context-budget.ts reaches api.ts through guarded-fetch. */
export const REVIEW_CONTEXT_SIZES = [
  "auto",
  "small",
  "medium",
  "large",
] as const;

/** How much diff + prior-discussion context an AI review sends, scaled to the
 *  reviewing model's context window. `"auto"` probes the window (live for
 *  Ollama, a per-provider fallback tier otherwise); the others force a fixed
 *  multiplier of the default budget profile. */
export type ReviewContextSize = (typeof REVIEW_CONTEXT_SIZES)[number];
