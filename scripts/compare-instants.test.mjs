// Pins newest-first ordering across UTC offsets and ties for invalid dates.
// The import reaches into src/ through Node's type stripping, so src/lib/time.ts
// may import types only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareInstantsNewestFirst as compare } from "../src/lib/time.ts";

const early = "2026-01-01T10:00:00+05:00";
const late = "2026-01-01T06:00:00+00:00";
const equalToEarly = "2026-01-01T05:00:00Z";
const newestFirst = [
  "2026-01-01T00:00:00-08:00",
  "2026-01-01T07:00:00Z",
  "2026-01-01T12:00:00+05:30",
];
const valid = [early, late, equalToEarly, ...newestFirst];
const invalid = ["", null, undefined, "not a date"];

test("different offsets order by instant and equivalent instants tie", () => {
  assert.ok(compare(early, late) > 0);
  assert.ok(compare(late, early) < 0);
  assert.equal(compare(early, equalToEarly), 0);
  assert.equal(compare(equalToEarly, early), 0);
});

test("invalid dates tie with each other and follow every valid date", () => {
  for (const a of invalid) {
    for (const b of invalid) assert.equal(compare(a, b), 0);
    for (const b of valid) {
      assert.ok(compare(a, b) > 0);
      assert.ok(compare(b, a) < 0);
    }
  }
});

test("every pair returns a finite number", () => {
  const matrix = [...valid, ...invalid];
  for (const a of matrix) {
    for (const b of matrix) assert.ok(Number.isFinite(compare(a, b)));
  }
});

function* permutations(values) {
  if (values.length === 0) {
    yield [];
    return;
  }
  for (const value of values) {
    const rest = values.filter((other) => other !== value);
    for (const tail of permutations(rest)) yield [value, ...tail];
  }
}

test("all 120 permutations sort newest first with stable invalid ties", () => {
  let count = 0;
  for (const input of permutations([...newestFirst, "", null])) {
    const ties = input.filter((value) => value === "" || value === null);
    assert.deepEqual(input.toSorted(compare), [...newestFirst, ...ties]);
    count++;
  }
  assert.equal(count, 120);
});
