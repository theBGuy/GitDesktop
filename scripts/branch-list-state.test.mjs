// Pins how the branch menu classifies its local branches read: rows once data
// has landed, a sticky failure while a never-loaded read keeps failing (each
// retry flips `isPending` back on, so the classifier takes no fetch status), and
// pending otherwise. The arm order mirrors BranchSwitcher's `unread` helper, so
// the list and the menu's disabled reasons never disagree about the same read.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so `branch-list-state.ts`
// must stay import-free. Node's stdlib test runner only, no dev dependency: the CI
// `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import { branchListState } from "../src/features/repository/branch-list-state.ts";

/** The sticky case: a first read failed and a retry is now in flight, which the
 *  query reports as pending with no data and a nonzero error count. */
const FAILED_RETRYING = { errorUpdateCount: 1, hasData: false };

test("data renders the rows, even over a failed refresh", () => {
  assert.deepEqual(branchListState({ errorUpdateCount: 0, hasData: true }), {
    mode: "ready",
    remoteGroupMayRender: true,
  });
  assert.deepEqual(branchListState({ errorUpdateCount: 3, hasData: true }), {
    mode: "ready",
    remoteGroupMayRender: true,
  });
});

test("no data and no errors is pending", () => {
  assert.deepEqual(branchListState({ errorUpdateCount: 0, hasData: false }), {
    mode: "pending",
    remoteGroupMayRender: false,
  });
});

test("a failed first read stays failed through its retries", () => {
  assert.deepEqual(branchListState(FAILED_RETRYING), {
    mode: "failed",
    remoteGroupMayRender: false,
  });
  assert.equal(
    branchListState({ errorUpdateCount: 4, hasData: false }).mode,
    "failed",
  );
});

test("the Remote group renders only in ready mode", () => {
  for (const errorUpdateCount of [0, 1, 2]) {
    for (const hasData of [false, true]) {
      const state = branchListState({ errorUpdateCount, hasData });
      assert.equal(state.remoteGroupMayRender, state.mode === "ready");
    }
  }
});

test("negative control: an absence-first classifier fails the sticky case", () => {
  // Treats missing data as pending before consulting the error count, the arm
  // order the real classifier must never take. The sticky assertion above has to
  // reject it, or that assertion proves nothing.
  const naive = (q) => {
    if (!q.hasData) return "pending";
    if (q.errorUpdateCount > 0) return "failed";
    return "ready";
  };
  assert.throws(() => assert.equal(naive(FAILED_RETRYING), "failed"));
  assert.equal(branchListState(FAILED_RETRYING).mode, "failed");
});
