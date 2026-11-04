// Pins folder-key grammar, flat descendant counts and post-emptying focus order.
// Direct .ts imports use Node's type stripping; both modules stay import-free.
// Negative controls run entirely in memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  entriesUnderFolder,
  parseFolderRowKey,
  rowAfterFolderLeaves,
} from "../src/features/repository/folder-stage-targets.ts";
import { flattenPathTree } from "../src/lib/path-tree.ts";

const getPath = (item) => item.path;
const entries = (paths) => paths.map((path) => Object.freeze({ path }));

for (const [key, expected] of [
  ["folder:staged:src/a", { section: "staged", path: "src/a" }],
  ["folder:unstaged:a:b", { section: "unstaged", path: "a:b" }],
  ["folder:unstaged:a\\b", { section: "unstaged", path: "a\\b" }],
  ['folder:unstaged:a "b"/c:d', { section: "unstaged", path: 'a "b"/c:d' }],
  ["folder:staged:a\nb", { section: "staged", path: "a\nb" }],
  ["staged:src/a", null],
  ["header:staged", null],
  ["folder:other:x", null],
  ["folder:staged:", null],
  ["folder:staged", null],
  ["folder:stagedx", null],
  ["folder:unstagedx", null],
  ["folder:", null],
  ["arbitrary", null],
  ["", null],
]) {
  test(`parseFolderRowKey: ${JSON.stringify(key)}`, () => {
    assert.deepEqual(parseFolderRowKey(key), expected);
  });
}

const descendantCases = [
  {
    name: "prefix boundary: src2 excluded (named negative)",
    paths: ["src/a.ts", "src2/b.ts"],
    dir: "src",
    expected: ["src/a.ts"],
  },
  {
    name: "a file equal to the directory is excluded",
    paths: ["src", "src/a.ts"],
    dir: "src",
    expected: ["src/a.ts"],
  },
  {
    name: "deep descendants remain included under collapsed subfolders",
    paths: ["src/a.ts", "src/nested/deep/b.ts", "src/nested/c.ts"],
    dir: "src",
    expected: ["src/a.ts", "src/nested/deep/b.ts", "src/nested/c.ts"],
  },
  {
    name: "compacted chain uses its deepest key",
    paths: ["a/b/c/x.ts", "a/b/d.ts"],
    dir: "a/b/c",
    expected: ["a/b/c/x.ts"],
  },
  {
    name: "empty input",
    paths: [],
    dir: "src",
    expected: [],
  },
  {
    name: "input order survives filtering",
    paths: ["src/z.ts", "else/a.ts", "src/b.ts", "src/a.ts"],
    dir: "src",
    expected: ["src/z.ts", "src/b.ts", "src/a.ts"],
  },
  {
    name: "backslashes are literal filename characters",
    paths: ["a\\b/x.ts", "a/b/x.ts", "a\\b2/x.ts"],
    dir: "a\\b",
    expected: ["a\\b/x.ts"],
  },
  {
    name: "spaces, quotes and colons are literal filename characters",
    paths: ['a "b":c/x.ts', 'a "b":c2/x.ts'],
    dir: 'a "b":c',
    expected: ['a "b":c/x.ts'],
  },
];

for (const { name, paths, dir, expected } of descendantCases) {
  test(`entriesUnderFolder: ${name}`, () => {
    const items = Object.freeze(entries(paths));
    const result = entriesUnderFolder(items, getPath, dir);
    assert.deepEqual(result.map(getPath), expected);
    assert.notEqual(result, items);
    for (const item of result) assert.ok(items.includes(item));
  });
}

test("renames match the new path and retain origPath outside the folder", () => {
  const renamedIn = Object.freeze({
    path: "tools/new.ts",
    origPath: "lib/old.ts",
  });
  const renamedOut = Object.freeze({
    path: "lib/new.ts",
    origPath: "tools/old.ts",
  });
  const result = entriesUnderFolder([renamedIn, renamedOut], getPath, "tools");
  assert.deepEqual(result, [renamedIn]);
  assert.equal(result[0], renamedIn);
  assert.equal(result[0].origPath, "lib/old.ts");
});

