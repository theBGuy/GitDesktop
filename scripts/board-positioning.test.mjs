// Pins the arithmetic behind moving a Projects-board card inside its column from
// the keyboard. Every case here is a position write that reaches GitHub: an
// afterId derived from the wrong list moves a card somewhere the board never
// showed, and the board has no way to tell the user that happened.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES types
// rather than compiling them and resolves no bundler aliases, so
// `board-positioning.ts` must stay import-free. A runtime import added there fails
// this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import { planReorder } from "../src/features/projects/board-positioning.ts";

// A board whose three columns INTERLEAVE in the project's own order, which is the
// shape that makes a card's global neighbour belong to another column.
const ORDER = ["a1", "b1", "a2", "c1", "b2", "a3", "c2", "b3"];
const COL_A = ["a1", "a2", "a3"];
const COL_B = ["b1", "b2", "b3"];
const COL_C = ["c1", "c2"];

/** One plan off the interleaved board, fully loaded unless a case says otherwise. */
const plan = (column, index, direction, extra = {}) =>
  planReorder({
    order: ORDER,
    column,
    index,
    direction,
    truncated: false,
    ...extra,
  });

// ------------------------------------------------------------------- down

test("down lands after the column's visible successor", () => {
  assert.deepEqual(plan(COL_A, 0, "down"), { kind: "move", afterId: "a2" });
});

test("down one slot from the middle is an adjacent swap", () => {
  assert.deepEqual(plan(COL_A, 1, "down"), { kind: "move", afterId: "a3" });
});

test("down on the column's last card is a no-op once the board is fully loaded", () => {
  assert.deepEqual(plan(COL_A, 2, "down"), { kind: "noop" });
});

test("down on the column's last card is HELD while pages are unloaded", () => {
  assert.deepEqual(plan(COL_A, 2, "down", { truncated: true }), {
    kind: "held",
    reason: "truncated",
  });
});

// --------------------------------------------------------------------- up

test("up to the head of the board lands at the top (null afterId)", () => {
  // a2's visible predecessor is a1, which IS the project's first item.
  assert.deepEqual(plan(COL_A, 1, "up"), { kind: "move", afterId: null });
});

test("up takes the predecessor's own GLOBAL neighbour, which can be another column's card", () => {
  // a3's visible predecessor is a2; a2 sits after b1 in the project's order, so
  // landing above a2 means landing after b1.
  assert.deepEqual(plan(COL_A, 2, "up"), { kind: "move", afterId: "b1" });
});

test("up one slot from the middle is an adjacent swap", () => {
  // b3 above b2: b2's global predecessor is c1.
  assert.deepEqual(plan(COL_B, 2, "up"), { kind: "move", afterId: "c1" });
});

test("up on the column's first card is a no-op", () => {
  assert.deepEqual(plan(COL_A, 0, "up"), { kind: "noop" });
});

// -------------------------------------------------------------------- top

test("to top lands at the board's head when the column's first card IS the board's first", () => {
  assert.deepEqual(plan(COL_A, 2, "top"), { kind: "move", afterId: null });
});

test("to top lands after a GLOBAL predecessor from another column when the column's first card is not the board's", () => {
  // b1 is the column's first card but the project's second item, so landing above
  // it means landing after a1.
  assert.deepEqual(plan(COL_B, 2, "top"), { kind: "move", afterId: "a1" });
});

test("to top on the column's first card is a no-op", () => {
  assert.deepEqual(plan(COL_B, 0, "top"), { kind: "noop" });
});

// ----------------------------------------------------------------- bottom

test("to bottom lands after the column's last visible card", () => {
  assert.deepEqual(plan(COL_A, 0, "bottom"), { kind: "move", afterId: "a3" });
});

test("to bottom on a two-card column lands after the other one", () => {
  assert.deepEqual(plan(COL_C, 0, "bottom"), { kind: "move", afterId: "c2" });
});

test("to bottom on a two-card column's last card is a no-op", () => {
  assert.deepEqual(plan(COL_C, 1, "bottom"), { kind: "noop" });
});

test("to bottom on the column's last card is HELD while pages are unloaded", () => {
  assert.deepEqual(plan(COL_C, 1, "bottom", { truncated: true }), {
    kind: "held",
    reason: "truncated",
  });
});

test("to bottom on a NON-last card is HELD on a truncated board", () => {
  // The true bottom lives past the loaded end, so column[last] would land the card
  // mid-column after Load more — held regardless of the card's index.
  assert.deepEqual(plan(COL_A, 0, "bottom", { truncated: true }), {
    kind: "held",
    reason: "truncated",
  });
});

