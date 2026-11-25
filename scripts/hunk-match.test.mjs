// Pins the hunk-match guard (src/features/diff/hunk-match.ts): a forge's diff
// text gets content mode only when it is exactly the change between the two
// whole files read for it, gaps between hunks included. The import reaches
// straight into src/ under Node's type stripping, so the module's runtime
// imports stay relative .ts ones; this suite needs no install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  hunksMatchContent,
  stripGitWhitespace,
} from "../src/features/diff/hunk-match.ts";

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

test("the final-newline rule: each side's marker, or its absence, must hold in its file", () => {
  const NO_EOL = "\\ No newline at end of file";
  // `a` without a final newline becomes `a` with one.
  const gains = `@@ -1 +1 @@\n-a\n${NO_EOL}\n+a\n`;
  assert.equal(hunksMatchContent(gains, "a", "a\n"), true);
  assert.equal(hunksMatchContent(gains, "a\n", "a\n"), false);
  assert.equal(hunksMatchContent(gains, "a", "a"), false);
  // ... and loses it.
  const loses = `@@ -1 +1 @@\n-a\n+a\n${NO_EOL}\n`;
  assert.equal(hunksMatchContent(loses, "a\n", "a"), true);
  assert.equal(hunksMatchContent(loses, "a\n", "a\n"), false);
  assert.equal(hunksMatchContent(loses, "a", "a"), false);
  // A marked context line holds on both sides.
  const context = `@@ -1,2 +1,2 @@\n-x\n+y\n z\n${NO_EOL}\n`;
  assert.equal(hunksMatchContent(context, "x\nz", "y\nz"), true);
  assert.equal(hunksMatchContent(context, "x\nz\n", "y\nz"), false);
  assert.equal(hunksMatchContent(context, "x\nz", "y\nz\n"), false);
  // An unmarked last line has a final newline.
  const plain = "@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(hunksMatchContent(plain, "a", "b\n"), false);
  assert.equal(hunksMatchContent(plain, "a\n", "b"), false);
  // Only a file's last line carries the marker.
  const early = `@@ -1,2 +1,2 @@\n-a\n${NO_EOL}\n+b\n c\n`;
  assert.equal(hunksMatchContent(early, "a\nc\n", "b\nc\n"), false);
  // Last lines no hunk shows are one line, so their final newlines agree.
  assert.equal(hunksMatchContent(plain, "a\nz\n", "b\nz"), false);
  assert.equal(hunksMatchContent(plain, "a\nz", "b\nz"), true);
  // One side's last line in a hunk, the other's outside every hunk: the
  // outside line keeps its terminator, which a later line on the other side
  // proves is a newline.
  const append = "@@ -1,0 +2 @@\n+b\n";
  assert.equal(hunksMatchContent(append, "a", "a\nb\n"), false);
  assert.equal(hunksMatchContent(append, "a\n", "a\nb\n"), true);
  const drop = "@@ -2 +1,0 @@\n-b\n";
  assert.equal(hunksMatchContent(drop, "a\nb\n", "a"), false);
  assert.equal(hunksMatchContent(drop, "a\nb\n", "a\n"), true);
});

test("the BOM rule: a byte-order mark on line 1 reads as absent, on either input", () => {
  const BOM = String.fromCharCode(0xfeff);
  const first = `@@ -1,2 +1,2 @@\n-${BOM}a\n+${BOM}A\n b\n`;
  // The decoder strips the mark from the files; the patch keeps it.
  assert.equal(hunksMatchContent(first, "a\nb\n", "A\nb\n"), true);
  assert.equal(hunksMatchContent(first, `${BOM}a\nb\n`, `${BOM}A\nb\n`), true);
  // Context on line 1, and a mark only line 1 may carry.
  const ctx = `@@ -1,2 +1,2 @@\n ${BOM}a\n-b\n+c\n`;
  assert.equal(hunksMatchContent(ctx, "a\nb\n", "a\nc\n"), true);
  const second = `@@ -1,2 +1,2 @@\n a\n-${BOM}b\n+c\n`;
  assert.equal(hunksMatchContent(second, "a\nb\n", "a\nc\n"), false);
  // keepBom: the texts hold the mark as their bytes do, so line 1 compares as
  // written, in a hunk and in a gap.
  const KEEP = { keepBom: true };
  assert.equal(hunksMatchContent(first, "a\nb\n", "A\nb\n", KEEP), false);
  assert.equal(hunksMatchContent(first, `${BOM}a\nb\n`, `${BOM}A\nb\n`, KEEP), true);
  assert.equal(hunksMatchContent(ctx, "a\nb\n", "a\nc\n", KEEP), false);
  const late = "@@ -2 +2 @@\n-b\n+c\n";
  assert.equal(hunksMatchContent(late, `${BOM}a\nb\n`, "a\nc\n"), true);
  assert.equal(hunksMatchContent(late, `${BOM}a\nb\n`, "a\nc\n", KEEP), false);
  assert.equal(hunksMatchContent(late, `${BOM}a\nb\n`, `${BOM}a\nc\n`, KEEP), true);
});

