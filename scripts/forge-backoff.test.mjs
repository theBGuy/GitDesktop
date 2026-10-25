// Pins the app-wide retry predicate (src/lib/query-client.ts) and the
// rate-limited panel's recheck delay (src/features/repository/ForgeNotReady.tsx).
// The contracts under test: a rate-limit or credential error is never retried,
// status digits count only as status tokens (a URL path or an issue ref is not
// a status), and a known reset times the recheck within a 10-minute cap.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module
// must stay free of runtime imports (type-only imports are erased).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isAuthError,
  isRateLimitError,
  RATE_LIMIT_KNOWN_RESET_RECHECK_MS,
  RATE_LIMIT_RECHECK_MS,
  RESET_GRACE_MS,
  rateLimitRecheckDelayMs,
  shouldRetryQuery,
} from "../src/lib/forge-backoff.ts";

// The held-call texts runner.rs returns in place of a spawn (its HELD_* constants).
const HELD_TEXTS = [
  "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
  "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
  "GitHub's search API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
];

const gh = (message) => ({ kind: "gh", message });

test("rate-limit errors are recognized across the forge kinds", () => {
  const hits = [
    ...HELD_TEXTS.map(gh),
    gh("GraphQL: API rate limit exceeded for user ID 1."),
    { kind: "glab", message: "429 Too Many Requests" },
    gh("gh: Too Many Requests (HTTP 429)"),
    gh("HTTP 429: Slow down (https://api.github.com/repos/o/r)"),
    gh(
      "HTTP 403: You have triggered an abuse detection mechanism. (https://ghe.example.com/api/v3/x)",
    ),
    // forge/http.rs and forge/jira.rs, verbatim.
    {
      kind: "bitbucket",
      message:
        "Bitbucket rate limit reached (429). Wait a moment and try again.",
    },
    {
      kind: "jira",
      message: "Jira rate limit reached (429). Wait a moment and try again.",
    },
  ];
  for (const error of hits)
    assert.equal(isRateLimitError(error), true, error.message);
});

test("rate-limit matching needs a forge kind and a status token, never bare digits", () => {
  const misses = [
    ["a non-forge kind", { kind: "git", message: "rate limit" }],
    ["a 4290-prefixed id", gh("run 42901 failed")],
    ["a status digit run", gh("HTTP 4290: odd (https://api.github.com/x)")],
    [
      "429 inside a URL path",
      gh("HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/issues/429)"),
    ],
    ["429 as an issue ref", gh("Couldn't update #429")],
    ["a plain Error", new Error("rate limit")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "rate limit"],
    ["a non-string message", { kind: "gh", message: 429 }],
    ["a non-string kind", { kind: 1, message: "rate limit" }],
  ];
  for (const [name, error] of misses)
    assert.equal(isRateLimitError(error), false, name);
});

test("credential errors are recognized by status token or gh's wording", () => {
  const hits = [
    gh("HTTP 401: Bad credentials (https://api.github.com/user)"),
    gh("gh: Requires authentication (HTTP 401)"),
    { kind: "glab", message: "401 Unauthorized" },
    gh("To get started with GitHub CLI, please run:  gh auth login"),
  ];
  for (const error of hits)
    assert.equal(isAuthError(error), true, error.message);
});

test("credential matching skips permission verdicts, paths, refs and non-forge kinds", () => {
  const misses = [
    [
      "a 403 permission verdict",
      gh("HTTP 403: Resource not accessible by integration"),
    ],
    [
      "401 inside a URL path",
      gh("HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/issues/401)"),
    ],
    ["401 as an issue ref", gh("Couldn't load #401")],
    ["a status digit run", gh("HTTP 4011: odd")],
    ["a non-forge kind", { kind: "git", message: "HTTP 401: Bad credentials" }],
    ["a missing-CLI kind", { kind: "ghNotFound", message: "gh auth login" }],
    ["null", null],
    ["a string", "HTTP 401: Bad credentials"],
  ];
  for (const [name, error] of misses)
    assert.equal(isAuthError(error), false, name);
});

test("the default retry keeps one retry, except for rate limits and credentials", () => {
  const generic = gh(
    "HTTP 502: Bad Gateway (https://api.github.com/repos/o/r)",
  );
  assert.equal(shouldRetryQuery(0, generic), true);
  assert.equal(shouldRetryQuery(1, generic), false);
  assert.equal(shouldRetryQuery(0, gh(HELD_TEXTS[0])), false);
  assert.equal(
    shouldRetryQuery(
      0,
      gh("HTTP 401: Bad credentials (https://api.github.com/user)"),
    ),
    false,
  );
  assert.equal(shouldRetryQuery(0, undefined), true);
  assert.equal(shouldRetryQuery(1, undefined), false);
});

