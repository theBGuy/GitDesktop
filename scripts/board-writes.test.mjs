// Pins the pure board-write bookkeeping: which paused writes a board settle waits
// on, and how the window-focus refetch and the mount refetch hold a lens a
// date-shift chase is reading. A wrong answer here never errors — a settle
// refetches under a paused write's patch, or a focus or remount read lands
// mid-chase and the chase writes the server's older dates back — so each rule is a
// case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `board-writes.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardWriteVars,
  focusRefetchPredicate,
  focusStaleMarkFilter,
  holdLens,
  pausedBoardWriteOn,
  projectItemsRepoKey,
  refetchOnMountUnlessHeld,
  releaseLens,
} from "../src/lib/git/queries/board-writes.ts";

const mutation = (isPaused, variables) => ({ state: { isPaused, variables } });

test("a paused board write counts for its own repo only", () => {
  assert.equal(
    pausedBoardWriteOn(mutation(true, { repo: "C:/a" }), "C:/a"),
    true,
  );
  assert.equal(
    pausedBoardWriteOn(mutation(true, { repo: "C:/a" }), "C:/b"),
    false,
  );
});

test("a write inside its request, or settling, is not paused and never counts here", () => {
  assert.equal(
    pausedBoardWriteOn(mutation(false, { repo: "C:/a" }), "C:/a"),
    false,
  );
});

test("a paused write whose variables name no repo counts nowhere", () => {
  assert.equal(pausedBoardWriteOn(mutation(true, undefined), "C:/a"), false);
  assert.equal(pausedBoardWriteOn(mutation(true, { repo: 7 }), "C:/a"), false);
  assert.equal(pausedBoardWriteOn(mutation(true, "C:/a"), "C:/a"), false);
});

test("boardWriteVars reads both bulk list spellings and guards every field", () => {
  assert.deepEqual(
    boardWriteVars({
      state: { variables: { repo: "r", itemIds: ["a", "b"] } },
    }),
    { repo: "r", itemId: null, number: null, count: 2 },
  );
  assert.deepEqual(
    boardWriteVars({
      state: { variables: { repo: "r", items: [{}], itemId: "x", number: 4 } },
    }),
    { repo: "r", itemId: "x", number: 4, count: 1 },
  );
  assert.deepEqual(boardWriteVars({ state: { variables: null } }), {
    repo: null,
    itemId: null,
    number: null,
    count: null,
  });
});

test("the board family key stays the repo prefix every lens key extends", () => {
  assert.deepEqual(projectItemsRepoKey("C:/a"), [
    "repo",
    "C:/a",
    "project-items",
  ]);
});

test("a lens stays held until its LAST chase releases it, then leaves the map", () => {
  const held = new Map();
  holdLens(held, "lens-1");
  holdLens(held, "lens-1");
  releaseLens(held, "lens-1");
  assert.equal(held.get("lens-1"), 1);
  releaseLens(held, "lens-1");
  assert.equal(held.has("lens-1"), false);
  assert.equal(held.size, 0);
});

/** A query as the focus predicate reads it: data `age` ms old against `now`, read
 *  through the query's own isStaleByTime the way query-core computes it. */
const focusQuery = ({
  hash = "q",
  status = "success",
  age = 0,
  observers = [{ options: { staleTime: 0 } }],
  data = true,
  now = 1_000_000,
} = {}) => ({
  queryHash: hash,
  state: { status, data: data ? "cached" : undefined },
  observers,
  isStaleByTime(staleTime) {
    if (!data) return true;
    if (staleTime === "static") return false;
    return now - age + staleTime <= now;
  },
});

const none = new Set();

test("focus refetches an active query past its staleTime, never a fresh one", () => {
  const refetch = focusRefetchPredicate(none);
  const minute = [{ options: { staleTime: 60_000 } }];
  assert.equal(refetch(focusQuery({ age: 30_000, observers: minute })), false);
  assert.equal(refetch(focusQuery({ age: 61_000, observers: minute })), true);
  // No staleTime reads as 0, query-core's default: any age is stale.
  assert.equal(
    refetch(focusQuery({ age: 1, observers: [{ options: {} }] })),
    true,
  );
});

