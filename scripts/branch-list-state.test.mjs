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
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { branchListState } from "../src/features/repository/branch-list-state.ts";
import { maskNonCode } from "./lib/ts-mask.mjs";

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

// An unread list resolves "Update from default" to the local default, so the
// footer row and the hotkey both hold on `branchesUnread`. Anchored in the raw
// source and read through the mask, so the name in a comment doesn't count. A
// missing anchor reports as a failure rather than passing.
const SWITCHER = readFileSync(
  new URL("../src/features/repository/BranchSwitcher.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const FOOTER_REASON = "reason={updateFromDefaultBlockedReason}";
const HOTKEY_ID = '"update-from-default",';
const HOTKEY_ENABLED = "Boolean(";

/** The slices of `raw` that must name the hold, as [label, start, end]. */
function updateGateSlices(raw) {
  const reason = raw.indexOf(FOOTER_REASON);
  const footerOpen = raw.lastIndexOf("disabled={", reason);
  const id = raw.indexOf(HOTKEY_ID);
  const enabled = raw.indexOf(HOTKEY_ENABLED, id);
  const enabledEnd = raw.indexOf("\n  );", enabled);
  return [
    ["footer row's disabled", footerOpen, reason],
    ["hotkey's enabled", enabled, enabledEnd],
  ];
}

function updateGateFailures(raw) {
  const masked = maskNonCode(raw, true);
  return updateGateSlices(raw)
    .filter(
      ([, start, end]) =>
        start < 0 ||
        end <= start ||
        !/\bbranchesUnread\b/.test(masked.slice(start, end)),
    )
    .map(([label]) => label);
}

/** `raw` with the hold's name spelled out of one gate's slice. */
function withoutHold(raw, label) {
  const [, start, end] = updateGateSlices(raw).find(([l]) => l === label);
  const gate = raw.slice(start, end);
  assert.match(gate, /\bbranchesUnread\b/);
  return (
    raw.slice(0, start) +
    gate.replace(/\bbranchesUnread\b/g, "somethingElse") +
    raw.slice(end)
  );
}

test("update from default holds on the unread list at both doors", () => {
  assert.deepEqual(updateGateFailures(SWITCHER), []);
});

test("mutation control: dropping either hold fails the pin", () => {
  for (const label of ["footer row's disabled", "hotkey's enabled"])
    assert.deepEqual(updateGateFailures(withoutHold(SWITCHER, label)), [label]);
});

test("mutation control: a missing anchor fails instead of passing", () => {
  const renamed = SWITCHER.replaceAll(FOOTER_REASON, "reason={renamed}");
  assert.ok(updateGateFailures(renamed).includes("footer row's disabled"));
});
