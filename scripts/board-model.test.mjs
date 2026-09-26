// Pins the Projects-board column model: which buckets a grouping field defines, in
// which order, which of them are drawn at all, and which cards land where. The bugs
// these guard against are silent — a card bucketed into a column the board then
// declines to draw disappears from the board without an error — so each is a case.
// Also where a reposition lands in those columns, and how the keyboard cursor finds
// its card again after they change under it.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6): stripping ERASES types rather than compiling them and resolves
// no bundler aliases, so `board-model.ts` must stay import-free (types only — its
// `import type` from the `@/` alias is erased and never resolved). A runtime import
// added there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bucketIdFor,
  buildColumns,
  findCard,
  groupableFields,
  reorderLanding,
  resolveBoardCursor,
  spliceAfter,
  UNSET_COLUMN_ID,
} from "../src/features/projects/board-model.ts";
import { planReorder } from "../src/features/projects/board-positioning.ts";
import { reorderBoardItem } from "../src/lib/git/queries/board-order.ts";

/** A board item as the column model reads it: id, archived flag, field values. The
 *  content arm is `redacted` because nothing here reads content. */
const item = (itemId, fieldValues = [], isArchived = false) => ({
  itemId,
  isArchived,
  content: { kind: "redacted" },
  fieldValues,
  addedAt: "2026-01-01T00:00:00Z",
});

const iterationValue = (fieldId, iterationId) => ({
  kind: "iteration",
  fieldId,
  fieldName: "Sprint",
  iterationId,
  title: "some title",
  startDate: "2026-01-05",
  duration: 14,
  isIssueField: false,
});

const selectValue = (fieldId, optionId) => ({
  kind: "singleSelect",
  fieldId,
  fieldName: "Status",
  optionId,
  name: "some name",
  color: "GRAY",
  isIssueField: false,
});

const iteration = (id, title) => ({
  id,
  title,
  startDate: "2026-01-05",
  duration: 14,
});

const iterationField = (iterations, completedIterations = []) => ({
  kind: "iteration",
  id: "F_iter",
  name: "Sprint",
  iterations,
  completedIterations,
});

const option = (id, name) => ({ id, name, color: "GRAY", description: "" });

const selectField = (options) => ({
  kind: "singleSelect",
  id: "F_sel",
  name: "Status",
  options,
  isIssueField: false,
});

/** Column ids in draw order, and the item ids each column holds. */
const ids = (columns) => columns.map((c) => c.id);
const held = (columns, id) =>
  columns.find((c) => c.id === id)?.items.map((i) => i.itemId);

// -------------------------------------- (1) active/upcoming iterations, incl. empty

test("iteration grouping draws every configured iteration in field order, empty ones included", () => {
  const field = iterationField([
    iteration("I_1", "Sprint 1"),
    iteration("I_2", "Sprint 2"),
    iteration("I_3", "Sprint 3"),
  ]);
  // Only the middle iteration holds a card; the other two must still be drawn.
  const columns = buildColumns(
    [item("a", [iterationValue("F_iter", "I_2")])],
    field,
    false,
  );
  assert.deepEqual(ids(columns), ["I_1", "I_2", "I_3", UNSET_COLUMN_ID]);
  assert.deepEqual(held(columns, "I_1"), []);
  assert.deepEqual(held(columns, "I_2"), ["a"]);
  assert.deepEqual(held(columns, "I_3"), []);
  // Iteration columns carry no colour — the header and the menu rows branch on null.
  assert.equal(
    columns.every((c) => c.color === null),
    true,
  );
  assert.equal(columns.at(-1).label, "No Sprint");
});

// ------------------------------------------- (2) completed iterations, only-with-cards

test("completed iterations are drawn only where they still hold a card", () => {
  const field = iterationField(
    [iteration("I_1", "Sprint 1")],
    [iteration("C_full", "Sprint 0"), iteration("C_empty", "Sprint -1")],
  );
  const columns = buildColumns(
    [item("a", [iterationValue("F_iter", "C_full")])],
    field,
    false,
  );
  // Active first in field order, then the completed one that has something in it.
  assert.deepEqual(ids(columns), ["I_1", "C_full", UNSET_COLUMN_ID]);
  assert.deepEqual(held(columns, "C_full"), ["a"]);
});

