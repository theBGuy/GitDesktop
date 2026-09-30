// Pins the remote list section's render ladder, the detail pane's ladder, the
// list notice, the "Load more" guard, the permanent-error predicate and the
// park it withholds, the review-comments notice, and the board's
// failure-notice grouping.
// The contract under test: a failed or offline read replaces a list or a pane
// only when it has nothing to draw; with content cached, it stays and a notice
// sits above it, so an outage never reads as data loss, and a read parked
// offline says so instead of spinning a skeleton forever.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so
// `remote-section-state.ts` must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detailNoticeMessage,
  groupNoticesByMessage,
  guardedLimit,
  guardObservation,
  initialLoadMoreGuard,
  isPermanentListError,
  listNotice,
  normalizeNoticeMessage,
  OFFLINE_ROWS_NOTICE,
  offlinePendingMessage,
  parkedUnlessPermanent,
  refreshFailed,
  resolveDetailPane,
  resolveRemoteSection,
  reviewCommentsNotice,
  sectionReadNotice,
  stepLoadMoreGuard,
  ungroupedReason,
} from "../src/features/conversations/remote-section-state.ts";

const BOOLS = [false, true];
const ROW_COUNTS = [0, 1, 7];

/** The ladder in the order the section checks it, written out rung by rung. A
 *  park outranks a failed refresh at every altitude, as in the detail pane. */
function expected({
  ghPending,
  ghReady,
  listPending,
  error,
  rowCount,
  paused,
}) {
  if (ghPending) return "gh-skeleton";
  if (!ghReady) return "not-ready";
  if (listPending && paused) return "offline";
  if (listPending) return "list-skeleton";
  if (paused && rowCount > 0) return "rows-offline";
  if (paused && error) return "offline";
  if (error && rowCount === 0) return "error";
  if (error) return "rows-degraded";
  if (rowCount === 0) return "empty";
  return "rows";
}

test("every ladder input resolves to its rung (full truth table)", () => {
  let cases = 0;
  for (const ghPending of BOOLS)
    for (const ghReady of BOOLS)
      for (const listPending of BOOLS)
        for (const error of BOOLS)
          for (const paused of BOOLS)
            for (const rowCount of ROW_COUNTS) {
              const input = {
                ghPending,
                ghReady,
                listPending,
                error,
                rowCount,
                paused,
              };
              assert.equal(
                resolveRemoteSection(input),
                expected(input),
                JSON.stringify(input),
              );
              cases++;
            }
  // 2^5 flag combinations x 3 row counts: a truncated loop fails here.
  assert.equal(cases, 96);
});

test("an omitted paused flag reads as online, matching every older caller", () => {
  for (const listPending of BOOLS)
    for (const error of BOOLS)
      for (const rowCount of ROW_COUNTS) {
        const input = {
          ghPending: false,
          ghReady: true,
          listPending,
          error,
          rowCount,
        };
        assert.equal(
          resolveRemoteSection(input),
          resolveRemoteSection({ ...input, paused: false }),
          JSON.stringify(input),
        );
      }
});

test("a first load parked offline says offline, never an endless skeleton", () => {
  const ready = { ghPending: false, ghReady: true, error: false, rowCount: 0 };
  assert.equal(
    resolveRemoteSection({ ...ready, listPending: true, paused: true }),
    "offline",
  );
  // Negative control: the same first load while online still shows skeletons.
  assert.equal(
    resolveRemoteSection({ ...ready, listPending: true, paused: false }),
    "list-skeleton",
  );
});

test("a parked refresh keeps its rows under the offline rung (negative control)", () => {
  const ready = { ghPending: false, ghReady: true, listPending: false };
  assert.equal(
    resolveRemoteSection({ ...ready, error: false, rowCount: 4, paused: true }),
    "rows-offline",
  );
  // A loaded-empty list stays empty: zero rows is still a loaded answer.
  assert.equal(
    resolveRemoteSection({ ...ready, error: false, rowCount: 0, paused: true }),
    "empty",
  );
  assert.equal(
    resolveRemoteSection({
      ...ready,
      error: false,
      rowCount: 4,
      paused: false,
    }),
    "rows",
  );
});

