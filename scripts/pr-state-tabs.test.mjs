// Pins the PR panel's Merged and Closed tabs: the "merged" and "unmerged"
// predicates, the placeholder pairs a switch between the three tabs serves, and
// the align that picks the tab a navigation lands on, with the hold a GitLab MR
// takes while its merge runs. A wrong answer never errors: a merged PR lingers
// under Closed, a switch flashes the empty copy, or a notification opens a PR
// on a tab that will never list it. The legacy "open"/"closed" semantics stay
// pinned by remote-state-filter.test.mjs.
//
// The import reaches straight into `src/` under Node's type stripping (>= 23.6),
// which resolves no bundler aliases: `remote-state-filter.ts` may import types
// only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cascadedStackNumbers,
  filterPlaceholderRows,
  filterRemoteRows,
  localPrAlignTab,
  localStateMatches,
  prAlignStep,
  prAlignTab,
  remoteStateMatches,
} from "../src/lib/remote-state-filter.ts";

const row = (number, state) => ({ number, state });

/** Every forge state shape the tabs must file, casing traps included. */
const REMOTE_STATES = [
  "OPEN",
  "MERGED",
  "CLOSED",
  "MERGING",
  "WEIRD",
  "",
  "Merged",
];
const LOCAL_STATUSES = ["open", "merged", "closed", "wip", "OPEN", ""];

