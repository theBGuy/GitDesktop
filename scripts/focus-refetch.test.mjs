// Pins the window-focus pass (src/lib/git/queries/board-writes.ts
// `refetchRepoQueriesOnFocus`, which projects.ts `refreshRepoOnFocus` runs on
// every native focus) against a REAL react-query cache: it refetches only ACTIVE
// repo queries past their own staleTime or in error, holds a chased board lens to a
// stale mark, and invalidates nothing else, so an inactive query keeps its clock.
// Staleness is read at CALL time: the clock here moves with no timer firing, which
// is how an occluded webview's lagging stale timers look to the pass.
//
// Also pins the header badge's per-mode placeholder axis: one observer whose key
// flips between the run-notify list and the limit-1 latest read must never hand one
// read's cached shape to the other's `select`.
//
// Also pins push-writes.ts `recheckRunsAfterPush`: one run-list recheck per repo,
// 8 s after the last push-like write, skipping a list paged past page 1, and
// covering the union of every coalesced arm's PR checks reads; and its sibling
// `recheckListsLater`: one list re-read per repo, re-armed by a
// later arm rather than stacked, covering every arm's keys. And pins
// `recheckFilterMatches`' exact, numbered-child and prefix modes against the key
// shapes `prChecksRecheck` builds, with source pins tying those shapes to the
// real PR-details and CI-map keys.
//
// The react-query-backed imports are DYNAMIC because the CI `guards` job (no
// install step) can't resolve @tanstack/react-query: unresolved deps skip every
// test here but the source pins and the matcher table, and GD_EXPECT_DEPS turns a
// skip into a failure on an installed run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// Import-free (types only), so it loads without node_modules like the source pins.
import { recheckFilterMatches } from "../src/lib/git/queries/push-writes.ts";

let deps = null;
try {
  const rq = await import("@tanstack/react-query");
  deps = {
    ...(await import("../src/lib/git/queries/board-writes.ts")),
    ...(await import("../src/lib/git/queries/push-writes.ts")),
    QueryClient: rq.QueryClient,
    QueryObserver: rq.QueryObserver,
  };
} catch (e) {
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const {
  QueryClient,
  QueryObserver,
  refetchRepoQueriesOnFocus,
  recheckRunsAfterPush,
  PUSH_RUN_RECHECK_MS,
  recheckListsLater,
  LIST_RECHECK_MS,
} = deps ?? {};

const NEEDS_DEPS =
  "needs node_modules — an installed run with GD_EXPECT_DEPS enforces this";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A clock the test moves by hand; query-core reads `Date.now()` for both
 *  `dataUpdatedAt` and staleness. */
function fakeClock(t) {
  const real = Date.now;
  let now = 1_000_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = real;
  });
  return { advance: (ms) => (now += ms) };
}

/** A cache plus per-key fetch counters. */
function harness(t) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetches = new Map();
  const unsubs = [];
  t.after(() => {
    for (const u of unsubs) u();
    qc.clear();
  });
  const fn = (name, impl) => () => {
    fetches.set(name, (fetches.get(name) ?? 0) + 1);
    return impl ? impl() : Promise.resolve(name);
  };
  /** Mounts a subscribed observer — an ACTIVE query unless `enabled` is false. */
  const observe = (name, options = {}, impl) => {
    const observer = new QueryObserver(qc, {
      queryKey: ["repo", "C:/a", name],
      queryFn: fn(name, impl),
      ...options,
    });
    unsubs.push(observer.subscribe(() => {}));
    return observer;
  };
  const query = (name) =>
    qc.getQueryCache().find({ queryKey: ["repo", "C:/a", name], exact: true });
  const count = (name) => fetches.get(name) ?? 0;
  return { qc, observe, query, count, fn };
}

test("fresh active queries take no fetch on focus; stale ones refetch", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  h.observe("minute", { staleTime: 60_000 });
  h.observe("pr-detail", { staleTime: 30_000 });
  h.observe("zero", { staleTime: 0 });
  await sleep(5);
  assert.deepEqual(
    ["minute", "pr-detail", "zero"].map(h.count),
    [1, 1, 1],
    "mount fetches",
  );

  clock.advance(20_000);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  // NEGATIVE CONTROL: a plain repo invalidation refetches every active query here.
  assert.equal(h.count("minute"), 1, "fresh within 60s");
  assert.equal(h.count("pr-detail"), 1, "fresh within 30s");
  assert.equal(h.count("zero"), 2, "staleTime 0 is always stale");

  // No timer fires: the observers' cached isStale still reads fresh.
  clock.advance(15_000);
  assert.equal(
    h.query("pr-detail").observers[0].getCurrentResult().isStale,
    false,
  );
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  assert.equal(h.count("minute"), 1, "35s old, still fresh");
  assert.equal(h.count("pr-detail"), 2, "an open PR 35s old refreshes");
});

