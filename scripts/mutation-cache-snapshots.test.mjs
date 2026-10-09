// Pins the pure projections behind the cache-scan pending-write holds (PR writes,
// review-thread writes, discussion upvotes, board writes): which pending mutations
// a view holds on, and what it reads off each. A wrong answer here never errors —
// a hold silently drops, or crosses into another repo or PR — so each matching
// rule is a case, over fake mutation objects shaped like query-core's.
//
// The imports reach straight into `src/` and rely on Node's default type stripping
// (>= 23.6), which resolves no bundler aliases: both modules may import types only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pendingBoardWritesFor } from "../src/lib/git/queries/board-writes.ts";
import {
  pendingDiscussionUpvoteFor,
  pendingMutationEntries,
  pendingThreadWritesFor,
  pendingWritesFor,
  readPendingPrWrite,
} from "../src/lib/git/queries/pr-writes.ts";

/** A fake cache mutation: what `MutationCache.findAll` hands a snapshot. */
const mutation = (mutationId, mutationKey, variables, isPaused = false) => ({
  mutationId,
  options: { mutationKey },
  state: { variables, isPaused },
});

test("a cache mutation projects to an entry carrying its id, key, vars and pause", () => {
  assert.deepEqual(
    pendingMutationEntries([
      mutation(4, ["pr-write", "merge", "C:/a"], 7, true),
      mutation(9, undefined, undefined),
    ]),
    [
      {
        mutationId: 4,
        key: ["pr-write", "merge", "C:/a"],
        vars: 7,
        paused: true,
      },
      { mutationId: 9, key: undefined, vars: undefined, paused: false },
    ],
  );
});

test("PR writes match their repo by KEY segment, never by variables", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["pr-write", "merge", "C:/a"], { number: 3, repo: "C:/b" }),
    mutation(2, ["pr-write", "merge", "C:/b"], { number: 3, repo: "C:/a" }),
  ]);
  const writes = pendingWritesFor(entries, "C:/a", readPendingPrWrite);
  assert.deepEqual(
    writes.map((w) => w.target),
    [3],
  );
  assert.equal(writes.length, 1);
});

test("board writes match their repo by VARIABLES and pass the mutation id through", () => {
  const entries = pendingMutationEntries([
    // The key carries no repo by design; the variables are the source of truth.
    mutation(11, ["board-write", "convert"], { repo: "C:/a", itemId: "I_1" }),
    mutation(12, ["board-write", "bulk-move"], {
      repo: "C:/a",
      itemIds: ["I_2", "I_3"],
    }),
    mutation(13, ["board-write", "convert"], { repo: "C:/b", itemId: "I_9" }),
    // An unknown key shape degrades to a null kind but still counts.
    mutation(14, ["board-write"], { repo: "C:/a", number: 42 }),
  ]);
  assert.deepEqual(pendingBoardWritesFor(entries, "C:/a"), [
    {
      mutationId: 11,
      kind: "convert",
      itemId: "I_1",
      number: null,
      count: null,
    },
    { mutationId: 12, kind: "bulk-move", itemId: null, number: null, count: 2 },
    { mutationId: 14, kind: null, itemId: null, number: 42, count: null },
  ]);
});

test("thread writes read both keys, filter by number AND lens, and OR the pauses", () => {
  const vars = (number, lens, threadId) => ({ number, lens, threadId });
  const entries = pendingMutationEntries([
    mutation(1, ["thread-reply", "C:/a"], vars(5, "origin", "T1")),
    mutation(2, ["thread-reply", "C:/a"], vars(5, "origin", "T1"), true),
    mutation(3, ["thread-resolve", "C:/a"], vars(5, "origin", "T2")),
    // Other PR, other lens, other repo, unknown kind: none of them hold.
    mutation(4, ["thread-reply", "C:/a"], vars(6, "origin", "T3")),
    mutation(5, ["thread-reply", "C:/a"], vars(5, "upstream", "T4")),
    mutation(6, ["thread-resolve", "C:/b"], vars(5, "origin", "T5")),
    mutation(7, ["thread-edit", "C:/a"], vars(5, "origin", "T6")),
  ]);
  assert.deepEqual(pendingThreadWritesFor(entries, "C:/a", 5, "origin"), {
    reply: { T1: { paused: true } },
    resolve: { T2: { paused: false } },
  });
  assert.deepEqual(pendingThreadWritesFor([], "C:/a", 5, "origin"), {
    reply: {},
    resolve: {},
  });
  // A key prefix that names an Object.prototype member is just an unknown kind.
  for (const prefix of ["constructor", "__proto__", "toString"])
    assert.deepEqual(
      pendingThreadWritesFor(
        pendingMutationEntries([
          mutation(8, [prefix, "C:/a"], vars(5, "origin", "T7")),
        ]),
        "C:/a",
        5,
        "origin",
      ),
      { reply: {}, resolve: {} },
      prefix,
    );
});

test("a discussion upvote holds its own discussion in its own repo", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["toggle-discussion-upvote", "C:/a"], { number: 8 }),
    mutation(2, ["toggle-discussion-upvote", "C:/a"], { number: 8 }, true),
    mutation(3, ["toggle-discussion-upvote", "C:/a"], { number: 9 }, true),
    mutation(4, ["toggle-discussion-upvote", "C:/b"], { number: 8 }, true),
  ]);
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/a", 8), {
    pending: true,
    paused: true,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries.slice(0, 1), "C:/a", 8), {
    pending: true,
    paused: false,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/a", 10), {
    pending: false,
    paused: false,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/c", 8), {
    pending: false,
    paused: false,
  });
});
