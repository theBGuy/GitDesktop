// Pins the pure PR-write bookkeeping: how a pending write's variables name the PR
// (or stack) it targets, and which PR view each one holds. A wrong answer here
// never errors — a variables-shape change reads as "targets nothing" and the hold
// silently drops — so each shape a write hook sends is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `pr-writes.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPendingFor,
  isStackMergePendingFor,
  pendingPrWriteTarget,
  prWriteKey,
} from "../src/lib/git/queries/pr-writes.ts";

const write = (kind, vars) => ({ kind, ...pendingPrWriteTarget(vars) });

test("a bare number is the target, with no lens or stack", () => {
  assert.deepEqual(pendingPrWriteTarget(7), {
    target: 7,
    lens: null,
    stack: null,
  });
});

test("an object's number is the target; a missing lens reads as none", () => {
  assert.deepEqual(pendingPrWriteTarget({ number: 7, body: "hi" }), {
    target: 7,
    lens: null,
    stack: null,
  });
});

test("an object carries its lens", () => {
  assert.deepEqual(pendingPrWriteTarget({ number: 7, lens: "upstream" }), {
    target: 7,
    lens: "upstream",
    stack: null,
  });
  assert.equal(
    pendingPrWriteTarget({ number: 7, lens: "origin" }).lens,
    "origin",
  );
});

test("an unrecognized lens reads as none, never a guessed one", () => {
  assert.equal(pendingPrWriteTarget({ number: 7, lens: "fork" }).lens, null);
  assert.equal(pendingPrWriteTarget({ number: 7, lens: 1 }).lens, null);
});

test("non-objects and a non-numeric number target nothing", () => {
  for (const vars of [undefined, null, "7", true, []]) {
    assert.deepEqual(pendingPrWriteTarget(vars), {
      target: null,
      lens: null,
      stack: null,
    });
  }
  assert.equal(pendingPrWriteTarget({ number: "7" }).target, null);
});

test("a merge carries the native stack it cascades through", () => {
  assert.equal(
    pendingPrWriteTarget({ number: 7, lens: "origin", stack: 3 }).stack,
    3,
  );
  assert.equal(
    pendingPrWriteTarget({ number: 7, lens: "origin", stack: null }).stack,
    null,
  );
  assert.equal(pendingPrWriteTarget({ number: 7, stack: "3" }).stack, null);
});

test("a write holds only its own kind and PR", () => {
  const writes = [write("merge", { number: 7, lens: "origin", stack: null })];
  assert.equal(isPendingFor(writes, "merge", 7, "origin"), true);
  assert.equal(isPendingFor(writes, "merge", 8, "origin"), false);
  assert.equal(isPendingFor(writes, "close", 7, "origin"), false);
});

test("a write with a lens holds only that lens's PR", () => {
  const writes = [write("close", { number: 7, lens: "upstream" })];
  assert.equal(isPendingFor(writes, "close", 7, "upstream"), true);
  assert.equal(isPendingFor(writes, "close", 7, "origin"), false);
});

test("a lens-less write holds its number under either lens", () => {
  const writes = [
    write("approve", 7),
    write("comment", { number: 9, body: "x", author: "me" }),
  ];
  assert.equal(isPendingFor(writes, "approve", 7, "origin"), true);
  assert.equal(isPendingFor(writes, "approve", 7, "upstream"), true);
  assert.equal(isPendingFor(writes, "comment", 9, "upstream"), true);
});

test("every pending write counts, not just the latest", () => {
  const writes = [
    write("close", { number: 7, lens: "origin" }),
    write("close", { number: 8, lens: "origin" }),
  ];
  assert.equal(isPendingFor(writes, "close", 7, "origin"), true);
  assert.equal(isPendingFor(writes, "close", 8, "origin"), true);
});

test("a null target holds nothing, even beside a target-less write", () => {
  const writes = [write("stack-dissolve", undefined)];
  assert.equal(isPendingFor(writes, "stack-dissolve", null, "origin"), false);
});

test("a dissolve holds every member of the stack it names", () => {
  const writes = [write("stack-dissolve", 3)];
  assert.equal(isPendingFor(writes, "stack-dissolve", 3, "origin"), true);
  assert.equal(isPendingFor(writes, "stack-dissolve", 4, "origin"), false);
});

test("a stack merge holds every member of its stack, in its lens", () => {
  const writes = [write("merge", { number: 7, lens: "origin", stack: 3 })];
  assert.equal(isStackMergePendingFor(writes, 3, "origin"), true);
  assert.equal(isStackMergePendingFor(writes, 4, "origin"), false);
  assert.equal(isStackMergePendingFor(writes, 3, "upstream"), false);
  assert.equal(isStackMergePendingFor(writes, null, "origin"), false);
});

test("an unstacked merge, or another kind naming a stack, holds no stack", () => {
  const writes = [
    write("merge", { number: 7, lens: "origin", stack: null }),
    write("close", { number: 8, lens: "origin", stack: 3 }),
  ];
  assert.equal(isStackMergePendingFor(writes, 3, "origin"), false);
});

test("a PR write's key files it by kind and repo under one prefix", () => {
  assert.deepEqual(prWriteKey("merge", "C:/a"), ["pr-write", "merge", "C:/a"]);
});
