// Pins the branch menu's windowed row model: the flatten the virtualizer renders
// and the arrow keys walk must agree row for row, every row key must be unique
// across kinds, and the range extractor's pins must never repeat a window index
// or leave the list's bounds (virtual-core checks neither). The source pins at
// the bottom hold BranchSwitcher.tsx to the wiring those helpers rely on: the
// hand-memoized flatten and row-key callback, the focused-row pin's tracking,
// the shared context menu's target/probe ordering and its scroll-on-return, and
// the session-branch filters staying upstream.
//
// The import reaches straight into `src/` through Node's default type
// stripping, which resolves no bundler aliases, so `BranchSwitcherRows.ts` must
// stay import-free. Node's stdlib test runner only, no dev dependency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  branchMenuPins,
  buildBranchMenuRows,
  menuTargetOf,
  mergePinnedIndexes,
  rowKeyOf,
} from "../src/features/repository/BranchSwitcherRows.ts";

const local = (name) => ({ name });
const remote = (r, name) => ({ remote: r, name });
const build = (over = {}) =>
  buildBranchMenuRows({
    visibleBranches: [],
    archivedBranches: [],
    showArchived: false,
    remoteOnly: [],
    showRemote: true,
    showRemoteSection: false,
    ...over,
  });

/** The invariant arrow nav rests on: the nav list is exactly the rendered
 *  non-header rows, in render order. */
function assertNavCongruent({ flatRows, navNames }) {
  assert.deepEqual(
    navNames,
    flatRows
      .filter((r) => r.type === "local" || r.type === "remote")
      .map((r) => r.branch.name),
  );
}

function assertKeysUnique({ flatRows }) {
  const keys = flatRows.map(rowKeyOf);
  assert.equal(new Set(keys).size, keys.length, `duplicate key in ${keys}`);
}

test("no branches at all, or a filter that matches none, flattens to nothing", () => {
  const out = build();
  assert.deepEqual(out, { flatRows: [], navNames: [] });
});

test("a single local branch is one row and one stop", () => {
  const out = build({ visibleBranches: [local("main")] });
  assert.deepEqual(
    out.flatRows.map((r) => r.type),
    ["local"],
  );
  assert.deepEqual(out.navNames, ["main"]);
});

test("archived-only: the header renders, its rows only when expanded", () => {
  const archived = [local("old-1"), local("old-2")];
  const collapsed = build({ archivedBranches: archived });
  assert.deepEqual(
    collapsed.flatRows.map((r) => r.type),
    ["archived-header"],
  );
  assert.deepEqual(collapsed.navNames, []);
  const expanded = build({ archivedBranches: archived, showArchived: true });
  assert.deepEqual(
    expanded.flatRows.map((r) => r.type),
    ["archived-header", "local", "local"],
  );
  assert.deepEqual(expanded.navNames, ["old-1", "old-2"]);
  assertNavCongruent(collapsed);
  assertNavCongruent(expanded);
});

test("the remote section: hidden, shown and collapsed", () => {
  const base = {
    visibleBranches: [local("main")],
    remoteOnly: [remote("origin", "feat")],
  };
  const hidden = build({ ...base, showRemoteSection: false });
  assert.deepEqual(
    hidden.flatRows.map((r) => r.type),
    ["local"],
  );
  const shown = build({ ...base, showRemoteSection: true });
  assert.deepEqual(
    shown.flatRows.map((r) => r.type),
    ["local", "remote-header", "remote"],
  );
  assert.deepEqual(shown.navNames, ["main", "feat"]);
  const collapsed = build({
    ...base,
    showRemoteSection: true,
    showRemote: false,
  });
  assert.deepEqual(
    collapsed.flatRows.map((r) => r.type),
    ["local", "remote-header"],
  );
  assert.deepEqual(collapsed.navNames, ["main"]);
  for (const out of [hidden, shown, collapsed]) assertNavCongruent(out);
});

test("section order is local, archived, remote, with headers off the nav list", () => {
  const out = build({
    visibleBranches: [local("a"), local("b")],
    archivedBranches: [local("x")],
    showArchived: true,
    remoteOnly: [remote("origin", "r1"), remote("origin", "r2")],
    showRemoteSection: true,
  });
  assert.deepEqual(
    out.flatRows.map((r) => r.type),
    [
      "local",
      "local",
      "archived-header",
      "local",
      "remote-header",
      "remote",
      "remote",
    ],
  );
  assert.deepEqual(out.navNames, ["a", "b", "x", "r1", "r2"]);
  assertNavCongruent(out);
  assertKeysUnique(out);
});

