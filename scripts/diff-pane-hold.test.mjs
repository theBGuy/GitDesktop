// Pins the Changes pane's single-swap pieces: the first hunk's `@@`-row
// prediction (src/features/diff/diff-rows.ts), which lets the line-1
// header paint with the first rows; `diffRendersRows` (same module), which lets
// a rowless diff settle at build instead of waiting out the hold bound; and the
// two-slot hold's transitions (src/features/diff/diff-pane-slots.ts), which keep
// the last settled pane up while the next one prepares, for at most the 400 ms
// bound, with the file-rail hosts' entity axis and slot ids, and the roster of
// hosts rendering through the shared slots. Also the hunk buttons' hosts (same
// diff-rows.ts): what expanding does to the `@@` rows, the inline headers'
// extend-row feed, and the post-write hold's release test (`answeredSince` and
// the status wait, diff-pane-slots.ts) with the react-query behavior it reads.
//
// Not testable here: the settle reports themselves (layout effects across the
// pane's surfaces), what `inert` blocks, and the hold's release commit. Those
// need the live app.
//
// The imports reach straight into `src/` under Node's type stripping, which
// resolves no bundler aliases, so all three modules (the two above and
// src/lib/git/hunks.ts) must stay free of runtime imports. The render suites at
// the end build real diffs with @git-diff-view and render them with
// react-dom/server, and the hold premises run react-query's own client, so they
// skip only when one of those PACKAGES is unresolved (the no-install guards
// job); GD_EXPECT_DEPS turns that skip into a failure on an installed run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  answeredSince,
  answerMark,
  expirePane,
  filePaneView,
  HOLD_BOUND_MS,
  isHolding,
  keyedPaneView,
  NO_STAGING_KEEP,
  paneSlots,
  paneViewKey,
  placeholderPaneView,
  retargetPane,
  settlePane,
  slotWidget,
  stagingKeep,
  startPaneHold,
  statusBehind,
  statusWaitFor,
  WORKING_TREE_ENTITY,
} from "../src/features/diff/diff-pane-slots.ts";
import {
  collapseAllContext,
  diffRendersRows,
  firstHunkHasSepRow,
  headerAnchorLine,
  hunkHeaderExtendData,
  hunkHost,
  hunkRange,
  hunkRangeText,
} from "../src/features/diff/diff-rows.ts";
import { parseHunks } from "../src/lib/git/hunks.ts";
import { maskNonCode } from "./lib/ts-mask.mjs";

// ---------------------------------------------------------- firstHunkHasSepRow

/** A DiffHunk the way parseHunks builds one: header line, body, final "\n". */
function hunk(header, ...body) {
  return { header, text: `${[header, ...body].join("\n")}\n` };
}

const sepRows = [
  {
    name: "a new file (all additions) has no row",
    hunk: hunk("@@ -0,0 +1,3 @@", "+a", "+b", "+c"),
    expected: false,
  },
  {
    name: "leading context at line 1 has no row",
    hunk: hunk("@@ -1,4 +1,5 @@", " a", "+b", " c", " d", " e"),
    expected: false,
  },
  {
    name: "leading context past line 1 has a row",
    hunk: hunk("@@ -5,7 +5,8 @@", " a", " b", " c", "+d", " e", " f", " g"),
    expected: true,
  },
  {
    name: "a context-0 hunk opening on a deletion has no row",
    hunk: hunk("@@ -5 +5,2 @@", "-a", "+b", "+c"),
    expected: false,
  },
  {
    name: "a context-0 hunk opening on an addition has no row",
    hunk: hunk("@@ -4,0 +5,2 @@", "+a", "+b"),
    expected: false,
  },
  {
    name: "a deleted file has no row",
    hunk: hunk("@@ -1,3 +0,0 @@", "-a", "-b", "-c"),
    expected: false,
  },
  {
    name: "a one-line new file (no count) has no row",
    hunk: hunk("@@ -0,0 +1 @@", "+a"),
    expected: false,
  },
  {
    name: "a section heading after the header doesn't change the answer",
    hunk: hunk("@@ -10,3 +10,4 @@ function f() {", " a", "+b", " c", " d"),
    expected: true,
  },
];

for (const { name, hunk: h, expected } of sepRows) {
  test(`firstHunkHasSepRow: ${name}`, () => {
    assert.equal(firstHunkHasSepRow(h), expected);
  });
}

// ------------------------------------------------------------ hunk button hosts

test("hunkRange: both ranges, an omitted count meaning one line", () => {
  assert.deepEqual(hunkRange(hunk("@@ -47,7 +48,9 @@ fn x() {", " a")), {
    oldStart: 47,
    oldLines: 7,
    newStart: 48,
    newLines: 9,
  });
  assert.deepEqual(hunkRange(hunk("@@ -0,0 +1 @@", "+a")), {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
  });
});

test("hunkRangeText: the new range, en-dashed", () => {
  assert.equal(hunkRangeText(hunk("@@ -47,7 +47,9 @@", " a")), "lines 47–55");
});

test("hunkRangeText: a one-line range reads as one line", () => {
  assert.equal(hunkRangeText(hunk("@@ -0,0 +1 @@", "+a")), "line 1");
});

test("hunkRangeText: a deletion-only hunk names its old range", () => {
  assert.equal(
    hunkRangeText(hunk("@@ -1,3 +0,0 @@", "-a", "-b", "-c")),
    "lines 1–3",
  );
});

test("headerAnchorLine: the new line directly above the hunk", () => {
  assert.equal(headerAnchorLine(hunk("@@ -47,7 +48,7 @@", " a")), 47);
  assert.equal(headerAnchorLine(hunk("@@ -1,4 +2,4 @@", " a")), 1);
});

test("headerAnchorLine: none for a hunk on new line 1 or an emptied file", () => {
  assert.equal(headerAnchorLine(hunk("@@ -1,4 +1,5 @@", " a")), null);
  assert.equal(headerAnchorLine(hunk("@@ -0,0 +1,3 @@", "+a")), null);
  assert.equal(headerAnchorLine(hunk("@@ -1,3 +0,0 @@", "-a")), null);
});

test("hunkHost: the row above the hunk's first row decides", () => {
  assert.equal(hunkHost("hunk", 0), "row");
  assert.equal(hunkHost("hunk", 3), "row");
  assert.equal(hunkHost("extend", 0), "inline");
  assert.equal(hunkHost("extend", 2), "inline");
  // A content row (a detached `@@` row's expanded context) or no row at all.
  assert.equal(hunkHost("diff", 0), "top");
  assert.equal(hunkHost(null, 0), "top");
  assert.equal(hunkHost(undefined, 0), "top");
  assert.equal(hunkHost("diff", 1), "none");
  assert.equal(hunkHost(null, 1), "none");
});

test("hunkHeaderExtendData: unified feeds the new side only, truthy data", () => {
  const hunks = [
    hunk("@@ -1,4 +1,5 @@", " a"),
    hunk("@@ -17,7 +18,7 @@", " a"),
    hunk("@@ -47,7 +48,7 @@", " a"),
  ];
  assert.deepEqual(hunkHeaderExtendData(hunks, false), {
    oldFile: {},
    newFile: { 17: { data: { hunk: 1 } }, 47: { data: { hunk: 2 } } },
  });
});

test("hunkHeaderExtendData: split adds the old column's half", () => {
  const hunks = [hunk("@@ -17,7 +18,7 @@", " a")];
  assert.deepEqual(hunkHeaderExtendData(hunks, true), {
    oldFile: { 16: { data: { hunk: 0, side: "old" } } },
    newFile: { 17: { data: { hunk: 0 } } },
  });
});