test("a park outranks the failed refresh it follows: offline, never a Retry", () => {
  const ready = { ghPending: false, ghReady: true, listPending: false };
  // A retry after a failure, parked over cached rows: the rows stay under the
  // offline notice, whose cause wires no Retry.
  const withRows = resolveRemoteSection({
    ...ready,
    error: true,
    rowCount: 4,
    paused: true,
  });
  assert.equal(withRows, "rows-offline");
  const notice = listNotice({
    noun: "pull requests",
    failed: withRows === "rows-degraded",
    offline: withRows === "rows-offline",
    placeholder: false,
    hasRows: true,
    loadMoreFailed: false,
  });
  assert.equal(notice.cause, "offline");
  // The same park with nothing drawn, past the first load: the offline line,
  // never the error slot and its Retry.
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 0, paused: true }),
    "offline",
  );
  // Negative control: the failure alone, online, keeps its degraded rungs.
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 4, paused: false }),
    "rows-degraded",
  );
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 0, paused: false }),
    "error",
  );
});

test("a failed read parked offline lands the list on the detail pane's rung", () => {
  // The list rung each pane state corresponds to; an unmapped list rung (the
  // degraded or error rungs a park must never reach) fails the comparison.
  const PANE_FOR_LIST = {
    "rows-offline": "content-degraded",
    offline: "offline",
  };
  for (const rowCount of ROW_COUNTS) {
    const list = resolveRemoteSection({
      ghPending: false,
      ghReady: true,
      listPending: false,
      error: true,
      rowCount,
      paused: true,
    });
    const pane = resolveDetailPane({
      pending: false,
      error: true,
      hasData: rowCount > 0,
      paused: true,
    });
    assert.equal(PANE_FOR_LIST[list], pane, JSON.stringify({ rowCount, list }));
  }
});

test("only a disabled feature or a refused filter reads as permanent", () => {
  assert.equal(
    isPermanentListError({ kind: "issuesDisabled", message: "" }),
    true,
  );
  assert.equal(
    isPermanentListError({ kind: "invalidArgument", message: "" }),
    true,
  );
  // Negative control: transport and forge failures are transient here.
  for (const kind of ["gh", "glab", "bitbucket", "jira", "io", "timeout"])
    assert.equal(isPermanentListError({ kind, message: "" }), false, kind);
  for (const value of [null, undefined, "issuesDisabled", {}, { kind: 5 }])
    assert.equal(isPermanentListError(value), false, String(value));
});

// The ladder takes `paused` as given; both list panels feed it
// `parkedUnlessPermanent(query)`, so this drives the ladder through that helper.
test("a park never hides a permanent verdict with nothing drawn", () => {
  const atCallSite = (error, isPaused) =>
    resolveRemoteSection({
      ghPending: false,
      ghReady: true,
      listPending: false,
      error: true,
      rowCount: 0,
      paused: parkedUnlessPermanent({ isPaused, error }),
    });
  const disabled = { kind: "issuesDisabled", message: "" };
  const refused = { kind: "invalidArgument", message: "" };
  assert.equal(atCallSite(disabled, true), "error");
  assert.equal(atCallSite(refused, true), "error");
  // Negative control: a transient failure parked still reads as offline.
  assert.equal(atCallSite({ kind: "io", message: "" }, true), "offline");
  assert.equal(atCallSite(disabled, false), "error");
});

/** The review-comments notice, rung by rung. */
function expectedReviewNotice({ threadCount, isError, isPaused }) {
  const failed = isError && !isPaused;
  const drawn = threadCount !== undefined && threadCount > 0;
  if (failed && drawn) return ["refresh-drawn", true];
  if (failed && threadCount !== undefined) return ["refresh-empty", true];
  if (failed) return ["load", true];
  if (isPaused && drawn) return ["offline-drawn", false];
  if (isPaused && threadCount === undefined) return ["offline-pending", false];
  return null;
}
const REVIEW_LINES = {
  "Couldn't refresh review comments — showing the last loaded ones.":
    "refresh-drawn",
  "Couldn't refresh review comments.": "refresh-empty",
  "Couldn't load review comments.": "load",
  "You're offline — showing the last loaded review comments.": "offline-drawn",
  [offlinePendingMessage("review comments")]: "offline-pending",
};

