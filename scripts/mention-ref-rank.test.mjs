// Pins the composer's reference ranking (src/features/conversations/
// mention-ref-rank.ts): text rank first, then open-before-closed, then recency;
// a number both the open and closed reads returned keeps the first (open) row;
// the slice applies after dedupe and ordering. The open tier must agree with
// the Open tab's predicate (src/lib/remote-state-filter.ts).
//
// The imports reach straight into `src/` under Node's type stripping, so both
// modules must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ROWS,
  PARTIAL_FAILURE_MESSAGE,
  rankRefs,
  refInputRows,
  refStateTier,
  showsPartialFailure,
} from "../src/features/conversations/mention-ref-rank.ts";
import { remoteStateMatches } from "../src/lib/remote-state-filter.ts";

function row(
  number,
  title,
  state,
  sortAt,
  { isPr = false, isDraft = false } = {},
) {
  return { number, title, state, isPr, isDraft, sortAt };
}

const ids = (rows) => rows.map((r) => `${r.isPr ? "pr" : "issue"}:${r.number}`);

test("at an equal text rank an open row beats a newer closed row", () => {
  const ranked = rankRefs(
    [
      row(1, "Fix login", "CLOSED", "2026-10-30T00:00:00Z"),
      row(2, "Fix logout", "OPEN", "2026-01-01T00:00:00Z"),
      row(3, "Fix layout", "MERGED", "2026-10-31T00:00:00Z", { isPr: true }),
    ],
    "fix",
  );
  assert.deepEqual(ids(ranked), ["issue:2", "pr:3", "issue:1"]);
});

test("a closed prefix match outranks an open substring match", () => {
  const ranked = rankRefs(
    [
      row(1, "Crash on save", "OPEN", "2026-10-31T00:00:00Z"),
      row(2, "Save dialog crash", "CLOSED", "2026-01-01T00:00:00Z"),
    ],
    "save",
  );
  assert.deepEqual(ids(ranked), ["issue:2", "issue:1"]);
});

test("a number in both reads renders once, the open page's row winning", () => {
  const ranked = rankRefs(
    [
      row(7, "Flaky test", "OPEN", "2026-10-01T00:00:00Z", { isPr: true }),
      row(7, "Flaky test", "MERGED", "2026-10-02T00:00:00Z", { isPr: true }),
    ],
    "",
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].state, "OPEN");
});

test("an issue and a PR sharing a number are two rows", () => {
  const ranked = rankRefs(
    [
      row(5, "Issue five", "OPEN", "2026-10-01T00:00:00Z"),
      row(5, "PR five", "OPEN", "2026-10-02T00:00:00Z", { isPr: true }),
    ],
    "",
  );
  assert.deepEqual(ids(ranked), ["pr:5", "issue:5"]);
});

test("a numeric query matches by number prefix across both tiers", () => {
  const ranked = rankRefs(
    [
      row(12, "Twelve", "CLOSED", "2026-10-31T00:00:00Z"),
      row(120, "One twenty", "OPEN", "2026-01-01T00:00:00Z", { isPr: true }),
      row(21, "Has 12 in title", "OPEN", "2026-10-31T00:00:00Z"),
      row(1, "One", "OPEN", "2026-10-31T00:00:00Z"),
    ],
    "12",
  );
  assert.deepEqual(ids(ranked), ["pr:120", "issue:12"]);
});

test("a draft ties as open; LOCKED and unknown states tie as closed", () => {
  assert.equal(refStateTier("OPEN"), 0);
  assert.equal(refStateTier("LOCKED"), 1);
  assert.equal(refStateTier("SOMETHING_NEW"), 1);
  const ranked = rankRefs(
    [
      row(1, "a", "LOCKED", "2026-10-31T00:00:00Z", { isPr: true }),
      row(2, "a", "OPEN", "2026-01-01T00:00:00Z", {
        isPr: true,
        isDraft: true,
      }),
      row(3, "a", "SOMETHING_NEW", "2026-10-30T00:00:00Z", { isPr: true }),
      row(4, "a", "OPEN", "2026-02-01T00:00:00Z", { isPr: true }),
    ],
    "a",
  );
  assert.deepEqual(ids(ranked), ["pr:4", "pr:2", "pr:1", "pr:3"]);
});

test("more matches than MAX_ROWS slice after dedupe and ordering", () => {
  assert.equal(MAX_ROWS, 8);
  const rows = [];
  // Ten closed rows listed first, all newer than the open ones.
  for (let n = 1; n <= 10; n++) {
    rows.push(
      row(n, `item ${n}`, "CLOSED", `2026-10-${String(n + 10)}T00:00:00Z`),
    );
  }
  // A duplicate of #1 (dropped: the first listing wins) and three open rows.
  rows.push(row(1, "item 1", "OPEN", "2026-10-31T00:00:00Z"));
  for (let n = 11; n <= 13; n++) {
    rows.push(row(n, `item ${n}`, "OPEN", `2026-01-0${n - 10}T00:00:00Z`));
  }
  const ranked = rankRefs(rows, "item");
  assert.equal(ranked.length, MAX_ROWS);
  assert.deepEqual(ids(ranked), [
    "issue:13",
    "issue:12",
    "issue:11",
    "issue:10",
    "issue:9",
    "issue:8",
    "issue:7",
    "issue:6",
  ]);
  assert.equal(ranked.filter((r) => r.number === 1).length, 0);
});

test("all-equal rows hold their input order", () => {
  const rows = [5, 3, 9, 1, 7].map((n) =>
    row(n, "same", "OPEN", "2026-10-01T00:00:00Z"),
  );
  assert.deepEqual(
    rankRefs(rows, "same").map((r) => r.number),
    [5, 3, 9, 1, 7],
  );
});

test("an empty query ranks every row equally: tier, then recency", () => {
  const ranked = rankRefs(
    [
      row(1, "x", "CLOSED", "2026-10-31T00:00:00Z"),
      row(2, "y", "OPEN", "2026-10-01T00:00:00Z"),
      row(3, "z", "MERGED", "2026-10-15T00:00:00Z", { isPr: true }),
      row(4, "w", "OPEN", "2026-10-20T00:00:00Z", { isPr: true }),
    ],
    "",
  );
  assert.deepEqual(ids(ranked), ["pr:4", "issue:2", "issue:1", "pr:3"]);
});

test("the open tier agrees with the Open tab's predicate", () => {
  for (const state of ["OPEN", "CLOSED", "MERGED", "LOCKED"]) {
    assert.equal(
      refStateTier(state) === 0,
      remoteStateMatches(state, "open"),
      state,
    );
  }
});

test("refInputRows lists the open read first, so its twin wins", () => {
  const open = [row(7, "Flaky test", "OPEN", "2026-10-01T00:00:00Z")];
  const closed = [row(7, "Flaky test", "CLOSED", "2026-10-02T00:00:00Z")];
  const ranked = rankRefs(refInputRows(open, closed), "");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].state, "OPEN");
  // Negative control: the swapped order keeps the closed twin instead.
  assert.equal(rankRefs([...closed, ...open], "")[0].state, "CLOSED");
});

test("partial-failure line: only over rows, only on a failure", () => {
  assert.equal(PARTIAL_FAILURE_MESSAGE, "Some suggestions couldn't load");
  assert.equal(showsPartialFailure(3, true), true);
  // Loading alone never shows it; the all-empty case keeps the empty message.
  assert.equal(showsPartialFailure(3, false), false);
  assert.equal(showsPartialFailure(0, true), false);
  assert.equal(showsPartialFailure(0, false), false);
});
