// Pins src/lib/settings/heal.ts `settingsSeedCallbacks` against a REAL
// react-query cache: after a settings write succeeds the cache holds that write's
// committed snapshot even when the follow-up re-read fails, unless a newer
// settings write started after it, whose optimistic patch or own seed wins; the
// superseded write then skips its invalidate too, and the newer write's settle
// (a failure included) reconciles. The latest write's invalidate cancels an older
// in-flight read, and `mutateAsync` resolves only once its refetch settled. Also
// pins that every settings mutation hook in queries.ts spreads the factory.
//
// The cache only refetches ACTIVE queries, so every re-read case subscribes a
// QueryObserver; without one the rejecting read never runs and the seed case
// would pass vacuously (its own control below). The seed counter is module-level
// and persists across cases, so seq checks compare relative order only.
//
// The react-query-backed imports are DYNAMIC because the CI `guards` job (no
// install step) can't resolve @tanstack/react-query: unresolved deps skip every
// test here but the source pins, and GD_EXPECT_DEPS turns a skip into a failure
// on an installed run.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

let deps = null;
try {
  const rq = await import("@tanstack/react-query");
  deps = {
    ...(await import("@/lib/settings/heal")),
    ...(await import("@/lib/started-mutation")),
    QueryClient: rq.QueryClient,
    QueryObserver: rq.QueryObserver,
    MutationObserver: rq.MutationObserver,
  };
} catch (e) {
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const {
  QueryClient,
  QueryObserver,
  MutationObserver,
  STARTED_KEY,
  healLoadedSettings,
  settingsSeedCallbacks,
  startedMutationOptions,
} = deps ?? {};

const NEEDS_DEPS =
  "needs node_modules — an installed run with GD_EXPECT_DEPS enforces this";

const HEAL_SOURCE = new URL("../src/lib/settings/heal.ts", import.meta.url);
const QUERIES_SOURCE = new URL(
  "../src/lib/settings/queries.ts",
  import.meta.url,
);
// settingsKeys.settings in queries.ts, which this suite can't load (it pulls the
// Tauri graph); the source pins below tie the hooks to that key.
const KEY = ["settings"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Null without deps: the module-level fixtures below must not throw in the
// no-install job, where every test that reads them skips.
const settings = (patch) => (deps ? healLoadedSettings(patch) : null);

/**
 * A client with `retry: false` whose settings read answers `reads` in order
 * (a value resolves, an Error rejects, a function is called), then rejects every
 * later read. `subscribe()` mounts an observer, making the query ACTIVE.
 */
function harness(t, reads = [settings({ theme: "light" })]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const counts = { reads: 0, rejected: 0 };
  const queryFn = () => {
    const next = reads[counts.reads++];
    const answer =
      next === undefined ? new Error("settings re-read failed") : next;
    if (typeof answer === "function") return answer();
    if (answer instanceof Error) {
      counts.rejected++;
      return Promise.reject(answer);
    }
    return Promise.resolve(answer);
  };
  const unsubs = [];
  t.after(() => {
    for (const u of unsubs) u();
    qc.clear();
  });
  const subscribe = async () => {
    const observer = new QueryObserver(qc, {
      queryKey: KEY,
      queryFn,
      staleTime: Number.POSITIVE_INFINITY,
      networkMode: "always",
    });
    unsubs.push(observer.subscribe(() => {}));
    await sleep(5);
    return observer;
  };
  return {
    qc,
    counts,
    subscribe,
    data: () => qc.getQueryData(KEY),
    status: () => qc.getQueryState(KEY)?.status,
  };
}

/** The premise every re-read case rests on: the post-save read actually ran
 *  and failed, so the cache kept only what the seed put there. */
function assertRefetchRejected(h, times = 1) {
  assert.equal(h.counts.rejected, times, "the rejecting re-read ran");
  assert.equal(h.status(), "error");
}

/** heal.ts with `replacements` applied (each needle hitting exactly once),
 *  loaded from a copy under a `/src/lib/settings/` path so the hooks treat it as
 *  src. Each copy has its own module-level counter. */
const mutantDirs = [];
after(() => {
  for (const dir of mutantDirs) rmSync(dir, { recursive: true, force: true });
});
async function mutantSeed(replacements) {
  let text = readFileSync(HEAL_SOURCE, "utf8").replace(/\r\n/g, "\n");
  for (const [needle, replacement] of replacements) {
    const count = text.split(needle).length - 1;
    assert.equal(count, 1, `expected exactly one "${needle}", found ${count}`);
    text = text.split(needle).join(replacement);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "gd-settings-seed-mutant-"));
  mutantDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  const settingsDir = path.join(dir, "src", "lib", "settings");
  mkdirSync(settingsDir, { recursive: true });
  const file = path.join(settingsDir, "heal.ts");
  writeFileSync(file, text);
  return (await import(pathToFileURL(file).href)).settingsSeedCallbacks;
}

const SEED_LINES =
  "      if (committed) client.setQueryData(key, committed);\n";
const SUPERSEDED_BRANCH =
  "        reconcileOwed = true;\n        payOwedUnlessNewer(newer);\n";
const SUPERSEDED_ARM = `      if (ctx?.seq !== started) {\n        owedGen++;\n${SUPERSEDED_BRANCH}        return;\n      }\n`;
const NO_SEED = [[SEED_LINES, ""]];
const NO_GUARD = [[SUPERSEDED_ARM, ""]];
const NO_NULL_ARM = [
  [SEED_LINES, "      client.setQueryData(key, committed);\n"],
];
// The superseded arm skips its seed but still invalidates, as the factory once did.
const UNCONDITIONAL_INVALIDATE = [
  [
    SUPERSEDED_BRANCH,
    "        reconcileOwed = newer;\n        return client.invalidateQueries({ queryKey: key });\n",
  ],
];
// A superseded success always defers, even with no newer write left to pay.
const NO_LAST_BRANCH = [[SUPERSEDED_BRANCH, "        reconcileOwed = true;\n"]];
// A paid reconcile retires its debt at the invalidate, before the read lands.
const PAY_BODY_START =
  "    const cache = client.getQueryCache();\n    const query = cache.find({ queryKey: key, exact: true });\n";
const CLEAR_BEFORE_REFETCH = [
  [PAY_BODY_START, `    reconcileOwed = false;\n${PAY_BODY_START}`],
];
// A failure never pays the reconcile a superseded success owed.
const ERROR_SETTLE = "      payOwedUnlessNewer(settleAndCheckNewer(ctx));\n";
const NO_ERROR_RECONCILE = [
  [ERROR_SETTLE, "      settleAndCheckNewer(ctx);\n"],
];
// Only the LATEST write's failure pays, the rule the A/B/C ordering breaks.
const ERROR_LATEST_ONLY = [
  [
    ERROR_SETTLE,
    "      const newer = settleAndCheckNewer(ctx);\n      if (ctx?.seq !== started) return;\n      payOwedUnlessNewer(newer);\n",
  ],
];
// A cache-identity guard, the alternative the start sequence is pinned against:
// seed only while the cache still holds the object it held when the write
// started.
const CACHE_IDENTITY_GUARD = [
  [
    "      return { seq };",
    "      return { seq, seen: client.getQueryData(key) };",
  ],
  [SUPERSEDED_ARM, ""],
  [
    SEED_LINES,
    "      if (committed && client.getQueryData(key) === ctx?.seen)\n        client.setQueryData(key, committed);\n",
  ],
];
const NO_CANCEL = [
  [
    `${SEED_LINES}      return client.invalidateQueries({ queryKey: key });`,
    `${SEED_LINES}      return client.invalidateQueries({ queryKey: key }, { cancelRefetch: false });`,
  ],
];

const PRE = settings({ theme: "light" });
const COMMITTED = settings({ theme: "dark", hideAi: true });

async function directCase(t, factory) {
  const h = harness(t);
  await h.subscribe();
  assert.deepEqual(h.data(), PRE);
  const seed = factory(h.qc, KEY);
  const ctx = seed.onMutate();
  await seed.onSuccess(COMMITTED, COMMITTED, ctx);
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), COMMITTED);
}