test("an errored active query refetches inside its staleTime", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  let fail = false;
  const observer = h.observe("forge-status", { staleTime: 60_000 }, () =>
    fail ? Promise.reject(new Error("unreachable")) : Promise.resolve("ok"),
  );
  await sleep(5);
  fail = true;
  await observer.refetch();
  const q = h.query("forge-status");
  assert.equal(q.state.status, "error");
  assert.equal(q.state.data, "ok", "last-good data kept beside the error");
  clock.advance(1_000);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  assert.equal(h.count("forge-status"), 3);
});

test("errored, no data, Infinity staleTime: focus refetches", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  h.observe("runs-paged-cold", { staleTime: Number.POSITIVE_INFINITY }, () =>
    Promise.reject(new Error("unreachable")),
  );
  await sleep(5);
  const q = h.query("runs-paged-cold");
  assert.equal(q.state.status, "error");
  assert.equal(q.state.data, undefined);
  clock.advance(1_000);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  // NEGATIVE CONTROL: an error arm reading only finite staleTimes skips this read.
  assert.equal(h.count("runs-paged-cold"), 2);
});

test("errored, has data, Infinity staleTime: focus takes no fetch", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  let fail = false;
  const observer = h.observe(
    "runs-paged-deep-errored",
    { staleTime: Number.POSITIVE_INFINITY },
    () =>
      fail ? Promise.reject(new Error("unreachable")) : Promise.resolve("deep"),
  );
  await sleep(5);
  fail = true;
  await observer.refetch();
  const q = h.query("runs-paged-deep-errored");
  assert.equal(q.state.status, "error");
  assert.equal(q.state.data, "deep");
  clock.advance(10 ** 7);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  // NEGATIVE CONTROL: an error arm refetching every errored query replays it.
  assert.equal(h.count("runs-paged-deep-errored"), 2);
});

test("inactive queries are never fetched and never invalidated", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  h.qc.setQueryData(["repo", "C:/a", "disabled"], "cached");
  h.observe("disabled", { enabled: false });
  h.observe("unobserved-after", { staleTime: 0 });
  await sleep(5);
  // Leave this one in the cache with no observer at all.
  const unobserved = h.query("unobserved-after");
  for (const o of [...unobserved.observers]) unobserved.removeObserver(o);
  clock.advance(10 ** 7);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  // NEGATIVE CONTROL: a plain repo invalidation marks both invalidated.
  for (const name of ["disabled", "unobserved-after"]) {
    assert.equal(h.query(name).state.isInvalidated, false, name);
  }
  assert.equal(h.count("disabled"), 0);
  assert.equal(h.count("unobserved-after"), 1);
});

test("a function staleTime resolves per query; Infinity never refetches", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  // The Actions runs-paged shape: deep pages never go stale on their own.
  h.observe(
    "runs-paged-deep",
    {
      staleTime: (query) =>
        query.state.data === "deep" ? Number.POSITIVE_INFINITY : 10_000,
    },
    () => Promise.resolve("deep"),
  );
  h.observe("runs-paged-shallow", {
    staleTime: (query) =>
      query.state.data === "deep" ? Number.POSITIVE_INFINITY : 10_000,
  });
  await sleep(5);
  clock.advance(10 ** 7);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  assert.equal(h.count("runs-paged-deep"), 1);
  assert.equal(h.count("runs-paged-shallow"), 2);
});

test("a chased lens is stale-marked, never refetched; its siblings refetch", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  h.observe("lens-chased", { staleTime: 60_000 });
  h.observe("lens-sibling", { staleTime: 60_000 });
  await sleep(5);
  clock.advance(120_000);
  const held = new Map([[h.query("lens-chased").queryHash, 1]]);
  refetchRepoQueriesOnFocus(h.qc, held);
  await sleep(5);
  assert.equal(h.count("lens-chased"), 1);
  assert.equal(h.query("lens-chased").state.isInvalidated, true);
  assert.equal(h.count("lens-sibling"), 2);
  assert.equal(h.query("lens-sibling").state.isInvalidated, false);
});