test("scale: 120 local and 2000 remote rows stay congruent and unique", () => {
  const out = build({
    visibleBranches: Array.from({ length: 120 }, (_, i) => local(`l-${i}`)),
    archivedBranches: Array.from({ length: 5 }, (_, i) => local(`a-${i}`)),
    showArchived: true,
    remoteOnly: Array.from({ length: 2000 }, (_, i) =>
      remote(i % 2 ? "origin" : "upstream", `r-${i}`),
    ),
    showRemoteSection: true,
  });
  assert.equal(out.flatRows.length, 120 + 1 + 5 + 1 + 2000);
  assert.equal(out.navNames.length, 120 + 5 + 2000);
  assertNavCongruent(out);
  assertKeysUnique(out);
});

test("hostile names keep every key unique across kinds", () => {
  const out = build({
    visibleBranches: [
      local("remote/origin/foo"),
      local("header:archived"),
      local("local:x"),
      local("x"),
      local('we"ird name.with/dots'),
    ],
    archivedBranches: [local("header:remote")],
    showArchived: true,
    remoteOnly: [
      remote("origin", "foo"),
      remote("a/b", "c"),
      remote("a", "b/c"),
      remote("o", "rigin/foo"),
    ],
    showRemoteSection: true,
  });
  assertKeysUnique(out);
  assertNavCongruent(out);
  const keys = out.flatRows.map(rowKeyOf);
  assert.ok(keys.includes("remote:3:a/b/c"));
  assert.ok(keys.includes("remote:1:a/b/c"));
});

test("menuTargetOf: rows give their key, headers and misses give none", () => {
  assert.deepEqual(menuTargetOf({ type: "local", branch: local("m") }), {
    kind: "local",
    name: "m",
  });
  assert.deepEqual(
    menuTargetOf({ type: "remote", branch: remote("up", "f") }),
    { kind: "remote", name: "f", remote: "up" },
  );
  assert.equal(menuTargetOf({ type: "archived-header" }), null);
  assert.equal(menuTargetOf({ type: "remote-header" }), null);
  assert.equal(menuTargetOf(undefined), null);
});

test("branchMenuPins resolves from the current rows and marks absence -1", () => {
  const { flatRows } = build({
    visibleBranches: [local("main"), local("dev")],
    archivedBranches: [local("old")],
    remoteOnly: [remote("a/b", "c"), remote("origin", "feat")],
    showRemoteSection: true,
  });
  // main, dev, archived-header, remote-header, a/b c, origin feat
  assert.deepEqual(
    branchMenuPins(flatRows, "dev", {
      kind: "remote",
      name: "feat",
      remote: "origin",
    }),
    [1, 5, 2, 3, -1],
  );
  // A remote target matches on the pair: the same name on another remote misses.
  assert.deepEqual(
    branchMenuPins(flatRows, null, {
      kind: "remote",
      name: "feat",
      remote: "upstream",
    }),
    [-1, -1, 2, 3, -1],
  );
  // A collapsed archived row isn't rendered, so it can't be pinned.
  assert.deepEqual(
    branchMenuPins(flatRows, "old", { kind: "local", name: "old" }, "old"),
    [-1, -1, 2, 3, -1],
  );
  assert.deepEqual(
    branchMenuPins([], "main", null, "main"),
    [-1, -1, -1, -1, -1],
  );
});

test("branchMenuPins pins the focused row by name, first match, apart from the cursor", () => {
  const { flatRows } = build({
    visibleBranches: [local("main"), local("feat")],
    remoteOnly: [remote("origin", "feat"), remote("origin", "solo")],
    showRemoteSection: true,
  });
  // main, feat, remote-header, origin feat, origin solo
  const focusedOf = (name) => branchMenuPins(flatRows, "main", null, name)[4];
  // A local and a remote sharing a short name resolve to the first, like the
  // cursor and the rows' `data-row` lookup.
  assert.equal(focusedOf("feat"), 1);
  assert.equal(branchMenuPins(flatRows, "feat", null, null)[0], 1);
  assert.equal(focusedOf("solo"), 4);
  assert.equal(focusedOf(null), -1);
  assert.equal(focusedOf("gone"), -1);
  // The cursor moving off the focused row keeps both pinned.
  assert.deepEqual(
    branchMenuPins(flatRows, "solo", null, "main"),
    [4, -1, -1, 2, 0],
  );
});

test("mergePinnedIndexes dedupes, drops absent and out-of-range pins, sorts ascending", () => {
  assert.deepEqual(
    mergePinnedIndexes([3, 4, 5], [4, 4, -1, 0, 9], 10),
    [0, 3, 4, 5, 9],
  );
  assert.deepEqual(mergePinnedIndexes([0, 1], [-1, -1, -1, -1], 2), [0, 1]);
  assert.deepEqual(mergePinnedIndexes([0, 1], [2, 7], 2), [0, 1]);
  assert.deepEqual(mergePinnedIndexes([], [5, 2], 6), [2, 5]);
  assert.deepEqual(mergePinnedIndexes([], [], 0), []);
});

