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
  captureRemovedCard,
  insertBoardCardAfter,
  rechunkPages,
  reorderBoardItem,
  resolveUndoAnchor,
} from "../src/lib/git/queries/board-order.ts";

/** A removal's undo entry for `id`, as the rollback builds it. `counted` is
 *  irrelevant to the anchor walk, so it stays false throughout. */
const planOf = (cap, id) => ({
  mode: "drop",
  key: ["board", "test"],
  itemId: id,
  at: cap,
  counted: false,
});

/** The per-lens batch the walk steps through, by item id. */
const chainOf = (...pairs) =>
  new Map(pairs.map(([cap, id]) => [id, planOf(cap, id)]));

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

test("applyBoardOrder leaves an archived-showing lens alone when the payload omits its archived ids", () => {
  // The both-states lens (View options → Show archived cards) caches archived cards
  // the position payload may never name. The all-or-nothing guard is what makes that
  // safe: the whole lens is left EXACTLY as it is rather than sorted against a list
  // that doesn't describe it, and the stale mark `writeThroughBoards` leaves behind
  // is what reconciles it on the next read.
  const data = pagesOf([mk("a"), mk("z", true), mk("b")]);
  const out = applyBoardOrder(data, { itemIds: ["b", "a"], truncated: false });
  assert.equal(out, data);
  assert.deepEqual(ids(out), ["a", "z", "b"]);
});

test("applyBoardOrder re-asserts over archived cards when the payload names them", () => {
  // The other half of the same guard: a payload that covers the archived-showing
  // lens orders it like any other, archived cards included and still archived.
  const data = pagesOf([mk("a"), mk("z", true)], [mk("b")]);
  const out = applyBoardOrder(data, {
    itemIds: ["b", "z", "a"],
    truncated: false,
  });
  assert.deepEqual(ids(out), ["b", "z", "a"]);
  assert.equal(
    out.pages.flatMap((p) => p.items).find((it) => it.itemId === "z")
      .isArchived,
    true,
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

// ------------------------------------------- removal capture / anchored restore

test("captureRemovedCard records the card, its flat place and what it followed", () => {
  const data = pagesOf([mk("a"), mk("b")], [mk("c"), mk("d")]);
  assert.deepEqual(captureRemovedCard(data, "a"), {
    flatIndex: 0,
    afterId: null,
    item: mk("a"),
  });
  // Across the page boundary: the predecessor is the flattened one, not a
  // per-page one, which is what makes the anchor survive a rechunk.
  assert.deepEqual(captureRemovedCard(data, "c"), {
    flatIndex: 2,
    afterId: "b",
    item: mk("c"),
  });
  assert.equal(captureRemovedCard(data, "gone"), null);
  assert.equal(captureRemovedCard(undefined, "a"), null);
});

test("captureRemovedCard reads the LAST copy and never anchors a card to itself", () => {
  // One membership held twice (a write-through insert plus a later page).
  const data = pagesOf([mk("a"), mk("x")], [mk("x"), mk("b")]);
  assert.deepEqual(captureRemovedCard(data, "x"), {
    flatIndex: 2,
    afterId: "a",
    item: mk("x"),
  });
});

test("insertBoardCardAfter puts a card back after its anchor, or at the head", () => {
  const data = pagesOf([mk("a"), mk("b")], [mk("c")]);
  assert.deepEqual(ids(insertBoardCardAfter(data, mk("x"), "a")), [
    "a",
    "x",
    "b",
    "c",
  ]);
  assert.deepEqual(ids(insertBoardCardAfter(data, mk("x"), null)), [
    "x",
    "a",
    "b",
    "c",
  ]);
  // Anchored to the last card of a page: lands at that page's end, not the next
  // page's start — the pages stay the shape the rest of the cache expects.
  const out = insertBoardCardAfter(data, mk("x"), "b");
  assert.deepEqual(
    out.pages[0].items.map((i) => i.itemId),
    ["a", "b", "x"],
  );
});

test("insertBoardCardAfter never inserts a card the cache already holds", () => {
  const data = pagesOf([mk("a"), mk("b")]);
  assert.deepEqual(ids(insertBoardCardAfter(data, mk("b"), "a")), ["a", "b"]);
});

// The partial-rollback case the anchor shape exists for: a restored card's
// captured slot has been vacated by a SUCCESSFUL sibling removal, so only its
// recorded predecessor still says where it belongs.
test("a partial rollback restores at the anchor, not the stale index", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c"), mk("d")]);
  const capA = captureRemovedCard(data, "a");
  const capB = captureRemovedCard(data, "b");
  // Both removed; only B is refused and comes back.
  let live = pagesOf([mk("c"), mk("d")]);
  // B's anchor was A, which succeeded and is gone, so the walk steps through A to
  // what IT followed — the head of the board.
  const anchor = resolveUndoAnchor(
    live,
    planOf(capB, "b"),
    chainOf([capA, "a"], [capB, "b"]),
  );
  assert.equal(anchor, null);
  live = insertBoardCardAfter(live, capB.item, anchor);
  assert.deepEqual(ids(live), ["b", "c", "d"]);
});

test("an all-failed rollback restores in order and keeps the original sequence", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c"), mk("d")]);
  const caps = ["a", "b"].map((id) => captureRemovedCard(data, id));
  let live = pagesOf([mk("c"), mk("d")]);
  // Original flat order, so A is back before B looks for it.
  for (const cap of caps.toSorted((x, y) => x.flatIndex - y.flatIndex)) {
    live = insertBoardCardAfter(live, cap.item, cap.afterId);
  }
  assert.deepEqual(ids(live), ["a", "b", "c", "d"]);
});

test("a non-adjacent partial rollback anchors to the survivor in front of it", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c"), mk("d")]);
  const capC = captureRemovedCard(data, "c");
  // B and C removed, C refused: its anchor B is gone, and B followed the survivor A.
  const capB = captureRemovedCard(data, "b");
  let live = pagesOf([mk("a"), mk("d")]);
  const anchor = resolveUndoAnchor(
    live,
    planOf(capC, "c"),
    chainOf([capB, "b"], [capC, "c"]),
  );
  assert.equal(anchor, "a");
  live = insertBoardCardAfter(live, capC.item, anchor);
  assert.deepEqual(ids(live), ["a", "c", "d"]);
});