test("a failed post-save re-read leaves the committed snapshot cached", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await directCase(t, settingsSeedCallbacks);
});

test("the seed case fails against a factory without the seed line", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: invalidate alone keeps the pre-save snapshot once the
  // re-read fails, which is the defect the seed closes.
  const seedless = await mutantSeed(NO_SEED);
  await assert.rejects(directCase(t, seedless), assert.AssertionError);
});

test("without a subscribed observer the rejecting re-read never runs", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL for every re-read case: an inactive query isn't refetched,
  // so its premise pin fails and a seed case built this way would prove nothing.
  const h = harness(t);
  h.qc.setQueryData(KEY, PRE);
  const seed = settingsSeedCallbacks(h.qc, KEY);
  await seed.onSuccess(COMMITTED, COMMITTED, seed.onMutate());
  assert.equal(h.counts.reads, 0);
  assert.throws(() => assertRefetchRejected(h), assert.AssertionError);
});

/** The started-options snapshot rides the mutation's meta only when the
 *  mutation was built through startedMutationOptions. */
function assertStartedPremise(qc) {
  const mutation = qc.getMutationCache().getAll().at(-1);
  assert.ok(mutation, "a mutation ran");
  assert.notEqual(mutation.options.meta?.[STARTED_KEY], undefined);
}