test("the EOF rule: a hunk starting past either file's end is refused, one starting at it is not", () => {
  const T = "a\nb\nc\n";
  // A zero-count hunk names the line before it, so `-3,0` starts at the end.
  assert.equal(hunksMatchContent("@@ -3,0 +3,0 @@\n", T, T), true);
  assert.equal(hunksMatchContent("@@ -3,0 +4 @@\n+d\n", T, `${T}d\n`), true);
  assert.equal(hunksMatchContent("@@ -4,0 +4,0 @@\n", T, T), false);
  assert.equal(hunksMatchContent("@@ -3,0 +4,0 @@\n", T, T), false);
  assert.equal(hunksMatchContent("@@ -4,0 +3,0 @@\n", T, T), false);
  const started = Date.now();
  assert.equal(hunksMatchContent("@@ -20000000,0 +20000000,0 @@\n", T, T), false);
  // A start too large for a finite number reads as Infinity.
  const huge = "9".repeat(400);
  assert.equal(hunksMatchContent(`@@ -${huge},0 +${huge},0 @@\n`, T, T), false);
  assert.ok(Date.now() - started < 1000, "refused without walking to the start");
});

// --- ignoreWhitespace: the guard over a `git diff -w` text -----------------
//
// Every positive fixture below is real output of
//   git diff --no-ext-diff --no-index --no-color -w -- old new
// (git 2.51.1, no global or system config; diff.suppressBlankEmpty only where
// the case says), from its first "@@" line on. D24's final-newline probe, same
// run, as JSON strings:
//   "x\n" vs "x"          -> nothing printed, exit 0
//   "x \n" vs "x"         -> nothing printed, exit 0
//   "a\nb\nc\n" vs "A\nb\nc" -> "@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n\\ No newline at end of file\n"
//   "a\nb\nc" vs "A\nb\nc\n" -> "@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n"
//   "a\nb" vs "a\nB\n"     -> "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n"
// So a final newline is whitespace to -w: a context line's marker speaks for
// the new side only, and last lines outside every hunk may differ in it; a "-"
// or "+" line's marker still speaks for its own side.
const WS = { ignoreWhitespace: true };
const CAPTURED = {
  reindentEdit: [
    "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n",
    "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n",
    "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n",
  ],
  crlfVsLf: [
    "@@ -1,7 +1,7 @@\n a\r\n b\r\n c\r\n-d\n+D\r\n e\r\n f\r\n g\r\n",
    "a\nb\nc\nd\ne\nf\ng\nh\n",
    "a\r\nb\r\nc\r\nD\r\ne\r\nf\r\ng\r\nh\r\n",
  ],
  wsInGap: [
    "@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+line three\n line 4\n line 5\n line 6\n@@ -24,7 +24,7 @@ line 23\n line 24\n line 25\n line 26\n-line 27\n+line twenty-seven\n line 28\n line 29\n line 30\n",
    "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\nline 16\nline 17\nline 18\nline 19\nline 20\nline 21\nline 22\nline 23\nline 24\nline 25\nline 26\nline 27\nline 28\nline 29\nline 30\n",
    "line 1\nline 2\nline three\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\n   line 15\nline 16\nline 17\nline 18\nline 19\nline 20\nline 21\nline 22\nline 23\nline 24\nline 25\nline 26\nline twenty-seven\nline 28\nline 29\nline 30\n",
  ],
  // diff.suppressBlankEmpty = true: blank context lines lose their space.
  blankContext: [
    "@@ -1,6 +1,6 @@\n a\n\n-b\n+B\n c\n\n d\n",
    "a\n\nb\nc\n\nd\n",
    "a\n\nB\nc\n\nd\n",
  ],
  eofNewline: [
    "@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n\\ No newline at end of file\n",
    "a\nb\nc\n",
    "A\nb\nc",
  ],
  eofSpaceNewline: [
    "@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n\\ No newline at end of file\n",
    "a\nb\nc \n",
    "A\nb\nc",
  ],
  eofNewlineOutside: [
    "@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n",
    "a\nb\nc\nd\ne\nf\ng\nh\n",
    "A\nb\nc\nd\ne\nf\ng\nh",
  ],
  eofOldNoNewline: [
    "@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n",
    "a\nb\nc",
    "A\nb\nc\n",
  ],
  minusMarker: [
    "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n",
    "a\nb",
    "a\nB\n",
  ],
  // A block duplicated above itself and re-indented: the -w hunk draws
  // new-side lines no plain hunk holds.
  duplicateReindent: [
    "@@ -1,6 +1,8 @@\n start\n+if (z) {\n   if (a) {\n     b();\n     c();\n   }\n+}\n end\n",
    "start\nif (a) {\n  b();\n  c();\n}\nend\n",
    "start\nif (z) {\n  if (a) {\n    b();\n    c();\n  }\n}\nend\n",
  ],
};

