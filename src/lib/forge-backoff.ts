// Import-free: scripts/forge-backoff.test.mjs imports this file through Node's
// type stripping, which resolves no aliases.

/** Forge kinds whose failures carry the forge's own answer (`AppError.kind`). */
const FORGE_KINDS = new Set(["gh", "glab", "bitbucket", "jira"]);

/** Rate-limit wording from gh, glab and the app's Bitbucket/Jira clients,
 *  mirroring Rust's `gh_error_is_rate_limit` and `GLAB_RATE_LIMIT_PHRASES`
 *  (forge/session.rs). Matched as substrings. */
const RATE_LIMIT_PHRASES = [
  "rate limit",
  "abuse detection",
  "too many requests",
];

/** 429 status tokens. Matched as whole words only: a bare 429 is as likely a
 *  URL path segment or an issue ref as a status. */
const RATE_LIMIT_STATUS = ["http 429", "(http 429)", "429 too many requests"];

/** gh's 401 wording (go-gh's `HTTP 401: Bad credentials (…)`) and the
 *  not-signed-in instruction gh and glab print. Matched as substrings. */
const AUTH_PHRASES = ["bad credentials", "auth login"];

/** 401 status tokens, whole words only for the same reason as the 429 ones. */
const AUTH_STATUS = ["http 401", "(http 401)", "401 unauthorized"];

/** Slack past the reset second, so the re-read doesn't land a hair early. */
export const RESET_GRACE_MS = 5_000;
/** The longest a rate-limited panel waits after the driving read before
 *  checking again when no future reset is known (null or past). */
export const RATE_LIMIT_RECHECK_MS = 2 * 60_000;
/** The longest a rate-limited panel waits after the driving read even with a
 *  known reset, so a terminal account switch or an early lift is noticed. */
export const RATE_LIMIT_KNOWN_RESET_RECHECK_MS = 10 * 60_000;

function isAsciiAlphanumeric(c: string | undefined): boolean {
  return c !== undefined && /[a-z0-9]/i.test(c);
}

/** Whether `word` appears with no ASCII letter or digit on either side. Spelled
 *  here rather than imported from error-summary.ts, which isn't import-free. */
function hasStandaloneWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    if (
      !isAsciiAlphanumeric(text[i - 1]) &&
      !isAsciiAlphanumeric(text[i + word.length])
    )
      return true;
  }
  return false;
}

/** A forge AppError's lowercased message, or null for anything else. */
function forgeMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  if (typeof kind !== "string" || typeof message !== "string") return null;
  return FORGE_KINDS.has(kind) ? message.toLowerCase() : null;
}

function matches(
  text: string,
  phrases: readonly string[],
  statuses: readonly string[],
): boolean {
  return (
    phrases.some((p) => text.includes(p)) ||
    statuses.some((s) => hasStandaloneWord(text, s))
  );
}

/** Whether `error` is a forge's rate-limit refusal, the app's own held-call
 *  text for a GitHub budget already used up included. */
export function isRateLimitError(error: unknown): boolean {
  const text = forgeMessage(error);
  return text !== null && matches(text, RATE_LIMIT_PHRASES, RATE_LIMIT_STATUS);
}

/** Whether `error` is a forge's credential verdict (a 401, or not signed in).
 *  Narrow on purpose: a 403 can be a permission verdict, a secondary rate
 *  limit, or a transient. */
export function isAuthError(error: unknown): boolean {
  const text = forgeMessage(error);
  return text !== null && matches(text, AUTH_PHRASES, AUTH_STATUS);
}

/** react-query's default `retry`: one retry, except for verdicts a retry a
 *  second later can't change. */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  return failureCount < 1 && !isRateLimitError(error) && !isAuthError(error);
}

/** How long a rate-limited panel waits before re-reading. A known future reset
 *  (`resetAt`, epoch seconds) fires just past it, at most
 *  RATE_LIMIT_KNOWN_RESET_RECHECK_MS after the driving read (`checkedAt`, epoch
 *  ms); otherwise RATE_LIMIT_RECHECK_MS after it. A reset inside the cap keeps
 *  its full grace even when that crosses the cap. */
export function rateLimitRecheckDelayMs(
  nowMs: number,
  checkedAt: number,
  resetAt: number | null | undefined,
): number {
  const recheck = Math.max(0, checkedAt + RATE_LIMIT_RECHECK_MS - nowMs);
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0)
    return recheck;
  const untilReset = resetAt * 1000 - nowMs;
  if (untilReset <= 0) return recheck;
  const cap = Math.max(
    0,
    checkedAt + RATE_LIMIT_KNOWN_RESET_RECHECK_MS - nowMs,
  );
  return untilReset <= cap ? untilReset + RESET_GRACE_MS : cap;
}
