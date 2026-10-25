// Pins the Changes advance: what a status transition does with a tracked row
// (`pruneDecision`) and which file opens in its place (`nextFileKey`).
//
// The import reaches straight into `src/` under Node's type stripping, so
// `next-file-after-stage.ts` must stay import-free: Node can't resolve the app's
// `@/` aliases. The ChangesPanel wiring is pinned by a mask-aware source scan,
// with in-memory mutation controls that must turn it red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cursorAfterAdvance,
  dialogClaimStep,
  nextFileKey,
  pruneDecision,
  selectionAfterAdvance,
} from "../src/features/repository/next-file-after-stage.ts";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const PANEL = "src/features/repository/ChangesPanel.tsx";
const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const base = {
  stillInSection: false,
  presentInOther: true,
  headMoved: false,
  walkActive: false,
  walkWasActive: false,
};

test("pruneDecision: a row still in its section is kept (partial stage)", () => {
  assert.equal(pruneDecision({ ...base, stillInSection: true }), "keep");
  // Kept even across a commit or an active walk: the row never left.
  assert.equal(
    pruneDecision({
      ...base,
      stillInSection: true,
      headMoved: true,
      walkActive: true,
    }),
    "keep",
  );
});

test("pruneDecision: a commit, a resolve walk, or a file gone from both sides clears", () => {
  assert.equal(pruneDecision({ ...base, headMoved: true }), "clear");
  assert.equal(pruneDecision({ ...base, walkActive: true }), "clear");
  assert.equal(pruneDecision({ ...base, presentInOther: false }), "clear");
});

test("pruneDecision: the walk's last file clears after the walk has closed", () => {
  // The walk is gone by the read its last stage lands in, but it was open at
  // (or since) the read before: the transition is still the walk's.
  assert.equal(pruneDecision({ ...base, walkWasActive: true }), "clear");
  // Negative control: with no walk at either read, the same move advances.
  assert.equal(
    pruneDecision({ ...base, walkActive: false, walkWasActive: false }),
    "advance",
  );
});

test("pruneDecision: a row that moved to the other side advances", () => {
  assert.equal(pruneDecision(base), "advance");
});

const ALL = (keys) => new Set(keys);

test("nextFileKey: the next eligible row BELOW in the same section", () => {
  const prev = ["unstaged:a", "unstaged:b", "unstaged:c"];
  assert.equal(
    nextFileKey(prev, "unstaged:a", ALL(["unstaged:b", "unstaged:c"])),
    "unstaged:b",
  );
});

test("nextFileKey: the last row falls back to the nearest row ABOVE", () => {
  const prev = ["unstaged:a", "unstaged:b", "unstaged:c"];
  assert.equal(
    nextFileKey(prev, "unstaged:c", ALL(["unstaged:a", "unstaged:b"])),
    "unstaged:b",
  );
});

test("nextFileKey: the only row has no successor", () => {
  assert.equal(nextFileKey(["unstaged:a"], "unstaged:a", ALL([])), null);
});

test("nextFileKey: never crosses sections, in either direction", () => {
  // The row above an unstaged row can be the very file just staged.
  const prev = ["staged:x", "staged:a", "unstaged:a"];
  const eligible = ALL(["staged:x", "staged:a"]);
  assert.equal(nextFileKey(prev, "unstaged:a", eligible), null);
  const prev2 = ["staged:a", "unstaged:b", "unstaged:c"];
  assert.equal(
    nextFileKey(prev2, "staged:a", ALL(["unstaged:a", "unstaged:b"])),
    null,
  );
});

test("nextFileKey: ineligible rows are skipped (hidden, folded, folder, conflicted)", () => {
  // The caller leaves filter-hidden rows, collapsed folders' children, folder
  // rows and conflicted files out of eligibleNow; the walk steps over them.
  const prev = [
    "unstaged:a",
    "unstaged:conflicted",
    "unstaged:hidden",
    "unstaged:d",
  ];
  assert.equal(
    nextFileKey(prev, "unstaged:a", ALL(["unstaged:d"])),
    "unstaged:d",
  );
  // Nothing eligible below: the nearest eligible row above.
  const prev2 = ["unstaged:a", "unstaged:b", "unstaged:c", "unstaged:z"];
  assert.equal(
    nextFileKey(prev2, "unstaged:c", ALL(["unstaged:a"])),
    "unstaged:a",
  );
});

