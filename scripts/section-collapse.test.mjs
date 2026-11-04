// Pins the Changes list's section-collapse seam: the selection prune and where
// an advance's focus lands when its target section is collapsed, plus the
// panel wiring that composes them. Direct .ts imports use Node's type
// stripping; mutation controls run in memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  advanceLanding,
  pruneCollapsedSectionKeys,
  rowKeySection,
} from "../src/features/repository/section-collapse.ts";

const KEYS = ["staged:a", "staged:b/c", "unstaged:a", "unstaged:d"];

for (const [name, collapsed, expected] of [
  ["staged only", ["staged"], ["unstaged:a", "unstaged:d"]],
  ["unstaged only", ["unstaged"], ["staged:a", "staged:b/c"]],
  ["both", ["staged", "unstaged"], []],
]) {
  test(`pruneCollapsedSectionKeys: ${name}`, () => {
    const out = pruneCollapsedSectionKeys(new Set(KEYS), new Set(collapsed));
    assert.deepEqual([...out], expected);
  });
}

test("pruneCollapsedSectionKeys: neither collapsed keeps the Set identity", () => {
  const keys = new Set(KEYS);
  assert.equal(pruneCollapsedSectionKeys(keys, new Set()), keys);
});

test("pruneCollapsedSectionKeys: nothing dropped keeps the Set identity", () => {
  const keys = new Set(["staged:a"]);
  assert.equal(pruneCollapsedSectionKeys(keys, new Set(["unstaged"])), keys);
});

test("pruneCollapsedSectionKeys: a colon in the path never misfiles a key", () => {
  const keys = new Set(["staged:unstaged:x", "unstaged:staged:y"]);
  assert.deepEqual(
    [...pruneCollapsedSectionKeys(keys, new Set(["unstaged"]))],
    ["staged:unstaged:x"],
  );
  assert.deepEqual(
    [...pruneCollapsedSectionKeys(keys, new Set(["staged"]))],
    ["unstaged:staged:y"],
  );
});

for (const [key, expected] of [
  ["staged:a", "staged"],
  ["unstaged:a", "unstaged"],
  ["staged:unstaged:x", "staged"],
  ["folder:staged:src", "staged"],
  ["folder:unstaged:a:b", "unstaged"],
  // A folder key read as a file key would misfile as unstaged/none.
  ["folder:staged:unstaged", "staged"],
  ["header:staged", null],
  ["folder:other:x", null],
  ["", null],
]) {
  test(`rowKeySection: ${JSON.stringify(key)}`, () => {
    assert.equal(rowKeySection(key), expected);
  });
}

const ON_SCREEN = ["staged:a", "folder:unstaged:src", "unstaged:src/b"];

for (const [name, args, expected] of [
  [
    "target on screen -> row",
    ["unstaged:src/b", ON_SCREEN, [], null],
    { kind: "row", key: "unstaged:src/b" },
  ],
  [
    "a collapsed set never shadows a visible row",
    ["staged:a", ON_SCREEN, ["staged", "unstaged"], "unstaged"],
    { kind: "row", key: "staged:a" },
  ],
  [
    "a folder row target on screen -> row",
    ["folder:unstaged:src", ON_SCREEN, ["staged"], null],
    { kind: "row", key: "folder:unstaged:src" },
  ],
  [
    "hidden target in a collapsed section -> toggle",
    ["staged:z", ON_SCREEN, ["staged"], null],
    { kind: "toggle", section: "staged" },
  ],
  [
    "hidden folder target parses its own section",
    ["folder:staged:unstaged", ON_SCREEN, ["staged"], "unstaged"],
    { kind: "toggle", section: "staged" },
  ],
  [
    "the target's own section outranks the fallback",
    ["unstaged:z", ON_SCREEN, ["staged"], "staged"],
    { kind: "landing" },
  ],
  [
    "null target + collapsed fallback -> toggle",
    [null, ON_SCREEN, ["unstaged"], "unstaged"],
    { kind: "toggle", section: "unstaged" },
  ],
  [
    "null target + expanded fallback -> landing",
    [null, ON_SCREEN, ["staged"], "unstaged"],
    { kind: "landing" },
  ],
  [
    "hidden target, section expanded -> landing",
    ["staged:z", ON_SCREEN, [], null],
    { kind: "landing" },
  ],
  [
    "null target, null fallback -> landing",
    [null, ON_SCREEN, ["staged", "unstaged"], null],
    { kind: "landing" },
  ],
]) {
  test(`advanceLanding: ${name}`, () => {
    const [target, rows, collapsed, fallback] = args;
    assert.deepEqual(
      advanceLanding(target, rows, new Set(collapsed), fallback),
      expected,
    );
  });
}

