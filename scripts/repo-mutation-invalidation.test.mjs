// Pins `useRepoMutation`'s invalidation target: whatever a mutation invalidates,
// it invalidates for the repo it started on, plus the current repo when that
// differs, even when its mounted observer is re-rendered for another repo before
// it settles. react-query replaces a pending mutation's whole options object on
// that re-render, so keys read from the settle-time closure alone land on the
// live repo; the builder captures them in `onMutate`'s context and settles the
// union. The current repo is in the union because a write that parked offline
// runs the RETARGETED mutationFn on reconnect.
//
// The builder lives in an import-free module so Node's type stripping can load it
// directly. The import is DYNAMIC because this file also pulls
// @tanstack/react-query, which the CI `guards` job (no install step) can't
// resolve: unresolved deps skip every test here, and GD_EXPECT_DEPS turns that
// skip into a failure on an installed run.
import assert from "node:assert/strict";
import { test } from "node:test";

let deps = null;
try {
  const rq = await import("@tanstack/react-query");
  deps = {
    ...(await import("../src/lib/git/queries/repo-mutation-options.ts")),
    QueryClient: rq.QueryClient,
    MutationObserver: rq.MutationObserver,
    onlineManager: rq.onlineManager,
  };
} catch (e) {
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const { QueryClient, MutationObserver, onlineManager, repoMutationCallbacks } =
  deps ?? {};

const NEEDS_DEPS =
  "needs node_modules — an installed run with GD_EXPECT_DEPS enforces this";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Distinct awaited and deferred lists per repo, so a stray key names its source. */
const keysFor = (repo) => ({
  invalidate: [["repo", repo, "status"]],
  invalidateAfter: [["repo", repo, "history"]],
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client whose `invalidateQueries` records each key instead of refetching. */
function spyClient() {
  const qc = new QueryClient();
  const invalidated = [];
  qc.invalidateQueries = (filters) => {
    invalidated.push(filters.queryKey);
    return Promise.resolve();
  };
  return { qc, invalidated };
}

const optionsFor = (qc, repo, mutationFn, refetchBeforeSuccess) => ({
  mutationFn,
  networkMode: "always",
  ...repoMutationCallbacks(qc, keysFor(repo), refetchBeforeSuccess, () => {}),
});

/** Starts a mutation for repo A, retargets its observer to repo B while the
 *  mutationFn is pending, then settles it; returns every invalidated key. */
async function retargetedRun({ refetchBeforeSuccess, fail }) {
  const { qc, invalidated } = spyClient();
  const gate = deferred();
  const mutationFn = () => gate.promise;
  const observer = new MutationObserver(
    qc,
    optionsFor(qc, "A", mutationFn, refetchBeforeSuccess),
  );
  const settled = observer.mutate(undefined).catch(() => {});
  await sleep(0); // onMutate has run; the mutationFn is parked on the gate
  observer.setOptions(optionsFor(qc, "B", mutationFn, refetchBeforeSuccess));
  if (fail) gate.reject(new Error("push failed"));
  else gate.resolve("ok");
  await settled;
  await sleep(0);
  return invalidated;
}

const named = (keys) => keys.map((k) => k.join("/"));

test("premise: a retargeted observer runs the NEW options' callbacks", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const gate = deferred();
  const ran = [];
  const options = (label) => ({
    mutationFn: () => gate.promise,
    networkMode: "always",
    onSettled: () => ran.push(label),
  });
  const observer = new MutationObserver(qc, options("A"));
  const settled = observer.mutate(undefined);
  await sleep(0);
  observer.setOptions(options("B"));
  gate.resolve("ok");
  await settled;
  // If this ever reads ["A"], react-query stopped retargeting pending mutations
  // and the union below is no longer needed to protect the target.
  assert.deepEqual(ran, ["B"]);
});

/** The starting repo's keys, then the current repo's, each list in turn. */
const BOTH = [
  "repo/A/status",
  "repo/B/status",
  "repo/A/history",
  "repo/B/history",
];

test("default arm: a retargeted success invalidates the starting repo's keys and the current ones", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: false,
    fail: false,
  });
  // NEGATIVE CONTROL: reading the keys from the settle-time closure alone, instead
  // of the union with the onMutate context, drops repo A's keys.
  assert.deepEqual(named(invalidated), BOTH);
});

