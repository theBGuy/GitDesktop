// Pins src/lib/started-mutation.ts: a mutation runs the mutationFn and callbacks
// of the render that STARTED it, however its mounted observer is re-rendered
// before it settles, whether it was running at the switch or parked offline.
//
// The import is DYNAMIC because the module under test and this file pull react
// and @tanstack/react-query, which the CI `guards` job (no install step) can't
// resolve: unresolved deps skip every test here, and GD_EXPECT_DEPS turns that
// skip into a failure on an installed run.
import assert from "node:assert/strict";
import { test } from "node:test";

let deps = null;
try {
  const rq = await import("@tanstack/react-query");
  deps = {
    ...(await import("../src/lib/started-mutation.ts")),
    ...(await import("../src/lib/git/queries/repo-mutation-options.ts")),
    QueryClient: rq.QueryClient,
    MutationObserver: rq.MutationObserver,
    onlineManager: rq.onlineManager,
  };
} catch (e) {
  if (process.env.GD_EXPECT_DEPS) throw e;
}
const {
  QueryClient,
  MutationObserver,
  onlineManager,
  startedMutationOptions,
  STARTED_KEY,
  repoMutationCallbacks,
} = deps ?? {};

const NEEDS_DEPS =
  "needs node_modules — an installed run with GD_EXPECT_DEPS enforces this";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Options whose mutationFn and every callback log `label`; the mutationFn waits
 *  on `gate` when one is given, and `omit` drops callbacks by name. */
function recording(label, log, { gate, omit = [] } = {}) {
  const options = {
    mutationFn: async (variables) => {
      log.push(`${label}:mutationFn`);
      if (gate) await gate.promise;
      return `${label}:${variables}`;
    },
    onMutate: () => {
      log.push(`${label}:onMutate`);
      return label;
    },
    onSuccess: () => {
      log.push(`${label}:onSuccess`);
    },
    onError: () => {
      log.push(`${label}:onError`);
    },
    onSettled: () => {
      log.push(`${label}:onSettled`);
    },
  };
  for (const key of omit) delete options[key];
  return options;
}

/** Never parks, for the tests that switch a RUNNING write. */
const always = (options) => ({ ...options, networkMode: "always" });

/** Runs `body` with the network reported offline and a mounted client, which
 *  resumes paused mutations on reconnect the way the app's client does. */
async function offline(body) {
  const qc = new QueryClient();
  qc.mount();
  onlineManager.setOnline(false);
  try {
    await body(qc);
  } finally {
    onlineManager.setOnline(true);
    qc.unmount();
  }
}

// The timeout makes a react-query that stops resuming paused mutations fail here
// instead of stalling the run.
test("premise: raw options retarget a parked write, and one context reaches every callback", {
  timeout: 10_000,
}, async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await offline(async (qc) => {
    const log = [];
    const contexts = [];
    const raw = (label) => ({
      meta: { label },
      mutationFn: async (_variables, context) => {
        log.push(`${label}:mutationFn`);
        contexts.push(context);
        return "ok";
      },
      onSettled: (_data, _error, _variables, _result, context) => {
        log.push(`${label}:onSettled`);
        contexts.push(context);
      },
    });
    const observer = new MutationObserver(qc, raw("A"));
    const settled = observer.mutate(undefined);
    await sleep(0);
    observer.setOptions(raw("B"));
    onlineManager.setOnline(true);
    await settled;
    // If this ever reads A's, react-query stopped retargeting pending mutations
    // and the snapshot no longer has anything to protect against.
    assert.deepEqual(log, ["B:mutationFn", "B:onSettled"]);
    // What the snapshot rides on: ONE context per execution, built from the
    // starting options and handed unchanged to the mutationFn and the settle
    // callbacks across setOptions. An upgrade that rebuilds it per call fails
    // here. (A `continue()` with no retryer, i.e. a mutation restored by
    // hydration, re-runs `execute` with a fresh context from its own options,
    // which hydration builds from mutation defaults rather than any render, so
    // persisted mutations would bypass the snapshot; none exist.)
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0], contexts[1]);
    assert.equal(contexts[0].meta.label, "A");
  });
});

for (const fail of [false, true]) {
  test(`a running write settles through its starting options (${fail ? "error" : "success"})`, async (t) => {
    if (!deps) return t.skip(NEEDS_DEPS);
    const qc = new QueryClient();
    const log = [];
    const gate = deferred();
    const observer = new MutationObserver(
      qc,
      startedMutationOptions(always(recording("A", log, { gate }))),
    );
    const settled = observer.mutate(1).catch(() => {});
    await sleep(0); // A's mutationFn is waiting on the gate
    observer.setOptions(
      startedMutationOptions(always(recording("B", log, { gate }))),
    );
    if (fail) gate.reject(new Error("push failed"));
    else gate.resolve();
    await settled;
    assert.deepEqual(log, [
      "A:onMutate",
      "A:mutationFn",
      fail ? "A:onError" : "A:onSuccess",
      "A:onSettled",
    ]);
  });
}