async function endToEnd(t, wrap) {
  const h = harness(t);
  await h.subscribe();
  const fresh = [{ path: "C:/repos/a", name: "a", lastOpenedAt: "x" }];
  const next = { ...PRE, theme: "dark" };
  const committed = settings({ ...next, recentRepos: fresh });
  const observer = new MutationObserver(
    h.qc,
    wrap({
      // Mirrors saveSettingsMerged: the committed object re-pins recentRepos.
      mutationFn: async (vars) => settings({ ...vars, recentRepos: fresh }),
      networkMode: "always",
      ...settingsSeedCallbacks(h.qc, KEY),
    }),
  );
  const result = await observer.mutate(next);
  // Read at resolve time: the rejecting refetch had already settled.
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), committed);
  assert.deepEqual(result, committed);
  assertStartedPremise(h.qc);
}

test("mutateAsync resolves after the rejecting refetch, holding the committed object", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await endToEnd(t, startedMutationOptions);
});

test("the end-to-end premise pin fails when startedMutationOptions is bypassed", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: raw options carry no started snapshot.
  await assert.rejects(
    endToEnd(t, (options) => options),
    assert.AssertionError,
  );
});

// One representative optimistic patch per writer shape: useApplyTheme, the diff
// file rail, the comment composer, the repository sidebar. Each patches the cache
// and then calls mutateAsync, so its onMutate runs after the patch.
const WRITER_SHAPES = [
  ["theme", "slate"],
  ["diffFileListCollapsed", true],
  ["commentComposerCollapsed", true],
  ["sidebarCollapsed", true],
];

async function supersedeCase(t, factory, [field, value]) {
  const h = harness(t);
  await h.subscribe();
  // Two hook instances: the counter is shared by every settings mutation.
  const olderHook = factory(h.qc, KEY);
  const newerHook = factory(h.qc, KEY);
  const older = olderHook.onMutate();
  const patched = { ...h.data(), [field]: value };
  h.qc.setQueryData(KEY, patched);
  const newer = newerHook.onMutate();
  assert.ok(newer.seq > older.seq, "a later start orders after");

  const olderCommitted = settings({ ...PRE, hideAi: true });
  await olderHook.onSuccess(olderCommitted, olderCommitted, older);
  await sleep(5);
  assert.equal(
    h.counts.rejected,
    0,
    `${field}: the older success re-read nothing`,
  );
  assert.deepEqual(h.data(), patched, `${field}: the newer patch survives`);

  const newerCommitted = settings({ ...patched, hideAi: true });
  await newerHook.onSuccess(newerCommitted, patched, newer);
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), newerCommitted, `${field}: the newer write seeds`);
}

test("a newer optimistic write keeps its patch over an older write's success", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  for (const shape of WRITER_SHAPES) {
    await supersedeCase(t, settingsSeedCallbacks, shape);
  }
});

test("the supersede case fails against a factory without the start guard", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: an unguarded older success seeds over the newer patch.
  const unguarded = await mutantSeed(NO_GUARD);
  await assert.rejects(
    supersedeCase(t, unguarded, WRITER_SHAPES[0]),
    assert.AssertionError,
  );
});

/** Two plain saves, A started first; `olderSettlesLast` picks the success order.
 *  Expected either way: the newest-started write's seed wins, A's skips. */