test("default arm: a retargeted failure invalidates both repos' keys too", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: false,
    fail: true,
  });
  assert.deepEqual(named(invalidated), BOTH);
});

test("refetchBeforeSuccess arm: a retargeted success awaits both repos' keys, then defers both", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: true,
    fail: false,
  });
  assert.deepEqual(named(invalidated), BOTH);
});

// The timeout makes a react-query that stops resuming paused mutations fail
// here instead of stalling the run.
test("a write parked offline runs the retargeted mutationFn and refreshes both repos once each", {
  timeout: 10_000,
}, async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const { qc, invalidated } = spyClient();
  // Mounted, so a reconnect resumes paused mutations the way the app's client does.
  qc.mount();
  const ran = [];
  // The default "online" networkMode: the write parks while offline.
  const optionsOn = (repo) => ({
    mutationFn: async () => {
      ran.push(repo);
      return "ok";
    },
    ...repoMutationCallbacks(qc, keysFor(repo), false, () => {}),
  });
  onlineManager.setOnline(false);
  try {
    const observer = new MutationObserver(qc, optionsOn("A"));
    const settled = observer.mutate(undefined);
    await sleep(0);
    assert.equal(observer.getCurrentResult().isPaused, true);
    const [mutation] = qc.getMutationCache().getAll();
    // onMutate ran before the write parked: the context holds A's keys.
    assert.deepEqual(mutation.state.context, keysFor("A"));
    observer.setOptions(optionsOn("B"));
    onlineManager.setOnline(true);
    await settled;
    await sleep(0);
    // Pre-existing react-query behavior, pinned as a named fact: the retargeted
    // mutationFn is the one that runs on reconnect.
    assert.deepEqual(ran, ["B"]);
    assert.deepEqual(named(invalidated), BOTH);
  } finally {
    onlineManager.setOnline(true);
    qc.unmount();
  }
});

test("refetchBeforeSuccess arm: a failure invalidates nothing, in either repo", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: true,
    fail: true,
  });
  assert.deepEqual(invalidated, []);
});

test("a settle with no captured context falls back to the current keys", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // Called with an undefined context, as for a mutation that settles without
  // an `onMutate` context.
  const { qc, invalidated } = spyClient();
  const settle = repoMutationCallbacks(qc, keysFor("C"), false, () => {});
  settle.onSettled("ok", null, undefined, undefined);
  await sleep(0);
  assert.deepEqual(named(invalidated), ["repo/C/status", "repo/C/history"]);

  const awaited = spyClient();
  const success = repoMutationCallbacks(
    awaited.qc,
    keysFor("C"),
    true,
    () => {},
  );
  await success.onSuccess("ok", undefined, undefined);
  await sleep(0);
  assert.deepEqual(named(awaited.invalidated), [
    "repo/C/status",
    "repo/C/history",
  ]);
});

test("notifySuccess runs with the data and variables before any invalidation", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  for (const refetchBeforeSuccess of [false, true]) {
    const { qc, invalidated } = spyClient();
    const seen = [];
    const observer = new MutationObserver(qc, {
      mutationFn: async (n) => n * 2,
      networkMode: "always",
      ...repoMutationCallbacks(
        qc,
        keysFor("A"),
        refetchBeforeSuccess,
        (data, variables) => seen.push([data, variables, invalidated.length]),
      ),
    });
    await observer.mutate(21);
    await sleep(0);
    assert.deepEqual(
      seen,
      [[42, 21, 0]],
      `refetchBeforeSuccess=${refetchBeforeSuccess}`,
    );
    assert.deepEqual(named(invalidated), ["repo/A/status", "repo/A/history"]);
  }
});
