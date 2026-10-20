// Pins the cursor math both palette-style pickers share
// (src/features/shortcuts/palette-highlight.ts): one clamped index, -1 on an
// empty list, arrow steps from the CLAMPED cursor, and empty-list arrows that
// leave the stored value alone. Also pins, by source shape, that each picker in
// CALL_SITES reads that one clamped index for the marker, Enter and the scroll
// effect, and that each arrow arm steps the stored value via the helper.
//
// Not testable here: the live render and dispatch (which row the user sees marked,
// what Enter runs, scroll-into-view). Those need the running app; the shape pins
// cover the wiring's text, not its runtime.
//
// The import reaches straight into `src/` under Node's type stripping, which
// resolves no bundler aliases, so the module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  clampHighlight,
  stepHighlight,
} from "../src/features/shortcuts/palette-highlight.ts";

test("clampHighlight: an empty list has no cursor", () => {
  assert.equal(clampHighlight(0, 0), -1);
  assert.equal(clampHighlight(5, 0), -1);
  assert.equal(clampHighlight(-1, 0), -1);
});

test("clampHighlight: in-range values pass through", () => {
  assert.equal(clampHighlight(0, 1), 0);
  assert.equal(clampHighlight(2, 5), 2);
  assert.equal(clampHighlight(4, 5), 4);
  assert.equal(clampHighlight(1, 2), 1);
});

test("clampHighlight: over-range clamps to the last row", () => {
  assert.equal(clampHighlight(8, 5), 4);
  assert.equal(clampHighlight(5, 5), 4);
  assert.equal(clampHighlight(3, 1), 0);
  assert.equal(clampHighlight(2, 2), 1);
});

test("clampHighlight: a negative stored value floors at row 0", () => {
  assert.equal(clampHighlight(-1, 3), 0);
  assert.equal(clampHighlight(-1, 1), 0);
});

test("stepHighlight: an empty list leaves the stored value unchanged", () => {
  assert.equal(stepHighlight(0, 0, 1), 0);
  assert.equal(stepHighlight(5, 0, -1), 5);
  assert.equal(stepHighlight(5, 0, 1), 5);
  assert.equal(stepHighlight(0, 0, -1), 0);
});

test("stepHighlight: steps clamp at both ends", () => {
  assert.equal(stepHighlight(4, 5, 1), 4);
  assert.equal(stepHighlight(0, 5, -1), 0);
  assert.equal(stepHighlight(0, 1, 1), 0);
  assert.equal(stepHighlight(0, 1, -1), 0);
});

test("stepHighlight: in-range steps move one row", () => {
  assert.equal(stepHighlight(2, 5, 1), 3);
  assert.equal(stepHighlight(2, 5, -1), 1);
  assert.equal(stepHighlight(0, 2, 1), 1);
});

test("stepHighlight: steps from the clamped cursor, not the stored value", () => {
  assert.equal(stepHighlight(8, 5, 1), 4);
  assert.equal(stepHighlight(8, 5, -1), 3);
  assert.equal(stepHighlight(-1, 3, 1), 1);
  assert.equal(stepHighlight(-1, 3, -1), 0);
});

test("stepHighlight: every non-empty result lands in [0, count-1]", () => {
  for (const count of [1, 2, 5]) {
    for (const stored of [-1, 0, 2, count - 1, count, count + 3]) {
      for (const delta of [1, -1]) {
        const next = stepHighlight(stored, count, delta);
        assert.ok(
          next >= 0 && next <= count - 1,
          `stepHighlight(${stored}, ${count}, ${delta}) = ${next}`,
        );
      }
    }
  }
});

// The palette-style pickers that share the helper; every source-shape pin runs
// per file, so a failure names the picker that broke.
const CALL_SITES = [
  "src/features/shortcuts/CommandPalette.tsx",
  "src/features/scripts/RunTaskPicker.tsx",
];

// Comments are stripped first so a comment can neither satisfy a positive pin nor
// trip a negative one. Neither call site carries `//` inside a string literal.
const readStripped = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function countMatches(source, re) {
  return (source.match(new RegExp(re.source, "g")) ?? []).length;
}

for (const file of CALL_SITES) {
  const source = readStripped(file);

  test(`${file}: no raw comparison against the stored index`, () => {
    assert.doesNotMatch(source, /[!=]==?\s*highlight\b|\bhighlight\s*[!=]==?/);
  });

  test(`${file}: no inline clamp at the Enter target`, () => {
    assert.doesNotMatch(source, /items\[\s*Math\.min\(/);
  });

  test(`${file}: marker and Enter read the one clamped index`, () => {
    assert.match(
      source,
      /const\s+active\s*=\s*clampHighlight\(\s*highlight\s*,\s*items\.length\s*\)/,
    );
    assert.match(source, /items\[\s*active\s*\]/);
    assert.ok(
      countMatches(source, /index\s*===\s*active/) >= 2,
      "both the data-highlighted attr and the accent class compare against active",
    );
  });

  test(`${file}: the scroll effect is keyed on the clamped index`, () => {
    assert.match(source, /\},\s*\[\s*active\s*\]\s*\);/);
  });

  test(`${file}: each arrow arm steps the stored index`, () => {
    const down = /stepHighlight\(\s*highlight\s*,\s*items\.length\s*,\s*1\s*\)/;
    const up = /stepHighlight\(\s*highlight\s*,\s*items\.length\s*,\s*-1\s*\)/;
    assert.equal(countMatches(source, down), 1, "ArrowDown steps +1");
    assert.equal(countMatches(source, up), 1, "ArrowUp steps -1");
    assert.equal(
      countMatches(source, /stepHighlight\(/),
      2,
      "no other step call",
    );
  });
}