test("focus touches only the repo subtree", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const clock = fakeClock(t);
  const h = harness(t);
  let other = 0;
  const observer = new QueryObserver(h.qc, {
    queryKey: ["settings"],
    queryFn: () => Promise.resolve(++other),
  });
  const unsub = observer.subscribe(() => {});
  t.after(unsub);
  await sleep(5);
  clock.advance(10 ** 7);
  refetchRepoQueriesOnFocus(h.qc, new Map());
  await sleep(5);
  assert.equal(other, 1);
});

// ── Header badge: the per-mode placeholder axis ─────────────────────────────

/** The core.ts helper's semantics (core.ts pulls aliases Node can't resolve):
 *  previous data only when the repo and every listed axis match. */
const keepForAxes = (repo, axes) => (previousData, previousQuery) => {
  const key = previousQuery?.queryKey;
  if (!key || key[1] !== repo) return undefined;
  return axes.every(([i, v]) => key[i] === v) ? previousData : undefined;
};

const run = (id) => ({ id, status: "completed", conclusion: "success" });

/** One badge-shaped observer whose mode decides its key, as useLatestRun does. */
function badgeRun(placeholderFor, seen) {
  const options = (mode, branch) => ({
    queryKey: ["repo", "C:/a", "actions", mode, branch],
    queryFn: () => new Promise(() => {}),
    enabled: false,
    placeholderData: placeholderFor(mode),
    select: (data) => {
      seen.push({ mode, isArray: Array.isArray(data) });
      return Array.isArray(data) ? (data[0] ?? null) : data;
    },
  });
  return { options };
}

test("a mode flip never hands the other read's shape to select", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  t.after(() => qc.clear());
  qc.setQueryData(
    ["repo", "C:/a", "actions", "notify", "main"],
    [run(9), run(8)],
  );
  qc.setQueryData(["repo", "C:/a", "actions", "latest", "main"], run(9));
  const seen = [];
  const badge = badgeRun((mode) => keepForAxes("C:/a", [[3, mode]]), seen);
  const observer = new QueryObserver(qc, badge.options("notify", "main"));
  const unsub = observer.subscribe(() => {});
  t.after(unsub);
  // Branch switch inside a mode: the placeholder is that mode's other key.
  observer.setOptions(badge.options("notify", "feature"));
  const held = observer.getCurrentResult();
  assert.equal(held.isPlaceholderData, true);
  assert.equal(held.data?.id, 9);
  // Mode flip: no placeholder across the axis, so nothing renders as this branch's.
  observer.setOptions(badge.options("latest", "feature-2"));
  const flipped = observer.getCurrentResult();
  assert.equal(flipped.isPlaceholderData, false);
  assert.equal(flipped.data, undefined);
  observer.setOptions(badge.options("latest", "main"));
  assert.equal(observer.getCurrentResult().data?.id, 9);
  assert.ok(seen.some(({ mode }) => mode === "notify"));
  assert.ok(seen.some(({ mode }) => mode === "latest"));
  for (const { mode, isArray } of seen)
    assert.equal(isArray, mode === "notify", `select under ${mode}`);
});

test("premise: a repo-only placeholder WOULD hand the other shape across a flip", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // If this ever stops holding, the axis above guards nothing react-query does.
  const qc = new QueryClient();
  t.after(() => qc.clear());
  qc.setQueryData(["repo", "C:/a", "actions", "notify", "main"], [run(9)]);
  const seen = [];
  const badge = badgeRun(() => keepForAxes("C:/a", []), seen);
  const observer = new QueryObserver(qc, badge.options("notify", "main"));
  const unsub = observer.subscribe(() => {});
  t.after(unsub);
  observer.setOptions(badge.options("latest", "feature"));
  assert.equal(observer.getCurrentResult().isPlaceholderData, true);
  assert.ok(seen.some(({ mode, isArray }) => mode === "latest" && isArray));
});

