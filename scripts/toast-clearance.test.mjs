// Pins how far toasts lift above a docked action bar: the bar's distance from
// the viewport bottom plus a gap, nothing for a bar off-screen or a measurement
// that isn't a number, and the shared store's max-of-entries aggregate that
// notifies only when the lift actually changes.
//
// `toast-clearance.ts` has no runtime import (settings-discard-confirm.test.mjs
// pins that), so this suite imports it straight from `src/` under Node's type
// stripping and runs in the no-install `guards` job.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  barClearance,
  clearToastClearance,
  maxClearance,
  publishToastClearance,
  subscribeToastClearance,
  TOAST_BAR_GAP,
  toastClearance,
} from "../src/lib/toast-clearance.ts";

const IDS = ["bar-a", "bar-b"];
afterEach(() => {
  for (const id of IDS) clearToastClearance(id);
});

test("the gap keeps toasts a little above the bar", () => {
  assert.equal(TOAST_BAR_GAP, 12);
});

test("the lift is the bar's distance from the viewport bottom plus the gap", () => {
  assert.equal(barClearance({ viewportHeight: 800, barTop: 750, gap: 12 }), 62);
  // A strip docked below the bar raises its top edge, and the lift with it.
  assert.equal(barClearance({ viewportHeight: 800, barTop: 722, gap: 12 }), 90);
});

test("a fractional measurement rounds before the gap is added", () => {
  assert.equal(
    barClearance({ viewportHeight: 800, barTop: 749.6, gap: 12 }),
    62,
  );
  assert.equal(
    barClearance({ viewportHeight: 800, barTop: 749.4, gap: 12 }),
    63,
  );
});

test("a bar at or below the viewport bottom lifts nothing", () => {
  assert.equal(barClearance({ viewportHeight: 800, barTop: 800, gap: 12 }), 0);
  assert.equal(barClearance({ viewportHeight: 800, barTop: 900, gap: 12 }), 0);
});

test("a measurement that isn't a finite number lifts nothing", () => {
  for (const [viewportHeight, barTop, gap] of [
    [Number.NaN, 750, 12],
    [800, Number.NaN, 12],
    [800, Number.NEGATIVE_INFINITY, 12],
    [Number.POSITIVE_INFINITY, 750, 12],
    [800, 750, Number.NaN],
  ])
    assert.equal(barClearance({ viewportHeight, barTop, gap }), 0);
});

test("the aggregate is the largest entry, 0 when there are none", () => {
  assert.equal(maxClearance([]), 0);
  assert.equal(maxClearance([40, 90, 62]), 90);
  assert.equal(maxClearance(new Map([["a", 5]]).values()), 5);
});

test("publishing and clearing entries moves the toaster's lift", () => {
  assert.equal(toastClearance(), 0);
  publishToastClearance("bar-a", 62);
  assert.equal(toastClearance(), 62);
  publishToastClearance("bar-b", 90);
  assert.equal(toastClearance(), 90);
  clearToastClearance("bar-b");
  assert.equal(toastClearance(), 62);
  clearToastClearance("bar-a");
  assert.equal(toastClearance(), 0);
});

test("listeners hear only a changed lift", () => {
  let calls = 0;
  const unsubscribe = subscribeToastClearance(() => {
    calls++;
  });
  publishToastClearance("bar-a", 62);
  assert.equal(calls, 1);
  // The same value again, a smaller second entry, and clearing an unknown id
  // all leave the aggregate where it was.
  publishToastClearance("bar-a", 62);
  publishToastClearance("bar-b", 40);
  clearToastClearance("bar-unknown");
  assert.equal(calls, 1);
  clearToastClearance("bar-a");
  assert.equal(calls, 2);
  assert.equal(toastClearance(), 40);
  unsubscribe();
  clearToastClearance("bar-b");
  assert.equal(calls, 2, "an unsubscribed listener was still called");
});

test("re-publishing one id replaces its entry rather than adding one", () => {
  publishToastClearance("bar-a", 90);
  publishToastClearance("bar-a", 62);
  assert.equal(toastClearance(), 62);
  clearToastClearance("bar-a");
  assert.equal(toastClearance(), 0);
});
