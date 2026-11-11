// Pins the pure half of pointer drag on the Projects board: which presses may lift,
// which slot a pointer is over, how fast the edges autoscroll, what a drop means,
// where the card lands, and the order of a cross-column drop's two writes. A drop
// is a write to GitHub's project order that everyone on the project sees, so the
// slot arithmetic and the write order are each a case here.
//
// The imports below reach straight into `src/` and rely on Node's default type
// stripping (>= 23.6): stripping ERASES types rather than compiling them and
// resolves no bundler aliases, so `drag-model.ts` must stay import-free. A runtime
// import added there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildColumns,
  MOVE_CANCELLED_ANNOUNCEMENT,
  movedAnnouncement,
  reorderLanding,
} from "../src/features/projects/board-model.ts";
import {
  planDrop,
  plannerCards,
} from "../src/features/projects/board-positioning.ts";
import {
  AUTOSCROLL_MAX_PX_PER_S,
  autoscrollStep,
  BOARD_EDGE_ZONE_PX,
  COLUMN_EDGE_ZONE_PX,
  classifyDrop,
  crossedLiftThreshold,
  dropLanding,
  edgeVelocity,
  isCancelKey,
  isLiftPress,
  LIFT_THRESHOLD_PX,
  ROW_GAP_PX,
  recheckSlot,
  runCrossColumnDrop,
  slotAboveArchivedRun,
  slotIndexAt,
  slotLineY,
} from "../src/features/projects/drag/drag-model.ts";

const TRUNCATED = "Load more cards to move past the loaded end";

// ---- fixtures -------------------------------------------------------------------

/** A board item as the column model reads it. `col` is the single-select option it
 *  carries ("O_A" / "O_B"); an id ending in `*` is ARCHIVED (the star is stripped). */
const boardItem = (raw, col) => {
  const isArchived = raw.endsWith("*");
  const itemId = isArchived ? raw.slice(0, -1) : raw;
  return {
    itemId,
    isArchived,
    content: { kind: "redacted" },
    fieldValues: [
      {
        kind: "singleSelect",
        fieldId: "F_sel",
        fieldName: "Status",
        optionId: col,
        name: col,
        color: "GRAY",
        isIssueField: false,
      },
    ],
    addedAt: "2026-01-01T00:00:00Z",
  };
};

const option = (id, name) => ({ id, name, color: "GRAY", description: "" });
const FIELD = {
  kind: "singleSelect",
  id: "F_sel",
  name: "Status",
  options: [
    option("O_A", "Todo"),
    option("O_B", "Done"),
    option("O_C", "Later"),
  ],
  isIssueField: false,
};

// Two INTERLEAVED columns of live cards, with archived cards at the top (az0), in
// the middle (az1) and directly above a slot (az2 sits right above a4). Column C
// ("Later") is empty.
const ITEMS = [
  boardItem("az0*", "O_A"),
  boardItem("a1", "O_A"),
  boardItem("b1", "O_B"),
  boardItem("a2", "O_A"),
  boardItem("az1*", "O_A"),
  boardItem("b2", "O_B"),
  boardItem("a3", "O_A"),
  boardItem("b3", "O_B"),
  boardItem("az2*", "O_A"),
  boardItem("a4", "O_A"),
  boardItem("b4", "O_B"),
];

const ORDER = ITEMS.map((i) => i.itemId);

/** The drawn columns' ids, archived cards drawn or not. */
const columnIds = (includeArchived) =>
  Object.fromEntries(
    buildColumns(ITEMS, FIELD, includeArchived).map((c) => [
      c.id,
      c.items.map((i) => i.itemId),
    ]),
  );

/** `count` rows of `size` px tiling from 0. */
const uniformRows = (size) => (index) => ({ start: index * size, size });

// ---- isLiftPress / crossedLiftThreshold ----------------------------------------

const press = (over = {}) => ({
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
  modified: false,
  ...over,
});

test("isLiftPress: a plain primary mouse press may lift", () => {
  assert.equal(isLiftPress(press()), true);
});

test("isLiftPress: a non-primary button never lifts", () => {
  assert.equal(isLiftPress(press({ button: 1 })), false);
  assert.equal(isLiftPress(press({ button: 2 })), false);
});