/** What keeps the fixtures above honest about src/lib/github/actions.ts: the badge
 *  hook's placeholder axis is `[[3, mode …]]`, both factories feed it, each
 *  factory's key holds its mode's name at index 3, and the modes are those names.
 *  Returns the broken links, empty when the source holds. */
function latestRunAxisProblems(source) {
  const body = /export function useLatestRun\([\s\S]*?\r?\n\}\r?\n/.exec(
    source,
  );
  if (!body) return ["useLatestRun not found"];
  const problems = [];
  if (
    !/placeholderData:\s*keepPreviousDataForKeyAxes\(\s*repo,\s*\[\s*\[\s*3,\s*mode\b/.test(
      body[0],
    )
  )
    problems.push("placeholder axis is not [[3, mode]]");
  for (const [factory, segment] of [
    ["runNotifyOptions", "notify"],
    ["latestRunOptions", "latest"],
  ]) {
    if (!new RegExp(`\\b${factory}\\(repo, branch\\)`).test(body[0]))
      problems.push(`${factory} not spread by useLatestRun`);
    const key = new RegExp(
      `export function ${factory}\\([^)]*\\)\\s*\\{\\s*return\\s*\\{\\s*queryKey:\\s*\\[\\s*"repo",\\s*repo,\\s*"actions",\\s*"${segment}"`,
    );
    if (!key.test(source))
      problems.push(`${factory} key index 3 is not "${segment}"`);
  }
  if (!/export type LatestRunMode = "notify" \| "latest";/.test(source))
    problems.push("LatestRunMode no longer names the key segments");
  return problems;
}

test("source pin: useLatestRun keys its placeholder on the mode segment", () => {
  const source = readFileSync(
    new URL("../src/lib/github/actions.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(latestRunAxisProblems(source), []);
  // In-memory controls: each broken link reads as a problem.
  for (const [from, to] of [
    ["[[3, mode", "[[2, mode"],
    [
      'keepPreviousDataForKeyAxes(repo, [[3, mode ?? "latest"]])',
      "keepPreviousDataForRepo(repo)",
    ],
    ['"actions", "notify"', '"actions", "runs"'],
  ]) {
    assert.ok(source.includes(from), `control anchor missing: ${from}`);
    assert.notDeepEqual(
      latestRunAxisProblems(source.replace(from, to)),
      [],
      `${from} -> ${to}`,
    );
  }
});

// ── Push: the one delayed run-list recheck ──────────────────────────────────

/** A cache seeded with every run-list read of `repo`, plus a recorder of the
 *  run-list keys each recheck invalidates. Seeded reads have no observers, so an
 *  invalidation only MARKS them, which is what these rows read. */
function runListCache(t, repo) {
  const qc = new QueryClient();
  t.after(() => qc.clear());
  const key = (kind, ...rest) => ["repo", repo, "actions", kind, ...rest];
  qc.setQueryData(key("notify", "main"), [{ id: 1 }]);
  qc.setQueryData(key("latest", "main"), { id: 1 });
  qc.setQueryData(key("runs", ""), [{ id: 1 }]);
  qc.setQueryData(key("runs-paged", "shallow"), {
    pages: [{ runs: [] }],
    pageParams: [1],
  });
  qc.setQueryData(key("runs-paged", "deep"), {
    pages: [{ runs: [] }, { runs: [] }],
    pageParams: [1, 2],
  });
  const marked = (kind, ...rest) =>
    qc.getQueryCache().find({ queryKey: key(kind, ...rest), exact: true }).state
      .isInvalidated;
  const calls = [];
  const invalidate = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = (filters, options) => {
    calls.push(filters.queryKey[3]);
    return invalidate(filters, options);
  };
  return { qc, marked, calls };
}

test("a push's recheck marks every run list but a deep-paged one, 8 s later", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = runListCache(t, "C:/push-a");
  recheckRunsAfterPush(c.qc, "C:/push-a");
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS - 1);
  assert.equal(c.marked("notify", "main"), false, "fired early");
  t.mock.timers.tick(1);
  assert.equal(c.marked("notify", "main"), true);
  assert.equal(c.marked("latest", "main"), true);
  assert.equal(c.marked("runs", ""), true);
  assert.equal(c.marked("runs-paged", "shallow"), true);
  // NEGATIVE CONTROL: without the page predicate the deep list is marked too.
  assert.equal(c.marked("runs-paged", "deep"), false, "a deep list replays");
});

test("two pushes within 8 s fire ONE recheck, 8 s after the second", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = runListCache(t, "C:/push-b");
  recheckRunsAfterPush(c.qc, "C:/push-b");
  t.mock.timers.tick(5_000);
  recheckRunsAfterPush(c.qc, "C:/push-b");
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS - 1);
  assert.deepEqual(c.calls, [], "the first push's timer still fired");
  t.mock.timers.tick(1);
  assert.deepEqual(c.calls, ["notify", "latest", "runs", "runs-paged"]);
  t.mock.timers.tick(60_000);
  assert.equal(c.calls.length, 4, "a second recheck fired");
});

test("two repos each keep their own recheck", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = runListCache(t, "C:/push-c");
  const b = runListCache(t, "C:/push-d");
  recheckRunsAfterPush(a.qc, "C:/push-c");
  t.mock.timers.tick(3_000);
  recheckRunsAfterPush(b.qc, "C:/push-d");
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS - 3_000);
  assert.equal(a.marked("notify", "main"), true, "repo c's recheck was lost");
  assert.equal(b.marked("notify", "main"), false);
  t.mock.timers.tick(3_000);
  assert.equal(b.marked("notify", "main"), true, "repo d's recheck was lost");
  assert.equal(a.calls.length, 4);
  assert.equal(b.calls.length, 4);
});

