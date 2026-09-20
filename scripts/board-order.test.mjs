// Pins the cache-shape helpers behind a Projects-board reposition: reading where a
// card sits, splicing it, and re-asserting GitHub's answered order. The bugs these
// guard against are silent — a wrong predecessor writes an afterId GitHub rejects,
// a lingering duplicate leaves the board drawing a stale slot — so each is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6): stripping ERASES types rather than compiling them and
// resolves no bundler aliases, so `board-order.ts` must stay import-free (types
// only). A runtime import added there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBoardOrder,
  boardItemPredecessor,
  rechunkPages,
  reorderBoardItem,
} from "../src/lib/git/queries/board-order.ts";

/** A board item as the helpers read it: only `itemId` and `isArchived` matter. */
const mk = (itemId, isArchived = false) => ({ itemId, isArchived });

/** An InfiniteData shell whose pages carry the given item arrays, each with its own
 *  metadata so a rechunk can be checked to preserve it. */
const pagesOf = (...itemArrays) => ({
  pageParams: itemArrays.map((_, i) => (i === 0 ? null : `cur${i}`)),
  pages: itemArrays.map((items, i) => ({
    items,
    totalCount: 999,
    truncated: i === itemArrays.length - 1,
    endCursor: `end${i}`,
  })),
});

const ids = (data) => data.pages.flatMap((p) => p.items.map((it) => it.itemId));

// ---------------------------------------------------------------- rechunkPages

test("rechunkPages preserves each page's original length and metadata", () => {
  const a = mk("a");
  const b = mk("b");
  const c = mk("c");
  const d = mk("d");
  const data = pagesOf([a, b], [c, d]);
  // Reversed flat: same count, so both pages stay length 2.
  const out = rechunkPages(data, [d, c, b, a]);
  assert.deepEqual(
    out.pages.map((p) => p.items.length),
    [2, 2],
  );
  assert.deepEqual(ids(out), ["d", "c", "b", "a"]);
  // Metadata rides the page, not its contents.
  assert.equal(out.pages[0].endCursor, "end0");
  assert.equal(out.pages[1].truncated, true);
});

test("rechunkPages reuses the identity of a page whose items didn't move", () => {
  const a = mk("a");
  const b = mk("b");
  const c = mk("c");
  const d = mk("d");
  const data = pagesOf([a, b], [c, d]);
  // Only the second page's items change order; the first is element-wise identical.
  const out = rechunkPages(data, [a, b, d, c]);
  assert.equal(out.pages[0], data.pages[0]);
  assert.notEqual(out.pages[1], data.pages[1]);
});

test("rechunkPages carries a shorter flatten, shrinking the trailing page", () => {
  const a = mk("a");
  const b = mk("b");
  const c = mk("c");
  const data = pagesOf([a, b], [c]);
  // One item removed (a dedup): first page keeps its length, the tail shrinks.
  const out = rechunkPages(data, [a, c]);
  assert.deepEqual(
    out.pages.map((p) => p.items.length),
    [2, 0],
  );
  assert.deepEqual(ids(out), ["a", "c"]);
});

// -------------------------------------------------------------- applyBoardOrder

test("applyBoardOrder bails unchanged when a cached id is absent from the payload", () => {
  const data = pagesOf([mk("a"), mk("b")], [mk("c")]);
  // Payload covers only the first 100; "c" isn't in it, so the whole lens is left be.
  const out = applyBoardOrder(data, { itemIds: ["b", "a"], truncated: true });
  assert.equal(out, data);
});

test("applyBoardOrder reorders the flatten to the payload order when it covers the cache", () => {
  const data = pagesOf([mk("a"), mk("b")], [mk("c")]);
  const out = applyBoardOrder(data, {
    itemIds: ["c", "a", "b"],
    truncated: false,
  });
  assert.deepEqual(ids(out), ["c", "a", "b"]);
  // Page lengths are preserved across the re-sort.
  assert.deepEqual(
    out.pages.map((p) => p.items.length),
    [2, 1],
  );
});