test("an empty completed iteration is dropped without losing any card", () => {
  const field = iterationField([], [iteration("C_empty", "Sprint 0")]);
  const columns = buildColumns([item("a"), item("b")], field, false);
  assert.deepEqual(ids(columns), [UNSET_COLUMN_ID]);
  // Every card still drawn: dropping only ever removes an EMPTY column.
  assert.deepEqual(held(columns, UNSET_COLUMN_ID), ["a", "b"]);
});

// ------------------------------------------------------------- (3) catch-all bucketing

test("a card with no iteration value, or one the field no longer defines, falls to the catch-all", () => {
  const field = iterationField([iteration("I_1", "Sprint 1")]);
  const columns = buildColumns(
    [
      item("unset"),
      item("gone", [iterationValue("F_iter", "I_deleted")]),
      item("other-field", [iterationValue("F_someone_else", "I_1")]),
    ],
    field,
    false,
  );
  assert.deepEqual(held(columns, "I_1"), []);
  assert.deepEqual(held(columns, UNSET_COLUMN_ID), [
    "unset",
    "gone",
    "other-field",
  ]);
  // The VALUE reading the menu uses agrees: unset reads null, a stale id reads
  // itself (naming no drawn column, which is what keeps the clear row live).
  assert.equal(bucketIdFor(item("unset"), field), null);
  assert.equal(
    bucketIdFor(item("gone", [iterationValue("F_iter", "I_deleted")]), field),
    "I_deleted",
  );
});

// ---------------------------------------------------------------- (4) archived cards

test("includeArchived false drops archived cards, true buckets them like any other", () => {
  const field = iterationField([iteration("I_1", "Sprint 1")]);
  const items = [
    item("live", [iterationValue("F_iter", "I_1")]),
    item("archived", [iterationValue("F_iter", "I_1")], true),
    item("archived-unset", [], true),
  ];
  const hidden = buildColumns(items, field, false);
  assert.deepEqual(held(hidden, "I_1"), ["live"]);
  assert.deepEqual(held(hidden, UNSET_COLUMN_ID), []);

  const shown = buildColumns(items, field, true);
  assert.deepEqual(held(shown, "I_1"), ["live", "archived"]);
  assert.deepEqual(held(shown, UNSET_COLUMN_ID), ["archived-unset"]);
});

test("an ungrouped board honours the archived flag too", () => {
  const items = [item("live"), item("archived", [], true)];
  assert.deepEqual(
    buildColumns(items, null, false)[0].items.map((i) => i.itemId),
    ["live"],
  );
  assert.deepEqual(
    buildColumns(items, null, true)[0].items.map((i) => i.itemId),
    ["live", "archived"],
  );
});

// ----------------------------------------------------------- (5) single-select intact

test("single-select grouping draws every option in field order and keeps its colours", () => {
  const field = selectField([option("O_1", "Todo"), option("O_2", "Done")]);
  const columns = buildColumns(
    [
      item("a", [selectValue("F_sel", "O_2")]),
      item("stale", [selectValue("F_sel", "O_gone")]),
    ],
    field,
    false,
  );
  assert.deepEqual(ids(columns), ["O_1", "O_2", UNSET_COLUMN_ID]);
  assert.deepEqual(held(columns, "O_1"), []);
  assert.deepEqual(held(columns, "O_2"), ["a"]);
  // A stored option the field no longer defines is drawn in the catch-all.
  assert.deepEqual(held(columns, UNSET_COLUMN_ID), ["stale"]);
  assert.equal(columns[0].color, "GRAY");
  assert.equal(columns.at(-1).color, null);
  assert.equal(columns.at(-1).label, "No Status");
  assert.equal(
    bucketIdFor(item("a", [selectValue("F_sel", "O_2")]), field),
    "O_2",
  );
});

test("a select field's value of the wrong kind is not a value of that field", () => {
  const field = selectField([option("O_1", "Todo")]);
  // Same field id, iteration shape: wire drift, not a single-select value.
  assert.equal(
    bucketIdFor(item("x", [iterationValue("F_sel", "O_1")]), field),
    null,
  );
});

// --------------------------------------------------------------- (6) groupableFields

