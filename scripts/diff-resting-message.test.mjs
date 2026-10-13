// Pins the Changes pane's no-selection message (src/features/diff/
// diff-resting-message.ts), which DiffViewer and its eager Suspense fallback
// both render: the full truth table and both strings verbatim. A failed FIRST
// status read is not pending and has no entries, so it reads "No changes to
// review" (a failed refetch keeps its data).
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restingDiffMessage } from "../src/features/diff/diff-resting-message.ts";

const SELECT = "Select a file to see its changes";
const CLEAN = "No changes to review";

test("a pending status read asks for a selection, whatever the count", () => {
  assert.equal(restingDiffMessage(true, 0), SELECT);
  assert.equal(restingDiffMessage(true, 3), SELECT);
});

test("a settled read with entries asks for a selection", () => {
  assert.equal(restingDiffMessage(false, 1), SELECT);
  assert.equal(restingDiffMessage(false, 42), SELECT);
});

test("a settled read with no entries (or a failed first read) reads clean", () => {
  assert.equal(restingDiffMessage(false, 0), CLEAN);
});
