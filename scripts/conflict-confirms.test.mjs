// Pins the stage-over-markers prompt that Mark resolved and every generic stage
// route share: one file reads as Mark resolved always has, a bulk action never
// titles itself after one file, and a file whose markers couldn't be read is
// hedged ("possible", "any") rather than asserted, naming its refusal (binary,
// too large) when the caller knows it, and a set of binary files alone asks
// about the files as they are on disk, with no claim about markers.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-confirms.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { markerStagePrompt } from "../src/features/repository/conflict-confirms.ts";

const marked = (name) => ({ name, unchecked: false });
const unchecked = (name) => ({ name, unchecked: true });
const binary = (name) => ({ name, unchecked: true, cause: "binary" });
const tooLarge = (name) => ({ name, unchecked: true, cause: "tooLarge" });

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

test("a binary file alone asks about the file, never about markers", () => {
  assert.deepEqual(markerStagePrompt([binary("logo.png")], false), {
    title: "Stage logo.png as it is on disk?",
    body: "logo.png looks like a binary file, so GitDesktop can't merge it or check what it holds. Staging it marks the conflict resolved with the file exactly as it is on disk now.",
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive",
  });
});

test("a bulk action with one binary file keeps a singular generic title", () => {
  const prompt = markerStagePrompt([binary("logo.png")], true);
  assert.equal(prompt.title, "Stage a binary file as it is on disk?");
  assert.equal(
    prompt.body,
    "logo.png looks like a binary file, so GitDesktop can't merge it or check what it holds. Staging it marks the conflict resolved with the file exactly as it is on disk now.",
  );
});

test("several binary files read as one group", () => {
  assert.deepEqual(
    markerStagePrompt([binary("a.png"), binary("b.png")], false),
    {
      title: "Stage binary files as they are on disk?",
      body: "a.png, b.png look like binary files, so GitDesktop can't merge them or check what they hold. Staging them marks those conflicts resolved with the files exactly as they are on disk now.",
      confirmLabel: "Stage anyway",
      confirmVariant: "destructive",
    },
  );
});

test("a binary file beside a marked one keeps the marker prompt", () => {
  const prompt = markerStagePrompt([binary("logo.png"), marked("a.ts")], true);
  assert.equal(prompt.title, "Stage files with possible conflict markers?");
  assert.equal(
    prompt.body,
    "a.ts still has conflict markers. logo.png looks like a binary file, so it wasn't checked for conflict markers. Staging them marks those conflicts resolved with any markers in the files, and they'll be committed unless you remove them first.",
  );
});

test("a too-large file says why it wasn't checked", () => {
  assert.deepEqual(markerStagePrompt([tooLarge("big.lock")], false), {
    title: "Stage big.lock with possible conflict markers?",
    body: "big.lock is too large to read here, so it wasn't checked for conflict markers. Staging it marks the conflict resolved with any markers in the file, and they'll be committed unless you remove them first.",
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive",
  });
});

test("a mixed set orders marked, binary, too large, then uncaused", () => {
  const prompt = markerStagePrompt(
    [
      unchecked("odd.txt"),
      tooLarge("big.lock"),
      binary("a.png"),
      marked("a.ts"),
      tooLarge("huge.json"),
      binary("b.png"),
    ],
    true,
  );
  assert.equal(prompt.title, "Stage files with possible conflict markers?");
  assert.equal(
    prompt.body,
    "a.ts still has conflict markers. a.png, b.png look like binary files, so they weren't checked for conflict markers. big.lock, huge.json are too large to read here, so they weren't checked for conflict markers. odd.txt couldn't be checked for conflict markers. Staging them marks those conflicts resolved with any markers in the files, and they'll be committed unless you remove them first.",
  );
});

test("an uncaused unreadable file keeps the generic sentence word for word", () => {
  const prompt = markerStagePrompt(
    [unchecked("x.bin"), unchecked("y.bin")],
    true,
  );
  assert.equal(
    prompt.body,
    "x.bin, y.bin couldn't be checked for conflict markers. Staging them marks those conflicts resolved with any markers in the files, and they'll be committed unless you remove them first.",
  );
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
