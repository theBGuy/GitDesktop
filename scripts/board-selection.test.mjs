// Pins the Projects-board multi-select model: which cards a Shift range covers,
// which of a selection the board still draws, and which of them each bulk verb
// acts on. The bugs these guard against are silent and destructive — a range that
// leaked across columns, or a verb that counted a card the board stopped drawing,
// would archive or remove work the user never selected — so each is a case. The
// TABLE layout's row model rides here too: which rows a collapsed section hides
// from the walk and from a range, and where the cursor re-lands.
//
// The imports below reach straight into `src/` and rely on Node's default type
// stripping (>= 23.6): stripping ERASES types rather than compiling them and
// resolves no bundler aliases, so `board-selection.ts` and `board-model.ts` must
// stay import-free (types only — their `import type` lines are erased and never
// resolved). A runtime import added to either fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  columnValue,
  firstCardPosition,
  groupRowKey,
  honouredSortKeys,
  itemAtRowSlot,
  itemRowKey,
  itemRowSlot,
  resolveTableCursor,
  stepTableCursor,
  tableColumns,
  tableRows,
} from "../src/features/projects/board-model.ts";
import {
  columnRange,
  isMacSecondaryClick,
  partitionEligible,
  pruneSelection,
  rowRange,
  selectionMods,
} from "../src/features/projects/board-selection.ts";

/** A board item as the selection model reads it: its id, its archived flag, and
 *  whether its content is readable at all. */
const item = (itemId, isArchived = false, kind = "issue") => ({
  itemId,
  isArchived,
  content: kind === "redacted" ? { kind } : { kind, title: itemId },
  fieldValues: [],
  addedAt: "2026-01-01T00:00:00Z",
});

/** A column of the given items, labelled by its id. */
const column = (id, items) => ({ id, label: id, color: null, items });

/** The two-column board the range and prune cases read, archived cards
 *  interleaved and a redacted card sitting inside the first column's span. */
const board = () => [
  column("todo", [
    item("a"),
    item("b", true),
    item("secret", false, "redacted"),
    item("c"),
    item("d"),
  ]),
  column("done", [item("e"), item("f", true)]),
];

// ------------------------------------------------------------- (1) column ranges

test("a range covers every card between the anchor and the target, in column order", () => {
  assert.deepEqual(columnRange(board(), "a", "c"), ["a", "b", "c"]);
});

test("a range reads the same in either direction", () => {
  assert.deepEqual(columnRange(board(), "d", "b"), ["b", "c", "d"]);
});

test("an anchor equal to the target is a one-card range", () => {
  assert.deepEqual(columnRange(board(), "c", "c"), ["c"]);
});

test("a redacted card inside the span is stepped over, never carried", () => {
  // `secret` sits between `b` and `c` and is structurally unselectable.
  assert.deepEqual(columnRange(board(), "b", "d"), ["b", "c", "d"]);
  // And a range whose own endpoint is redacted carries nothing of it either.
  assert.deepEqual(columnRange(board(), "a", "secret"), ["a", "b"]);
});

test("a range across two columns is null — the caller toggle-adds instead", () => {
  assert.equal(columnRange(board(), "a", "e"), null);
  assert.equal(columnRange(board(), "f", "c"), null);
});

test("a range whose anchor or target the board no longer draws is null", () => {
  assert.equal(columnRange(board(), "gone", "c"), null);
  assert.equal(columnRange(board(), "a", "gone"), null);
  assert.equal(columnRange([], "a", "c"), null);
});

test("a range inside the second column stays inside it", () => {
  assert.deepEqual(columnRange(board(), "e", "f"), ["e", "f"]);
});

// -------------------------------------------------------------------- (2) prune

test("prune keeps only the ids the board still draws", () => {
  const live = pruneSelection(new Set(["a", "f", "gone"]), board());
  assert.deepEqual([...live].sort(), ["a", "f"]);
});

test("prune drops a card that became redacted under the selection", () => {
  assert.deepEqual([...pruneSelection(new Set(["secret"]), board())], []);
});

test("prune of an empty selection is empty, and an emptied board prunes to nothing", () => {
  assert.deepEqual([...pruneSelection(new Set(), board())], []);
  assert.deepEqual([...pruneSelection(new Set(["a", "b"]), [])], []);
});

test("prune returns a fresh set rather than the one it was handed", () => {
  const selected = new Set(["a"]);
  const live = pruneSelection(selected, board());
  assert.notEqual(live, selected);
  assert.deepEqual([...live], ["a"]);
});

