// Pins the cache-shape helpers behind a Projects-board reposition: reading where a
// card sits, splicing it, re-asserting GitHub's answered order, and judging a
// write that reported failure. The bugs these guard against are silent — a wrong
// predecessor writes an afterId GitHub rejects, a lingering duplicate leaves the
// board drawing a stale slot — so each is a case.
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
  failedRepositionTarget,
  insertBoardCardAfter,
  nextChaseTarget,
  pickWatchLens,
  REORDER_CHASE_LIMIT,
  REPOSITION_SETTLE_SLACK_MS,
  rechunkPages,
  reorderBoardItem,
  repositionFailure,
  repositionRestoreTarget,
  repositionVerdict,
  resolveUndoAnchor,
  routeRepositionPress,
  staleRepositionPress,
  stepRepositionWatch,
  watchReposition,
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

// ------------------------------------------------------- repositionVerdict

// GitHub's position endpoint can answer an error WHILE COMMITTING the write, so a
// reposition that reported failure is judged by a read of the board. Only a read
// STARTED past the replica window decides, either way.

test("repositionVerdict: a settled read with the card at the target means it committed", () => {
  const data = pagesOf([mk("a"), mk("c"), mk("b")]);
  assert.equal(repositionVerdict(data, "c", "a", true), "committed");
});

test("repositionVerdict: a hit inside the replica window proves nothing yet", () => {
  // c moved away from a, then a move back to after a failed. A lagged read still
  // serving the order from before the first move shows c after a: a hit the
  // failed write never made.
  const data = pagesOf([mk("a"), mk("c"), mk("b")]);
  assert.equal(repositionVerdict(data, "c", "a", false), "pending");
});

test("repositionVerdict: a null target is the top of the board, a real answer", () => {
  const data = pagesOf([mk("c"), mk("a"), mk("b")]);
  assert.equal(repositionVerdict(data, "c", null, true), "committed");
  assert.equal(repositionVerdict(data, "c", null, false), "pending");
  // Not at the top: a miss, never confused with "no anchor".
  const moved = pagesOf([mk("a"), mk("c"), mk("b")]);
  assert.equal(repositionVerdict(moved, "c", null, true), "failed");
});

test("repositionVerdict: the target is read past archived cards, as the write anchors", () => {
  // The write anchored on a (it can't name the archived z); a card sitting right
  // after z is at that target.
  const data = pagesOf([mk("a"), mk("z", true), mk("c"), mk("b")]);
  assert.equal(repositionVerdict(data, "c", "a", true), "committed");
});

test("repositionVerdict: a miss inside the replica window proves nothing yet", () => {
  // Card still at its pre-write place: the read may predate the commit.
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  assert.equal(repositionVerdict(data, "c", "a", false), "pending");
});

test("repositionVerdict: a miss past the replica window is a real failure", () => {
  const data = pagesOf([mk("a"), mk("b"), mk("c")]);
  assert.equal(repositionVerdict(data, "c", "a", true), "failed");
});

test("repositionVerdict: a lens that doesn't draw the card can't vouch for the write", () => {
  // Undefined anchor — the card is filtered out, or past the loaded pages.
  const data = pagesOf([mk("a"), mk("b")]);
  assert.equal(repositionVerdict(data, "c", "a", false), "pending");
  assert.equal(repositionVerdict(data, "c", "a", true), "failed");
  assert.equal(repositionVerdict(undefined, "c", null, true), "failed");
});

test("boardItemPredecessor (positionable) walks a whole RUN of archived cards", () => {
  const data = pagesOf(
    [mk("a"), mk("z", true), mk("y", true)],
    [mk("x", true), mk("b")],
  );
  assert.equal(boardItemPredecessor(data, "b", true), "a");
  // A run reaching the head of the board is no anchor at all.
  const head = pagesOf([mk("z", true), mk("y", true), mk("x", true), mk("b")]);
  assert.equal(boardItemPredecessor(head, "b", true), null);
});

// Probe 3 (measured 2026-09-26 with archived-inclusive reads): GitHub places a
// moved card right after its afterId, at the front for null, and every archived
// item keeps its slot relative to everything else. The optimistic splice has to
// be exactly that, or the board draws an order the server never settles on.
test("reorderBoardItem matches the server's measured placement around an archived card", () => {
  const board = () => pagesOf([mk("A"), mk("Z", true), mk("B"), mk("C")]);
  assert.deepEqual(ids(reorderBoardItem(board(), "C", "A")), [
    "A",
    "C",
    "Z",
    "B",
  ]);
  assert.deepEqual(ids(reorderBoardItem(board(), "C", null)), [
    "C",
    "A",
    "Z",
    "B",
  ]);
});

