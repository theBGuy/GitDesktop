// Pins src/lib/settings/heal.ts `settingsSeedCallbacks` against a REAL
// react-query cache: after a settings write succeeds the cache holds that write's
// committed snapshot even when the follow-up re-read fails, unless a newer
// settings write started after it, whose optimistic patch or own seed wins; the
// invalidate always runs, cancels an older in-flight read, and `mutateAsync`
// resolves only once its refetch settled. Also pins that every settings mutation
// hook in queries.ts spreads the factory.
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

const settings = (patch) => healLoadedSettings(patch);

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
  "      if (committed && ctx?.seq === started)\n        client.setQueryData(key, committed);\n";
const NO_SEED = [[SEED_LINES, ""]];
const NO_GUARD = [["if (committed && ctx?.seq === started)", "if (committed)"]];
const NO_NULL_ARM = [
  ["if (committed && ctx?.seq === started)", "if (ctx?.seq === started)"],
];
// The reference-equality guard the start sequence replaced: seed only while the
// cache still holds the object it held when the write started.
const CACHE_IDENTITY_GUARD = [
  [
    "onMutate: (): SettingsSeedContext => ({ seq: ++started }),",
    "onMutate: () => ({ seq: ++started, seen: client.getQueryData(key) }),",
  ],
  [
    "if (committed && ctx?.seq === started)",
    "if (committed && client.getQueryData(key) === ctx?.seen)",
  ],
];
const NO_CANCEL = [
  [
    "return client.invalidateQueries({ queryKey: key });",
    "return client.invalidateQueries({ queryKey: key }, { cancelRefetch: false });",
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
  assertRefetchRejected(h);
  assert.deepEqual(h.data(), patched, `${field}: the newer patch survives`);

  const newerCommitted = settings({ ...patched, hideAi: true });
  await newerHook.onSuccess(newerCommitted, patched, newer);
  assertRefetchRejected(h, 2);
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
  } else {
    await a.onSuccess(committedA, committedA, ctxA);
    assert.deepEqual(h.data(), PRE, "the older success skipped its seed");
    await b.onSuccess(committedB, committedB, ctxB);
  }
  assertRefetchRejected(h, 2);
  assert.deepEqual(h.data(), committedB);
}

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
  if (mutations < 6) failures.push(`only ${mutations} useMutation( sites`);
  if (src.split("settingsSeedCallbacks(").length - 1 < 6)
    failures.push("fewer than six settingsSeedCallbacks( calls");
  if (seeds !== mutations)
    failures.push(`${seeds} seed spreads for ${mutations} mutations`);
  if (/invalidateQueries\(\s*\{\s*queryKey:\s*settingsKeys\.settings/.test(src))
    failures.push("a literal settings invalidate remains");
  return failures;
}

test("queries.ts wires all six settings mutations through the seed", () => {
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
    "fewer than six settingsSeedCallbacks( calls",
    "5 seed spreads for 6 mutations",
    "a literal settings invalidate remains",
  ]);
  const literal = `${src}\nqueryClient.invalidateQueries({ queryKey: settingsKeys.settings });\n`;
  assert.deepEqual(queriesPinFailures(literal), [
    "a literal settings invalidate remains",
  ]);
});
