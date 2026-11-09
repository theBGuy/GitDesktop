// Pins the History panel's unpushed/editable view
// (src/features/history/editable-set.ts): the log and status refetch apart, so
// the unpushed consumers read them only as a pair that agrees on HEAD (and,
// without an upstream, on a count read as fresh as the log), keep the last
// agreeing set through a mismatch only while the log still shows its head,
// and fall to nothing editable otherwise; plus the sync gates that refetch the
// trailing side without looping, re-read the HEAD-move set only where a read
// predates the move, and recheck an aged no-upstream count; and squash's gate
// with its hold precedence, and Edit history's hold codes in their precedence
// order.
//
// Not testable here: the component's ref holding the last-seen oid (its update
// rule is `observeHeadOid`, pinned below), the render-time setState loop,
// effect timing under <Activity>, and the react-query invalidations
// themselves. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceSnapshot,
  deriveEditRange,
  EDIT_MAX,
  editHistoryHold,
  headAgrees,
  isNoUpstream,
  NO_UPSTREAM_COUNT_RECHECK_MS,
  observeHeadOid,
  observeSeeded,
  preMoveStale,
  resolveUnpushedView,
  squashGate,
  statusContentSignature,
  statusLogAction,
  undoPushedHold,
  viewAgrees,
} from "../src/features/history/editable-set.ts";

const commit = (hash, isMerge = false) => ({ hash, isMerge });
const hashes = (list) => list.map((c) => c.hash);
const REPO = "C:/repos/app";
const BRANCH = "main";

// Two pushed commits (C1, C0) under two unpushed ones; N lands from outside.
const OLD_LOG = ["U2", "U1", "C1", "C0"].map((h) => commit(h));
const NEW_LOG = [commit("N"), ...OLD_LOG];

function snap(commits, count, over = {}) {
  return {
    repo: REPO,
    branch: BRANCH,
    commits,
    count,
    hasNextPage: false,
    ...over,
  };
}

function resolve(over) {
  return resolveUnpushedView({
    agreed: false,
    repo: REPO,
    branch: BRANCH,
    statusOid: undefined,
    liveAhead: 0,
    noUpstream: false,
    commits: [],
    count: 0,
    hasNextPage: false,
    snapshot: null,
    ...over,
  });
}

/** The hashes a view marks unpushed. */
const unpushed = (view) => hashes(view.commits.slice(0, view.count));
/** The live log sliced by the live count, with no HEAD gate, whatever HEAD
 *  each read saw. */
const ungated = (commits, count) => hashes(commits.slice(0, count));

test("headAgrees: only a present log head equal to a present oid", () => {
  assert.equal(headAgrees("abc", "abc"), true);
  assert.equal(headAgrees("abc", "def"), false);
  assert.equal(headAgrees("abc", null), false, "unborn repo");
  assert.equal(headAgrees("abc", undefined), false, "status pending");
  assert.equal(headAgrees(undefined, "abc"), false, "empty log");
});

test("viewAgrees: heads, then the no-upstream count's HEAD", () => {
  const base = {
    logHead: "U2",
    statusOid: "U2",
    noUpstream: false,
    countIsError: false,
    countHead: undefined,
  };
  assert.equal(viewAgrees(base), true, "upstream mode ignores the count read");
  assert.equal(viewAgrees({ ...base, statusOid: "N" }), false, "head mismatch");
  assert.equal(
    viewAgrees({ ...base, noUpstream: true, countHead: "U2" }),
    true,
    "a count taken on the same HEAD agrees, whatever its read order",
  );
  for (const [countHead, label] of [
    ["U1", "a count taken on another head"],
    [null, "an unborn-HEAD count"],
    [undefined, "no count read"],
  ]) {
    assert.equal(
      viewAgrees({ ...base, noUpstream: true, countHead }),
      false,
      label,
    );
  }
  assert.equal(
    viewAgrees({ ...base, noUpstream: true, countHead: "U2", countIsError: true }),
    false,
    "an errored count whose retained data names the same head",
  );
});

test("resolveUnpushedView: agreement passes the live values through", () => {
  const view = resolve({
    agreed: true,
    statusOid: "U2",
    liveAhead: 2,
    commits: OLD_LOG,
    count: 2,
    hasNextPage: true,
    snapshot: snap(NEW_LOG, 3),
  });
  assert.equal(view.commits, OLD_LOG);
  assert.equal(view.count, 2);
  assert.equal(view.hasNextPage, true);
});

test("status-first mismatch serves the lineage-valid snapshot", () => {
  // N committed outside: status says oid N, ahead 3; the log hasn't refetched.
  const view = resolve({
    statusOid: "N",
    liveAhead: 3,
    commits: OLD_LOG,
    count: 3,
    snapshot: snap(OLD_LOG, 2),
  });
  assert.deepEqual(unpushed(view), ["U2", "U1"]);
  assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 3));
  const range = deriveEditRange(view.commits, view.count, view.hasNextPage);
  assert.deepEqual(hashes(range.editCommits), ["U2", "U1"]);
  assert.equal(range.editBase, "C1");
  assert.notDeepStrictEqual(
    hashes(range.editCommits),
    hashes(deriveEditRange(OLD_LOG, 3, false).editCommits),
    "the ungated range lists the pushed C1 as editable",
  );
});