// The board DRAWS the last copy of a duplicated membership (`oneCardPerItem` in
// ProjectsBoardPanel keeps the last occurrence at the flatten point), so a
// rollback's anchor has to be that copy too. Mirrors that dedupe here rather than
// asserting raw pages: the raw order can be right while the rendered one is wrong.
const rendered = (data) => {
  const flat = data.pages.flatMap((p) => p.items);
  const lastAt = new Map();
  flat.forEach((item, i) => lastAt.set(item.itemId, i));
  return flat
    .filter((item, i) => lastAt.get(item.itemId) === i)
    .map((item) => item.itemId);
};

test("insertBoardCardAfter anchors to the anchor's LAST copy across pages", () => {
  // One membership ("x") held twice: a write-through insert plus a later page.
  const data = pagesOf([mk("a"), mk("x")], [mk("x"), mk("c")]);
  const out = insertBoardCardAfter(data, mk("b"), "x");
  // Landing after the FIRST copy would render [a, b, x, c] — b ahead of its own
  // anchor, the one order anchoring was supposed to rule out.
  assert.deepEqual(rendered(out), ["a", "x", "b", "c"]);
  // And it really went into the later page, not the first.
  assert.deepEqual(
    out.pages[1].items.map((i) => i.itemId),
    ["x", "b", "c"],
  );
});

test("insertBoardCardAfter still anchors correctly with no duplicate anchor", () => {
  const data = pagesOf([mk("a"), mk("x")], [mk("c")]);
  const out = insertBoardCardAfter(data, mk("b"), "x");
  assert.deepEqual(rendered(out), ["a", "x", "b", "c"]);
  assert.deepEqual(
    out.pages[0].items.map((i) => i.itemId),
    ["a", "x", "b"],
  );
});

test("a duplicated anchor within ONE page still takes its last copy", () => {
  const data = pagesOf([mk("a"), mk("x"), mk("d"), mk("x")]);
  const out = insertBoardCardAfter(data, mk("b"), "x");
  assert.deepEqual(rendered(out), ["a", "d", "x", "b"]);
});

// ------------------------------------------- round-trip PROPERTY over duplicates

/** Every card of `ids` dropped from every page, the way `dropBoardItem` does it:
 *  a removal takes ALL copies of a membership, not just the drawn one. */
const dropAll = (data, ids) => ({
  ...data,
  pages: data.pages.map((p) => ({
    ...p,
    items: p.items.filter((it) => !ids.has(it.itemId)),
  })),
});

/** Non-empty subsets of `xs`, smallest first — a deterministic sweep rather than
 *  one more hand-picked example. */
const subsets = (xs) => {
  const out = [];
  for (let mask = 1; mask < 1 << xs.length; mask += 1) {
    out.push(xs.filter((_, i) => (mask >> i) & 1));
  }
  return out;
};

/**
 * THE PROPERTY: capture a set, remove it, put every one back (an all-failed
 * rollback) and the board RENDERS exactly what it rendered before. Pages may end
 * up shaped differently — a removal drops duplicate copies a restore does not
 * re-mint — but the drawn sequence is the invariant, which is what the anchors
 * exist to preserve.
 *
 * An all-failed rollback is the case that exercises capture and insert against
 * each other with no walking: every recorded anchor is itself restored, in
 * `flatIndex` order, so each is on the board before its dependent looks for it.
 */
