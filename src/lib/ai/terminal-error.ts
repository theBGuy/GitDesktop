/** Longest terminal text we will accept as an error reason — mirrors the
 *  runner-side error-shape tripwire's ceiling. */
const MAX_ERROR_TEXT = 300;

/**
 * The message for an errored terminal event, or `fallback` (the calling surface's own
 * generic copy) when the text isn't error-shaped. Short single-paragraph terminal text
 * on an errored run is the CLI's own error message (probe-verified); anything longer or
 * multi-paragraph is run output — a run failed by its terminal reason alone carries the
 * truncated body there, and presenting that as the reason is the bug this exists to stop.
 * Error-shape twins to keep aligned: `claude_result_is_error` / `has_blank_line`
 * (agent.rs) and `looksLikeProviderError` (automations/runner.ts).
 *
 * Deliberately a leaf module — the session stores and the streaming core import it, so it
 * must never pull in `cli-client` (which `client.ts` loads lazily) or any other ai/ module.
 */
export function terminalErrorMessage(
  text: string,
  fallback = "The run ended with an error.",
): string {
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_ERROR_TEXT ||
    /\n[ \t\r]*\n/.test(trimmed)
  ) {
    return fallback;
  }
  return trimmed;
}
