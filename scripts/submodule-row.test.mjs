// Pins what a submodule row in Changes says and allows, from
// src/features/repository/submodule-row.ts: the row's words over every measured
// status token (none says "new commits", which the token can't know), the stage
// and discard blocks, the cause-aware "none stageable" copy, the root compare
// the open hook's walk-up guard rests on (its non-Windows half lives here,
// since the hook's jsdom suite poses as Windows), and the verdict memory
// DiffViewer keeps for the live selection.
//
// It also pins the wiring no jsdom test renders: ChangesPanel's stage, discard
// and open routes and DiffViewer's verdict memory, each by a mask-aware scan
// with an in-memory mutation control that must turn it red.
//
// The module imports the reserved-name module, which decides on
// `navigator.platform`, so the suite poses as Windows before its first import
// and loads it through the shared src hooks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Win32" },
  configurable: true,
});
const hooks = installSrcHooks();
after(() => hooks.deregister());

const {
  SUBMODULE_NOTHING_TO_STAGE,
  discardReach,
  noneStageableCopy,
  rememberSubmoduleVerdicts,
  sameRepoRoot,
  stageBlocks,
  submoduleDiscardBlocked,
  submoduleStageBlocked,
  submoduleVerdict,
  submoduleWords,
  submodulesLeftUnstagedCopy,
} = await import("../src/features/repository/submodule-row.ts");

/** A submodule record: `token` is porcelain v2's `S<c><m><u>`. */
const sub = (token, kinds, path = "vendor/sub") => ({
  path,
  staged: null,
  unstaged: null,
  ...kinds,
  submodule: {
    commitChanged: token[1] === "C",
    trackedModified: token[2] === "M",
    untracked: token[3] === "U",
  },
});
/** `MT SC..`: a staged change under an unstaged typechange; `worktreeIsGitlink`
 *  tells a repository in the file's place from a file in the gitlink's. */
const replacedOverEdit = (worktreeIsGitlink) => {
  const entry = sub("SC..", { staged: "modified", unstaged: "typechange" });
  return { ...entry, submodule: { ...entry.submodule, worktreeIsGitlink } };
};
const file = (path, unstaged = "modified") => ({
  path,
  staged: null,
  unstaged,
});

// [measured row, entry, staged side, words, stage-blocked, discard-blocked]
const ROWS = [
  [
    "1 .M S..U",
    sub("S..U", { unstaged: "modified" }),
    false,
    "untracked files",
    true,
    true,
  ],
  [
    "2 .M S.M.",
    sub("S.M.", { unstaged: "modified" }),
    false,
    "modified files",
    true,
    true,
  ],
  [
    "3 .M SC..",
    sub("SC..", { unstaged: "modified" }),
    false,
    "commit changed",
    false,
    true,
  ],
  [
    "4 .M SCMU",
    sub("SCMU", { unstaged: "modified" }),
    false,
    "commit changed, modified files, untracked files",
    false,
    true,
  ],
  [
    "6 .M S..U detached",
    sub("S..U", { unstaged: "modified" }),
    false,
    "untracked files",
    true,
    true,
  ],
  ["8 D. S...", sub("S...", { staged: "deleted" }), true, "", false, false],
  ["9 .D S...", sub("S...", { unstaged: "deleted" }), false, "", false, false],
  [
    "12 M. S...",
    sub("S...", { staged: "modified" }),
    true,
    "commit changed",
    false,
    false,
  ],
  [
    "13 MM SC.U staged",
    sub("SC.U", { staged: "modified", unstaged: "modified" }),
    true,
    "commit changed",
    false,
    true,
  ],
  [
    "13 MM SC.U unstaged",
    sub("SC.U", { staged: "modified", unstaged: "modified" }),
    false,
    "commit changed, untracked files",
    false,
    true,
  ],
  [
    "14 UU S...",
    sub("S...", { unstaged: "conflicted" }),
    false,
    "",
    false,
    false,
  ],
  [
    "14 UU S.MU",
    sub("S.MU", { unstaged: "conflicted" }),
    false,
    "",
    false,
    false,
  ],
  [
    "15 .M S.M. nested",
    sub("S.M.", { unstaged: "modified" }),
    false,
    "modified files",
    true,
    true,
  ],
  [
    "16 .T S...",
    sub("S...", { unstaged: "typechange" }),
    false,
    "",
    false,
    true,
  ],
  [
    "16b .T SC..",
    sub("SC..", { unstaged: "typechange" }),
    false,
    "",
    false,
    true,
  ],
  // A repository replaced the file over a staged edit: the index still holds
  // a plain file, so the staged row has no submodule words.
  [
    "MT SC.. repository over a staged file edit, staged",
    replacedOverEdit(true),
    true,
    "",
    false,
    true,
  ],
  [
    "MT SC.. repository over a staged file edit, unstaged",
    replacedOverEdit(true),
    false,
    "",
    false,
    true,
  ],
  // The other direction: a file over a moved pointer, whose index is a gitlink.
  [
    "MT SC.. file over a staged pointer move, staged",
    replacedOverEdit(false),
    true,
    "commit changed",
    false,
    true,
  ],
  ["17 A. S...", sub("S...", { staged: "added" }), true, "", false, false],
  ["8b ? sub/", file("sub/", "untracked"), false, "", false, false],
  ["plain file", file("a.ts"), false, "", false, false],
];