test("reserved names remain in mixed and all-reserved folder counts", () => {
  const mixed = entries([
    ...Array.from({ length: 11 }, (_, i) => `tools/file${i}.ts`),
    "tools/nul",
  ]);
  const allReserved = entries(["reserved/nul", "reserved/CON", "reserved/aux"]);
  assert.deepEqual(entriesUnderFolder(mixed, getPath, "tools"), mixed);
  assert.equal(entriesUnderFolder(mixed, getPath, "tools").length, 12);
  assert.deepEqual(
    entriesUnderFolder(allReserved, getPath, "reserved"),
    allReserved,
  );
});

test("MM entries retain both sides while selection uses the caller's list", () => {
  const mm = Object.freeze({ path: "tools/mm.ts", staged: "M", unstaged: "M" });
  const stagedOnly = Object.freeze({
    path: "tools/staged.ts",
    staged: "M",
    unstaged: null,
  });
  const unstagedOnly = Object.freeze({
    path: "tools/unstaged.ts",
    staged: null,
    unstaged: "M",
  });
  const items = [mm, stagedOnly, unstagedOnly];
  assert.deepEqual(
    entriesUnderFolder(
      items.filter((item) => item.unstaged !== null),
      getPath,
      "tools",
    ),
    [mm, unstagedOnly],
  );
  assert.deepEqual(
    entriesUnderFolder(
      items.filter((item) => item.staged !== null),
      getPath,
      "tools",
    ),
    [mm, stagedOnly],
  );
});

// Include intermediate chain paths: collapsing one can change compaction keys.
function folderPaths(items) {
  const paths = new Set();
  for (const item of items) {
    const segments = item.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      paths.add(segments.slice(0, i).join("/"));
    }
  }
  return [...paths];
}

const propertyCorpora = [
  ["src/x.ts", "src2/x.ts"],
  ["a/b/c/x.ts"],
  ["root.ts", "src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts"],
  ["space dir/a.ts", "colon:dir/b.ts", "back\\slash/c.ts", 'quote"dir/d.ts'],
  ...[1, 2, 3].map((depth) => {
    const chain = Array.from({ length: depth }, (_, i) => `dir${i}`);
    return chain.flatMap((_, i) => [
      `${chain.slice(0, i + 1).join("/")}/x.ts`,
      `${chain.slice(0, i + 1).join("/")}/nested/y.ts`,
    ]);
  }),
];

for (const [corpusIndex, paths] of propertyCorpora.entries()) {
  test(`PROPERTY: folder counts match flat targets, corpus ${corpusIndex}`, () => {
    const items = Object.freeze(entries(paths));
    const dirs = folderPaths(items);
    // All subsets includes empty, every proper subset, and fully collapsed.
    for (let mask = 0; mask < 2 ** dirs.length; mask++) {
      const collapsed = new Set(dirs.filter((_, index) => mask & (1 << index)));
      const rows = flattenPathTree(items, getPath, collapsed);
      const folders = rows.filter((row) => row.kind === "folder");
      assert.ok(folders.length > 0);
      for (const row of folders) {
        assert.equal(
          entriesUnderFolder(items, getPath, row.path).length,
          row.fileCount,
          `corpus ${corpusIndex}, collapse ${mask}, folder ${row.path}`,
        );
      }
    }
  });
}

const folderKey = "folder:unstaged:src/a";
const child = "unstaged:src/a/x.ts";
const nested = "folder:unstaged:src/a/deep";
const before = "unstaged:before.ts";
const after = "unstaged:after.ts";
const twin = "folder:staged:src/a";
const deeperTwin = "folder:staged:src/a/b";
const otherFile = "staged:src/a/x.ts";

