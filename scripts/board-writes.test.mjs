// Pins the pure board-write bookkeeping: which paused writes a board settle waits
// on, and how the window-focus invalidation and the mount refetch hold a lens a
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
  holdLens,
  pausedBoardWriteOn,
  projectItemsRepoKey,
  refetchOnMountUnlessHeld,
  releaseLens,
  repoFocusInvalidations,
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

test("with no chase live the focus invalidation is the one plain call", () => {
  assert.deepEqual(repoFocusInvalidations(new Map()), [{ queryKey: ["repo"] }]);
});

test("a chased lens is marked stale without a refetch; every other query refetches", () => {
  const held = new Map([["chased", 1]]);
  const [refetch, markOnly, ...rest] = repoFocusInvalidations(held);
  assert.equal(rest.length, 0);
  const chased = { queryHash: "chased" };
  const sibling = { queryHash: "same-board-other-lens" };
  assert.deepEqual(refetch.queryKey, ["repo"]);
  assert.equal(refetch.refetchType, undefined);
  assert.equal(refetch.predicate(chased), false);
  assert.equal(refetch.predicate(sibling), true);
  assert.deepEqual(markOnly.queryKey, ["repo"]);
  assert.equal(markOnly.refetchType, "none");
  assert.equal(markOnly.predicate(chased), true);
  assert.equal(markOnly.predicate(sibling), false);
});

test("the filters snapshot the held set: a chase ending afterwards changes neither", () => {
  const held = new Map([["chased", 1]]);
  const [refetch, markOnly] = repoFocusInvalidations(held);
  releaseLens(held, "chased");
  assert.equal(refetch.predicate({ queryHash: "chased" }), false);
  assert.equal(markOnly.predicate({ queryHash: "chased" }), true);
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