async function overlappingSaves(t, factory, olderSettlesLast) {
  const h = harness(t);
  await h.subscribe();
  const a = factory(h.qc, KEY);
  const b = factory(h.qc, KEY);
  const committedA = settings({ theme: "dark" });
  const committedB = settings({ theme: "slate" });
  const ctxA = a.onMutate();
  const ctxB = b.onMutate();
  assert.ok(ctxB.seq > ctxA.seq);
  if (olderSettlesLast) {
    await b.onSuccess(committedB, committedB, ctxB);
    await a.onSuccess(committedA, committedA, ctxA);
    await sleep(5);
  } else {
    await a.onSuccess(committedA, committedA, ctxA);
    assert.deepEqual(h.data(), PRE, "the older success skipped its seed");
    await b.onSuccess(committedB, committedB, ctxB);
  }
  // Settling first, the older success defers to the newer write; settling
  // last, with nothing newer left, it re-reads once itself.
  assertRefetchRejected(h, olderSettlesLast ? 2 : 1);
  assert.deepEqual(h.data(), committedB);
}

/** The older write commits after the newer one settled and re-read: nothing
 *  newer is left to reconcile for it, so its own success re-reads once. */
async function olderSettlesLastCase(t, factory) {
  const diskB = settings({ theme: "slate" });
  const diskBoth = settings({ theme: "slate", hideAi: true });
  const h = harness(t, [PRE, diskB, diskBoth]);
  await h.subscribe();
  const a = factory(h.qc, KEY);
  const b = factory(h.qc, KEY);
  const ctxA = a.onMutate();
  const ctxB = b.onMutate();
  await b.onSuccess(diskB, diskB, ctxB);
  assert.equal(h.counts.reads, 2, "the newer write re-read");
  await a.onSuccess(diskBoth, diskBoth, ctxA);
  await sleep(5);
  assert.equal(h.counts.reads, 3, "the older success re-read exactly once");
  assert.deepEqual(h.data(), diskBoth);
}

test("an older write settling last with nothing newer pending re-reads once", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await olderSettlesLastCase(t, settingsSeedCallbacks);
});

test("the settles-last case fails when a superseded success always defers", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the debt is owed to no pending write, so the older
  // commit never reaches the cache.
  const deferring = await mutantSeed(NO_LAST_BRANCH);
  await assert.rejects(
    olderSettlesLastCase(t, deferring),
    assert.AssertionError,
  );
});

test("overlapping saves: the newest-started seed wins in either settle order", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await overlappingSaves(t, settingsSeedCallbacks, true);
  await overlappingSaves(t, settingsSeedCallbacks, false);
});

test("the overlapping-saves case fails against a factory without the start guard", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: unguarded, the older save settling last seeds its stale
  // commit, and settling first seeds over the pre-save snapshot.
  const unguarded = await mutantSeed(NO_GUARD);
  await assert.rejects(
    overlappingSaves(t, unguarded, true),
    assert.AssertionError,
  );
  await assert.rejects(
    overlappingSaves(t, unguarded, false),
    assert.AssertionError,
  );
});

/** The older write's re-read would ANSWER here (disk holds its commit), so an
 *  invalidate from its success would land that answer over the newer patch. */
async function supersededRereadCase(t, factory) {
  const olderDisk = settings({ ...PRE, hideAi: true });
  const h = harness(t, [PRE, olderDisk]);
  await h.subscribe();
  const olderHook = factory(h.qc, KEY);
  const newerHook = factory(h.qc, KEY);
  const older = olderHook.onMutate();
  const patched = { ...h.data(), theme: "slate" };
  h.qc.setQueryData(KEY, patched);
  newerHook.onMutate();
  await olderHook.onSuccess(olderDisk, olderDisk, older);
  await sleep(5);
  assert.equal(h.counts.reads, 1, "the older success re-read nothing");
  assert.deepEqual(h.data(), patched);
}

test("an older write's success neither seeds nor invalidates while a newer one is in flight", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await supersededRereadCase(t, settingsSeedCallbacks);
});

test("the superseded-reread case fails when the superseded arm still invalidates", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the older write's refetch lands its disk over the patch.
  const invalidating = await mutantSeed(UNCONDITIONAL_INVALIDATE);
  await assert.rejects(
    supersededRereadCase(t, invalidating),
    assert.AssertionError,
  );
});

/** The newer write fails after the older one's skipped success: its error
 *  reconciles the cache with disk. A failure with nothing owed re-reads nothing. */
