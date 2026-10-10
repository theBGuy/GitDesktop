// Pins the budget race a repo open waits on before it switches: the open holds
// for the new repo's cold shell reads, but never past the budget, and a read that
// fails must neither fail the open nor hold it. Ordering is asserted against
// generous outer timers rather than tight wall-clock windows, so a slow CI
// machine can only make these slower, never red.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so `repo-shell-budget.ts`
// must stay import-free. Node's stdlib test runner only, no dev dependency: the CI
// `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPO_SHELL_BUDGET_MS,
  settleWithin,
} from "../src/features/repository/repo-shell-budget.ts";

const LONG = 10_000;

/** Resolves "settled" if `promise` resolves within `ms`, "timeout" otherwise,
 *  clearing its own timer so nothing holds the process open. */
function raceAgainst(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise.then(() => "settled"), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

test("the budget is 250 ms", () => {
  assert.equal(REPO_SHELL_BUDGET_MS, 250);
});

test("resolves as soon as every member settles, well inside the budget", async () => {
  let release;
  const member = new Promise((resolve) => {
    release = resolve;
  });
  let done = false;
  const settled = settleWithin([member], LONG).then(() => {
    done = true;
  });
  await nextTask();
  assert.equal(done, false, "resolved before its member settled");
  release();
  assert.equal(await raceAgainst(settled, 1_000), "settled");
});

test("resolves at the budget when a member never settles", async () => {
  const never = new Promise(() => {});
  const started = Date.now();
  let done = false;
  const settled = settleWithin([never, Promise.resolve()], 30).then(() => {
    done = true;
  });
  await nextTask();
  assert.equal(done, false, "resolved before the budget passed");
  assert.equal(await raceAgainst(settled, 5_000), "settled");
  assert.ok(Date.now() - started >= 20, "resolved well before the budget");
});

test("never rejects when a member rejects", async () => {
  const failing = Promise.reject(new Error("read failed"));
  const settled = settleWithin([failing, Promise.resolve("ok")], LONG);
  assert.equal(await raceAgainst(settled, 1_000), "settled");
  await assert.doesNotReject(settled);
});

test("an empty set resolves at once, before any timer turn", async () => {
  let done = false;
  const settled = settleWithin([], LONG).then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  await settled;
});