test("the row's words and blocks over every measured token", () => {
  for (const [
    name,
    entry,
    staged,
    words,
    stageBlocked,
    discardBlocked,
  ] of ROWS) {
    assert.equal(submoduleWords(entry, staged), words, `${name}: words`);
    assert.doesNotMatch(submoduleWords(entry, staged), /new commits/, name);
    assert.equal(
      submoduleStageBlocked(entry, staged),
      stageBlocked,
      `${name}: stage`,
    );
    assert.equal(
      submoduleDiscardBlocked(entry),
      discardBlocked,
      `${name}: discard`,
    );
  }
  assert.equal(
    SUBMODULE_NOTHING_TO_STAGE,
    "Nothing to stage: commit inside the submodule first",
  );
});

test("noneStageableCopy and stageBlocks name each cause", () => {
  const reserved = {
    reason:
      "Git can't stage Windows-reserved device names, and every file here has one",
    menuLabel: "Stage files (Windows-reserved names)",
  };
  const submodule = {
    reason: "Nothing to stage here: commit inside the submodule first",
    menuLabel: "Stage files (commit inside the submodule first)",
  };
  const both = {
    reason:
      "Nothing here can be staged: Windows-reserved names, and submodules whose commit hasn't changed",
    menuLabel: "Stage files (none can be staged)",
  };
  const dirty = sub("S.M.", { unstaged: "modified" });
  const lists = [
    [[file("nul"), file("dir/con.txt")], ["reserved"], reserved],
    [
      [dirty, sub("S..U", { unstaged: "modified" }, "b")],
      ["submodule"],
      submodule,
    ],
    [[file("nul"), dirty], ["reserved", "submodule"], both],
  ];
  for (const [rows, blocks, copy] of lists) {
    assert.deepEqual(stageBlocks(rows).toSorted(), blocks);
    assert.deepEqual(noneStageableCopy(stageBlocks(rows)), copy);
  }
  // A reserved name outranks the submodule cause on one row, as on the row.
  assert.deepEqual(
    stageBlocks([sub("S..U", { unstaged: "modified" }, "nul")]),
    ["reserved"],
  );
  // Staged-only rows and stageable ones add no cause.
  assert.deepEqual(
    stageBlocks([
      sub("S...", { staged: "modified" }),
      sub("SC..", { unstaged: "modified" }),
    ]),
    [],
  );
});

test("submodulesLeftUnstagedCopy counts the blocked submodule rows a stage skipped", () => {
  const dirty = sub("S.M.", { unstaged: "modified" });
  const moved = sub("SC..", { unstaged: "modified" }, "b");
  assert.equal(submodulesLeftUnstagedCopy([]), null);
  // Stageable rows, staged-only rows and reserved names add nothing.
  assert.equal(
    submodulesLeftUnstagedCopy([
      moved,
      file("a.ts"),
      sub("S...", { staged: "modified" }, "c"),
      sub("S..U", { unstaged: "modified" }, "nul"),
    ]),
    null,
  );
  assert.equal(
    submodulesLeftUnstagedCopy([moved, dirty, file("a.ts")]),
    "1 submodule was left unstaged: commit inside it first",
  );
  assert.equal(
    submodulesLeftUnstagedCopy([
      dirty,
      sub("S..U", { unstaged: "modified" }, "d"),
      moved,
    ]),
    "2 submodules were left unstaged: commit inside them first",
  );
});

