// Pins the staging gate for the content-writing conflict accepts (the AI accept
// and per-region accept): each stages a file only when `hasConflictMarkers` finds
// none, so a false negative lets markers ride Continue's commit and a false
// positive strands a clean file unstaged. Also pins the no-regions fallback's
// Mark resolved offer and its marker confirm, which read the same predicate.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-parse.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fallbackArm,
  hasConflictMarkers,
  MARK_RESOLVED_ARMS,
  markNeedsConfirm,
  parseConflictSegments,
} from "../src/lib/git/conflict-parse.ts";

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

// Mark resolved on the no-regions fallback: which arm a file lands on, whether
// the arm offers Mark resolved, and whether staging it must confirm first. The
// confirm rides the shared `hasConflictMarkers`, so these cases also pin that
// the view's gate and the accept gate can't disagree on what a marker is.
const sides = (working, ours, theirs, workingExists = true) => ({
  working,
  base: null,
  ours,
  theirs,
  aiIgnored: false,
  workingExists,
});
const SURVIVOR = "fn keep() {}\n";

test("Mark resolved: arm, offer, and marker confirm per fallback shape", () => {
  for (const [name, s, arm, confirm] of [
    [
      "deletion survivor with a lone theirs marker",
      sides(`${SURVIVOR}>>>>>>> feature\n`, null, SURVIVOR),
      "deletionEdited",
      true,
    ],
    [
      "deletion survivor with 8-char markers",
      sides(
        `<<<<<<<< HEAD\na\n======== \nb\n>>>>>>>> feature\n`,
        SURVIVOR,
        null,
      ),
      "deletionEdited",
      true,
    ],
    [
      "deletion survivor with an unterminated block",
      sides(`<<<<<<< HEAD\na\n=======\nb\n`, null, SURVIVOR),
      "deletionEdited",
      true,
    ],
    [
      "deletion survivor edited clean",
      sides("fn keep() { edited() }\n", SURVIVOR, null),
      "deletionEdited",
      false,
    ],
    [
      "both sides present, markers unparseable",
      sides("a\n>>>>>>> feature\n", "a\n", "b\n"),
      "unparsed",
      true,
    ],
    [
      "no index stages, real content, no markers",
      sides("content\n", null, null),
      "unparsed",
      false,
    ],
    [
      "both sides present, markers gone",
      sides("merged\n", "a\n", "b\n"),
      "externallyResolved",
      false,
    ],
    ["emptied on disk", sides("", "a\n", "b\n"), "emptiedOnDisk", false],
    ["gone from disk", sides("", "a\n", "b\n", false), "emptiedGone", false],
  ]) {
    // Every case here is one the parser refuses, which is what routes it to the
    // fallback in the first place.
    assert.equal(parseConflictSegments(s.working), null, `parses: ${name}`);
    assert.equal(fallbackArm(s), arm, `arm: ${name}`);
    assert.ok(MARK_RESOLVED_ARMS.has(arm), `offers Mark resolved: ${name}`);
    assert.equal(markNeedsConfirm(s), confirm, `confirm: ${name}`);
    assert.equal(
      markNeedsConfirm(s),
      hasConflictMarkers(s.working),
      `shared predicate: ${name}`,
    );
  }
});

test("Mark resolved is withheld where the header's accepts are the way through", () => {
  // Untouched survivor, CRLF on disk against the LF stage blob: still not edited.
  const untouched = sides(SURVIVOR.replace("\n", "\r\n"), null, SURVIVOR);
  assert.equal(fallbackArm(untouched), "deletion");
  assert.equal(MARK_RESOLVED_ARMS.has("deletion"), false);
  const both = sides("", null, null);
  assert.equal(fallbackArm(both), "bothDeleted");
  assert.equal(MARK_RESOLVED_ARMS.has("bothDeleted"), false);
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
