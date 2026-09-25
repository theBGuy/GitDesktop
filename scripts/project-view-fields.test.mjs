// Pins the saved-view fields editor's write: which field ids a view shows after
// the editor, in which order. GitHub stores the checked set in the project's
// field-DEFINITION order whatever order a write sends (measured live), so the
// optimistic patch has to produce that same order or the columns reshuffle when
// the answer lands. A wrong list never errors, so each rule is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `board-model.ts` must
// stay import-free (types only). A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { nextVisibleFieldIds } from "../src/features/projects/board-model.ts";

const title = { kind: "system", id: "title", name: "Title", dataType: "TITLE" };
const text = (id) => ({ kind: "text", id, name: id, isIssueField: false });
const DEFS = [title, text("status"), text("priority"), text("estimate")];

test("output follows definition order, not the view's current order", () => {
  assert.deepEqual(
    nextVisibleFieldIds(
      ["estimate", "title", "status"],
      DEFS,
      new Set(["title", "status", "estimate"]),
    ),
    ["title", "status", "estimate"],
  );
});

test("a newly checked field lands in its definition slot, not at the end", () => {
  assert.deepEqual(
    nextVisibleFieldIds(
      ["title", "estimate"],
      DEFS,
      new Set(["title", "estimate", "status"]),
    ),
    ["title", "status", "estimate"],
  );
});

test("an unchecked field leaves and the rest close ranks", () => {
  assert.deepEqual(
    nextVisibleFieldIds(
      ["title", "status", "priority"],
      DEFS,
      new Set(["title", "priority"]),
    ),
    ["title", "priority"],
  );
});

test("Title stays even when the checked set leaves it out", () => {
  assert.deepEqual(
    nextVisibleFieldIds(["status", "title"], DEFS, new Set(["status"])),
    ["title", "status"],
  );
  // A view that never showed it gains it rather than going empty.
  assert.deepEqual(nextVisibleFieldIds([], DEFS, new Set()), ["title"]);
});

test("an id the editor never offered is kept, after the offered ones", () => {
  assert.deepEqual(
    nextVisibleFieldIds(
      ["beyond-cap", "title", "status"],
      DEFS,
      new Set(["title"]),
    ),
    ["title", "beyond-cap"],
  );
});

test("duplicates collapse", () => {
  assert.deepEqual(
    nextVisibleFieldIds(
      ["title", "status", "status"],
      DEFS,
      new Set(["title", "status"]),
    ),
    ["title", "status"],
  );
});

test("no definitions at all keeps the view exactly as it was", () => {
  assert.deepEqual(nextVisibleFieldIds(["a", "b"], [], new Set()), ["a", "b"]);
});