test("isLiftPress: a secondary pointer never lifts", () => {
  assert.equal(isLiftPress(press({ isPrimary: false })), false);
});

test("isLiftPress: a modified press belongs to the selection grammar", () => {
  assert.equal(isLiftPress(press({ modified: true })), false);
});

test("isLiftPress: touch and pen presses never lift", () => {
  assert.equal(isLiftPress(press({ pointerType: "touch" })), false);
  assert.equal(isLiftPress(press({ pointerType: "pen" })), false);
});

test("isCancelKey: a trusted Escape cancels", () => {
  assert.equal(isCancelKey({ key: "Escape", trusted: true }), true);
});

test("isCancelKey: an untrusted Escape never cancels", () => {
  assert.equal(isCancelKey({ key: "Escape", trusted: false }), false);
});

test("isCancelKey: a trusted key other than Escape never cancels", () => {
  assert.equal(isCancelKey({ key: "Enter", trusted: true }), false);
  assert.equal(isCancelKey({ key: "Esc", trusted: true }), false);
});

test("crossedLiftThreshold: 4.99 px stays a press, exactly 5 px lifts", () => {
  assert.equal(LIFT_THRESHOLD_PX, 5);
  assert.equal(crossedLiftThreshold(4.99, 0), false);
  assert.equal(crossedLiftThreshold(0, -4.99), false);
  assert.equal(crossedLiftThreshold(5, 0), true);
  assert.equal(crossedLiftThreshold(0, -5), true);
});

test("crossedLiftThreshold: the distance is Euclidean, (3, 4) lifts", () => {
  assert.equal(crossedLiftThreshold(3, 4), true);
  assert.equal(crossedLiftThreshold(-3, -3.9), false);
});

// ---- slotIndexAt / slotLineY ------------------------------------------------------

test("slotIndexAt: an empty column has only slot 0", () => {
  assert.equal(
    slotIndexAt(500, 0, () => assert.fail("no row read")),
    0,
  );
});

test("slotIndexAt: above the first row's midpoint is slot 0", () => {
  assert.equal(slotIndexAt(10, 3, uniformRows(100)), 0);
  assert.equal(slotIndexAt(-40, 3, uniformRows(100)), 0);
});

test("slotIndexAt: exactly on a midpoint lands in the slot after that row", () => {
  assert.equal(slotIndexAt(50, 3, uniformRows(100)), 1);
  assert.equal(slotIndexAt(49.99, 3, uniformRows(100)), 0);
});

test("slotIndexAt: between two midpoints is the slot before the lower row", () => {
  assert.equal(slotIndexAt(120, 3, uniformRows(100)), 1);
  assert.equal(slotIndexAt(220, 3, uniformRows(100)), 2);
});

test("slotIndexAt: below the last midpoint is the column's end", () => {
  assert.equal(slotIndexAt(250, 3, uniformRows(100)), 3);
  assert.equal(slotIndexAt(9999, 3, uniformRows(100)), 3);
});

test("slotIndexAt: uneven measured rows split at each row's own midpoint", () => {
  const rows = [
    { start: 0, size: 40 },
    { start: 40, size: 200 },
    { start: 240, size: 20 },
  ];
  const rowAt = (i) => rows[i];
  assert.equal(slotIndexAt(19, 3, rowAt), 0);
  assert.equal(slotIndexAt(100, 3, rowAt), 1);
  assert.equal(slotIndexAt(140, 3, rowAt), 2);
  assert.equal(slotIndexAt(249, 3, rowAt), 2);
  assert.equal(slotIndexAt(250, 3, rowAt), 3);
});

test("slotIndexAt: 150 rows of estimates resolve deep slots without a mounted row", () => {
  const rowAt = uniformRows(80);
  assert.equal(slotIndexAt(80 * 75 + 39, 150, rowAt), 75);
  assert.equal(slotIndexAt(80 * 75 + 40, 150, rowAt), 76);
  assert.equal(slotIndexAt(80 * 149 + 39, 150, rowAt), 149);
  assert.equal(slotIndexAt(80 * 150, 150, rowAt), 150);
});

test("slotLineY: an empty column draws the line half a gap into its body", () => {
  assert.equal(
    slotLineY(0, 0, () => assert.fail("no row read")),
    ROW_GAP_PX / 2,
  );
});

