// Pins the Changes pane's no-selection message (src/features/diff/
// diff-resting-message.ts), which DiffViewer and its eager Suspense fallback
// both render: the full truth table and every string verbatim. A failed FIRST
// status read (the sticky gate) reads as the shared failed-read reason, never
// as a clean tree; a failed refetch keeps its data and its healthy message.
//
// The imports reach straight into `src/` under Node's type stripping, so both
// modules must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restingDiffMessage } from "../src/features/diff/diff-resting-message.ts";
import { STATUS_READ_FAILED_REASON } from "../src/features/repository/sync-controls-state.ts";

const SELECT = "Select a file to see its changes";
const CLEAN = "No changes to review";

test("a pending status read asks for a selection, whatever the count", () => {
  assert.equal(restingDiffMessage(true, 0, false), SELECT);
  assert.equal(restingDiffMessage(true, 3, false), SELECT);
});

test("a settled read with entries asks for a selection", () => {
  assert.equal(restingDiffMessage(false, 1, false), SELECT);
  assert.equal(restingDiffMessage(false, 42, false), SELECT);
});

test("a settled read with no entries reads clean", () => {
  assert.equal(restingDiffMessage(false, 0, false), CLEAN);
});

test("a failed first read names the failure, never a clean tree", () => {
  assert.equal(restingDiffMessage(false, 0, true), STATUS_READ_FAILED_REASON);
  assert.notEqual(restingDiffMessage(false, 0, true), CLEAN);
});

test("a poll of a failed first read holds the reason while pending", () => {
  assert.equal(restingDiffMessage(true, 0, true), STATUS_READ_FAILED_REASON);
});

test("the reason is the Changes tab's shared constant, verbatim", () => {
  assert.equal(
    STATUS_READ_FAILED_REASON,
    "Couldn't read the repository status",
  );
});