test("log-first: commits added on top fall to the zero arm", () => {
  // The log refetched first: it has N above the snapshot head U2, status still
  // reports U2 / ahead 2. Serving [U2, U1] on base C1 would drop N on apply.
  const view = resolve({
    statusOid: "U2",
    liveAhead: 2,
    commits: NEW_LOG,
    count: 2,
    snapshot: snap(OLD_LOG, 2),
  });
  assert.strictEqual(view.count, 0);
  assert.deepEqual(unpushed(view), []);
  assert.equal(deriveEditRange(view.commits, view.count, false).editLen, 0);
  assert.notDeepStrictEqual(
    unpushed(view),
    ["U2", "U1"],
    "the snapshot whose head is merely present below the log's head",
  );
  assert.notDeepStrictEqual(unpushed(view), ungated(NEW_LOG, 2));
});

test("a foreign-repo snapshot falls to the zero arm", () => {
  const view = resolve({
    statusOid: "N",
    liveAhead: 3,
    commits: OLD_LOG,
    count: 3,
    snapshot: snap(OLD_LOG, 2, { repo: "C:/repos/other" }),
  });
  assert.strictEqual(view.count, 0);
  assert.deepEqual(unpushed(view), []);
  assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 3));
  assert.notDeepStrictEqual(unpushed(view), ["U2", "U1"]);
});

test("a lineage break (snapshot head gone from the log) falls to zero", () => {
  // An outside reset/rebase or a checkout landed log-first: X2 is orphaned.
  const orphaned = ["X2", "X1", "C0"].map((h) => commit(h));
  const view = resolve({
    statusOid: "X2",
    liveAhead: 2,
    commits: OLD_LOG,
    count: 2,
    snapshot: snap(orphaned, 2),
  });
  assert.strictEqual(view.count, 0);
  assert.deepEqual(unpushed(view), []);
  assert.notDeepStrictEqual(unpushed(view), ungated(orphaned, 2));
  assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 2));
});

test("a branch change (detached included) falls to zero", () => {
  for (const [snapBranch, liveBranch] of [
    ["main", "feature"],
    ["main", null],
    [null, "main"],
  ]) {
    const view = resolve({
      branch: liveBranch,
      statusOid: "N",
      liveAhead: 3,
      commits: OLD_LOG,
      count: 3,
      snapshot: snap(OLD_LOG, 2, { branch: snapBranch }),
    });
    const label = `${snapBranch} -> ${liveBranch}`;
    assert.strictEqual(view.count, 0, label);
    assert.deepEqual(unpushed(view), [], label);
    assert.notDeepStrictEqual(unpushed(view), ["U2", "U1"], label);
    assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 3), label);
  }
});

test("a detached HEAD on both sides still serves its snapshot", () => {
  const view = resolve({
    branch: null,
    statusOid: "N",
    liveAhead: 3,
    commits: OLD_LOG,
    count: 3,
    snapshot: snap(OLD_LOG, 2, { branch: null }),
  });
  assert.deepEqual(unpushed(view), ["U2", "U1"]);
  assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 3));
});

test("commit+push cap: upstream mode trims a snapshot status has outrun", () => {
  const over = { statusOid: "N", commits: OLD_LOG, snapshot: snap(OLD_LOG, 2) };
  // `git commit && git push` in one poll: oid N, ahead 0, the old log.
  const pushed = resolve({ ...over, liveAhead: 0, count: 0 });
  assert.strictEqual(pushed.count, 0);
  assert.deepEqual(unpushed(pushed), []);
  assert.notDeepStrictEqual(
    unpushed(pushed),
    ["U2", "U1"],
    "uncapped snapshot",
  );
  // commit, push, commit: ahead 1 covers only the newest, not yet in the log.
  const pushedThenOne = resolve({ ...over, liveAhead: 1, count: 1 });
  assert.strictEqual(pushedThenOne.count, 0);
  assert.notDeepStrictEqual(unpushed(pushedThenOne), ["U2", "U1"]);
  // A plain outside commit keeps the whole snapshot.
  const plain = resolve({ ...over, liveAhead: 3, count: 3 });
  assert.deepEqual(unpushed(plain), ["U2", "U1"]);
  assert.notDeepStrictEqual(unpushed(plain), ungated(OLD_LOG, 3));
  // No-upstream mode's count is its own read: no cap.
  const noUpstream = resolve({
    ...over,
    noUpstream: true,
    liveAhead: 0,
    count: 2,
  });
  assert.deepEqual(unpushed(noUpstream), ["U2", "U1"]);
  // The cap applies only while status has outrun the snapshot head.
  const sameHead = resolve({
    ...over,
    statusOid: "U2",
    liveAhead: 0,
    count: 0,
  });
  assert.deepEqual(unpushed(sameHead), ["U2", "U1"]);
});