test("hunkHeaderExtendData: hunk 0's data is an object, never a bare 0", () => {
  const { newFile } = hunkHeaderExtendData(
    [hunk("@@ -17,7 +17,7 @@", " a")],
    false,
  );
  assert.ok(newFile[16].data);
  assert.equal(typeof newFile[16].data, "object");
});

// ----------------------------------------------------------------- pane slots

const REPO = "C:/repo";
const E = WORKING_TREE_ENTITY;
const file = (path, staged = false) => ({ path, staged, untracked: false });
const view = (path, staged = false, repo = REPO) =>
  filePaneView(repo, file(path, staged));
const PLACEHOLDER = { kind: "placeholder" };
const phases = (hold) =>
  paneSlots(hold).map(({ view: v, phase }) => [paneViewKey(v), phase]);
/** A file shown and settled: the state a click away from it starts from. */
const settledOn = (v) =>
  settlePane(startPaneHold(v), v.key, v.repo, v.entity, true);

test("the hold bound is 400 ms", () => {
  assert.equal(HOLD_BOUND_MS, 400);
});

test("same key: a reselect (fresh object) does not hold", () => {
  const hold = settledOn(view("a.ts"));
  const next = retargetPane(hold, view("a.ts"));
  assert.equal(next, hold);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "shown"],
  ]);
});

test("different key, same repo: the shown file holds while the target prepares", () => {
  const next = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  assert.equal(isHolding(next), true);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "held"],
    ["file:working-tree:C:/repo:false:b.ts", "preparing"],
  ]);
});

test("same path, other side: staged and unstaged are different slots", () => {
  const next = retargetPane(settledOn(view("a.ts", false)), view("a.ts", true));
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "held"],
    ["file:working-tree:C:/repo:true:a.ts", "preparing"],
  ]);
});

test("target null: the placeholder replaces the file at once", () => {
  const next = retargetPane(settledOn(view("a.ts")), PLACEHOLDER);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["placeholder", "shown"]]);
});

test("first selection: the file prepares out of sight over the placeholder", () => {
  const next = retargetPane(startPaneHold(PLACEHOLDER), view("a.ts"));
  assert.deepEqual(phases(next), [
    ["placeholder", "held"],
    ["file:working-tree:C:/repo:false:a.ts", "preparing"],
  ]);
});

test("conflicted target: swaps at once", () => {
  const next = retargetPane(settledOn(view("a.ts")), {
    kind: "conflict",
    key: "b.ts",
  });
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["conflict:b.ts", "shown"]]);
});

test("conflicted source: a file target swaps at once", () => {
  const next = retargetPane(
    startPaneHold({ kind: "conflict", key: "b.ts" }),
    view("a.ts"),
  );
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "shown"],
  ]);
});

test("repo changed: nothing is held across repos", () => {
  const next = retargetPane(
    settledOn(view("a.ts")),
    view("a.ts", false, "C:/other"),
  );
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/other:false:a.ts", "shown"],
  ]);
});

test("rapid retarget: the held slot stays the last settled file", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const next = retargetPane(holding, view("c.ts"));
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "held"],
    ["file:working-tree:C:/repo:false:c.ts", "preparing"],
  ]);
});

test("retarget back to the held file: it is shown again, no hold", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const next = retargetPane(holding, view("a.ts"));
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:a.ts", "shown"],
  ]);
});

test("stale-key settle: a replaced slot's report is ignored, either edge", () => {
  const holding = retargetPane(
    retargetPane(settledOn(view("a.ts")), view("b.ts")),
    view("c.ts"),
  );
  assert.equal(
    settlePane(holding, "C:/repo:false:b.ts", REPO, E, true),
    holding,
  );
  assert.equal(
    settlePane(holding, "C:/repo:false:b.ts", REPO, E, false),
    holding,
  );
  // The held file is already settled: its settled report changes nothing.
  assert.equal(
    settlePane(holding, "C:/repo:false:a.ts", REPO, E, true),
    holding,
  );
});

test("the preparing target's unsettled report neither promotes nor drops it", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  assert.equal(
    settlePane(holding, "C:/repo:false:b.ts", REPO, E, false),
    holding,
  );
});

test("settle, then unsettle, then retarget: the loading view swaps, not held", () => {
  const settled = settledOn(view("a.ts"));
  const loading = settlePane(settled, "C:/repo:false:a.ts", REPO, E, false);
  assert.equal(loading.shownSettled, false);
  assert.equal(
    settlePane(loading, "C:/repo:false:a.ts", REPO, E, false),
    loading,
  );
  const next = retargetPane(loading, view("b.ts"));
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:b.ts", "shown"],
  ]);
});

test("unsettle, then settle again: the view is held again", () => {
  const settled = settledOn(view("a.ts"));
  const loading = settlePane(settled, "C:/repo:false:a.ts", REPO, E, false);
  const again = settlePane(loading, "C:/repo:false:a.ts", REPO, E, true);
  assert.equal(isHolding(retargetPane(again, view("b.ts"))), true);
});

test("a held file that goes loading is dropped by the next retarget", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const heldLoading = settlePane(holding, "C:/repo:false:a.ts", REPO, E, false);
  assert.equal(isHolding(heldLoading), true);
  const next = retargetPane(heldLoading, view("c.ts"));
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:c.ts", "shown"],
  ]);
});

test("settle from another repo is ignored", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  assert.equal(
    settlePane(holding, "C:/repo:false:b.ts", "C:/other", E, true),
    holding,
  );
});

test("current-key settle: the target is promoted to a single slot", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const next = settlePane(holding, "C:/repo:false:b.ts", REPO, E, true);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:b.ts", "shown"],
  ]);
});

test("a shown file starts unsettled; its first settle marks it, a repeat is a no-op", () => {
  const hold = startPaneHold(view("a.ts"));
  assert.equal(hold.shownSettled, false);
  const settled = settlePane(hold, "C:/repo:false:a.ts", REPO, E, true);
  assert.equal(settled.shownSettled, true);
  assert.equal(isHolding(settled), false);
  assert.equal(
    settlePane(settled, "C:/repo:false:a.ts", REPO, E, true),
    settled,
  );
});

test("the placeholder and conflict views start settled", () => {
  assert.equal(startPaneHold(PLACEHOLDER).shownSettled, true);
  assert.equal(
    startPaneHold({ kind: "conflict", key: "b.ts" }).shownSettled,
    true,
  );
});

test("an unsettled shown file is swapped out, never held", () => {
  const next = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:b.ts", "shown"],
  ]);
});

test("expire, then retarget: the unsettled promotion is not held", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("s.ts"));
  const expired = expirePane(holding, "C:/repo:false:s.ts", E);
  assert.equal(expired.shownSettled, false);
  const next = retargetPane(expired, view("f.ts"));
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:f.ts", "shown"],
  ]);
});

test("settle, then retarget: the settled promotion is held", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("s.ts"));
  const settled = settlePane(holding, "C:/repo:false:s.ts", REPO, E, true);
  assert.equal(settled.shownSettled, true);
  const next = retargetPane(settled, view("f.ts"));
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:s.ts", "held"],
    ["file:working-tree:C:/repo:false:f.ts", "preparing"],
  ]);
});

test("expire, then a late settle of the shown file: it holds again", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("s.ts"));
  const expired = expirePane(holding, "C:/repo:false:s.ts", E);
  const settled = settlePane(expired, "C:/repo:false:s.ts", REPO, E, true);
  assert.equal(settled.shownSettled, true);
  assert.equal(isHolding(retargetPane(settled, view("f.ts"))), true);
});