async function owedReconcileCase(t, factory) {
  const olderDisk = settings({ ...PRE, hideAi: true });
  const h = harness(t, [PRE, olderDisk]);
  await h.subscribe();
  const olderHook = factory(h.qc, KEY);
  const newerHook = factory(h.qc, KEY);
  const older = olderHook.onMutate();
  h.qc.setQueryData(KEY, { ...h.data(), theme: "slate" });
  const newer = newerHook.onMutate();
  await olderHook.onSuccess(olderDisk, olderDisk, older);
  await newerHook.onError(new Error("disk full"), {}, newer);
  await sleep(5);
  assert.equal(h.counts.reads, 2, "the newer failure re-read once");
  assert.deepEqual(h.data(), olderDisk);

  const lone = factory(h.qc, KEY);
  await lone.onError(new Error("disk full"), {}, lone.onMutate());
  await sleep(5);
  assert.equal(
    h.counts.reads,
    2,
    "a failure with nothing owed re-reads nothing",
  );
}

test("the newest write's failure pays a superseded success's reconcile", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await owedReconcileCase(t, settingsSeedCallbacks);
});

test("the owed-reconcile case fails without the error arm's invalidate", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the cache keeps the failed write's state, missing the
  // older write that landed on disk.
  const silent = await mutantSeed(NO_ERROR_RECONCILE);
  await assert.rejects(owedReconcileCase(t, silent), assert.AssertionError);
});

/** The newer write's failure pays the owed re-read, but a whitespace flip cancels
 *  that read and patches before it lands, then fails: its settle pays again, so
 *  disk's value replaces the flip's rollback. */
async function cancelledPayCase(t, factory) {
  const olderDisk = settings({ ...PRE, hideAi: true });
  const gate = deferred();
  const h = harness(t, [PRE, () => gate.promise, olderDisk]);
  await h.subscribe();
  const [older, newer, flip] = [0, 1, 2].map(() => factory(h.qc, KEY));
  const ctxOlder = older.onMutate();
  h.qc.setQueryData(KEY, { ...h.data(), theme: "slate" });
  const ctxNewer = newer.onMutate();
  await older.onSuccess(olderDisk, olderDisk, ctxOlder);
  await newer.onError(new Error("disk full"), {}, ctxNewer);
  await sleep(1);
  assert.equal(h.counts.reads, 2, "the newer failure paid a re-read");
  // useSetHideWhitespace: cancel, patch, then the write starts.
  void h.qc.cancelQueries({ queryKey: KEY, exact: true });
  const stale = h.data();
  h.qc.setQueryData(KEY, { ...stale, diffHideWhitespace: true });
  const ctxFlip = flip.onMutate();
  gate.resolve(settings({ theme: "cancelled" }));
  await sleep(5);
  await flip.onError(new Error("disk full"), {}, ctxFlip);
  h.qc.setQueryData(KEY, { ...h.data(), diffHideWhitespace: false });
  await sleep(5);
  assert.equal(h.counts.reads, 3, "the flip's failure paid the re-read again");
  assert.deepEqual(h.data(), olderDisk);
}

test("a paid re-read a flip cancels stays owed, and the next settle pays it", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await cancelledPayCase(t, settingsSeedCallbacks);
});

test("the cancelled-pay case fails when a pay retires its debt before the read lands", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the cancelled read retired the debt, so the flip's failure
  // re-reads nothing and the stale snapshot stays.
  const early = await mutantSeed(CLEAR_BEFORE_REFETCH);
  await assert.rejects(cancelledPayCase(t, early), assert.AssertionError);
});

// A paid re-read retires the debt on any fetched success, generation unchecked.
const RETIRE_ON_ANY_SUCCESS = [
  [
    "        if (owedGen === paying) reconcileOwed = false;\n",
    "        reconcileOwed = false;\n",
  ],
];

/** B's failure pays A's debt with a read still in flight when C's superseded
 *  success owes a newer one; that read's success predates C's commit, so the
 *  debt stands and D's failure pays it again. */