test("groupableFields admits single-select and iteration, in the board's own order", () => {
  const fields = [
    { kind: "text", id: "T", name: "Notes", isIssueField: false },
    iterationField([]),
    {
      kind: "multiSelect",
      id: "M",
      name: "Tags",
      options: [],
      isIssueField: false,
    },
    selectField([]),
    { kind: "system", id: "S", name: "Title", dataType: "TITLE" },
    { kind: "date", id: "D", name: "Due", isIssueField: false },
    { kind: "number", id: "N", name: "Points", isIssueField: false },
  ];
  assert.deepEqual(
    groupableFields(fields).map((f) => f.id),
    ["F_iter", "F_sel"],
  );
});

test("groupableFields returns nothing for a board that defines no groupable field", () => {
  assert.deepEqual(
    groupableFields([
      {
        kind: "multiSelect",
        id: "M",
        name: "Tags",
        options: [],
        isIssueField: false,
      },
    ]),
    [],
  );
});

// ------------------------------------------------- (7) reposition landing

/** Where a reposition of `itemId` in `direction` lands in the drawn columns: the
 *  planner's afterId, fed through the same splice the cache runs. */
const land = (items, field, includeArchived, itemId, direction) => {
  const columns = buildColumns(items, field, includeArchived);
  const at = findCard(columns, itemId);
  const plan = planReorder({
    order: items,
    column: columns[at.col].items,
    index: at.idx,
    direction,
    truncated: false,
  });
  assert.equal(plan.kind, "move", `${itemId} ${direction} plans a move`);
  return reorderLanding(items, field, includeArchived, itemId, plan.afterId);
};

test("up past an archived card lands at the drawn top, not one slot up", () => {
  // [A, Z, B] with Z archived: B up steps past Z and lands before A.
  const items = [item("A"), item("Z", [], true), item("B")];
  assert.deepEqual(land(items, null, true, "B", "up"), {
    col: 0,
    idx: 0,
    count: 3,
  });
});

test("down past an archived card lands after the next live card, two drawn slots on", () => {
  // [B, Z, C] with Z archived: B down lands after C, so Z stays first.
  const items = [item("B"), item("Z", [], true), item("C")];
  assert.deepEqual(land(items, null, true, "B", "down"), {
    col: 0,
    idx: 2,
    count: 3,
  });
});

test("to top on an archived-LEADING column lands ahead of the archived card", () => {
  // A null afterId is the front of the board, and GitHub keeps the archived card's
  // slot relative to everything else (measured 2026-09-26): [B, Z, A].
  const items = [item("Z", [], true), item("A"), item("B")];
  assert.deepEqual(land(items, null, true, "B", "top"), {
    col: 0,
    idx: 0,
    count: 3,
  });
});

test("to bottom on an archived-TRAILING column lands above the archived card", () => {
  // A to the bottom lands after B, the last LIVE card: [B, A, Z].
  const items = [item("A"), item("B"), item("Z", [], true)];
  assert.deepEqual(land(items, null, true, "A", "bottom"), {
    col: 0,
    idx: 1,
    count: 3,
  });
});

test("the landing reads the card's own column when others interleave the order", () => {
  const field = selectField([option("O_1", "Todo"), option("O_2", "Done")]);
  const todo = (id, archived = false) =>
    item(id, [selectValue("F_sel", "O_1")], archived);
  const items = [
    todo("a"),
    item("x", [selectValue("F_sel", "O_2")]),
    todo("z", true),
    todo("b"),
  ];
  // Todo draws [a, z, b]; b up steps past z and lands before a.
  assert.deepEqual(land(items, field, true, "b", "up"), {
    col: 0,
    idx: 0,
    count: 3,
  });
  // Archived cards hidden: the column is [a, b] and counts two.
  assert.deepEqual(land(items, field, false, "b", "up"), {
    col: 0,
    idx: 0,
    count: 2,
  });
});

test("with no archived card the landing is the plain one-slot step", () => {
  const items = [item("a"), item("b"), item("c"), item("d")];
  assert.deepEqual(land(items, null, false, "b", "down"), {
    col: 0,
    idx: 2,
    count: 4,
  });
  assert.deepEqual(land(items, null, false, "c", "up"), {
    col: 0,
    idx: 1,
    count: 4,
  });
  assert.deepEqual(land(items, null, false, "a", "bottom"), {
    col: 0,
    idx: 3,
    count: 4,
  });
  assert.deepEqual(land(items, null, false, "d", "top"), {
    col: 0,
    idx: 0,
    count: 4,
  });
});