test("retarget back to the held file keeps its settle", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const back = retargetPane(holding, view("a.ts"));
  assert.equal(back.shownSettled, true);
  assert.equal(isHolding(retargetPane(back, view("c.ts"))), true);
});

test("retargeting while holding keeps the held file's settle", () => {
  const holding = retargetPane(settledOn(view("a.ts")), view("b.ts"));
  const next = retargetPane(holding, view("c.ts"));
  assert.equal(next.shownSettled, true);
});

test("bound expiry: the target is promoted to a single slot", () => {
  const holding = retargetPane(startPaneHold(PLACEHOLDER), view("b.ts"));
  const next = expirePane(holding, "C:/repo:false:b.ts", E);
  assert.deepEqual(phases(next), [
    ["file:working-tree:C:/repo:false:b.ts", "shown"],
  ]);
});

test("bound expiry for a replaced target is ignored", () => {
  const holding = retargetPane(
    retargetPane(settledOn(view("a.ts")), view("b.ts")),
    view("c.ts"),
  );
  assert.equal(expirePane(holding, "C:/repo:false:b.ts", E), holding);
});

// A file-rail host's views carry its entity (here a commit): a hold starts only
// between files of one entity, and an entity change re-targets the shown slot
// in place under its own id, so its mounted reads serve their previous answer.

const COMMIT_A = "aaaa";
const COMMIT_B = "bbbb";
const hostView = (path, entity = COMMIT_A, repo = REPO) =>
  keyedPaneView(repo, entity, path, path);
const report = (hold, v, settled) =>
  settlePane(hold, v.key, v.repo, v.entity, settled);
const hostSettledOn = (v) => report(startPaneHold(v), v, true);
const ids = (hold) =>
  paneSlots(hold).map(({ phase, slotId }) => [phase, slotId]);

test("entity change while idle: the shown slot re-targets in place, no hold", () => {
  const shown = hostSettledOn(hostView("a.ts"));
  for (const path of ["a.ts", "b.ts"]) {
    const next = retargetPane(shown, hostView(path, COMMIT_B));
    assert.equal(isHolding(next), false, path);
    assert.deepEqual(ids(next), [["shown", shown.shownId]], path);
    assert.equal(next.shown.entity, COMMIT_B, path);
    // Its reads serve the previous entity's answer until the new one lands.
    assert.equal(next.shownSettled, false, path);
  }
});

test("entity change mid-hold: the hold drops and the shown slot re-targets in place", () => {
  const shown = hostSettledOn(hostView("a.ts"));
  const holding = retargetPane(shown, hostView("b.ts"));
  assert.equal(isHolding(holding), true);
  const next = retargetPane(holding, hostView("c.ts", COMMIT_B));
  assert.equal(isHolding(next), false);
  assert.deepEqual(ids(next), [["shown", shown.shownId]]);
});

test("same-entity path change over a settled file holds, the target in a fresh slot", () => {
  const shown = hostSettledOn(hostView("a.ts"));
  const next = retargetPane(shown, hostView("b.ts"));
  const [held, preparing] = ids(next);
  assert.deepEqual(held, ["held", shown.shownId]);
  assert.equal(preparing[0], "preparing");
  assert.notEqual(preparing[1], shown.shownId);
});

test("promotion keeps the preparing slot's id, by settle or by the bound", () => {
  const holding = retargetPane(
    hostSettledOn(hostView("a.ts")),
    hostView("b.ts"),
  );
  const preparingId = holding.targetId;
  assert.deepEqual(ids(report(holding, hostView("b.ts"), true)), [
    ["shown", preparingId],
  ]);
  assert.deepEqual(ids(expirePane(holding, "b.ts", COMMIT_A)), [
    ["shown", preparingId],
  ]);
});

test("back to the held file adopts the held slot's id", () => {
  const shown = hostSettledOn(hostView("a.ts"));
  const holding = retargetPane(shown, hostView("b.ts"));
  assert.deepEqual(ids(retargetPane(holding, hostView("a.ts"))), [
    ["shown", shown.shownId],
  ]);
});

test("replace-outright mints a fresh id, and no id repeats across a run", () => {
  const unsettled = startPaneHold(hostView("a.ts"));
  const replaced = retargetPane(unsettled, hostView("b.ts"));
  assert.equal(isHolding(replaced), false);
  assert.notEqual(replaced.shownId, unsettled.shownId);
  let hold = hostSettledOn(hostView("a.ts"));
  const seen = new Set([hold.shownId]);
  for (const path of ["b.ts", "c.ts", "d.ts"]) {
    hold = retargetPane(hold, hostView(path));
    assert.ok(!seen.has(hold.targetId), path);
    seen.add(hold.targetId);
  }
});

test("a stale entity's report on the same path is ignored", () => {
  const inPlace = retargetPane(
    hostSettledOn(hostView("a.ts")),
    hostView("a.ts", COMMIT_B),
  );
  assert.equal(report(inPlace, hostView("a.ts", COMMIT_A), true), inPlace);
  assert.equal(
    report(inPlace, hostView("a.ts", COMMIT_B), true).shownSettled,
    true,
  );
});

test("the bound's expiry for another entity's target is ignored", () => {
  const holding = retargetPane(
    hostSettledOn(hostView("a.ts")),
    hostView("b.ts"),
  );
  assert.equal(expirePane(holding, "b.ts", COMMIT_B), holding);
});

test("a host's placeholder holds a first file only within its entity", () => {
  const resting = startPaneHold(placeholderPaneView(COMMIT_A));
  assert.equal(isHolding(retargetPane(resting, hostView("a.ts"))), true);
  assert.equal(
    isHolding(retargetPane(resting, hostView("a.ts", COMMIT_B))),
    false,
  );
});

test("a host's placeholder is one per entity: another entity's is another view", () => {
  const resting = startPaneHold(placeholderPaneView(COMMIT_A));
  const next = retargetPane(resting, placeholderPaneView(COMMIT_B));
  assert.notEqual(next, resting);
  assert.equal(isHolding(next), false);
  assert.notEqual(next.shownId, resting.shownId);
  // The Changes pane's placeholder keeps its one identity.
  assert.equal(paneViewKey(placeholderPaneView()), "placeholder");
});

test("the same host key in another repo is another view, never held", () => {
  const shown = hostSettledOn(hostView("a.ts"));
  const next = retargetPane(shown, hostView("a.ts", COMMIT_A, "C:/other"));
  assert.equal(isHolding(next), false);
  assert.notEqual(next.shownId, shown.shownId);
});

test("release and advance in one render: a file kept settled through its write is held", () => {
  // The post-write keep repaints nothing, so the shown file reports no edge
  // while the write releases and the selection advances in the same render.
  const shown = settledOn(view("a.ts"));
  assert.deepEqual(phases(retargetPane(shown, view("b.ts"))), [
    ["file:working-tree:C:/repo:false:a.ts", "held"],
    ["file:working-tree:C:/repo:false:b.ts", "preparing"],
  ]);
  // Had the emptied side fallen back to a loading paint, the advance would
  // replace it outright and paint the next file over nothing.
  const fellBack = settlePane(shown, "C:/repo:false:a.ts", REPO, E, false);
  assert.equal(isHolding(retargetPane(fellBack, view("b.ts"))), false);
});

// ------------------------------------------------------- post-write status wait