test("advanceSnapshot: identity contract", () => {
  const live = snap(OLD_LOG, 2);
  assert.equal(
    advanceSnapshot(null, live, false),
    null,
    "null until agreement",
  );
  assert.equal(advanceSnapshot(null, live, true), live);
  assert.equal(advanceSnapshot(live, live, true), live);
  const fieldEqual = { ...live };
  assert.equal(
    advanceSnapshot(live, fieldEqual, true),
    live,
    "field-equal prev",
  );
  const other = snap(NEW_LOG, 3);
  assert.equal(advanceSnapshot(live, other, false), live, "!agreed keeps prev");
  for (const [field, value] of [
    ["repo", "C:/repos/other"],
    ["branch", "feature"],
    ["branch", null],
    ["commits", [...OLD_LOG]],
    ["count", 3],
    ["hasNextPage", true],
  ]) {
    const next = { ...live, [field]: value };
    assert.equal(advanceSnapshot(live, next, true), next, `${field} differs`);
  }
});

test("a mismatched first render seeds nothing and marks nothing", () => {
  // Warm reopen: a stale cached log against fresh status, no snapshot yet.
  const live = snap(OLD_LOG, 3);
  const seeded = advanceSnapshot(null, live, false);
  assert.equal(seeded, null);
  const view = resolve({
    statusOid: "N",
    liveAhead: 3,
    commits: OLD_LOG,
    count: 3,
    snapshot: seeded,
  });
  assert.strictEqual(view.count, 0);
  assert.notDeepStrictEqual(unpushed(view), ungated(OLD_LOG, 3));
  assert.equal(deriveEditRange(view.commits, view.count, false).editLen, 0);
});

const SYNC_BASE = {
  oid: "N",
  oidChanged: false,
  logHead: "U2",
  logHasData: true,
  logIsFetching: false,
  logAt: 100,
  statusAt: 200,
  noUpstream: false,
  countIsError: false,
  countIsFetching: false,
  countAt: 0,
  countErrorAt: 0,
  countHead: "N",
  logErrorAt: 0,
  refsChanged: false,
  contentChanged: false,
};
const sync = (over) => {
  const actions = statusLogAction({ ...SYNC_BASE, ...over });
  return actions === null ? null : [...actions].sort();
};

test("statusLogAction: the log refetches only as the stale side", () => {
  assert.deepEqual(sync({}), ["refetch-log"], "stale log");
  assert.equal(sync({ logAt: 300 }), null, "log newer than status");
  assert.equal(sync({ logAt: 200 }), null, "log as fresh as status");
  assert.equal(sync({ logIsFetching: true }), null, "already fetching");
  assert.equal(sync({ logHead: "N" }), null, "heads agree");
  assert.equal(
    sync({ oid: null, logHead: undefined }),
    null,
    "unborn repo: settled-empty log, null oid",
  );
  assert.equal(
    sync({ logHead: undefined, logHasData: false }),
    null,
    "pending log",
  );
  assert.deepEqual(
    sync({ logHead: undefined }),
    ["refetch-log"],
    "settled-empty log once status reports a first commit",
  );
});

test("statusLogAction: side keys fire exactly on an observed oid change", () => {
  assert.deepEqual(sync({ oidChanged: true }), [
    "refetch-log",
    "refresh-head-set",
    "refresh-side-keys",
  ]);
  assert.deepEqual(
    sync({ oidChanged: true, logAt: 300 }),
    ["refresh-head-set", "refresh-side-keys"],
    "log-first: the side keys still fire",
  );
  assert.deepEqual(sync({ oidChanged: true, logHead: "N", logAt: 300 }), [
    "refresh-head-set",
    "refresh-side-keys",
  ]);
  assert.equal(sync({ logAt: 300 }), null, "no oid change, no side keys");
});

test("statusLogAction: the HEAD-move set fires exactly on an oid change", () => {
  for (const [label, over] of [
    ["stale log", {}],
    ["fresh log", { logAt: 300 }],
    ["agreeing log", { logHead: "N", logAt: 300 }],
    ["log fetching", { logIsFetching: true }],
    ["no upstream, stale count", { noUpstream: true, countAt: 50 }],
  ]) {
    assert.ok(
      sync({ ...over, oidChanged: true }).includes("refresh-head-set"),
      `${label}: an observed move fires it`,
    );
    assert.ok(
      !(sync({ ...over, oidChanged: false }) ?? []).includes(
        "refresh-head-set",
      ),
      `${label}: no observed move, no fire`,
    );
  }
});

