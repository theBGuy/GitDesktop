// Pins the Changes pane's single-swap pieces: the first hunk's `@@`-row
// prediction (src/features/diff/first-hunk-sep.ts), which lets the line-1
// header paint with the first rows; `diffRendersRows` (same module), which lets
// a rowless diff settle at build instead of waiting out the hold bound; and the
// two-slot hold's transitions (src/features/diff/diff-pane-slots.ts), which keep
// the last settled pane up until the next one is ready.
//
// Not testable here: the settle reports themselves (layout effects across the
// pane's surfaces) and what `inert` blocks. Those need the live app.
//
// The imports reach straight into `src/` under Node's type stripping, which
// resolves no bundler aliases, so both modules must stay free of runtime
// imports. The diff-shape suite at the end builds real diffs with
// @git-diff-view and renders them with react-dom/server, so it skips only when
// one of those PACKAGES is unresolved (the no-install guards job);
// GD_EXPECT_DEPS turns that skip into a failure on an installed run.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expirePane,
  filePaneView,
  HOLD_BOUND_MS,
  isHolding,
  paneSlots,
  paneViewKey,
  retargetPane,
  settlePane,
  startPaneHold,
} from "../src/features/diff/diff-pane-slots.ts";
import {
  diffRendersRows,
  firstHunkHasSepRow,
} from "../src/features/diff/first-hunk-sep.ts";

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

// ----------------------------------------------------------------- pane slots

const REPO = "C:/repo";
const file = (path, staged = false) => ({ path, staged, untracked: false });
const view = (path, staged = false, repo = REPO) =>
  filePaneView(repo, file(path, staged));
const PLACEHOLDER = { kind: "placeholder" };
const phases = (hold) =>
  paneSlots(hold).map(({ view: v, phase }) => [paneViewKey(v), phase]);

test("the hold bound is 400 ms", () => {
  assert.equal(HOLD_BOUND_MS, 400);
});

test("same key: a reselect (fresh object) does not hold", () => {
  const hold = startPaneHold(view("a.ts"));
  const next = retargetPane(hold, view("a.ts"));
  assert.equal(next, hold);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["file:C:/repo:false:a.ts", "shown"]]);
});

test("different key, same repo: the shown file holds while the target prepares", () => {
  const next = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  assert.equal(isHolding(next), true);
  assert.deepEqual(phases(next), [
    ["file:C:/repo:false:a.ts", "held"],
    ["file:C:/repo:false:b.ts", "preparing"],
  ]);
});

test("same path, other side: staged and unstaged are different slots", () => {
  const next = retargetPane(
    startPaneHold(view("a.ts", false)),
    view("a.ts", true),
  );
  assert.deepEqual(phases(next), [
    ["file:C:/repo:false:a.ts", "held"],
    ["file:C:/repo:true:a.ts", "preparing"],
  ]);
});

test("target null: the placeholder replaces the file at once", () => {
  const next = retargetPane(startPaneHold(view("a.ts")), PLACEHOLDER);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["placeholder", "shown"]]);
});

test("first selection: the file prepares behind the placeholder", () => {
  const next = retargetPane(startPaneHold(PLACEHOLDER), view("a.ts"));
  assert.deepEqual(phases(next), [
    ["placeholder", "held"],
    ["file:C:/repo:false:a.ts", "preparing"],
  ]);
});

test("conflicted target: swaps at once", () => {
  const next = retargetPane(startPaneHold(view("a.ts")), {
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
  assert.deepEqual(phases(next), [["file:C:/repo:false:a.ts", "shown"]]);
});

test("repo changed: nothing is held across repos", () => {
  const next = retargetPane(
    startPaneHold(view("a.ts")),
    view("a.ts", false, "C:/other"),
  );
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["file:C:/other:false:a.ts", "shown"]]);
});

test("rapid retarget: the held slot stays the last settled file", () => {
  const holding = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  const next = retargetPane(holding, view("c.ts"));
  assert.deepEqual(phases(next), [
    ["file:C:/repo:false:a.ts", "held"],
    ["file:C:/repo:false:c.ts", "preparing"],
  ]);
});

test("retarget back to the held file: it is shown again, no hold", () => {
  const holding = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  const next = retargetPane(holding, view("a.ts"));
  assert.deepEqual(phases(next), [["file:C:/repo:false:a.ts", "shown"]]);
});

test("stale-key settle: a replaced or held slot's report is ignored", () => {
  const holding = retargetPane(
    retargetPane(startPaneHold(view("a.ts")), view("b.ts")),
    view("c.ts"),
  );
  assert.equal(settlePane(holding, "C:/repo:false:b.ts", REPO), holding);
  assert.equal(settlePane(holding, "C:/repo:false:a.ts", REPO), holding);
});

test("settle from another repo is ignored", () => {
  const holding = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  assert.equal(settlePane(holding, "C:/repo:false:b.ts", "C:/other"), holding);
});

test("current-key settle: the target is promoted to a single slot", () => {
  const holding = retargetPane(startPaneHold(view("a.ts")), view("b.ts"));
  const next = settlePane(holding, "C:/repo:false:b.ts", REPO);
  assert.equal(isHolding(next), false);
  assert.deepEqual(phases(next), [["file:C:/repo:false:b.ts", "shown"]]);
});

test("settle while not holding changes nothing", () => {
  const hold = startPaneHold(view("a.ts"));
  assert.equal(settlePane(hold, "C:/repo:false:a.ts", REPO), hold);
});

test("bound expiry: the target is promoted to a single slot", () => {
  const holding = retargetPane(startPaneHold(PLACEHOLDER), view("b.ts"));
  const next = expirePane(holding, "C:/repo:false:b.ts");
  assert.deepEqual(phases(next), [["file:C:/repo:false:b.ts", "shown"]]);
});

test("bound expiry for a replaced target is ignored", () => {
  const holding = retargetPane(
    retargetPane(startPaneHold(view("a.ts")), view("b.ts")),
    view("c.ts"),
  );
  assert.equal(expirePane(holding, "C:/repo:false:b.ts"), holding);
});

// ------------------------------------------------------------- diffRendersRows

test("diffRendersRows: no parsed hunk lines means no rows", () => {
  assert.equal(diffRendersRows({ diffLineLength: 0 }), false);
  assert.equal(diffRendersRows({ diffLineLength: 1 }), true);
  assert.equal(diffRendersRows({ diffLineLength: 240 }), true);
});

const DEP_PACKAGES =
  /Cannot find package '(@git-diff-view\/(core|react)|react|react-dom)'/;

let core;
let viewLib;
let React;
let server;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("@git-diff-view/react"),
  import("react"),
  import("react-dom/server"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [core, viewLib, React, server] = loads.map((l) => l.value);
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
    "@git-diff-view / react are not installed — the guards job runs with no " +
    "install step; an installed run with GD_EXPECT_DEPS enforces this";
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

/** Rows the view actually renders for a freshly built diff in `mode`. */
function renderedRows(text, content, mode) {
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
    return (html.match(/<tr[^>]*\bdata-line=/g) ?? []).length;
  });
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
