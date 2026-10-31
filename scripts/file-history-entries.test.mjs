// Pins the file-history dialog's entry helpers
// (src/features/history/file-history-entries.ts): each commit's diff reads the
// file under its name AS OF that commit, and pages appended by Load more never
// duplicate a row or reorder the list.
//
// Not testable here: the dialog's wiring of these into the diff slot and the
// arrow-key cursor across an append. The live drive covers those.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dedupeByHash,
  entryPathFor,
} from "../src/features/history/file-history-entries.ts";

// Newest first, as git_file_log returns them: the rename commit carries the
// NEW name, every commit before it the OLD one.
const ENTRIES = [
  { hash: "c4", path: "src/new-name.css" },
  { hash: "c3", path: "src/new-name.css" }, // the rename commit
  { hash: "c2", path: "src/old-name.css" },
  { hash: "c1", path: "src/old-name.css" },
];
const DIALOG_PATH = "src/new-name.css";

test("entryPathFor hands the rename commit its new name", () => {
  assert.equal(entryPathFor(ENTRIES, "c3", DIALOG_PATH), "src/new-name.css");
});

test("entryPathFor hands a pre-rename commit its old name", () => {
  assert.equal(entryPathFor(ENTRIES, "c2", DIALOG_PATH), "src/old-name.css");
  assert.equal(entryPathFor(ENTRIES, "c1", DIALOG_PATH), "src/old-name.css");
});

test("entryPathFor falls back to the dialog path for an unloaded hash", () => {
  assert.equal(entryPathFor(ENTRIES, "c0", DIALOG_PATH), DIALOG_PATH);
  assert.equal(entryPathFor([], "c3", DIALOG_PATH), DIALOG_PATH);
});

test("entryPathFor returns hostile names verbatim", () => {
  const entries = [
    { hash: "a", path: "[slug]/a.txt" },
    { hash: "b", path: "dir/sägen.txt" },
  ];
  assert.equal(entryPathFor(entries, "a", "x"), "[slug]/a.txt");
  assert.equal(entryPathFor(entries, "b", "x"), "dir/sägen.txt");
});

test("dedupeByHash keeps the first occurrence and the order across pages", () => {
  // A commit landing between page fetches shifts the offset window, so page 2
  // can repeat page 1's last row.
  const page1 = [
    { hash: "c5", path: "p", page: 1 },
    { hash: "c4", path: "p", page: 1 },
  ];
  const page2 = [
    { hash: "c4", path: "p", page: 2 },
    { hash: "c3", path: "p", page: 2 },
  ];
  const out = dedupeByHash([...page1, ...page2]);
  assert.deepEqual(
    out.map((e) => e.hash),
    ["c5", "c4", "c3"],
  );
  assert.equal(out[1].page, 1);
  assert.equal(out[1], page1[1]);
});

test("dedupeByHash leaves a duplicate-free list and an empty one intact", () => {
  assert.deepEqual(
    dedupeByHash(ENTRIES).map((e) => e.hash),
    ["c4", "c3", "c2", "c1"],
  );
  assert.deepEqual(dedupeByHash([]), []);
});

test("selection survives an append: the cursor index derives from the hash", () => {
  // The dialog's arrow cursor is `commits.findIndex(c => c.hash === active)`;
  // appending a page (with an overlap) never moves an already-loaded row.
  const before = dedupeByHash(ENTRIES.slice(0, 2));
  const after = dedupeByHash([...ENTRIES.slice(0, 2), ...ENTRIES.slice(1)]);
  for (const { hash } of before) {
    assert.equal(
      after.findIndex((e) => e.hash === hash),
      before.findIndex((e) => e.hash === hash),
    );
  }
});
