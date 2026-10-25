// Pins `createRunReads`, the per-run memo a review run shares its identical forge
// reads through: one fetch per key however many harvests ask, a rejection never
// served twice (and a LATE one never evicting a newer entry), prefix eviction, and
// no unhandled rejection from a read nobody awaited. A memo that silently
// re-fetched would still pass every caller's tests, so the single-flight arms also
// run against a pass-through `share` that must FAIL them.
//
// The import below reaches straight into `src/` under Node's type stripping, which
// resolves no bundler aliases: `run-reads.ts` must stay import-free at runtime.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRunReads } from "../src/lib/automations/run-reads.ts";

/** A fetcher that counts its calls and settles when told to. */
function deferredFetcher() {
  const calls = [];
  const fetch = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, fetch };
}

/** The memo with sharing removed: every call fetches. The negative control. */
const passThrough = () => ({
  share: (_key, fetch) => fetch(),
  evict: () => {},
});

/** Collects unhandled rejections raised while `body` runs plus a few turns. */
async function unhandledDuring(body) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    for (let i = 0; i < 3; i++)
      await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

// Arm (a): concurrent shares of one key make one fetch and share its result.
async function armSingleFlight(create) {
  const reads = create();
  const { calls, fetch } = deferredFetcher();
  const first = reads.share("k", fetch);
  const second = reads.share("k", fetch);
  assert.equal(calls.length, 1, "one underlying fetch");
  const value = { items: [] };
  calls[0].resolve(value);
  assert.equal(await first, value);
  assert.equal(await second, value);
  // Resolved entries keep serving.
  assert.equal(await reads.share("k", fetch), value);
  assert.equal(calls.length, 1);
}

// Arm (d): the harvest shape, three consumers of one key.
async function armThreeConsumers(create) {
  const reads = create();
  let fetches = 0;
  const thunk = () =>
    reads.share("extrev:/repo:7", async () => {
      fetches++;
      return { items: [], itemsTruncated: false };
    });
  const [a, b, c] = await Promise.all([thunk(), thunk(), thunk()]);
  assert.equal(fetches, 1, "three consumers, one fetch");
  assert.equal(a, b);
  assert.equal(b, c);
}

test("(a) same key, concurrent calls: one fetch, one result", async () => {
  await armSingleFlight(createRunReads);
});

test("(b) distinct keys fetch separately", async () => {
  const reads = createRunReads();
  let fetches = 0;
  const fetch = async () => ++fetches;
  assert.equal(await reads.share("diff", fetch), 1);
  assert.equal(await reads.share("extrev:/repo:7", fetch), 2);
  assert.equal(fetches, 2);
});

test("(c) a rejection is evicted, so the next share re-fetches", async () => {
  const reads = createRunReads();
  let fetches = 0;
  const fetch = async () => {
    fetches++;
    if (fetches === 1) throw new Error("transient");
    return "ok";
  };
  await assert.rejects(reads.share("diff", fetch), /transient/);
  assert.equal(await reads.share("diff", fetch), "ok");
  assert.equal(fetches, 2);
});

test("(c) a late rejection does not evict a newer entry", async () => {
  const reads = createRunReads();
  const { calls, fetch } = deferredFetcher();
  const stale = reads.share("extrev:/repo:7", fetch);
  reads.evict("extrev:");
  const fresh = reads.share("extrev:/repo:7", fetch);
  assert.equal(calls.length, 2);
  calls[1].resolve("fresh");
  assert.equal(await fresh, "fresh");
  calls[0].reject(new Error("late"));
  await assert.rejects(stale, /late/);
  // The newer entry is still the one served, with no third fetch (checked before
  // awaiting: a third fetch would never settle).
  const again = reads.share("extrev:/repo:7", fetch);
  assert.equal(calls.length, 2);
  assert.equal(await again, "fresh");
});

test("(d) three consumers of one key make one fetch", async () => {
  await armThreeConsumers(createRunReads);
});

test("(e) evict drops entries under the prefix only", async () => {
  const reads = createRunReads();
  let fetches = 0;
  const fetch = async () => ++fetches;
  await reads.share("diff", fetch);
  await reads.share("extrev:/a:1", fetch);
  await reads.share("extrev:/b:2", fetch);
  assert.equal(fetches, 3);
  reads.evict("extrev:");
  assert.equal(await reads.share("diff", fetch), 1, "diff survives");
  assert.equal(await reads.share("extrev:/a:1", fetch), 4, "re-fetched");
  assert.equal(await reads.share("extrev:/b:2", fetch), 5, "re-fetched");
});

test("(f) a synchronously throwing fetcher rejects, is not kept, and raises no unhandled rejection", async () => {
  const reads = createRunReads();
  let fetches = 0;
  const seen = await unhandledDuring(async () => {
    const thrown = reads.share("diff", () => {
      fetches++;
      throw new Error("sync");
    });
    assert.ok(thrown instanceof Promise);
    // Left unconsumed on purpose: the memo's own observer must cover it.
    const next = reads.share("diff", async () => {
      fetches++;
      return "ok";
    });
    assert.equal(await next, "ok");
    // Consumed only after a macrotask, past Node's unhandled-rejection check.
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(thrown, /sync/);
  });
  assert.equal(fetches, 2);
  assert.deepEqual(seen, []);
});

test("an unconsumed shared rejection raises no unhandled rejection", async () => {
  const reads = createRunReads();
  const seen = await unhandledDuring(async () => {
    reads.share("extrev:/repo:7", () => Promise.reject(new Error("nobody")));
  });
  assert.deepEqual(seen, []);
});

test("(g) negative control: a pass-through share fails the single-flight arms", async () => {
  await assert.rejects(armSingleFlight(passThrough), assert.AssertionError);
  await assert.rejects(armThreeConsumers(passThrough), assert.AssertionError);
});