test("a write parked offline runs its starting mutationFn on reconnect", {
  timeout: 10_000,
}, async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await offline(async (qc) => {
    const log = [];
    const observer = new MutationObserver(
      qc,
      startedMutationOptions(recording("A", log)),
    );
    const settled = observer.mutate(1);
    await sleep(0);
    assert.equal(observer.getCurrentResult().isPaused, true);
    assert.deepEqual(log, ["A:onMutate"]);
    observer.setOptions(startedMutationOptions(recording("B", log)));
    onlineManager.setOnline(true);
    assert.equal(await settled, "A:1");
    assert.deepEqual(log, [
      "A:onMutate",
      "A:mutationFn",
      "A:onSuccess",
      "A:onSettled",
    ]);
  });
});

test("a parked write survives a second switch while it runs", {
  timeout: 10_000,
}, async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  await offline(async (qc) => {
    const log = [];
    const gate = deferred();
    const options = (label) =>
      startedMutationOptions(recording(label, log, { gate }));
    const observer = new MutationObserver(qc, options("A"));
    const settled = observer.mutate(1);
    await sleep(0);
    observer.setOptions(options("B"));
    onlineManager.setOnline(true);
    await sleep(0); // resumed: the mutationFn is waiting on the gate
    assert.deepEqual(log, ["A:onMutate", "A:mutationFn"]);
    observer.setOptions(options("C"));
    gate.resolve();
    await settled;
    assert.deepEqual(log, [
      "A:onMutate",
      "A:mutationFn",
      "A:onSuccess",
      "A:onSettled",
    ]);
  });
});

test("a switch leaves the observer attached; a changed mutation key still detaches it", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const log = [];
  const gate = deferred();
  // A regression pin of unchanged react-query behavior: it passes with or without
  // the helper, and fails if wrapping the options ever changed the hold.
  const observer = new MutationObserver(
    qc,
    startedMutationOptions(always(recording("A", log, { gate }))),
  );
  const settled = observer.mutate(1);
  await sleep(0);
  assert.equal(observer.getCurrentResult().isPending, true);
  observer.setOptions(
    startedMutationOptions(always(recording("B", log, { gate }))),
  );
  assert.equal(observer.getCurrentResult().isPending, true);
  gate.resolve();
  await settled;
  assert.equal(observer.getCurrentResult().isPending, false);
  assert.equal(observer.getCurrentResult().data, "A:1");

  // An identity pin keeps its detach: the observer goes idle at the switch while
  // the mutation itself still settles through its starting options.
  const pinnedLog = [];
  const pinnedGate = deferred();
  const pinned = (label) =>
    startedMutationOptions({
      ...always(recording(label, pinnedLog, { gate: pinnedGate })),
      mutationKey: ["op", label],
    });
  const keyed = new MutationObserver(qc, pinned("A"));
  const keyedSettled = keyed.mutate(1);
  await sleep(0);
  assert.equal(keyed.getCurrentResult().isPending, true);
  keyed.setOptions(pinned("B"));
  assert.equal(keyed.getCurrentResult().isPending, false);
  pinnedGate.resolve();
  assert.equal(await keyedSettled, "A:1");
  assert.deepEqual(pinnedLog, [
    "A:onMutate",
    "A:mutationFn",
    "A:onSuccess",
    "A:onSettled",
  ]);
});

test("a later render cannot drop or add a callback on an in-flight mutation", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const log = [];
  const gate = deferred();
  const observer = new MutationObserver(
    qc,
    startedMutationOptions(
      always(recording("A", log, { gate, omit: ["onSuccess"] })),
    ),
  );
  const settled = observer.mutate(1);
  await sleep(0);
  // B drops onSettled and adds onSuccess: neither may reach A's mutation.
  observer.setOptions(
    startedMutationOptions(
      always(recording("B", log, { gate, omit: ["onSettled"] })),
    ),
  );
  gate.resolve();
  await settled;
  assert.deepEqual(log, ["A:onMutate", "A:mutationFn", "A:onSettled"]);
});

test("onMutate's result is the context, and an onSuccess promise holds the settle", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const seen = [];
  const observer = new MutationObserver(
    qc,
    startedMutationOptions({
      networkMode: "always",
      mutationFn: async (n) => {
        if (n < 0) throw new Error("negative");
        return n * 2;
      },
      onMutate: (n) => ({ token: n }),
      onSuccess: async (data, _variables, context) => {
        seen.push(["onSuccess", data, context]);
        await sleep(5);
        seen.push(["onSuccess done"]);
      },
      onError: (error, _variables, context) => {
        seen.push(["onError", error.message, context]);
      },
      onSettled: (data, error, _variables, context) => {
        seen.push(["onSettled", data, error?.message ?? null, context]);
      },
    }),
  );
  seen.push(["resolved", await observer.mutate(21)]);
  assert.deepEqual(seen, [
    ["onSuccess", 42, { token: 21 }],
    ["onSuccess done"],
    ["onSettled", 42, null, { token: 21 }],
    ["resolved", 42],
  ]);
  assert.deepEqual(observer.getCurrentResult().context, { token: 21 });

  seen.length = 0;
  await observer.mutate(-1).catch((e) => seen.push(["rejected", e.message]));
  assert.deepEqual(seen, [
    ["onError", "negative", { token: -1 }],
    ["onSettled", undefined, "negative", { token: -1 }],
    ["rejected", "negative"],
  ]);
});

