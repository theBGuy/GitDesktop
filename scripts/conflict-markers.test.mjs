// Pins the staging gate for the content-writing conflict accepts (the AI accept
// and per-region accept): each stages a file only when `hasConflictMarkers` finds
// none, so a false negative lets markers ride Continue's commit and a false
// positive strands a clean file unstaged.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-parse.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasConflictMarkers } from "../src/lib/git/conflict-parse.ts";

test("angle and pipe markers are detected with a space, tab, or EOL tail", () => {
  for (const marker of ["<<<<<<<", ">>>>>>>", "|||||||"]) {
    assert.ok(hasConflictMarkers(`a\n${marker} label\nb`), `${marker} + space`);
    assert.ok(hasConflictMarkers(`a\n${marker}\tlabel\nb`), `${marker} + tab`);
    assert.ok(hasConflictMarkers(`a\n${marker}\nb`), `${marker} + EOL`);
    assert.ok(hasConflictMarkers(`a\n${marker}`), `${marker} at EOF`);
  }
});

test("6-char runs are not markers", () => {
  for (const char of ["<", ">", "|"]) {
    assert.ok(!hasConflictMarkers(`a\n${char.repeat(6)} x\nb`), `${char}x6`);
  }
});

// A `conflict-marker-size` attribute lengthens git's markers; staging must
// still refuse them even though the parser only reads 7-char runs.
test("longer runs are markers", () => {
  for (const char of ["<", ">", "|"]) {
    assert.ok(hasConflictMarkers(`a\n${char.repeat(8)} x\nb`), `${char}x8`);
    assert.ok(hasConflictMarkers(`a\n${char.repeat(12)}\nb`), `${char}x12`);
  }
});

// A bare separator can be a setext heading underline, so it never blocks staging;
// the parser's own marker set includes it for a different job (ambiguity).
test("a bare ======= line is deliberately not a marker", () => {
  assert.ok(!hasConflictMarkers("Title\n=======\nbody\n"));
});

test("a marker mid-line is not a marker", () => {
  assert.ok(!hasConflictMarkers("text <<<<<<< HEAD\nmore >>>>>>> theirs\n"));
});

test("CRLF input is handled", () => {
  assert.ok(hasConflictMarkers("a\r\n<<<<<<<\r\nb\r\n"));
  assert.ok(hasConflictMarkers("a\r\n>>>>>>> theirs\r\n"));
  assert.ok(!hasConflictMarkers("Title\r\n=======\r\nbody\r\n"));
  assert.ok(hasConflictMarkers("a\r\n<<<<<<<<\r\n"));
  assert.ok(!hasConflictMarkers("a\r\n<<<<<<\r\n"));
});

// The two AI-proposal shapes the accept gate branches on.
test("a proposal left with only a bare separator stages; one with a trailing theirs marker does not", () => {
  assert.equal(
    hasConflictMarkers("fn a() {}\n=======\nfn b() {}\n"),
    false,
    "bare ======= only → clean, stages",
  );
  assert.equal(
    hasConflictMarkers("fn a() {}\nfn b() {}\n>>>>>>> theirs\n"),
    true,
    "trailing >>>>>>> theirs → not staged",
  );
});
