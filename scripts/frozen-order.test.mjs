// Pins the frozen-order helper the repo list holds its rows with while an open
// is in flight: the recents write moves the opened row to the top before the
// switch lands, and a list that followed it would reorder (and regroup) under the
// pointer. RepoList applies the order BEFORE its Recent slice and owner grouping,
// so the slice cases below replay that composition.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so `frozen-order.ts` must
// stay import-free (types only). Node's stdlib test runner only, no dev dependency:
// the CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFrozenOrder, frozenPathKey } from "../src/lib/frozen-order.ts";

const RECENT_COUNT = 5;
const row = (path, owner = "acme") => ({ path, owner });
const keyOf = (r) => frozenPathKey(r.path);
const paths = (rows) => rows.map((r) => r.path);
/** The snapshot RepoList takes at the click: its recents order before the filter
 *  and the grouping, normalized. */
const snapshot = (rows) => rows.map(keyOf);
/** addRecent's effect on the live list: the opened row moves to the front, with
 *  its path respelled the way validateRepo returns the root. */
const reopen = (rows, path, respelled = path) => [
  { ...rows.find((r) => r.path === path), path: respelled },
  ...rows.filter((r) => r.path !== path),
];

test("a null snapshot returns the live order untouched", () => {
  const live = [row("C:/a"), row("C:/b"), row("C:/c")];
  assert.equal(applyFrozenOrder(live, null, keyOf), live);
});

test("the opened row stays in its slot after addRecent prepends it", () => {
  const before = [row("C:/a"), row("C:/b"), row("C:/c"), row("C:/d")];
  const after = reopen(before, "C:/c");
  assert.deepEqual(paths(after), ["C:/c", "C:/a", "C:/b", "C:/d"]);
  assert.deepEqual(paths(applyFrozenOrder(after, snapshot(before), keyOf)), [
    "C:/a",
    "C:/b",
    "C:/c",
    "C:/d",
  ]);
});

test("a row outside the top five keeps its owner group, not the Recent slice", () => {
  const before = [
    row("C:/r1"),
    row("C:/r2"),
    row("C:/r3"),
    row("C:/r4"),
    row("C:/r5"),
    row("C:/far", "elsewhere"),
  ];
  const after = reopen(before, "C:/far");
  // Unfrozen, the live order would pull the row into Recent.
  assert.ok(paths(after.slice(0, RECENT_COUNT)).includes("C:/far"));
  const held = applyFrozenOrder(after, snapshot(before), keyOf);
  assert.deepEqual(paths(held.slice(0, RECENT_COUNT)), [
    "C:/r1",
    "C:/r2",
    "C:/r3",
    "C:/r4",
    "C:/r5",
  ]);
  assert.deepEqual(paths(held.slice(RECENT_COUNT)), ["C:/far"]);
  assert.equal(held[RECENT_COUNT].owner, "elsewhere");
});

test("matching ignores path case and separators", () => {
  assert.equal(frozenPathKey("C:\\Repo"), frozenPathKey("c:/repo"));
  const before = [row("c:/repo"), row("C:/other")];
  // validateRepo hands back the Windows spelling; the snapshot still finds it.
  const after = reopen(before, "C:/other", "C:\\Other");
  assert.deepEqual(paths(applyFrozenOrder(after, snapshot(before), keyOf)), [
    "c:/repo",
    "C:\\Other",
  ]);
});

test("row data stays live while the order holds", () => {
  const before = [row("C:/a"), row("C:/b")];
  const after = [{ ...row("C:/b"), alias: "renamed" }, row("C:/a")];
  const held = applyFrozenOrder(after, snapshot(before), keyOf);
  assert.deepEqual(paths(held), ["C:/a", "C:/b"]);
  assert.equal(held[1].alias, "renamed");
});

test("new rows append in live order, and rows gone from the live list drop out", () => {
  const before = [row("C:/a"), row("C:/b"), row("C:/c")];
  const after = [row("C:/n2"), row("C:/c"), row("C:/n1"), row("C:/a")];
  assert.deepEqual(paths(applyFrozenOrder(after, snapshot(before), keyOf)), [
    "C:/a",
    "C:/c",
    "C:/n2",
    "C:/n1",
  ]);
});

test("an empty live list stays empty", () => {
  assert.deepEqual(applyFrozenOrder([], ["c:/a"], keyOf), []);
});

test("an empty snapshot keeps the live order", () => {
  const live = [row("C:/b"), row("C:/a")];
  assert.deepEqual(paths(applyFrozenOrder(live, [], keyOf)), ["C:/b", "C:/a"]);
});