test("statusLogAction: the no-upstream count retries once heads agree", () => {
  const agreeing = { logHead: "N", noUpstream: true, logAt: 100 };
  assert.deepEqual(
    sync({ ...agreeing, countHead: "U2", countAt: 50 }),
    ["refresh-count"],
    "taken on another head and older than the status reading",
  );
  assert.equal(
    sync({ ...agreeing, countHead: "U2", countAt: 250 }),
    null,
    "taken on a head NEWER than a lagging status: no loop",
  );
  assert.deepEqual(
    sync({ ...agreeing, countAt: 150, countIsError: true, countErrorAt: 150 }),
    ["refresh-count"],
    "errored, its failure older than the status reading",
  );
  assert.equal(
    sync({ ...agreeing, countAt: 150, countIsError: true, countErrorAt: 200 }),
    null,
    "errored at the status reading: retried once per status reading",
  );
  assert.equal(
    sync({ ...agreeing, countAt: 150, countIsError: true, countErrorAt: 250 }),
    null,
    "errored after the status reading",
  );
  assert.equal(sync({ ...agreeing, countAt: 150 }), null, "same head");
  assert.equal(
    sync({ ...agreeing, countAt: 50 }),
    null,
    "same head, older than the log: identity, not read order",
  );
  assert.equal(
    sync({ ...agreeing, countHead: "U2", countAt: 50, countIsFetching: true }),
    null,
    "a count read in flight must land",
  );
  assert.deepEqual(
    sync({ ...agreeing, countHead: "U2", countAt: 50, oidChanged: true }),
    ["refresh-head-set", "refresh-side-keys"],
    "the side keys already cover the count",
  );
  assert.equal(
    sync({ ...agreeing, logHead: "U2", countAt: 50, logAt: 300 }),
    null,
    "heads differ",
  );
  assert.equal(
    sync({ ...agreeing, noUpstream: false, countHead: "U2", countAt: 50 }),
    null,
    "upstream mode",
  );
});

test("statusLogAction: a no-upstream count past the recheck age re-reads", () => {
  assert.equal(NO_UPSTREAM_COUNT_RECHECK_MS, 30_000);
  // The count is fresher than the log, so only its age against the status
  // reading can fire it (a terminal push moves no HEAD).
  const countAt = 1_000;
  const aged = (age, over = {}) =>
    sync({
      logHead: "N",
      noUpstream: true,
      logAt: 500,
      countAt,
      statusAt: countAt + age,
      ...over,
    });
  assert.deepEqual(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS),
    ["refresh-count"],
    "exactly at the threshold",
  );
  assert.equal(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS - 1),
    null,
    "1 ms under the threshold",
  );
  assert.deepEqual(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS + 5_000),
    ["refresh-count"],
    "over the threshold",
  );
  assert.equal(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS + 5_000, { countIsFetching: true }),
    null,
    "a count read in flight must land",
  );
  assert.deepEqual(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS + 5_000, { oidChanged: true }),
    ["refresh-head-set", "refresh-side-keys"],
    "an oid change refreshes the count through the side keys instead",
  );
  assert.deepEqual(
    aged(1, { countIsError: true, countErrorAt: countAt }),
    ["refresh-count"],
    "an errored count re-reads under the threshold too",
  );
  assert.equal(
    aged(NO_UPSTREAM_COUNT_RECHECK_MS + 5_000, { noUpstream: false }),
    null,
    "upstream mode reads status's ahead, never the count",
  );
});

test("preMoveStale: only idle reads older than the last pre-move status", () => {
  const stale = (over) =>
    preMoveStale({
      fetchStatus: "idle",
      dataUpdatedAt: 100,
      prevStatusAt: 200,
      ...over,
    });
  assert.equal(stale({}), true, "pre-move data is re-read");
  assert.equal(
    stale({ dataUpdatedAt: 200 }),
    true,
    "data from the very reading the old oid held at is pre-move",
  );
  assert.equal(
    stale({ dataUpdatedAt: 0 }),
    true,
    "a never-fetched read is re-read",
  );
  assert.equal(
    stale({ dataUpdatedAt: 201 }),
    false,
    "a read refreshed since (an in-app write's invalidation) is skipped",
  );
  assert.equal(
    stale({ fetchStatus: "fetching" }),
    false,
    "a read already refreshing is skipped",
  );
  assert.equal(stale({ fetchStatus: "paused" }), false, "a paused read waits");
  assert.equal(
    stale({ dataUpdatedAt: 100, prevStatusAt: 0 }),
    false,
    "no earlier status reading: nothing is known to predate the move",
  );
});

/** Runs one render's derivation the way the panel does: advance the snapshot
 *  on agreement, then resolve the view over it. */