test("slotLineY: slot 0 sits in the first row's top gap", () => {
  assert.equal(slotLineY(0, 3, uniformRows(100)), ROW_GAP_PX / 2);
});

test("slotLineY: a middle slot sits half a gap above its row", () => {
  assert.equal(slotLineY(2, 3, uniformRows(100)), 200 - ROW_GAP_PX / 2);
});

test("slotLineY: the end slot sits half a gap above the last row's end", () => {
  assert.equal(slotLineY(3, 3, uniformRows(100)), 300 - ROW_GAP_PX / 2);
});

// ---- edgeVelocity / autoscrollStep -------------------------------------------------

test("edgeVelocity: nothing scrolls in the middle of a scroller", () => {
  assert.equal(edgeVelocity(250, 0, 500, COLUMN_EDGE_ZONE_PX), 0);
});

test("edgeVelocity: negative toward the start, positive toward the end", () => {
  assert.ok(edgeVelocity(10, 0, 500, COLUMN_EDGE_ZONE_PX) < 0);
  assert.ok(edgeVelocity(490, 0, 500, COLUMN_EDGE_ZONE_PX) > 0);
});

test("edgeVelocity: ramps linearly from 0 at the zone's inner edge", () => {
  const zone = COLUMN_EDGE_ZONE_PX;
  assert.equal(edgeVelocity(zone, 0, 500, zone), 0);
  assert.equal(
    edgeVelocity(zone / 2, 0, 500, zone),
    -AUTOSCROLL_MAX_PX_PER_S / 2,
  );
  assert.equal(
    edgeVelocity(zone / 4, 0, 500, zone),
    (-AUTOSCROLL_MAX_PX_PER_S * 3) / 4,
  );
  assert.equal(edgeVelocity(500 - zone, 0, 500, zone), 0);
  assert.equal(
    edgeVelocity(500 - zone / 2, 0, 500, zone),
    AUTOSCROLL_MAX_PX_PER_S / 2,
  );
});

test("edgeVelocity: capped at the scroller's edge and beyond it", () => {
  const zone = COLUMN_EDGE_ZONE_PX;
  assert.equal(edgeVelocity(0, 0, 500, zone), -AUTOSCROLL_MAX_PX_PER_S);
  assert.equal(edgeVelocity(-300, 0, 500, zone), -AUTOSCROLL_MAX_PX_PER_S);
  assert.equal(edgeVelocity(500, 0, 500, zone), AUTOSCROLL_MAX_PX_PER_S);
  assert.equal(edgeVelocity(900, 0, 500, zone), AUTOSCROLL_MAX_PX_PER_S);
});

test("edgeVelocity: both zone constants, on an offset scroller", () => {
  assert.equal(COLUMN_EDGE_ZONE_PX, 48);
  assert.equal(BOARD_EDGE_ZONE_PX, 64);
  // A column body from y=100 to y=700: half its 48 px zone in from the top.
  assert.equal(
    edgeVelocity(100 + 24, 100, 700, COLUMN_EDGE_ZONE_PX),
    -AUTOSCROLL_MAX_PX_PER_S / 2,
  );
  assert.equal(edgeVelocity(100 + 49, 100, 700, COLUMN_EDGE_ZONE_PX), 0);
  // The board from x=200 to x=1400: half its 64 px zone in from the right.
  assert.equal(
    edgeVelocity(1400 - 32, 200, 1400, BOARD_EDGE_ZONE_PX),
    AUTOSCROLL_MAX_PX_PER_S / 2,
  );
  assert.equal(edgeVelocity(1400 - 65, 200, 1400, BOARD_EDGE_ZONE_PX), 0);
});

test("edgeVelocity: a scroller shorter than two zones splits at its midpoint", () => {
  // 60 px tall with 48 px zones: each zone shrinks to 30 px and they meet at 30.
  const zone = COLUMN_EDGE_ZONE_PX;
  assert.equal(edgeVelocity(30, 0, 60, zone), 0);
  assert.ok(edgeVelocity(29, 0, 60, zone) < 0);
  assert.ok(edgeVelocity(31, 0, 60, zone) > 0);
  assert.equal(edgeVelocity(15, 0, 60, zone), -AUTOSCROLL_MAX_PX_PER_S / 2);
  assert.equal(edgeVelocity(60, 0, 60, zone), AUTOSCROLL_MAX_PX_PER_S);
});