test("post-write status wait: tracked stage and unstage record status, discards don't", () => {
  assert.equal(statusWaitFor("stage", false), "if-emptied");
  assert.equal(statusWaitFor("unstage", false), "if-emptied");
  assert.equal(statusWaitFor("discard", false), null);
  for (const kind of ["stage", "unstage", "discard"])
    assert.equal(statusWaitFor(kind, true), "always", kind);
});

test("post-write status wait: a tracked write waits on status only after an empty diff", () => {
  const wait = statusWaitFor("stage", false);
  // The diff leg holds until it answers; status adds nothing before that.
  assert.equal(
    statusBehind(wait, false, { answered: false, empty: true }),
    false,
  );
  // A press that leaves content releases on the diff's answer alone.
  assert.equal(
    statusBehind(wait, false, { answered: true, empty: false }),
    false,
  );
  // An emptied side waits for status, and releases once it answers.
  assert.equal(
    statusBehind(wait, false, { answered: true, empty: true }),
    true,
  );
  assert.equal(
    statusBehind(wait, true, { answered: true, empty: true }),
    false,
  );
  // Discards never wait; an untracked file's write waits until status answers.
  assert.equal(
    statusBehind(null, false, { answered: true, empty: true }),
    false,
  );
  assert.equal(
    statusBehind("always", false, { answered: false, empty: false }),
    true,
  );
  assert.equal(
    statusBehind("always", true, { answered: true, empty: false }),
    false,
  );
});

// ---------------------------------------------------- staging view keep

// One render of the staging view per step, from a file shown in hunk mode:
// whether it keeps its last hunk view rather than fall back.

/** A shown file in hunk mode, no write in flight, on its side of status. */
const SHOWN_LIVE = {
  live: true,
  interactive: true,
  writeHolding: false,
  emptiedByWrite: false,
  writeReleased: true,
  onSide: true,
  nonEmptyAnswer: true,
  leftBoundExpired: false,
};

/** The kept flag at each step, from the hunk view on screen. */
function keepRun(steps) {
  let state = stagingKeep(NO_STAGING_KEEP, SHOWN_LIVE);
  return steps.map((step) => {
    state = stagingKeep(state, { ...SHOWN_LIVE, ...step });
    return state.kept;
  });
}

/** A stage or unstage that empties the side, up to the write's release. */
const EMPTIED = [
  // The press: the write runs over the old answer.
  { writeHolding: true, writeReleased: false },
  // The side answers empty; status hasn't answered.
  {
    live: false,
    writeHolding: true,
    emptiedByWrite: true,
    writeReleased: false,
    nonEmptyAnswer: false,
  },
  // Status answers with the file off the side; the write releases next.
  {
    live: false,
    emptiedByWrite: true,
    writeReleased: false,
    onSide: false,
    nonEmptyAnswer: false,
  },
];
const LEFT = { live: false, onSide: false, nonEmptyAnswer: false };

test("staging keep: an emptied side keeps its last view past the write's release", () => {
  assert.deepEqual(keepRun([...EMPTIED, LEFT, LEFT]), [
    false,
    true,
    true,
    true,
    true,
  ]);
});

test("staging keep: the selection moving on holds the kept view (release and advance)", () => {
  assert.deepEqual(keepRun([...EMPTIED, { ...LEFT, interactive: false }]), [
    false,
    true,
    true,
    true,
  ]);
});

test("staging keep: a hidden Changes list never prunes, so the keep lets go after the bound", () => {
  const kept = keepRun([...EMPTIED, LEFT, { ...LEFT, leftBoundExpired: true }]);
  assert.deepEqual(kept, [false, true, true, true, false]);
});

test("staging keep: a file still on its side once status answered paints its answer", () => {
  assert.deepEqual(
    keepRun([...EMPTIED.slice(0, 2), { ...LEFT, onSide: true }]),
    [false, true, false],
  );
});

test("staging keep: a partial stage repaints the remaining hunk, no keep", () => {
  assert.deepEqual(
    keepRun([{ writeHolding: true, writeReleased: false }, {}]),
    [false, false],
  );
});

test("staging keep: a non-empty answer releases the emptied keep", () => {
  assert.deepEqual(keepRun([...EMPTIED, LEFT, {}, { ...LEFT }]), [
    false,
    true,
    true,
    true,
    false,
    false,
  ]);
});

test("staging keep: a discard that empties the side paints its answer", () => {
  // A discard holds no view (the pane passes neither write flag for one).
  assert.deepEqual(
    keepRun([{ live: false, nonEmptyAnswer: false, onSide: false }]),
    [false],
  );
});

test("staging keep: an untracked file's full stage keeps through the re-keyed read", () => {
  assert.deepEqual(
    keepRun([
      // Status still waits; the untracked read answers the whole file.
      { writeHolding: true, writeReleased: false },
      // Status answered and re-keyed the read, which hasn't answered.
      {
        live: false,
        writeHolding: true,
        writeReleased: false,
        nonEmptyAnswer: false,
      },
      // The tracked read answers empty; the file left the unstaged side.
      { ...LEFT, emptiedByWrite: true, writeReleased: false },
      LEFT,
    ]),
    [false, true, true, true],
  );
});

test("staging keep: a held slot keeps its view whatever its read does", () => {
  assert.deepEqual(
    keepRun([
      { interactive: false },
      { live: false, interactive: false, nonEmptyAnswer: false },
      { live: false, interactive: false, nonEmptyAnswer: true },
    ]),
    [false, true, true],
  );
});

test("staging keep: a view the fallback replaced is never kept again", () => {
  // The file left hunk mode (binary, truncated) while shown: the fallback
  // paints, and a later hold has nothing to keep.
  assert.deepEqual(
    keepRun([{ live: false }, { live: false, interactive: false }]),
    [false, false],
  );
});

test("staging keep: an external change while shown paints as it lands", () => {
  assert.deepEqual(keepRun([LEFT]), [false]);
});

// ------------------------------------------------------------- slot widget

/** The widget a slot renders at each `[phase, live widget]` step. */
function widgetRun(steps) {
  let kept = steps[0][1];
  return steps.map(([phase, live]) => {
    const next = slotWidget(phase, live, kept);
    kept = next.keep;
    return next.render;
  });
}

const COMPOSER_A = { enabled: true, file: "a.ts" };
const COMPOSER_B = { enabled: true, file: "b.ts" };

test("slot widget: a preparing slot follows its live widget, so promotion swaps nothing", () => {
  // Mounted before its composer could open (comments not ready yet).
  assert.deepEqual(
    widgetRun([
      ["preparing", undefined],
      ["preparing", COMPOSER_A],
      ["shown", COMPOSER_A],
    ]),
    [undefined, COMPOSER_A, COMPOSER_A],
  );
});

test("slot widget: a held slot keeps the widget it had while shown", () => {
  assert.deepEqual(
    widgetRun([
      ["shown", COMPOSER_A],
      // The selection moved on: the live widget is the next file's, or none.
      ["held", COMPOSER_B],
      ["held", undefined],
      // Back to it: it follows the live widget again.
      ["shown", COMPOSER_A],
    ]),
    [COMPOSER_A, COMPOSER_A, COMPOSER_A, COMPOSER_A],
  );
});

// ------------------------------------------------------------------ slot roster

