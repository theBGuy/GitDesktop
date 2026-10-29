// Pins how far toasts lift above a docked action bar: the bar's distance from
// the viewport bottom plus a gap, nothing for a bar off-screen or a measurement
// that isn't a number, the move watch's root box around the bar, and the shared
// store's max-of-entries aggregate that notifies only when the lift actually
// changes.
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
  moveWatchOptions,
  publishToastClearance,
  subscribeToastClearance,
  TOAST_BAR_GAP,
  toastClearance,
} from "../src/lib/toast-clearance.ts";

const BAR = { left: 100, top: 700, width: 600, height: 50 };
const ROOT = { rootWidth: 1000, rootHeight: 800 };

test("the move watch's root box hugs the bar, armed at full visibility", () => {
  assert.deepEqual(moveWatchOptions({ ...BAR, ...ROOT }), {
    rootMargin: "-700px -300px -50px -100px",
    threshold: 1,
  });
  // A bar flush with the root's top-left edges insets by zero, never "-0px".
  assert.equal(
    moveWatchOptions({ ...BAR, left: 0, top: 0, ...ROOT })?.rootMargin,
    "0px -400px -750px 0px",
  );
});

test("fractional edges floor, so the root box still contains the whole bar", () => {
  const rect = { left: 10.4, top: 749.6, width: 200.2, height: 40.5 };
  const options = moveWatchOptions({ ...rect, ...ROOT });
  assert.deepEqual(options, {
    rootMargin: "-749px -789px -9px -10px",
    threshold: 1,
  });
  const [top, right, bottom, left] = options.rootMargin
    .split(" ")
    .map((v) => -Number.parseFloat(v));
  assert.ok(top <= rect.top && left <= rect.left);
  assert.ok(ROOT.rootWidth - right >= rect.left + rect.width);
  assert.ok(ROOT.rootHeight - bottom >= rect.top + rect.height);
});

test("a bar across or below the viewport bottom expands the root, still armed", () => {
  // Straddling the bottom edge by 30px, then wholly 100px below it.
  assert.deepEqual(moveWatchOptions({ ...BAR, top: 780, ...ROOT }), {
    rootMargin: "-780px -300px 30px -100px",
    threshold: 1,
  });
  assert.deepEqual(moveWatchOptions({ ...BAR, top: 900, ...ROOT }), {
    rootMargin: "-900px -300px 150px -100px",
    threshold: 1,
  });
});

test("a re-arm ratio is clamped into (0, 1], with nothing read as full", () => {
  for (const [given, armed] of [
    [0.6, 0.6],
    [1e-7, 1e-7],
    [1, 1],
    [1.3, 1],
    [0, 1],
    [-0.5, 1],
  ])
    assert.equal(
      moveWatchOptions({ ...BAR, ...ROOT, threshold: given })?.threshold,
      armed,
      `threshold ${given}`,
    );
});

test("a boxless bar arms no move watch", () => {
  assert.equal(moveWatchOptions({ ...BAR, width: 0, ...ROOT }), null);
  assert.equal(moveWatchOptions({ ...BAR, height: 0, ...ROOT }), null);
  assert.equal(
    moveWatchOptions({ left: 0, top: 0, width: 0, height: 0, ...ROOT }),
    null,
  );
});

test("a measurement that isn't a finite number arms no move watch", () => {
  const input = { ...BAR, ...ROOT, threshold: 1 };
  for (const field of Object.keys(input))
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      assert.equal(
        moveWatchOptions({ ...input, [field]: bad }),
        null,
        `${field} = ${bad}`,
      );
});

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