test("nextFileKey: a multi-file stage lands on the nearest row left", () => {
  const prev = ["unstaged:a", "unstaged:b", "unstaged:c", "unstaged:d"];
  // a, b and c staged in one pass: only d is left.
  assert.equal(
    nextFileKey(prev, "unstaged:a", ALL(["unstaged:d"])),
    "unstaged:d",
  );
  // b and d staged together, b was selected: c is the nearest below.
  assert.equal(
    nextFileKey(prev, "unstaged:b", ALL(["unstaged:a", "unstaged:c"])),
    "unstaged:c",
  );
});

test("nextFileKey: the Staged mirror walks within Staged", () => {
  const prev = ["staged:a", "staged:b", "unstaged:c"];
  assert.equal(
    nextFileKey(prev, "staged:a", ALL(["staged:b", "unstaged:c"])),
    "staged:b",
  );
  assert.equal(
    nextFileKey(prev, "staged:b", ALL(["staged:a", "unstaged:c"])),
    "staged:a",
  );
});

test("nextFileKey: no wrap, and a key that wasn't on screen has no successor", () => {
  const prev = ["unstaged:a", "unstaged:b"];
  assert.equal(nextFileKey(prev, "unstaged:b", ALL([])), null);
  assert.equal(
    nextFileKey(prev, "unstaged:gone", ALL(["unstaged:a", "unstaged:b"])),
    null,
  );
});

test("nextFileKey: the removed key itself is never its own successor", () => {
  const prev = ["unstaged:a", "unstaged:b"];
  assert.equal(
    nextFileKey(prev, "unstaged:a", ALL(["unstaged:a", "unstaged:b"])),
    "unstaged:b",
  );
});

test("selectionAfterAdvance: only the row that left drops, its successor joins", () => {
  const multi = new Set(["unstaged:a", "unstaged:b", "unstaged:x"]);
  assert.deepEqual(
    [...selectionAfterAdvance(multi, "unstaged:a", "unstaged:c")].sort(),
    ["unstaged:b", "unstaged:c", "unstaged:x"],
  );
  // The input set is not mutated.
  assert.equal(multi.size, 3);
  assert.ok(multi.has("unstaged:a"));
});

test("selectionAfterAdvance: a single selection becomes the successor alone", () => {
  assert.deepEqual(
    [...selectionAfterAdvance(new Set(["staged:a"]), "staged:a", "staged:b")],
    ["staged:b"],
  );
  // A successor already in the set stays once.
  assert.deepEqual(
    [
      ...selectionAfterAdvance(
        new Set(["staged:a", "staged:b"]),
        "staged:a",
        "staged:b",
      ),
    ],
    ["staged:b"],
  );
});

test("dialogClaimStep: claims once the dialog's focus return orphaned focus", () => {
  assert.equal(dialogClaimStep("orphaned", 100, 500), "claim");
  // Even past the deadline: the return has happened.
  assert.equal(dialogClaimStep("orphaned", 900, 500), "claim");
});

test("dialogClaimStep: waits while the dialog holds focus, until the deadline", () => {
  assert.equal(dialogClaimStep("dialog", 0, 500), "wait");
  assert.equal(dialogClaimStep("dialog", 499.9, 500), "wait");
  assert.equal(dialogClaimStep("dialog", 500, 500), "drop");
  assert.equal(dialogClaimStep("dialog", 750, 500), "drop");
});

test("dialogClaimStep: never takes focus somebody else owns", () => {
  assert.equal(dialogClaimStep("other", 0, 500), "drop");
});

/** The masked `const NAME = useEffectEvent(…)` holding `marker`, as
 *  `{ name, body, start, end }`; null when absent. */