test("every review-comments input resolves to its line (full truth table)", () => {
  let cases = 0;
  for (const threadCount of [undefined, 0, 1])
    for (const isError of BOOLS)
      for (const isPaused of BOOLS) {
        const input = { threadCount, isError, isPaused };
        const notice = reviewCommentsNotice(input);
        assert.deepEqual(
          notice === null
            ? null
            : [REVIEW_LINES[notice.message] ?? notice.message, notice.retry],
          expectedReviewNotice(input),
          JSON.stringify(input),
        );
        cases++;
      }
  assert.equal(cases, 12);
});

test("review comments: a park outranks the failure, and a loaded empty answer stays quiet", () => {
  // Parked over a failure with threads drawn: the offline line, no Retry.
  assert.deepEqual(
    reviewCommentsNotice({ threadCount: 3, isError: true, isPaused: true }),
    {
      message: "You're offline — showing the last loaded review comments.",
      retry: false,
    },
  );
  // Parked over a loaded empty answer: nothing to say.
  assert.equal(
    reviewCommentsNotice({ threadCount: 0, isError: false, isPaused: true }),
    null,
  );
  // A first load that fails online: the load line, with Retry.
  assert.deepEqual(
    reviewCommentsNotice({
      threadCount: undefined,
      isError: true,
      isPaused: false,
    }),
    { message: "Couldn't load review comments.", retry: true },
  );
  // Negative control: healthy threads raise no notice at all.
  assert.equal(
    reviewCommentsNotice({ threadCount: 3, isError: false, isPaused: false }),
    null,
  );
});

/** The detail pane's ladder, rung by rung. */
function expectedPane({ pending, error, hasData, paused }) {
  if (hasData && (error || paused)) return "content-degraded";
  if (hasData) return "content";
  if (paused) return "offline";
  if (pending) return "skeleton";
  return "error";
}

test("every detail pane input resolves to its state (full truth table)", () => {
  let cases = 0;
  for (const pending of BOOLS)
    for (const error of BOOLS)
      for (const hasData of BOOLS)
        for (const paused of BOOLS) {
          const input = { pending, error, hasData, paused };
          assert.equal(
            resolveDetailPane(input),
            expectedPane(input),
            JSON.stringify(input),
          );
          cases++;
        }
  assert.equal(cases, 16);
});

test("a detail refresh that fails over cached data keeps the content", () => {
  const cached = { pending: false, hasData: true, paused: false };
  assert.equal(
    resolveDetailPane({ ...cached, error: true }),
    "content-degraded",
  );
  // Negative control: with nothing cached the failure still takes the pane.
  assert.equal(
    resolveDetailPane({ ...cached, hasData: false, error: true }),
    "error",
  );
  // A first load that is still running is a skeleton, a parked one is offline.
  assert.equal(
    resolveDetailPane({
      pending: true,
      error: false,
      hasData: false,
      paused: false,
    }),
    "skeleton",
  );
  assert.equal(
    resolveDetailPane({
      pending: true,
      error: false,
      hasData: false,
      paused: true,
    }),
    "offline",
  );
});

test("a failure counts only while not parked offline (full truth table)", () => {
  // Offline outranks a failure it follows: the notice speaks of the connection
  // and offers no Retry, even though react-query still reports the error.
  for (const [isError, isPaused, expected] of [
    [true, true, false],
    [true, false, true],
    [false, true, false],
    [false, false, false],
  ]) {
    assert.equal(
      refreshFailed({ isError, isPaused }),
      expected,
      `isError=${isError} isPaused=${isPaused}`,
    );
  }
});

const LIST = { noun: "pull requests", hasRows: true };

