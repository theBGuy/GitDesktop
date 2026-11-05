// Pins the Changes panel's Discard and Stash confirm titles and bodies byte for
// byte, from src/features/repository/changes-confirm-copy.ts: the live module
// renders every table row, and an in-memory mutant of each copy rule must fail
// at least one.
//
// The rules the table covers: the left-alone sentence goes before " This
// cannot be undone." in tracked arms and is appended in untracked ones; a
// one-target folder Discard takes the single-file wording; the reserved-name
// notes come after "This cannot be undone."; the whole-tree Discard sweeps the
// repo's entries, not its scope, for reserved names; and the Stash count and
// note ride the any-component rule the backend's path stash excludes on.
//
// The reserved-name module decides on `navigator.platform`, so the suite poses
// as Windows before its first import. Imported through the shared src hooks
// (dynamic, so they are registered before the module links); mutants load from
// memory under the module's own URL plus a query, so nothing is written to disk.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const MODULE_URL = new URL(
  "../src/features/repository/changes-confirm-copy.ts",
  import.meta.url,
).href;

Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Win32" },
  configurable: true,
});
const hooks = installSrcHooks();
const mutants = new Map();
const loads = registerHooks({
  load(url, context, next) {
    const source = mutants.get(url);
    if (source === undefined) return next(url, context);
    return { format: "module-typescript", source, shortCircuit: true };
  },
});
after(() => {
  loads.deregister();
  hooks.deregister();
});