test("options with no mutationFn reject as react-query does, and meta keeps the caller's entries", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const observer = new MutationObserver(
    qc,
    startedMutationOptions({ networkMode: "always" }),
  );
  await assert.rejects(observer.mutate(1), { message: "No mutationFn found" });

  const raw = { meta: { source: "caller" } };
  const started = startedMutationOptions(raw);
  assert.equal(started.meta.source, "caller");
  assert.equal(started.meta[STARTED_KEY], raw);
  assert.equal(raw.meta[STARTED_KEY], undefined);
});

test("a trampoline whose snapshot is missing names the cause", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  // Called directly: through a mutation, the callbacks' own throws would surface
  // as react-query's deliberately unhandled rejections.
  const qc = new QueryClient();
  const started = startedMutationOptions({ mutationFn: async () => "ok" });
  const context = { client: qc, meta: {} };
  const cause = /build mutations only through @\/lib\/started-mutation/;
  await assert.rejects(async () => started.mutationFn(1, context), cause);
  assert.throws(() => started.onMutate(1, context), cause);
  assert.throws(
    () => started.onSettled("ok", null, 1, undefined, context),
    cause,
  );
});

test("wrapping wrapped options returns them unchanged and runs the mutationFn once", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const log = [];
  const once = startedMutationOptions(always(recording("A", log)));
  const twice = startedMutationOptions(once);
  assert.equal(twice, once);
  await new MutationObserver(qc, twice).mutate(1);
  assert.deepEqual(log, [
    "A:onMutate",
    "A:mutationFn",
    "A:onSuccess",
    "A:onSettled",
  ]);
});

const RESERVED = /is reserved for @\/lib\/started-mutation/;

test("wrapping a copy of wrapped options throws", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const wrapped = startedMutationOptions(always(recording("A", [])));
  assert.throws(
    () => startedMutationOptions({ ...wrapped, onSuccess: () => {} }),
    RESERVED,
  );
});

test("a caller meta carrying the reserved key throws", (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  assert.throws(
    () =>
      startedMutationOptions({
        mutationFn: async () => "ok",
        meta: { [STARTED_KEY]: {} },
      }),
    RESERVED,
  );
});

/** A client whose `invalidateQueries` records each key instead of refetching. */
function spyClient() {
  const qc = new QueryClient();
  const invalidated = [];
  qc.invalidateQueries = (filters) => {
    invalidated.push(filters.queryKey.join("/"));
    return Promise.resolve();
  };
  return { qc, invalidated };
}

const keysFor = (repo) => ({
  invalidate: [["repo", repo, "status"]],
  invalidateAfter: [["repo", repo, "history"]],
});

test("useRepoMutation's callbacks refresh only the starting repo after a switch", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  for (const refetchBeforeSuccess of [false, true]) {
    const { qc, invalidated } = spyClient();
    const gate = deferred();
    const optionsFor = (repo) =>
      startedMutationOptions({
        mutationFn: () => gate.promise,
        networkMode: "always",
        ...repoMutationCallbacks(
          qc,
          keysFor(repo),
          refetchBeforeSuccess,
          () => {},
        ),
      });
    const observer = new MutationObserver(qc, optionsFor("A"));
    const settled = observer.mutate(undefined);
    await sleep(0);
    observer.setOptions(optionsFor("B"));
    gate.resolve("ok");
    await settled;
    // Read with no further tick: both arms START their invalidations inside the
    // settle callbacks, before the mutation's promise resolves.
    assert.deepEqual(
      invalidated,
      ["repo/A/status", "repo/A/history"],
      `refetchBeforeSuccess=${refetchBeforeSuccess}`,
    );
  }
});

// A regression pin of unchanged react-query behavior: it passes with or without
// the helper, and fails if wrapping the options ever changed per-call callbacks.
test("a per-call onSuccess still fires once", async (t) => {
  if (!deps) return t.skip(NEEDS_DEPS);
  const qc = new QueryClient();
  const log = [];
  const observer = new MutationObserver(
    qc,
    startedMutationOptions(always(recording("A", log))),
  );
  // Per-call callbacks fire only while the observer has listeners.
  const unsubscribe = observer.subscribe(() => {});
  try {
    let calls = 0;
    await observer.mutate(1, {
      onSuccess: () => {
        calls += 1;
      },
    });
    await sleep(0);
    assert.equal(calls, 1);
    assert.deepEqual(log, [
      "A:onMutate",
      "A:mutationFn",
      "A:onSuccess",
      "A:onSettled",
    ]);
  } finally {
    unsubscribe();
  }
});