// ── Push: the PR checks reads an arm hands the recheck ──────────────────────

/** A cache seeded with a run list and the PR reads an arm can hand the recheck:
 *  two PRs' details in origin, one's diff under it, one in upstream, and the
 *  list's CI map. */
function prChecksCache(t, repo) {
  const qc = new QueryClient();
  t.after(() => qc.clear());
  const keys = {
    runs: ["repo", repo, "actions", "runs", ""],
    details7: ["repo", repo, "pr", "origin", 7],
    diff7: ["repo", repo, "pr", "origin", 7, "diff"],
    details8: ["repo", repo, "pr", "origin", 8],
    upstream7: ["repo", repo, "pr", "upstream", 7],
    ci: ["repo", repo, "pr-ci", "origin", "open", null, "7:"],
  };
  for (const key of Object.values(keys)) qc.setQueryData(key, { seeded: true });
  const marked = (name) =>
    qc.getQueryCache().find({ queryKey: keys[name], exact: true }).state
      .isInvalidated;
  return { qc, keys, marked };
}

/** Two arms 5 s apart, each handing different PR reads, must fire ONE pass 8 s
 *  after the second that covers both arms' reads and nothing else. */
function assertUnionFires(t, recheck, repo) {
  const c = prChecksCache(t, repo);
  recheck(c.qc, repo, [{ queryKey: c.keys.details7, exact: true }]);
  t.mock.timers.tick(5_000);
  recheck(c.qc, repo, [{ queryKey: ["repo", repo, "pr-ci", "origin"] }]);
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS - 1);
  assert.equal(c.marked("runs"), false, "the first arm's timer still fired");
  t.mock.timers.tick(1);
  assert.equal(c.marked("runs"), true);
  assert.equal(c.marked("details7"), true, "the first arm's read was dropped");
  assert.equal(c.marked("ci"), true, "the second arm's read was dropped");
  assert.equal(c.marked("diff7"), false, "an exact read reached its subtree");
  assert.equal(c.marked("details8"), false);
  assert.equal(c.marked("upstream7"), false);
}

test("coalesced arms fire ONE recheck covering every arm's PR reads", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assertUnionFires(t, recheckRunsAfterPush, "C:/push-e");
});

test("NEGATIVE CONTROL: a recheck that keeps only the latest arm's reads fails the union pin", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The helper with its union reverted: a re-arm replaces what was owed.
  const timers = new Map();
  const latestOnly = (qc, repo, extra = []) => {
    clearTimeout(timers.get(repo));
    timers.set(
      repo,
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["repo", repo, "actions"] });
        for (const f of extra)
          void qc.invalidateQueries({ queryKey: f.queryKey, exact: f.exact });
      }, PUSH_RUN_RECHECK_MS),
    );
  };
  assert.throws(
    () => assertUnionFires(t, latestOnly, "C:/push-f"),
    assert.AssertionError,
  );
});