// ------------------------------------------------- failedRepositionTarget

test("failedRepositionTarget prefers the newest folded target, null included", () => {
  assert.equal(failedRepositionTarget(undefined, "a"), "a");
  assert.equal(failedRepositionTarget("b", "a"), "b");
  // A folded press to the TOP is a real target, never "nothing folded".
  assert.equal(failedRepositionTarget(null, "a"), null);
  assert.equal(failedRepositionTarget(undefined, null), null);
});

// ---------------------------------------------------- stepRepositionWatch

const LAG = 8_000;
/** A watch begun at t=0 for card c, whose failed write targeted after a. */
const watch0 = () => watchReposition("c", "a", 0, LAG);
const atTarget = pagesOf([mk("a"), mk("c"), mk("b")]);
const offTarget = pagesOf([mk("a"), mk("b"), mk("c")]);
const read = (data, extra = {}) => ({
  type: "success",
  manual: false,
  fetchMore: false,
  data,
  ...extra,
});
/** Feeds `events` in order; the last step, or the first that ends the watch —
 *  the whole step, so a report's `restore` is visible to the assertions. */
const run = (...events) => {
  let watch = watch0();
  let step = { kind: "wait", watch };
  for (const event of events) {
    step = stepRepositionWatch(watch, event);
    if (step.kind !== "wait") return step;
    watch = step.watch;
  }
  return step;
};
const SETTLED = LAG; // a fetch started here is past the window
/** A report that puts the card back, and one that leaves the cache alone. */
const RESTORE = { kind: "report", restore: true };
const NO_RESTORE = { kind: "report", restore: false };
const SILENT = { kind: "silent" };

test("stepRepositionWatch: the gate sits a clock-slack short of the replica window", () => {
  assert.equal(watch0().settledAt, LAG - REPOSITION_SETTLE_SLACK_MS);
  assert.ok(
    REPOSITION_SETTLE_SLACK_MS > 0 && REPOSITION_SETTLE_SLACK_MS < 1_000,
  );
  // A read the recovery timer starts a coarsened tick early still counts.
  assert.deepEqual(run({ type: "fetch", at: LAG - 1 }, read(atTarget)), SILENT);
  // The gate is inclusive: a start exactly on it decides, a tick before it doesn't.
  const gate = watch0().settledAt;
  assert.deepEqual(run({ type: "fetch", at: gate }, read(atTarget)), SILENT);
  assert.equal(
    run({ type: "fetch", at: gate - 1 }, read(atTarget)).kind,
    "wait",
  );
});

test("stepRepositionWatch: a read started past the window decides both ways", () => {
  assert.deepEqual(run({ type: "fetch", at: SETTLED }, read(atTarget)), SILENT);
  // The deciding read already drew GitHub's order, so nothing is put back over it.
  assert.deepEqual(
    run({ type: "fetch", at: SETTLED }, read(offTarget)),
    NO_RESTORE,
  );
});

test("stepRepositionWatch: settledness is the FETCH START, not when the read lands", () => {
  // Started inside the window: whatever it shows and however late it lands (the
  // stamp is all the step sees), it decides nothing.
  assert.equal(run({ type: "fetch", at: 1_000 }, read(offTarget)).kind, "wait");
  assert.equal(run({ type: "fetch", at: 1_000 }, read(atTarget)).kind, "wait");
  // A read already running when the watch began never stamped a start.
  assert.equal(run(read(offTarget)).kind, "wait");
});

test("stepRepositionWatch: a landed read's stamp is spent, so the next needs its own", () => {
  // The first read started early and landed; a second success with no fetch event
  // of its own must not borrow a later stamp it never had.
  assert.equal(
    run({ type: "fetch", at: 1_000 }, read(offTarget), read(offTarget)).kind,
    "wait",
  );
  // ...and a later settled start decides as usual.
  assert.deepEqual(
    run(
      { type: "fetch", at: 1_000 },
      read(offTarget),
      { type: "fetch", at: SETTLED },
      read(offTarget),
    ),
    NO_RESTORE,
  );
});

