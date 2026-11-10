// Pins the Changes panel's Discard and Stash confirm titles and bodies byte for
// byte, from src/features/repository/changes-confirm-copy.ts: the live module
// renders every table row, and an in-memory mutant of each copy rule must fail
// at least one.
//
// The rules the table covers: the left-alone sentence goes before " This
// cannot be undone." in tracked arms and is appended in untracked ones; a
// one-target folder Discard takes the single-file wording; the reserved-name
// notes come after "This cannot be undone."; the whole-tree Discard and Stash
// sweep the repo's entries, not their scope, for reserved names; and the Stash
// count and note ride the any-component rule the backend's stash excludes on;
// the Stash count also leaves out the submodules and embedded repositories a
// stash can't take.
// After any reserved-name note, the whole-tree bodies add a submodule note
// while the repo holds a submodule whose staged or unstaged kind is `modified`
// (the states both commands leave in place), then a replaced-file warning while
// a nested repository replaced a tracked file; the note yields to the warning
// on such a row. A files scope takes neither.
//
// It also pins the copy's single source: no other src file spells either
// whole-tree body lead, and BranchSwitcher's whole-tree dialogs and
// ChangesPanel's own confirms read the live entries only while their repo is
// the live one (both through `confirmEntries`).
//
// The reserved-name module decides on `navigator.platform`, so the suite poses
// as Windows before its first import. Imported through the shared src hooks
// (dynamic, so they are registered before the module links); mutants load from
// memory under the module's own URL plus a query, so nothing is written to disk.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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
/** A submodule record: `token` is porcelain v2's `S<c><m><u>`; `flags` may set
 *  `worktreeIsGitlink` false (a file or nothing in the worktree). */
const submodule = (path, token, kinds, flags = {}) => ({
  path,
  staged: null,
  unstaged: null,
  ...kinds,
  submodule: {
    commitChanged: token[1] === "C",
    trackedModified: token[2] === "M",
    untracked: token[3] === "U",
    worktreeIsGitlink: true,
    ...flags,
  },
});

const RESERVED_DISCARD = ` Files with Windows-reserved names (like "nul") skip the recycle bin and are deleted permanently.`;
const RESERVED_STASH = ` New files with Windows-reserved names (like "nul") can't be stashed and stay in your working tree.`;
const SUBMODULE_DISCARD =
  " Submodules keep the commit they have checked out and any uncommitted files inside. Open a submodule to discard its uncommitted files.";
const SUBMODULE_STASH =
  " Submodules keep the commit they have checked out and any uncommitted files inside. Open a submodule to stash its uncommitted files.";
const REPLACED_1 =
  " 1 repository that replaced a tracked file is deleted with its commits — commit or move it first.";
const REPLACED_2 =
  " 2 repositories that replaced tracked files are deleted with their commits — commit or move them first.";
const DISCARD_ALL =
  "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.";