// --------------------------------------------------------- boardItemPredecessor

test("boardItemPredecessor reads the LAST occurrence's predecessor", () => {
  // Two copies of "x": a write-through append then a Load-more page. The board draws
  // the last, so its predecessor is the one before the last copy.
  const data = pagesOf([mk("x"), mk("a")], [mk("b"), mk("x")]);
  assert.equal(boardItemPredecessor(data, "x", false), "b");
});

test("boardItemPredecessor (positionable) skips an archived predecessor", () => {
  const data = pagesOf([mk("a"), mk("z", true), mk("b")]);
  assert.equal(boardItemPredecessor(data, "b", true), "a");
  // The archived-inclusive form takes it as the anchor.
  assert.equal(boardItemPredecessor(data, "b", false), "z");
});

test("boardItemPredecessor skips an ADJACENT own duplicate rather than returning own id", () => {
  // "x" appears twice, adjacently: the naive flat[at-1] would be "x" itself.
  const data = pagesOf([mk("a"), mk("x"), mk("x")]);
  assert.equal(boardItemPredecessor(data, "x", false), "a");
});

test("boardItemPredecessor skips a NON-ADJACENT own duplicate too", () => {
  // The earlier "x" sits mid-list; the scan from the last "x" must pass over it.
  const data = pagesOf([mk("x"), mk("a")], [mk("b"), mk("x")]);
  // Predecessor of the last "x" is "b"; if the scan didn't skip own copies it would
  // still land on "b" here, so also check the degenerate all-own case below.
  assert.equal(boardItemPredecessor(data, "x", false), "b");
  const onlyDupes = pagesOf([mk("x"), mk("x")]);
  // Nothing but own copies precede it — null, never its own id.
  assert.equal(boardItemPredecessor(onlyDupes, "x", false), null);
});

// ------------------------------------------------------------- reorderBoardItem

test("reorderBoardItem splices one card after the anchor", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  const out = reorderBoardItem(data, "c", "a");
  assert.deepEqual(ids(out), ["a", "c", "b"]);
});

test("reorderBoardItem with a null anchor moves the card to the front", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  const out = reorderBoardItem(data, "c", null);
  assert.deepEqual(ids(out), ["c", "a", "b"]);
});

test("reorderBoardItem returns data unchanged when the anchor isn't cached", () => {
  const data = pagesOf([mk("a"), mk("b")]);
  assert.equal(reorderBoardItem(data, "b", "nope"), data);
});

test("reorderBoardItem returns the SAME reference for an already-in-place no-op", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  // "b" already sits right after "a".
  assert.equal(reorderBoardItem(data, "b", "a"), data);
});

test("reorderBoardItem dedupes a duplicate membership, keeping one copy at the target", () => {
  // Two copies of "x" (write-through append + Load-more page). Moving it must leave
  // exactly one, at the intended slot — not a stale earlier copy as the last one.
  const data = pagesOf([mk("x"), mk("a")], [mk("b"), mk("x")]);
  const out = reorderBoardItem(data, "x", "a");
  assert.deepEqual(ids(out), ["a", "x", "b"]);
  assert.equal(ids(out).filter((id) => id === "x").length, 1);
  // And the deduped cache now reads a correct predecessor for the moved card.
  assert.equal(boardItemPredecessor(out, "x", false), "a");
});

test("reorderBoardItem dedupes even when the moved copy lands before the stale one", () => {
  // Moving "x" to the front: the lingering earlier copy would otherwise become the
  // last occurrence (a stale position); dedup collapses to one.
  const data = pagesOf([mk("a"), mk("x")], [mk("x"), mk("b")]);
  const out = reorderBoardItem(data, "x", null);
  assert.deepEqual(ids(out), ["x", "a", "b"]);
  assert.equal(ids(out).filter((id) => id === "x").length, 1);
});