test("stepRepositionWatch: optimistic patches and Load more appends are skipped", () => {
  const settledStart = { type: "fetch", at: SETTLED };
  assert.equal(
    run(settledStart, read(offTarget, { manual: true })).kind,
    "wait",
  );
  assert.equal(
    run(settledStart, read(offTarget, { fetchMore: true })).kind,
    "wait",
  );
  // Skipping keeps the stamp: the real read after them still decides.
  assert.deepEqual(
    run(settledStart, read(atTarget, { manual: true }), read(offTarget)),
    NO_RESTORE,
  );
});

test("stepRepositionWatch: every way no read can decide reports and puts the card back", () => {
  // Nothing drew GitHub's order over the held place, so the report restores.
  assert.deepEqual(run({ type: "error" }), RESTORE);
  assert.deepEqual(run({ type: "bound" }), RESTORE);
  assert.deepEqual(run({ type: "inactive" }), RESTORE);
  // A read already underway changes none of them.
  assert.deepEqual(
    run({ type: "fetch", at: SETTLED }, { type: "error" }),
    RESTORE,
  );
  assert.deepEqual(
    run({ type: "fetch", at: SETTLED }, { type: "inactive" }),
    RESTORE,
  );
});

test("stepRepositionWatch: a contested report leaves the card where the contester planned it", () => {
  assert.deepEqual(run({ type: "contested" }), NO_RESTORE);
  assert.deepEqual(
    run({ type: "fetch", at: SETTLED }, { type: "contested" }),
    NO_RESTORE,
  );
});

test("stepRepositionWatch: the bound waits once for a deciding read in flight", () => {
  const settledStart = { type: "fetch", at: SETTLED };
  // Waiting arm: a read started past the window is still running.
  const waited = run(settledStart, { type: "bound" });
  assert.equal(waited.kind, "wait");
  assert.equal(waited.watch.boundExtended, true);
  // That read landing inside the grace decides as any deciding read does.
  assert.deepEqual(
    run(settledStart, { type: "bound" }, read(atTarget)),
    SILENT,
  );
  assert.deepEqual(
    run(settledStart, { type: "bound" }, read(offTarget)),
    NO_RESTORE,
  );
  // Terminal arm: the second bound reports, however the read stands.
  assert.deepEqual(
    run(settledStart, { type: "bound" }, { type: "bound" }),
    RESTORE,
  );
  // A read started INSIDE the window can't decide, so it earns no wait.
  assert.deepEqual(
    run({ type: "fetch", at: 1_000 }, { type: "bound" }),
    RESTORE,
  );
  // An early read that landed spent its stamp: nothing is in flight to wait for.
  assert.deepEqual(
    run({ type: "fetch", at: 1_000 }, read(offTarget), { type: "bound" }),
    RESTORE,
  );
  // A skipped optimistic patch keeps the stamp, so the read it rode is still owed.
  assert.equal(
    run(settledStart, read(offTarget, { manual: true }), { type: "bound" })
      .kind,
    "wait",
  );
  // The one wait survives a NEW deciding read starting inside the grace: the
  // second bound still reports.
  assert.deepEqual(
    run(
      settledStart,
      { type: "bound" },
      { type: "fetch", at: SETTLED + 1 },
      { type: "bound" },
    ),
    RESTORE,
  );
});

/** A move to a lens whose read the watch didn't see start. */
const MOVED_UNSTAMPED = { type: "retarget", fetchStartedAt: undefined };

test("stepRepositionWatch: moving to another lens drops the old lens's stamp only", () => {
  const moved = run({ type: "fetch", at: SETTLED }, MOVED_UNSTAMPED);
  assert.equal(moved.kind, "wait");
  assert.equal(moved.watch.fetchStartedAt, undefined);
  assert.equal(moved.watch.settledAt, watch0().settledAt);
  // The old lens's read no longer decides, so a read landing unstamped waits...
  assert.equal(
    run({ type: "fetch", at: SETTLED }, MOVED_UNSTAMPED, read(offTarget)).kind,
    "wait",
  );
  // ...while the new lens's own settled read does.
  assert.deepEqual(
    run(
      { type: "fetch", at: SETTLED },
      MOVED_UNSTAMPED,
      { type: "fetch", at: SETTLED },
      read(atTarget),
    ),
    SILENT,
  );
  // The bound's single wait is spent across a move, not granted again.
  assert.deepEqual(
    run(
      { type: "fetch", at: SETTLED },
      { type: "bound" },
      MOVED_UNSTAMPED,
      { type: "fetch", at: SETTLED },
      { type: "bound" },
    ),
    RESTORE,
  );
  // With no stamp after the move, the bound has nothing to wait for.
  assert.deepEqual(
    run({ type: "fetch", at: SETTLED }, MOVED_UNSTAMPED, { type: "bound" }),
    RESTORE,
  );
});