test("remote: MERGED alone is the Merged tab's", () => {
  const expected = {
    OPEN: false,
    MERGED: true,
    CLOSED: false,
    MERGING: false,
    WEIRD: false,
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
    MERGING: true,
    WEIRD: true,
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
    row(4, "MERGING"),
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
  for (const state of ["CLOSED", "MERGING", "WEIRD", "", "Merged", "open"])
    assert.equal(prAlignTab(state), "unmerged", state);
});

test("align: a remote PR's state names the tab whose predicate lists it", () => {
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

/** A stack of three, bottom-first, as cached PR details carry it. */
const member = (number, position, state) => ({ number, position, state });
const STACK = [
  member(11, 1, "open"),
  member(12, 2, "OPEN"),
  member(13, 3, "open"),
];

test("cascade: a merge takes the open layers below it, whatever the state's case", () => {
  assert.deepEqual(cascadedStackNumbers(STACK, 3), [11, 12]);
  assert.deepEqual(cascadedStackNumbers(STACK, 2), [11]);
  assert.deepEqual(cascadedStackNumbers(STACK, 1), []);
});

test("cascade: a layer already merged or closed is not taken", () => {
  const members = [
    member(11, 1, "merged"),
    member(12, 2, "closed"),
    member(13, 3, "open"),
    member(14, 4, "open"),
  ];
  assert.deepEqual(cascadedStackNumbers(members, 4), [13]);
});

test("cascade: an unread or empty member list takes nothing", () => {
  assert.deepEqual(cascadedStackNumbers([], 3), []);
  for (const members of [undefined, null, "11", 11, {}])
    assert.deepEqual(cascadedStackNumbers(members, 3), [], String(members));
  for (const position of [undefined, null, "3", Number.NaN, Infinity])
    assert.deepEqual(
      cascadedStackNumbers(STACK, position),
      [],
      String(position),
    );
});

test("cascade: a malformed member is skipped, never a throw", () => {
  const members = [
    null,
    "12",
    7,
    { number: 7, position: "1", state: "open" },
    { number: 8, position: 1, state: null },
    { number: 9, position: 1 },
    { number: "10", position: 1, state: "open" },
    { number: Number.NaN, position: 1, state: "open" },
    member(11, 1, "open"),
    member(12, 2, "open"),
  ];
  assert.deepEqual(cascadedStackNumbers(members, 3), [11, 12]);
});

const IDLE = { status: "idle" };
const PENDING = { status: "pending" };
const FAILED = { status: "failed" };
const ok = (locked, state) => ({ status: "ok", locked, state });
const settle = (tab) => ({ do: "settle", tab });
const WAIT = { do: "wait" };
const DISARM = { do: "disarm" };
const PROBES = [
  IDLE,
  PENDING,
  FAILED,
  ok(true, "MERGING"),
  ok(false, "MERGED"),
];

test("align step: a provider that can't lock settles its own tab at once", () => {
  for (const state of REMOTE_STATES)
    for (const probe of PROBES)
      for (const saw of [false, true])
        assert.deepEqual(
          prAlignStep(state, false, probe, 0, saw),
          settle(prAlignTab(state)),
          state,
        );
});

test("align step: GitLab OPEN and MERGED never consult the probe", () => {
  for (const state of ["OPEN", "MERGED"])
    for (const probe of PROBES)
      assert.deepEqual(
        prAlignStep(state, true, probe, 0, true),
        settle(prAlignTab(state)),
        state,
      );
});

test("align step: a would-be Closed waits on an unanswered probe", () => {
  for (const state of ["CLOSED", "MERGING", ""])
    for (const probe of [IDLE, PENDING])
      for (const pollsLeft of [0, 5])
        assert.deepEqual(
          prAlignStep(state, true, probe, pollsLeft, false),
          WAIT,
        );
});

test("align step: a failure with no locked answer falls back to the details", () => {
  for (const pollsLeft of [0, 3])
    assert.deepEqual(
      prAlignStep("CLOSED", true, FAILED, pollsLeft, false),
      settle("unmerged"),
    );
});

test("align step: a failure after a locked answer never settles Closed", () => {
  assert.deepEqual(prAlignStep("CLOSED", true, FAILED, 2, true), WAIT);
  assert.deepEqual(prAlignStep("CLOSED", true, FAILED, 0, true), DISARM);
});

test("align step: locked waits on its polls, then disarms", () => {
  for (const saw of [false, true]) {
    assert.deepEqual(
      prAlignStep("CLOSED", true, ok(true, "MERGING"), 1, saw),
      WAIT,
    );
    assert.deepEqual(
      prAlignStep("CLOSED", true, ok(true, "MERGING"), 0, saw),
      DISARM,
    );
  }
});

test("align step: an unlocked answer settles from its OWN state", () => {
  assert.deepEqual(
    prAlignStep("CLOSED", true, ok(false, "MERGED"), 0, true),
    settle("merged"),
  );
  // The merge failed and GitLab reopened the MR.
  assert.deepEqual(
    prAlignStep("CLOSED", true, ok(false, "OPEN"), 0, true),
    settle("open"),
  );
  assert.deepEqual(
    prAlignStep("CLOSED", true, ok(false, "CLOSED"), 5, false),
    settle("unmerged"),
  );
  // An answer that predates the new fields, or carries no state, keeps the
  // details' tab.
  for (const state of [undefined, ""])
    assert.deepEqual(
      prAlignStep("CLOSED", true, ok(false, state), 5, false),
      settle("unmerged"),
    );
});

/** Drives the step over a sequence of answers the way the panel's ladder
 *  does: after a locked answer, every later answer is a re-read and spends a
 *  rung. Returns the first non-wait step and how many reads it took. */
function runLadder(answers, budget = 5) {
  let polls = 0;
  let sawLocked = false;
  for (const [i, probe] of answers.entries()) {
    if (i > 0 && sawLocked) polls += 1;
    if (probe.status === "ok" && probe.locked) sawLocked = true;
    const step = prAlignStep("CLOSED", true, probe, budget - polls, sawLocked);
    if (step.do !== "wait") return { step, reads: i + 1 };
  }
  return { step: WAIT, reads: answers.length };
}

test("align ladder: locked six times disarms on the fifth re-read", () => {
  const locked = ok(true, "MERGING");
  assert.deepEqual(runLadder(Array(7).fill(locked)), {
    step: DISARM,
    reads: 6,
  });
});

test("align ladder: locked, then failures until the budget is spent, disarms", () => {
  const answers = [ok(true, "MERGING"), ...Array(6).fill(FAILED)];
  assert.deepEqual(runLadder(answers), { step: DISARM, reads: 6 });
});

test("align ladder: a failure between locked answers rides on to the merge", () => {
  const answers = [
    ok(true, "MERGING"),
    FAILED,
    ok(true, "MERGING"),
    ok(false, "MERGED"),
  ];
  assert.deepEqual(runLadder(answers), { step: settle("merged"), reads: 4 });
});

test("align ladder: locked, then opened, lands on Open", () => {
  assert.deepEqual(runLadder([ok(true, "MERGING"), ok(false, "OPEN")]), {
    step: settle("open"),
    reads: 2,
  });
});

// GitLab's mid-merge state files exactly as CLOSED in every list and align predicate.
test("MERGING files as CLOSED in every tab and align step", () => {
  assert.equal(prAlignTab("MERGING"), prAlignTab("CLOSED"));
  for (const filter of ["open", "closed", "merged", "unmerged"])
    assert.equal(
      remoteStateMatches("MERGING", filter),
      remoteStateMatches("CLOSED", filter),
      filter,
    );
  const probes = [
    IDLE,
    PENDING,
    FAILED,
    ok(true, "MERGING"),
    ok(false, "MERGED"),
    ok(false, "CLOSED"),
  ];
  for (const probe of probes)
    for (const saw of [false, true])
      for (const polls of [0, 1])
        assert.deepEqual(
          prAlignStep("MERGING", true, probe, polls, saw),
          prAlignStep("CLOSED", true, probe, polls, saw),
          JSON.stringify({ probe, saw, polls }),
        );
});