test("ignoreWhitespace: true for real -w texts, which exact mode refuses where -w did anything", () => {
  for (const [name, [diff, oldText, newText]] of Object.entries(CAPTURED))
    assert.equal(hunksMatchContent(diff, oldText, newText, WS), true, name);
  for (const name of [
    "reindentEdit",
    "eofNewline",
    "eofSpaceNewline",
    "eofNewlineOutside",
    "eofOldNoNewline",
    "duplicateReindent",
  ]) {
    const [diff, oldText, newText] = CAPTURED[name];
    assert.equal(
      hunksMatchContent(diff, oldText, newText),
      false,
      "exact: " + name,
    );
  }
});

test("ignoreWhitespace: false for every non-whitespace mismatch", () => {
  const [gapDiff, gapOld, gapNew] = CAPTURED.wsInGap;
  const [riDiff, riOld, riNew] = CAPTURED.reindentEdit;
  const [eofDiff, eofOld] = CAPTURED.eofNewline;
  const cases = [
    [
      "a non-whitespace difference in a gap",
      gapDiff,
      gapOld,
      gapNew.replace("   line 15\n", "line fifteen\n"),
    ],
    [
      "a context line differing in a letter, old side",
      riDiff,
      riOld.replace("  line 9\n", "  line 9x\n"),
      riNew,
    ],
    [
      "a context line differing in a letter, new side",
      riDiff,
      riOld,
      riNew.replace("  line 9\n", "  line 9x\n"),
    ],
    [
      "a hunk offset off by one",
      riDiff.replace("@@ -11,7 +11,7 @@", "@@ -12,7 +12,7 @@"),
      riOld,
      riNew,
    ],
    [
      "unequal line counts outside the hunks",
      gapDiff,
      gapOld,
      gapNew + "line 31\n",
    ],
    [
      "a hunk starting past the file's end",
      "@@ -40,1 +40,1 @@\n-x\n+y\n",
      "x\n",
      "y\n",
    ],
    ["a text with no hunk", "", "x\n", "x"],
    [
      "a - marker the old file contradicts",
      CAPTURED.minusMarker[0],
      "a\nb\n",
      "a\nB\n",
    ],
    ["a context marker the new file contradicts", eofDiff, eofOld, "A\nb\nc\n"],
  ];
  for (const [name, diff, oldText, newText] of cases)
    assert.equal(hunksMatchContent(diff, oldText, newText, WS), false, name);
});

// The characters -w skips, probed the same way (git 2.51.1, no global or
// system config): "x\nab\n" against "X\na<c>b\n", where line 2 is context or
// a change, and a nine-line pair whose line 9 sits in a gap past the first
// hunk's context. Space, tab and an interior CR leave line 2 context and the
// gap alone:
//   " "  -> "@@ -1,2 +1,2 @@\n-x\n+X\n a b\n"
//   "\t" -> "@@ -1,2 +1,2 @@\n-x\n+X\n a\tb\n"
//   "\r" -> "@@ -1,2 +1,2 @@\n-x\n+X\n a\rb\n"
//   gap, each of the three -> "@@ -1,4 +1,4 @@\n-x\n+X\n 2\n 3\n 4\n"
// \v, \f and U+00A0 make line 2 a change and give the gap a hunk of its own:
//   "\v" -> "@@ -1,2 +1,2 @@\n-x\n-ab\n+X\n+a\u000bb\n"
//   gap  -> "@@ -1,4 +1,4 @@\n-x\n+X\n 2\n 3\n 4\n@@ -6,4 +6,4 @@ x\n 6\n 7\n 8\n-ab\n+a\u000bb\n"
const GAP_BODY = "2\n3\n4\n5\n6\n7\n8\n";
const GAP_HUNK = "@@ -1,4 +1,4 @@\n-x\n+X\n 2\n 3\n 4\n";