test("stepRepositionWatch: a move carries the new lens's own read in flight", () => {
  // The view switch started the new lens's read past the window, before the
  // watch moved: that read landing decides, both ways.
  const carried = { type: "retarget", fetchStartedAt: SETTLED };
  assert.equal(run(carried).watch.fetchStartedAt, SETTLED);
  assert.deepEqual(run(carried, read(atTarget)), SILENT);
  assert.deepEqual(run(carried, read(offTarget)), NO_RESTORE);
  // It replaces the old lens's stamp, whichever way that one leaned.
  assert.deepEqual(
    run({ type: "fetch", at: 1_000 }, carried, read(atTarget)),
    SILENT,
  );
  // A carried start INSIDE the window decides nothing, like any other.
  const early = { type: "retarget", fetchStartedAt: 1_000 };
  assert.equal(
    run({ type: "fetch", at: SETTLED }, early, read(atTarget)).kind,
    "wait",
  );
  // The bound waits for a carried deciding read the way it waits for its own.
  assert.equal(run(carried, { type: "bound" }).kind, "wait");
});

test("stepRepositionWatch: the same card moved again releases the report silently", () => {
  assert.deepEqual(run({ type: "superseded" }), SILENT);
  assert.deepEqual(
    run({ type: "fetch", at: 1_000 }, { type: "superseded" }),
    SILENT,
  );
  // Also inside the bound's grace.
  assert.deepEqual(
    run(
      { type: "fetch", at: SETTLED },
      { type: "bound" },
      { type: "superseded" },
    ),
    SILENT,
  );
});

// ---------------------------------------------------------- nextChaseTarget

const KEY_A = ["repo", "r", "project-items", "p", null, false, false];
const KEY_B = ["repo", "r", "project-items", "p", "status:done", false, false];

test("nextChaseTarget: no press waiting is convergence, and consumes nothing", () => {
  assert.deepEqual(nextChaseTarget(undefined, "a", 8), {
    action: "converge",
    consumed: false,
  });
  // Even with no rounds left: an empty slot never exhausts a burst.
  assert.deepEqual(nextChaseTarget(undefined, null, 0), {
    action: "converge",
    consumed: false,
  });
});

test("nextChaseTarget: a waiting press at the target just written converges and is spent", () => {
  assert.deepEqual(nextChaseTarget({ afterId: "a", key: KEY_B }, "a", 8), {
    action: "converge",
    consumed: true,
  });
  // The top of the board is a real target, never "nothing waiting".
  assert.deepEqual(nextChaseTarget({ afterId: null, key: KEY_A }, null, 0), {
    action: "converge",
    consumed: true,
  });
});

test("nextChaseTarget: a waiting press elsewhere is written next, with its own lens", () => {
  assert.deepEqual(nextChaseTarget({ afterId: "b", key: KEY_B }, "a", 1), {
    action: "write",
    afterId: "b",
    key: KEY_B,
    consumed: true,
  });
  assert.deepEqual(nextChaseTarget({ afterId: null, key: KEY_A }, "a", 8), {
    action: "write",
    afterId: null,
    key: KEY_A,
    consumed: true,
  });
});

test("nextChaseTarget: out of rounds, a differing press ends the burst short and is spent", () => {
  assert.deepEqual(nextChaseTarget({ afterId: "b", key: KEY_A }, "a", 0), {
    action: "exhaust",
    consumed: true,
  });
});

/**
 * The live write's loop, driven through the real step over a slot map the way the
 * hook drives it: `presses[i]` are the folds landing while write `i` is in flight
 * (write 0 is the initial one). Returns what was written and how it ended.
 */
function chase(presses, limit = REORDER_CHASE_LIMIT) {
  const slots = new Map();
  const written = ["start"];
  let consumed = 0;
  let afterId = "start";
  const fold = (press) => slots.set("card", press);
  for (const press of presses[0] ?? []) fold(press);
  for (let round = 0; ; round += 1) {
    const step = nextChaseTarget(slots.get("card"), afterId, limit - round);
    if (step.consumed) {
      slots.delete("card");
      consumed += 1;
    }
    if (step.action !== "write")
      return { written, end: step.action, consumed, left: slots.size };
    afterId = step.afterId;
    written.push(afterId);
    for (const press of presses[round + 1] ?? []) fold(press);
  }
}

