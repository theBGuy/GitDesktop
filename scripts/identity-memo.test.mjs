// Pins the memo behind the repo-identity resolver — the layer that decides which
// repository every per-repo store writes under. Each guard here answers a failure
// that leaves nothing on screen: an immortal entry mis-keys a checkout path that
// changed hands, an out-of-order settle restores the value a re-issue just
// corrected, and an over-eager evict turns one failed probe into a resolve storm.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES types
// rather than compiling them and resolves no bundler aliases, so
// `identity-memo.ts` must stay import-free. A runtime import added there fails
// this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ttlMemo } from "../src/lib/git/identity-memo.ts";

const TTL = 300_000;

/** A memo over a scripted resolver, with the clock under the test's control. */
function harness() {
  let clock = 1_000_000;
  const calls = [];
  let behavior = (key) => Promise.resolve(`${key}/.git`);
  const memo = ttlMemo({
    resolve: (key) => {
      calls.push(key);
      return behavior(key);
    },
    ttlMs: TTL,
    now: () => clock,
  });
  return {
    memo,
    calls,
    advance: (ms) => {
      clock += ms;
    },
    setBehavior: (fn) => {
      behavior = fn;
    },
  };
}

const rejects = async (promise) => {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
};

test("a hit inside the TTL issues no second resolve", async () => {
  const h = harness();
  const burst = await Promise.all([
    h.memo.get("/repo"),
    h.memo.get("/repo"),
    h.memo.get("/repo"),
  ]);
  h.advance(TTL - 1);
  const late = await h.memo.get("/repo");

  assert.deepEqual(burst, ["/repo/.git", "/repo/.git", "/repo/.git"]);
  assert.equal(late, "/repo/.git");
  assert.deepEqual(h.calls, ["/repo"], "four calls, one resolve");
});

test("past the TTL the next call re-resolves and serves the new answer", async () => {
  const h = harness();
  assert.equal(await h.memo.get("/repo"), "/repo/.git");
  // The reused-path case: same checkout path, different repository.
  h.setBehavior(() => Promise.resolve("/elsewhere/.git"));
  h.advance(TTL);
  assert.equal(await h.memo.get("/repo"), "/elsewhere/.git");
  assert.equal(h.calls.length, 2);
  assert.equal(h.memo.peek("/repo"), "/elsewhere/.git", "peek follows");
});

test("a slow OLDER resolve settling last does not overwrite the newer answer", async () => {
  const h = harness();
  let releaseSlow;
  h.setBehavior(() => new Promise((res) => (releaseSlow = res)));
  const slow = h.memo.get("/repo"); // issued, hangs

  h.advance(TTL); // the window rolls while it is still out
  h.setBehavior(() => Promise.resolve("/corrected/.git"));
  const reissued = await h.memo.get("/repo");

  releaseSlow("/stale/.git"); // the older resolve settles LAST
  assert.equal(
    await slow,
    "/stale/.git",
    "its own caller still gets its answer",
  );
  assert.equal(reissued, "/corrected/.git");
  assert.equal(h.memo.peek("/repo"), "/corrected/.git", "newest ANSWER wins");
});

test("a rejection after a success leaves peek serving the last id", async () => {
  const h = harness();
  assert.equal(await h.memo.get("/repo"), "/repo/.git");
  h.setBehavior(() => Promise.reject(new Error("git unavailable")));
  h.advance(TTL);

  assert.ok(
    await rejects(h.memo.get("/repo")),
    "the resolve itself still rejects",
  );
  assert.equal(
    h.memo.peek("/repo"),
    "/repo/.git",
    "unaged: the last answer stands",
  );
  // The aged reader disagrees on purpose — that split is the whole point of having
  // both. Within its own window the remembered answer is still good.
  assert.equal(h.memo.within("/repo", TTL * 2), "/repo/.git");
  h.advance(TTL * 2);
  assert.equal(h.memo.within("/repo", TTL * 2), undefined, "aged out");
  assert.equal(h.memo.peek("/repo"), "/repo/.git", "peek never ages out");
});

test("a never-resolved key rejects and evicts, so the next call retries", async () => {
  const h = harness();
  h.setBehavior(() => Promise.reject(new Error("git unavailable")));

  assert.ok(await rejects(h.memo.get("/cold")));
  assert.ok(await rejects(h.memo.get("/cold")), "no cached failure to serve");
  assert.equal(
    h.calls.length,
    2,
    "the failed entry was evicted, so each call asks",
  );
  assert.equal(h.memo.peek("/cold"), undefined, "nothing settled to peek");
});

test("a failure does not evict the re-issue that already replaced it", async () => {
  const h = harness();
  let failSlow;
  h.setBehavior(() => new Promise((_res, rej) => (failSlow = rej)));
  const slow = h.memo.get("/repo"); // issued, hangs

  h.advance(TTL); // the window rolls; a re-issue replaces the entry
  h.setBehavior(() => Promise.resolve("/repo/.git"));
  assert.equal(await h.memo.get("/repo"), "/repo/.git");

  failSlow(new Error("git unavailable")); // the ORIGINAL attempt now fails
  assert.ok(await rejects(slow));

  const callsBefore = h.calls.length;
  assert.equal(await h.memo.get("/repo"), "/repo/.git");
  assert.equal(
    h.calls.length,
    callsBefore,
    "the live entry survived the older attempt's failure",
  );
});
