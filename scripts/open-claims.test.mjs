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

test("an order claim ignores the epoch, retires older claims and falls to newer ones", () => {
  let epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  const o = claims.claimOrder();
  assert.equal(a(), false);
  epoch++;
  assert.equal(o(), true);
  const p = claims.claimOrder();
  assert.equal(o(), false);
  assert.equal(p(), true);
  claims.claim();
  assert.equal(p(), false);
});

test("of two reservations the later one wins, whichever claims first", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.reserve();
  const b = claims.reserve();
  const aCheck = a();
  assert.equal(aCheck(), true);
  const bCheck = b();
  assert.equal(bCheck(), true);
  assert.equal(aCheck(), false);

  const c = claims.reserve();
  const d = claims.reserve();
  const dCheck = d();
  assert.equal(dCheck(), true);
  assert.equal(c(), null);
  assert.equal(dCheck(), true);
});

test("a reservation never claimed leaves an earlier claim standing", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  claims.reserve();
  assert.equal(a(), true);
  // Nor does it fail a watermark taken before it.
  const w = claims.watermark();
  claims.reserve();
  assert.equal(w(), true);
});

test("a claim made after a reservation beats it", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const r = claims.reserve();
  const b = claims.claim();
  assert.equal(r(), null);
  assert.equal(b(), true);
});

test("a reservation made after a claim beats it once it claims", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const a = claims.claim();
  const r = claims.reserve();
  assert.equal(a(), true);
  const rCheck = r();
  assert.equal(rCheck(), true);
  assert.equal(a(), false);
});

test("an epoch move since a reservation fails it", () => {
  let epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const r = claims.reserve();
  epoch++;
  assert.equal(r(), null);

  const s = claims.reserve();
  const sCheck = s();
  assert.equal(sCheck(), true);
  epoch++;
  assert.equal(sCheck(), false);
});

test("a reservation claiming after a watermark fails the watermark", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const r = claims.reserve();
  const w = claims.watermark();
  assert.equal(w(), true);
  r();
  assert.equal(w(), false);
});

test("an order claim made after a reservation beats it", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const r = claims.reserve();
  const o = claims.claimOrder();
  assert.equal(r(), null);
  assert.equal(o(), true);
});

test("a reservation made after an order claim beats it once it claims", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const o = claims.claimOrder();
  const r = claims.reserve();
  assert.equal(o(), true);
  r();
  assert.equal(o(), false);
});

test("claiming one reservation twice keeps both checks and retires nothing more", () => {
  const epoch = 0;
  const claims = createOpenClaims(() => epoch);
  const r = claims.reserve();
  const first = r();
  const w = claims.watermark();
  const second = r();
  assert.equal(first(), true);
  assert.equal(second(), true);
  assert.equal(w(), true);
});