function effectEventWith(masked, marker) {
  for (const m of masked.matchAll(
    /\bconst\s+([\w$]+)\s*=\s*useEffectEvent\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    const body = masked.slice(open, close + 1);
    if (!body.includes(marker)) continue;
    const end = masked.indexOf(";", close);
    return { name: m[1], body, start: m.index, end: end + 1 };
  }
  return null;
}

/** The deps of the `useLayoutEffect(() => { … }, [deps])` whose body calls
 *  `name(`; null when no layout effect does. */
function layoutEffectDepsCalling(masked, name) {
  const call = new RegExp(String.raw`(?<![\w$.])${name}\(`);
  for (const m of masked.matchAll(/\buseLayoutEffect\(\s*\(\)\s*=>\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    if (!call.test(masked.slice(open, close + 1))) continue;
    const deps = /^\s*,\s*\[([^\]]*)\]\s*\)/.exec(masked.slice(close + 1));
    return deps ? deps[1] : "";
  }
  return null;
}

/** Problems with ChangesPanel's advance wiring; empty when it is pinned. */
function panelProblems(text) {
  const masked = maskNonCode(text, true);
  const event = effectEventWith(masked, "pruneDecision(");
  if (event === null)
    return ["no useEffectEvent calls pruneDecision( (the advance is gone)"];
  const problems = [];
  for (const callee of [
    "nextFileKey",
    "advanceSelectedFile",
    "selectionAfterAdvance",
    "cursorAfterAdvance",
  ])
    if (!new RegExp(String.raw`\b${callee}\(`).test(event.body))
      problems.push(`the transition never calls ${callee}(`);
  const deps = layoutEffectDepsCalling(masked, event.name);
  if (deps === null)
    problems.push(`no useLayoutEffect runs ${event.name} (the layout pass)`);
  else
    for (const dep of ["status.data", "status.dataUpdatedAt"])
      if (!deps.split(",").some((d) => d.trim() === dep))
        problems.push(`the transition's layout effect is not keyed on ${dep}`);
  // The pre-fix prune: a passive effect clearing on any absent selection.
  if (
    /\buseEffect\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*!selectedFile\s*\|\|\s*!status\.data\s*\)/.test(
      masked,
    )
  )
    problems.push("the pre-fix clear-only prune effect is back");
  return problems;
}

/** `text` with `from` swapped for `to` exactly once (a control that misses its
 *  target would pass vacuously). */
function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

/** `text` with every `from` swapped for `to`; at least one must exist. */
function mutateAll(text, from, to) {
  const parts = text.split(from);
  assert.ok(parts.length > 1, `mutation target missing: ${from}`);
  return parts.join(to);
}

const PRE_FIX_PRUNE = `useEffect(() => {
    if (!selectedFile || !status.data) return;
    const stillThere = status.data.entries.some(
      (e) =>
        e.path === selectedFile.path &&
        (selectedFile.staged ? e.staged !== null : e.unstaged !== null),
    );
    if (!stillThere) clearSelectedFile();
  }, [status.data, selectedFile, clearSelectedFile]);`;

test("ChangesPanel wires the advance into its status transition", () => {
  assert.deepEqual(panelProblems(source(PANEL)), []);
});

test("advance wiring mutation controls go red", () => {
  const text = source(PANEL);
  // The whole transition stripped back to the pre-fix clear-only prune.
  const event = effectEventWith(maskNonCode(text, true), "pruneDecision(");
  assert.ok(event, "transition not found for the control");
  const reverted =
    text.slice(0, event.start) + PRE_FIX_PRUNE + text.slice(event.end);
  assert.notDeepEqual(panelProblems(reverted), []);
  const mutants = [
    mutate(text, "advanceSelectedFile({", "clearSelectedFile({"),
    // Every successor walk gone (the selected and the focused arm alike).
    mutateAll(text, "nextFileKey(prevKeys,", "firstKey(prevKeys,"),
    // The multi-selection collapsed to the successor alone.
    mutate(
      text,
      "setSelectedKeys((keys) => selectionAfterAdvance(keys, key, next));",
      "setSelectedKeys(new Set([next]));",
    ),
    mutate(
      text,
      "}, [status.data, status.dataUpdatedAt, selectedFile, repoPath]);",
      "}, [selectedFile, repoPath]);",
    ),
  ];
  for (const mutant of mutants) assert.notDeepEqual(panelProblems(mutant), []);
  // The pre-fix cursor write: the folder cursor dropped on every advance.
  const start = text.indexOf("const cursor = cursorAfterAdvance(");
  const endMark = "cursorAfter = cursor.cursor;";
  const end = text.indexOf(endMark, start);
  assert.ok(start !== -1 && end !== -1, "cursor control target not found");
  const dropsFolder =
    text.slice(0, start) +
    "setActiveFolderKey(null);\n            cursorAfter = next;" +
    text.slice(end + endMark.length);
  assert.notDeepEqual(panelProblems(dropsFolder), []);
});