test("edgeVelocity: a collapsed scroller never scrolls", () => {
  assert.equal(edgeVelocity(0, 0, 0, COLUMN_EDGE_ZONE_PX), 0);
});

test("autoscrollStep: one frame's px at the given velocity", () => {
  assert.equal(autoscrollStep(900, 20), 18);
  assert.equal(autoscrollStep(-900, 10), -9);
});

test("autoscrollStep: a stalled frame is clamped to 50 ms", () => {
  assert.equal(autoscrollStep(900, 50), 45);
  assert.equal(autoscrollStep(900, 2000), 45);
  assert.equal(autoscrollStep(-900, 2000), -45);
});

test("autoscrollStep: a negative frame time scrolls nothing", () => {
  assert.equal(autoscrollStep(900, -16), 0);
});

// ---- classifyDrop -----------------------------------------------------------------

const verdict = (over = {}) =>
  classifyDrop({
    target: { columnId: "O_A", beforeId: "a2" },
    currentColumnId: "O_A",
    movedId: "a3",
    targetItemIds: ["a1", "a2", "a3", "a4"],
    moveHeld: undefined,
    plan: { kind: "move", afterId: "b1" },
    truncatedReason: TRUNCATED,
    ...over,
  });

test("classifyDrop rule 1: no target, no current column or no target column is outside", () => {
  assert.deepEqual(verdict({ target: null }), { kind: "outside" });
  assert.deepEqual(verdict({ currentColumnId: null }), { kind: "outside" });
  assert.deepEqual(verdict({ targetItemIds: null }), { kind: "outside" });
});

test("classifyDrop rule 2: a slot neighbour the column no longer draws is outside", () => {
  assert.deepEqual(verdict({ target: { columnId: "O_A", beforeId: "gone" } }), {
    kind: "outside",
  });
  // Rule 2 outranks rule 4's refusal: a stale slot is no column's verdict.
  assert.deepEqual(
    verdict({
      target: { columnId: "O_B", beforeId: "gone" },
      targetItemIds: ["b1"],
      moveHeld: "held",
    }),
    { kind: "outside" },
  );
});

test("classifyDrop rule 2: the column end and the moved card itself are real slots", () => {
  assert.equal(
    verdict({ target: { columnId: "O_A", beforeId: null } }).kind,
    "valid",
  );
  assert.equal(
    verdict({
      target: { columnId: "O_B", beforeId: "a3" },
      targetItemIds: ["b1"],
    }).kind,
    "valid",
  );
});

test("classifyDrop rule 3: same column, a held plan refuses with the truncated reason", () => {
  assert.deepEqual(verdict({ plan: { kind: "held" } }), {
    kind: "refused",
    reason: TRUNCATED,
  });
});

test("classifyDrop rule 3: same column, a noop plan is the card's own slot", () => {
  assert.deepEqual(verdict({ plan: { kind: "noop" } }), { kind: "own-slot" });
});

test("classifyDrop rule 3: same column, a move plan is a same-column write", () => {
  assert.deepEqual(verdict(), {
    kind: "valid",
    crossColumn: false,
    afterId: "b1",
  });
});

test("classifyDrop rule 3: a same-column drop ignores moveHeld", () => {
  assert.deepEqual(verdict({ moveHeld: "Finishing…" }), {
    kind: "valid",
    crossColumn: false,
    afterId: "b1",
  });
});

const cross = (over = {}) =>
  verdict({
    target: { columnId: "O_B", beforeId: "b2" },
    targetItemIds: ["b1", "b2", "b3", "b4"],
    ...over,
  });

test("classifyDrop rule 4: another column while moveHeld is defined refuses with it", () => {
  assert.deepEqual(cross({ moveHeld: "No column to move to" }), {
    kind: "refused",
    reason: "No column to move to",
  });
  // moveHeld outranks the truncated refusal.
  assert.deepEqual(cross({ moveHeld: "x", plan: { kind: "held" } }), {
    kind: "refused",
    reason: "x",
  });
});

