// Pins `useRepoMutation`'s invalidation target: a mutation refreshes the repo it
// RAN on, even when its mounted observer is re-rendered for another repo before it
// settles. react-query replaces a pending mutation's whole options object on that
// re-render, so keys read from the settle-time closure land on the live repo; the
// builder captures them in `onMutate`'s context instead.
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
  };
} catch (e) {
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const { QueryClient, MutationObserver, repoMutationCallbacks } = deps ?? {};

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
  // and the context capture below is no longer what protects the target.
  assert.deepEqual(ran, ["B"]);
});

test("default arm: a retargeted success invalidates exactly the starting repo's keys", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: false,
    fail: false,
  });
  // NEGATIVE CONTROL: reading the keys from the settle-time closure instead of
  // the onMutate context turns this into repo B's keys.
  assert.deepEqual(named(invalidated), ["repo/A/status", "repo/A/history"]);
});

test("default arm: a retargeted failure still invalidates the starting repo's keys", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: false,
    fail: true,
  });
  assert.deepEqual(named(invalidated), ["repo/A/status", "repo/A/history"]);
});

test("refetchBeforeSuccess arm: a retargeted success awaits A's keys, then defers A's", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const invalidated = await retargetedRun({
    refetchBeforeSuccess: true,
    fail: false,
  });
  assert.deepEqual(named(invalidated), ["repo/A/status", "repo/A/history"]);
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
  // A mutation restored from dehydrated state skips onMutate, so its context
  // is undefined at settle.
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