async function midPayDebtCase(t, factory) {
  const diskA = settings({ ...PRE, hideAi: true });
  const diskAC = settings({ theme: "slate", hideAi: true });
  const gate = deferred();
  const h = harness(t, [PRE, () => gate.promise, diskAC]);
  await h.subscribe();
  const [a, b, c, d] = [0, 1, 2, 3].map(() => factory(h.qc, KEY));
  const ctxA = a.onMutate();
  const ctxB = b.onMutate();
  await a.onSuccess(diskA, diskA, ctxA);
  await b.onError(new Error("disk full"), {}, ctxB);
  await sleep(1);
  assert.equal(h.counts.reads, 2, "B's failure paid A's re-read");
  const ctxC = c.onMutate();
  const ctxD = d.onMutate();
  await c.onSuccess(diskAC, diskAC, ctxC);
  await sleep(1);
  assert.equal(h.counts.reads, 2, "C defers while D is unsettled");
  gate.resolve(diskA);
  await sleep(5);
  assert.equal(h.status(), "success", "the paid read landed");
  assert.deepEqual(h.data(), diskA);
  await d.onError(new Error("disk full"), {}, ctxD);
  await sleep(5);
  assert.equal(h.counts.reads, 3, "D's failure paid C's debt");
  assert.deepEqual(h.data(), diskAC);
}

test("a debt owed while a paid re-read is in flight survives that read's success", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await midPayDebtCase(t, settingsSeedCallbacks);
});

test("the mid-pay debt case fails when any fetched success retires the debt", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the older read retires C's debt, so D's failure re-reads
  // nothing and C's commit never reaches the cache.
  const ungenerational = await mutantSeed(RETIRE_ON_ANY_SUCCESS);
  await assert.rejects(
    midPayDebtCase(t, ungenerational),
    assert.AssertionError,
  );
});

/** Queue order differs from start order: C (newest) lands first, A succeeds
 *  while B is still unsettled, then B fails. B is not the latest write, yet with
 *  nothing newer than it unsettled its failure pays A's owed re-read. */
async function queueOrderCase(t, factory) {
  const diskC = settings({ theme: "slate" });
  const diskAC = settings({ theme: "slate", hideAi: true });
  const h = harness(t, [PRE, diskC, diskAC]);
  await h.subscribe();
  const [a, b, c] = [0, 1, 2].map(() => factory(h.qc, KEY));
  const ctxA = a.onMutate();
  const ctxB = b.onMutate();
  const ctxC = c.onMutate();
  await c.onSuccess(diskC, diskC, ctxC);
  assert.equal(h.counts.reads, 2, "the newest write re-read");
  await a.onSuccess(diskAC, diskAC, ctxA);
  await sleep(5);
  assert.equal(h.counts.reads, 2, "A defers while B is unsettled");
  await b.onError(new Error("disk full"), {}, ctxB);
  await sleep(5);
  assert.equal(h.counts.reads, 3, "B's failure paid A's re-read once");
  assert.deepEqual(h.data(), diskAC);
}

test("a non-latest failure pays an owed re-read once nothing newer is unsettled", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await queueOrderCase(t, settingsSeedCallbacks);
});

test("the queue-order case fails when only the latest write's failure pays", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: B is not the latest write, so A's commit never lands.
  const latestOnly = await mutantSeed(ERROR_LATEST_ONLY);
  await assert.rejects(queueOrderCase(t, latestOnly), assert.AssertionError);
});

const MID = settings({ theme: "light", hideAi: false, lastSeenVersion: "1" });

async function midWriteCase(t, factory) {
  const h = harness(t, [PRE, MID]);
  const observer = await h.subscribe();
  const seed = factory(h.qc, KEY);
  const ctx = seed.onMutate();
  await observer.refetch();
  assert.deepEqual(h.data(), MID, "the mid-write read replaced the cache");
  await seed.onSuccess(COMMITTED, COMMITTED, ctx);
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), COMMITTED);
}

test("a refetch landing mid-write does not block the seed", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await midWriteCase(t, settingsSeedCallbacks);
});

test("the mid-write case fails against a cache-identity guard", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: the identity guard sees the refetched object, skips this
  // legitimate seed, and the failed re-read leaves the mid-write read cached.
  const identityGuarded = await mutantSeed(CACHE_IDENTITY_GUARD);
  await assert.rejects(midWriteCase(t, identityGuarded), (err) => {
    assert.ok(err instanceof assert.AssertionError);
    assert.deepEqual(err.actual, MID);
    assert.deepEqual(err.expected, COMMITTED);
    return true;
  });
});

