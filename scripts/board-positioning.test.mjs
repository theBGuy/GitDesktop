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

/** Cards as the planner reads them. An id ending in `*` is ARCHIVED (the star is
 *  stripped from the id), so a fixture reads the way the board draws it. */
const cards = (...ids) =>
  ids.map((id) =>
    id.endsWith("*")
      ? { itemId: id.slice(0, -1), isArchived: true }
      : { itemId: id, isArchived: false },
  );

// A board whose three columns INTERLEAVE in the project's own order, which is the
// shape that makes a card's global neighbour belong to another column.
const ORDER_IDS = ["a1", "b1", "a2", "c1", "b2", "a3", "c2", "b3"];
const ORDER = cards(...ORDER_IDS);
const COL_A = cards("a1", "a2", "a3");
const COL_B = cards("b1", "b2", "b3");
const COL_C = cards("c1", "c2");

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
  // The true bottom lives past the loaded end, so the last loaded card would land
  // the card mid-column after Load more — held regardless of the card's index.
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
        column: cards("a1"),
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
        column: cards("a1"),
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
  assert.deepEqual(plan(COL_A, -1, "down"), { kind: "noop" });
  assert.deepEqual(plan([], 0, "down"), { kind: "noop" });
});

test("a neighbour the flatten doesn't hold plans nothing rather than guessing", () => {
  // The columns and the flatten disagree — a refetch landed between them. A
  // position written off the stale list would move the card somewhere nothing
  // showed.
  assert.deepEqual(
    planReorder({
      order: cards("x1", "x2"),
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
  const lensOrder = cards("b1", "a2", "a3");
  assert.deepEqual(
    planReorder({
      order: lensOrder,
      column: cards("a2", "a3"),
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
  assert.deepEqual(
    planReorder({
      order: lensOrder,
      column: cards("a2", "a3"),
      index: 1,
      direction: "top",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
});

// ------------------------------------------------- drafts and redacted cards

test("a draft or a redacted neighbour is just an id", () => {
  // Neither carries content the plan reads: a position is a membership fact, and
  // an item the viewer can't see still holds a place in the project's order.
  const order = cards("redacted-1", "draft-1", "issue-1");
  assert.deepEqual(
    planReorder({
      order,
      column: cards("draft-1", "issue-1"),
      index: 1,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "redacted-1" },
  );
  assert.deepEqual(
    planReorder({
      order,
      column: cards("draft-1", "issue-1"),
      index: 0,
      direction: "down",
      truncated: false,
    }),
    { kind: "move", afterId: "issue-1" },
  );
});

// ------------------------------------------- equivalence with no archived cards

/** The planner as it stood before archived cards could be drawn under a move:
 *  string ids, `order` pre-filtered to live cards by the caller. Frozen here so
 *  the live-subset contract is pinned to byte-identical plans wherever no
 *  archived card is involved. */
const legacyPlan = ({ order, column, index, direction, truncated }) => {
  const last = column.length - 1;
  if (index < 0 || index > last) return { kind: "noop" };
  const landBefore = (beforeId) => {
    const at = order.indexOf(beforeId);
    if (at === -1) return { kind: "noop" };
    return { kind: "move", afterId: at === 0 ? null : order[at - 1] };
  };
  switch (direction) {
    case "down":
      if (index === last)
        return truncated
          ? { kind: "held", reason: "truncated" }
          : { kind: "noop" };
      return { kind: "move", afterId: column[index + 1] };
    case "bottom":
      if (truncated) return { kind: "held", reason: "truncated" };
      if (index === last) return { kind: "noop" };
      return { kind: "move", afterId: column[last] };
    case "up":
      if (index === 0) return { kind: "noop" };
      return landBefore(column[index - 1]);
    default:
      if (index === 0) return { kind: "noop" };
      return landBefore(column[0]);
  }
};

test("with no archived card anywhere, every plan is the pre-lift plan", () => {
  // Exhaustive over the interleaved board, the ungrouped column, a filtered lens
  // and a flatten that disagrees with the column, every index in and just out of
  // range, all four directions, loaded and truncated.
  const boards = [
    { order: ORDER_IDS, columns: [COL_A, COL_B, COL_C, ORDER, []] },
    { order: ["b1", "a2", "a3"], columns: [cards("a2", "a3")] },
    { order: ["x1", "x2"], columns: [COL_A] },
  ];
  let checked = 0;
  for (const { order, columns } of boards)
    for (const column of columns)
      for (let index = -1; index <= column.length; index += 1)
        for (const direction of ["up", "down", "top", "bottom"])
          for (const truncated of [false, true]) {
            const args = { index, direction, truncated };
            assert.deepEqual(
              planReorder({ ...args, order: cards(...order), column }),
              legacyPlan({
                ...args,
                order,
                column: column.map((card) => card.itemId),
              }),
              JSON.stringify({ ...args, column: column.map((c) => c.itemId) }),
            );
            checked += 1;
          }
  assert.ok(checked > 200, `swept ${checked} plans`);
});

// ------------------------------------------------ archived cards interleaved
//
// GitHub refuses an archived item as a position anchor: updateProjectV2ItemPosition
// answers VALIDATION, "The item to be positioned after is archived and cannot be
// used to update the position of this item" (measured 2026-09-19, re-measured
// 2026-09-26). It also keeps archived items in their slots around a moved card,
// exactly as the cache splice does. So every verb works on the LIVE cards, and no
// plan below may name an archived id.

test("down past an archived neighbour lands after the next LIVE card", () => {
  const column = cards("b", "z*", "c");
  assert.deepEqual(
    planReorder({
      order: column,
      column,
      index: 0,
      direction: "down",
      truncated: false,
    }),
    { kind: "move", afterId: "c" },
  );
});

test("down with only archived cards below is the column's end", () => {
  const column = cards("a", "b", "z*", "y*");
  const args = { order: column, column, index: 1, direction: "down" };
  assert.deepEqual(planReorder({ ...args, truncated: false }), {
    kind: "noop",
  });
  assert.deepEqual(planReorder({ ...args, truncated: true }), {
    kind: "held",
    reason: "truncated",
  });
});

test("up with an archived card above moves past it rather than stopping", () => {
  // The drawn neighbour above b is archived; the live one is a, which is the
  // board's first card, so b lands at the top.
  const column = cards("a", "z*", "b");
  assert.deepEqual(
    planReorder({
      order: column,
      column,
      index: 2,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: null },
  );
});

test("up lands before the live neighbour, anchored on ITS nearest live predecessor", () => {
  // a2's global predecessor is the archived z; the anchor walks past it to b1.
  const order = cards("a1", "b1", "z*", "a2", "a3");
  assert.deepEqual(
    planReorder({
      order,
      column: cards("a1", "a2", "a3"),
      index: 2,
      direction: "up",
      truncated: false,
    }),
    { kind: "move", afterId: "b1" },
  );
});

test("up and top reach the front when only archived cards precede the landing", () => {
  const order = cards("z*", "y*", "a", "b");
  for (const direction of ["up", "top"])
    assert.deepEqual(
      planReorder({
        order,
        column: order,
        index: 3,
        direction,
        truncated: false,
      }),
      { kind: "move", afterId: null },
      direction,
    );
});

test("an archived-LEADING column: the first live card is already at the top", () => {
  const column = cards("z*", "a", "b");
  const at = (index, direction) =>
    planReorder({ order: column, column, index, direction, truncated: false });
  assert.deepEqual(at(1, "top"), { kind: "noop" });
  assert.deepEqual(at(1, "up"), { kind: "noop" });
  // b to the top lands before a, and nothing live precedes a.
  assert.deepEqual(at(2, "top"), { kind: "move", afterId: null });
});

test("an archived-TRAILING column: the last live card is already at the bottom", () => {
  const column = cards("a", "b", "z*");
  const at = (index, direction) =>
    planReorder({ order: column, column, index, direction, truncated: false });
  assert.deepEqual(at(1, "bottom"), { kind: "noop" });
  assert.deepEqual(at(1, "down"), { kind: "noop" });
  assert.deepEqual(at(0, "bottom"), { kind: "move", afterId: "b" });
});

test("an all-archived gap between live cards is stepped over in both directions", () => {
  const column = cards("a", "z*", "y*", "x*", "b");
  const at = (index, direction) =>
    planReorder({ order: column, column, index, direction, truncated: false });
  assert.deepEqual(at(0, "down"), { kind: "move", afterId: "b" });
  assert.deepEqual(at(0, "bottom"), { kind: "move", afterId: "b" });
  assert.deepEqual(at(4, "up"), { kind: "move", afterId: null });
  assert.deepEqual(at(4, "top"), { kind: "move", afterId: null });
});

test("an archived card is never a move's subject", () => {
  // Restore is its action; the panel's hold says so before the planner is asked.
  const column = cards("a", "z*", "b");
  for (const direction of ["up", "down", "top", "bottom"])
    assert.deepEqual(
      planReorder({
        order: column,
        column,
        index: 1,
        direction,
        truncated: false,
      }),
      { kind: "noop" },
      direction,
    );
});

test("no plan ever names an archived anchor", () => {
  // Every live card of a column mixing archived cards at the edges and between
  // live ones, every direction, loaded and truncated.
  const order = cards("z*", "a", "q", "y*", "b", "x*", "w*", "c", "v*");
  const column = cards("z*", "a", "y*", "b", "x*", "w*", "c", "v*");
  const archived = new Set(
    order.filter((card) => card.isArchived).map((card) => card.itemId),
  );
  let moves = 0;
  for (let index = 0; index < column.length; index += 1)
    for (const direction of ["up", "down", "top", "bottom"])
      for (const truncated of [false, true]) {
        const got = planReorder({
          order,
          column,
          index,
          direction,
          truncated,
        });
        if (got.kind !== "move") continue;
        moves += 1;
        assert.equal(
          archived.has(got.afterId),
          false,
          `${column[index].itemId} ${direction}: ${got.afterId}`,
        );
      }
  // Not vacuous: a, b and c plan 3, 7 and 4 moves across the sweep, so a planner
  // that never moved fails here instead of passing every assertion above.
  assert.equal(moves, 14);
});

test("the anchor walk passes a whole RUN of archived cards to reach a live one", () => {
  // Three archived cards in a row, from another column, between b1 and a1: a2 up
  // and to the top both land after b1, never on the run.
  const order = cards("b1", "z*", "y*", "x*", "a1", "a2");
  const column = cards("a1", "a2");
  for (const direction of ["up", "top"])
    assert.deepEqual(
      planReorder({ order, column, index: 1, direction, truncated: false }),
      { kind: "move", afterId: "b1" },
      direction,
    );
  // The same run drawn in the column itself, stepped over going down.
  const drawn = cards("a", "z*", "y*", "x*", "b");
  for (const direction of ["down", "bottom"])
    assert.deepEqual(
      planReorder({
        order: drawn,
        column: drawn,
        index: 0,
        direction,
        truncated: false,
      }),
      { kind: "move", afterId: "b" },
      direction,
    );
});

test("up/top anchors walk past an archived card from ANOTHER column", () => {
  // Column A draws [a1, a2]; the archived z belongs to another column and sits
  // between b1 and a1 in the project's order. a2 up and a2 to the top both land
  // before a1, whose global predecessor is z, so the anchor walks on to b1.
  const order = cards("b1", "z*", "a1", "a2");
  const column = cards("a1", "a2");
  for (const direction of ["up", "top"])
    assert.deepEqual(
      planReorder({ order, column, index: 1, direction, truncated: false }),
      { kind: "move", afterId: "b1" },
      direction,
    );
  // With nothing live ahead of the other column's archived card, the walk runs
  // off the front: the head of the board.
  const headOrder = cards("z*", "a1", "a2");
  for (const direction of ["up", "top"])
    assert.deepEqual(
      planReorder({
        order: headOrder,
        column,
        index: 1,
        direction,
        truncated: false,
      }),
      { kind: "move", afterId: null },
      direction,
    );
});