test("an anchor the flatten doesn't hold leaves the card where it is, as the splice does", () => {
  const items = [item("a"), item("b")];
  assert.deepEqual(reorderLanding(items, null, false, "b", "nope"), {
    col: 0,
    idx: 1,
    count: 2,
  });
  assert.equal(reorderLanding(items, null, false, "gone", null), null);
});

// ------------------------------------------------ (8) the board's cursor

/** The one column of an ungrouped board holding `ids` in order. */
const columnOf = (...ids) =>
  buildColumns(
    ids.map((id) => item(id)),
    null,
    false,
  );

test("the cursor re-finds its card after a rollback slides a neighbour into its slot", () => {
  // c was moved up and the cursor predicted it at slot 1; the write failed and the
  // rollback put c back at slot 2, where b now sits in slot 1.
  const cursor = { itemId: "c", col: 0, idx: 1 };
  assert.deepEqual(resolveBoardCursor(columnOf("a", "b", "c"), cursor), {
    itemId: "c",
    col: 0,
    idx: 2,
  });
});

test("a cursor whose slot still holds its card comes back as the same object", () => {
  const cursor = { itemId: "b", col: 0, idx: 1 };
  assert.equal(resolveBoardCursor(columnOf("a", "b", "c"), cursor), cursor);
});

test("a cursor follows its card into another column", () => {
  const field = selectField([option("O_1", "Todo"), option("O_2", "Done")]);
  const columns = buildColumns(
    [item("a", [selectValue("F_sel", "O_2")])],
    field,
    false,
  );
  assert.deepEqual(
    resolveBoardCursor(columns, { itemId: "a", col: 0, idx: 0 }),
    { itemId: "a", col: 1, idx: 0 },
  );
});

test("a cursor whose card is gone addresses nothing, never the card in its slot", () => {
  const cursor = { itemId: "gone", col: 0, idx: 0 };
  assert.equal(resolveBoardCursor(columnOf("a", "b"), cursor), null);
  assert.equal(resolveBoardCursor(columnOf("a"), null), null);
});

// ------------------------------------ (9) the landing's splice and the cache's

/** The board's flatten point: each membership's LAST copy, as `oneCardPerItem`. */
const drawnOnce = (flat) => {
  const last = new Map();
  flat.forEach((card, i) => last.set(card.itemId, i));
  return flat.filter((card, i) => last.get(card.itemId) === i);
};

test("the landing's splice is the cache splice, seen through the drawn flatten", () => {
  // reorderLanding predicts the cursor off `spliceAfter`; the cache moves by
  // `reorderBoardItem`. Every fixture here, duplicate copies included, has to come
  // out drawing the same order both ways, or the cursor lands beside its card.
  const page = (flat) => ({
    pageParams: [null],
    pages: [
      {
        items: flat,
        totalCount: flat.length,
        truncated: false,
        endCursor: null,
      },
    ],
  });
  const fixtures = [
    ["A", "Z*", "B", "C"],
    ["Z*", "A", "B", "Y*"],
    ["x", "a", "b", "x", "c"],
    ["a", "x", "x", "b"],
    ["x", "a", "x", "Z*", "b", "x"],
  ].map((spec) =>
    spec.map((id) =>
      id.endsWith("*") ? item(id.slice(0, -1), [], true) : item(id),
    ),
  );
  let checked = 0;
  for (const flat of fixtures) {
    const idsIn = [...new Set(flat.map((card) => card.itemId))];
    for (const moved of idsIn)
      for (const afterId of [null, ...idsIn, "nope"]) {
        if (afterId === moved) continue;
        const viaCache = reorderBoardItem(page(flat), moved, afterId);
        const cacheDrawn = drawnOnce(viaCache.pages.flatMap((p) => p.items));
        const viaLanding = spliceAfter(drawnOnce(flat), moved, afterId);
        assert.deepEqual(
          viaLanding.map((card) => card.itemId),
          cacheDrawn.map((card) => card.itemId),
          `${flat.map((c) => c.itemId).join(",")}: ${moved} after ${afterId}`,
        );
        checked += 1;
      }
  }
  assert.ok(checked > 50, `compared ${checked} moves`);
});