async function inFlightCase(t, factory) {
  const stale = settings({ theme: "light", lastSeenVersion: "stale" });
  const gate = deferred();
  const h = harness(t, [PRE, () => gate.promise]);
  const observer = await h.subscribe();
  // A read started before the write, still in flight when the write succeeds.
  void observer.refetch();
  await sleep(1);
  const seed = factory(h.qc, KEY);
  const settled = seed.onSuccess(COMMITTED, COMMITTED, seed.onMutate());
  gate.resolve(stale);
  await settled;
  await sleep(5);
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), COMMITTED);
}

test("an older read in flight at success time cannot land over the seed", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await inFlightCase(t, settingsSeedCallbacks);
});

test("the in-flight case fails when the invalidate keeps the older read", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: with cancelRefetch off the invalidate joins the older read
  // and its pre-write data lands over the seed.
  const keeping = await mutantSeed(NO_CANCEL);
  await assert.rejects(inFlightCase(t, keeping), assert.AssertionError);
});

async function nullCase(t, factory) {
  const h = harness(t);
  await h.subscribe();
  const seed = factory(h.qc, KEY);
  await seed.onSuccess(null, [], seed.onMutate());
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), PRE);
}

test("a null committed result seeds nothing but still invalidates", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await nullCase(t, settingsSeedCallbacks);
});

test("the null case fails against a factory that seeds a null result", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // NEGATIVE CONTROL: without the `committed &&` arm the cache holds null.
  const nullSeeding = await mutantSeed(NO_NULL_ARM);
  await assert.rejects(nullCase(t, nullSeeding), assert.AssertionError);
});

async function emptyCacheCase(t, factory) {
  const h = harness(t);
  assert.equal(h.data(), undefined);
  const seed = factory(h.qc, KEY);
  await seed.onSuccess(COMMITTED, COMMITTED, seed.onMutate());
  assert.deepEqual(h.data(), COMMITTED);
}

test("a first-ever write over an empty cache seeds", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await emptyCacheCase(t, settingsSeedCallbacks);
  // NEGATIVE CONTROL: the seedless factory leaves the cache empty.
  const seedless = await mutantSeed(NO_SEED);
  await assert.rejects(emptyCacheCase(t, seedless), assert.AssertionError);
});

/** What queries.ts must hold: every `useMutation(` spreads the seed factory over
 *  the settings key, and no literal settings invalidate survives outside it. */
function queriesPinFailures(src) {
  const failures = [];
  const mutations = src.split("useMutation(").length - 1;
  const seeds =
    src.split("...settingsSeedCallbacks(queryClient, settingsKeys.settings)")
      .length - 1;
  if (mutations < 7) failures.push(`only ${mutations} useMutation( sites`);
  if (src.split("settingsSeedCallbacks(").length - 1 < 7)
    failures.push("fewer than seven settingsSeedCallbacks( calls");
  if (seeds !== mutations)
    failures.push(`${seeds} seed spreads for ${mutations} mutations`);
  if (/invalidateQueries\(\s*\{\s*queryKey:\s*settingsKeys\.settings/.test(src))
    failures.push("a literal settings invalidate remains");
  return failures;
}

test("queries.ts wires all seven settings mutations through the seed", () => {
  const src = readFileSync(QUERIES_SOURCE, "utf8");
  assert.deepEqual(queriesPinFailures(src), []);
});

test("the queries.ts pin fails on a dropped spread or a literal invalidate", () => {
  const src = readFileSync(QUERIES_SOURCE, "utf8");
  const spread =
    "    ...settingsSeedCallbacks(queryClient, settingsKeys.settings),";
  assert.ok(src.includes(spread));
  // NEGATIVE CONTROLS: one hook back on the bare invalidate, and an extra
  // literal invalidate beside the spreads.
  const reverted = src.replace(
    spread,
    "    onSuccess: () =>\n      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
  );
  assert.deepEqual(queriesPinFailures(reverted), [
    "fewer than seven settingsSeedCallbacks( calls",
    "6 seed spreads for 7 mutations",
    "a literal settings invalidate remains",
  ]);
  const literal = `${src}\nqueryClient.invalidateQueries({ queryKey: settingsKeys.settings });\n`;
  assert.deepEqual(queriesPinFailures(literal), [
    "a literal settings invalidate remains",
  ]);
});