function step(state, input) {
  const agreed = viewAgrees({
    logHead: input.commits[0]?.hash,
    statusOid: input.oid,
    noUpstream: input.noUpstream,
    countIsError: false,
    countHead: input.countHead,
  });
  const live = {
    repo: REPO,
    branch: BRANCH,
    commits: input.commits,
    count: input.count,
    hasNextPage: false,
  };
  state.snapshot = advanceSnapshot(state.snapshot, live, agreed);
  const view = resolveUnpushedView({
    agreed,
    repo: REPO,
    branch: BRANCH,
    statusOid: input.oid,
    liveAhead: input.ahead ?? 0,
    noUpstream: input.noUpstream,
    commits: input.commits,
    count: input.count,
    hasNextPage: false,
    snapshot: state.snapshot,
  });
  const range = deriveEditRange(view.commits, view.count, view.hasNextPage);
  return {
    key: hashes(range.editCommits).join(),
    base: range.editBase,
    ungated: hashes(
      deriveEditRange(input.commits, input.count, false).editCommits,
    ).join(),
  };
}

const changes = (keys) =>
  keys.filter((k, i) => i > 0 && k !== keys[i - 1]).length;

test("an outside commit changes the editable set exactly once (upstream)", () => {
  const state = { snapshot: null };
  const steps = [
    step(state, {
      commits: OLD_LOG,
      oid: "U2",
      ahead: 2,
      count: 2,
      noUpstream: false,
    }),
    // Status-first: N reported, the log not yet refetched.
    step(state, {
      commits: OLD_LOG,
      oid: "N",
      ahead: 3,
      count: 3,
      noUpstream: false,
    }),
    step(state, {
      commits: NEW_LOG,
      oid: "N",
      ahead: 3,
      count: 3,
      noUpstream: false,
    }),
  ];
  assert.deepEqual(
    steps.map((s) => s.key),
    ["U2,U1", "U2,U1", "N,U2,U1"],
  );
  assert.equal(changes(steps.map((s) => s.key)), 1);
  assert.deepEqual(
    steps.map((s) => s.base),
    ["C1", "C1", "C1"],
    "the base holds through the reseed",
  );
  assert.notEqual(
    steps[1].key,
    steps[1].ungated,
    "ungated listed the pushed C1",
  );
  assert.equal(
    changes(steps.map((s) => s.ungated)),
    2,
    "ungated reseeded twice",
  );
});

test("no upstream: a count taken on the old head never pairs with the moved log", () => {
  const state = { snapshot: null };
  const input = { noUpstream: true };
  const steps = [
    step(state, {
      ...input,
      commits: OLD_LOG,
      oid: "U2",
      count: 2,
      countHead: "U2",
    }),
    step(state, {
      ...input,
      commits: OLD_LOG,
      oid: "N",
      count: 2,
      countHead: "U2",
    }),
    // The log lands, but the count read still names the old head: the log has
    // moved past the snapshot head, so nothing is editable until the count
    // re-reads on the new one.
    step(state, {
      ...input,
      commits: NEW_LOG,
      oid: "N",
      count: 2,
      countHead: "U2",
    }),
    step(state, {
      ...input,
      commits: NEW_LOG,
      oid: "N",
      count: 3,
      countHead: "N",
    }),
  ];
  assert.deepEqual(
    steps.map((s) => s.key),
    ["U2,U1", "U2,U1", "", "N,U2,U1"],
  );
  assert.notEqual(steps[2].key, "U2,U1", "the snapshot would drop N");
  assert.notEqual(
    steps[2].key,
    steps[2].ungated,
    "ungated paired the new log with a count taken on the old head",
  );
});

test("deriveEditRange: the edit range and its base", () => {
  assert.equal(EDIT_MAX, 15);
  const many = Array.from({ length: 17 }, (_, i) => commit(`c${i}`));
  const capped = deriveEditRange(many, 17, false);
  assert.equal(capped.editLen, 15);
  assert.equal(capped.editBase, "c15");

  const merged = ["a", "b", "m", "c", "d"].map((h) => commit(h, h === "m"));
  const toMerge = deriveEditRange(merged, 5, true);
  assert.equal(toMerge.editLen, 2);
  assert.deepEqual(hashes(toMerge.editCommits), ["a", "b"]);
  assert.equal(toMerge.editBase, "m");

  const whole = deriveEditRange(OLD_LOG, 4, false);
  assert.equal(whole.editLen, 3, "the bottom commit stays as base");
  assert.equal(whole.editBase, "C0");
  const paged = deriveEditRange(OLD_LOG, 4, true);
  assert.equal(paged.editLen, 4, "more pages: no decrement");
  assert.equal(paged.editBase, "", "the commit below isn't loaded");

  const root = deriveEditRange([commit("R")], 1, false);
  assert.equal(root.editLen, 0);
  assert.deepEqual(root.editCommits, []);
  assert.equal(root.editBase, "R");

  const none = deriveEditRange(OLD_LOG, 0, false);
  assert.equal(none.editLen, 0);
  assert.equal(none.editBase, "U2");

  const empty = deriveEditRange([], 0, false);
  assert.equal(empty.editLen, 0);
  assert.equal(empty.editBase, "");
});