test("classifyDrop rule 4: another column with a held plan refuses with the truncated reason", () => {
  assert.deepEqual(cross({ plan: { kind: "held" } }), {
    kind: "refused",
    reason: TRUNCATED,
  });
});

test("classifyDrop rule 4: another column with a move plan is a cross-column write", () => {
  assert.deepEqual(cross({ plan: { kind: "move", afterId: null } }), {
    kind: "valid",
    crossColumn: true,
    afterId: null,
  });
});

test("classifyDrop rule 4: another column with a noop plan is a status write alone", () => {
  assert.deepEqual(cross({ plan: { kind: "noop" } }), {
    kind: "valid",
    crossColumn: true,
    afterId: undefined,
  });
});

/** classifyDrop fed by planDrop on the interleaved fixture, archived cards drawn. */
const planned = (movedId, columnId, beforeId, truncated = false) => {
  const columns = buildColumns(ITEMS, FIELD, true);
  const current = columns.find((c) =>
    c.items.some((i) => i.itemId === movedId),
  );
  const target = columns.find((c) => c.id === columnId);
  return classifyDrop({
    target: { columnId, beforeId },
    currentColumnId: current.id,
    movedId,
    targetItemIds: target.items.map((i) => i.itemId),
    moveHeld: undefined,
    plan: planDrop({
      order: ITEMS,
      column: target.items,
      movedId,
      beforeId,
      truncated,
    }),
    truncatedReason: TRUNCATED,
  });
};

test("classifyDrop over planDrop: own slot on an interleaved board is own-slot", () => {
  // a2's own slot, before itself, before its next card, and before the archived
  // card under it: b1/b2 of the other column sit between in the global order.
  assert.deepEqual(planned("a2", "O_A", "a2"), { kind: "own-slot" });
  assert.deepEqual(planned("a2", "O_A", "az1"), { kind: "own-slot" });
  assert.deepEqual(planned("a2", "O_A", "a3"), { kind: "own-slot" });
});

test("classifyDrop over planDrop: a real same-column move is valid", () => {
  assert.deepEqual(planned("a1", "O_A", "a4"), {
    kind: "valid",
    crossColumn: false,
    afterId: "b3",
  });
});

test("classifyDrop over planDrop: the end of a live column on a truncated board refuses", () => {
  assert.deepEqual(planned("a1", "O_A", null, true), {
    kind: "refused",
    reason: TRUNCATED,
  });
  assert.deepEqual(planned("a4", "O_A", null, true), {
    kind: "refused",
    reason: TRUNCATED,
  });
  assert.deepEqual(planned("a1", "O_B", null, true), {
    kind: "refused",
    reason: TRUNCATED,
  });
});

test("classifyDrop over planDrop: an empty column takes a status write, truncated or not", () => {
  for (const truncated of [false, true])
    assert.deepEqual(planned("a1", "O_C", null, truncated), {
      kind: "valid",
      crossColumn: true,
      afterId: undefined,
    });
});

// ---- slotAboveArchivedRun -----------------------------------------------------------

/** A planner column from raw ids; an id ending in `*` is ARCHIVED. */
const cards = (...raws) =>
  raws.map((raw) => ({
    itemId: raw.replace(/\*$/, ""),
    isArchived: raw.endsWith("*"),
  }));

const resolved = (column, beforeId) =>
  slotAboveArchivedRun({ column, beforeId });

test("slotAboveArchivedRun: a slot directly below one archived card moves above it", () => {
  assert.equal(resolved(cards("a", "x*", "b"), "b"), "x");
});

test("slotAboveArchivedRun: a slot inside a run moves above the whole run", () => {
  assert.equal(resolved(cards("a", "x*", "y*", "z*", "b"), "y"), "x");
  assert.equal(resolved(cards("a", "x*", "y*", "z*", "b"), "b"), "x");
});

test("slotAboveArchivedRun: the end slot below a trailing run moves above the run", () => {
  assert.equal(resolved(cards("a", "x*", "y*"), null), "x");
});

test("slotAboveArchivedRun: a run at the column's top resolves to the first card", () => {
  assert.equal(resolved(cards("x*", "y*", "a"), "a"), "x");
  assert.equal(resolved(cards("x*", "y*"), null), "x");
});