// -------------------------------------------------------------- (3) eligibility

/** Item ids of each half, for readable assertions. */
const split = (verb, items) => {
  const { eligible, skipped } = partitionEligible(verb, items);
  return [eligible.map((i) => i.itemId), skipped.map((i) => i.itemId)];
};

test("move, fields and archive take the live cards and skip the archived ones", () => {
  const mixed = [item("live"), item("old", true), item("live2")];
  assert.deepEqual(split("move", mixed), [["live", "live2"], ["old"]]);
  assert.deepEqual(split("fields", mixed), [["live", "live2"], ["old"]]);
  assert.deepEqual(split("archive", mixed), [["live", "live2"], ["old"]]);
});

test("restore takes the archived cards alone", () => {
  const mixed = [item("live"), item("old", true), item("older", true)];
  assert.deepEqual(split("restore", mixed), [["old", "older"], ["live"]]);
});

test("remove reaches every card, whatever its state", () => {
  const mixed = [item("live"), item("old", true)];
  assert.deepEqual(split("remove", mixed), [["live", "old"], []]);
});

test("an all-archived selection leaves archive, move and fields with nothing to do", () => {
  const archived = [item("x", true), item("y", true)];
  assert.deepEqual(split("archive", archived), [[], ["x", "y"]]);
  assert.deepEqual(split("move", archived), [[], ["x", "y"]]);
  assert.deepEqual(split("fields", archived), [[], ["x", "y"]]);
  assert.deepEqual(split("restore", archived), [["x", "y"], []]);
  assert.deepEqual(split("remove", archived), [["x", "y"], []]);
});

test("an all-live selection leaves restore with nothing to do", () => {
  const live = [item("x"), item("y")];
  assert.deepEqual(split("restore", live), [[], ["x", "y"]]);
  assert.deepEqual(split("archive", live), [["x", "y"], []]);
  assert.deepEqual(split("fields", live), [["x", "y"], []]);
});

test("an empty selection partitions to two empty halves for every verb", () => {
  for (const verb of ["move", "fields", "archive", "restore", "remove"]) {
    assert.deepEqual(split(verb, []), [[], []]);
  }
});

// --------------------------------------------------------------- (4) row ranges

/** The table's visible rows: a flat list, collapsed sections already left out. */
const rows = () => [
  item("a"),
  item("b", true),
  item("secret", false, "redacted"),
  item("c"),
  item("d"),
];

