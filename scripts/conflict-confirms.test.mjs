// Pins the stage-over-markers prompt that Mark resolved and every generic stage
// route share: one file reads as Mark resolved always has, a bulk action never
// titles itself after one file, and a file whose markers couldn't be read is
// hedged ("possible", "any") rather than asserted.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-confirms.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { markerStagePrompt } from "../src/features/repository/conflict-confirms.ts";

const marked = (name) => ({ name, unchecked: false });
const unchecked = (name) => ({ name, unchecked: true });

test("one marked file reads exactly as Mark resolved's prompt", () => {
  assert.deepEqual(markerStagePrompt([marked("a.ts")], false), {
    title: "Stage a.ts with conflict markers?",
    body: "a.ts still has conflict markers. Staging it marks the conflict resolved with the markers in the file, and they'll be committed unless you remove them first.",
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive",
  });
});

test("a bulk action with one flagged file keeps the generic title", () => {
  const prompt = markerStagePrompt([marked("a.ts")], true);
  assert.equal(prompt.title, "Stage files with conflict markers?");
  assert.equal(
    prompt.body,
    "a.ts still has conflict markers. Staging it marks the conflict resolved with the markers in the file, and they'll be committed unless you remove them first.",
  );
});

test("an unreadable file is hedged, never asserted to hold markers", () => {
  assert.deepEqual(markerStagePrompt([unchecked("big.lock")], false), {
    title: "Stage big.lock with possible conflict markers?",
    body: "big.lock couldn't be checked for conflict markers. Staging it marks the conflict resolved with any markers in the file, and they'll be committed unless you remove them first.",
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive",
  });
});

test("a mixed set names both groups and pluralizes the consequence", () => {
  const prompt = markerStagePrompt(
    [marked("a.ts"), unchecked("img.png"), marked("b.ts")],
    true,
  );
  assert.equal(prompt.title, "Stage files with possible conflict markers?");
  assert.equal(
    prompt.body,
    "a.ts, b.ts still have conflict markers. img.png couldn't be checked for conflict markers. Staging them marks those conflicts resolved with any markers in the files, and they'll be committed unless you remove them first.",
  );
});

test("more than three flagged files collapse to a count", () => {
  const prompt = markerStagePrompt(
    ["a", "b", "c", "d"].map((n) => marked(`${n}.ts`)),
    true,
  );
  assert.equal(prompt.title, "Stage files with conflict markers?");
  assert.ok(
    prompt.body.startsWith("4 files still have conflict markers. Staging them"),
    prompt.body,
  );
});

test("three flagged files are still named", () => {
  const prompt = markerStagePrompt(
    ["a", "b", "c"].map((n) => marked(`${n}.ts`)),
    true,
  );
  assert.ok(
    prompt.body.startsWith("a.ts, b.ts, c.ts still have conflict markers."),
    prompt.body,
  );
});