test("isNoUpstream: no upstream or a gone one, never a pending status", () => {
  assert.equal(isNoUpstream({ upstream: null, upstreamGone: false }), true);
  assert.equal(
    isNoUpstream({ upstream: "origin/main", upstreamGone: true }),
    true,
  );
  assert.equal(
    isNoUpstream({ upstream: "origin/main", upstreamGone: false }),
    false,
  );
  assert.equal(isNoUpstream(undefined), false, "status pending");
  assert.equal(isNoUpstream(null), false);
});

test("observeHeadOid: seeds once, keeps through null, fires once per move", () => {
  const first = observeHeadOid(null, "A");
  assert.deepEqual(
    first,
    { next: "A", changed: false },
    "first observation seeds",
  );
  assert.deepEqual(observeHeadOid(null, null), { next: null, changed: false });
  assert.deepEqual(observeHeadOid(null, undefined), {
    next: null,
    changed: false,
  });
  assert.deepEqual(
    observeHeadOid("A", null),
    { next: "A", changed: false },
    "an unborn or pending read keeps the last oid",
  );
  assert.deepEqual(observeHeadOid("A", undefined), {
    next: "A",
    changed: false,
  });
  const moved = observeHeadOid("A", "B");
  assert.deepEqual(moved, { next: "B", changed: true });
  assert.deepEqual(
    observeHeadOid(moved.next, "B"),
    { next: "B", changed: false },
    "the same oid again doesn't fire",
  );
  // A null between two equal oids is no move.
  const held = observeHeadOid(observeHeadOid("A", null).next, "A");
  assert.equal(held.changed, false);
});

// HEAD-first, all non-merge; selections index into it.
const GATE_LOG = ["a", "b", "c", "d", "e"].map((h) => commit(h));
const ALL_UNPUSHED = new Set(hashes(GATE_LOG));
const gate = (over) =>
  squashGate({
    selectedIndices: [0, 1],
    commits: GATE_LOG,
    unpushed: ALL_UNPUSHED,
    filterActive: false,
    agreed: true,
    opInProgress: false,
    ...over,
  });
const holds = (hold) => ({ canSquash: false, hold });

test("squashGate: an operation in progress holds first", () => {
  assert.deepEqual(
    gate({ opInProgress: true }),
    holds("op"),
    "an operation alone holds an otherwise valid range",
  );
  assert.deepEqual(
    gate({ opInProgress: true, filterActive: true, selectedIndices: [0, 2] }),
    holds("op"),
    "ahead of the filter and adjacency holds",
  );
  assert.deepEqual(
    gate({ opInProgress: true, agreed: false }),
    holds("op"),
    "ahead of the refreshing hold",
  );
});

test("squashGate: hold precedence with no operation in progress", () => {
  assert.deepEqual(
    gate({ filterActive: true, selectedIndices: [0, 2] }),
    holds("filter-hides-range"),
    "a filter hiding commits inside the range",
  );
  assert.deepEqual(
    gate({ selectedIndices: [0, 2] }),
    holds("not-adjacent-unpushed"),
    "non-contiguous",
  );
  assert.deepEqual(
    gate({ unpushed: new Set(["a"]) }),
    holds("not-adjacent-unpushed"),
    "one member pushed",
  );
  assert.deepEqual(
    gate({ selectedIndices: [3, 4] }),
    holds("not-adjacent-unpushed"),
    "no base below the range",
  );
  const merged = ["m", "b", "c", "d", "e"].map((h) => commit(h, h === "m"));
  assert.deepEqual(
    gate({
      commits: merged,
      unpushed: new Set(hashes(merged)),
      selectedIndices: [1, 2],
    }),
    holds("not-adjacent-unpushed"),
    "a merge above the base",
  );
  assert.deepEqual(
    gate({ agreed: false }),
    holds("refreshing"),
    "reads disagree",
  );
  assert.deepEqual(
    gate({ selectedIndices: [1, 2] }),
    { canSquash: true, hold: null },
    "happy path",
  );
  assert.deepEqual(
    gate({ selectedIndices: [1] }),
    holds("not-adjacent-unpushed"),
    "single selection",
  );
  assert.deepEqual(
    gate({ selectedIndices: [] }),
    holds("not-adjacent-unpushed"),
    "empty selection",
  );
  assert.deepEqual(
    gate({ filterActive: true, selectedIndices: [1, 2] }),
    { canSquash: true, hold: null },
    "a filter over a contiguous range",
  );
  assert.deepEqual(
    gate({ filterActive: true, selectedIndices: [1, 2], agreed: false }),
    holds("refreshing"),
    "a filter over a contiguous range while the reads disagree",
  );
  assert.deepEqual(
    gate({ selectedIndices: [0, 2], agreed: false }),
    holds("not-adjacent-unpushed"),
    "adjacency is checked before refreshing",
  );
  assert.deepEqual(
    gate({ unpushed: new Set(["a"]), agreed: false }),
    holds("refreshing"),
    "refreshing is checked before the not-allowed fallback",
  );
  assert.deepEqual(
    gate({ filterActive: true, selectedIndices: [0, 2], agreed: false }),
    holds("filter-hides-range"),
    "the filter hold is checked before refreshing",
  );
});