test("slotAboveArchivedRun: a live card above the slot leaves it unchanged", () => {
  assert.equal(resolved(cards("a", "b"), "b"), "b");
  assert.equal(resolved(cards("x*", "a", "b"), null), null);
  // The first slot has no card above it, archived or not.
  assert.equal(resolved(cards("x*", "a"), "x"), "x");
});

test("slotAboveArchivedRun: the walk stops at the nearest live card, the moved card included", () => {
  // Two runs split by one live card: only the lower run is walked past.
  assert.equal(resolved(cards("x*", "a", "y*", "b"), "b"), "y");
  // The moved card is live to this rule, so it splits a run like any other.
  assert.equal(resolved(cards("x*", "m", "y*"), null), "y");
});

test("slotAboveArchivedRun: a restoring card counts archived", () => {
  const column = plannerCards(cards("a", "r", "b"), new Set(["r"]));
  assert.equal(resolved(column, "b"), "r");
  assert.equal(resolved(cards("a", "r", "b"), "b"), "b");
});

test("slotAboveArchivedRun: an unknown beforeId comes back unchanged", () => {
  assert.equal(resolved(cards("a", "x*", "b"), "nope"), "nope");
});

test("slotAboveArchivedRun: an empty column's only slot is null", () => {
  assert.equal(resolved([], null), null);
});

test("slotAboveArchivedRun over planDrop and dropLanding: the card lands directly above the run", () => {
  // o, a live card of ANOTHER column, sits between the run's first card x and
  // the slot card s in the project order: planned raw, the slot lands under x.
  const order = cards("m", "l", "x*", "o", "y*", "s");
  const column = cards("l", "x*", "y*", "s");
  const orderIds = order.map((c) => c.itemId);
  const drawnIds = column.map((c) => c.itemId);
  const plan = (beforeId) =>
    planDrop({ order, column, movedId: "m", beforeId, truncated: false });
  const beforeId = resolved(column, "s");
  assert.equal(beforeId, "x");
  assert.deepEqual(plan(beforeId), { kind: "move", afterId: "l" });
  assert.deepEqual(
    dropLanding({
      order: orderIds,
      column: drawnIds,
      movedId: "m",
      afterId: "l",
    }),
    { idx: 1, count: 5 },
  );
  // The raw slot's anchor is o, which draws the card below x.
  assert.deepEqual(plan("s"), { kind: "move", afterId: "o" });
  assert.deepEqual(
    dropLanding({
      order: orderIds,
      column: drawnIds,
      movedId: "m",
      afterId: "o",
    }),
    { idx: 2, count: 5 },
  );
  // Same column on the shared fixture: a1 dropped under az2 lands right above it.
  const todo = buildColumns(ITEMS, FIELD, true).find((c) => c.id === "O_A");
  const at = resolved(todo.items, "a4");
  assert.equal(at, "az2");
  const write = planDrop({
    order: ITEMS,
    column: todo.items,
    movedId: "a1",
    beforeId: at,
    truncated: false,
  });
  assert.deepEqual(write, { kind: "move", afterId: "b3" });
  const landing = dropLanding({
    order: ORDER,
    column: columnIds(true).O_A,
    movedId: "a1",
    afterId: write.afterId,
  });
  assert.equal(
    columnIds(true).O_A.filter((id) => id !== "a1")[landing.idx],
    "az2",
  );
});

// ---- dropLanding ------------------------------------------------------------------

test("dropLanding: same column, moving down", () => {
  const { O_A } = columnIds(true);
  // a1 after a3 in the global order: Todo draws [az0, a2, az1, a3, a1, az2, a4].
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_A, movedId: "a1", afterId: "a3" }),
    { idx: 4, count: 7 },
  );
});

test("dropLanding: same column, moving up to the top of the board", () => {
  const { O_A } = columnIds(true);
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_A, movedId: "a4", afterId: null }),
    { idx: 0, count: 7 },
  );
});