// --- source pins on BranchSwitcher.tsx ------------------------------------

const SOURCE = new URL(
  "../src/features/repository/BranchSwitcher.tsx",
  import.meta.url,
);
const squash = (s) => s.replace(/\s+/g, "");

/** The span from `head` to the first `close` after it, or null. */
function span(text, head, close) {
  const i = text.indexOf(head);
  if (i < 0) return null;
  const j = text.indexOf(close, i + head.length);
  return j < 0 ? null : text.slice(i, j + close.length);
}

function sourceProblems(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const flat = squash(text);
  const problems = [];
  const need = (cond, what) => {
    if (!cond) problems.push(what);
  };
  // The flatten is memoized by hand on exactly its inputs: the list re-keys its
  // rows on its identity, which must not rest on the compiler's choices.
  need(
    flat.includes(
      "const{flatRows,navNames}=useMemo(()=>buildBranchMenuRows({visibleBranches,archivedBranches,showArchived,remoteOnly,showRemote,showRemoteSection,}),[visibleBranches,archivedBranches,showArchived,remoteOnly,showRemote,showRemoteSection,],);",
    ),
    "flatten useMemo (callee + deps)",
  );
  need(
    flat.includes("constnavBranches=navNames;"),
    "navBranches from navNames",
  );
  // Re-minted per row sequence, never per render.
  need(
    flat.includes(
      "constgetItemKey=useCallback((i:number)=>rowKeyOf(flatRows[i]),[flatRows],);",
    ),
    "getItemKey keyed on [flatRows]",
  );
  need(
    flat.includes(
      "mergePinnedIndexes(defaultRangeExtractor(range),[activePin,targetPin,archivedPin,remotePin,focusedPin],count,)",
    ),
    "rangeExtractor merges the pins",
  );
  // The focused pin reads the row holding DOM focus, which the list container
  // tracks: focus landing on a row names it, focus leaving the list clears it.
  need(
    flat.includes(
      "const[activePin,targetPin,archivedPin,remotePin,focusedPin]=branchMenuPins(flatRows,activeName,target,focusedName);",
    ),
    "focusedPin read from focusedName",
  );
  need(
    flat.includes(
      'onFocus={(e)=>{if(!e.currentTarget.contains(e.target))return;setFocusedName(e.target.closest("[data-row]")?.getAttribute("data-row")??null,);}}',
    ),
    "list onFocus sets focusedName from the row",
  );
  need(
    flat.includes(
      "onBlur={(e)=>{if(!e.currentTarget.contains(e.target)||(e.relatedTargetinstanceofNode&&e.currentTarget.contains(e.relatedTarget)))return;setFocusedName(null);}}",
    ),
    "list onBlur clears focusedName only when focus leaves the list",
  );
  // The context menu's focus return scrolls the row into view first: Base UI
  // restores focus with preventScroll.
  const finalFocus = span(text, "finalFocus={() => {", "return row ?? true;");
  need(
    finalFocus !== null &&
      squash(finalFocus).endsWith(
        'row?.scrollIntoView({block:"nearest"});returnrow??true;',
      ),
    "finalFocus scrolls the returned row into view",
  );
  need(
    flat.includes("<BranchMenuListkey={repoPath}"),
    "list keyed on repoPath",
  );
  // useVirtualizer only in the leaf, so the host keeps compiling.
  const leafAt = text.indexOf("function BranchMenuList(");
  const hostAt = text.indexOf("export function BranchSwitcher(");
  const calls = [...text.matchAll(/useVirtualizer\(/g)].map((m) => m.index);
  need(
    calls.length === 1 && leafAt >= 0 && calls[0] > leafAt && calls[0] < hostAt,
    "useVirtualizer called once, inside BranchMenuList",
  );
  // One aim sets the target AND the probe, before Base UI opens the menu.
  const aim = span(text, "function aimBranchMenu(", "\n  }\n");
  need(
    aim !== null &&
      aim.includes("setMenuTarget(target);") &&
      aim.includes("setRewriteProbe("),
    "aimBranchMenu sets target + probe",
  );
  const capture = span(text, "function handleBranchContextMenu(", "\n  }\n");
  need(
    capture !== null &&
      capture.includes("aimBranchMenu(e)") &&
      capture.includes("suppressContextMenu(e);"),
    "capture handler aims the menu and suppresses non-rows",
  );
  need(
    text.includes("onContextMenuCapture={handleBranchContextMenu}"),
    "capture handler wired in the capture phase",
  );
  // A touch long-press opens with no contextmenu event, so its start aims too.
  const touch = span(text, "function handleBranchTouchStart(", "\n  }\n");
  need(
    touch !== null && touch.includes("aimBranchMenu(e)"),
    "touch start aims the menu",
  );
  need(
    text.includes("onTouchStartCapture={handleBranchTouchStart}"),
    "touch handler wired in the capture phase",
  );
  // A closed popover drops the menu target, its probe and the open flag: an
  // item that closes the popover unmounts the menu before close-complete runs.
  need(
    flat.includes(
      "if(!open&&(menuTarget!==null||rewriteProbe!==null||branchMenuOpen)){setMenuTarget(null);setRewriteProbe(null);setBranchMenuOpen(false);}",
    ),
    "popover close resets the row menu",
  );
  // onOpenChange never reads the target; the target clears at close-complete.
  const change = span(
    text,
    "onOpenChange={(menuOpen, details) => {",
    "\n                }}",
  );
  need(
    change !== null &&
      !/\bmenuTarget\b/.test(change) &&
      !change.includes("setMenuTarget"),
    "onOpenChange reads no target state",
  );
  const complete = span(text, "onOpenChangeComplete={(menuOpen) => {", "}}");
  need(
    complete !== null && complete.includes("setMenuTarget(null)"),
    "target clears in onOpenChangeComplete",
  );
  // Session branches are filtered upstream of the helper, on both lists.
  need(
    flat.includes(
      'constallBranches=useMemo(()=>(branches.data??[]).filter((b)=>!b.name.startsWith("gd/session/")),[branches.data],);',
    ),
    "gd/session filter on allBranches",
  );
  need(
    flat.includes("!isSessionBranchName(b.name)&&!localNames.has(b.name)"),
    "session filter in remoteOnly",
  );
  return problems;
}

test("BranchSwitcher.tsx keeps the windowed menu's wiring", () => {
  assert.deepEqual(sourceProblems(readFileSync(SOURCE, "utf8")), []);
});

test("the source pins catch their mutants", () => {
  const real = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  const mutants = [
    // a dropped dep
    [
      "      showRemote,\n      showRemoteSection,\n    ],",
      "      showRemote,\n    ],",
    ],
    // a per-render key callback
    [
      "    [flatRows],\n  );\n  const count",
      "    [flatRows, activeName],\n  );\n  const count",
    ],
    // the focused row dropped from the range extractor's pins
    [
      "[activePin, targetPin, archivedPin, remotePin, focusedPin],\n        count",
      "[activePin, targetPin, archivedPin, remotePin],\n        count",
    ],
    // the probe no longer set by the capture handler
    [
      "    setMenuTarget(target);\n    setRewriteProbe(",
      "    setMenuTarget(target);\n    void (0, ",
    ],
    // onOpenChange clearing the target at close start
    [
      "                  setBranchMenuOpen(menuOpen);\n",
      "                  setBranchMenuOpen(menuOpen);\n                  if (!menuOpen) setMenuTarget(null);\n",
    ],
    // the leaf losing its repo key
    [
      "<BranchMenuList\n                      key={repoPath}\n",
      "<BranchMenuList\n",
    ],
    // the touch handler unwired
    [
      "                        onTouchStartCapture={handleBranchTouchStart}\n",
      "",
    ],
    // the touch handler no longer aiming
    [
      "    if (!aimBranchMenu(e)) e.stopPropagation();\n",
      "    e.stopPropagation();\n",
    ],
    // the popover close leaving the target set
    [
      "  ) {\n    setMenuTarget(null);\n    setRewriteProbe(null);\n    setBranchMenuOpen(false);\n",
      "  ) {\n    setRewriteProbe(null);\n    setBranchMenuOpen(false);\n",
    ],
    // the session filter moved off the memo
    ['!b.name.startsWith("gd/session/")', "true"],
    // the list no longer telling the pin which row holds focus
    [
      '        setFocusedName(\n          e.target.closest("[data-row]")?.getAttribute("data-row") ?? null,\n        );\n',
      "",
    ],
    // a blur onto another row clearing the name in between
    [
      "          (e.relatedTarget instanceof Node &&\n            e.currentTarget.contains(e.relatedTarget))\n",
      "          false\n",
    ],
    // focus leaving the list keeping a stale name
    ["        setFocusedName(null);\n", ""],
    // the context menu returning focus to a row out of view
    ['                    row?.scrollIntoView({ block: "nearest" });\n', ""],
  ];
  for (const [from, to] of mutants) {
    assert.ok(real.includes(from), `mutant anchor missing: ${from}`);
    const problems = sourceProblems(real.replace(from, () => to));
    assert.ok(problems.length > 0, `mutant not caught: ${from}`);
  }
});
