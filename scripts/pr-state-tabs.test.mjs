// Pins the PR panel's Merged and Closed tabs: the "merged" and "unmerged"
// predicates, the placeholder pairs a switch between the three tabs serves, and
// the align that picks the tab a navigation lands on. A wrong answer never
// errors: a merged PR lingers under Closed, a switch flashes the empty copy, or
// a notification opens a PR on a tab that will never list it. The legacy
// "open"/"closed" semantics stay pinned by remote-state-filter.test.mjs.
//
// The import reaches straight into `src/` under Node's type stripping (>= 23.6),
// which resolves no bundler aliases: `remote-state-filter.ts` may import types
// only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterPlaceholderRows,
  filterRemoteRows,
  localPrAlignTab,
  localStateMatches,
  prAlignTab,
  remoteStateMatches,
} from "../src/lib/remote-state-filter.ts";

const row = (number, state) => ({ number, state });

/** Every forge state shape the tabs must file, casing traps included. */
const REMOTE_STATES = ["OPEN", "MERGED", "CLOSED", "LOCKED", "", "Merged"];
const LOCAL_STATUSES = ["open", "merged", "closed", "wip", "OPEN", ""];

test("remote: MERGED alone is the Merged tab's", () => {
  const expected = {
    OPEN: false,
    MERGED: true,
    CLOSED: false,
    LOCKED: false,
    "": false,
    Merged: false,
  };
  for (const state of REMOTE_STATES)
    assert.equal(remoteStateMatches(state, "merged"), expected[state], state);
});

test("remote: every state but OPEN and MERGED is the Closed (unmerged) tab's", () => {
  const expected = {
    OPEN: false,
    MERGED: false,
    CLOSED: true,
    LOCKED: true,
    "": true,
    Merged: true,
  };
  for (const state of REMOTE_STATES)
    assert.equal(remoteStateMatches(state, "unmerged"), expected[state], state);
});

test("remote: each state lands on exactly one of the three PR tabs", () => {
  for (const state of REMOTE_STATES) {
    const hits = ["open", "merged", "unmerged"].filter((tab) =>
      remoteStateMatches(state, tab),
    );
    assert.equal(hits.length, 1, `${state}: ${hits.join(",")}`);
  }
});

test("local: merged is the Merged tab's; closed and any unknown status are Closed's", () => {
  const merged = { open: false, merged: true, closed: false };
  const unmerged = { open: false, merged: false, closed: true };
  for (const status of ["open", "merged", "closed"]) {
    assert.equal(localStateMatches(status, "merged"), merged[status], status);
    assert.equal(
      localStateMatches(status, "unmerged"),
      unmerged[status],
      status,
    );
  }
  // A hand-edited or newer-build status stays under Closed, as before the split.
  for (const status of ["wip", "OPEN", "Merged", ""]) {
    assert.equal(localStateMatches(status, "merged"), false, status);
    assert.equal(localStateMatches(status, "unmerged"), true, status);
  }
});

test("local: each status lands on exactly one of the three PR tabs", () => {
  for (const status of LOCAL_STATUSES) {
    const hits = ["open", "merged", "unmerged"].filter((tab) =>
      localStateMatches(status, tab),
    );
    assert.equal(hits.length, 1, `${status}: ${hits.join(",")}`);
  }
});

test("rows: a Merged page keeps merged rows only, a Closed page drops merged and reopened rows", () => {
  const page = [
    row(1, "OPEN"),
    row(2, "MERGED"),
    row(3, "CLOSED"),
    row(4, "LOCKED"),
    row(5, ""),
    row(6, "Merged"),
  ];
  assert.deepEqual(
    filterRemoteRows(page, "merged", false).map((r) => r.number),
    [2],
  );
  assert.deepEqual(
    filterRemoteRows(page, "unmerged", false).map((r) => r.number),
    [3, 4, 5, 6],
  );
  assert.deepEqual(filterRemoteRows([], "merged", false), []);
});

test("placeholder: every cross-tab pair passes the other tab's page whole, as the same array", () => {
  const pages = {
    open: [row(1, "OPEN")],
    merged: [row(2, "MERGED")],
    unmerged: [row(3, "CLOSED")],
  };
  for (const [from, page] of Object.entries(pages)) {
    for (const to of ["open", "merged", "unmerged"]) {
      if (to === from) continue;
      assert.equal(
        filterPlaceholderRows(page, to, from),
        page,
        `${from}->${to}`,
      );
    }
  }
});

test("placeholder: a same-state page is filed by its rows' own state", () => {
  // A Merged page kept across Load more cannot lose a row (merges are final);
  // a Closed page kept across a filter change drops a row reopened since.
  const merged = [row(1, "MERGED"), row(2, "MERGED")];
  assert.deepEqual(
    filterPlaceholderRows(merged, "merged", "merged").map((r) => r.number),
    [1, 2],
  );
  const unmerged = [row(3, "CLOSED"), row(4, "OPEN"), row(5, "MERGED")];
  assert.deepEqual(
    filterPlaceholderRows(unmerged, "unmerged", "unmerged").map(
      (r) => r.number,
    ),
    [3],
  );
});

test("placeholder: a non-empty page that files down to nothing serves no placeholder", () => {
  const page = [row(6, "CLOSED"), row(7, "OPEN")];
  assert.equal(filterPlaceholderRows(page, "merged", "merged"), undefined);
  // The same page still passes whole to another tab.
  assert.equal(filterPlaceholderRows(page, "unmerged", "merged"), page);
  const empty = [];
  assert.deepEqual(filterPlaceholderRows(empty, "merged", "merged"), []);
});

test("align: a remote PR's state picks its tab exactly", () => {
  assert.equal(prAlignTab("OPEN"), "open");
  assert.equal(prAlignTab("MERGED"), "merged");
  for (const state of ["CLOSED", "LOCKED", "", "Merged", "open"])
    assert.equal(prAlignTab(state), "unmerged", state);
});

test("align: a remote PR always lands on a tab that lists it", () => {
  for (const state of REMOTE_STATES)
    assert.equal(remoteStateMatches(state, prAlignTab(state)), true, state);
});

/** Stored local statuses are untrusted: hand-edited, from a newer build, or
 *  not a string at all. */
const HOSTILE_LOCAL_STATUSES = [
  "wip",
  "OPEN",
  "Merged",
  "",
  "toString",
  "__proto__",
  "constructor",
  undefined,
  null,
  0,
  {},
];

test("align: a local PR's status picks its tab, an unknown one picks Closed", () => {
  assert.equal(localPrAlignTab("open"), "open");
  assert.equal(localPrAlignTab("merged"), "merged");
  assert.equal(localPrAlignTab("closed"), "unmerged");
  for (const status of HOSTILE_LOCAL_STATUSES)
    assert.equal(localPrAlignTab(status), "unmerged", String(status));
});

test("align: every local status, hostile ones included, lands on a tab that lists it", () => {
  for (const status of [
    "open",
    "merged",
    "closed",
    ...HOSTILE_LOCAL_STATUSES,
  ]) {
    // The list filters the raw stored value, which may not be a string.
    assert.equal(
      localStateMatches(status, localPrAlignTab(status)),
      true,
      String(status),
    );
  }
});