// Wiring pins over the panel source (CRLF-normalized). Each lookup that finds
// nothing fails, and every pin carries an in-memory mutation control.
function readSource(rel) {
  const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.ok(text.trim().length > 0, `${rel} is empty`);
  return text.replace(/\r\n/g, "\n");
}

function between(src, start, end) {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = src.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return src.slice(from, to);
}

function pinPanel(src) {
  const push = between(src, "  function pushSection(", "if (!treeMode) {");
  assert.ok(
    push.includes("if (collapsedSections.has(section)) return;"),
    "pushSection skips a collapsed section before the view-mode branch",
  );
  const build = between(src, "      buildChangeRows(\n", "    ],\n");
  assert.equal(
    build.match(/\bcollapsedSections,/g)?.length,
    2,
    "collapsedSections is a buildChangeRows argument and a memo dep",
  );
  const reset = between(
    src,
    "if (prevRepo.current === repoPath) return;",
    "}, [repoPath]);",
  );
  assert.ok(reset.includes("setCollapsedSections(new Set());"), "repo reset");
  const target = between(src, "  function focusAdvanceTarget(", "\n  }\n");
  assert.ok(target.includes("advanceLanding("), "landing routes the helper");
  assert.ok(target.includes("navRows.map(rowKeyOf)"), "widened row keys");
  assert.ok(target.includes("[data-section-toggle="), "toggle landing");
  assert.ok(
    target.includes("markerLandingRef.current?.focus()"),
    "silent landing",
  );
  assert.ok(!/\blandingRef\.current/.test(target), "never landingRef");
  // Plans run at the latest render's rows: one waiting out a dialog lands
  // frames after the transition, past any section toggled meanwhile.
  const plans = src.match(
    /focusPlan = \(\) =>\s*focusAdvanceTargetLatest\(target, cursorAfter, \w+\)/g,
  );
  assert.equal(plans?.length, 4, "every plan site passes its fallback");
  assert.ok(
    !/focusPlan = \(\) =>\s*focusAdvanceTarget\(/.test(src),
    "no plan reads the transition render's rows",
  );
  const latest = between(
    src,
    "const focusAdvanceTargetLatest = useEffectEvent(",
    ");\n",
  );
  assert.ok(
    latest.includes("=> focusAdvanceTarget(key, cursorAfter, fallbackSection)"),
    "the latest wrapper forwards to focusAdvanceTarget",
  );
  // A toggle never scrolls to the cursor, and the skip lasts one commit: the
  // ref syncs in a no-deps effect AFTER the scroll effect, never inside it.
  const scroll = between(
    src,
    "  const sectionsSeen = useRef(collapsedSections);\n",
    "  }, [activeFlatIndex, activeRowKey, viewMode]);\n",
  );
  assert.ok(
    scroll.includes(
      "if (sectionsSeen.current === collapsedSections)\n      rowVirtualizer.scrollToIndex(activeFlatIndex",
    ),
    "the cursor scroll skips a section toggle's commit",
  );
  assert.ok(scroll.includes("onCursorScrolled()"), "the claim loop still runs");
  assert.ok(!/sectionsSeen\.current = /.test(scroll), "no in-effect sync");
  const afterScroll = src.slice(
    src.indexOf("  }, [activeFlatIndex, activeRowKey, viewMode]);\n"),
  );
  assert.ok(
    /^ {2}\}, \[activeFlatIndex, activeRowKey, viewMode\]\);\n(?: {2}\/\/.*\n)*\s{2}useEffect\(\(\) => \{\n {4}sectionsSeen\.current = collapsedSections;\n {2}\}\);\n/.test(
      afterScroll,
    ),
    "the per-commit sync follows the scroll effect, with no deps",
  );
  assert.equal(
    src.match(/sectionsSeen\.current = /g)?.length,
    1,
    "the sync is the ref's only write",
  );
  const toggle = between(src, "  function toggleSection(", "\n  }\n");
  assert.ok(toggle.includes("pruneCollapsedSectionKeys("), "collapse prunes");
  assert.ok(toggle.includes("clearPendingFocus()"), "drops the claim");
  assert.ok(toggle.includes("setActiveFolderKey(null)"), "drops the cursor");
  const backstop = between(
    src,
    "const staleKey = activeFolderKey;",
    "}, [activeFolderKey, navIndex]);",
  );
  assert.ok(
    backstop.includes("if (collapsedSections.has(section)) {"),
    "backstop never re-keys into a collapsed section",
  );
  assert.ok(
    backstop.includes("(cur) => (cur === staleKey ? nextKey : cur)"),
    "backstop keeps its compare-and-set write",
  );
  const header = between(src, "data-section-toggle={row.section}", "</button>");
  assert.ok(
    header.includes("aria-expanded={!collapsedSections.has(row.section)}"),
    "toggle carries aria-expanded",
  );
  assert.ok(!/tabIndex|onKeyDown/.test(header), "no roving or key wiring");
  assert.ok(
    src.includes("viewMode, collapsedFolders, collapsedSections]"),
    "collapsedSections re-mints getItemKey",
  );
}