test("the list notice names one reason, failure first, then offline, then Load more", () => {
  const all = listNotice({
    ...LIST,
    placeholder: false,
    failed: true,
    offline: true,
    loadMoreFailed: true,
  });
  assert.equal(all.cause, "refresh");
  assert.match(all.message, /^Couldn't refresh pull requests/);
  const offline = listNotice({
    ...LIST,
    placeholder: false,
    failed: false,
    offline: true,
    loadMoreFailed: true,
  });
  // Offline wires no Retry: a retry parks again at once.
  assert.equal(offline.cause, "offline");
  assert.equal(offline.message, OFFLINE_ROWS_NOTICE);
  const more = listNotice({
    ...LIST,
    placeholder: false,
    failed: false,
    offline: false,
    loadMoreFailed: true,
  });
  assert.equal(more.cause, "load-more");
  assert.match(more.message, /^Couldn't load more pull requests/);
  assert.equal(more.retryLabel, "Retry loading more pull requests");
  // Negative control: a healthy list shows nothing.
  assert.equal(
    listNotice({
      ...LIST,
      placeholder: false,
      failed: false,
      offline: false,
      loadMoreFailed: false,
    }),
    null,
  );
});

/** The notice selection, rung by rung. */
function expectedNotice({
  failed,
  offline,
  placeholder,
  hasRows,
  loadMoreFailed,
}) {
  if (failed && hasRows) return ["refresh", "failed"];
  if (failed) return ["refresh", "failed-bare"];
  if (offline && hasRows && placeholder)
    return ["offline", "offline-other-view"];
  if (offline && hasRows) return ["offline", "offline-last-loaded"];
  if (loadMoreFailed) return ["load-more", "load-more"];
  return null;
}
const noticeKind = (n) => {
  if (n === null) return null;
  if (/^Couldn't refresh [^—]*\.$/.test(n.message))
    return [n.cause, "failed-bare"];
  if (n.message.startsWith("Couldn't refresh")) return [n.cause, "failed"];
  if (n.message === OFFLINE_ROWS_NOTICE)
    return [n.cause, "offline-last-loaded"];
  if (n.message.includes("for this view will load"))
    return [n.cause, "offline-other-view"];
  if (n.message.startsWith("Couldn't load more")) return [n.cause, "load-more"];
  return [n.cause, `unknown: ${n.message}`];
};

test("every list notice input resolves to its line (full truth table)", () => {
  let cases = 0;
  for (const failed of BOOLS)
    for (const offline of BOOLS)
      for (const placeholder of BOOLS)
        for (const hasRows of BOOLS)
          for (const loadMoreFailed of BOOLS) {
            const input = {
              failed,
              offline,
              placeholder,
              hasRows,
              loadMoreFailed,
            };
            assert.deepEqual(
              noticeKind(listNotice({ ...LIST, ...input })),
              expectedNotice(input),
              JSON.stringify(input),
            );
            cases++;
          }
  assert.equal(cases, 32);
});

test("offline over another view's placeholder rows never calls them this list's", () => {
  const base = { ...LIST, failed: false, offline: true, loadMoreFailed: false };
  const other = listNotice({ ...base, placeholder: true });
  assert.equal(
    other.message,
    "You're offline — pull requests for this view will load once you're back online.",
  );
  assert.notEqual(other.message, OFFLINE_ROWS_NOTICE);
  // Negative control: the list's own rows keep the last-loaded claim.
  assert.equal(
    listNotice({ ...base, placeholder: false }).message,
    OFFLINE_ROWS_NOTICE,
  );
  // Placeholder rows alone, online, raise no notice at all.
  assert.equal(
    listNotice({ ...base, offline: false, placeholder: true }),
    null,
  );
});

/**
 * Drives a guard the way the hook does: each observation names the caller's
 * requested limit and what the query did at the GUARDED limit, and after every
 * step the loop re-observes until the state stops changing — the render-phase
 * pass. Returns the settled state plus the limit each step's query ran at.
 */
function run(observations, start = initialLoadMoreGuard("repo-a")) {
  let state = start;
  const ranAt = [];
  for (const o of observations) {
    const identity = o.identity ?? "repo-a";
    const limit = guardedLimit(state, identity, o.requested);
    ranAt.push(limit);
    let next = stepLoadMoreGuard(state, { ...o, identity, limit });
    // A settled step is a fixpoint: re-observing its own result changes nothing.
    for (let pass = 0; next !== state && pass < 3; pass++) {
      state = next;
      next = stepLoadMoreGuard(state, {
        ...o,
        identity,
        limit: guardedLimit(state, identity, o.requested),
        // The re-render queries the redirected limit, whose cache loaded.
        loaded:
          o.loaded || guardedLimit(state, identity, o.requested) !== limit,
        failed: false,
      });
    }
    assert.equal(next, state, `no fixpoint for ${JSON.stringify(o)}`);
  }
  return { state, ranAt };
}
const ok = (requested, identity) => ({
  identity,
  requested,
  loaded: true,
  failed: false,
});
const bad = (requested, identity) => ({
  identity,
  requested,
  loaded: false,
  failed: true,
});
const busy = (requested, identity) => ({
  identity,
  requested,
  loaded: false,
  failed: false,
});

test("a grown page that fails after one loaded page redirects to it at once", () => {
  const { state } = run([ok(100), busy(200), bad(200)]);
  assert.equal(state.failed, 200);
  assert.equal(state.lastGood, 100);
  assert.deepEqual(state.rollback, { from: 200, to: 100 });
  // While the caller still asks for 200, the query keys on the loaded 100.
  assert.equal(guardedLimit(state, "repo-a", 200), 100);
  // Negative control: under another identity the redirect never applies.
  assert.equal(guardedLimit(state, "repo-b", 200), 200);
});

test("the caller catching up retires the redirect but keeps the failure", () => {
  const { state } = run([ok(100), bad(200), ok(100)]);
  assert.equal(state.rollback, null);
  assert.equal(state.failed, 200);
  // Growing again (Retry or Load more) is no longer redirected.
  assert.equal(guardedLimit(state, "repo-a", 200), 200);
});

test("a first-load failure is the list's own error, never a rollback (negative control)", () => {
  const { state, ranAt } = run([busy(100), bad(100)]);
  assert.equal(state.failed, null);
  assert.equal(state.rollback, null);
  assert.deepEqual(ranAt, [100, 100]);
  // A refresh failing over the loaded page is not a grow failure either.
  const again = run([ok(100), bad(100)]);
  assert.equal(again.state.failed, null);
  assert.equal(again.state.rollback, null);
});

test("a retry that reaches the failed limit clears the failure", () => {
  const { state } = run([ok(100), bad(200), ok(100), busy(200), ok(200)]);
  assert.equal(state.failed, null);
  assert.equal(state.lastGood, 200);
});

test("a retry that fails again redirects again", () => {
  const { state, ranAt } = run([
    ok(100),
    bad(200),
    ok(100),
    busy(200),
    bad(200),
  ]);
  assert.deepEqual(ranAt, [100, 200, 100, 200, 200]);
  assert.deepEqual(state.rollback, { from: 200, to: 100 });
  assert.equal(state.failed, 200);
});

test("a grown page parked offline is no failure: no rollback, no Load more Retry", () => {
  const read = {
    isSuccess: false,
    isError: true,
    isPlaceholderData: true,
    isFetching: false,
  };
  // A retry of the errored grown key, parked: the error is still reported.
  const parked = guardObservation({ ...read, isPaused: true });
  assert.deepEqual(parked, { loaded: false, failed: false });
  const { state } = run([ok(100), { requested: 200, ...parked }]);
  assert.equal(state.failed, null);
  assert.equal(state.rollback, null);
  // Negative control: the same settled error online records the failure.
  const settled = guardObservation({ ...read, isPaused: false });
  assert.deepEqual(settled, { loaded: false, failed: true });
  assert.equal(
    run([ok(100), { requested: 200, ...settled }]).state.failed,
    200,
  );
  // A fetch in flight is unsettled too, as before.
  assert.equal(
    guardObservation({ ...read, isFetching: true, isPaused: false }).failed,
    false,
  );
  // Real data loads whatever the park: placeholder rows never count.
  assert.deepEqual(
    guardObservation({
      isSuccess: true,
      isError: false,
      isPlaceholderData: false,
      isFetching: false,
      isPaused: true,
    }),
    { loaded: true, failed: false },
  );
});

test("a new list identity starts a fresh guard, dropping the old failure", () => {
  const { state } = run([ok(100), bad(200), ok(100)]);
  // Another lens or filter at a grown limit: no loaded page there yet, so its
  // failure is that list's own error.
  const switched = stepLoadMoreGuard(state, {
    ...bad(200, "repo-a-upstream"),
    identity: "repo-a-upstream",
    limit: 200,
  });
  assert.equal(switched.identity, "repo-a-upstream");
  assert.equal(switched.failed, null);
  assert.equal(switched.lastGood, null);
  assert.equal(switched.rollback, null);
});

test("an unchanged observation returns the same guard state", () => {
  const { state } = run([ok(100)]);
  const at = (o) =>
    stepLoadMoreGuard(state, { ...o, identity: "repo-a", limit: o.requested });
  assert.equal(at(ok(100)), state);
  assert.equal(at(busy(200)), state);
  // The redirected render re-observing its own result is a fixpoint too.
  const failed = run([ok(100), bad(200)]).state;
  assert.equal(
    stepLoadMoreGuard(failed, {
      ...ok(200),
      identity: "repo-a",
      limit: guardedLimit(failed, "repo-a", 200),
    }),
    failed,
  );
});

test("a failed refresh with cached rows keeps the rows (negative control)", () => {
  const ready = { ghPending: false, ghReady: true, listPending: false };
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 3 }),
    "rows-degraded",
  );
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 1 }),
    "rows-degraded",
  );
  // With nothing to draw, the error state still replaces the section.
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 0 }),
    "error",
  );
});