test("a row range covers every visible row between anchor and target, in draw order", () => {
  assert.deepEqual(rowRange(rows(), "a", "c"), ["a", "b", "c"]);
  assert.deepEqual(rowRange(rows(), "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rowRange(rows(), "c", "c"), ["c"]);
});

test("a row range steps over a redacted row inside it", () => {
  assert.deepEqual(rowRange(rows(), "b", "d"), ["b", "c", "d"]);
});

test("a row range runs across group sections: the rows are one ordering", () => {
  // Rows from two sections, flattened the way the table draws them.
  const flat = [item("todo-1"), item("todo-2"), item("done-1")];
  assert.deepEqual(rowRange(flat, "todo-2", "done-1"), ["todo-2", "done-1"]);
});

test("a row range never selects through a collapsed section: its rows are not visible, so an anchor inside one is null", () => {
  // "hidden" sits in a collapsed section, so the visible list doesn't carry it.
  const visible = [item("a"), item("c")];
  assert.equal(rowRange(visible, "hidden", "c"), null);
  // And a range between two visible rows skips what the collapse hid between them.
  assert.deepEqual(rowRange(visible, "a", "c"), ["a", "c"]);
});

test("a row range with an undrawn anchor or target is null", () => {
  assert.equal(rowRange(rows(), "gone", "c"), null);
  assert.equal(rowRange(rows(), "a", "gone"), null);
  assert.equal(rowRange([], "a", "c"), null);
});

// ------------------------------------------------------ (5) selection modifiers

const press = (mods = {}) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test("the toggle modifier is Cmd on macOS and Ctrl elsewhere, never either", () => {
  assert.deepEqual(selectionMods(press({ metaKey: true }), true), {
    toggle: true,
    range: false,
  });
  assert.deepEqual(selectionMods(press({ ctrlKey: true }), true), {
    toggle: false,
    range: false,
  });
  assert.deepEqual(selectionMods(press({ ctrlKey: true }), false), {
    toggle: true,
    range: false,
  });
  assert.deepEqual(selectionMods(press({ metaKey: true }), false), {
    toggle: false,
    range: false,
  });
});

test("Shift is the range modifier on every platform", () => {
  for (const mac of [true, false])
    assert.deepEqual(selectionMods(press({ shiftKey: true }), mac), {
      toggle: false,
      range: true,
    });
});

test("a mac Ctrl-click is the secondary click, Shift or not; Ctrl elsewhere is not", () => {
  assert.equal(isMacSecondaryClick(press({ ctrlKey: true }), true), true);
  assert.equal(
    isMacSecondaryClick(press({ ctrlKey: true, shiftKey: true }), true),
    true,
  );
  assert.equal(isMacSecondaryClick(press({ metaKey: true }), true), false);
  assert.equal(isMacSecondaryClick(press({ ctrlKey: true }), false), false);
});

// ----------------------------------------------------------- (6) table row model

/** Two sections as the board model buckets them, the second with no items. */
const sections = () => [
  column("todo", [item("t1"), item("t2")]),
  column("doing", []),
  column("done", [item("d1")]),
];

const keys = (entries) => entries.map((entry) => entry.key);

test("grouped rows are each non-empty section's header, then its items", () => {
  assert.deepEqual(keys(tableRows(sections(), true, new Set())), [
    groupRowKey("todo"),
    itemRowKey("t1"),
    itemRowKey("t2"),
    groupRowKey("done"),
    itemRowKey("d1"),
  ]);
});

test("a collapsed section keeps its header and counts, and leaves its items out", () => {
  const entries = tableRows(sections(), true, new Set(["todo"]));
  assert.deepEqual(keys(entries), [
    groupRowKey("todo"),
    groupRowKey("done"),
    itemRowKey("d1"),
  ]);
  assert.equal(entries[0].expanded, false);
  assert.equal(entries[0].count, 2);
});

test("ungrouped rows are the items alone, with no header", () => {
  assert.deepEqual(
    keys(tableRows([column("all", [item("x"), item("y")])], false, new Set())),
    [itemRowKey("x"), itemRowKey("y")],
  );
  assert.deepEqual(tableRows([column("all", [])], false, new Set()), []);
});

test("a removed row's landing is FLAT across sections: an emptied section hands on to the next one's first row", () => {
  const before = tableRows(
    [
      column("todo", [item("t1"), item("t2")]),
      column("doing", [item("g1")]),
      column("done", [item("d1"), item("d2")]),
    ],
    true,
    new Set(),
  );
  const slot = itemRowSlot(before, "g1");
  assert.equal(slot, 2);
  const after = tableRows(
    [
      column("todo", [item("t1"), item("t2")]),
      column("doing", []),
      column("done", [item("d1"), item("d2")]),
    ],
    true,
    new Set(),
  );
  assert.equal(itemAtRowSlot(after, slot), "d1");
  // The last row clamps to the new last; nothing drawn lands nowhere.
  assert.equal(itemAtRowSlot(after, 9), "d2");
  assert.equal(itemAtRowSlot([], 0), null);
  // A collapsed section's rows are not drawn, so they hold no slot.
  const folded = tableRows(sections(), true, new Set(["todo"]));
  assert.equal(itemRowSlot(folded, "t1"), null);
  assert.equal(itemRowSlot(folded, "d1"), 0);
  // Every section folded: no row holds a slot, but the first card still stands,
  // and a cursor on it re-lands on its folded header (the panel composes these).
  const allFolded = tableRows(sections(), true, new Set(["todo", "done"]));
  assert.equal(itemAtRowSlot(allFolded, 0), null);
  assert.deepEqual(firstCardPosition(sections()), { col: 0, idx: 0 });
  assert.deepEqual(
    resolveTableCursor(
      allFolded,
      sections(),
      { rowKey: itemRowKey("t1"), colIndex: 0 },
      3,
    ),
    { rowIndex: 0, colIndex: 0 },
  );
});

test("the cursor resolves by row key, clamped to the columns there are", () => {
  const entries = tableRows(sections(), true, new Set());
  assert.deepEqual(
    resolveTableCursor(
      entries,
      sections(),
      { rowKey: itemRowKey("t2"), colIndex: 9 },
      3,
    ),
    { rowIndex: 2, colIndex: 2 },
  );
  assert.equal(resolveTableCursor(entries, sections(), null, 3), null);
});

test("a cursor inside a section that collapses re-lands on its header, not stranded", () => {
  const entries = tableRows(sections(), true, new Set(["todo"]));
  assert.deepEqual(
    resolveTableCursor(
      entries,
      sections(),
      { rowKey: itemRowKey("t2"), colIndex: 1 },
      3,
    ),
    { rowIndex: 0, colIndex: 1 },
  );
});

test("a cursor on a row the board no longer holds resolves to nothing", () => {
  const entries = tableRows(sections(), true, new Set());
  assert.equal(
    resolveTableCursor(
      entries,
      sections(),
      { rowKey: itemRowKey("gone"), colIndex: 0 },
      3,
    ),
    null,
  );
});

test("the walk steps rows and columns, clamped at every edge", () => {
  const entries = tableRows(sections(), true, new Set());
  const at = (rowIndex, colIndex) => ({ rowIndex, colIndex });
  assert.deepEqual(stepTableCursor(entries, at(1, 1), "down", 3, 5), at(2, 1));
  assert.deepEqual(stepTableCursor(entries, at(0, 1), "up", 3, 5), at(0, 1));
  assert.deepEqual(stepTableCursor(entries, at(4, 1), "down", 3, 5), at(4, 1));
  assert.deepEqual(stepTableCursor(entries, at(1, 2), "right", 3, 5), at(1, 2));
  assert.deepEqual(stepTableCursor(entries, at(1, 0), "left", 3, 5), at(1, 0));
  assert.deepEqual(
    stepTableCursor(entries, at(1, 1), "rowEnd", 3, 5),
    at(1, 2),
  );
  assert.deepEqual(
    stepTableCursor(entries, at(1, 1), "rowStart", 3, 5),
    at(1, 0),
  );
  assert.deepEqual(stepTableCursor(entries, at(2, 1), "first", 3, 5), at(0, 1));
  assert.deepEqual(stepTableCursor(entries, at(1, 1), "last", 3, 5), at(4, 1));
});

test("Page Up and Page Down jump a viewport's worth of rows, clamped", () => {
  const many = tableRows(
    [
      column(
        "all",
        Array.from({ length: 300 }, (_, i) => item(`r${i}`)),
      ),
    ],
    false,
    new Set(),
  );
  const at = (rowIndex) => ({ rowIndex, colIndex: 0 });
  assert.deepEqual(stepTableCursor(many, at(10), "pageDown", 3, 20), at(30));
  assert.deepEqual(stepTableCursor(many, at(290), "pageDown", 3, 20), at(299));
  assert.deepEqual(stepTableCursor(many, at(10), "pageUp", 3, 20), at(0));
  // A viewport too short to hold a row still moves by one.
  assert.deepEqual(stepTableCursor(many, at(10), "pageDown", 3, 0), at(11));
});

test("a group header has one cell: column moves on it do nothing, and the walk keeps its column through it", () => {
  const entries = tableRows(sections(), true, new Set());
  const header = { rowIndex: 3, colIndex: 2 };
  assert.deepEqual(stepTableCursor(entries, header, "left", 3, 5), header);
  assert.deepEqual(stepTableCursor(entries, header, "rowStart", 3, 5), header);
  assert.deepEqual(stepTableCursor(entries, header, "down", 3, 5), {
    rowIndex: 4,
    colIndex: 2,
  });
});

test("the walk skips a collapsed section's rows by construction", () => {
  const entries = tableRows(sections(), true, new Set(["todo"]));
  // From the collapsed header, down lands on the next header, not on t1.
  assert.deepEqual(
    keys([
      entries[
        stepTableCursor(entries, { rowIndex: 0, colIndex: 0 }, "down", 3, 5)
          .rowIndex
      ],
    ]),
    [groupRowKey("done")],
  );
});

// ------------------------------------------------------- (7) table columns & cells

const def = (id, name, kind = "text", extra = {}) => ({
  kind,
  id,
  name,
  isIssueField: false,
  ...extra,
});
const system = (id, name, dataType) => ({ kind: "system", id, name, dataType });

test("columns follow the view's visible order, system fields included, Title pinned first", () => {
  const fields = [
    def("notes", "Notes"),
    system("title", "Title", "TITLE"),
    system("who", "Assignees", "ASSIGNEES"),
  ];
  const view = { visibleFieldIds: ["who", "notes", "title", "missing"] };
  const cols = tableColumns(view, fields);
  assert.deepEqual(
    cols.map((c) => [c.def.id, c.title]),
    [
      ["title", true],
      ["who", false],
      ["notes", false],
    ],
  );
});

test("a view without Title renders what it lists; one that resolves to nothing still gets Title", () => {
  const fields = [def("notes", "Notes")];
  assert.deepEqual(
    tableColumns({ visibleFieldIds: ["notes"] }, fields).map((c) => c.def.id),
    ["notes"],
  );
  const fallback = tableColumns({ visibleFieldIds: [] }, fields);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].title, true);
});