// ------------------------------------------------------- degenerate columns

test("a single-card column has nowhere to go in any direction", () => {
  for (const direction of ["up", "down", "top", "bottom"]) {
    assert.deepEqual(
      planReorder({
        order: ORDER,
        column: ["a1"],
        index: 0,
        direction,
        truncated: false,
      }),
      { kind: "noop" },
      direction,
    );
  }
});

test("a single-card column still HOLDS downward moves on a truncated board", () => {
  // The one card is the column's last, and the rest of the column may live past
  // the loaded end — the same rule every column-last card takes.
  for (const direction of ["down", "bottom"]) {
    assert.deepEqual(
      planReorder({
        order: ORDER,
        column: ["a1"],
        index: 0,
        direction,
        truncated: true,
      }),
      { kind: "held", reason: "truncated" },
      direction,
    );
  }
});

test("an index the column doesn't hold plans nothing", () => {
  assert.deepEqual(plan(COL_A, 3, "up"), { kind: "noop" });
  assert.deepEqual(plan([], 0, "down"), { kind: "noop" });
});

test("a neighbour the flatten doesn't hold plans nothing rather than guessing", () => {
  // The columns and the flatten disagree — a refetch landed between them. A
  // position written off the stale list would move the card somewhere nothing
  // showed.
  assert.deepEqual(
    planReorder({
      order: ["x1", "x2"],
      column: COL_A,
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "noop" },
  );
});

// ------------------------------------------------------- the ungrouped board

test("an ungrouped board's one column IS the project's order", () => {
  // No grouping field, so every card sits in the single "All items" column and
  // the visible neighbour and the global one are the same card.
  const all = ORDER;
  assert.deepEqual(
    planReorder({
      order: ORDER,
      column: all,
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: null },
  );
  assert.deepEqual(
    planReorder({
      order: ORDER,
      column: all,
      index: 2,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "a1" },
  );
  assert.deepEqual(
    planReorder({
      order: ORDER,
      column: all,
      index: 0,
      direction: "down",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
});

// ------------------------------------------------------- the filtered lens

test("under a filtered lens the plan is exact in the view and approximate in global interleave", () => {
  // The lens loaded only these three; the board's real order has hidden items
  // between them, and those end up BELOW the moved card. The accepted edge.
  const lensOrder = ["b1", "a2", "a3"];
  assert.deepEqual(
    planReorder({
      order: lensOrder,
      column: ["a2", "a3"],
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
  assert.deepEqual(
    planReorder({
      order: lensOrder,
      column: ["a2", "a3"],
      index: 1,
      direction: "top",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
});

// ------------------------------------------------------ archived neighbours

test("an archived neighbour is filtered out of order, so the anchor is one GitHub accepts", () => {
  // GitHub refuses an archived item as a position anchor: updateProjectV2ItemPosition
  // answers VALIDATION, "The item to be positioned after is archived and cannot be
  // used to update the position of this item" (measured 2026-09-19). The caller hands
  // in the POSITIONABLE sequence, which walks the landing back to the nearest live
  // predecessor — the same slot the board draws, archived cards being invisible there.
  const withArchived = ["a1", "b1", "z1", "a2", "a3"];
  const positionable = withArchived.filter((id) => id !== "z1");
  const upFromA3 = (order) =>
    planReorder({
      order,
      column: COL_A,
      index: 2,
      direction: "up",
      truncated: false,
    });
  assert.deepEqual(upFromA3(positionable), { kind: "move", afterId: "b1" });
  // The premise the filter exists for: unfiltered, a2's global predecessor IS the
  // archived card, and that is the anchor the server rejects.
  assert.deepEqual(upFromA3(withArchived), { kind: "move", afterId: "z1" });
});

// ------------------------------------------------- drafts and redacted cards

test("a draft or a redacted neighbour is just an id", () => {
  // Neither carries content the plan reads: a position is a membership fact, and
  // an item the viewer can't see still holds a place in the project's order.
  const order = ["redacted-1", "draft-1", "issue-1"];
  assert.deepEqual(
    planReorder({
      order,
      column: ["draft-1", "issue-1"],
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "redacted-1" },
  );
  assert.deepEqual(
    planReorder({
      order,
      column: ["draft-1", "issue-1"],
      index: 0,
      direction: "down",
      truncated: false,
    }),
    { kind: "move", afterId: "issue-1" },
  );
});