test("dropLanding: an archived card between the anchor and the slot stays below the card", () => {
  const { O_A } = columnIds(true);
  // a1 after b3 (planDrop's anchor for "before a4"): az2 sits between b3 and a4,
  // so a1 lands above az2, not right above a4.
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_A, movedId: "a1", afterId: "b3" }),
    { idx: 4, count: 7 },
  );
  // With archived cards hidden the same write lands a1 right above a4.
  const live = columnIds(false).O_A;
  assert.deepEqual(
    dropLanding({ order: ORDER, column: live, movedId: "a1", afterId: "b3" }),
    { idx: 2, count: 4 },
  );
});

test("dropLanding: cross column into the middle", () => {
  const { O_B } = columnIds(true);
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_B, movedId: "a1", afterId: "b2" }),
    { idx: 2, count: 5 },
  );
});

test("dropLanding: cross column to the end", () => {
  const { O_B } = columnIds(true);
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_B, movedId: "a1", afterId: "b4" }),
    { idx: 4, count: 5 },
  );
});

test("dropLanding: cross column into an empty column", () => {
  assert.deepEqual(
    dropLanding({
      order: ORDER,
      column: [],
      movedId: "a1",
      afterId: undefined,
    }),
    { idx: 0, count: 1 },
  );
});

test("dropLanding: no position write keeps the card's place in the order", () => {
  const { O_B } = columnIds(true);
  // a2 sits between b1 and b2 in the order, so it lands at index 1 of Done.
  assert.deepEqual(
    dropLanding({
      order: ORDER,
      column: O_B,
      movedId: "a2",
      afterId: undefined,
    }),
    { idx: 1, count: 5 },
  );
});

test("dropLanding: an anchor the order doesn't hold leaves the card in place", () => {
  const { O_A } = columnIds(true);
  assert.deepEqual(
    dropLanding({ order: ORDER, column: O_A, movedId: "a2", afterId: "nope" }),
    { idx: 2, count: 7 },
  );
});