const STASH_ALL =
  'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.';

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
    `Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.${RESERVED_STASH}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree with an untracked file under a reserved directory",
    [tracked("a.ts"), untracked("con/x.txt")],
    ALL,
    ALL,
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
    `Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.${RESERVED_STASH}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree with a tracked reserved name",
    [tracked("docs/nul.txt")],
    ALL,
    ALL,
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
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
  [
    "whole tree, an untracked-only submodule beside a tracked file",
    [
      tracked("a.ts"),
      submodule("vendor/sub", "S..U", { unstaged: "modified" }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${SUBMODULE_DISCARD}`,
    `${STASH_ALL}${SUBMODULE_STASH}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree, a submodule with only a staged pointer",
    [submodule("vendor/sub", "S...", { staged: "modified" })],
    ALL,
    ALL,
    `${DISCARD_ALL}${SUBMODULE_DISCARD}`,
    `${STASH_ALL}${SUBMODULE_STASH}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree, a reserved untracked file and a dirty submodule",
    [
      untracked("nul"),
      submodule("vendor/sub", "S.M.", { unstaged: "modified" }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${RESERVED_DISCARD}${SUBMODULE_DISCARD}`,
    `${STASH_ALL}${RESERVED_STASH}${SUBMODULE_STASH}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  // A repository in a tracked file's place: both commands delete it (measured,
  // git 2.51.1, staged and unstaged).
  [
    "whole tree, a repository that replaced a tracked file",
    [tracked("a.ts"), submodule("x", "SC..", { unstaged: "typechange" })],
    ALL,
    ALL,
    `${DISCARD_ALL}${REPLACED_1}`,
    `${STASH_ALL}${REPLACED_1}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree, two repositories that replaced tracked files beside a dirty submodule",
    [
      submodule("x", "SC..", { unstaged: "typechange" }),
      submodule("y", "S...", { staged: "typechange" }),
      submodule("vendor/sub", "S.M.", { unstaged: "modified" }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${SUBMODULE_DISCARD}${REPLACED_2}`,
    `${STASH_ALL}${SUBMODULE_STASH}${REPLACED_2}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  // A replaced-file row modified on its other side leaves a plain file behind
  // (measured, git 2.51.1), so only the replaced-file warning speaks for it.
  [
    "whole tree, a staged replacement with dirty files inside",
    [
      submodule("x", "S.M.", {
        staged: "typechange",
        unstaged: "modified",
      }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${REPLACED_1}`,
    `${STASH_ALL}${REPLACED_1}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree, a staged edit then an unstaged replacement",
    [
      submodule("x", "SC..", {
        staged: "modified",
        unstaged: "typechange",
      }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${REPLACED_1}`,
    `${STASH_ALL}${REPLACED_1}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree, a staged replacement with dirty files beside a dirty submodule",
    [
      submodule("x", "S.M.", {
        staged: "typechange",
        unstaged: "modified",
      }),
      submodule("vendor/sub", "S.M.", { unstaged: "modified" }),
    ],
    ALL,
    ALL,
    `${DISCARD_ALL}${SUBMODULE_DISCARD}${REPLACED_1}`,
    `${STASH_ALL}${SUBMODULE_STASH}${REPLACED_1}`,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    // The other direction: a file sits where the gitlink was.
    "whole tree, files that replaced submodules",
    [
      submodule(
        "x",
        "S...",
        { unstaged: "typechange" },
        { worktreeIsGitlink: false },
      ),
      submodule(
        "y",
        "S...",
        { staged: "typechange" },
        { worktreeIsGitlink: false },
      ),
    ],
    ALL,
    ALL,
    DISCARD_ALL,
    STASH_ALL,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    "whole tree whose only submodule row is a removed folder",
    [submodule("vendor/sub", "S...", { unstaged: "deleted" })],
    ALL,
    ALL,
    DISCARD_ALL,
    STASH_ALL,
    "Discard all changes?",
    "Stash all changes?",
  ],
  [
    // git stash never saves a submodule row, so the selection's stash counts
    // only the file and names the submodule it leaves; Discard takes no note.
    "a selection holding a dirty submodule stashes the file and names the submodule",
    [submodule("vendor/sub", "S.M.", { unstaged: "modified" })],
    files([
      tracked("a.ts"),
      submodule("vendor/sub", "S.M.", { unstaged: "modified" }),
    ]),
    files(
      [
        tracked("a.ts"),
        submodule("vendor/sub", "S.M.", { unstaged: "modified" }),
      ],
      { leftAlone: { hidden: 0, conflicted: 0, submodules: 1 } },
    ),
    "Changes to 2 files will be discarded — tracked files are restored and untracked files moved to the recycle bin. This cannot be undone.",
    '1 selected file is saved to the stash and removed from your working tree. "Pop latest stash" restores it. 1 submodule is left as it is.',
    "Discard 2 changes?",
    "Stash 1 change?",
  ],
  [
    "a selection holding a pointer-moved submodule, a reserved file and two files",
    [],
    ALL,
    files(
      [
        tracked("a.ts"),
        tracked("b.ts"),
        untracked("nul"),
        submodule("vendor/sub", "SC..", { unstaged: "modified" }),
      ],
      { leftAlone: { hidden: 0, conflicted: 0, submodules: 1 } },
    ),
    DISCARD_ALL,
    `2 selected files are saved to the stash and removed from your working tree. "Pop latest stash" restores them. 1 submodule is left as it is.${RESERVED_STASH}`,
    "Discard all changes?",
    "Stash 2 changes?",
  ],
  [
    "a folder holding a staged pointer-moved submodule beside two files",
    [],
    ALL,
    files(
      [
        tracked("src/a.ts"),
        tracked("src/b.ts"),
        submodule("src/sub", "SC..", { staged: "modified" }),
      ],
      { folder: "src", leftAlone: { hidden: 0, conflicted: 0, submodules: 1 } },
    ),
    DISCARD_ALL,
    '2 files in src are saved to the stash and removed from your working tree. "Pop latest stash" restores them. 1 submodule is left as it is.',
    "Discard all changes?",
    "Stash 2 changes?",
  ],
  [
    "a selection that withholds a submodule beside a conflicted file",
    [],
    files([tracked("a.ts"), untracked("b.ts")], {
      leftAlone: { hidden: 0, conflicted: 1, submodules: 1 },
    }),
    files([tracked("a.ts")]),
    "Changes to 2 files will be discarded — tracked files are restored and untracked files moved to the recycle bin. 1 conflicted file is left as it is. 1 submodule is left as it is. This cannot be undone.",
    'a.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it.',
    "Discard 2 changes?",
    "Stash change?",
  ],
  [
    "a folder that withholds two submodules and hides a file",
    [],
    files([tracked("src/a.ts"), tracked("src/b.ts")], {
      folder: "src",
      leftAlone: { hidden: 1, conflicted: 0, submodules: 2 },
    }),
    ALL,
    "Changes to 2 files in src will be discarded. Tracked files are restored and untracked files move to the recycle bin. 1 file hidden by the filter is left as it is. 2 submodules are left as they are. This cannot be undone.",
    STASH_ALL,
    "Discard 2 changes?",
    "Stash all changes?",
  ],
  [
    "one untracked file and a withheld submodule only",
    [],
    files([untracked("new.ts")], {
      leftAlone: { hidden: 0, conflicted: 0, submodules: 1 },
    }),
    files([untracked("new.ts")], {
      leftAlone: { hidden: 0, conflicted: 0, submodules: 1 },
    }),
    "new.ts is untracked — it will be moved to the recycle bin. 1 submodule is left as it is.",
    'new.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it. 1 submodule is left as it is.',
    "Discard changes?",
    "Stash change?",
  ],
  [
    // A file took a removed submodule's path: `git stash push -u -- <path>`
    // saves the deletion and the file, one change (measured, git 2.51.1).
    "a selection holding a file and a submodule deletion whose path holds a file",
    [
      submodule("vendor/sub", "S...", { staged: "deleted" }),
      untracked("vendor/sub"),
    ],
    ALL,
    files(
      [tracked("a.ts"), submodule("vendor/sub", "S...", { staged: "deleted" })],
      { untrackedPaths: new Set(["vendor/sub"]) },
    ),
    DISCARD_ALL,
    '2 selected files are saved to the stash and removed from your working tree. "Pop latest stash" restores them.',
    "Discard all changes?",
    "Stash 2 changes?",
  ],
  [
    "a folder holding only a submodule deletion whose path holds a file",
    [],
    ALL,
    files([submodule("vendor/sub", "S...", { staged: "deleted" })], {
      folder: "vendor",
      untrackedPaths: new Set(["vendor/sub"]),
    }),
    DISCARD_ALL,
    '1 file in vendor is saved to the stash and removed from your working tree. "Pop latest stash" restores it.',
    "Discard all changes?",
    "Stash change?",
  ],
  [
    // Alone, the deletion saves nothing; another path's file doesn't count.
    "a lone submodule deletion",
    [],
    ALL,
    files([submodule("vendor/sub", "S...", { staged: "deleted" })], {
      untrackedPaths: new Set(["vendor/other"]),
      leftAlone: { hidden: 0, conflicted: 0, submodules: 1 },
    }),
    DISCARD_ALL,
    "Nothing will be stashed.",
    "Discard all changes?",
    "Stash change?",
  ],
  // An untracked path ending in `/` is a folder holding its own repository: a
  // path stash saves nothing of it.
  [
    "a selection of a file and an embedded repository",
    [],
    ALL,
    files([tracked("a.ts"), untracked("vendor/lib/")], {
      leftAlone: { hidden: 0, conflicted: 0, embedded: 1 },
    }),
    DISCARD_ALL,
    '1 selected file is saved to the stash and removed from your working tree. "Pop latest stash" restores it. 1 embedded repository is left as it is.',
    "Discard all changes?",
    "Stash 1 change?",
  ],
  [
    "a selection of two files and two embedded repositories",
    [],
    ALL,
    files(
      [
        tracked("a.ts"),
        untracked("b.ts"),
        untracked("vendor/lib/"),
        untracked("tools/x/"),
      ],
      { leftAlone: { hidden: 0, conflicted: 0, embedded: 2 } },
    ),
    DISCARD_ALL,
    '2 selected files are saved to the stash and removed from your working tree. "Pop latest stash" restores them. 2 embedded repositories are left as they are.',
    "Discard all changes?",
    "Stash 2 changes?",
  ],
  [
    "a folder holding only an embedded repository",
    [],
    ALL,
    files([untracked("vendor/lib/")], {
      folder: "vendor",
      leftAlone: { hidden: 0, conflicted: 0, embedded: 1 },
    }),
    DISCARD_ALL,
    "Nothing will be stashed.",
    "Discard all changes?",
    "Stash change?",
  ],
  [
    "a lone embedded repository",
    [],
    ALL,
    files([untracked("vendor/lib/")]),
    DISCARD_ALL,
    "Nothing will be stashed.",
    "Discard all changes?",
    "Stash change?",
  ],
];

/** Every way `mod` disagrees with the table (empty = the shipped copy). */
function tableFailures(mod) {
  const failures = [];
  for (const row of TABLE) {
    const [name, entries, discardScope, stashScope, ...want] = row;
    const discard = mod.discardConfirmCopy(discardScope, entries);
    const stash = mod.stashConfirmCopy(stashScope, entries);
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
    // appends the note, and the whole-tree arm sweeps the repo's entries.
    ["repoEntries.some(staysOutOfStash)", "repoEntries.some(isReservedName)"],
    [
      "restores them.${stashAllReservedNote}${stashAllSubmoduleNote}",
      "restores them.${stashAllSubmoduleNote}",
    ],
    [
      "const stashN = stashFiles.filter(\n    (e) =>\n      !staysOutOfStash(e) &&\n      !submoduleStaysOutOfStash(e, untracked) &&\n      !embeddedRepoStaysOutOfStash(e),\n  ).length;",
      "const stashN = stashFiles.length;",
    ],
    // The stash count leaves every submodule row out.
    ["      !submoduleStaysOutOfStash(e, untracked) &&\n", ""],
    // A submodule deletion stashes with the file that took its path, and only
    // the scope's own capture of the untracked paths says so.
    ["&&\n    !untrackedPaths.has(entry.path)", ""],
    [
      '(scope?.kind === "files" ? scope.untrackedPaths : undefined) ?? NO_PATHS;',
      "NO_PATHS;",
    ],
    [
      ': `Stash ${stashN} change${stashN === 1 ? "" : "s"}?`;',
      ": `Stash ${stashFiles.length} changes?`;",
    ],
    [
      "const stashReservedNote = stashFiles.some(staysOutOfStash)",
      "const stashReservedNote = stashFiles.some(isReservedName)",
    ],
    // Folder arm (ends the line), then the selection arm (ends the statement).
    [
      '"them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`\n',
      '"them"}.${stashSplitNote}${stashLeft}`\n',
    ],
    [
      '"them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`\n',
      '"them"}.${stashSplitNote}${stashReservedNote}`\n',
    ],
    // The single-file arm's note has no control: one file that stays out leaves
    // nothing to stash, so that arm never renders with a reserved file in scope.
    [
      "restores it.${stashSplitNote}${stashLeft}${stashReservedNote}`",
      "restores it.${stashSplitNote}${stashReservedNote}`",
    ],
    [
      '"them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`;',
      '"them"}.${stashSplitNote}${stashLeft}`;',
    ],
    [
      '"them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`;',
      '"them"}.${stashSplitNote}${stashReservedNote}`;',
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
    // The whole-tree submodule notes: present, after the reserved note, and
    // keyed on a submodule whose staged or unstaged kind is modified.
    [
      '.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}${discardSubmoduleNote}',
      '.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}',
    ],
    [
      "restores them.${stashAllReservedNote}${stashAllSubmoduleNote}",
      "restores them.${stashAllReservedNote}",
    ],
    [
      '.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}${discardSubmoduleNote}',
      '.${discardSubmoduleNote}${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}',
    ],
    [
      '(entry.unstaged === "modified" || entry.staged === "modified")',
      'entry.unstaged === "modified"',
    ],
    ["entry.submodule !== undefined &&\n    (entry", "(entry"],
    // Withheld submodule rows join the left-alone sentence, each count its own.
    [
      "submodulesLeftSentence(scope.leftAlone?.submodules ?? 0)",
      "submodulesLeftSentence(0)",
    ],
    ['"1 submodule is left as it is."', '"1 submodule is skipped."'],
    [
      "`${n} submodules are left as they are.`",
      "`${n} submodule are left as they are.`",
    ],
  ];
  for (const [from, to] of mutations) {
    const mutant = await importMutated(from, to);
    assert.notDeepEqual(tableFailures(mutant), [], `mutant survived: ${to}`);
  }
});

test("negative controls: each embedded-repository term fails its own rows", async () => {
  const left = [
    "a selection of a file and an embedded repository: stash body",
    "a selection of two files and two embedded repositories: stash body",
  ];
  for (const [from, to, want] of [
    // The stash count leaves an embedded repository out.
    [
      "      !submoduleStaysOutOfStash(e, untracked) &&\n      !embeddedRepoStaysOutOfStash(e),\n",
      "      !submoduleStaysOutOfStash(e, untracked),\n",
      [
        "a selection of a file and an embedded repository: stash body",
        "a selection of a file and an embedded repository: stash title",
        "a selection of two files and two embedded repositories: stash body",
        "a selection of two files and two embedded repositories: stash title",
        "a folder holding only an embedded repository: stash body",
        "a lone embedded repository: stash body",
      ],
    ],
    // The left-alone sentence names the embedded repositories.
    [
      "          embeddedLeftSentence(scope.leftAlone?.embedded ?? 0),\n",
      "",
      left,
    ],
    [
      '"1 embedded repository is left as it is."',
      '"1 embedded repo is left as it is."',
      left.slice(0, 1),
    ],
    [
      "`${n} embedded repositories are left as they are.`",
      "`${n} embedded repository are left as they are.`",
      left.slice(1),
    ],
  ]) {
    const mutant = await importMutated(from, to);
    assert.deepEqual(tableFailures(mutant), want, `mutant: ${to}`);
  }
});

test("negative controls: each replaced-file repository term fails its own rows", async () => {
  const one = "whole tree, a repository that replaced a tracked file";
  const two =
    "whole tree, two repositories that replaced tracked files beside a dirty submodule";
  const other = "whole tree, files that replaced submodules";
  const stagedDirty =
    "whole tree, a staged replacement with dirty files inside";
  const stagedEdit = "whole tree, a staged edit then an unstaged replacement";
  const beside =
    "whole tree, a staged replacement with dirty files beside a dirty submodule";
  const bodies = (...names) =>
    names.flatMap((n) => [`${n}: discard body`, `${n}: stash body`]);
  for (const [from, to, want] of [
    // The predicate dropped: no row gets the warning.
    [
      "entries.filter(repoReplacedFile).length",
      "0",
      bodies(one, two, stagedDirty, stagedEdit, beside),
    ],
    // Either direction of typechange.
    [
      "entries.filter(repoReplacedFile)",
      'entries.filter((e) => e.unstaged === "typechange" || e.staged === "typechange")',
      bodies(other),
    ],
    // The unstaged side alone misses the staged shape.
    [
      "entries.filter(repoReplacedFile)",
      'entries.filter((e) => e.submodule?.worktreeIsGitlink === true && e.unstaged === "typechange")',
      bodies(two, stagedDirty, beside),
    ],
    // A replaced-file row modified on its other side isn't one that stays put.
    ["    !repoReplacedFile(entry) &&\n", "", bodies(stagedDirty, stagedEdit)],
    // Each whole-tree body carries it, after the submodule note.
    [
      "${discardSubmoduleNote}${discardReplacedNote}`",
      "${discardSubmoduleNote}`",
      [one, two, stagedDirty, stagedEdit, beside].map(
        (n) => `${n}: discard body`,
      ),
    ],
    [
      "${stashAllSubmoduleNote}${stashAllReplacedNote}`",
      "${stashAllSubmoduleNote}`",
      [one, two, stagedDirty, stagedEdit, beside].map(
        (n) => `${n}: stash body`,
      ),
    ],
    [
      "${discardSubmoduleNote}${discardReplacedNote}`",
      "${discardReplacedNote}${discardSubmoduleNote}`",
      [`${two}: discard body`, `${beside}: discard body`],
    ],
    // One wording slip apiece.
    [
      "is deleted with its commits — commit or move it first.",
      "is deleted — commit or move it first.",
      bodies(one, stagedDirty, stagedEdit, beside),
    ],
    [
      "are deleted with their commits — commit or move them first.",
      "are deleted with its commits — commit or move them first.",
      [`${two}: discard body`, `${two}: stash body`],
    ],
  ]) {
    const mutant = await importMutated(from, to);
    assert.deepEqual(tableFailures(mutant), want, `mutant: ${to}`);
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

// [entry, submoduleStaysOutOfStash, untracked paths]: every submodule row,
// whatever moved, except a submodule that became a file (its path stash saves
// that file), and a staged deletion whose path holds an untracked file. A
// file that became a submodule stays out like any gitlink.
const TWIN = new Set(["s"]);
const OFF = { worktreeIsGitlink: false };
const SUBMODULE_STASH_ROWS = [
  [submodule("s", "S...", { staged: "deleted" }, OFF), false, TWIN],
  [submodule("s", "S...", { staged: "deleted" }, OFF), true, new Set(["t"])],
  [submodule("s", "S...", { staged: "deleted" }, OFF), true, new Set(["s/"])],
  [submodule("s", "S.M.", { unstaged: "modified" }), true],
  [submodule("s", "SC..", { unstaged: "modified" }), true],
  [submodule("s", "SC..", { staged: "modified" }), true],
  [submodule("s", "S..U", { unstaged: "modified" }), true],
  [submodule("s", "S...", { unstaged: "deleted" }, OFF), true],
  [submodule("s", "S...", { staged: "added" }), true],
  [submodule("s", "S...", { staged: "deleted" }, OFF), true],
  [submodule("s", "S...", { unstaged: "typechange" }, OFF), false],
  [submodule("s", "S...", { staged: "typechange" }, OFF), false],
  [submodule("s", "SC..", { unstaged: "typechange" }), true],
  [submodule("s", "S...", { staged: "typechange" }), true],
  [tracked("a.ts"), false],
  [untracked("nul"), false],
];

function submoduleStashFailures(mod) {
  return SUBMODULE_STASH_ROWS.filter(
    ([entry, out, paths = new Set()]) =>
      mod.submoduleStaysOutOfStash(entry, paths) !== out,
  ).map(([entry]) => `${entry.unstaged ?? entry.staged} ${entry.path}`);
}

test("submoduleStaysOutOfStash takes every submodule row but a typechange or a deletion beside a file, dirty-only and pointer-moved", async () => {
  assert.deepEqual(submoduleStashFailures(real), []);
  const pathsOf = (mod) => [
    ...mod.untrackedPathsOf([
      submodule("s", "S...", { staged: "deleted" }),
      untracked("s"),
      tracked("a.ts"),
      untracked("b.ts"),
      // An embedded repository's folder record is no file twin.
      untracked("c/"),
    ]),
  ];
  assert.deepEqual(pathsOf(real), ["s", "b.ts"]);
  const untrackedFilter =
    'if (e.unstaged === "untracked" && !e.path.endsWith("/")) paths.add(e.path);';
  for (const to of [
    "paths.add(e.path);",
    'if (e.unstaged === "untracked") paths.add(e.path);',
  ]) {
    const mutant = await importMutated(untrackedFilter, to);
    assert.notDeepEqual(pathsOf(mutant), ["s", "b.ts"], to);
  }
  for (const [from, to] of [
    ["&&\n    !untrackedPaths.has(entry.path)", ""],
    ["!submoduleFileOnDisk(entry) &&", ""],
    // The guess the status fact replaced: any typechange stashes.
    [
      "!submoduleFileOnDisk(entry) &&",
      '!(entry.staged === "typechange" || entry.unstaged === "typechange") &&',
    ],
    // The direction alone, deletions included.
    [
      "!submoduleFileOnDisk(entry) &&",
      "entry.submodule.worktreeIsGitlink !== false &&",
    ],
  ]) {
    const mutant = await importMutated(from, to);
    assert.notDeepEqual(submoduleStashFailures(mutant), [], to);
  }
});

const SRC_DIR = new URL("../src/", import.meta.url);
const COPY_FILE = "features/repository/changes-confirm-copy.ts";
const WHOLE_TREE_LEADS = [
  "All uncommitted changes are discarded",
  "Sets your working tree back to the last commit",
];

/** Every src `.ts`/`.tsx` file as `{ path, text }`, path relative to src/. */
function srcFiles() {
  return readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => {
      const full = join(d.parentPath, d.name);
      return {
        path: relative(fileURLToPath(SRC_DIR), full).replaceAll("\\", "/"),
        text: readFileSync(full, "utf8"),
      };
    });
}

/** Files other than the copy module that spell a whole-tree body lead. */
function twinSpellers(files) {
  return files
    .filter((f) => f.path !== COPY_FILE)
    .filter((f) => WHOLE_TREE_LEADS.some((lead) => f.text.includes(lead)))
    .map((f) => f.path);
}

test("only changes-confirm-copy.ts spells the whole-tree body leads", () => {
  const files = srcFiles();
  assert.ok(files.length > 100, `src walk read ${files.length} files`);
  assert.ok(
    files.some((f) => f.path === COPY_FILE),
    "the walk reaches the copy module",
  );
  assert.deepEqual(twinSpellers(files), []);
});

test("negative control: a twin of a whole-tree lead is caught", () => {
  for (const lead of WHOLE_TREE_LEADS)
    assert.deepEqual(
      twinSpellers([
        { path: COPY_FILE, text: lead },
        { path: "features/x/Fake.tsx", text: `body="${lead}."` },
      ]),
      ["features/x/Fake.tsx"],
    );
});

const BRANCH_SWITCHER = readFileSync(
  new URL("../src/features/repository/BranchSwitcher.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** The ConfirmDialog element opened by `open={<state> !== null}`. */
function dialogBlock(text, state) {
  const start = text.indexOf(`open={${state} !== null}`);
  if (start < 0) return null;
  return text.slice(
    text.lastIndexOf("<ConfirmDialog", start),
    text.indexOf("/>", start),
  );
}

/** Ways BranchSwitcher's whole-tree dialogs drift from the shared copy. */
function branchSwitcherWiringFailures(text) {
  const failures = [];
  const count = (needle) => text.split(needle).length - 1;
  if (
    !/const entriesFor = \(repo: string\) =>\s*confirmEntries\(repo, repoPath, status\.data\?\.entries \?\? \[\]\);/.test(
      text,
    )
  )
    failures.push("entriesFor: live entries only for the live repo");
  for (const [fn, state, copy] of [
    ["discardConfirmCopy", "discardAllIn", "discardAllCopy"],
    ["stashConfirmCopy", "stashAllIn", "stashAllCopy"],
  ]) {
    if (count(`${fn}(`) !== 1) failures.push(`${fn}: exactly one call`);
    const call = new RegExp(
      `const ${copy} = ${fn}\\(\\s*\\{ kind: "all", repo: ${state} \\?\\? repoPath \\},\\s*entriesFor\\(${state} \\?\\? repoPath\\),?\\s*\\);`,
    );
    if (!call.test(text)) failures.push(`${fn}: whole-tree scope + entriesFor`);
    const block = dialogBlock(text, state);
    if (block === null) {
      failures.push(`${state}: dialog not found`);
      continue;
    }
    if (!block.includes(`title={${copy}.title}`))
      failures.push(`${state}: title from the module`);
    if (!block.includes(`body={${copy}.body}`))
      failures.push(`${state}: body from the module`);
    if (/\b(title|body)=(["']|\{\s*["'`])/.test(block))
      failures.push(`${state}: a literal title or body`);
  }
  return failures;
}

test("BranchSwitcher's whole-tree dialogs render the shared copy", () => {
  assert.deepEqual(branchSwitcherWiringFailures(BRANCH_SWITCHER), []);
});

test("negative controls: BranchSwitcher wiring drift fails", () => {
  const guard = "confirmEntries(repo, repoPath, status.data?.entries ?? []);";
  assert.equal(BRANCH_SWITCHER.split(guard).length, 2, "guard anchor once");
  assert.notDeepEqual(
    branchSwitcherWiringFailures(
      BRANCH_SWITCHER.replace(guard, () => "status.data?.entries ?? [];"),
    ),
    [],
  );
  const body = "body={stashAllCopy.body}";
  assert.equal(BRANCH_SWITCHER.split(body).length, 2, "body anchor once");
  assert.notDeepEqual(
    branchSwitcherWiringFailures(
      BRANCH_SWITCHER.replace(
        body,
        () =>
          `body={'Sets your working tree back to the last commit and saves all uncommitted changes.'}`,
      ),
    ),
    [],
  );
});

test("confirmEntries passes the live entries only for the live repo", async () => {
  const live = [tracked("a.ts")];
  const rows = (mod) => [
    mod.confirmEntries("C:/r", "C:/r", live),
    mod.confirmEntries("C:/other", "C:/r", live),
    mod.confirmEntries(undefined, "C:/r", live),
  ];
  assert.deepEqual(rows(real), [live, [], []]);
  const mutant = await importMutated(
    "return scopeRepo === liveRepo ? liveEntries : [];",
    "return liveEntries;",
  );
  assert.notDeepEqual(rows(mutant), [live, [], []]);
});

const CHANGES_PANEL = readFileSync(
  new URL("../src/features/repository/ChangesPanel.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** Ways ChangesPanel's own Discard and Stash confirms drift from describing
 *  the live repo's entries only while their scope's repo is the live one. */
function changesPanelWiringFailures(text) {
  const failures = [];
  const count = (needle) => text.split(needle).length - 1;
  if (!text.includes("const entries = status.data?.entries ?? [];"))
    failures.push("entries: the live status");
  for (const [fn, scope] of [
    ["discardConfirmCopy", "shownDiscardScope"],
    ["stashConfirmCopy", "shownStashScope"],
  ]) {
    if (count(`${fn}(`) !== 1) failures.push(`${fn}: exactly one call`);
    const call = new RegExp(
      `${fn}\\(\\s*${scope},\\s*confirmEntries\\(${scope}\\?\\.repo, repoPath, entries\\),?\\s*\\)`,
    );
    if (!call.test(text)) failures.push(`${fn}: guarded live entries`);
  }
  return failures;
}

test("ChangesPanel's confirms read the live entries only for their own repo", () => {
  assert.deepEqual(changesPanelWiringFailures(CHANGES_PANEL), []);
});

test("negative controls: ChangesPanel confirm wiring drift fails", () => {
  for (const scope of ["shownDiscardScope", "shownStashScope"]) {
    const guarded = `confirmEntries(${scope}?.repo, repoPath, entries)`;
    assert.equal(
      CHANGES_PANEL.split(guarded).length,
      2,
      `${scope} anchor once`,
    );
    for (const to of ["entries", "[]"])
      assert.notDeepEqual(
        changesPanelWiringFailures(CHANGES_PANEL.replace(guarded, () => to)),
        [],
        `${scope} -> ${to}`,
      );
  }
});