test("nextChaseTarget: folded presses — the newest wins, and each is sent at most once", () => {
  // Three presses fold during the initial write: only the newest is sent.
  const pressA = { afterId: "x", key: KEY_A };
  const pressB = { afterId: "y", key: KEY_B };
  const pressC = { afterId: "z", key: KEY_B };
  assert.deepEqual(chase([[pressA, pressB, pressC]]), {
    written: ["start", "z"],
    end: "converge",
    consumed: 1,
    left: 0,
  });
  // Nothing folds: the initial write converges on the spot with nothing spent.
  assert.deepEqual(chase([]), {
    written: ["start"],
    end: "converge",
    consumed: 0,
    left: 0,
  });
  // A press back to the target just written converges without another write.
  assert.deepEqual(chase([[pressA], [{ afterId: "x", key: KEY_B }]]), {
    written: ["start", "x"],
    end: "converge",
    consumed: 2,
    left: 0,
  });
});

test("nextChaseTarget: the chase budget counts writes, never reset by a new press", () => {
  // The budget the hook spends, pinned: a long key-hold must be able to run out.
  assert.equal(REORDER_CHASE_LIMIT, 8);
  // A press lands during every write, each to a new target: the budget's worth of
  // follow-ups, then the next press is spent unsent and the burst ends short.
  const presses = Array.from({ length: REORDER_CHASE_LIMIT + 2 }, (_, i) => [
    { afterId: `t${i}`, key: i % 2 === 0 ? KEY_A : KEY_B },
  ]);
  const ended = chase(presses);
  assert.equal(ended.end, "exhaust");
  assert.deepEqual(
    ended.written.slice(1),
    Array.from({ length: REORDER_CHASE_LIMIT }, (_, i) => `t${i}`),
  );
  // One more decision than writes saw a press, and the slot is left empty for
  // the next burst.
  assert.equal(ended.consumed, REORDER_CHASE_LIMIT + 1);
  assert.equal(ended.left, 0);
  // The last round agreeing still converges, even with the budget spent.
  const caughtUp = presses.slice(0, REORDER_CHASE_LIMIT);
  caughtUp.push([{ afterId: `t${REORDER_CHASE_LIMIT - 1}`, key: KEY_A }]);
  assert.equal(chase(caughtUp).end, "converge");
});

// ------------------------------------------------ press order (stale presses)

test("staleRepositionPress: only a press older than the card's newest is stale", () => {
  assert.equal(staleRepositionPress(2, 1), true);
  assert.equal(staleRepositionPress(2, 2), false);
  // Nothing newer recorded: never stale.
  assert.equal(staleRepositionPress(undefined, 1), false);
  assert.equal(staleRepositionPress(1, 2), false);
});

test("routeRepositionPress: a stale press is dropped whether or not a write is in flight", () => {
  assert.equal(routeRepositionPress(2, 1, true), "drop");
  assert.equal(routeRepositionPress(2, 1, false), "drop");
  // The newest press folds into a live write, or runs its own.
  assert.equal(routeRepositionPress(2, 2, true), "fold");
  assert.equal(routeRepositionPress(2, 2, false), "run");
  assert.equal(routeRepositionPress(undefined, 1, false), "run");
});

test("routeRepositionPress: presses that overtake each other still land the newest target", () => {
  // Press 1 (to "old") and press 2 (to "new") on one card; press 2's cancel
  // finishes first, so it reaches its write first. Driven the way the hook
  // drives the route and the waiting slot.
  const newest = 2;
  const slots = new Map();
  let live = null;
  const arrive = (press, target) => {
    const route = routeRepositionPress(newest, press, live !== null);
    if (route === "fold") slots.set("card", { afterId: target, key: KEY_A });
    if (route === "run") live = target;
    return route;
  };
  assert.equal(arrive(2, "new"), "run");
  // The overtaken press arrives while press 2 is writing: dropped, and it never
  // reaches the slot the chase would send next.
  assert.equal(arrive(1, "old"), "drop");
  assert.equal(slots.size, 0);
  assert.deepEqual(nextChaseTarget(slots.get("card"), live, 8), {
    action: "converge",
    consumed: false,
  });
  // Arriving after press 2's write finished, it still can't start one of its own.
  live = null;
  assert.equal(arrive(1, "old"), "drop");
  assert.equal(live, null);
});

// ---------------------------------------------------------- repositionFailure

