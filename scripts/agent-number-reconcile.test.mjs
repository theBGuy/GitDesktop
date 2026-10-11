// Pins how agent `#N` numbers merge across instances at persist time: disk wins for
// an id both sides numbered, a memory-only number already taken on disk is
// re-minted, and a pass over already-merged state reports no change (the persist
// subscriber re-fires on the absorbed result, so a false `changed` would loop).
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: the reconcile module must
// stay import-free. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileNumbers } from "../src/features/sessions/agent-number-reconcile.ts";

test("an id numbered on both sides adopts the disk number", () => {
  const r = reconcileNumbers({ a: 3 }, 4, { a: 7 }, 8);
  assert.equal(r.numbers.a, 3);
  assert.equal(r.changed, true);
});

test("a memory-only id with a taken number re-mints past every counter", () => {
  // Disk holds 5 and 6; memory's `b` collides on 5. Counters top out at 5, so the
  // re-mint must skip the taken 5 and 6 and land on 7.
  const r = reconcileNumbers({ a: 5, c: 6 }, 5, { b: 5 }, 3);
  assert.deepEqual(r.numbers, { a: 5, c: 6, b: 7 });
  assert.equal(r.counter, 8);
  assert.equal(r.changed, true);
});

test("re-mints follow memory order and never reuse one another", () => {
  const r = reconcileNumbers({ a: 1, b: 2 }, 3, { x: 1, y: 2 }, 3);
  assert.equal(r.numbers.x, 3);
  assert.equal(r.numbers.y, 4);
  assert.equal(r.counter, 5);
});

test("a memory-only id with a free number keeps it", () => {
  const r = reconcileNumbers({ a: 1 }, 2, { a: 1, b: 9 }, 10);
  assert.equal(r.numbers.b, 9);
  assert.equal(r.counter, 10);
  assert.equal(r.changed, false);
});

test("disk-only ids are absorbed into memory", () => {
  const r = reconcileNumbers({ a: 1, z: 4 }, 5, { a: 1 }, 2);
  assert.deepEqual(r.numbers, { a: 1, z: 4 });
  assert.equal(r.counter, 5);
  assert.equal(r.changed, true);
});

test("identical maps and counters settle with no change", () => {
  const map = { a: 1, b: 2, c: 3 };
  const r = reconcileNumbers({ ...map }, 4, { ...map }, 4);
  assert.deepEqual(r.numbers, map);
  assert.equal(r.counter, 4);
  assert.equal(r.changed, false);
});

test("a reconciled result reconciles to itself", () => {
  const first = reconcileNumbers({ a: 2, c: 3 }, 4, { b: 2, d: 6 }, 7);
  const again = reconcileNumbers(
    first.numbers,
    first.counter,
    first.numbers,
    first.counter,
  );
  assert.equal(again.changed, false);
  assert.deepEqual(again.numbers, first.numbers);
  assert.equal(again.counter, first.counter);
});

test("the counter is the max of disk, memory, and the last re-mint + 1", () => {
  assert.equal(reconcileNumbers({}, 9, {}, 2).counter, 9);
  assert.equal(reconcileNumbers({}, 2, {}, 9).counter, 9);
  // A disk map past its own counter still clears every number handed out.
  assert.equal(reconcileNumbers({ a: 12 }, 3, {}, 2).counter, 13);
  assert.equal(reconcileNumbers({ a: 3 }, 4, { b: 3 }, 4).counter, 5);
  assert.equal(reconcileNumbers({}, 0, {}, 0).counter, 1);
});
