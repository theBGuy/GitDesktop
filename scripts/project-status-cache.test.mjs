// Pins the cache patches behind the project status update writes: where a
// placeholder, an answer and a rolled-back delete land, and what each does to the
// count. A wrong patch never errors — it just shows the history out of order, or a
// count that drifts from GitHub's until the next read — so each rule is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `project-status-cache.ts`
// may import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dropStatusUpdate,
  insertNewestFirst,
  mayPatchStatusCache,
  prependStatusUpdate,
  replaceStatusUpdate,
} from "../src/lib/git/queries/project-status-cache.ts";

const update = (id, createdAt) => ({
  id,
  body: null,
  status: "ON_TRACK",
  startDate: null,
  targetDate: null,
  creator: null,
  createdAt,
  updatedAt: null,
});

const ids = (updates) => updates.map((u) => u.id);

const cache = (updates, totalCount = updates.length, truncated = false) => ({
  updates,
  totalCount,
  truncated,
});

test("a post before the first read seeds the cache with the placeholder alone", () => {
  const placeholder = update("optimistic:1", "2026-09-24T16:00:00.000Z");
  assert.deepEqual(prependStatusUpdate(undefined, placeholder), {
    updates: [placeholder],
    totalCount: 1,
    truncated: false,
  });
});

test("a post over a read leads it and moves the count, keeping the cap claim", () => {
  const read = cache([update("a", "2026-09-24T15:00:00Z")], 30, true);
  const next = prependStatusUpdate(
    read,
    update("optimistic:2", "2026-09-24T16:00:00Z"),
  );
  assert.deepEqual(ids(next.updates), ["optimistic:2", "a"]);
  assert.equal(next.totalCount, 31);
  assert.equal(next.truncated, true);
});

test("an answer replaces its entry in place, and a missing one changes nothing", () => {
  const read = cache([
    update("optimistic:3", "x"),
    update("a", "2026-09-24T15:00:00Z"),
  ]);
  const real = update("PVTSU_real", "2026-09-24T16:00:00Z");
  assert.deepEqual(
    ids(replaceStatusUpdate(read, "optimistic:3", real).updates),
    ["PVTSU_real", "a"],
  );
  assert.equal(replaceStatusUpdate(read, "gone", real), read);
  assert.equal(replaceStatusUpdate(undefined, "a", real), undefined);
});

test("a drop takes the entry and one from the count, never below zero", () => {
  const read = cache([update("a", "t"), update("b", "t")], 5);
  const next = dropStatusUpdate(read, "a");
  assert.deepEqual(ids(next.updates), ["b"]);
  assert.equal(next.totalCount, 4);
  assert.equal(
    dropStatusUpdate(cache([update("a", "t")], 0), "a").totalCount,
    0,
  );
  // The last entry leaves a valid empty cache for the settle read to refill.
  assert.deepEqual(dropStatusUpdate(cache([update("a", "t")]), "a"), cache([]));
});

test("a drop of an id the cache no longer holds leaves the count alone", () => {
  const read = cache([update("b", "t")], 7);
  assert.equal(dropStatusUpdate(read, "a"), read);
  assert.equal(dropStatusUpdate(read, "a").totalCount, 7);
  assert.equal(dropStatusUpdate(undefined, "a"), undefined);
});

test("a rolled-back delete lands below posts that arrived above its old slot", () => {
  const list = [
    update("optimistic:4", "2026-09-24T16:00:00.123Z"),
    update("newer", "2026-09-24T15:56:42Z"),
    update("older", "2026-09-20T00:00:00Z"),
  ];
  const restored = update("restored", "2026-09-22T00:00:00Z");
  assert.deepEqual(ids(insertNewestFirst(list, restored)), [
    "optimistic:4",
    "newer",
    "restored",
    "older",
  ]);
  assert.deepEqual(
    ids(insertNewestFirst(list, update("oldest", "2026-01-01T00:00:00Z"))),
    ["optimistic:4", "newer", "older", "oldest"],
  );
  assert.deepEqual(
    ids(insertNewestFirst(list, update("newest", "2027-01-01T00:00:00Z"))),
    ["newest", "optimistic:4", "newer", "older"],
  );
  assert.deepEqual(ids(insertNewestFirst([], restored)), ["restored"]);
});

test("unparseable timestamps sort after every readable one", () => {
  const list = [
    update("a", "2026-09-24T15:00:00Z"),
    update("b", "2026-09-20T00:00:00Z"),
  ];
  // An unreadable INSERTED entry goes after the readable ones.
  assert.deepEqual(ids(insertNewestFirst(list, update("bad", "nope"))), [
    "a",
    "b",
    "bad",
  ]);
  // An unreadable EXISTING entry stays below a readable insert.
  const withBad = [update("a", "2026-09-24T15:00:00Z"), update("bad", "nope")];
  assert.deepEqual(
    ids(insertNewestFirst(withBad, update("c", "2026-09-01T00:00:00Z"))),
    ["a", "c", "bad"],
  );
  // A second unreadable one lands above the first — still below every readable one.
  assert.deepEqual(ids(insertNewestFirst(withBad, update("bad2", ""))), [
    "a",
    "bad2",
    "bad",
  ]);
});

test("a post seeds any cache but one a FAILED read left empty", () => {
  // Nothing read yet, or a read still loading: seed, so the post shows at once.
  assert.equal(mayPatchStatusCache(undefined), true);
  assert.equal(
    mayPatchStatusCache({ status: "pending", data: undefined }),
    true,
  );
  assert.equal(
    mayPatchStatusCache({ status: "success", data: cache([]) }),
    true,
  );
  // A refetch that failed over data still holds a real history to patch.
  assert.equal(mayPatchStatusCache({ status: "error", data: cache([]) }), true);
  // A failed read with nothing cached draws no strip; a seed would claim one.
  assert.equal(
    mayPatchStatusCache({ status: "error", data: undefined }),
    false,
  );
});