test("focus refetches an errored query even inside its staleTime", () => {
  // forge-status keeps last-good data beside the error: only this arm retries it.
  const refetch = focusRefetchPredicate(none);
  const minute = [{ options: { staleTime: 60_000 } }];
  assert.equal(
    refetch(focusQuery({ status: "error", age: 1_000, observers: minute })),
    true,
  );
});

test("an errored Infinity read never replays on focus; one with no data does", () => {
  // An errored deep Actions page set must not replay every page per focus.
  const refetch = focusRefetchPredicate(none);
  for (const staleTime of [Number.POSITIVE_INFINITY, "static"]) {
    const never = [{ options: { staleTime: () => staleTime } }];
    assert.equal(
      refetch(focusQuery({ status: "error", observers: never })),
      false,
      String(staleTime),
    );
    assert.equal(
      refetch(focusQuery({ status: "error", observers: never, data: false })),
      true,
      String(staleTime),
    );
  }
  // A disabled observer's finite staleTime doesn't count.
  const mixed = [
    { options: { enabled: false, staleTime: 0 } },
    { options: { staleTime: Number.POSITIVE_INFINITY } },
  ];
  assert.equal(
    refetch(focusQuery({ status: "error", observers: mixed })),
    false,
  );
});

test("Infinity and static staleTimes are never stale on focus", () => {
  const refetch = focusRefetchPredicate(none);
  for (const staleTime of [Number.POSITIVE_INFINITY, "static"])
    assert.equal(
      refetch(
        focusQuery({ age: 10 ** 9, observers: [{ options: { staleTime } }] }),
      ),
      false,
      String(staleTime),
    );
});

test("function-form staleTime and enabled resolve against the query", () => {
  const refetch = focusRefetchPredicate(none);
  const seen = [];
  const query = focusQuery({
    hash: "fn",
    age: 20_000,
    observers: [
      {
        options: {
          staleTime: (q) => {
            seen.push(q.queryHash);
            return 10_000;
          },
        },
      },
    ],
  });
  assert.equal(refetch(query), true);
  assert.deepEqual(seen, ["fn"]);
  // A function `enabled` answering false drops its observer: only enabled ones count.
  const disabledOnly = focusQuery({
    age: 20_000,
    observers: [{ options: { enabled: () => false, staleTime: 0 } }],
  });
  assert.equal(refetch(disabledOnly), false);
  const mixed = focusQuery({
    age: 20_000,
    observers: [
      { options: { enabled: false, staleTime: 0 } },
      { options: { enabled: () => true, staleTime: 60_000 } },
    ],
  });
  assert.equal(refetch(mixed), false);
});

test("a chased lens is never refetched by focus, only stale-marked", () => {
  const chased = new Set(["chased"]);
  const refetch = focusRefetchPredicate(chased);
  assert.equal(refetch(focusQuery({ hash: "chased", age: 10 ** 9 })), false);
  assert.equal(refetch(focusQuery({ hash: "chased", status: "error" })), false);
  assert.equal(refetch(focusQuery({ hash: "sibling", age: 10 ** 9 })), true);
  const mark = focusStaleMarkFilter(chased);
  assert.deepEqual(mark.queryKey, ["repo"]);
  assert.equal(mark.refetchType, "none");
  assert.equal(mark.predicate({ queryHash: "chased" }), true);
  assert.equal(mark.predicate({ queryHash: "same-board-other-lens" }), false);
});

test("a held lens takes no mount refetch; every other lens keeps the default", () => {
  const held = new Map([["chased", 1]]);
  const refetchOnMount = refetchOnMountUnlessHeld(held);
  assert.equal(refetchOnMount({ queryHash: "chased" }), false);
  assert.equal(refetchOnMount({ queryHash: "same-board-other-lens" }), true);
});

test("the mount predicate reads the held set LIVE, not as of its creation", () => {
  const held = new Map();
  const refetchOnMount = refetchOnMountUnlessHeld(held);
  assert.equal(refetchOnMount({ queryHash: "lens" }), true);
  holdLens(held, "lens");
  assert.equal(refetchOnMount({ queryHash: "lens" }), false);
  releaseLens(held, "lens");
  assert.equal(refetchOnMount({ queryHash: "lens" }), true);
});