test("a numbered-child read re-reads every PR's details in the lens, nothing under them", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = prChecksCache(t, "C:/push-g");
  recheckRunsAfterPush(c.qc, "C:/push-g", [
    { queryKey: ["repo", "C:/push-g", "pr", "origin"], numberedChild: true },
  ]);
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS);
  assert.equal(c.marked("details7"), true);
  assert.equal(c.marked("details8"), true);
  assert.equal(c.marked("diff7"), false);
  assert.equal(c.marked("upstream7"), false);
  assert.equal(c.marked("ci"), false);
});

test("overlapping owed filters invalidate a matched query ONCE", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = prChecksCache(t, "C:/push-i");
  const hits = [];
  const invalidate = c.qc.invalidateQueries.bind(c.qc);
  c.qc.invalidateQueries = (filters, options) => {
    hits.push(
      c.qc
        .getQueryCache()
        .findAll(filters)
        .some((q) => q.queryHash === JSON.stringify(c.keys.details7)),
    );
    return invalidate(filters, options);
  };
  // The finish-resolve shape over the lens, plus another arm's exact key in it:
  // two calls on one active query would cancel the first call's refetch.
  recheckRunsAfterPush(c.qc, "C:/push-i", [
    { queryKey: ["repo", "C:/push-i", "pr", "origin"], numberedChild: true },
  ]);
  recheckRunsAfterPush(c.qc, "C:/push-i", [
    { queryKey: c.keys.details7, exact: true },
  ]);
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS);
  assert.equal(hits.filter(Boolean).length, 1, JSON.stringify(hits));
  assert.equal(c.marked("details7"), true);
  assert.equal(c.marked("details8"), true);
});

test("a fired recheck forgets what it owed", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = prChecksCache(t, "C:/push-j");
  recheckRunsAfterPush(c.qc, "C:/push-j", [
    { queryKey: c.keys.details7, exact: true },
  ]);
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS);
  assert.equal(c.marked("details7"), true);
  // Re-seeded reads are fresh again; a later plain arm owes the run lists only.
  c.qc.setQueryData(c.keys.details7, { seeded: true });
  c.qc.setQueryData(c.keys.runs, { seeded: true });
  recheckRunsAfterPush(c.qc, "C:/push-j");
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS);
  assert.equal(c.marked("runs"), true);
  assert.equal(c.marked("details7"), false, "the first fire's reads re-fired");
});

test("a plain arm re-reads no PR reads", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = prChecksCache(t, "C:/push-h");
  recheckRunsAfterPush(c.qc, "C:/push-h");
  t.mock.timers.tick(PUSH_RUN_RECHECK_MS);
  assert.equal(c.marked("runs"), true);
  for (const name of ["details7", "diff7", "details8", "upstream7", "ci"])
    assert.equal(c.marked(name), false, name);
});

// ── Push: prChecksRecheck's key shapes against the reads they must reach ─────

/** The three filter shapes `prChecksRecheck` (queries/pr-actions.ts) builds (a
 *  call hands two: exact or lens-wide, plus the CI map), spelled as the source
 *  pin below requires them, for repo `r`, lens `origin` and, for the exact shape,
 *  PR 7. */
const PR_CHECKS_SHAPES = {
  exact: { queryKey: ["repo", "r", "pr", "origin", 7], exact: true },
  lensWide: { queryKey: ["repo", "r", "pr", "origin"], numberedChild: true },
  ci: { queryKey: ["repo", "r", "pr-ci", "origin"] },
};

