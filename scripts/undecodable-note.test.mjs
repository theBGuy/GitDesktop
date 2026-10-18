// Pins the working-tree diff's non-UTF-8 gate (src/features/diff/
// undecodable-note.ts), which both the parsed memo (the structural gate) and
// the fire-time refusals read: hunk/line writes run only over a loaded diff
// that isn't flagged. An absent field is the hand-built PR-literal shape.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hunkWritesAllowed } from "../src/features/diff/undecodable-note.ts";

test("no diff loaded refuses hunk writes", () => {
  assert.equal(hunkWritesAllowed(undefined), false);
});

test("a flagged diff refuses hunk writes", () => {
  assert.equal(hunkWritesAllowed({ undecodable: true }), false);
});

test("a clean or unflagged diff allows hunk writes", () => {
  assert.equal(hunkWritesAllowed({ undecodable: false }), true);
  assert.equal(hunkWritesAllowed({}), true);
});