const roundTrips = (label, data) => {
  const before = rendered(data);
  for (const ids of subsets(before)) {
    const gone = new Set(ids);
    const caps = ids
      .map((id) => captureRemovedCard(data, id))
      .toSorted((a, b) => a.flatIndex - b.flatIndex);
    let live = dropAll(data, gone);
    for (const cap of caps) {
      live = insertBoardCardAfter(live, cap.item, cap.afterId);
    }
    assert.deepEqual(
      rendered(live),
      before,
      `${label}: removing {${ids.join(",")}} then restoring all changed the drawn order`,
    );
  }
};

test("round trip preserves the drawn order: duplicate inside one page", () => {
  // The r0d case: raw [x, b, x, c] renders [b, x, c], so b's predecessor is the
  // HEAD, not the leading undrawn copy of x.
  roundTrips("dup-in-page", pagesOf([mk("x"), mk("b"), mk("x"), mk("c")]));
});

test("round trip preserves the drawn order: duplicate across pages", () => {
  roundTrips("dup-cross-page", pagesOf([mk("a"), mk("x")], [mk("x"), mk("c")]));
});

test("round trip preserves the drawn order: adjacent duplicate", () => {
  roundTrips("dup-adjacent", pagesOf([mk("a"), mk("x"), mk("x"), mk("b")]));
});

test("round trip preserves the drawn order: duplicate spanning three pages", () => {
  roundTrips(
    "dup-triple",
    pagesOf([mk("x")], [mk("a"), mk("x"), mk("b")], [mk("x"), mk("c")]),
  );
});

test("round trip preserves the drawn order: no duplicates at all (control)", () => {
  roundTrips("no-dups", pagesOf([mk("a"), mk("b")], [mk("c"), mk("d")]));
});

test("captureRemovedCard reads the DEDUPED predecessor, not the raw one", () => {
  const data = pagesOf([mk("x"), mk("b"), mk("x"), mk("c")]);
  // b is drawn FIRST, so it follows nothing — the leading x is not on screen.
  assert.equal(captureRemovedCard(data, "b").afterId, null);
  // c follows the DRAWN x, which is the later copy.
  assert.equal(captureRemovedCard(data, "c").afterId, "x");
  // x itself is captured at its drawn index, following the drawn b.
  assert.deepEqual(captureRemovedCard(data, "x"), {
    flatIndex: 2,
    afterId: "b",
    item: mk("x"),
  });
});

// ------------------------------------------------- resolveUndoAnchor, directly

test("resolveUndoAnchor falls to the HEAD when the whole chain is gone", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  const capA = captureRemovedCard(data, "a");
  const capB = captureRemovedCard(data, "b");
  const capC = captureRemovedCard(data, "c");
  // Every predecessor of c was removed and none is coming back, so the walk
  // exhausts the chain rather than anchoring to something undrawn.
  const live = pagesOf([]);
  assert.equal(
    resolveUndoAnchor(
      live,
      planOf(capC, "c"),
      chainOf([capA, "a"], [capB, "b"], [capC, "c"]),
    ),
    null,
  );
});

test("resolveUndoAnchor falls to the HEAD when the anchor is neither drawn nor ours", () => {
  const data = pagesOf([mk("ghost"), mk("b")]);
  const capB = captureRemovedCard(data, "b");
  assert.equal(capB.afterId, "ghost");
  // "ghost" left under a concurrent change and is not in this batch, so nothing
  // in the cache still says where it was.
  const live = pagesOf([mk("z")]);
  assert.equal(
    resolveUndoAnchor(live, planOf(capB, "b"), chainOf([capB, "b"])),
    null,
  );
});

test("resolveUndoAnchor refuses to spin on a cyclic chain", () => {
  // A corrupted batch where two entries name each other as predecessor. Neither
  // is drawn, so a walk with no `seen` guard would loop forever.
  const cycle = new Map([
    ["x", planOf({ flatIndex: 0, afterId: "y", item: mk("x") }, "x")],
    ["y", planOf({ flatIndex: 1, afterId: "x", item: mk("y") }, "y")],
  ]);
  assert.equal(resolveUndoAnchor(pagesOf([]), cycle.get("x"), cycle), null);
});

test("resolveUndoAnchor uses a DRAWN anchor as-is, without walking", () => {
  const data = pagesOf([mk("a"), mk("b")]);
  const capB = captureRemovedCard(data, "b");
  // `a` survived, so the walk never starts.
  assert.equal(
    resolveUndoAnchor(
      pagesOf([mk("a")]),
      planOf(capB, "b"),
      chainOf([capB, "b"]),
    ),
    "a",
  );
});

test("resolveUndoAnchor stops at a sibling this rollback already restored", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  const capB = captureRemovedCard(data, "b");
  const capC = captureRemovedCard(data, "c");
  // b and c both failed; restoring in flatIndex order puts b back first, so by
  // the time c resolves its anchor b is drawn again and the walk stops there.
  const live = pagesOf([mk("a"), mk("b")]);
  assert.equal(
    resolveUndoAnchor(
      live,
      planOf(capC, "c"),
      chainOf([capB, "b"], [capC, "c"]),
    ),
    "b",
  );
});