// Every file-rail diff host swaps files through the shared slots
// (src/features/diff/file-slot.tsx), as the Changes pane does. The roster is
// closed by the lazy diff wrapper's consumers: a new consumer is a deliberate
// decision here, a slot host or a recorded exemption.
const SLOT_HOSTS = [
  "src/features/compare/BranchDiffView.tsx",
  "src/features/history/CommitDetailView.tsx",
  "src/features/history/FileHistoryDialog.tsx",
  "src/features/pulls/PrCommitDetail.tsx",
  "src/features/pulls/RemotePrViewParts.tsx",
  "src/features/repository/StashesDialog.tsx",
  "src/features/sessions/WorktreeChangesView.tsx",
];
const NOT_SLOT_HOSTS = [
  // A transcript step's inline diff: one file per step, no rail to swap.
  "src/features/sessions/AgentTranscript.tsx",
  // A conflict side, which the resolve flow renders whole.
  "src/features/repository/ConflictResolveView.tsx",
];
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The module specifiers a source imports, read at code positions only. */
function specifiers(raw, masked) {
  return [...masked.matchAll(/\bfrom\s*"/g)].map((m) => {
    const open = m.index + m[0].length;
    return raw.slice(open, masked.indexOf('"', open));
  });
}

test("slot roster: the lazy diff wrapper's consumers are the slot hosts and the exemptions", () => {
  const seen = readdirSync(join(ROOT, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).split("\\").join("/")}`)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => {
      const raw = readFileSync(join(ROOT, file), "utf8");
      return specifiers(raw, maskNonCode(raw, file.endsWith(".tsx"))).includes(
        "@/features/diff/DiffSurfaceLazy",
      );
    })
    .sort();
  assert.ok(seen.length > 0, "no consumer found: the scan read nothing");
  assert.deepEqual(seen, [...SLOT_HOSTS, ...NOT_SLOT_HOSTS].sort());
});

for (const file of [...SLOT_HOSTS, "src/features/diff/DiffViewer.tsx"]) {
  test(`slot roster: ${file} renders its diff through the file slots`, () => {
    const raw = readFileSync(join(ROOT, file), "utf8");
    const masked = maskNonCode(raw, true);
    const module = file.startsWith("src/features/diff/")
      ? "./file-slot"
      : "@/features/diff/file-slot";
    assert.ok(specifiers(raw, masked).includes(module), `imports ${module}`);
    assert.match(masked, /\buseFileSlots\(/, "holds through useFileSlots");
    assert.match(masked, /<FileSlots\b/, "renders <FileSlots>");
  });
}

test("answeredSince: a key with no answer yet never counts as answered", () => {
  assert.equal(
    answeredSince(
      { isFetched: false, dataUpdatedAt: 0, errorUpdateCount: 0 },
      new Set(),
    ),
    false,
  );
});

// ------------------------------------------------------------- diffRendersRows

test("diffRendersRows: no parsed hunk lines means no rows", () => {
  assert.equal(diffRendersRows({ diffLineLength: 0 }), false);
  assert.equal(diffRendersRows({ diffLineLength: 1 }), true);
  assert.equal(diffRendersRows({ diffLineLength: 240 }), true);
});

const DEP_PACKAGES =
  /Cannot find package '(@git-diff-view\/(core|react)|react|react-dom|@tanstack\/react-query)'/;

let core;
let viewLib;
let React;
let server;
let rq;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("@git-diff-view/react"),
  import("react"),
  import("react-dom/server"),
  import("@tanstack/react-query"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [core, viewLib, React, server, rq] = loads.map((l) => l.value);
} else {
  for (const { reason } of failures) {
    if (
      process.env.GD_EXPECT_DEPS ||
      reason?.code !== "ERR_MODULE_NOT_FOUND" ||
      !DEP_PACKAGES.test(String(reason?.message))
    )
      throw reason;
  }
  skip =
    "@git-diff-view / react / react-query are not installed — the guards job " +
    "runs with no install step; an installed run with GD_EXPECT_DEPS enforces " +
    "this";
}

/** Runs `fn` with the library's dev-mode console notices muted. */
function quietly(fn) {
  const { warn, error } = console;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/** A DiffFile built the way createDiffFile builds one (DiffSurface.tsx). */
function buildDiff(text, content) {
  return quietly(() => {
    const file = core.DiffFile.createInstance({
      oldFile: { fileName: "f", content: content?.old ?? null },
      newFile: { fileName: "f", content: content?.new ?? null },
      hunks: [text],
    });
    file.initRaw();
    return file;
  });
}

/** The rows (`<tr data-line=…>` open tags) the view renders for a freshly built
 *  diff in `mode`, in document order. */
function renderedRowTags(text, content, mode) {
  return quietly(() => {
    const file = buildDiff(text, content);
    file.buildUnifiedDiffLines();
    file.buildSplitDiffLines();
    const html = server.renderToStaticMarkup(
      React.createElement(viewLib.DiffView, {
        diffFile: file,
        diffViewMode: viewLib.DiffModeEnum[mode],
        diffViewWrap: true,
        diffViewFontSize: 12,
      }),
    );
    return html.match(/<tr\b[^>]*\bdata-line="[^"]*"[^>]*>/g) ?? [];
  });
}

/** How many rows the view actually renders for a freshly built diff in `mode`. */
function renderedRows(text, content, mode) {
  return renderedRowTags(text, content, mode).length;
}

const gitHeader = (a, b = a) => `diff --git a/${a} b/${b}\n`;
const SAME = { old: "one\ntwo\n", new: "one\ntwo\n" };

// Every shape git can hand the Changes pane without a hunk, beside row-bearing
// ones; content-mode `content` matches what the pane's whole-file reads return.
const rowShapes = [
  {
    name: "an empty new (untracked) file",
    text: `${gitHeader("e.txt")}new file mode 100644\nindex 0000000..e69de29\n`,
    content: { old: "", new: "" },
    rows: false,
  },
  {
    name: "an empty deleted file",
    text: `${gitHeader("e.txt")}deleted file mode 100644\nindex e69de29..0000000\n`,
    content: { old: "", new: "" },
    rows: false,
  },
  {
    name: "a mode-only change",
    text: `${gitHeader("run.sh")}old mode 100644\nnew mode 100755\n`,
    content: SAME,
    rows: false,
  },
  {
    name: "a pure rename",
    text: `${gitHeader("a.txt", "b.txt")}similarity index 100%\nrename from a.txt\nrename to b.txt\n`,
    content: { old: "", new: "one\ntwo\n" },
    rows: false,
  },
  {
    name: "a pure copy",
    text: `${gitHeader("a.txt", "b.txt")}similarity index 100%\ncopy from a.txt\ncopy to b.txt\n`,
    content: { old: "", new: "one\ntwo\n" },
    rows: false,
  },
  {
    name: "a rename with a mode change",
    text: `${gitHeader("a.sh", "b.sh")}old mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from a.sh\nrename to b.sh\n`,
    content: { old: "", new: "one\ntwo\n" },
    rows: false,
  },
  {
    name: "a binary change",
    text: `${gitHeader("x.png")}index 1111111..2222222 100644\nBinary files a/x.png and b/x.png differ\n`,
    content: SAME,
    rows: false,
  },
  {
    name: "a one-hunk modification",
    text: `${gitHeader("f.txt")}index 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n`,
    content: { old: "one\ntwo\n", new: "one\nthree\n" },
    rows: true,
  },
  {
    name: "a new one-line file",
    text: `${gitHeader("n.txt")}new file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+one\n`,
    content: { old: "", new: "one\n" },
    rows: true,
  },
  {
    name: "a deleted non-empty file",
    text: `${gitHeader("d.txt")}deleted file mode 100644\nindex 1111111..0000000\n--- a/d.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n`,
    content: { old: "one\ntwo\n", new: "" },
    rows: true,
  },
  {
    name: "a mode change with an edit",
    text: `${gitHeader("run.sh")}old mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n`,
    content: { old: "one\ntwo\n", new: "one\nthree\n" },
    rows: true,
  },
];

for (const { name, text, content, rows } of rowShapes) {
  for (const [mode, modeContent] of [
    ["hunk-only", undefined],
    ["content", content],
  ]) {
    const title = `diffRendersRows matches the view: ${name} (${mode})`;
    test(title, { skip }, () => {
      assert.equal(diffRendersRows(buildDiff(text, modeContent)), rows);
      for (const layout of ["Unified", "Split"]) {
        assert.equal(
          renderedRows(text, modeContent, layout) > 0,
          rows,
          `${layout} view`,
        );
      }
    });
  }
}

// Hunk 0's `@@` row, rendered: firstHunkHasSepRow decides whether the line-1
// header paints with the first rows, so it must agree with the view's own first
// row in both modes, or a library upgrade doubles or drops that header.

/** Ten numbered lines, with `edits` (1-based line -> text) applied. */
function tenLines(edits = {}) {
  return Array.from(
    { length: 10 },
    (_, i) => `${edits[i + 1] ?? `l${i + 1}`}\n`,
  ).join("");
}

const fileHeader = `${gitHeader("f.txt")}index 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n`;

const sepShapes = [
  {
    name: "a hunk at line 1 with leading context",
    hunks: "@@ -1,3 +1,3 @@\n l1\n-l2\n+x\n l3\n",
    content: { old: tenLines(), new: tenLines({ 2: "x" }) },
    sep: false,
  },
  {
    name: "a hunk past line 1 with leading context",
    hunks: "@@ -4,3 +4,3 @@\n l4\n-l5\n+x\n l6\n",
    content: { old: tenLines(), new: tenLines({ 5: "x" }) },
    sep: true,
  },
  {
    name: "a context-0 hunk past line 1",
    hunks: "@@ -5 +5 @@\n-l5\n+x\n",
    content: { old: tenLines(), new: tenLines({ 5: "x" }) },
    sep: false,
  },
  {
    name: "two hunks, the first opening on a change at line 1",
    hunks:
      "@@ -1,2 +1,2 @@\n-l1\n+y\n l2\n@@ -8,3 +8,3 @@\n l8\n-l9\n+z\n l10\n",
    content: { old: tenLines(), new: tenLines({ 1: "y", 9: "z" }) },
    sep: false,
  },
  {
    name: "two hunks, the first past line 1",
    hunks:
      "@@ -3,3 +3,3 @@\n l3\n-l4\n+y\n l5\n@@ -8,3 +8,3 @@\n l8\n-l9\n+z\n l10\n",
    content: { old: tenLines(), new: tenLines({ 4: "y", 9: "z" }) },
    sep: true,
  },
];

for (const { name, hunks, content, sep } of sepShapes) {
  const text = `${fileHeader}${hunks}`;
  test(`firstHunkHasSepRow predicts ${name}`, () => {
    assert.equal(firstHunkHasSepRow(parseHunks(text).hunks[0]), sep);
  });
  for (const [mode, modeContent] of [
    ["hunk-only", undefined],
    ["content", content],
  ]) {
    const title = `firstHunkHasSepRow matches the view: ${name} (${mode})`;
    test(title, { skip }, () => {
      for (const layout of ["Unified", "Split"]) {
        const [first] = renderedRowTags(text, modeContent, layout);
        assert.ok(first, `${layout} view renders rows`);
        assert.equal(
          /\bdata-state="hunk"/.test(first),
          sep,
          `${layout} view's first row`,
        );
      }
    });
  }
}

