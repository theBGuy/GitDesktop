// Pins the hunk-match guard (src/features/diff/hunk-match.ts): a forge's diff
// text gets content mode only when it is exactly the change between the two
// whole files read for it, gaps between hunks included. The import reaches
// straight into src/ under Node's type stripping, so the module stays free of
// runtime imports; this suite needs no install.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hunksMatchContent } from "../src/features/diff/hunk-match.ts";

const lines = (from, to, tag = "") =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}${tag}\n`).join("");

/** A 20-line file and an edit of its line 5. */
const OLD = lines(1, 20);
const NEW = OLD.replace("line 5\n", "line five\n");
const EDIT =
  "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n" +
  "--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -2,7 +2,7 @@ heading\n line 2\n line 3\n line 4\n-line 5\n+line five\n" +
  " line 6\n line 7\n line 8\n";

/** Two hunks with a gap of lines 9..14 between them. */
const NEW2 = NEW.replace("line 16\n", "line sixteen\n");
const TWO =
  "@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+line five\n line 6\n line 7\n line 8\n" +
  "@@ -15,3 +15,3 @@\n line 15\n-line 16\n+line sixteen\n line 17\n";

test("true for the shapes a forge sends", () => {
  const cases = [
    ["a plain edit", EDIT, OLD, NEW],
    ["two hunks over equal gaps", TWO, OLD, NEW2],
    [
      "an added file (old empty)",
      "--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+a\n+b\n",
      "",
      "a\nb\n",
    ],
    [
      "a deleted file (new empty)",
      "--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
      "a\nb\n",
      "",
    ],
    [
      "a file without a trailing newline",
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
      "a\nb",
      "a\nc",
    ],
    [
      "one side without a trailing newline",
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
      "a\nb",
      "a\nb\n",
    ],
    [
      "CRLF lines on both sides",
      "@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n",
      "a\r\nb\r\n",
      "a\r\nc\r\n",
    ],
    [
      "an omitted count reads as 1",
      "@@ -2 +2 @@\n-b\n+c\n",
      "a\nb\nd\n",
      "a\nc\nd\n",
    ],
  ];
  for (const [name, diff, oldText, newText] of cases)
    assert.equal(hunksMatchContent(diff, oldText, newText), true, name);
});

test("false for every mismatch, and never a throw", () => {
  const cases = [
    [
      "a changed context line",
      EDIT,
      OLD.replace("line 3\n", "LINE 3\n"),
      NEW.replace("line 3\n", "LINE 3\n"),
    ],
    ["a changed - line", EDIT, OLD.replace("line 5\n", "line 5!\n"), NEW],
    ["a changed + line", EDIT, OLD, NEW.replace("line five\n", "line 5ive\n")],
    ["a hunk offset off by one", EDIT.replace("@@ -2,7 +2,7 @@", "@@ -3,7 +3,7 @@"), OLD, NEW],
    [
      "a difference between the sides outside every hunk",
      EDIT,
      OLD,
      NEW.replace("line 12\n", "line twelve\n"),
    ],
    [
      "a difference between the sides before the first hunk",
      EDIT,
      OLD,
      NEW.replace("line 1\n", "line one\n"),
    ],
    [
      "a difference inside the gap between two hunks",
      TWO,
      OLD,
      NEW2.replace("line 10\n", "line ten\n"),
    ],
    ["an old file shorter than a hunk reaches", EDIT, lines(1, 6), NEW],
    [
      "a last hunk past the old file's end",
      "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n",
      "a\nb\n",
      "a\nc\nd\n",
    ],
    ["a side that read absent while the diff has lines for it", EDIT, "", NEW],
    ["a text with no hunks", "diff --git a/f b/f\nindex 1..2 100644\n", OLD, NEW],
    ["an empty text", "", OLD, NEW],
    ["a header it cannot parse", "@@ -x,1 +1 @@\n-a\n+b\n", "a\n", "b\n"],
    ["a hunk cut short", "@@ -1,3 +1,3 @@\n a\n-b\n+c\n", "a\nb\nd\n", "a\nc\nd\n"],
    [
      "a second file's section after the hunks",
      `${EDIT}diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n`,
      OLD,
      NEW,
    ],
    ["a line of no kind inside a hunk", "@@ -1,2 +1,2 @@\n a\n?b\n+c\n", "a\nb\n", "a\nc\n"],
    [
      "hunks out of order",
      `@@ -15${TWO.split("@@ -15")[1]}${TWO.split("@@ -15")[0]}`,
      OLD,
      NEW2,
    ],
  ];
  for (const [name, diff, oldText, newText] of cases)
    assert.equal(hunksMatchContent(diff, oldText, newText), false, name);
  for (const bad of [undefined, null, 7, {}])
    assert.equal(hunksMatchContent(bad, OLD, NEW), false, String(bad));
  assert.equal(hunksMatchContent(EDIT, null, NEW), false);
});

test("the EOL rule: a file line drops one trailing CR, so CRLF on one side only still matches", () => {
  const diff = "@@ -1 +1 @@\n-a\n+b\n";
  // A hunk line: one side's file line ends in CRLF, the diff's in LF.
  assert.equal(hunksMatchContent(diff, "a\r\n", "b\n"), true);
  assert.equal(hunksMatchContent(diff, "a\n", "b\r\n"), true);
  // One CR only: a second is part of the line.
  assert.equal(hunksMatchContent(diff, "a\r\r\n", "b\n"), false);
  // A line before the first hunk, which the two files answer for each other:
  // the same line, CRLF in one file only, still matches.
  const late = "@@ -2 +2 @@\n-a\n+b\n";
  assert.equal(hunksMatchContent(late, "x\r\na\n", "x\nb\n"), true);
  assert.equal(hunksMatchContent(late, "x\na\n", "x\r\nb\n"), true);
  assert.equal(hunksMatchContent(late, "x\r\r\na\n", "x\nb\n"), false);
});

test("the gap check bites: the same hunks over a differing gap are refused", () => {
  // Every hunk matches both files; only the unchanged middle differs.
  const oldText = "a\nb\nc\nd\ne\n";
  const newText = "A\nb\nX\nd\nE\n";
  const diff = "@@ -1 +1 @@\n-a\n+A\n@@ -5 +5 @@\n-e\n+E\n";
  assert.equal(hunksMatchContent(diff, oldText, newText), false);
  assert.equal(hunksMatchContent(diff, oldText, newText.replace("X", "c")), true);
});