test("editHistoryHold: each held case names its code, op before refreshing before empty", () => {
  // Composed the way the panel does: deriveEditRange first, then the hold
  // over the head-is-merge primitive.
  const hold = (commits, count, over = {}) => {
    const { editLen } = deriveEditRange(commits, count, false);
    return editHistoryHold({
      editLen,
      count,
      headIsMerge: commits[0]?.isMerge === true,
      shallowBoundary: false,
      agreed: true,
      opInProgress: false,
      ...over,
    });
  };
  assert.equal(hold(OLD_LOG, 0), "nothing-unpushed");
  const mergeTop = ["m", "a", "b"].map((h) => commit(h, h === "m"));
  assert.equal(hold(mergeTop, 3), "merge-on-top");
  assert.equal(hold([commit("R")], 1), "lone-commit");
  assert.equal(
    hold([commit("R")], 1, { shallowBoundary: true }),
    "shallow-boundary",
  );
  assert.equal(hold([commit("b"), commit("a")], 2), null, "editLen 1");
  // Precedence: an operation outranks the reads disagreeing, which outrank
  // every empty case.
  assert.equal(hold(OLD_LOG, 0, { opInProgress: true, agreed: false }), "op");
  assert.equal(hold(OLD_LOG, 0, { agreed: false }), "refreshing");
  assert.equal(hold(OLD_LOG, 3, { agreed: false }), "refreshing");
  assert.equal(hold(OLD_LOG, 3, { opInProgress: true }), "op");
  // A count of 0 over a merge on top reads as nothing to edit, the first
  // editLen-0 cause in deriveEditRange's order.
  assert.equal(hold(mergeTop, 0), "nothing-unpushed");
  // A merge on top outranks a shallow boundary.
  assert.equal(
    hold([commit("R", true)], 1, { shallowBoundary: true }),
    "merge-on-top",
  );
});

test("editHistoryHold: available exactly where the old gate was", () => {
  for (const editLen of [0, 1, 3]) {
    for (const agreed of [false, true]) {
      for (const opInProgress of [false, true]) {
        const held = editHistoryHold({
          editLen,
          count: editLen,
          headIsMerge: false,
          shallowBoundary: false,
          agreed,
          opInProgress,
        });
        assert.equal(
          held === null,
          editLen >= 1 && !opInProgress && agreed,
          `editLen ${editLen}, agreed ${agreed}, op ${opInProgress}`,
        );
      }
    }
  }
});

test("statusLogAction: a count read at or after the status reading never re-reads itself", () => {
  const OID = "N";
  const BASES = [
    "remotes",
    "default-branch",
    "on-default-branch",
    "unresolved",
    undefined,
  ];
  let rows = 0;
  const check = (args) => {
    rows++;
    const actions = statusLogAction(args);
    assert.ok(
      !(actions?.has("refresh-count") ?? false),
      `refresh-count fired for ${JSON.stringify(args)}`,
    );
  };
  for (const heads of [true, false])
    for (const [logHasData, logIsFetching] of [
      [true, false],
      [true, true],
    ])
      for (const logAt of [100, 200, 300])
        for (const statusAt of [150, 200, 250])
          for (const countBasis of BASES)
            for (const statusBranch of ["main", "feature", null])
              for (const countHead of [OID, "OTHER", undefined]) {
                const base = {
                  oid: OID,
                  oidChanged: false,
                  refsChanged: false,
                  contentChanged: false,
                  logHead: heads ? OID : "OLD",
                  logHasData,
                  logIsFetching,
                  logAt,
                  logErrorAt: 0,
                  statusAt,
                  noUpstream: true,
                  countIsFetching: false,
                  countBasis,
                  countDefault: "main",
                  countHead,
                  statusBranch,
                };
                for (const countAt of [statusAt, statusAt + 50]) {
                  check({ ...base, countIsError: false, countAt, countErrorAt: 0 });
                }
                // A count that rejects: react-query keeps dataUpdatedAt at the
                // last success (0 when there never was one).
                for (const countAt of [0, statusAt - 40_000, statusAt, statusAt + 50])
                  for (const countErrorAt of [statusAt, statusAt + 50]) {
                    check({ ...base, countIsError: true, countAt, countErrorAt });
                  }
              }
  assert.ok(rows > 5000, `table too small: ${rows}`);
});