test("discardReach drops exactly the withheld submodule rows, conflicts left to excludeConflicted", () => {
  const a = file("a.ts");
  const b = file("b.ts", "untracked");
  const dirty = sub("S.M.", { unstaged: "modified" });
  const swapped = sub("S...", { unstaged: "typechange" });
  const gone = sub("S...", { unstaged: "deleted" });
  const conflictedSub = sub("S.MU", { unstaged: "conflicted" });
  const conflicted = file("m.ts", "conflicted");
  assert.deepEqual(discardReach([a, dirty, b]), [a, b]);
  assert.deepEqual(
    discardReach([swapped, gone, conflictedSub, conflicted, a]),
    [gone, conflictedSub, conflicted, a],
  );
  assert.deepEqual(discardReach([]), []);
});

test("negative control: a discardReach that drops conflicts or keeps a submodule fails", async () => {
  const a = file("a.ts");
  const dirty = sub("S.M.", { unstaged: "modified" });
  const conflicted = file("m.ts", "conflicted");
  const pin = (reach) =>
    JSON.stringify(reach([a, dirty, conflicted])) ===
    JSON.stringify([a, conflicted]);
  assert.equal(pin(discardReach), true);
  assert.equal(
    pin((rows) => rows),
    false,
  );
  assert.equal(
    pin((rows) =>
      discardReach(rows).filter((r) => r.unstaged !== "conflicted"),
    ),
    false,
  );
});

test("sameRepoRoot folds separators and case only on Windows", () => {
  assert.equal(sameRepoRoot("/r/Sub", "/r/sub", false), false);
  assert.equal(sameRepoRoot("/r/Sub", "/r/sub", true), true);
  assert.equal(sameRepoRoot("/r/sub/", "/r/sub", false), true);
  assert.equal(sameRepoRoot("C:\\r", "c:/R/", true), true);
  assert.equal(sameRepoRoot("C:\\r", "C:/r", false), false);
  assert.equal(sameRepoRoot("C:\\r\\vendor\\sub", "C:\\r", true), false);
});

test("the verdict memory keeps the live selection's verdict once its record leaves", () => {
  const R = "/repo:false:vendor/sub";
  const P = "/repo:false:a.ts";
  const record = sub("S..U", { unstaged: "modified" });
  const prev = file("a.ts");
  // The click's render: the live row still has its record.
  const m0 = new Map();
  const m1 = rememberSubmoduleVerdicts(m0, [
    { key: R, record },
    { key: P, record: prev },
  ]);
  // The deferred render after status dropped the row.
  const m2 = rememberSubmoduleVerdicts(m1, [
    { key: R, record: undefined },
    { key: P, record: prev },
  ]);
  assert.equal(submoduleVerdict(m2, R, undefined), true);
  // Fed only the deferred key, the memory never saw R's record.
  const onlyDeferred = rememberSubmoduleVerdicts(
    rememberSubmoduleVerdicts(new Map(), [{ key: P, record: prev }]),
    [{ key: P, record: prev }],
  );
  assert.equal(submoduleVerdict(onlyDeferred, R, undefined), false);
  // Unchanged input returns the same object; unseen keys are dropped.
  assert.equal(
    rememberSubmoduleVerdicts(m2, [
      { key: R, record: undefined },
      { key: P, record: prev },
    ]),
    m2,
  );
  const m3 = rememberSubmoduleVerdicts(m2, [{ key: P, record: prev }]);
  assert.deepEqual([...m3.keys()], [P]);
  assert.equal(submoduleVerdict(m3, R, undefined), false);
  // A record always wins over the memory.
  assert.equal(submoduleVerdict(m2, R, file("vendor/sub")), false);
});

// --- wiring pins ------------------------------------------------------------

const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const PANEL = read("src/features/repository/ChangesPanel.tsx");
const MENU = read("src/features/repository/ChangesContextMenu.tsx");
const VIEWER = read("src/features/diff/DiffViewer.tsx");

/** The masked body of `function <name>(…) { … }`, or null. */
function functionBody(masked, name) {
  const hit = new RegExp(`\\bfunction ${name}\\s*\\(`).exec(masked);
  if (!hit) return null;
  const open = masked.indexOf("{", hit.index);
  const close = matchBrace(masked, open);
  return close === -1 ? null : masked.slice(open, close + 1);
}

