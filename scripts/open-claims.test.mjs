// Pins the request order repo opens are checked against: only the newest claimed
// open may land, any navigation (an interaction-epoch move) retires every pending
// one, and a watermark notices a newer open without claiming one itself. These
// orderings decide which of two racing opens the user ends up in, and a slip
// lands them silently in the older one.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so `open-claims.ts` must
// stay import-free. Node's stdlib test runner only, no dev dependency: the CI
// `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpenClaims } from "../src/features/repository/open-claims.ts";

test("a newer claim retires an older one", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  const b = claims.claim();
  assert.equal(a(), false);
  assert.equal(b(), true);
});

test("an epoch move retires a pending claim", () => {
  let epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  epoch++;
  assert.equal(a(), false);
});

test("checking a claim consumes nothing", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  const b = claims.claim();
  assert.equal(a(), false);
  assert.equal(a(), false);
  assert.equal(b(), true);
  assert.equal(b(), true);
  // Nor does taking a watermark in between.
  claims.watermark();
  assert.equal(b(), true);
});

test("a claim taken after an epoch move stands", () => {
  let epoch = 0;
  const claims = createOpenClaims(() => epoch);
  epoch++;
  const a = claims.claim();
  assert.equal(a(), true);
});

test("a claim after a watermark fails the watermark and stands itself", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const w = claims.watermark();
  const a = claims.claim();
  assert.equal(w(), false);
  assert.equal(a(), true);
});

test("an epoch move fails a watermark", () => {
  let epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const w = claims.watermark();
  epoch++;
  assert.equal(w(), false);
});

test("a watermark holds while nothing moves, and never retires a claim", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  const w = claims.watermark();
  assert.equal(w(), true);
  assert.equal(a(), true);
});
