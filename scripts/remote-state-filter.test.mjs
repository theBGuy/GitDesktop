// Pins the Open/Closed tab predicate the PR and issue lists share. A wrong
// answer here never errors: a merged row lingers under Open, or a placeholder
// page of the other tab filters to nothing and flashes the empty copy, so each
// state and each placeholder arm is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `remote-state-filter.ts`
// may import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterRemoteRows,
  localStateMatches,
  remoteStateMatches,
} from "../src/features/conversations/remote-state-filter.ts";

const row = (number, state) => ({ number, state });

test("remote: OPEN is the Open tab's alone", () => {
  assert.equal(remoteStateMatches("OPEN", "open"), true);
  assert.equal(remoteStateMatches("OPEN", "closed"), false);
});

test("remote: MERGED, CLOSED and an unknown state land in Closed", () => {
  for (const state of ["MERGED", "CLOSED", "LOCKED"]) {
    assert.equal(remoteStateMatches(state, "open"), false, state);
    assert.equal(remoteStateMatches(state, "closed"), true, state);
  }
});

test("remote: the match is exact, never a case fold", () => {
  assert.equal(remoteStateMatches("open", "open"), false);
  assert.equal(remoteStateMatches("", "open"), false);
  assert.equal(remoteStateMatches("", "closed"), true);
});

test("local: open is the Open tab's alone, anything else is Closed", () => {
  assert.equal(localStateMatches("open", "open"), true);
  assert.equal(localStateMatches("open", "closed"), false);
  for (const status of ["closed", "merged", "locked", "OPEN"]) {
    assert.equal(localStateMatches(status, "open"), false, status);
    assert.equal(localStateMatches(status, "closed"), true, status);
  }
});

test("rows: an Open page drops the merged and closed rows it still carries", () => {
  const page = [
    row(1, "OPEN"),
    row(2, "MERGED"),
    row(3, "OPEN"),
    row(4, "CLOSED"),
  ];
  assert.deepEqual(
    filterRemoteRows(page, "open", false).map((r) => r.number),
    [1, 3],
  );
});

test("rows: a Closed page drops a reopened row and keeps an unknown state", () => {
  const page = [row(5, "CLOSED"), row(6, "OPEN"), row(7, "LOCKED")];
  assert.deepEqual(
    filterRemoteRows(page, "closed", false).map((r) => r.number),
    [5, 7],
  );
});

test("rows: a non-empty page can filter to empty, and an empty page stays empty", () => {
  assert.deepEqual(
    filterRemoteRows([row(8, "MERGED"), row(9, "CLOSED")], "open", false),
    [],
  );
  assert.deepEqual(filterRemoteRows([], "open", false), []);
  assert.deepEqual(filterRemoteRows([], "closed", true), []);
});

test("rows: a placeholder passes through untouched, the other tab's rows included", () => {
  // The Closed tab's page served as the Open tab's placeholder on a tab switch.
  const otherTab = [row(10, "MERGED"), row(11, "CLOSED")];
  const out = filterRemoteRows(otherTab, "open", true);
  assert.deepEqual(out, otherTab);
  assert.equal(out.length, 2);
  const openTab = [row(12, "OPEN")];
  assert.deepEqual(filterRemoteRows(openTab, "closed", true), openTab);
});

test("rows: filtering keeps the rows' own objects and order", () => {
  const a = { number: 1, state: "OPEN", title: "a" };
  const b = { number: 2, state: "OPEN", title: "b" };
  const out = filterRemoteRows([b, row(3, "MERGED"), a], "open", false);
  assert.equal(out[0], b);
  assert.equal(out[1], a);
});