test("cursorAfterAdvance: a listed folder cursor stays put", () => {
  assert.deepEqual(
    cursorAfterAdvance("folder:unstaged:src", true, "unstaged:src/b.ts"),
    { folderCursor: "folder:unstaged:src", cursor: "folder:unstaged:src" },
  );
});

test("cursorAfterAdvance: otherwise the cursor follows the open file", () => {
  // No folder cursor (list mode, or the cursor was on the file itself).
  assert.deepEqual(cursorAfterAdvance(null, false, "staged:b"), {
    folderCursor: null,
    cursor: "staged:b",
  });
  // A folder cursor whose row is gone can't hold it.
  assert.deepEqual(
    cursorAfterAdvance("folder:unstaged:gone", false, "unstaged:c"),
    { folderCursor: null, cursor: "unstaged:c" },
  );
});

/** Problems with focusAdvancedRow: a non-cursor target arms its claim even
 *  when it is mounted, so the claim's reveal keeps it in the window. */
function mountedClaimProblems(text) {
  const masked = maskNonCode(text, true);
  const fn = /\bfunction focusAdvancedRow\s*\(/.exec(masked);
  if (!fn) return ["focusAdvancedRow not found"];
  const paren = matchBrace(masked, fn.index + fn[0].length - 1);
  const open = masked.indexOf("{", paren);
  const close = matchBrace(masked, open);
  if (paren === -1 || close === -1) return ["focusAdvancedRow is unreadable"];
  const body = masked.slice(open, close + 1);
  const at = body.search(/\bif \(el\) \{/);
  if (at === -1) return ["focusAdvancedRow has no mounted-row branch"];
  const elOpen = body.indexOf("{", at);
  const elClose = matchBrace(body, elOpen);
  const problems = [];
  if (/\breturn\b/.test(body.slice(elOpen, elClose + 1)))
    problems.push(
      "a mounted non-cursor target returns before arming its claim",
    );
  if (
    !/deferFocusRow\(key, undefined, \{ cursorAtArm: cursorAfter \}\)/.test(
      body.slice(elClose),
    )
  )
    problems.push("focusAdvancedRow doesn't arm a non-cursor claim after it");
  return problems;
}

test("a mounted non-cursor target still arms its claim", () => {
  assert.deepEqual(mountedClaimProblems(source(PANEL)), []);
});

test("mounted-claim pin control goes red", () => {
  const text = source(PANEL);
  const mutant = mutate(
    text,
    'el.scrollIntoView({ block: "nearest" });\n    }\n    deferFocusRow',
    'el.scrollIntoView({ block: "nearest" });\n      return;\n    }\n    deferFocusRow',
  );
  assert.notDeepEqual(mountedClaimProblems(mutant), []);
});

/** Problems with focusAdvanceTarget's fallback: a hidden target lands focus on
 *  the silent span, never `landingRef` (the tree-view toggle while the toolbar
 *  is up, which the next Space would press). Empty when pinned. */
function landingProblems(text) {
  const masked = maskNonCode(text, true);
  const fn = /\bfunction focusAdvanceTarget\s*\(/.exec(masked);
  if (!fn) return ["focusAdvanceTarget not found"];
  const paren = matchBrace(masked, fn.index + fn[0].length - 1);
  const open = masked.indexOf("{", paren);
  const close = matchBrace(masked, open);
  if (paren === -1 || close === -1) return ["focusAdvanceTarget is unreadable"];
  const body = masked.slice(open, close + 1);
  const problems = [];
  if (!/\bmarkerLandingRef\.current\?\.focus\(\)/.test(body))
    problems.push("a hidden target doesn't land on the silent span");
  if (/(?<![\w$])landingRef\.current/.test(body))
    problems.push("a hidden target lands on landingRef (a live control)");
  return problems;
}

test("a hidden advance target lands on the silent span", () => {
  assert.deepEqual(landingProblems(source(PANEL)), []);
});

test("landing pin control goes red", () => {
  const text = source(PANEL);
  const mutant = mutate(
    text,
    "    markerLandingRef.current?.focus();\n    return false;",
    "    landingRef.current?.focus();\n    return false;",
  );
  assert.notDeepEqual(landingProblems(mutant), []);
});