// Where a hunk's buttons can live once context is expanded. A content-mode diff
// of a 200-line file with one-line edits at 20, 50 and 150: hunk A (lines
// 17-23) sits under a 16-line gap that its Expand Up opens to line 1, hunk B
// (47-53) under a 23-line gap that one Expand All empties, and hunk C (147-153)
// under a 93-line gap that Expand Up opens only 40 lines of. (The view offers a
// first gap only Up, a middle gap under 40 lines only All, and a longer one Up
// and Down by 40.) Expansion runs on the built file before the render: the
// view renders a clone, but the clone shares the file's line and gap maps, so
// the static markup shows the expanded state.

const LONG_LINES = 200;
const EDITED = [20, 50, 150];

/** The 200-line file before and after one-line edits at `edited`. */
function longFile(edited = EDITED) {
  const old = Array.from({ length: LONG_LINES }, (_, i) => `l${i + 1}`);
  const next = old.map((l, i) => (edited.includes(i + 1) ? `x${i + 1}` : l));
  return { old: `${old.join("\n")}\n`, new: `${next.join("\n")}\n` };
}

/** git's three-line-context hunk around one replaced line. */
function editHunk(line) {
  const body = [];
  for (let n = line - 3; n <= line + 3; n++) {
    if (n === line) body.push(`-l${n}`, `+x${n}`);
    else body.push(` l${n}`);
  }
  return `@@ -${line - 3},7 +${line - 3},7 @@\n${body.join("\n")}\n`;
}

const longText = (edited = EDITED) =>
  `${fileHeader}${edited.map(editHunk).join("")}`;
const longHunks = (edited = EDITED) => parseHunks(longText(edited)).hunks;
const FIRST = { A: 17, B: 47, C: 147 };

/** A built, unexpanded content-mode DiffFile of the long diff. */
function longDiff(edited = EDITED) {
  return quietly(() => {
    const file = buildDiff(longText(edited), longFile(edited));
    file.buildUnifiedDiffLines();
    file.buildSplitDiffLines();
    return file;
  });
}

/** Expands the gap above the hunk whose first new line is `line`, the way the
 *  view's own expand controls do: `all`, or `up` / `down` by the library's 40
 *  lines. */
function expandAbove(file, layout, dir, line) {
  quietly(() => {
    if (layout === "Unified") {
      const index = file.getUnifiedLineIndexByLineNumber(
        line,
        core.SplitSide.new,
      );
      file.onUnifiedHunkExpand(dir, index);
    } else {
      const index = file.getSplitLineIndexByLineNumber(
        line,
        core.SplitSide.new,
      );
      file.onSplitHunkExpand(dir, index);
    }
  });
}

/** Test stand-in for the pane's header renderer: a marker per rendered half. */
const markExtend = ({ data }) =>
  React.createElement("span", {
    "data-hdr": `${data.hunk}:${data.side ?? "new"}`,
  });

/** Every `<tr>` the view renders for `file` in `layout`, whole. */
function renderedRowsOf(file, layout, extendData) {
  return quietly(() => {
    const html = server.renderToStaticMarkup(
      React.createElement(viewLib.DiffView, {
        diffFile: file,
        diffViewMode: viewLib.DiffModeEnum[layout],
        diffViewWrap: true,
        diffViewFontSize: 12,
        ...(extendData ? { extendData, renderExtendLine: markExtend } : {}),
      }),
    );
    return html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? [];
  });
}

const rowState = (row) => row.match(/^<tr\b[^>]*\bdata-state="([^"]*)"/)?.[1];

/** The index of the row showing new line `line`. */
function rowOfLine(rows, layout, line) {
  const re =
    layout === "Unified"
      ? new RegExp(`data-line-new-num="${line}"`)
      : new RegExp(`data-side="new"[^>]*><span data-line-num="${line}"`);
  const i = rows.findIndex((r) => re.test(r));
  assert.ok(i > 0, `${layout} renders new line ${line} below another row`);
  return i;
}