test("repositionFailure: a press still waiting names both the target and the lens", () => {
  // Nothing landed yet (the initial write failed) and a lens-B press is waiting.
  assert.deepEqual(
    repositionFailure({ afterId: "b", key: KEY_B }, null, "a", undefined),
    { afterId: "b", watchKey: KEY_B, landedAfterId: undefined },
  );
  // A waiting press wins over the lens of the target just written, too.
  assert.deepEqual(
    repositionFailure({ afterId: null, key: KEY_A }, KEY_B, "a", "x"),
    { afterId: null, watchKey: KEY_A, landedAfterId: "x" },
  );
});

test("repositionFailure: with the slot consumed, the tried target goes with ITS lens", () => {
  // The chase already sent lens B's press, and that write failed: judged on B.
  assert.deepEqual(repositionFailure(undefined, KEY_B, "b", "a"), {
    afterId: "b",
    watchKey: KEY_B,
    landedAfterId: "a",
  });
  // The burst's own target, never chased elsewhere: its own lens (null).
  assert.deepEqual(repositionFailure(undefined, null, "a", undefined), {
    afterId: "a",
    watchKey: null,
    landedAfterId: undefined,
  });
  // A landing at the top of the board is carried as null, not dropped.
  assert.equal(
    repositionFailure(undefined, null, "a", null).landedAfterId,
    null,
  );
});

// ---------------------------------------------------------- pickWatchLens

test("pickWatchLens: the first active lens in preference order that draws the card", () => {
  const draws = pagesOf([mk("a"), mk("c")]);
  const hides = pagesOf([mk("a"), mk("b")]);
  const lens = (name, active, data) => ({ name, active, data });
  const pick = (...lenses) => pickWatchLens(lenses, "c", "a")?.name;
  // Preference order holds among eligible lenses.
  assert.equal(
    pick(lens("pressed", true, draws), lens("own", true, draws)),
    "pressed",
  );
  // An inactive lens is skipped, however well it draws the card.
  assert.equal(
    pick(lens("pressed", false, draws), lens("own", true, draws)),
    "own",
  );
  // A lens filtering the card out would judge a landed move failed: skipped.
  assert.equal(
    pick(lens("pressed", true, hides), lens("other", true, draws)),
    "other",
  );
  // A lens with nothing cached yet can't say it draws the card.
  assert.equal(pick(lens("loading", true, undefined)), undefined);
  // Nothing eligible: no lens to judge on.
  assert.equal(
    pick(lens("a", false, draws), lens("b", true, hides)),
    undefined,
  );
  assert.equal(pick(), undefined);
});

test("pickWatchLens: the lens must draw the anchor the move is judged against too", () => {
  const lens = (name, data) => ({ name, active: true, data });
  const pick = (anchorId, ...lenses) =>
    pickWatchLens(lenses, "c", anchorId)?.name;
  // Draws the card but filters its anchor out: a landed move would read failed.
  const hidesAnchor = lens("hides", pagesOf([mk("b"), mk("c")]));
  const drawsAnchor = lens("draws", pagesOf([mk("a"), mk("b"), mk("c")]));
  assert.equal(pick("a", hidesAnchor, drawsAnchor), "draws");
  assert.equal(pick("a", hidesAnchor), undefined);
  // An anchor present only as an archived copy can't be read back as one.
  assert.equal(
    pick("a", lens("archived", pagesOf([mk("a", true), mk("c")]))),
    undefined,
  );
  // A top-of-board target needs no anchor: the card leads every lens drawing it.
  assert.equal(pick(null, hidesAnchor, drawsAnchor), "hides");
  // The card is still required, whatever the anchor.
  assert.equal(pick(null, lens("no-card", pagesOf([mk("a")]))), undefined);
});

// ------------------------------------------------- repositionRestoreTarget

test("repositionRestoreTarget: back to the last write that landed, never past it", () => {
  // A landed write stuck: the pre-burst place would be a position GitHub never
  // holds now.
  assert.equal(repositionRestoreTarget("landed", "before"), "landed");
  // Landing at the top is a real landing, not "nothing landed".
  assert.equal(repositionRestoreTarget(null, "before"), null);
  assert.equal(repositionRestoreTarget(null, undefined), null);
});

test("repositionRestoreTarget: nothing landed goes back to before the burst, or holds", () => {
  assert.equal(repositionRestoreTarget(undefined, "before"), "before");
  assert.equal(repositionRestoreTarget(undefined, null), null);
  // Neither known: no splice, the card holds for the re-read.
  assert.equal(repositionRestoreTarget(undefined, undefined), undefined);
});
