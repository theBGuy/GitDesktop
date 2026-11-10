// Pins the write kinds of a local PR's conflict-resolving update: their mutation keys,
// how their variables name the branches, and that no update kind reads as one of the
// into-base or "Update from…" kinds a hold keys on. A wrong answer never errors: the
// hold silently drops, so each kind's variables shape is a case.
//
// Imports `pr-writes.ts` straight from `src/` through Node's type stripping, as
// scripts/pr-writes.test.mjs does; that module may import types only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  localPrWriteKey,
  pendingLocalPrWrite,
  pendingWriteOfKind,
  readPendingLocalPrWrite,
} from "../src/lib/git/queries/pr-writes.ts";

const UPDATE_KINDS = ["update-resolve", "finish-update", "discard-update"];

test("each update kind keys as [local-pr-write, kind, repo]", () => {
  for (const kind of UPDATE_KINDS)
    assert.deepEqual(localPrWriteKey(kind, "C:/repo"), [
      "local-pr-write",
      kind,
      "C:/repo",
    ]);
});

test("a start's variables name its base and head", () => {
  assert.deepEqual(
    pendingLocalPrWrite("update-resolve", {
      id: "pr-1",
      base: "main",
      head: "feat",
    }),
    { kind: "update-resolve", base: "main", head: "feat" },
  );
});

test("a finish's variables name its base and head", () => {
  assert.deepEqual(
    pendingLocalPrWrite("finish-update", {
      id: "pr-1",
      base: "main",
      head: "feat",
      worktreePath: "C:/wt/gd-resolve-0123456789ab",
      worktreeId: "0123456789ab",
      opId: "op-1",
      journalRepo: "C:/repo",
    }),
    { kind: "finish-update", base: "main", head: "feat" },
  );
});

test("a discard names its head and no base", () => {
  assert.deepEqual(
    pendingLocalPrWrite("discard-update", { id: "pr-1", head: "feat" }),
    { kind: "discard-update", base: null, head: "feat" },
  );
  assert.deepEqual(
    readPendingLocalPrWrite("discard-update", { id: null, head: 7 }),
    { kind: "discard-update", base: null, head: null },
  );
});

test("a pending update kind is never read as another local-PR kind", () => {
  const writes = UPDATE_KINDS.map((kind) =>
    readPendingLocalPrWrite(kind, { id: "pr-1", base: "main", head: "feat" }),
  );
  for (const other of ["finish-merge", "update-from", "merge", "abort-merge"])
    assert.equal(pendingWriteOfKind(writes, other), undefined, other);
  assert.equal(pendingWriteOfKind(writes, "finish-update")?.head, "feat");
  // Negative control: the same lookup finds the kind when it is pending.
  assert.equal(
    pendingWriteOfKind(
      [readPendingLocalPrWrite("finish-merge", { base: "main" })],
      "finish-merge",
    )?.base,
    "main",
  );
});
