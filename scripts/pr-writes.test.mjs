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
  isStackWritePendingFor,
  LOCAL_PR_WRITES_KEY,
  localPrWriteKey,
  PR_WRITES_KEY,
  pendingLocalPrWrite,
  pendingPrWriteTarget,
  pendingWriteOfKind,
  pendingWritesFor,
  prWriteKey,
  readPendingLocalPrWrite,
  readPendingPrWrite,
} from "../src/lib/git/queries/pr-writes.ts";

const write = (kind, vars) => ({ kind, ...pendingPrWriteTarget(vars) });

test("a bare number is the target, with no lens or stack", () => {
  assert.deepEqual(pendingPrWriteTarget(7), {
    target: 7,
    lens: null,
    stack: null,
    members: null,
  });
});

test("an object's number is the target; a missing lens reads as none", () => {
  assert.deepEqual(pendingPrWriteTarget({ number: 7, body: "hi" }), {
    target: 7,
    lens: null,
    stack: null,
    members: null,
  });
});

test("an object carries its lens", () => {
  assert.deepEqual(pendingPrWriteTarget({ number: 7, lens: "upstream" }), {
    target: 7,
    lens: "upstream",
    stack: null,
    members: null,
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
      members: null,
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

test("a stack create's PR list is its members, with no single target", () => {
  assert.deepEqual(pendingPrWriteTarget([4, 5, 6]), {
    target: null,
    lens: null,
    stack: null,
    members: [4, 5, 6],
  });
});

test("a stack add's members are its PRs; the stack it appends to is its stack", () => {
  // GitHub numbers stacks apart from PRs, so the stack never joins the members.
  assert.deepEqual(
    pendingPrWriteTarget({ stackNumber: 3, pullRequests: [8, 9] }),
    { target: null, lens: null, stack: 3, members: [8, 9] },
  );
  assert.equal(
    pendingPrWriteTarget({ stackNumber: "3", pullRequests: [8] }).stack,
    null,
  );
});

test("a member list keeps only numbers; an empty one holds nothing", () => {
  assert.deepEqual(pendingPrWriteTarget([4, "5", null]).members, [4]);
  assert.equal(pendingPrWriteTarget(["4"]).members, null);
  assert.equal(pendingPrWriteTarget({ pullRequests: [] }).members, null);
  assert.equal(pendingPrWriteTarget({ pullRequests: "4" }).members, null);
});

test("a stack create holds the offer of every PR it names, and no other", () => {
  const writes = [write("stack-create", [4, 5])];
  assert.equal(isStackWritePendingFor(writes, 4, "origin"), true);
  assert.equal(isStackWritePendingFor(writes, 5, "upstream"), true);
  assert.equal(isStackWritePendingFor(writes, 6, "origin"), false);
});

test("a stack add holds its PRs, never the PR sharing its stack's number", () => {
  const writes = [write("stack-add", { stackNumber: 3, pullRequests: [8, 9] })];
  assert.equal(isStackWritePendingFor(writes, 8, "origin"), true);
  assert.equal(isStackWritePendingFor(writes, 9, "origin"), true);
  assert.equal(isStackWritePendingFor(writes, 3, "origin"), false);
  assert.equal(isStackWritePendingFor(writes, 10, "origin"), false);
  // Nor is an add a merge: its stack number holds no stack-merge gate.
  assert.equal(isStackMergePendingFor(writes, 3, "origin"), false);
});

test("a null target holds no stack offer", () => {
  const writes = [write("stack-create", [4, 5])];
  assert.equal(isStackWritePendingFor(writes, null, "origin"), false);
});

test("only a stack create or add holds a stack offer", () => {
  const writes = [
    write("stack-dissolve", 4),
    write("merge", { number: 4, lens: "origin", stack: 3 }),
    write("close", { number: 4, pullRequests: [4] }),
  ];
  assert.equal(isStackWritePendingFor(writes, 4, "origin"), false);
});

test("a checkout is its own only for its number in its lens", () => {
  assert.deepEqual(pendingPrWriteTarget({ number: 7, lens: "origin" }), {
    target: 7,
    lens: "origin",
    stack: null,
    members: null,
  });
  const writes = [write("checkout", { number: 7, lens: "origin" })];
  assert.equal(isPendingFor(writes, "checkout", 7, "origin"), true);
  // The same number in the other lens is a different PR.
  assert.equal(isPendingFor(writes, "checkout", 7, "upstream"), false);
  assert.equal(isPendingFor(writes, "checkout", 8, "origin"), false);
  // The repo-wide hold still sees it from any PR.
  assert.equal(pendingWriteOfKind(writes, "checkout")?.target, 7);
});

test("an update-branch holds only its own PR, in its lens", () => {
  const writes = [
    write("update-branch", { number: 7, rebase: false, lens: "upstream" }),
  ];
  assert.equal(isPendingFor(writes, "update-branch", 7, "upstream"), true);
  assert.equal(isPendingFor(writes, "update-branch", 7, "origin"), false);
  assert.equal(isPendingFor(writes, "update-branch", 8, "upstream"), false);
});

test("a resolve merge names its PR but no lens", () => {
  const writes = [
    write("resolve-merge", { number: 7, base: "main", head: "feat" }),
  ];
  assert.equal(isPendingFor(writes, "resolve-merge", 7, "origin"), true);
  assert.equal(isPendingFor(writes, "resolve-merge", 7, "upstream"), true);
  assert.equal(isPendingFor(writes, "resolve-merge", 8, "origin"), false);
});

test("a repo-wide hold finds a pending write of its kind, whatever it targets", () => {
  const writes = [
    write("close", { number: 7, lens: "origin" }),
    write("checkout", { number: 9, lens: "upstream" }),
    write("checkout", { number: 10, lens: "origin" }),
    write("abort-resolve", { worktreePath: "C:/wt" }),
  ];
  assert.equal(pendingWriteOfKind(writes, "checkout")?.target, 9);
  assert.equal(pendingWriteOfKind(writes, "abort-resolve")?.target, null);
  assert.equal(pendingWriteOfKind(writes, "merge"), undefined);
  assert.equal(pendingWriteOfKind([], "checkout"), undefined);
});

test("an abort names no PR, so no per-PR match holds by it", () => {
  const writes = [write("abort-resolve", { worktreePath: "C:/wt" })];
  assert.equal(isPendingFor(writes, "abort-resolve", 7, "origin"), false);
});

test("a local-PR write's key files it apart from the remote PR writes", () => {
  assert.deepEqual(localPrWriteKey("merge", "C:/a"), [
    "local-pr-write",
    "merge",
    "C:/a",
  ]);
  assert.deepEqual(localPrWriteKey("update-from", "C:/a"), [
    "local-pr-write",
    "update-from",
    "C:/a",
  ]);
  assert.deepEqual(LOCAL_PR_WRITES_KEY, ["local-pr-write"]);
  assert.notEqual(LOCAL_PR_WRITES_KEY[0], PR_WRITES_KEY[0]);
});

test("a local merge surfaces the branches its variables name", () => {
  assert.deepEqual(
    pendingLocalPrWrite("merge", {
      base: "main",
      head: "feat",
      message: "m",
      strategy: "squash",
    }),
    { kind: "merge", base: "main", head: "feat" },
  );
});

test("an update-from's head is the branch it writes into", () => {
  assert.deepEqual(
    pendingLocalPrWrite("update-from", { branch: "feat", base: "main" }),
    { kind: "update-from", base: "main", head: "feat" },
  );
  // Each kind reads its own field: a merge carries no `branch`.
  assert.equal(
    pendingLocalPrWrite("merge", { branch: "feat", base: "main" }).head,
    null,
  );
});

test("unreadable local variables name no branches", () => {
  for (const vars of [undefined, null, 7, "feat"]) {
    assert.deepEqual(pendingLocalPrWrite("merge", vars), {
      kind: "merge",
      base: null,
      head: null,
    });
  }
  assert.deepEqual(pendingLocalPrWrite("merge", { base: 1, head: ["x"] }), {
    kind: "merge",
    base: null,
    head: null,
  });
});

test("only writes keyed to this repo are read; a foreign repo's never match", () => {
  const entries = [
    {
      key: prWriteKey("checkout", "C:/a"),
      vars: { number: 9, lens: "origin" },
    },
    {
      key: prWriteKey("checkout", "C:/b"),
      vars: { number: 10, lens: "origin" },
    },
    { key: ["pr-write"], vars: 11 },
    { key: undefined, vars: 12 },
  ];
  const writes = pendingWritesFor(entries, "C:/a", readPendingPrWrite);
  assert.equal(writes.length, 1);
  assert.equal(isPendingFor(writes, "checkout", 9, "origin"), true);
  assert.equal(isPendingFor(writes, "checkout", 10, "origin"), false);
});

test("a foreign repo's local merge never holds this repo's view", () => {
  const entries = [
    {
      key: localPrWriteKey("merge", "C:/b"),
      vars: { base: "main", head: "feat" },
    },
  ];
  const writes = pendingWritesFor(entries, "C:/a", readPendingLocalPrWrite);
  assert.equal(pendingWriteOfKind(writes, "merge"), undefined);
  const own = pendingWritesFor(entries, "C:/b", readPendingLocalPrWrite);
  assert.equal(pendingWriteOfKind(own, "merge")?.head, "feat");
});