const panelSrc = readSource("src/features/repository/ChangesPanel.tsx");

test("wiring: the panel collapses sections through the shared seam", () => {
  pinPanel(panelSrc);
});

test("negative controls: the wiring pins catch their regressions", () => {
  const mutations = [
    ["    if (collapsedSections.has(section)) return;\n", ""],
    ["    setCollapsedSections(new Set());\n", ""],
    ["navRows.map(rowKeyOf)", "navFileKeys"],
    [
      "focusAdvanceTargetLatest(target, cursorAfter, other)",
      "focusAdvanceTargetLatest(target, cursorAfter)",
    ],
    [
      "focusAdvanceTargetLatest(target, cursorAfter, null)",
      "focusAdvanceTarget(target, cursorAfter, null)",
    ],
    [
      "=> focusAdvanceTarget(key, cursorAfter, fallbackSection)",
      "=> focusAdvanceTarget(key, cursorAfter, null)",
    ],
    [
      "if (sectionsSeen.current === collapsedSections)\n      rowVirtualizer",
      "rowVirtualizer",
    ],
    [
      "    sectionsSeen.current = collapsedSections;\n  });\n",
      "    sectionsSeen.current = collapsedSections;\n  }, [activeFlatIndex]);\n",
    ],
    [
      "  useEffect(() => {\n    sectionsSeen.current = collapsedSections;\n  });\n",
      "",
    ],
    [
      "    if (activeFlatIndex < 0) return;\n    // A section toggle",
      "    sectionsSeen.current = collapsedSections;\n    if (activeFlatIndex < 0) return;\n    // A section toggle",
    ],
    ["pruneCollapsedSectionKeys(prev, new Set([section]))", "prev"],
    ["(cur === staleKey ? nextKey : cur)", "nextKey"],
    ["aria-expanded={!collapsedSections.has(row.section)}", "aria-expanded"],
    ["collapsedFolders, collapsedSections]", "collapsedFolders]"],
  ];
  for (const [from, to] of mutations) {
    assert.ok(panelSrc.includes(from), `mutation anchor ${from}`);
    assert.throws(() => pinPanel(panelSrc.replace(from, () => to)), {
      code: "ERR_ASSERTION",
    });
  }
});
