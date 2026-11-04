// Pins the Changes panel's Discard and Stash confirm bodies byte for byte. The
// copy builders are inline in ChangesPanel.tsx, so the suite slices their
// source (the reserved-name helpers and notes, plus the confirm-copy block),
// strips its types and runs it against a render table: the live code renders
// every row, and an in-memory mutant of the source must fail at least one.
//
// The rules the table covers: the left-alone sentence goes before " This
// cannot be undone." in tracked arms and is appended in untracked ones; a
// one-target folder Discard takes the single-file wording; the reserved-name
// notes come after "This cannot be undone."; and the Stash note rides the
// any-component rule the backend's path stash excludes on.
//
// The reserved-name module decides on `navigator.platform`, so the suite poses
// as Windows before importing it through the shared src hooks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Win32" },
  configurable: true,
});
const hooks = installSrcHooks();
after(() => hooks.deregister());

const { reservedDeviceName, pathHasReservedComponent } = await import(
  "../src/lib/git/reserved-device-name.ts"
);
const { leftAloneSentence } = await import(
  "../src/features/repository/bulk-row-targets.ts"
);

const panelSrc = readFileSync(
  new URL("../src/features/repository/ChangesPanel.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function between(src, start, end) {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = src.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return src.slice(from, to);
}

// stripTypeScriptTypes is experimental in Node 24 and warns on every call.
function strip(code) {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return stripTypeScriptTypes(code);
  } finally {
    process.emitWarning = emit;
  }
}

/** Compiles the panel's confirm-copy code from `src` into a renderer of
 *  { discardBody, stashBody } for the given scopes and repo entries. */
function compileCopy(src) {
  const helpers = between(
    src,
    "function isReservedName(entry: FileEntry): boolean {",
    "\ntype FilterKind",
  );
  const copy = between(
    src,
    "  const discardFiles =\n",
    "\n\n  // One row's inner content",
  );
  // Wrapped, since a bare top-level `return` doesn't strip.
  const body = `${strip(
    `function render() {\n${helpers}\n${copy}\nreturn { discardBody, stashBody };\n}`,
  )}\nreturn render();`;
  return new Function(
    "reservedDeviceName",
    "pathHasReservedComponent",
    "leftAloneSentence",
    "entries",
    "shownDiscardScope",
    "shownStashScope",
    body,
  ).bind(null, reservedDeviceName, pathHasReservedComponent, leftAloneSentence);
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

// [name, entries (the repo's), discard scope, stash scope, discard, stash]
const TABLE = [
  [
    "whole tree, nothing reserved",
    [tracked("a.ts")],
    ALL,
    ALL,
    "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.",
    'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.',
  ],
  [
    "whole tree with a reserved untracked file",
    [tracked("a.ts"), untracked("nul")],
    ALL,
    ALL,
    `All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.${RESERVED_DISCARD}`,
    'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.',
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
  ],
  [
    "one untracked file",
    [],
    files([untracked("new.ts")], { leftAlone: { hidden: 0, conflicted: 2 } }),
    files([untracked("new.ts")], { split: true }),
    "new.ts is untracked — it will be moved to the recycle bin. 2 conflicted files are left as they are.",
    'new.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it. A stash takes each file whole, staged and unstaged changes alike.',
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
  ],
  [
    "a selection, nothing reserved, nothing left alone",
    [],
    files([tracked("a.ts"), untracked("b.ts")]),
    files([tracked("a.ts")]),
    "Changes to 2 files will be discarded — tracked files are restored and untracked files moved to the recycle bin. This cannot be undone.",
    'a.ts is saved to the stash and removed from your working tree. "Pop latest stash" restores it.',
  ],
];

function renderTable(render) {
  for (const [
    name,
    entries,
    discardScope,
    stashScope,
    discard,
    stash,
  ] of TABLE) {
    const out = render(entries, discardScope, stashScope);
    assert.equal(out.discardBody, discard, `${name}: discard body`);
    assert.equal(out.stashBody, stash, `${name}: stash body`);
  }
}

test("confirm copy: every row renders its exact Discard and Stash body", () => {
  renderTable(compileCopy(panelSrc));
});

test("negative controls: a mutant of each copy rule fails the table", () => {
  const mutations = [
    // R6: tracked arms put the left-alone sentence before the undo sentence.
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
    // R6: untracked arms append it.
    [
      "so it will be deleted permanently.${discardLeft}`",
      "so it will be deleted permanently.`",
    ],
    [
      "it will be moved to the recycle bin.${discardLeft}`",
      "it will be moved to the recycle bin.`",
    ],
    // R12: the folder template starts at two targets.
    [
      "discardFolder !== undefined && discardFiles.length >= 2",
      "discardFolder !== undefined && discardFiles.length >= 1",
    ],
    // R13: the reserved note follows the undo sentence.
    [
      'This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;\n      // Per-file',
      '${discardHasReserved ? RESERVED_DISCARD_NOTE : ""} This cannot be undone.`;\n      // Per-file',
    ],
    [
      '${discardLeft} This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;\n    }',
      '${discardLeft}${discardHasReserved ? RESERVED_DISCARD_NOTE : ""} This cannot be undone.`;\n    }',
    ],
    // The stash note rides the any-component rule and every arm appends it.
    [
      "const stashReservedNote = stashFiles.some(staysOutOfStash)",
      "const stashReservedNote = stashFiles.some(isReservedName)",
    ],
    [
      "${stashSplitNote}${leftAloneOf(shownStashScope)}${stashReservedNote}`",
      "${stashSplitNote}${leftAloneOf(shownStashScope)}`",
    ],
    [
      "${stashSplitNote}${leftAloneOf(shownStashScope)}${stashReservedNote}`",
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
    assert.equal(
      panelSrc.split(from).length,
      2,
      `mutation anchor appears exactly once: ${from}`,
    );
    assert.throws(
      () => renderTable(compileCopy(panelSrc.replace(from, () => to))),
      { code: "ERR_ASSERTION" },
      `mutant survived: ${to}`,
    );
  }
});