test("source pin: prChecksRecheck builds the exact, lens-wide and CI-map shapes", () => {
  const source = readFileSync(
    new URL("../src/lib/git/queries/pr-actions.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  for (const shape of [
    '{ queryKey: ["repo", repo, "pr", lens], numberedChild: true }',
    '{ queryKey: ["repo", repo, "pr", lens, number], exact: true }',
    "{ queryKey: [...repoKeys.prCi(repo), lens] }",
  ])
    assert.ok(source.includes(shape), shape);
  // The details key the exact shape mirrors (prs.ts prDetailsOptions).
  const prs = readFileSync(
    new URL("../src/lib/git/queries/prs.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.ok(
    prs.includes('queryKey: ["repo", repo, "pr", lens, number] as const'),
  );
  // The CI-map key the CI shape prefixes: usePrListCi's lens follows the prCi
  // family, and core.ts spells that family ["repo", repo, "pr-ci"].
  const ci = prs.slice(prs.indexOf("export function usePrListCi("));
  assert.ok(/queryKey: \[\s*\.\.\.repoKeys\.prCi\(repo\),\s*lens,/.test(ci));
  const core = readFileSync(
    new URL("../src/lib/git/queries/core.ts", import.meta.url),
    "utf8",
  );
  assert.ok(core.includes('prCi: (repo: string) => ["repo", repo, "pr-ci"]'));
});

test("recheckFilterMatches: exact, numbered-child and prefix modes", () => {
  const m = (shape, key) => recheckFilterMatches(PR_CHECKS_SHAPES[shape], key);
  const details7 = ["repo", "r", "pr", "origin", 7];
  const diff7 = ["repo", "r", "pr", "origin", 7, "diff"];
  const details8 = ["repo", "r", "pr", "origin", 8];
  const upstream7 = ["repo", "r", "pr", "upstream", 7];
  const named = ["repo", "r", "pr", "origin", "resolve-worktree"];
  const ciPage = ["repo", "r", "pr-ci", "origin", "open", null, "7:"];
  const ciUpstream = ["repo", "r", "pr-ci", "upstream", "open", null, "7:"];
  assert.equal(m("exact", details7), true);
  assert.equal(m("exact", diff7), false, "exact reached the subtree");
  assert.equal(m("exact", details8), false);
  assert.equal(m("lensWide", details7), true);
  assert.equal(m("lensWide", details8), true);
  assert.equal(m("lensWide", diff7), false, "lens-wide reached the subtree");
  assert.equal(m("lensWide", named), false, "a non-number leaf matched");
  assert.equal(m("lensWide", upstream7), false, "lens-wide crossed lenses");
  assert.equal(m("ci", ciPage), true);
  assert.equal(m("ci", ciUpstream), false);
  assert.equal(m("ci", details7), false);
  // A shorter key never matches a longer prefix.
  assert.equal(m("exact", ["repo", "r", "pr"]), false);
});

// ── Remote-branch delete: the one delayed PR-list re-read ──────────────────

/** Two arms 5 s apart must fire ONE invalidation, covering the union of both
 *  arms' keys and nothing else, `LIST_RECHECK_MS` after the second.
 *  Throws on any other shape. */
function assertPrListRecheckReArms(t, recheck, repo) {
  const qc = new QueryClient();
  t.after(() => qc.clear());
  const calls = [];
  qc.invalidateQueries = (filters) => {
    calls.push(filters);
    return Promise.resolve();
  };
  recheck(qc, repo, [["repo", repo, "first"]]);
  t.mock.timers.tick(5_000);
  recheck(qc, repo, [
    ["repo", repo, "pr-list"],
    ["repo", repo, "prs"],
  ]);
  t.mock.timers.tick(LIST_RECHECK_MS - 1);
  assert.deepEqual(calls, [], "the first delete's timer still fired");
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1, "the owed keys fired as more than one call");
  const covers = (queryKey) => calls[0].predicate({ queryKey });
  for (const key of [
    ["repo", repo, "first"],
    ["repo", repo, "first", "x"],
    ["repo", repo, "pr-list", "origin", "open"],
    ["repo", repo, "prs", "origin", "feature"],
  ])
    assert.equal(covers(key), true, `missed ${JSON.stringify(key)}`);
  for (const key of [
    ["repo", repo, "pr-review-state"],
    ["repo", repo, "issue-list", "origin"],
    ["repo", "C:/other", "pr-list", "origin"],
    ["repo", repo],
  ])
    assert.equal(covers(key), false, `covered ${JSON.stringify(key)}`);
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 1, "a second re-read fired");
}

test("two remote deletes within 8 s fire ONE PR-list re-read, of both deletes' keys", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assertPrListRecheckReArms(t, recheckListsLater, "C:/del-a");
});

test("NEGATIVE CONTROL: a stacking PR-list re-read fails the re-arm pin", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The helper with its clearTimeout re-arm reverted: every call keeps its timer.
  const stacking = (qc, _repo, keys) => {
    setTimeout(() => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    }, LIST_RECHECK_MS);
  };
  assert.throws(
    () => assertPrListRecheckReArms(t, stacking, "C:/del-b"),
    assert.AssertionError,
  );
});
