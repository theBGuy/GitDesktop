// Pins the shared byte formatter (Insights, tag assets, the binary diff size
// line). Installless: the import reaches straight into src/ under Node's type
// stripping, so format-bytes.ts stays import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes } from "../src/lib/format-bytes.ts";

test("bytes stay whole below 1 KB", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(700), "700 B");
  assert.equal(formatBytes(1023), "1023 B");
});

test("units are base 1024, one decimal below 100", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  // Base 1000 would read "5.0 KB".
  assert.equal(formatBytes(5000), "4.9 KB");
  assert.notEqual(formatBytes(5000), "5.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("100 and up of a unit rounds to a whole number", () => {
  assert.equal(formatBytes(102400), "100 KB");
  assert.equal(formatBytes(99.94 * 1024), "99.9 KB");
});

test("a decimal rounding to 100.0 prints the whole number", () => {
  // 102349 B is 99.950 KB; one byte less is 99.949 KB.
  assert.equal(formatBytes(102349), "100 KB");
  assert.equal(formatBytes(102348), "99.9 KB");
  assert.equal(formatBytes(102297), "99.9 KB");
});

test("a value rounding to 1024 of a unit carries to the next unit", () => {
  assert.equal(formatBytes(1048570), "1.0 MB");
  assert.equal(formatBytes(1048575), "1.0 MB");
  // 1023.5 KB is the first value that rounds to 1024; 1023.49 KB stays.
  assert.equal(formatBytes(1023.5 * 1024), "1.0 MB");
  assert.equal(formatBytes(1023.49 * 1024), "1023 KB");
  assert.equal(formatBytes(1024 ** 3 - 1), "1.0 GB");
  assert.equal(formatBytes(1024 ** 4 - 1), "1.0 TB");
});

test("TB is the largest unit", () => {
  assert.equal(formatBytes(5 * 1024 ** 4), "5.0 TB");
  assert.equal(formatBytes(2048 * 1024 ** 4), "2048 TB");
  // No unit past TB to carry into.
  assert.equal(formatBytes(1023.9 * 1024 ** 4), "1024 TB");
});