test("the recheck constants keep their values", () => {
  assert.equal(RESET_GRACE_MS, 5_000);
  assert.equal(RATE_LIMIT_RECHECK_MS, 2 * 60_000);
  assert.equal(RATE_LIMIT_KNOWN_RESET_RECHECK_MS, 10 * 60_000);
});

const NOW = 1_800_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
/** A reset `ms` from NOW, in the epoch seconds the forge status reports. */
const resetIn = (ms) => (NOW + ms) / SEC;

test("a known reset times the recheck, capped at 10 minutes from the read (table)", () => {
  const table = [
    ["reset 50 min out", NOW, resetIn(50 * MIN), 10 * MIN],
    ["reset 3 min out", NOW, resetIn(3 * MIN), 3 * MIN + 5 * SEC],
    ["reset 30 s out", NOW, resetIn(30 * SEC), 35 * SEC],
    ["reset already past", NOW, resetIn(-MIN), 2 * MIN],
    ["reset 3 h out", NOW, resetIn(3 * 60 * MIN), 10 * MIN],
    ["null reset", NOW, null, 2 * MIN],
    ["undefined reset", NOW, undefined, 2 * MIN],
    ["NaN reset", NOW, Number.NaN, 2 * MIN],
    ["negative reset", NOW, -5, 2 * MIN],
    ["zero reset", NOW, 0, 2 * MIN],
    ["infinite reset", NOW, Number.POSITIVE_INFINITY, 2 * MIN],
    ["stale read, no reset", NOW - 3 * MIN, null, 0],
    ["read 9 min old, reset 50 min out", NOW - 9 * MIN, resetIn(50 * MIN), MIN],
    ["read 11 min old, reset 50 min out", NOW - 11 * MIN, resetIn(50 * MIN), 0],
    ["stale read, reset past", NOW - 3 * MIN, resetIn(-MIN), 0],
    [
      "reset just inside the cap keeps its grace",
      NOW,
      resetIn(10 * MIN - 2 * SEC),
      10 * MIN + 3 * SEC,
    ],
    ["reset exactly at the cap", NOW, resetIn(10 * MIN), 10 * MIN + 5 * SEC],
    ["reset just past the cap", NOW, resetIn(10 * MIN + SEC), 10 * MIN],
  ];
  for (const [name, checkedAt, resetAt, expected] of table)
    assert.equal(
      rateLimitRecheckDelayMs(NOW, checkedAt, resetAt),
      expected,
      name,
    );
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Throws unless the client's query defaults take `retry: shouldRetryQuery`
 *  imported from ./forge-backoff. Line comments are dropped and whitespace
 *  (CRLF included) is free, so only the code's shape is pinned. */
function assertRetryWired(source) {
  const code = source.replace(/\r\n/g, "\n").replace(/\/\/[^\n]*/g, "");
  assert.match(
    code,
    /import\s*\{[^}]*\bshouldRetryQuery\b[^}]*\}\s*from\s*["']\.\/forge-backoff["']/,
    "shouldRetryQuery is imported from ./forge-backoff",
  );
  assert.match(
    code,
    /defaultOptions\s*:\s*\{\s*queries\s*:\s*\{[^}]*\bretry\s*:\s*shouldRetryQuery\s*[,}]/,
    "the query defaults set retry: shouldRetryQuery",
  );
}

test("the query client's default retry is shouldRetryQuery", () => {
  const source = readFileSync(join(ROOT, "src/lib/query-client.ts"), "utf8");
  assertRetryWired(source);
  // Mutation controls: the reverted default, and the import dropped, each fail.
  const reverted = source.replace(/retry:\s*shouldRetryQuery/, "retry: 1");
  assert.notEqual(reverted, source);
  assert.throws(() => assertRetryWired(reverted), /retry: shouldRetryQuery/);
  const unimported = source.replace(/\bfrom\s*["']\.\/forge-backoff["']/, "");
  assert.notEqual(unimported, source);
  assert.throws(() => assertRetryWired(unimported), /forge-backoff/);
  // CRLF and spacing are free.
  assertRetryWired(
    source.replace(/\r?\n/g, "\r\n").replace(/retry:\s*/, "retry :\n  "),
  );
});