const focusCases = [
  {
    name: "first surviving row after the block in previous order",
    prev: [before, folderKey, nested, child, "unstaged:gone.ts", after, twin],
    now: [twin, before, after],
    expected: after,
  },
  {
    name: "all after gone: nearest surviving row above",
    prev: ["header:unstaged", before, folderKey, child, after],
    now: [twin, "header:unstaged", before],
    expected: before,
  },
  {
    name: "exact other-section folder twin",
    prev: [before, folderKey, child, after],
    now: [otherFile, twin],
    expected: twin,
  },
  {
    name: "other-section folder twin compacted deeper",
    prev: [folderKey, child],
    now: [otherFile, deeperTwin, twin],
    expected: deeperTwin,
  },
  {
    name: "other-section file when no folder twin exists",
    prev: [folderKey, child],
    now: ["staged:src/ab/x.ts", otherFile, "staged:src/a/y.ts"],
    expected: otherFile,
  },
  {
    name: "nothing anywhere",
    prev: [folderKey, child],
    now: [],
    expected: null,
  },
  {
    name: "folder absent from previous rows",
    prev: [child, after],
    now: [after, twin],
    expected: null,
  },
  {
    name: "surviving same-section descendants and the folder are skipped",
    prev: [before, folderKey, nested, child, after],
    now: [folderKey, nested, child, after],
    expected: after,
  },
  {
    name: "same-section block members above are also skipped",
    prev: [before, child, folderKey, after],
    now: [child, before],
    expected: before,
  },
  {
    name: "block-only survivors never become a fallback",
    prev: [folderKey, nested, child],
    now: [folderKey, nested, child],
    expected: null,
  },
  {
    name: "same-section file equal to the directory belongs to the block",
    prev: [folderKey, "unstaged:src/a", after],
    now: ["unstaged:src/a", after],
    expected: after,
  },
  {
    name: "prefix sibling is outside the block",
    prev: [folderKey, child, "folder:unstaged:src/ab", after],
    now: ["folder:unstaged:src/ab", after],
    expected: "folder:unstaged:src/ab",
  },
  {
    name: "opposite-section same-path row is outside the block",
    prev: [folderKey, otherFile, after],
    now: [otherFile, after],
    expected: otherFile,
  },
  {
    name: "surviving header before wins over a new twin",
    prev: ["header:unstaged", folderKey, child],
    now: [twin, "header:unstaged"],
    expected: "header:unstaged",
  },
  {
    name: "fallback excludes sibling prefixes, ancestors and equal file paths",
    prev: [folderKey, child],
    now: [
      "folder:staged:src/ab",
      "folder:staged:src",
      "staged:src/a",
      "staged:src/ab/x.ts",
      "header:staged",
    ],
    expected: null,
  },
];

for (const { name, prev, now, expected } of focusCases) {
  test(`rowAfterFolderLeaves: ${name}`, () => {
    assert.equal(
      rowAfterFolderLeaves(Object.freeze(prev), folderKey, Object.freeze(now)),
      expected,
    );
  });
}

test("rowAfterFolderLeaves: unparsable folder keys return null", () => {
  for (const key of ["", child, "header:unstaged", "folder:other:src/a"]) {
    assert.equal(rowAfterFolderLeaves([key, after], key, [after, twin]), null);
  }
});

test("rowAfterFolderLeaves: staged emptying finds its unstaged twin", () => {
  assert.equal(
    rowAfterFolderLeaves([twin, otherFile], twin, [folderKey]),
    folderKey,
  );
});

test("rowAfterFolderLeaves: hostile path characters stay literal", () => {
  const dir = 'space dir/a:b\\c"d';
  const key = `folder:unstaged:${dir}`;
  const descendant = `unstaged:${dir}/x.ts`;
  const other = `folder:staged:${dir}/nested`;
  assert.equal(rowAfterFolderLeaves([key, descendant], key, [other]), other);
});

test("negative control: descendant cases reject bare-prefix matching", () => {
  const items = entries(["src/a.ts", "src2/b.ts"]);
  const barePrefix = items.filter((item) => item.path.startsWith("src"));
  assert.throws(() => assert.deepEqual(barePrefix.map(getPath), ["src/a.ts"]), {
    code: "ERR_ASSERTION",
  });
});