test("the gates outrank an error: pending and not-ready never show rows", () => {
  const failed = { error: true, rowCount: 5 };
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: true,
      ghReady: true,
      listPending: false,
    }),
    "gh-skeleton",
  );
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: false,
      ghReady: false,
      listPending: false,
    }),
    "not-ready",
  );
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: false,
      ghReady: true,
      listPending: true,
    }),
    "list-skeleton",
  );
});

const notice = (key, message) => ({ key, message });
const keys = (groups) => groups.map((g) => g.map((n) => n.key));

test("identical messages collapse into one group, in first-seen order", () => {
  const down = "Couldn't reach GitHub.";
  const groups = groupNoticesByMessage([
    notice("projects", down),
    notice("fields", down),
    notice("views", down),
    notice("items", down),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields", "views", "items"]]);
});

test("a two-and-two split yields two groups, each keeping its members", () => {
  const groups = groupNoticesByMessage([
    notice("projects", "A"),
    notice("fields", "B"),
    notice("views", "A"),
    notice("items", "B"),
  ]);
  assert.deepEqual(keys(groups), [
    ["projects", "views"],
    ["fields", "items"],
  ]);
});

test("distinct messages stay one line each", () => {
  const groups = groupNoticesByMessage([
    notice("projects", "A"),
    notice("fields", "B"),
    notice("views", "C"),
    notice("items", "D"),
  ]);
  assert.deepEqual(keys(groups), [
    ["projects"],
    ["fields"],
    ["views"],
    ["items"],
  ]);
});

test("no notices, no groups", () => {
  assert.deepEqual(groupNoticesByMessage([]), []);
});

// Shapes measured on a live board outage: every transport error names its own
// connection's ephemeral local port, so exact text never matches across reads.
const reset = (localPort) =>
  `read tcp 127.0.0.1:${localPort}->127.0.0.1:18431: wsarecv: An existing connection was forcibly closed by the remote host.`;
const BAD_GATEWAY = 'Post "https://api.github.com/graphql": Bad Gateway';
const dial = (localPort) =>
  `dial tcp 192.168.1.20:${localPort}->140.82.113.3:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time.`;

test("resets differing only in the local port group as one outage (negative control)", () => {
  const groups = groupNoticesByMessage([
    notice("projects", reset(63047)),
    notice("fields", reset(63051)),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields"]]);
  // The line shows the first member's own text, unmasked.
  assert.equal(groups[0][0].message, reset(63047));
});

test("a fixed-text failure on every read still groups as one", () => {
  const groups = groupNoticesByMessage([
    notice("projects", BAD_GATEWAY),
    notice("fields", BAD_GATEWAY),
    notice("views", BAD_GATEWAY),
    notice("items", BAD_GATEWAY),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields", "views", "items"]]);
});

test("a reset and a bad gateway stay two lines", () => {
  const groups = groupNoticesByMessage([
    notice("projects", reset(63047)),
    notice("fields", BAD_GATEWAY),
  ]);
  assert.deepEqual(keys(groups), [["projects"], ["fields"]]);
});

test("dial failures to one remote from different local ports group as one", () => {
  const groups = groupNoticesByMessage([
    notice("projects", dial(50112)),
    notice("views", dial(50119)),
    notice("items", dial(50123)),
  ]);
  assert.deepEqual(keys(groups), [["projects", "views", "items"]]);
});

test("masking touches address:port tokens only, never bare numbers", () => {
  assert.equal(
    normalizeNoticeMessage("dial tcp localhost:8080: refused"),
    "dial tcp <addr>: refused",
  );
  assert.equal(
    normalizeNoticeMessage("read tcp [::1]:63047->[::1]:18431: reset"),
    "read tcp <addr>-><addr>: reset",
  );
  // Different HTTP statuses, and a version-like number, are left alone.
  const groups = groupNoticesByMessage([
    notice("projects", "HTTP 502: Bad Gateway"),
    notice("fields", "HTTP 503: Service Unavailable"),
    notice("views", "HTTP 500 from 1.2.3"),
  ]);
  assert.deepEqual(keys(groups), [["projects"], ["fields"], ["views"]]);
});

test("a failed refresh over a card-only section still reports, without the rows claim", () => {
  const base = {
    noun: "code scanning alerts",
    failed: true,
    offline: false,
    placeholder: false,
    loadMoreFailed: false,
  };
  const card = listNotice({ ...base, hasRows: false });
  assert.equal(card.message, "Couldn't refresh code scanning alerts.");
  assert.equal(card.cause, "refresh");
  assert.equal(card.retryLabel, "Retry loading code scanning alerts");
  // Negative control: with rows drawn the claim stays.
  assert.equal(
    listNotice({ ...base, hasRows: true }).message,
    "Couldn't refresh code scanning alerts — showing the last loaded results.",
  );
  // Offline over a card says nothing: there are no loaded results to claim.
  assert.equal(
    listNotice({ ...base, failed: false, offline: true, hasRows: false }),
    null,
  );
});

test("the offline and detail notice strings are the ones every surface shows", () => {
  assert.equal(
    offlinePendingMessage("pull requests"),
    "You're offline — pull requests will load once you're back online.",
  );
  assert.equal(
    offlinePendingMessage("this finding"),
    "You're offline — this finding will load once you're back online.",
  );
  const detail = (isError, stale) =>
    detailNoticeMessage({ noun: "pull request", isError, stale });
  assert.equal(
    detail(true, false),
    "Couldn't refresh this pull request — showing the last loaded version.",
  );
  // A failed refresh outranks the switch window: its content is still cached.
  assert.equal(detail(true, true), detail(true, false));
  assert.equal(
    detail(false, true),
    "You're offline — showing the last opened pull request; this one will load once you're back online.",
  );
  assert.equal(
    detail(false, false),
    "You're offline — showing the last loaded version.",
  );
  // The list notice's other-view line is the same pending sentence.
  assert.equal(
    listNotice({
      noun: "issues",
      failed: false,
      offline: true,
      placeholder: true,
      hasRows: true,
      loadMoreFailed: false,
    }).message,
    offlinePendingMessage("issues for this view"),
  );
});

/** A single-read section's notice, rung by rung. */
function expectedSectionNotice({ rowCount, isError, isPaused }) {
  const failed = isError && !isPaused;
  if (rowCount === undefined) {
    if (isPaused) return ["offline-pending", false];
    return failed ? ["load", true] : null;
  }
  if (failed) return [rowCount > 0 ? "refresh-drawn" : "refresh-empty", true];
  if (isPaused && rowCount > 0) return ["offline-drawn", false];
  return null;
}
const SECTION_LINES = {
  "Couldn't refresh tasks — showing the last loaded results.": "refresh-drawn",
  "Couldn't refresh tasks.": "refresh-empty",
  "Couldn't load tasks.": "load",
  [OFFLINE_ROWS_NOTICE]: "offline-drawn",
  [offlinePendingMessage("tasks")]: "offline-pending",
};

test("every single-read section input resolves to its line (full truth table)", () => {
  let cases = 0;
  for (const rowCount of [undefined, 0, 1, 4])
    for (const isError of BOOLS)
      for (const isPaused of BOOLS) {
        const input = { rowCount, isError, isPaused };
        const notice = sectionReadNotice({
          noun: "tasks",
          loadFailed: "Couldn't load tasks.",
          ...input,
        });
        assert.deepEqual(
          notice === null
            ? null
            : [SECTION_LINES[notice.message] ?? notice.message, notice.retry],
          expectedSectionNotice(input),
          JSON.stringify(input),
        );
        if (notice !== null)
          assert.equal(notice.retryLabel, "Retry loading tasks");
        cases++;
      }
  assert.equal(cases, 16);
});

test("a single-read section keeps its rows through a failure and a park", () => {
  // The failure over loaded rows is the list notice's line, with Retry.
  assert.deepEqual(
    sectionReadNotice({
      noun: "comments",
      loadFailed: "Couldn't load comments for this commit.",
      rowCount: 2,
      isError: true,
      isPaused: false,
    }),
    {
      message: "Couldn't refresh comments — showing the last loaded results.",
      retryLabel: "Retry loading comments",
      retry: true,
    },
  );
  // The same failure parked offline: the offline line, no Retry.
  assert.deepEqual(
    sectionReadNotice({
      noun: "comments",
      loadFailed: "Couldn't load comments for this commit.",
      rowCount: 2,
      isError: true,
      isPaused: true,
    }),
    {
      message: OFFLINE_ROWS_NOTICE,
      retryLabel: "Retry loading comments",
      retry: false,
    },
  );
  // Negative controls: healthy loaded rows raise nothing, and a loaded empty
  // answer stays quiet offline, like a list's empty rung.
  for (const rowCount of [2, 0])
    assert.equal(
      sectionReadNotice({
        noun: "comments",
        loadFailed: "Couldn't load comments for this commit.",
        rowCount,
        isError: false,
        isPaused: rowCount === 0,
      }),
      null,
      String(rowCount),
    );
});

/** Why the review-grouped list is flat, rung by rung. */
function expectedUngrouped({
  requested,
  grouped,
  isError,
  isPaused,
  truncated,
}) {
  if (!requested || grouped) return null;
  if (truncated) return "truncated";
  if (isPaused) return "offline";
  if (isError) return "error";
  return null;
}

test("every grouping input resolves to its note (full truth table)", () => {
  let cases = 0;
  for (const requested of BOOLS)
    for (const grouped of BOOLS)
      for (const isError of BOOLS)
        for (const isPaused of BOOLS)
          for (const truncated of BOOLS) {
            const input = { requested, grouped, isError, isPaused, truncated };
            assert.equal(
              ungroupedReason(input),
              expectedUngrouped(input),
              JSON.stringify(input),
            );
            cases++;
          }
  assert.equal(cases, 32);
});

test("grouped and flat lists × error, paused, and fresh review state", () => {
  const note = (grouped, state) =>
    ungroupedReason({
      requested: true,
      grouped,
      isError: state === "error" || state === "error-paused",
      isPaused: state === "paused" || state === "error-paused",
      truncated: false,
    });
  // A grouped list explains nothing, whatever the review read is doing.
  for (const state of ["fresh", "error", "paused", "error-paused"])
    assert.equal(note(true, state), null, state);
  // A flat list names why: offline outranks the failure it follows, and a
  // first load parked offline is said, not left silent.
  assert.equal(note(false, "error"), "error");
  assert.equal(note(false, "error-paused"), "offline");
  assert.equal(note(false, "paused"), "offline");
  // Negative control: a map still fetching stays silent by design.
  assert.equal(note(false, "fresh"), null);
  // A loaded but truncated map keeps its own verdict through a park.
  assert.equal(
    ungroupedReason({
      requested: true,
      grouped: false,
      isError: false,
      isPaused: true,
      truncated: true,
    }),
    "truncated",
  );
  // Grouping never asked for: nothing to explain.
  assert.equal(
    ungroupedReason({
      requested: false,
      grouped: false,
      isError: true,
      isPaused: true,
      truncated: false,
    }),
    null,
  );
});