test("dropLanding equals reorderLanding on every same-column move of the fixture", () => {
  let compared = 0;
  for (const includeArchived of [true, false]) {
    const columns = buildColumns(ITEMS, FIELD, includeArchived);
    for (const column of columns) {
      const drawn = column.items.map((i) => i.itemId);
      for (const moved of column.items) {
        if (moved.isArchived) continue;
        for (const beforeId of [...drawn, null]) {
          const plan = planDrop({
            order: ITEMS,
            column: column.items,
            movedId: moved.itemId,
            beforeId,
            truncated: false,
          });
          if (plan.kind !== "move") continue;
          const twin = reorderLanding(
            ITEMS,
            FIELD,
            includeArchived,
            moved.itemId,
            plan.afterId,
          );
          assert.deepEqual(
            dropLanding({
              order: ORDER,
              column: drawn,
              movedId: moved.itemId,
              afterId: plan.afterId,
            }),
            { idx: twin.idx, count: twin.count },
            `${moved.itemId} before ${beforeId} (archived drawn: ${includeArchived})`,
          );
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared >= 20, `compared ${compared} moves`);
});

// ---- recheckSlot ------------------------------------------------------------------

const PINNED = {
  repo: "C:/repo",
  signature: "sig-1",
  movedId: "a1",
  targetColumnId: "O_B",
};
const LIVE = {
  signature: "sig-1",
  columns: [
    { id: "O_A", itemIds: ["a2"] },
    { id: "O_B", itemIds: ["b1", "a1", "b2"] },
  ],
};
const recheck = (over = {}, plan = { kind: "move", afterId: "b1" }) => {
  let replans = 0;
  const result = recheckSlot({
    pinned: PINNED,
    liveRepo: "C:/repo",
    live: LIVE,
    replan: () => {
      replans += 1;
      return plan;
    },
    ...over,
  });
  return { result, replans };
};

test("recheckSlot: a repo switch skips first, whatever else changed", () => {
  const { result, replans } = recheck({
    liveRepo: "C:/other",
    live: { ...LIVE, signature: "sig-2" },
  });
  assert.deepEqual(result, { kind: "skip", why: "repo" });
  assert.equal(replans, 0);
  assert.deepEqual(recheck({ liveRepo: null }).result, {
    kind: "skip",
    why: "repo",
  });
});

test("recheckSlot: an unmounted root (null live) skips as board", () => {
  assert.deepEqual(recheck({ live: null }).result, {
    kind: "skip",
    why: "board",
  });
});

test("recheckSlot: a changed board signature skips before any column check", () => {
  const { result, replans } = recheck({
    live: { signature: "sig-2", columns: [] },
  });
  assert.deepEqual(result, { kind: "skip", why: "board" });
  assert.equal(replans, 0);
});

test("recheckSlot: a target column that is gone skips", () => {
  assert.deepEqual(
    recheck({ live: { ...LIVE, columns: [LIVE.columns[0]] } }).result,
    { kind: "skip", why: "column-gone" },
  );
});

test("recheckSlot: a card the target column no longer draws skips", () => {
  const { result, replans } = recheck({
    live: {
      ...LIVE,
      columns: [LIVE.columns[0], { id: "O_B", itemIds: ["b1", "b2"] }],
    },
  });
  assert.deepEqual(result, { kind: "skip", why: "card-left" });
  assert.equal(replans, 0);
});

test("recheckSlot: a re-plan with nothing to write skips", () => {
  assert.deepEqual(recheck({}, { kind: "noop" }).result, {
    kind: "skip",
    why: "nothing-to-write",
  });
  assert.deepEqual(recheck({}, { kind: "held" }).result, {
    kind: "skip",
    why: "nothing-to-write",
  });
});

test("recheckSlot: a re-plan that moves writes ITS anchor", () => {
  const { result, replans } = recheck({}, { kind: "move", afterId: "b2" });
  assert.deepEqual(result, { kind: "write", afterId: "b2" });
  assert.equal(replans, 1);
});

// ---- runCrossColumnDrop -----------------------------------------------------------

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((res) => setImmediate(res));

test("runCrossColumnDrop: the slot write waits for the status write to settle", async () => {
  const status = deferred();
  const log = [];
  const run = runCrossColumnDrop({
    writeStatus: () => {
      log.push("status");
      return status.promise;
    },
    recheck: () => {
      log.push("recheck");
      return { kind: "write", afterId: "b1" };
    },
    writeSlot: (afterId) => log.push(`slot:${afterId}`),
  });
  await flush();
  await flush();
  assert.deepEqual(
    log,
    ["status"],
    "nothing past the status write while pending",
  );
  status.resolve();
  assert.equal(await run, "slot-written");
  assert.deepEqual(log, ["status", "recheck", "slot:b1"]);
});

test("runCrossColumnDrop: a rejected status write never sends the slot", async () => {
  const status = deferred();
  let slots = 0;
  let rechecks = 0;
  const run = runCrossColumnDrop({
    writeStatus: () => status.promise,
    recheck: () => {
      rechecks += 1;
      return { kind: "write", afterId: null };
    },
    writeSlot: () => {
      slots += 1;
    },
  });
  status.reject(new Error("offline"));
  assert.equal(await run, "status-failed");
  assert.equal(slots, 0);
  assert.equal(rechecks, 0);
});

test("runCrossColumnDrop: a skipped recheck never sends the slot", async () => {
  let slots = 0;
  const outcome = await runCrossColumnDrop({
    writeStatus: () => Promise.resolve("ok"),
    recheck: () => ({ kind: "skip", why: "board" }),
    writeSlot: () => {
      slots += 1;
    },
  });
  assert.equal(outcome, "slot-skipped");
  assert.equal(slots, 0);
});

test("runCrossColumnDrop: a write recheck sends the re-planned anchor once", async () => {
  const sent = [];
  const outcome = await runCrossColumnDrop({
    writeStatus: () => Promise.resolve(),
    recheck: () => ({ kind: "write", afterId: null }),
    writeSlot: (afterId) => sent.push(afterId),
  });
  assert.equal(outcome, "slot-written");
  assert.deepEqual(sent, [null]);
});

// ---- copy -------------------------------------------------------------------------

test("movedAnnouncement: the keyboard route's landing sentence, exactly", () => {
  assert.equal(
    movedAnnouncement(3, 7, "In progress"),
    "Moved to 3 of 7 in In progress",
  );
});

test("MOVE_CANCELLED_ANNOUNCEMENT: exactly 'Move cancelled'", () => {
  assert.equal(MOVE_CANCELLED_ANNOUNCEMENT, "Move cancelled");
});