test("ignoreWhitespace skips space, tab and CR only, as -w does", () => {
  for (const [name, ch] of [
    ["space", " "],
    ["tab", "\t"],
    ["interior CR", "\r"],
  ]) {
    const ctx = `@@ -1,2 +1,2 @@\n-x\n+X\n a${ch}b\n`;
    assert.equal(
      hunksMatchContent(ctx, "x\nab\n", `X\na${ch}b\n`, WS),
      true,
      `context: ${name}`,
    );
    assert.equal(
      hunksMatchContent(GAP_HUNK, `x\n${GAP_BODY}ab\n`, `X\n${GAP_BODY}a${ch}b\n`, WS),
      true,
      `gap: ${name}`,
    );
  }
  for (const [name, ch] of [
    ["\\v", "\v"],
    ["\\f", "\f"],
    ["U+00A0", "\u00a0"],
  ]) {
    const oldText = "x\nab\n";
    const newText = `X\na${ch}b\n`;
    // The real -w text draws the line as a change.
    const real = `@@ -1,2 +1,2 @@\n-x\n-ab\n+X\n+a${ch}b\n`;
    assert.equal(hunksMatchContent(real, oldText, newText, WS), true, `real: ${name}`);
    // The text -w would print if it skipped the character is refused.
    const asIfSkipped = `@@ -1,2 +1,2 @@\n-x\n+X\n a${ch}b\n`;
    assert.equal(
      hunksMatchContent(asIfSkipped, oldText, newText, WS),
      false,
      `context: ${name}`,
    );
    assert.equal(
      hunksMatchContent(GAP_HUNK, `x\n${GAP_BODY}ab\n`, `X\n${GAP_BODY}a${ch}b\n`, WS),
      false,
      `gap: ${name}`,
    );
  }
});

// A last line holding only a CR, with no final LF ("a\n\r" against an empty
// file), probed the same way; plain and -w print the same text:
//   "@@ -0,0 +1,2 @@\n+a\n+\r\n\\ No newline at end of file\n"
test("a last line holding a lone CR is a line, in exact and -w mode", () => {
  const diff = "@@ -0,0 +1,2 @@\n+a\n+\r\n\\ No newline at end of file\n";
  assert.equal(hunksMatchContent(diff, "", "a\n\r"), true, "exact");
  assert.equal(hunksMatchContent(diff, "", "a\n\r", WS), true, "ws");
  // Without the line, or with a final newline after it, the text is refused.
  for (const newText of ["a\n", "a\n\r\n"]) {
    assert.equal(hunksMatchContent(diff, "", newText), false, JSON.stringify(newText));
    assert.equal(hunksMatchContent(diff, "", newText, WS), false, JSON.stringify(newText));
  }
});

test("ignoreWhitespace absent or false is exact mode", () => {
  const [diff, oldText, newText] = CAPTURED.reindentEdit;
  assert.equal(hunksMatchContent(diff, oldText, newText, {}), false);
  assert.equal(
    hunksMatchContent(diff, oldText, newText, { ignoreWhitespace: false }),
    false,
  );
  assert.equal(hunksMatchContent(EDIT, OLD, NEW, WS), true);
});

// The -w set is spelled once, in hunk-match.ts: forge-whitespace.ts spells no
// copy of its own that could drift from it.
test("stripGitWhitespace is the one spelling of -w's set", () => {
  assert.equal(stripGitWhitespace(" a\tb\rc \u00a0\v\f"), "abc\u00a0\v\f");
  assert.equal(stripGitWhitespace("a b"), stripGitWhitespace("a b"), "stateless");
  const src = (f) =>
    readFileSync(new URL(`../src/features/diff/${f}`, import.meta.url), "utf8");
  const setLiteral = /\[ \\t\\r\]/g;
  assert.equal(src("hunk-match.ts").match(setLiteral)?.length, 1, "hunk-match.ts");
  const forge = src("forge-whitespace.ts");
  assert.equal(forge.match(setLiteral), null, "forge-whitespace.ts spells no set");
});