const real = await import(MODULE_URL);
const moduleSrc = readFileSync(new URL(MODULE_URL), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Imports the module with `from` replaced by `to`, from memory. */
async function importMutated(from, to) {
  assert.equal(
    moduleSrc.split(from).length,
    2,
    `mutation anchor appears exactly once: ${from}`,
  );
  const url = `${MODULE_URL}?mutant=${mutants.size}`;
  mutants.set(
    url,
    moduleSrc.replace(from, () => to),
  );
  return import(url);
}

const tracked = (path, staged = null) => ({
  path,
  staged,
  unstaged: "modified",
});
const untracked = (path) => ({ path, staged: null, unstaged: "untracked" });
const files = (entries, extra = {}) => ({
  kind: "files",
  entries,
  repo: "C:/r",
  ...extra,
});
const ALL = { kind: "all", repo: "C:/r" };

const RESERVED_DISCARD = ` Files with Windows-reserved names (like "nul") skip the recycle bin and are deleted permanently.`;
const RESERVED_STASH = ` New files with Windows-reserved names (like "nul") can't be stashed and stay in your working tree.`;

// [name, entries (the repo's), discard scope, stash scope, discard, stash,
//  discard title, stash title]
const TABLE = [
  [
    "whole tree, nothing reserved",
    [tracked("a.ts")],
    ALL,
    ALL,
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
    'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.',
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree with a reserved untracked file",
    [tracked("a.ts"), untracked("nul")],
    ALL,
    ALL,
    `All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.${RESERVED_DISCARD}`,
    'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.',
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "folder of two, one left alone, one reserved",
    [],
    files([tracked("src/a.ts"), untracked("src/nul")], {
      folder: "src",
      leftAlone: { hidden: 0, conflicted: 1 },
    }),
    files([tracked("src/a.ts"), tracked("src/b.ts"), untracked("src/nul")], {
      folder: "src",
      split: true,
      leftAlone: { hidden: 1, conflicted: 0 },
    }),
    `Changes to 2 files in src will be discarded. Tracked files are restored and untracked files move to the recycle bin. 1 conflicted file is left as it is. This cannot be undone.${RESERVED_DISCARD}`,
    `2 files in src are saved to the stash and removed from your working tree. "Pop latest stash" restores them. A stash takes each file whole, staged and unstaged changes alike. 1 file hidden by the filter is left as it is.${RESERVED_STASH}`,
    "Discard 2 changes?",
    "Stash 2 changes?",
  ],
  [
    "one-target folder, staged and unstaged",
    [],
    files([tracked("src/a.ts", "modified")], {
      folder: "src",
      leftAlone: { hidden: 1, conflicted: 0 },
    }),
    files([tracked("src/a.ts", "modified")], {
      folder: "src",
      leftAlone: { hidden: 2, conflicted: 0 },
    }),
    "Unstaged changes to src/a.ts will be discarded, returning it to its staged version. Its staged changes are kept. 1 file hidden by the filter is left as it is. This cannot be undone.",
    '1 file in src is saved to the stash and removed from your working tree. "Pop latest stash" restores it. 2 files hidden by the filter are left as they are.',
    "Discard changes?",
    "Stash change?",
  ],
  [
    "one-target folder, unstaged only",
    [],
    files([tracked("src/a.ts")], {
      folder: "src",
      leftAlone: { hidden: 2, conflicted: 1 },
    }),
    files([tracked("src/a.ts")]),
    "Unstaged changes to src/a.ts will be restored to the last committed version. 2 files hidden by the filter and 1 conflicted file are left as they are. This cannot be undone.",
    'src/a.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it.',
    "Discard changes?",
    "Stash change?",
  ],
  [
    "one-target folder, untracked reserved name",
    [],
    files([untracked("src/nul")], {
      folder: "src",
      leftAlone: { hidden: 1, conflicted: 0 },
    }),
    files([untracked("src/nul")], { folder: "src" }),
    "src/nul is untracked. Its Windows-reserved name can't go to the recycle bin, so it will be deleted permanently. 1 file hidden by the filter is left as it is.",
    `Nothing will be stashed.${RESERVED_STASH}`,
    "Discard changes?",
    "Stash change?",
  ],
  [
    "one untracked file",
    [],
    files([untracked("new.ts")], { leftAlone: { hidden: 0, conflicted: 2 } }),
    files([untracked("new.ts")], { split: true }),
    "new.ts is untracked — it will be moved to the recycle bin. 2 conflicted files are left as they are.",
    'new.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it. A stash takes each file whole, staged and unstaged changes alike.',
    "Discard changes?",
    "Stash change?",
  ],
  [
    "a selection, a reserved name below a reserved directory",
    [],
    files([tracked("a.ts"), untracked("nul")], {
      leftAlone: { hidden: 0, conflicted: 1 },
    }),
    files([tracked("a.ts"), tracked("b.ts"), untracked("aux/readme.md")]),
    `Changes to 2 files will be discarded — tracked files are restored and untracked files moved to the recycle bin. 1 conflicted file is left as it is. This cannot be undone.${RESERVED_DISCARD}`,
    `2 selected files are saved to the stash and removed from your working tree. "Pop latest stash" restores them.${RESERVED_STASH}`,
    "Discard 2 changes?",
    "Stash 2 changes?",
  ],
  [
    "a selection, nothing reserved, nothing left alone",
    [],
    files([tracked("a.ts"), untracked("b.ts")]),
    files([tracked("a.ts")]),
    "Changes to 2 files will be discarded — tracked files are restored and untracked files moved to the recycle bin. This cannot be undone.",
    'a.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it.',
    "Discard 2 changes?",
    "Stash change?",
  ],
  [
    "a two-file selection that stashes one",
    [],
    ALL,
    files([tracked("a.ts"), untracked("con/x.txt")]),
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
    `1 selected file is saved to the stash and removed from your working tree. "Pop latest stash" restores it.${RESERVED_STASH}`,
    "Discard all changes?",
    "Stash 1 change?",
  ],
  [
    "a selection of only reserved untracked files",
    [],
    ALL,
    files([untracked("nul"), untracked("con/x.txt")]),
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
    `Nothing will be stashed.${RESERVED_STASH}`,
    "Discard all changes?",
    "Stash 0 changes?",
  ],
];

/** Every way `mod` disagrees with the table (empty = the shipped copy). */
function tableFailures(mod) {
  const failures = [];
  for (const row of TABLE) {
    const [name, entries, discardScope, stashScope, ...want] = row;
    const discard = mod.discardConfirmCopy(discardScope, entries);
    const stash = mod.stashConfirmCopy(stashScope);
    const got = [discard.body, stash.body, discard.title, stash.title];
    for (const [i, part] of [
      "discard body",
      "stash body",
      "discard title",
      "stash title",
    ].entries())
      if (got[i] !== want[i]) failures.push(`${name}: ${part}`);
  }
  return failures;
}

// [entry, staysOutOfStash, isReservedName]
const RULE_ROWS = [
  [untracked("aux/readme.md"), true, false],
  [untracked("con/x.txt"), true, false],
  [untracked("docs/aux.txt"), true, true],
  [tracked("con/x.txt"), false, false],
  [tracked("docs/nul.txt"), false, true],
  [untracked("console/x.ts"), false, false],
];

/** Rows `mod`'s predicates get wrong (empty = the shipped rules). */
function ruleFailures(mod) {
  return RULE_ROWS.filter(
    ([entry, stays, reserved]) =>
      mod.staysOutOfStash(entry) !== stays ||
      mod.isReservedName(entry) !== reserved,
  ).map(([entry]) => `${entry.unstaged} ${entry.path}`);
}

test("confirm copy: every row renders its exact titles and bodies", () => {
  assert.deepEqual(tableFailures(real), []);
});

test("staysOutOfStash is the untracked any-component rule; isReservedName reads the name", () => {
  assert.deepEqual(ruleFailures(real), []);
});

test("negative controls: a mutant of each copy rule fails the table", async () => {
  const mutations = [
    // Tracked arms put the left-alone sentence before the undo sentence.
    [
      "move to the recycle bin.${discardLeft} This cannot be undone.${discardHasReserved",
      "move to the recycle bin. This cannot be undone.${discardLeft}${discardHasReserved",
    ],
    [
      "Its staged changes are kept.${discardLeft} This cannot be undone.",
      "Its staged changes are kept. This cannot be undone.${discardLeft}",
    ],
    [
      "to the last committed version.${discardLeft} This cannot be undone.",
      "to the last committed version. This cannot be undone.${discardLeft}",
    ],
    [
      "moved to the recycle bin.${discardLeft} This cannot be undone.",
      "moved to the recycle bin. This cannot be undone.${discardLeft}",
    ],
    // Untracked arms append it.
    [
      "so it will be deleted permanently.${discardLeft}`",
      "so it will be deleted permanently.`",
    ],
    [
      "it will be moved to the recycle bin.${discardLeft}`",
      "it will be moved to the recycle bin.`",
    ],
    // The folder template starts at two targets.
    [
      "discardFolder !== undefined && discardFiles.length >= 2",
      "discardFolder !== undefined && discardFiles.length >= 1",
    ],
    // The reserved note follows the undo sentence.
    [
      'This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;\n      // Per-file',
      '${discardHasReserved ? RESERVED_DISCARD_NOTE : ""} This cannot be undone.`;\n      // Per-file',
    ],
    [
      '${discardLeft} This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;\n    }',
      '${discardLeft}${discardHasReserved ? RESERVED_DISCARD_NOTE : ""} This cannot be undone.`;\n    }',
    ],
    // "all" sweeps the whole tree for reserved names.
    ['scope?.kind === "all" ? repoEntries : discardFiles', "discardFiles"],
    // The stash count and note ride the any-component rule; every files arm
    // appends the note (the whole-tree arm never does).
    [
      "const stashN = stashFiles.filter((e) => !staysOutOfStash(e)).length;",
      "const stashN = stashFiles.length;",
    ],
    [
      ': `Stash ${stashN} change${stashN === 1 ? "" : "s"}?`;',
      ": `Stash ${stashFiles.length} changes?`;",
    ],
    [
      "const stashReservedNote = stashFiles.some(staysOutOfStash)",
      "const stashReservedNote = stashFiles.some(isReservedName)",
    ],
    [
      "${stashSplitNote}${leftAloneOf(scope)}${stashReservedNote}`",
      "${stashSplitNote}${leftAloneOf(scope)}`",
    ],
    [
      "${stashSplitNote}${leftAloneOf(scope)}${stashReservedNote}`",
      "${stashSplitNote}${stashReservedNote}`",
    ],
    // The single-file arm's note has no control: one file that stays out leaves
    // nothing to stash, so that arm never renders with a reserved file in scope.
    [
      'restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}${stashReservedNote}`;',
      'restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}`;',
    ],
    [
      "`Nothing will be stashed.${stashReservedNote}`",
      "`Nothing will be stashed.`",
    ],
    // A selection with nothing stashable says so, not only a folder.
    [": stashN === 0\n", ": stashN === 0 && stashFolder !== undefined\n"],
    // The titles.
    ['? "Discard changes?"', '? "Discard change?"'],
    [
      "`Discard ${discardFiles.length} changes?`",
      "`Discard ${discardFiles.length} files?`",
    ],
    // The copy itself, one wording slip apiece.
    [
      "' New files with Windows-reserved names (like \"nul\") can\\'t be stashed",
      '\' New files with Windows-reserved names (like "nul") cannot be stashed',
    ],
    [
      '\' Files with Windows-reserved names (like "nul") skip the recycle bin',
      '\' Files with reserved names (like "nul") skip the recycle bin',
    ],
  ];
  for (const [from, to] of mutations) {
    const mutant = await importMutated(from, to);
    assert.notDeepEqual(tableFailures(mutant), [], `mutant survived: ${to}`);
  }
});

test("negative controls: a drifted stash-exclude rule fails its rows", async () => {
  for (const [from, to] of [
    [
      'return entry.unstaged === "untracked" && pathHasReservedComponent(entry.path);',
      "return pathHasReservedComponent(entry.path);",
    ],
    // The file name alone misses `con/x.txt`, which the backend leaves behind.
    [
      'return entry.unstaged === "untracked" && pathHasReservedComponent(entry.path);',
      'return entry.unstaged === "untracked" && isReservedName(entry);',
    ],
    [
      "return reservedDeviceName(entry.path) !== null;",
      "return pathHasReservedComponent(entry.path);",
    ],
  ]) {
    const mutant = await importMutated(from, to);
    assert.notDeepEqual(ruleFailures(mutant), [], `mutant survived: ${to}`);
  }
});
