// Import-free: scripts/forge-backoff.test.mjs imports this file through Node's
// type stripping, which resolves no aliases.

/** The provider each forge kind's failures are named after (`AppError.kind`).
 *  The one kind→provider map: error-summary.ts aliases it. */
export const FORGE_KIND_HOSTS = {
  gh: "GitHub",
  glab: "GitLab",
  bitbucket: "Bitbucket",
  jira: "Jira",
} as const;

/** Forge kinds whose failures carry the forge's own answer (`AppError.kind`). */
const FORGE_KINDS: ReadonlySet<string> = new Set(Object.keys(FORGE_KIND_HOSTS));

/** The texts github/runner.rs returns in place of a held gh call (its HELD_*
 *  constants), by the bucket each names. A cross-language contract pinned by
 *  scripts/forge-backoff.test.mjs: a rewording on either side must move both. */
export const HELD_RATE_LIMIT_TEXTS = {
  REST: "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
  GraphQL:
    "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
  search:
    "GitHub's search API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
} as const;

export type HeldBucket = keyof typeof HELD_RATE_LIMIT_TEXTS;

/** Rate-limit wording from gh, glab and the app's Bitbucket/Jira clients,
 *  mirroring Rust's `gh_error_is_rate_limit` and `GLAB_RATE_LIMIT_PHRASES`
 *  (forge/session.rs). Matched as substrings. */
const RATE_LIMIT_PHRASES = [
  "rate limit",
  "abuse detection",
  "too many requests",
];

/** The 429 status token, matched as a whole word only: a bare 429 is as likely
 *  a URL path segment or an issue ref as a status. */
const RATE_LIMIT_STATUS = ["http 429"];

/** gh's 401 wording (go-gh's `HTTP 401: Bad credentials (…)`) and the
 *  not-signed-in instruction gh and glab print. Matched as substrings. */
const AUTH_PHRASES = ["bad credentials", "auth login"];

/** 401 status tokens, whole words only for the same reason as the 429 token. */
const AUTH_STATUS = ["http 401", "401 unauthorized"];

/** Slack past the reset second, so the re-read doesn't land a hair early. */
export const RESET_GRACE_MS = 5_000;
/** The longest a rate-limited panel waits after the driving read before
 *  checking again when no future reset is known (null or past). */
export const RATE_LIMIT_RECHECK_MS = 2 * 60_000;
/** The longest a rate-limited panel waits after the driving read even with a
 *  known reset (plus at most the grace), so a terminal account switch or an
 *  early lift is noticed. */
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
 *  text included ("GitHub's … API rate limit has been reached, so GitDesktop
 *  didn't send this request"). */
export function isRateLimitError(error: unknown): boolean {
  const text = forgeMessage(error);
  return text !== null && matches(text, RATE_LIMIT_PHRASES, RATE_LIMIT_STATUS);
}

/** The bucket a held-call text names, or null. Its caller passes only bare
 *  messages, which are the held text alone today; a substring match also
 *  names the bucket behind a raw prefix the bare rule strips (`error: `). */
export function heldBucket(message: string): HeldBucket | null {
  for (const [bucket, text] of Object.entries(HELD_RATE_LIMIT_TEXTS))
    if (message.includes(text)) return bucket as HeldBucket;
  return null;
}

/** The provider whose rate limit `error` is, or null when it isn't one. */
export function rateLimitProvider(error: unknown): string | null {
  if (!isRateLimitError(error)) return null;
  const { kind } = error as { kind: keyof typeof FORGE_KIND_HOSTS };
  return FORGE_KIND_HOSTS[kind];
}

/** Raw prefixes a forge's own diagnostic can open with, stripped in turn: gh's
 *  `gh:` / `error:` / `GraphQL:` / `HTTP <status>:` (go-gh), and glab's
 *  client-go `<METHOD> <url>:` or a bare `<host>:`. */
const RAW_PREFIX =
  /^(?:(?:gh|glab|error|graphql):\s*|http \d{3}:\s*|(?:get|post|put|patch|delete|head) https?:\/\/\S+:\s*|[\w-]+(?:\.[\w-]+)+(?::\d+)?:\s+)/;

/** How a forge's own rate-limit text opens once its prefixes are gone: gh's
 *  primary, secondary, abuse and 429 wording, glab's 429 and limit wording, the
 *  Bitbucket and Jira clients' sentence (forge/http.rs, forge/jira.rs), and the
 *  held texts (runner.rs). */
const RATE_LIMIT_LEAD =
  /^(?:429\b|(?:api |secondary )?rate limit|too many requests|you have exceeded a secondary rate limit|you have triggered an abuse detection|(?:bitbucket|jira) rate limit reached|github's (?:rest|graphql|search) api rate limit has been reached)/;

/** Whether the message IS the forge's or the runner's rate-limit text, so one
 *  sentence may stand in for it. App prose in front of the cause fails the lead
 *  by construction. Only a single meaningful line can be bare (glab's lines are
 *  read joined, as glab wraps one diagnostic): gh writes multi-line output of
 *  its own too, but a second line may be app prose saying a write already
 *  landed, so any message with one keeps its own words. */
function isBareRateLimit(kind: string, message: string): boolean {
  const lines = message
    .split(/\r\n|[\n\r]/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && l !== "ERROR");
  if (lines.length === 0 || (kind !== "glab" && lines.length > 1)) return false;
  let text = lines.join(" ").toLowerCase();
  for (let m = RAW_PREFIX.exec(text); m !== null; m = RAW_PREFIX.exec(text)) {
    if (m[0].startsWith("http 429:")) return true;
    text = text.slice(m[0].length);
  }
  return RATE_LIMIT_LEAD.test(text);
}

/** One calm sentence for a bare rate-limit error, or null for anything else,
 *  a limit wrapped in app prose included. Names the bucket only for gh's held
 *  texts, the one source that knows it, and never "this request": a caller may
 *  quote it for several reads. */
export function rateLimitSummary(error: unknown): string | null {
  const provider = rateLimitProvider(error);
  if (provider === null) return null;
  const { kind, message } = error as { kind: string; message: string };
  if (!isBareRateLimit(kind, message)) return null;
  const bucket = kind === "gh" ? heldBucket(message) : null;
  const api = bucket === null ? "API" : `${bucket} API`;
  return `${provider}'s ${api} rate limit has been reached. Try again once it lifts.`;
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