test("a cell reads its field's value by id and kind, and a system column takes any typed arm", () => {
  const notes = def("notes", "Notes");
  const labels = system("labels", "Labels", "LABELS");
  const withValues = {
    ...item("x"),
    fieldValues: [
      {
        kind: "number",
        fieldId: "notes",
        fieldName: "Notes",
        number: 3,
        isIssueField: false,
      },
      {
        kind: "labels",
        fieldId: "labels",
        fieldName: "Labels",
        totalCount: 25,
        labels: Array.from({ length: 20 }, (_, i) => ({
          name: `l${i}`,
          color: "fff",
        })),
        isIssueField: false,
      },
      { kind: "unknown", fieldName: "Mystery" },
    ],
  };
  // A value whose kind disagrees with the definition is not a value of it.
  assert.equal(columnValue(withValues, notes), undefined);
  const cell = columnValue(withValues, labels);
  assert.equal(cell.kind, "labels");
  assert.equal(cell.totalCount - cell.labels.length, 5);
});

test("an item missing half its values leaves those cells blank", () => {
  assert.equal(columnValue(item("x"), def("notes", "Notes")), undefined);
  assert.equal(
    columnValue(item("x"), system("m", "Milestone", "MILESTONE")),
    undefined,
  );
});

test("Assignees and Repository fall back to the item's own content when the field value is absent", () => {
  const issue = {
    ...item("x"),
    content: {
      kind: "issue",
      title: "x",
      repoNameWithOwner: "o/r",
      assignees: [{ login: "ann", avatarUrl: "" }],
    },
  };
  assert.deepEqual(
    columnValue(issue, system("who", "Assignees", "ASSIGNEES")).users.map(
      (u) => u.login,
    ),
    ["ann"],
  );
  assert.equal(
    columnValue(issue, system("repo", "Repository", "REPOSITORY"))
      .nameWithOwner,
    "o/r",
  );
  // A draft has no repository to fall back to.
  const draft = {
    ...item("d"),
    content: { kind: "draft", title: "d", assignees: [] },
  };
  assert.equal(
    columnValue(draft, system("repo", "Repository", "REPOSITORY")),
    undefined,
  );
});