const headerMarks = (row) => row.match(/data-hdr="[^"]*"/g) ?? [];

for (const layout of ["Unified", "Split"]) {
  test(`premise: collapsed, each hunk sits under its \`@@\` row (${layout})`, {
    skip,
  }, () => {
    const rows = renderedRowsOf(longDiff(), layout);
    for (const line of Object.values(FIRST))
      assert.equal(rowState(rows[rowOfLine(rows, layout, line) - 1]), "hunk");
  });

  test(`premise: Expand All empties hunk B's gap and its \`@@\` row goes (${layout})`, {
    skip,
  }, () => {
    const file = longDiff();
    expandAbove(file, layout, "all", FIRST.B);
    const rows = renderedRowsOf(file, layout);
    const b = rowOfLine(rows, layout, FIRST.B);
    assert.notEqual(rowState(rows[b - 1]), "hunk");
    // Nothing but code rows from hunk A's last line down to hunk B.
    const aEnd = rowOfLine(rows, layout, FIRST.A + 6);
    assert.ok(rows.slice(aEnd, b).every((r) => rowState(r) !== "hunk"));
    // The model agrees: the gap's hidden span is empty.
    const index =
      layout === "Unified"
        ? file.getUnifiedLineIndexByLineNumber(FIRST.B, core.SplitSide.new)
        : file.getSplitLineIndexByLineNumber(FIRST.B, core.SplitSide.new);
    const gap =
      layout === "Unified"
        ? file.getUnifiedHunkLine(index).unifiedInfo
        : file.getSplitHunkLine(index).splitInfo;
    assert.equal(gap.startHiddenIndex, gap.endHiddenIndex);
  });

  test(`premise: Expand Up detaches hunk C's \`@@\` row 40 rows above it (${layout})`, {
    skip,
  }, () => {
    const file = longDiff();
    expandAbove(file, layout, "up", FIRST.C);
    const rows = renderedRowsOf(file, layout);
    const c = rowOfLine(rows, layout, FIRST.C);
    assert.notEqual(rowState(rows[c - 1]), "hunk");
    const sep = rows.slice(0, c).findLastIndex((r) => rowState(r) === "hunk");
    assert.ok(sep >= 0, "the gap's `@@` row is still rendered");
    assert.equal(c - sep - 1, 40);
  });

  test(`inline headers: absent collapsed, directly above each hunk once its line above shows (${layout})`, {
    skip,
  }, () => {
    const split = layout === "Split";
    const extendData = hunkHeaderExtendData(longHunks(), split);
    const file = longDiff();
    const collapsed = renderedRowsOf(file, layout, extendData);
    assert.equal(collapsed.filter((r) => rowState(r) === "extend").length, 0);
    expandAbove(file, layout, "up", FIRST.A); // hunk 0, to line 1
    expandAbove(file, layout, "all", FIRST.B);
    expandAbove(file, layout, "up", FIRST.C); // partial: its `@@` row detaches
    const rows = renderedRowsOf(file, layout, extendData);
    for (const [i, line] of Object.values(FIRST).entries()) {
      const above = rows[rowOfLine(rows, layout, line) - 1];
      assert.equal(rowState(above), "extend", `hunk ${i}'s header`);
      assert.deepEqual(
        headerMarks(above),
        split
          ? [`data-hdr="${i}:old"`, `data-hdr="${i}:new"`]
          : [`data-hdr="${i}:new"`],
        `hunk ${i}'s header halves`,
      );
    }
    assert.equal(rows.filter((r) => rowState(r) === "extend").length, 3);
  });

  test(`inline headers: an Expand Down that empties a gap swaps its \`@@\` row for the header (${layout})`, {
    skip,
  }, () => {
    // Edits at 20 and 67 leave exactly 40 hidden lines between the hunks: too
    // many for Expand All, so the view offers Down, and one Down empties it.
    const edited = [20, 67];
    const extendData = hunkHeaderExtendData(
      longHunks(edited),
      layout === "Split",
    );
    const file = longDiff(edited);
    const before = renderedRowsOf(file, layout, extendData);
    assert.equal(rowState(before[rowOfLine(before, layout, 64) - 1]), "hunk");
    expandAbove(file, layout, "down", 64);
    const rows = renderedRowsOf(file, layout, extendData);
    const b = rowOfLine(rows, layout, 64);
    assert.equal(rowState(rows[b - 1]), "extend");
    assert.ok(headerMarks(rows[b - 1]).includes(`data-hdr="1:new"`));
    const aEnd = rowOfLine(rows, layout, 23);
    assert.ok(rows.slice(aEnd, b).every((r) => rowState(r) !== "hunk"));
  });

  test(`inline headers: a partial Expand Up on hunk 0 detaches its row and heads the hunk (${layout})`, {
    skip,
  }, () => {
    const edited = [150];
    const extendData = hunkHeaderExtendData(
      longHunks(edited),
      layout === "Split",
    );
    const file = longDiff(edited);
    const before = renderedRowsOf(file, layout, extendData);
    assert.equal(rowState(before[rowOfLine(before, layout, 147) - 1]), "hunk");
    assert.equal(before.filter((r) => rowState(r) === "extend").length, 0);
    expandAbove(file, layout, "up", 147);
    const rows = renderedRowsOf(file, layout, extendData);
    const h = rowOfLine(rows, layout, 147);
    assert.equal(rowState(rows[h - 1]), "extend");
    assert.ok(headerMarks(rows[h - 1]).includes(`data-hdr="0:new"`));
    // The detached `@@` row sits above the 40 revealed lines and the header.
    const sep = rows.slice(0, h).findLastIndex((r) => rowState(r) === "hunk");
    assert.equal(h - sep - 1, 41);
  });
}

test("premise: each layout keeps its own expansion, so collapsing one leaves the other", {
  skip,
}, () => {
  const file = longDiff();
  expandAbove(file, "Unified", "all", FIRST.B);
  quietly(() => file.onAllCollapse("split"));
  const rows = renderedRowsOf(file, "Unified");
  assert.notEqual(
    rowState(rows[rowOfLine(rows, "Unified", FIRST.B) - 1]),
    "hunk",
  );
});

test("collapseAllContext restores every `@@` row in both layouts", {
  skip,
}, () => {
  const file = longDiff();
  expandAbove(file, "Unified", "up", FIRST.A);
  expandAbove(file, "Unified", "all", FIRST.B);
  expandAbove(file, "Unified", "up", FIRST.C);
  expandAbove(file, "Split", "all", FIRST.B);
  expandAbove(file, "Split", "up", FIRST.C);
  quietly(() => collapseAllContext(file));
  for (const layout of ["Unified", "Split"]) {
    const extendData = hunkHeaderExtendData(longHunks(), layout === "Split");
    const rows = renderedRowsOf(file, layout, extendData);
    for (const line of Object.values(FIRST))
      assert.equal(
        rowState(rows[rowOfLine(rows, layout, line) - 1]),
        "hunk",
        `${layout}: the row above new line ${line}`,
      );
    assert.equal(rows.filter((r) => rowState(r) === "extend").length, 0);
  }
});

test("inline headers: unified must feed one side, or the header renders twice", {
  skip,
}, () => {
  const file = longDiff();
  expandAbove(file, "Unified", "all", FIRST.B);
  // The anchor is a context line, so a unified row matches it on both sides.
  const both = renderedRowsOf(file, "Unified", {
    oldFile: { [FIRST.B - 1]: { data: { hunk: 1, side: "old" } } },
    newFile: { [FIRST.B - 1]: { data: { hunk: 1 } } },
  });
  const above = both[rowOfLine(both, "Unified", FIRST.B) - 1];
  assert.equal(headerMarks(above).length, 2);
});

