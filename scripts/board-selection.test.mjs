// Pins the Projects-board multi-select model: which cards a Shift range covers,
// which of a selection the board still draws, and which of them each bulk verb
// acts on. The bugs these guard against are silent and destructive — a range that
// leaked across columns, or a verb that counted a card the board stopped drawing,
// would archive or remove work the user never selected — so each is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6): stripping ERASES types rather than compiling them and
// resolves no bundler aliases, so `board-selection.ts` must stay import-free
// (types only — its `import type` lines are erased and never resolved). A runtime
// import added there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  columnRange,
  partitionEligible,
  pruneSelection,
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
