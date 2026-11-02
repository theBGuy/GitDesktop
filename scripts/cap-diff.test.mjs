// Pins the diff cap (src/features/diff/cap-diff.ts): it counts REAL lines (a
// final newline's empty segment is not one), cuts on whole hunks where it can,
// and reports which hunks stayed whole so the staging view can keep their
// actions. The imports reach straight into src/ under Node's type stripping,
// so both modules stay free of runtime imports; this suite needs no install.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capDiffText,
  DIFF_LINE_CAP,
  HIGHLIGHT_MAX_LINES,
  highlightCostLength,
  realLineCount,
  STAGING_DIFF_LINE_CAP,
  stagingContentMaxLines,
} from "../src/features/diff/cap-diff.ts";
import { parseHunks } from "../src/lib/git/hunks.ts";

const HEADER = [
  "diff --git a/f.ts b/f.ts",
  "index 1111111..2222222 100644",
  "--- a/f.ts",
  "+++ b/f.ts",
];

/** One hunk of `bodyLen` added lines, numbered from `start`. */
function hunk(start, bodyLen) {
  const body = Array.from({ length: bodyLen }, (_, k) => `+line ${start + k}`);
  return [`@@ -${start},0 +${start},${bodyLen} @@`, ...body];
}

/** A diff of the given hunk body sizes; real lines = 4 + sum(1 + size). */
function diff(sizes, trailingNewline) {
  const lines = [...HEADER];
  let start = 1;
  for (const size of sizes) {
    lines.push(...hunk(start, size));
    start += size + 10;
  }
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

test("realLineCount excludes the final newline's empty segment", () => {
  assert.equal(realLineCount(""), 0);
  assert.equal(realLineCount("a"), 1);
  assert.equal(realLineCount("a\n"), 1);
  assert.equal(realLineCount("a\nb"), 2);
  assert.equal(realLineCount("a\nb\n"), 2);
  assert.equal(realLineCount("\n"), 1);
  assert.equal(realLineCount("a\n\n"), 2);
});

for (const cap of [STAGING_DIFF_LINE_CAP, DIFF_LINE_CAP]) {
  for (const nl of [false, true]) {
    const tag = `cap ${cap}, ${nl ? "with" : "without"} trailing newline`;

    test(`${tag}: exactly cap real lines, one hunk, is uncapped`, () => {
      // 4 header + 1 @@ + body = cap
      const text = diff([cap - 5], nl);
      assert.equal(realLineCount(text), cap);
      const r = capDiffText(text, cap);
      assert.equal(r.text, text);
      assert.equal(r.hidden, 0);
      assert.equal(r.wholeHunks, 1);
      assert.equal(r.cutHunk, false);
    });

    test(`${tag}: exactly cap real lines, two hunks, is uncapped`, () => {
      const first = Math.floor((cap - 6) / 2);
      const text = diff([first, cap - 6 - first], nl);
      assert.equal(realLineCount(text), cap);
      const r = capDiffText(text, cap);
      assert.equal(r.text, text);
      assert.equal(r.hidden, 0);
      assert.equal(r.wholeHunks, 2);
      assert.equal(r.cutHunk, false);
    });

    test(`${tag}: cap + 1 real lines, one hunk, cuts it with 1 hidden`, () => {
      const text = diff([cap - 4], nl);
      assert.equal(realLineCount(text), cap + 1);
      const r = capDiffText(text, cap);
      assert.equal(r.hidden, 1);
      assert.equal(r.wholeHunks, 0);
      assert.equal(r.cutHunk, true);
      assert.equal(realLineCount(r.text), cap);
    });

    test(`${tag}: cap + 1 real lines, two hunks, hides the last whole`, () => {
      const first = Math.floor((cap - 6) / 2);
      const second = cap - 5 - first;
      const text = diff([first, second], nl);
      assert.equal(realLineCount(text), cap + 1);
      const r = capDiffText(text, cap);
      assert.equal(r.hidden, second + 1);
      assert.equal(r.wholeHunks, 1);
      assert.equal(r.cutHunk, false);
      assert.equal(realLineCount(r.text) + r.hidden, realLineCount(text));
    });

    test(`${tag}: hunks filling the cap exactly all stay whole`, () => {
      const first = Math.floor((cap - 6) / 2);
      const text = diff([first, cap - 6 - first, 10], nl);
      const r = capDiffText(text, cap);
      assert.equal(r.wholeHunks, 2);
      assert.equal(r.cutHunk, false);
      assert.equal(r.hidden, 11);
      assert.equal(realLineCount(r.text), cap);
    });
  }
}

test("a boundary cut keeps whole hunks byte-identical to the full parse", () => {
  const text = diff([300, 300, 300, 300, 300], true);
  const r = capDiffText(text, STAGING_DIFF_LINE_CAP);
  assert.equal(r.cutHunk, false);
  assert.equal(r.wholeHunks, 3);
  assert.equal(r.hidden, 2 * 301);
  const full = parseHunks(text).hunks;
  const capped = parseHunks(r.text).hunks;
  assert.equal(capped.length, r.wholeHunks);
  for (let i = 0; i < r.wholeHunks; i++) {
    assert.equal(capped[i].text, full[i].text, `hunk ${i}`);
  }
});

test("a 5000-line many-hunk diff cuts between hunks", () => {
  const text = diff(
    Array.from({ length: 50 }, () => 99),
    true,
  );
  assert.equal(realLineCount(text), 5004);
  const r = capDiffText(text, STAGING_DIFF_LINE_CAP);
  assert.equal(r.cutHunk, false);
  assert.equal(r.wholeHunks, 9);
  assert.equal(r.hidden, 5004 - (4 + 9 * 100));
});

test("an oversized first hunk is cut mid-body with its header rewritten", () => {
  const text = [
    ...HEADER,
    "@@ -10,1500 +10,1500 @@ fn ctx()",
    ...Array.from({ length: 1500 }, (_, k) =>
      k % 3 === 0 ? `-old ${k}` : k % 3 === 1 ? `+new ${k}` : ` ctx ${k}`,
    ),
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const r = capDiffText(text, STAGING_DIFF_LINE_CAP);
  assert.equal(r.cutHunk, true);
  assert.equal(r.wholeHunks, 0);
  assert.equal(r.hidden, 4 + 1 + 1501 - STAGING_DIFF_LINE_CAP);
  const lines = r.text.split("\n");
  assert.equal(lines.length, STAGING_DIFF_LINE_CAP);
  const body = lines.slice(5);
  let oldCount = 0;
  let newCount = 0;
  for (const l of body) {
    if (l[0] === "+") newCount++;
    else if (l[0] === "-") oldCount++;
    else {
      oldCount++;
      newCount++;
    }
  }
  assert.equal(lines[4], `@@ -10,${oldCount} +10,${newCount} @@ fn ctx()`);
});

test("wholeHunks is the full hunk count whenever nothing is hidden", () => {
  assert.equal(capDiffText(diff([3, 4, 5], true), 1000).wholeHunks, 3);
  assert.equal(capDiffText(diff([3, 4, 5], false), 1000).wholeHunks, 3);
  assert.equal(capDiffText("", 1000).wholeHunks, 0);
  // A line starting `@@` mid-text counts; one that merely contains it doesn't.
  assert.equal(capDiffText("x @@ y\n@@ -1 +1 @@\n+a", 1000).wholeHunks, 1);
});

test("text with no @@ lines slices raw and reports no hunks", () => {
  const text = `${Array.from({ length: 250 }, (_, k) => `Binary ${k}`).join("\n")}\n`;
  const r = capDiffText(text, DIFF_LINE_CAP);
  assert.equal(r.hidden, 50);
  assert.equal(r.wholeHunks, 0);
  assert.equal(r.cutHunk, false);
  assert.equal(r.text.split("\n").length, DIFF_LINE_CAP);
  const fits = capDiffText("Binary files differ\n", DIFF_LINE_CAP);
  assert.deepEqual(fits, {
    text: "Binary files differ\n",
    hidden: 0,
    wholeHunks: 0,
    cutHunk: false,
  });
});

test("staging content eligibility tracks the cap, then the highlight gate", () => {
  assert.equal(STAGING_DIFF_LINE_CAP, 1000);
  assert.equal(HIGHLIGHT_MAX_LINES, 2000);
  assert.equal(stagingContentMaxLines(false), STAGING_DIFF_LINE_CAP);
  assert.equal(stagingContentMaxLines(true), HIGHLIGHT_MAX_LINES);
});

test("highlightCostLength counts both whole files in content mode", () => {
  assert.equal(highlightCostLength(500), 500);
  assert.equal(highlightCostLength(500, null), 500);
  assert.equal(
    highlightCostLength(500, { old: "a".repeat(90), new: "b".repeat(100) }),
    500,
  );
  assert.equal(
    highlightCostLength(500, { old: "a".repeat(400), new: "b".repeat(300) }),
    700,
  );
  assert.equal(highlightCostLength(10, { old: null, new: "b".repeat(30) }), 30);
});