const RESERVED_STRINGS = [
  "Stage files (Windows-reserved names)",
  "and every file here has one",
];

/** Problems with ChangesPanel's and the menu's submodule wiring. */
function wiringProblems(panel, menu) {
  const p = maskNonCode(panel, true);
  const m = maskNonCode(menu, true);
  const problems = [];
  // (1) canStage consults the shared stage block.
  const canStage = functionBody(p, "canStage");
  if (
    canStage === null ||
    !/!submoduleStageBlocked\(entry, false\)/.test(canStage)
  )
    problems.push("canStage doesn't consult submoduleStageBlocked");
  // (2) three cause derivations; the reserved copy lives in submodule-row.ts.
  const blocks = [...p.matchAll(/\bstageBlocks\(([^()]*)\)/g)].map((x) => x[1]);
  if (
    JSON.stringify(blocks.toSorted()) !==
    JSON.stringify(["bulk.unstagedRows", "shown", "unstagedEntries"])
  )
    problems.push(`stageBlocks is called over ${JSON.stringify(blocks)}`);
  for (const [name, text] of [
    ["ChangesPanel", panel],
    ["ChangesContextMenu", menu],
  ])
    for (const s of RESERVED_STRINGS)
      if (text.includes(s)) problems.push(`${name} spells "${s}"`);
  // (3) every discard route leaves the withheld rows out.
  for (const [route, re] of [
    ["selection", /\bexcludeConflicted\(discardReach\(bulk\.unstagedRows\)\)/],
    [
      "folder",
      /\bexcludeConflicted\(\s*discardReach\(rows\.unstagedRows\),?\s*\)/,
    ],
    ["cursor", /\bdiscardReach\(shown\)\.filter\(/],
  ])
    if (!re.test(p)) problems.push(`the ${route} discard skips discardReach`);
  const single = p.search(/\bdiscardFile: \(entry\) => \{/);
  const refuse = p.indexOf(
    "if (submoduleDiscardBlocked(entry)) return;",
    single,
  );
  const scope = p.indexOf("setDiscardScope({", single);
  if (single === -1 || refuse === -1 || scope === -1 || refuse > scope)
    problems.push("the single discard doesn't refuse a withheld row first");
  // (4) the folder counts and the menu's arithmetic.
  if (
    !/\bdiscardBlockedCount: staged\s*\?\s*0\s*:\s*shown\.filter\(submoduleDiscardBlocked\)\.length,/.test(
      p,
    )
  )
    problems.push("discardBlockedCount isn't the shown withheld rows");
  if (!/-\s*\(folderCounts\?\.discardBlockedCount \?\? 0\);/.test(m))
    problems.push("the folder menu doesn't subtract discardBlockedCount");
  // (5) ChangesPanel's one opener, handed to its double-click executor and the
  // menu; DiffViewer's palette twin is pinned by open-changed-file-wiring.
  if (
    [...p.matchAll(/\buseOpenSubmoduleAsRepo\(/g)].length !== 1 ||
    !/\bconst openSubmodule = useOpenSubmoduleAsRepo\(repoPath\);/.test(p)
  )
    problems.push("ChangesPanel doesn't hold one submodule opener");
  const openRow = functionBody(p, "openRow");
  if (
    openRow === null ||
    !/\brunOpenChangedFile\([\s\S]*\),\s*repoPath,\s*openSubmodule,?\s*\);/.test(
      openRow,
    )
  )
    problems.push("openRow doesn't pass the opener to runOpenChangedFile");
  if (!/\n\s*openSubmodule,\n\s*stashFile:/.test(p))
    problems.push("the menu's actions don't carry the opener");
  // (6) every stage route that skips rows names the submodules it left, read
  // before the stage and said only once it went ahead.
  const skip = functionBody(p, "stageSkippingSubmodules");
  if (
    skip === null ||
    !/const left = submodulesLeftUnstagedCopy\(listed\);\s*const staged = await stageGuarded\(targets\);\s*if \(staged && left !== null\) toast\.info\(left\);\s*return staged;/.test(
      skip,
    )
  )
    problems.push("stageSkippingSubmodules doesn't report the skipped rows");
  for (const [route, re] of [
    [
      "Stage all",
      /\bstageSkippingSubmodules\(stageableUnstaged, unstagedEntries\)/,
    ],
    [
      "selection",
      /\bstageSkippingSubmodules\(stageableSelected, bulk\.unstagedRows\)/,
    ],
    ["folder", /\bstageSkippingSubmodules\(targets, listed\)/],
  ])
    if (!re.test(p)) problems.push(`the ${route} stage doesn't report skips`);
  if ([...p.matchAll(/\bstageGuarded\(/g)].length !== 3)
    problems.push("a stage route bypasses stageSkippingSubmodules");
  return problems;
}

/** Problems with DiffViewer's verdict memory: both selections feed it. */
function viewerProblems(viewer) {
  const v = maskNonCode(viewer, true);
  const at = v.indexOf("rememberSubmoduleVerdicts(verdicts, [");
  if (at === -1) return ["DiffViewer doesn't remember verdicts"];
  const open = v.indexOf("[", at);
  const args = v.slice(open, matchBrace(v, open) + 1);
  const problems = [];
  if (!/\brecordOf\(selectedFile\)/.test(args))
    problems.push("the live selection isn't remembered");
  if (!/\brecordOf\(file\)/.test(args))
    problems.push("the deferred file isn't remembered");
  return problems;
}

/** `text` with `from` swapped for `to` exactly once. */
function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

test("ChangesPanel and the menu route submodule rows through the shared helpers", () => {
  assert.deepEqual(wiringProblems(PANEL, MENU), []);
  assert.deepEqual(viewerProblems(VIEWER), []);
});

test("negative controls: each wiring pin goes red", () => {
  const panelMutants = [
    ["    !submoduleStageBlocked(entry, false)\n", "    true\n"],
    [
      "noneStageableCopy(stageBlocks(unstagedEntries)).reason",
      "noneStageableCopy([]).reason",
    ],
    [
      "noneStageableCopy(stageBlocks(bulk.unstagedRows)).menuLabel",
      '"Stage files (Windows-reserved names)"',
    ],
    [
      "noneStageableCopy(stageBlocks(shown)).menuLabel",
      "noneStageableCopy(stageBlocks(sameSide)).menuLabel",
    ],
    [
      "excludeConflicted(discardReach(bulk.unstagedRows))",
      "excludeConflicted(bulk.unstagedRows)",
    ],
    [
      "excludeConflicted(\n      discardReach(rows.unstagedRows),\n    )",
      "excludeConflicted(rows.unstagedRows)",
    ],
    [": discardReach(shown).filter(", ": shown.filter("],
    ["if (submoduleDiscardBlocked(entry)) return;\n", ""],
    [": shown.filter(submoduleDiscardBlocked).length,", ": 0,"],
    [
      "      repoPath,\n      openSubmodule,\n    );",
      "      repoPath,\n      async () => false,\n    );",
    ],
    ["                    openSubmodule,\n", ""],
    ["    if (staged && left !== null) toast.info(left);\n", ""],
    [
      "const left = submodulesLeftUnstagedCopy(listed);",
      "const left = submodulesLeftUnstagedCopy(targets);",
    ],
    [
      "stageSkippingSubmodules(stageableUnstaged, unstagedEntries)",
      "stageGuarded(stageableUnstaged)",
    ],
    [
      "stageSkippingSubmodules(stageableSelected, bulk.unstagedRows)",
      "stageSkippingSubmodules(stageableSelected, stageableSelected)",
    ],
    [
      "void stageSkippingSubmodules(targets, listed)",
      "void stageGuarded(targets)",
    ],
  ];
  for (const [from, to] of panelMutants)
    assert.notDeepEqual(
      wiringProblems(mutate(PANEL, from, to), MENU),
      [],
      `panel mutant survived: ${to}`,
    );
  assert.notDeepEqual(
    wiringProblems(
      PANEL,
      mutate(
        MENU,
        " -\n        (folderCounts?.discardBlockedCount ?? 0);",
        ";",
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    wiringProblems(PANEL, `${MENU}\n// Stage files (Windows-reserved names)\n`),
    [],
  );
  // Dropping the live selection from the memory must go red.
  assert.notDeepEqual(
    viewerProblems(
      mutate(
        VIEWER,
        "      ? [{ key: keyOf(repoPath, selectedFile), record: recordOf(selectedFile) }]\n",
        "      ? []\n",
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    viewerProblems(
      mutate(
        VIEWER,
        "    ...(file ? [{ key: keyOf(repoPath, file), record: recordOf(file) }] : []),\n",
        "",
      ),
    ),
    [],
  );
});