test("negative control: folder counts reject visible-leaves-only targets", () => {
  const items = entries(["src/a.ts", "src/nested/b.ts"]);
  const rows = flattenPathTree(items, getPath, new Set(["src/nested"]));
  const folder = rows.find(
    (row) => row.kind === "folder" && row.path === "src",
  );
  assert.ok(folder);
  const visible = rows
    .filter((row) => row.kind === "leaf")
    .map((row) => row.item);
  assert.throws(
    () => {
      assert.equal(
        entriesUnderFolder(visible, getPath, "src").length,
        folder.fileCount,
      );
    },
    { code: "ERR_ASSERTION" },
  );
});

test("negative control: focus order rejects a surviving block descendant", () => {
  const prev = [folderKey, child, after];
  const now = [child, after];
  const unfilteredNext = prev.slice(1).find((key) => now.includes(key));
  assert.throws(() => assert.equal(unfilteredNext, after), {
    code: "ERR_ASSERTION",
  });
});

// Wiring pins: source scans over the files the folder menu spans. Each read
// fails on a missing or empty file, so an unreadable input never passes.
function readSource(rel) {
  const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.ok(text.trim().length > 0, `${rel} is empty`);
  return text.replace(/\r\n/g, "\n");
}

/** The body of `function <name>(` up to the next same-indent function. */
function functionBody(src, name) {
  const start = src.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const end = src.indexOf("\n  function ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

function pinPanel(src) {
  assert.ok(
    !src.includes("takes the whole-tree menu"),
    "the folder -> whole-tree menu comment is gone",
  );
  const menu = functionBody(src, "handleContextMenu");
  assert.ok(menu.includes("parseFolderRowKey(key)"), "folder key parsed");
  assert.ok(menu.includes('kind: "folder"'), "folder target minted");
  const stage = functionBody(src, "stageFolderIn");
  assert.ok(
    stage.includes("stageGuarded(targets)"),
    "stage rides stageGuarded",
  );
  assert.ok(stage.includes(".filter(canStage)"), "stage filters canStage");
  assert.ok(stage.includes("refuseIfSwitched("), "stage refuses a switch");
  const unstage = functionBody(src, "unstageFolderIn");
  assert.ok(unstage.includes("void unstage"), "unstage rides the mutation");
  assert.ok(
    unstage.includes(".mutateAsync(targets.flatMap(unstagePaths))"),
    "unstage flatMaps unstagePaths",
  );
  assert.ok(unstage.includes("refuseIfSwitched("), "unstage refuses a switch");
  // Discard leaves conflicted files out; Stash can't (git refuses any path
  // stash while one exists), so its menu items disable instead.
  const discard = functionBody(src, "requestDiscardFolder");
  assert.ok(
    discard.includes(
      'if (refuseIfSwitched(repo, "nothing was discarded")) return;',
    ),
    "discard refuses a switch",
  );
  assert.ok(
    discard.includes("excludeConflicted("),
    "discard leaves conflicted files out",
  );
  const stash = functionBody(src, "requestStashFolder");
  assert.ok(
    stash.includes(
      'if (refuseIfSwitched(repo, "nothing was stashed")) return;',
    ),
    "stash refuses a switch",
  );
  // The body runs on to the next plain `function`, so read up to Bulk ignore.
  assert.ok(
    !stash
      .slice(0, stash.indexOf("// Bulk ignore:"))
      .includes("excludeConflicted"),
    "stash excludes nothing",
  );
}

function pinMenu(src) {
  const start = src.indexOf('if (target.kind === "folder")');
  assert.notEqual(start, -1, "folder branch not found");
  const end = src.indexOf('if (target.kind === "global")', start);
  assert.notEqual(end, -1, "global branch not found after the folder branch");
  const branch = src.slice(start, end);
  const group = branch.indexOf("<ContextMenuGroup>");
  const label = branch.indexOf("<ContextMenuLabel");
  const close = branch.indexOf("</ContextMenuGroup>");
  assert.ok(
    group !== -1 && group < label && label < close,
    "ContextMenuLabel sits inside ContextMenuGroup",
  );
  assert.ok(branch.includes("<PathText"), "heading renders through PathText");
  assert.ok(
    !branch.includes("discardAll"),
    "no Discard all in the folder menu",
  );
  assert.ok(!branch.includes("stashAll"), "no Stash all in the folder menu");
  // A folder whose files the filter hides all says so, never "nothing here".
  assert.ok(
    branch.includes(
      "if (files === 0 && hidden > 0) label = `No visible files to ${verb}`;",
    ),
    "all-hidden folder names the filter",
  );
  assert.ok(
    branch.includes('here is" : "s here are"} hidden by the filter.`'),
    "all-hidden footnote drops 'more'",
  );
  // 5A order: the Stage/Unstage anchor, Discard, Stash, then the footnote.
  const anchor = branch.indexOf(
    "onClick={staged ? actions.unstageFolder : actions.stageFolder}",
  );
  const discardAt = branch.indexOf("onClick={actions.discardFolder}");
  const stashAt = branch.indexOf("onClick={actions.stashFolder}");
  const note = branch.indexOf("id={noteId}");
  assert.ok(
    anchor !== -1 &&
      anchor < discardAt &&
      discardAt < stashAt &&
      stashAt < note,
    "folder actions sit in 5A order",
  );
  const itemOf = (at) =>
    branch.slice(
      branch.lastIndexOf("<ContextMenuItem", at),
      branch.indexOf("</ContextMenuItem>", at),
    );
  const discard = itemOf(discardAt);
  const stash = itemOf(stashAt);
  // Discard hides at zero (it never renders disabled) and counts what it sends.
  assert.ok(
    branch.includes(
      "const discardable = staged\n      ? 0\n      : files - (folderCounts?.conflictedCount ?? 0);",
    ),
    "Discard counts the shown files minus conflicted ones, Changes only",
  );
  assert.ok(
    branch.includes("{discardable > 0 && (\n            <ContextMenuItem\n"),
    "Discard hides at zero",
  );
  assert.ok(!discard.includes("disabled="), "Discard never renders disabled");
  assert.ok(
    discard.includes(
      '{discardable === files\n                ? `Discard ${discardable} change${discardable === 1 ? "" : "s"}…`\n                : `Discard ${discardable} of ${files} changes…`}',
    ),
    "Discard says N of M when conflicted files stay",
  );
  // Stash counts the shown files it takes, hides when it takes none (like
  // Discard), and waits while anything is conflicted.
  assert.ok(
    branch.includes("{stashable > 0 && (\n"),
    "Stash renders only while it takes a file",
  );
  assert.ok(stash.includes("disabled={anyConflicted}"), "Stash disables");
  assert.ok(
    stash.includes("className={MENU_HELD_ROW_CLASS}"),
    "Stash stays hit-testable through a flip",
  );
  assert.ok(
    stash.includes(
      '{`${stashLabel(stashable, files)}${anyConflicted ? CONFLICT_HINT : ""}`}',
    ),
    "Stash counts the shown files it takes and names the reason",
  );
  for (const [name, item] of [
    ["Discard", discard],
    ["Stash", stash],
  ])
    assert.ok(
      item.includes("aria-describedby={hidden > 0 ? noteId : undefined}"),
      `${name} points at the filter footnote`,
    );
  assert.ok(
    branch.includes(
      '`${hidden} more ${hidden === 1 ? "is" : "are"} hidden by the filter and ${hidden === 1 ? "is" : "are"} left alone.`',
    ),
    "the footnote covers all three actions",
  );
}

const panelSrc = readSource("src/features/repository/ChangesPanel.tsx");
const menuSrc = readSource("src/features/repository/ChangesContextMenu.tsx");

test("wiring: the panel mints folder targets and stages through the shared paths", () => {
  pinPanel(panelSrc);
});

test("wiring: the folder menu's heading is a group label", () => {
  pinMenu(menuSrc);
});

test("wiring: registry carries both palette actions; the guide drops the old claim", () => {
  const registry = readSource("src/lib/hotkeys/registry.ts");
  assert.ok(registry.includes('id: "stage-folder"'));
  assert.ok(registry.includes('id: "unstage-folder"'));
  // Appended right after unstage-folder, palette-only.
  assert.ok(
    registry.includes(
      '    id: "unstage-folder",\n    label: "Unstage folder",\n    category: "Changes",\n    defaultBinding: null,\n  },\n  {\n    id: "discard-folder",\n    label: "Discard changes in folder…",\n    category: "Changes",\n    defaultBinding: null,\n  },\n  {\n    id: "stash-folder",\n    label: "Stash changes in folder…",\n    category: "Changes",\n    defaultBinding: null,\n  },\n',
    ),
    "both folder actions follow unstage-folder, unbound",
  );
  const help = readSource("src/features/help/content.ts");
  assert.ok(!help.includes("opens the whole-list menu"));
});

test("negative controls: the wiring pins catch their regressions", () => {
  const mutations = [
    [pinPanel, panelSrc, "stageGuarded(targets)", "stage.mutateAsync(targets)"],
    [
      pinPanel,
      panelSrc,
      "targets.flatMap(unstagePaths)",
      "targets.map((e) => e.path)",
    ],
    [pinPanel, panelSrc, 'kind: "folder"', 'kind: "global"'],
    [pinMenu, menuSrc, "<ContextMenuGroup>", "<>"],
    [pinMenu, menuSrc, "Show in Explorer", "{actions.discardAll}"],
    [pinMenu, menuSrc, "files === 0 && hidden > 0", "files === 0"],
    [pinMenu, menuSrc, "No visible files to ${verb}", "Nothing to ${verb}"],
    [
      pinMenu,
      menuSrc,
      '" here is" : "s here are"}',
      '" more is" : "s more are"}',
    ],
    [
      pinPanel,
      panelSrc,
      'if (refuseIfSwitched(repo, "nothing was discarded")) return;',
      "",
    ],
    [
      pinPanel,
      panelSrc,
      'if (refuseIfSwitched(repo, "nothing was stashed")) return;',
      "",
    ],
    [
      pinPanel,
      panelSrc,
      "entries: rows.pathEntries,",
      "entries: excludeConflicted(rows.pathEntries).targets,",
    ],
    [
      pinPanel,
      panelSrc,
      "excludeConflicted(rows.unstagedRows)",
      "({ targets: rows.unstagedRows, conflicted: [] })",
    ],
    // The Stash item must keep its disable while anything is conflicted.
    [
      pinMenu,
      menuSrc,
      "disabled={anyConflicted}\n              aria-describedby",
      "aria-describedby",
    ],
    [
      pinMenu,
      menuSrc,
      'stashLabel(stashable, files)}${anyConflicted ? CONFLICT_HINT : ""}',
      "stashLabel(stashable, files)}",
    ],
    [
      pinMenu,
      menuSrc,
      "stashLabel(stashable, files)",
      "stashLabel(files, files)",
    ],
    [
      pinMenu,
      menuSrc,
      "              className={MENU_HELD_ROW_CLASS}\n              disabled={anyConflicted}",
      "              disabled={anyConflicted}",
    ],
    [pinMenu, menuSrc, "{discardable > 0 && (", "{files > 0 && ("],
    [pinMenu, menuSrc, "{stashable > 0 && (", "{files > 0 && ("],
    [
      pinMenu,
      menuSrc,
      "`Discard ${discardable} of ${files} changes…`",
      "`Discard ${files} changes…`",
    ],
    [
      pinMenu,
      menuSrc,
      ": files - (folderCounts?.conflictedCount ?? 0);",
      ": files;",
    ],
    [
      pinMenu,
      menuSrc,
      "aria-describedby={hidden > 0 ? noteId : undefined}\n              onClick={actions.discardFolder}",
      "onClick={actions.discardFolder}",
    ],
    [
      pinMenu,
      menuSrc,
      "aria-describedby={hidden > 0 ? noteId : undefined}\n              onClick={actions.stashFolder}",
      "onClick={actions.stashFolder}",
    ],
    [
      pinMenu,
      menuSrc,
      '"is" : "are"} left alone.`',
      '"stays" : "stay"} unstaged.`',
    ],
  ];
  for (const [pin, src, from, to] of mutations) {
    assert.ok(src.includes(from), `mutation anchor ${from}`);
    assert.throws(() => pin(src.replace(from, () => to)), {
      code: "ERR_ASSERTION",
    });
  }
  assert.throws(() => functionBody("", "stageFolderIn"), {
    code: "ERR_ASSERTION",
  });
});
