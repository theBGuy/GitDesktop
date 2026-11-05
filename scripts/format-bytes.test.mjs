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

test("TB is the largest unit", () => {
  assert.equal(formatBytes(5 * 1024 ** 4), "5.0 TB");
  assert.equal(formatBytes(2048 * 1024 ** 4), "2048 TB");
});
