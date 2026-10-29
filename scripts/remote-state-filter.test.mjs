// Pins the Open/Closed tab predicate the PR and issue lists share. A wrong
// answer here never errors: a merged row lingers under Open, or a placeholder
// page of the other tab filters to nothing and flashes the empty copy, so each
// state and each placeholder arm is a case. The placeholder filter the list
// hooks run and the row patch a merge, close or reopen writes into cached pages
// are pinned here too, identity included: both feed react-query's cache.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `remote-state-filter.ts`
// may import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterPlaceholderRows,
  filterRemoteRows,
  localStateMatches,
  patchRowState,
  remoteStateMatches,
} from "../src/lib/remote-state-filter.ts";

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

test("placeholder: a same-state page is filed by its rows' own state", () => {
  // An Open page kept across Load more or a filter change still carries a row
  // the forge merged before its open-list membership caught up.
  const page = [row(1, "OPEN"), row(2, "MERGED"), row(3, "OPEN")];
  assert.deepEqual(
    filterPlaceholderRows(page, "open", "open").map((r) => r.number),
    [1, 3],
  );
  const closed = [row(4, "CLOSED"), row(5, "OPEN"), row(6, "MERGED")];
  assert.deepEqual(
    filterPlaceholderRows(closed, "closed", "closed").map((r) => r.number),
    [4, 6],
  );
});

test("placeholder: a cross-state page passes whole, as the same array", () => {
  // The Closed tab's page served while the Open tab's own read is in flight.
  const otherTab = [row(7, "MERGED"), row(8, "CLOSED")];
  assert.equal(filterPlaceholderRows(otherTab, "open", "closed"), otherTab);
  const openTab = [row(9, "OPEN")];
  assert.equal(filterPlaceholderRows(openTab, "closed", "open"), openTab);
});

test("placeholder: an unknown source state passes the page whole", () => {
  const page = [row(10, "MERGED"), row(11, "OPEN")];
  for (const source of [undefined, null, "OPEN", "", 4]) {
    assert.equal(
      filterPlaceholderRows(page, "open", source),
      page,
      String(source),
    );
  }
});

test("placeholder: the same page and tab give back the same filtered array", () => {
  const page = [row(12, "OPEN"), row(13, "CLOSED")];
  const first = filterPlaceholderRows(page, "open", "open");
  assert.notEqual(first, page);
  assert.equal(filterPlaceholderRows(page, "open", "open"), first);
  // Another page with equal rows is its own entry, never the first page's.
  const twin = [...page];
  const other = filterPlaceholderRows(twin, "open", "open");
  assert.notEqual(other, first);
  assert.deepEqual(other, first);
});

test("placeholder: a non-empty page that files down to nothing serves no placeholder", () => {
  // The section shows its loading state, never the empty copy its read hasn't
  // answered with yet.
  const page = [row(14, "MERGED"), row(15, "CLOSED")];
  assert.equal(filterPlaceholderRows(page, "open", "open"), undefined);
  assert.equal(filterPlaceholderRows(page, "open", "open"), undefined);
  // The same page on the other tab still passes whole.
  assert.equal(filterPlaceholderRows(page, "closed", "open"), page);
});

test("placeholder: an empty page stays an empty placeholder, with a stable identity", () => {
  const empty = [];
  const first = filterPlaceholderRows(empty, "open", "open");
  assert.deepEqual(first, []);
  assert.equal(filterPlaceholderRows(empty, "open", "open"), first);
  assert.equal(filterPlaceholderRows(empty, "closed", "open"), empty);
});

test("patch: only the named row is re-filed, the rest keep their objects", () => {
  const a = { number: 1, state: "OPEN", title: "a" };
  const b = { number: 2, state: "OPEN", title: "b" };
  const c = { number: 3, state: "CLOSED", title: "c" };
  const page = [a, b, c];
  const out = patchRowState(page, 2, "MERGED");
  assert.notEqual(out, page);
  assert.deepEqual(
    out.map((r) => [r.number, r.state]),
    [
      [1, "OPEN"],
      [2, "MERGED"],
      [3, "CLOSED"],
    ],
  );
  assert.equal(out[0], a);
  assert.equal(out[2], c);
  assert.equal(out[1].title, "b");
  assert.equal(b.state, "OPEN", "the cached row object is never mutated");
});

test("patch: a page without the row is returned as the same array", () => {
  const page = [row(4, "OPEN"), row(5, "CLOSED")];
  assert.equal(patchRowState(page, 99, "CLOSED"), page);
  const empty = [];
  assert.equal(patchRowState(empty, 4, "CLOSED"), empty);
});

test("patch: a row already in that state leaves the page as the same array", () => {
  const page = [row(6, "OPEN"), row(7, "MERGED")];
  assert.equal(patchRowState(page, 7, "MERGED"), page);
  const once = patchRowState(page, 6, "CLOSED");
  assert.notEqual(once, page);
  assert.equal(patchRowState(once, 6, "CLOSED"), once);
});

test("patch: an absent page stays absent", () => {
  assert.equal(patchRowState(undefined, 1, "OPEN"), undefined);
});

test("patch: a cached page that isn't an array comes back as it is, never a throw", () => {
  // A success callback runs the patch; a throw there would report a landed
  // close or reopen as failed.
  const shapes = [
    null,
    {},
    { length: 1, 0: row(1, "OPEN") },
    { some: () => true, map: () => [] },
    "rows",
    42,
  ];
  for (const page of shapes) {
    assert.equal(patchRowState(page, 1, "CLOSED"), page, String(page));
  }
});

test("patch: a reopen re-files a closed row under Open", () => {
  const page = [row(8, "CLOSED"), row(9, "CLOSED")];
  const out = patchRowState(page, 8, "OPEN");
  assert.deepEqual(
    filterRemoteRows(out, "open", false).map((r) => r.number),
    [8],
  );
});