test("a draft's own assignees win over its stale typed value; an issue's typed value wins", () => {
  const who = system("who", "Assignees", "ASSIGNEES");
  const stale = {
    kind: "users",
    fieldId: "who",
    fieldName: "Assignees",
    totalCount: 25,
    users: [{ login: "old", avatarUrl: "" }],
    isIssueField: false,
  };
  const draft = {
    ...item("d"),
    content: {
      kind: "draft",
      title: "d",
      assignees: [{ login: "new", avatarUrl: "" }],
    },
    fieldValues: [stale],
  };
  assert.deepEqual(
    columnValue(draft, who).users.map((u) => u.login),
    ["new"],
  );
  // Unassigning a draft empties the cell, whatever the typed copy still says.
  assert.equal(
    columnValue(
      { ...draft, content: { ...draft.content, assignees: [] } },
      who,
    ),
    undefined,
  );
  const issue = {
    ...item("i"),
    content: {
      kind: "issue",
      title: "i",
      repoNameWithOwner: "o/r",
      assignees: [],
    },
    fieldValues: [stale],
  };
  assert.equal(columnValue(issue, who).totalCount, 25);
});

test("the honoured sort keys drop what can't be ordered; an all-dropped sort is empty", () => {
  const fields = [
    def("notes", "Notes"),
    def("tags", "Tags", "multiSelect", { options: [] }),
    system("who", "Assignees", "ASSIGNEES"),
    system("title", "Title", "TITLE"),
  ];
  const sort = (fieldId) => ({ fieldId, direction: "asc" });
  assert.deepEqual(
    honouredSortKeys([sort("tags"), sort("notes"), sort("title")], fields).map(
      (s) => s.fieldId,
    ),
    ["notes", "title"],
  );
  assert.deepEqual(honouredSortKeys([sort("tags"), sort("who")], fields), []);
});