test("inline headers: a falsy `data` renders no row, which is why hunk 0's is an object", {
  skip,
}, () => {
  const file = longDiff();
  expandAbove(file, "Unified", "all", FIRST.B);
  const feed = (data) =>
    renderedRowsOf(file, "Unified", {
      oldFile: {},
      newFile: { [FIRST.B - 1]: { data } },
    }).filter((r) => rowState(r) === "extend").length;
  assert.equal(feed(0), 0);
  assert.equal(feed({ hunk: 0 }), 1);
});

// The post-write hold releases on the diff (and, for an untracked file, the
// status) answering after the write settled: its data stamp or error count
// moving off the values the cache held at the settle. These pin the
// react-query behaviors that relies on.

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** An observed query whose every fetch waits on a promise the test resolves. */
function heldQuery() {
  const client = new rq.QueryClient();
  const queryKey = ["repo", "r", "diff", "f.txt", false, false];
  const fetches = [];
  const observer = new rq.QueryObserver(client, {
    queryKey,
    queryFn: () =>
      new Promise((resolve) => {
        fetches.push(resolve);
      }),
    networkMode: "always",
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const state = () => client.getQueryCache().find({ queryKey }).state;
  return { client, queryKey, fetches, observer, unsubscribe, state };
}

test("hold premise: a refetch of unchanged data still advances dataUpdatedAt", {
  skip,
}, async () => {
  const q = heldQuery();
  await tick();
  q.fetches[0]({ text: "same" });
  await tick(5);
  const before = q.state();
  const refetch = q.observer.refetch();
  await tick(2);
  q.fetches[1]({ text: "same" });
  await refetch;
  const after = q.state();
  assert.equal(after.data, before.data, "structural sharing kept the object");
  assert.ok(after.dataUpdatedAt > before.dataUpdatedAt);
  q.unsubscribe();
});

test("hold premise: an invalidation mid-fetch restarts it, and only the restart advances dataUpdatedAt", {
  skip,
}, async () => {
  const q = heldQuery();
  await tick();
  q.fetches[0]({ text: "before" });
  await tick(5);
  const settled = q.state().dataUpdatedAt;
  await tick(2);
  void q.observer.refetch();
  await tick();
  assert.equal(q.fetches.length, 2);
  // Another surface's write invalidates with the default cancelRefetch: true.
  void q.client.invalidateQueries({ queryKey: q.queryKey });
  await tick();
  assert.equal(q.fetches.length, 3, "the in-flight fetch restarted");
  // The cancelled fetch answering changes nothing.
  q.fetches[1]({ text: "cancelled" });
  await tick(5);
  assert.equal(q.state().dataUpdatedAt, settled);
  assert.deepEqual(q.state().data, { text: "before" });
  q.fetches[2]({ text: "after" });
  await tick(5);
  assert.ok(q.state().dataUpdatedAt > settled);
  assert.deepEqual(q.state().data, { text: "after" });
  q.unsubscribe();
});

test("hold premise: a failed refetch moves the error count and keeps the data", {
  skip,
}, async () => {
  const client = new rq.QueryClient();
  let calls = 0;
  const observer = new rq.QueryObserver(client, {
    queryKey: ["repo", "r", "diff", "f.txt", false, false],
    queryFn: async () => {
      calls += 1;
      if (calls > 1) throw new Error("git failed");
      return { text: "before" };
    },
    networkMode: "always",
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await tick(5);
  const before = observer.getCurrentResult();
  await observer.refetch();
  const after = observer.getCurrentResult();
  // What the pane's observer result carries, and so what the hold reads.
  assert.equal(after.errorUpdateCount, before.errorUpdateCount + 1);
  assert.equal(after.dataUpdatedAt, before.dataUpdatedAt);
  assert.deepEqual(after.data, { text: "before" });
  assert.equal("dataUpdateCount" in after, false);
  unsubscribe();
});

// answeredSince over marks taken the way the pane's write helper takes them at
// the settle: every diff entry under the file's prefix (both untracked-axis
// keys), the status entry by exact key.

/** The prefix of f.txt's unstaged-side diff keys; `diffKeyFor` appends the
 *  `untracked` axis. */
const diffPrefix = ["repo", "r", "diff", "f.txt", false];
const diffKeyFor = (untracked) => [...diffPrefix, untracked];

/** The marks the write helper records at the settle. */
function settleMarks(client, queryKey, exact) {
  return new Set(
    client
      .getQueryCache()
      .findAll({ queryKey, exact })
      .map((q) => answerMark(q.state)),
  );
}

/** A client holding both untracked-axis diff entries with distinct answers. */
function seededClient() {
  const client = new rq.QueryClient();
  const at = (updatedAt) => ({ updatedAt });
  client.setQueryData(diffKeyFor(true), { text: "all new" }, at(1000));
  client.setQueryData(diffKeyFor(false), { text: "older" }, at(2000));
  return client;
}

/** An observer on `queryKey` whose fetches the test settles by hand. */
function observe(client, queryKey) {
  const fetches = [];
  const observer = new rq.QueryObserver(client, {
    queryKey,
    queryFn: () =>
      new Promise((resolve, reject) => {
        fetches.push({ resolve, reject });
      }),
    networkMode: "always",
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, fetches, unsubscribe };
}

test("answeredSince: the diff marks cover both untracked-axis keys", {
  skip,
}, () => {
  const marks = settleMarks(seededClient(), diffPrefix, false);
  assert.deepEqual([...marks].sort(), ["1000:0", "2000:0"]);
});

test("answeredSince: a sibling key the hold moves to waits for its own answer", {
  skip,
}, async () => {
  const client = seededClient();
  const marks = settleMarks(client, diffPrefix, false);
  // Status re-keyed the diff to the tracked sibling, whose cached answer
  // predates the settle.
  const { observer, fetches, unsubscribe } = observe(client, diffKeyFor(false));
  await tick();
  assert.equal(answeredSince(observer.getCurrentResult(), marks), false);
  assert.equal(fetches.length, 1, "the stale sibling refetches on mount");
  fetches[0].resolve({ text: "remainder" });
  await tick(5);
  assert.equal(answeredSince(observer.getCurrentResult(), marks), true);
  unsubscribe();
});

test("answeredSince: an error answer releases too", { skip }, async () => {
  const client = seededClient();
  const marks = settleMarks(client, diffPrefix, false);
  const { observer, fetches, unsubscribe } = observe(client, diffKeyFor(true));
  await tick();
  assert.equal(answeredSince(observer.getCurrentResult(), marks), false);
  fetches[0].reject(new Error("git failed"));
  await tick(5);
  const after = observer.getCurrentResult();
  assert.equal(after.dataUpdatedAt, 1000, "the data stamp did not move");
  assert.equal(after.errorUpdateCount, 1);
  assert.equal(answeredSince(after, marks), true);
  unsubscribe();
});

test("answeredSince: the status marks are the status entry alone", {
  skip,
}, () => {
  const client = new rq.QueryClient();
  const status = ["repo", "r", "status"];
  client.setQueryData(status, { entries: [] }, { updatedAt: 3000 });
  client.setQueryData([...status, "line-stats"], {}, { updatedAt: 4000 });
  assert.deepEqual([...settleMarks(client, status, true)], ["3000:0"]);
});