test("undoPushedHold: every arm in its order", () => {
  const STATES = [
    { countLoaded: true, countFailed: false },
    { countLoaded: false, countFailed: false },
    { countLoaded: false, countFailed: true },
    { countLoaded: true, countFailed: true },
  ];
  const oracle = (a) => {
    if (a.countFailed) return "unpushed-unchecked";
    if (!a.countLoaded) return "refreshing";
    if (a.basis !== "remotes") return null;
    if (!a.agreed) return "refreshing";
    if (a.count > 0) return null;
    return "already-pushed";
  };
  for (const basis of [
    "remotes",
    "default-branch",
    "on-default-branch",
    "unresolved",
  ])
    for (const state of STATES)
      for (const agreed of [true, false])
        for (const count of [0, 1]) {
          const args = { noUpstream: true, ahead: 0, basis, agreed, count, ...state };
          assert.equal(undoPushedHold(args), oracle(args), JSON.stringify(args));
        }
  const upstream = {
    noUpstream: false,
    countLoaded: false,
    countFailed: true,
    basis: null,
    count: 0,
    agreed: false,
  };
  assert.equal(undoPushedHold({ ...upstream, ahead: 1 }), null, "ahead");
  assert.equal(
    undoPushedHold({ ...upstream, ahead: 0 }),
    "already-pushed",
    "nothing ahead of the upstream",
  );
  assert.equal(
    undoPushedHold({
      noUpstream: true,
      ahead: 0,
      countLoaded: true,
      countFailed: false,
      basis: "remotes",
      count: 0,
      agreed: true,
    }),
    "already-pushed",
    "a remote branch has HEAD's commit",
  );
});

test("statusContentSignature: entries only, order-free, short", () => {
  const a = { path: "a.txt", staged: "modified", unstaged: null };
  const b = { path: "b.txt", staged: null, unstaged: "added" };
  assert.equal(statusContentSignature(undefined), null);
  assert.equal(typeof statusContentSignature([]), "string");
  assert.equal(
    statusContentSignature([a, b]),
    statusContentSignature([b, a]),
    "order-independent",
  );
  assert.notEqual(
    statusContentSignature([a]),
    statusContentSignature([{ ...a, staged: null, unstaged: "modified" }]),
    "a staged/unstaged flip",
  );
  assert.notEqual(
    statusContentSignature([a]),
    statusContentSignature([a, b]),
    "an added path",
  );
  assert.notEqual(
    statusContentSignature([{ ...a, staged: "conflicted" }]),
    statusContentSignature([a]),
    "a kind change",
  );
  const many = Array.from({ length: 5_000 }, (_, i) => ({
    path: `dir/file-${i}.ts`,
    staged: null,
    unstaged: "modified",
  }));
  const sig = statusContentSignature(many);
  assert.ok(sig.length < 64, `signature length ${sig.length}`);
  assert.match(sig, /^5000:[0-9a-f]{16}$/);
});

test("observeSeeded: seeds once, keeps through a missing value", () => {
  assert.deepEqual(observeSeeded(null, "a"), { next: "a", changed: false });
  assert.deepEqual(observeSeeded("a", "a"), { next: "a", changed: false });
  assert.deepEqual(observeSeeded("a", "b"), { next: "b", changed: true });
  assert.deepEqual(observeSeeded("a", null), { next: "a", changed: false });
  assert.deepEqual(observeSeeded("a", undefined), {
    next: "a",
    changed: false,
  });
  assert.deepEqual(observeSeeded(null, ""), { next: "", changed: false });
  assert.deepEqual(observeSeeded("", "x"), { next: "x", changed: true });
  assert.deepEqual(observeSeeded("x", ""), { next: "", changed: true });
});

test("statusLogAction: the ref set, op state and the log's failure gate", () => {
  const settled = { logHead: "N" };
  assert.deepEqual(
    sync({ ...settled, refsChanged: true }),
    ["refresh-op-state", "refresh-ref-set"],
    "the stamp covers the operation sentinels",
  );
  assert.deepEqual(sync({ ...settled, contentChanged: true }), [
    "refresh-op-state",
  ]);
  assert.deepEqual(
    sync({ ...settled, refsChanged: true, contentChanged: true }),
    ["refresh-op-state", "refresh-ref-set"],
  );
  assert.deepEqual(
    sync({ ...settled, refsChanged: true, oidChanged: true }),
    ["refresh-head-set", "refresh-ref-set", "refresh-side-keys"],
    "an oid change already re-reads op state on a stamp move too",
  );
  assert.deepEqual(
    sync({ ...settled, contentChanged: true, oidChanged: true }),
    ["refresh-head-set", "refresh-side-keys"],
    "an oid change already re-reads op state",
  );
  assert.deepEqual(
    sync({
      ...settled,
      noUpstream: true,
      countAt: 0,
      statusAt: 50_000,
      refsChanged: true,
    }),
    ["refresh-op-state", "refresh-ref-set"],
    "the ref set re-reads the count itself",
  );
  assert.deepEqual(
    sync({ ...settled, noUpstream: true, countAt: 0, statusAt: 50_000 }),
    ["refresh-count"],
    "the same count without a stamp move",
  );
  assert.equal(
    sync({ logErrorAt: 250 }),
    null,
    "a log refetch that failed after the status reading waits for the next",
  );
  assert.equal(sync({ logErrorAt: 200 }), null, "failed at the reading");
  assert.deepEqual(
    sync({ logErrorAt: 150 }),
    ["refetch-log"],
    "a failure older than the status reading retries",
  );
});
