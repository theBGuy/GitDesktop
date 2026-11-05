// Pins the Changes panel's row-based bulk targets: row actions (stage,
// unstage, discard) take the selected rows' own records, so a staged deletion
// never drags in its untracked twin, and path-level actions (stash, ignore,
// untrack, exclude) count each selected path once.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `bulk-row-targets.ts` must keep to type-only imports, which stripping erases:
// Node can't resolve the app's `@/` aliases. The ChangesPanel wiring and the
// ChangesContextMenu's shared-predicate greps are pinned by mask-aware source
// scans, each with in-memory mutation controls that must turn it red; the
// menu's rendered labels and gates live in src/test/changes-context-menu.test.tsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bulkRowTargets,
  canUntrack,
  excludeConflicted,
  isConflictedEntry,
  leftAloneSentence,
  rowEntry,
} from "../src/features/repository/bulk-row-targets.ts";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const PANEL = "src/features/repository/ChangesPanel.tsx";
const MENU = "src/features/repository/ChangesContextMenu.tsx";

// `git rm --cached old-notes.md` lists the path twice, the `?` record last.
const twinStaged = { path: "old-notes.md", staged: "deleted", unstaged: null };
const twinUntracked = {
  path: "old-notes.md",
  staged: null,
  unstaged: "untracked",
};
const mm = {
  path: "src/lib/path-tree.ts",
  staged: "modified",
  unstaged: "modified",
};
const m = { path: "app.ts", staged: null, unstaged: "modified" };
const renamed = {
  path: "new-name.ts",
  origPath: "old-name.ts",
  staged: "renamed",
  unstaged: null,
};
const reserved = { path: "docs/aux.txt", staged: null, unstaged: "untracked" };
const added = { path: "fresh.ts", staged: "added", unstaged: null };

const ENTRIES = [twinStaged, mm, renamed, added, twinUntracked, m, reserved];
const keys = (...k) => new Set(k);

test("a staged twin row alone discards nothing and marks its path split", () => {
  const t = bulkRowTargets(keys("staged:old-notes.md"), ENTRIES);
  assert.equal(t.rowCount, 1);
  assert.deepEqual(t.stagedRows, [twinStaged]);
  assert.deepEqual(t.unstagedRows, []);
  assert.deepEqual(t.pathEntries, [twinStaged]);
  // A staged deletion has no index entry for `git rm --cached` to remove.
  assert.deepEqual(t.trackedPathEntries, []);
  assert.deepEqual(t.splitPaths, ["old-notes.md"]);
});

test("the untracked twin row alone targets its own `?` record", () => {
  const t = bulkRowTargets(keys("unstaged:old-notes.md"), ENTRIES);
  assert.equal(t.rowCount, 1);
  assert.deepEqual(t.stagedRows, []);
  assert.deepEqual(t.unstagedRows, [twinUntracked]);
  assert.deepEqual(t.splitPaths, ["old-notes.md"]);
  assert.equal(rowEntry(ENTRIES, "old-notes.md", false), twinUntracked);
  assert.equal(rowEntry(ENTRIES, "old-notes.md", true), twinStaged);
});

test("both twin rows count as two rows over one path", () => {
  const t = bulkRowTargets(
    keys("staged:old-notes.md", "unstaged:old-notes.md"),
    ENTRIES,
  );
  assert.equal(t.rowCount, 2);
  assert.deepEqual(t.unstagedRows, [twinUntracked]);
  assert.equal(t.pathEntries.length, 1);
  assert.equal(t.trackedPathEntries.length, 0);
  assert.deepEqual(t.splitPaths, []);
});

test("an MM file's staged row alone leaves its unstaged side alone", () => {
  const t = bulkRowTargets(keys("staged:src/lib/path-tree.ts"), ENTRIES);
  assert.deepEqual(t.stagedRows, [mm]);
  assert.deepEqual(t.unstagedRows, []);
  assert.deepEqual(t.splitPaths, ["src/lib/path-tree.ts"]);
});

test("an MM file with both rows selected is one path in both row lists", () => {
  const t = bulkRowTargets(
    keys("staged:src/lib/path-tree.ts", "unstaged:src/lib/path-tree.ts"),
    ENTRIES,
  );
  assert.equal(t.rowCount, 2);
  assert.deepEqual(t.stagedRows, [mm]);
  assert.deepEqual(t.unstagedRows, [mm]);
  assert.deepEqual(t.pathEntries, [mm]);
  assert.deepEqual(t.splitPaths, []);
});

test("a staged rename passes through with its origPath", () => {
  const t = bulkRowTargets(keys("staged:new-name.ts"), ENTRIES);
  assert.equal(t.stagedRows[0], renamed);
  assert.equal(t.stagedRows[0].origPath, "old-name.ts");
});

test("a reserved-name row stays in unstagedRows (the caller filters)", () => {
  const t = bulkRowTargets(keys("unstaged:docs/aux.txt"), ENTRIES);
  assert.deepEqual(t.unstagedRows, [reserved]);
  assert.deepEqual(t.trackedPathEntries, []);
});

test("a lone staged deletion is not untrackable", () => {
  const gone = { path: "gone.txt", staged: "deleted", unstaged: null };
  const t = bulkRowTargets(keys("staged:gone.txt", "unstaged:app.ts"), [
    gone,
    m,
  ]);
  assert.deepEqual(t.stagedRows, [gone]);
  assert.deepEqual(t.trackedPathEntries, [m]);
});

test("canUntrack needs an index entry", () => {
  assert.equal(canUntrack(m), true);
  assert.equal(canUntrack(mm), true);
  assert.equal(canUntrack(renamed), true);
  // A working-tree deletion still has its index entry.
  assert.equal(canUntrack({ staged: null, unstaged: "deleted" }), true);
  assert.equal(canUntrack(twinStaged), false);
  assert.equal(canUntrack(twinUntracked), false);
  assert.equal(canUntrack(added), false);
});

test("a staged add is not untrackable", () => {
  const t = bulkRowTargets(keys("staged:fresh.ts", "unstaged:app.ts"), ENTRIES);
  assert.deepEqual(t.trackedPathEntries, [m]);
});

test("the mockup selection yields every 5B count", () => {
  const t = bulkRowTargets(
    keys(
      "staged:old-notes.md",
      "staged:src/lib/path-tree.ts",
      "unstaged:app.ts",
    ),
    ENTRIES,
  );
  assert.equal(t.rowCount, 3);
  assert.deepEqual(t.stagedRows, [twinStaged, mm]);
  assert.deepEqual(t.unstagedRows, [m]);
  assert.deepEqual(
    t.pathEntries.map((e) => e.path),
    ["old-notes.md", "src/lib/path-tree.ts", "app.ts"],
  );
  assert.deepEqual(t.trackedPathEntries, [mm, m]);
  assert.deepEqual(t.splitPaths, ["old-notes.md", "src/lib/path-tree.ts"]);
});

test("stale, folder and header keys are skipped", () => {
  const t = bulkRowTargets(
    keys(
      "unstaged:gone.ts",
      "staged:app.ts",
      "folder:unstaged:docs",
      "header:staged",
      "plain",
    ),
    ENTRIES,
  );
  assert.equal(t.rowCount, 0);
  assert.deepEqual(t.pathEntries, []);
  assert.deepEqual(t.splitPaths, []);
  assert.equal(rowEntry(ENTRIES, "app.ts", true), undefined);
  assert.equal(rowEntry(ENTRIES, "gone.ts", false), undefined);
});

test("an empty selection targets nothing", () => {
  assert.deepEqual(bulkRowTargets(new Set(), ENTRIES), {
    rowCount: 0,
    stagedRows: [],
    unstagedRows: [],
    pathEntries: [],
    trackedPathEntries: [],
    splitPaths: [],
  });
});

test("pathEntries follow entries order, not selection order", () => {
  const t = bulkRowTargets(
    keys("unstaged:app.ts", "unstaged:old-notes.md", "staged:new-name.ts"),
    ENTRIES,
  );
  assert.deepEqual(
    t.pathEntries.map((e) => e.path),
    ["old-notes.md", "new-name.ts", "app.ts"],
  );
  // The path's first record represents it, whichever row was selected.
  assert.equal(t.pathEntries[0], twinStaged);
});

// A conflicted record exists only in the Changes section (status.rs).
const conflicted = {
  path: "pr-gate/tools/merge.rs",
  staged: null,
  unstaged: "conflicted",
};

test("isConflictedEntry reads either side", () => {
  assert.equal(isConflictedEntry(conflicted), true);
  assert.equal(
    isConflictedEntry({ staged: "conflicted", unstaged: null }),
    true,
  );
  assert.equal(isConflictedEntry(mm), false);
  assert.equal(isConflictedEntry(twinUntracked), false);
  assert.equal(isConflictedEntry(twinStaged), false);
});

test("excludeConflicted splits in order and counts a record once", () => {
  const both = {
    path: "both.rs",
    staged: "conflicted",
    unstaged: "conflicted",
  };
  const t = excludeConflicted([m, conflicted, twinUntracked, both, reserved]);
  assert.deepEqual(t.targets, [m, twinUntracked, reserved]);
  assert.deepEqual(t.conflicted, [conflicted, both]);
  assert.deepEqual(excludeConflicted([]), { targets: [], conflicted: [] });
});

test("leftAloneSentence pluralizes each noun by its own count", () => {
  const table = [
    [0, 0, ""],
    [
      3,
      1,
      "3 files hidden by the filter and 1 conflicted file are left as they are.",
    ],
    [1, 0, "1 file hidden by the filter is left as it is."],
    [3, 0, "3 files hidden by the filter are left as they are."],
    [0, 1, "1 conflicted file is left as it is."],
    [0, 2, "2 conflicted files are left as they are."],
    [
      1,
      1,
      "1 file hidden by the filter and 1 conflicted file are left as they are.",
    ],
    [
      1,
      2,
      "1 file hidden by the filter and 2 conflicted files are left as they are.",
    ],
    [
      2,
      1,
      "2 files hidden by the filter and 1 conflicted file are left as they are.",
    ],
  ];
  for (const [hidden, conflictedCount, want] of table)
    assert.equal(
      leftAloneSentence(hidden, conflictedCount),
      want,
      `(${hidden}, ${conflictedCount})`,
    );
});

test("folder keys resolve through the selection's targets", () => {
  // A folder route synthesizes one key per shown file of its section.
  const folderTwinStaged = { ...twinStaged, path: "pr-gate/tools/old.md" };
  const folderTwin = { ...twinUntracked, path: "pr-gate/tools/old.md" };
  const odd = {
    path: "pr-gate/a b/c:d.ts",
    staged: null,
    unstaged: "modified",
  };
  const entries = [folderTwinStaged, conflicted, folderTwin, odd];
  const shown = [conflicted, folderTwin, odd];
  const t = bulkRowTargets(
    new Set(shown.map((e) => `unstaged:${e.path}`)),
    entries,
  );
  const discard = excludeConflicted(t.unstagedRows);
  assert.deepEqual(discard.targets, [folderTwin, odd]);
  assert.equal(discard.targets[0].unstaged, "untracked");
  assert.deepEqual(discard.conflicted, [conflicted]);
  // Stash keeps every shown path; the twin's staged deletion rides along.
  assert.deepEqual(
    t.pathEntries.map((e) => e.path),
    ["pr-gate/tools/old.md", "pr-gate/tools/merge.rs", "pr-gate/a b/c:d.ts"],
  );
  assert.deepEqual(t.splitPaths, ["pr-gate/tools/old.md"]);
});

/** The masked body of `function <name>(…) { … }` in `masked`, or null. */
function functionBody(masked, name) {
  const re = new RegExp(`\\bfunction ${name}\\s*\\(`);
  const hit = re.exec(masked);
  if (!hit) return null;
  const open = masked.indexOf("{", hit.index);
  const close = matchBrace(masked, open);
  return close === -1 ? null : masked.slice(open, close + 1);
}

/** Problems with ChangesPanel's bulk wiring; empty when it is pinned. */
function panelProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  // (p1) one derivation from the selected row keys.
  if (!/\bbulkRowTargets\(selectedKeys, entries\)/.test(masked))
    problems.push(
      "the panel does not derive bulkRowTargets(selectedKeys, entries)",
    );
  for (const gone of [
    "selectedEntries",
    "selectedPaths",
    "discardableSelected",
    "selectedTracked",
    "collapseDiscardEntries",
  ])
    if (new RegExp(`\\b${gone}\\b`).test(masked))
      problems.push(`the path-based ${gone} is back`);
  // (p2) discard scopes the selected unstaged rows only, conflicted ones left
  // out: git refuses the whole restore after the untracked ones are recycled.
  if (
    !/\bconst selectedDiscard = excludeConflicted\(bulk\.unstagedRows\);/.test(
      masked,
    )
  )
    problems.push("selectedDiscard is not the non-conflicted unstaged rows");
  const body = functionBody(masked, "requestDiscardSelected");
  if (body === null) problems.push("requestDiscardSelected not found");
  else {
    if (!/\bentries:\s*selectedDiscard\.targets\b/.test(body))
      problems.push("requestDiscardSelected does not scope the unstaged rows");
    if (/\bpathEntries\b|\bstagedRows\b/.test(body))
      problems.push("requestDiscardSelected reads a path-level or staged list");
  }
  const wired = [...masked.matchAll(/\bdiscardSelected:\s*([\w$]+)/g)];
  if (wired.length !== 1 || wired[0][1] !== "requestDiscardSelected")
    problems.push("the menu's discardSelected is not requestDiscardSelected");
  // (p3) the right-clicked row resolves by path AND side.
  if (/\bentries\.find\(/.test(masked))
    problems.push("the panel resolves a row with a bare entries.find");
  const menu = functionBody(masked, "handleContextMenu");
  if (menu === null) problems.push("handleContextMenu not found");
  else if (!/\browEntry\(entries, path, staged\)/.test(menu))
    problems.push("handleContextMenu does not resolve the row side-aware");
  // The menu's counts come from the row-true derivation.
  if (!/\browCount=\{bulk\.rowCount\}/.test(masked))
    problems.push("the menu's rowCount is not the resolved row count");
  if (!/\bunstagedRowCount=\{bulk\.unstagedRows\.length\}/.test(masked))
    problems.push("the menu's unstagedRowCount is not the unstaged rows");
  if (!/\bpathCount=\{bulk\.pathEntries\.length\}/.test(masked))
    problems.push("the menu's pathCount is not the distinct paths");
  if (!/\bdiscardableCount=\{selectedDiscard\.targets\.length\}/.test(masked))
    problems.push("the menu's discardableCount is not Discard's targets");
  // One spelling of the Stash disable: any conflicted entry in the repo.
  if (!/\bconst anyConflicted = conflictedPaths\.length > 0;/.test(masked))
    problems.push("anyConflicted is not derived from conflictedPaths");
  if (!/\banyConflicted=\{anyConflicted\}/.test(masked))
    problems.push("the menu's anyConflicted is not the panel's");
  return problems;
}

/** Problems with the folder Discard/Stash routes and their palette enables;
 *  empty when pinned. */
function folderRouteProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  // Discard's exclusion has exactly two sites; Stash takes none, since git
  // refuses any path stash while a conflict exists and the item disables.
  const excludes = [...masked.matchAll(/\bexcludeConflicted\(/g)].length;
  if (excludes !== 2)
    problems.push(`ChangesPanel calls excludeConflicted ${excludes} times`);
  for (const [fn, mustRe, banned] of [
    ["requestDiscardFolder", /\bexcludeConflicted\(rows\.unstagedRows\)/, null],
    [
      "requestStashFolder",
      /\bentries:\s*rows\.pathEntries,/,
      "excludeConflicted",
    ],
  ]) {
    const fnBody = functionBody(masked, fn);
    if (fnBody === null) {
      problems.push(`${fn} not found`);
      continue;
    }
    // The request-time repo check comes before any target is resolved.
    const refuse = fnBody.search(
      /\bif \(refuseIfSwitched\(repo, "[^"]*"\)\) return;/,
    );
    const targets = fnBody.indexOf("folderActionTargets(");
    if (refuse === -1 || targets === -1 || refuse > targets)
      problems.push(`${fn} doesn't refuse a switched repo first`);
    if (!mustRe.test(fnBody)) problems.push(`${fn} lacks ${mustRe.source}`);
    if (banned && fnBody.includes(banned))
      problems.push(`${fn} calls ${banned}`);
  }
  const noConfirm =
    /\bconst noConfirm =\s*discardScope === null &&\s*stashScope === null &&\s*!discardPaths\.isPending &&\s*!stashPaths\.isPending\b/;
  if (!noConfirm.test(masked))
    problems.push("noConfirm doesn't cover both dialogs and their writes");
  const enables = {
    "discard-folder":
      /,\s*!mutating &&\s*noConfirm &&\s*folderCursor\?\.section === "\s*" &&\s*folderCursorTargets\.discardable > 0,?\s*\)$/,
    "stash-folder":
      /,\s*!mutating &&\s*noConfirm &&\s*!anyConflicted &&\s*folderCursor !== null &&\s*folderCursorTargets\.stashable > 0,?\s*\)$/,
  };
  for (const [id, re] of Object.entries(enables)) {
    const args = hotkeyArgs(text, masked, id);
    if (args === null) problems.push(`the ${id} hotkey is not found`);
    else if (!re.test(args)) problems.push(`the ${id} enable drifted`);
  }
  // Discard's palette count leaves conflicted files out; Stash's keeps them.
  if (
    !/\bdiscardable: staged\s*\?\s*0\s*:\s*shown\.filter\(\(e\) => !isConflictedEntry\(e\)\)\.length,/.test(
      masked,
    )
  )
    problems.push("the cursor's discardable count keeps conflicted files");
  if (
    !/\bstashable: shown\.filter\(\(e\) => !staysOutOfStash\(e\)\)\.length,/.test(
      masked,
    )
  )
    problems.push("the cursor's stashable count keeps reserved names");
  // The mask blanks "unstaged": a staged cursor must never enable Discard.
  if (
    !text.includes(
      '      noConfirm &&\n      folderCursor?.section === "unstaged" &&\n      folderCursorTargets.discardable > 0,',
    )
  )
    problems.push("the discard-folder enable isn't unstaged-only");
  // The menu's Discard label subtracts this, so it must count exactly the
  // shown conflicted files requestDiscardFolder leaves out.
  const countsAt = masked.search(/\bconst folderCounts = useMemo\(/);
  const countsEnd = masked.indexOf("}, [menuTarget,", countsAt);
  if (
    countsAt === -1 ||
    countsEnd === -1 ||
    !/\bconflictedCount: shown\.filter\(isConflictedEntry\)\.length,/.test(
      masked.slice(countsAt, countsEnd),
    )
  )
    problems.push("folderCounts.conflictedCount isn't the shown conflicted");
  return problems;
}

/** Problems with the menu's shared-predicate and record-kind greps; empty
 *  when pinned. Its rendered labels and gates are pinned by
 *  src/test/changes-context-menu.test.tsx. */
function menuClassGrepProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  // The single-row Untrack shares the bulk rule instead of re-spelling it.
  if (!/\bconst untrackable = canUntrack\(entry\);/.test(masked))
    problems.push("the single-row menu does not gate Untrack on canUntrack");
  if (/\.(staged|unstaged) !==/.test(masked))
    problems.push("the menu re-spells a record-kind rule inline");
  // One conflict predicate, shared with the panel.
  if (/\bisConflicted\b/.test(masked) || text.includes('"conflicted"'))
    problems.push("the menu re-spells the conflict predicate");
  return problems;
}

const ROW_LISTS =
  /\bbulk\.(stagedRows|unstagedRows|pathEntries|trackedPathEntries)\b/g;

/** Problems with one bulk handler: `must` patterns all present in its masked
 *  body, and no `bulk.<list>` read other than `lists`. */
function handlerProblems(masked, name, must, lists) {
  const body = functionBody(masked, name);
  if (body === null) return [`${name} not found`];
  const problems = [];
  for (const re of must)
    if (!re.test(body)) problems.push(`${name} lacks ${re.source}`);
  for (const [, list] of body.matchAll(ROW_LISTS))
    if (!lists.includes(list)) problems.push(`${name} reads bulk.${list}`);
  return problems;
}

/** The masked argument list of `useHotkeyAction("<id>", …)`, or null. */
function hotkeyArgs(text, masked, id) {
  // The id is a string literal, which the mask blanks: locate it raw, then
  // confirm the call itself is code.
  const at = text.search(new RegExp(`useHotkeyAction\\(\\s*"${id}",`));
  if (at === -1 || !masked.startsWith("useHotkeyAction(", at)) return null;
  const open = at + "useHotkeyAction".length;
  const close = matchBrace(masked, open);
  return close === -1 ? null : masked.slice(open, close + 1);
}

/** Problems with the bulk handlers' target lists and the hotkey enables. */
function targetProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  if (
    !/\bconst stageableSelected = bulk\.unstagedRows\.filter\(canStage\);/.test(
      masked,
    )
  )
    problems.push("stageableSelected is not the stageable unstaged rows");
  problems.push(
    ...handlerProblems(
      masked,
      "stageSelected",
      [
        /\bif \(stageableSelected\.length === 0\) return;/,
        /\bstageGuarded\(stageableSelected\)/,
      ],
      [],
    ),
    ...handlerProblems(
      masked,
      "unstageSelected",
      [
        /\bif \(bulk\.stagedRows\.length === 0\) return;/,
        /\bunstage\.mutateAsync\(bulk\.stagedRows\.flatMap\(unstagePaths\)\)/,
      ],
      ["stagedRows"],
    ),
    ...handlerProblems(
      masked,
      "requestStashSelected",
      [
        /\bentries:\s*bulk\.pathEntries,/,
        /\bsplit:\s*bulk\.splitPaths\.length > 0\b/,
      ],
      ["pathEntries"],
    ),
    ...handlerProblems(
      masked,
      "ignoreSelected",
      [/\bconst patterns = bulk\.pathEntries\.map\(/],
      ["pathEntries"],
    ),
    ...handlerProblems(
      masked,
      "aiExcludeSelected",
      [/\bbulk\.pathEntries\.flatMap\(/],
      ["pathEntries"],
    ),
    ...handlerProblems(
      masked,
      "untrackSelected",
      [
        /\bconst tracked = bulk\.trackedPathEntries;/,
        /\bpathspecs: tracked\.map\(/,
        /\bignorePatterns: tracked\.map\(/,
      ],
      ["trackedPathEntries"],
    ),
  );
  const enables = {
    "stage-selected-files":
      /^\(\s*[\s\S]*,\s*!mutating && stageableSelected\.length > 0,?\s*\)$/,
    "unstage-selected-files":
      /^\(\s*[\s\S]*,\s*!mutating && bulk\.stagedRows\.length > 0,?\s*\)$/,
  };
  for (const [id, re] of Object.entries(enables)) {
    const args = hotkeyArgs(text, masked, id);
    if (args === null) problems.push(`the ${id} hotkey is not found`);
    else if (!re.test(args)) problems.push(`the ${id} enable is not row-based`);
  }
  return problems;
}

/** `text` with `from` swapped for `to` exactly once (a control that misses
 *  its target would pass vacuously). */
function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

test("the panel and menu are wired to row-based targets", () => {
  assert.deepEqual(panelProblems(source(PANEL)), []);
  assert.deepEqual(menuClassGrepProblems(source(MENU)), []);
});

test("the folder Discard/Stash routes and palette enables are pinned", () => {
  assert.deepEqual(folderRouteProblems(source(PANEL)), []);
});

test("folder route pin mutation controls go red", () => {
  const text = source(PANEL);
  const discardRefuse =
    '    if (refuseIfSwitched(repo, "nothing was discarded")) return;\n';
  const stashRefuse =
    '    if (refuseIfSwitched(repo, "nothing was stashed")) return;\n';
  const mutants = [
    mutate(text, discardRefuse, ""),
    mutate(text, stashRefuse, ""),
    // Refusing only after the targets resolved mixes two repos' state.
    mutate(
      mutate(text, discardRefuse, ""),
      "    const { targets, conflicted } = excludeConflicted(rows.unstagedRows);\n",
      `    const { targets, conflicted } = excludeConflicted(rows.unstagedRows);\n${discardRefuse}`,
    ),
    mutate(
      text,
      "const { targets, conflicted } = excludeConflicted(rows.unstagedRows);",
      "const { targets, conflicted } = { targets: rows.unstagedRows, conflicted: [] };",
    ),
    // Stash must not exclude: git refuses the whole stash anyway.
    mutate(
      text,
      "      entries: rows.pathEntries,",
      "      entries: excludeConflicted(rows.pathEntries).targets,",
    ),
    mutate(text, "    !discardPaths.isPending &&\n", ""),
    mutate(text, "    stashScope === null &&\n", ""),
    mutate(
      text,
      "      noConfirm &&\n      !anyConflicted &&\n",
      "      noConfirm &&\n",
    ),
    mutate(
      text,
      "      noConfirm &&\n      folderCursor?.section",
      "      folderCursor?.section",
    ),
    mutate(
      text,
      "folderCursorTargets.discardable > 0",
      "folderCursorTargets.stashable > 0",
    ),
    mutate(
      text,
      ": shown.filter((e) => !isConflictedEntry(e)).length,",
      ": shown.length,",
    ),
    mutate(
      text,
      '      noConfirm &&\n      folderCursor?.section === "unstaged" &&\n      folderCursorTargets.discardable',
      '      noConfirm &&\n      folderCursor?.section === "staged" &&\n      folderCursorTargets.discardable',
    ),
    mutate(
      text,
      "conflictedCount: shown.filter(isConflictedEntry).length,",
      "conflictedCount: 0,",
    ),
    mutate(
      text,
      "conflictedCount: shown.filter(isConflictedEntry).length,",
      "conflictedCount: entries.filter(isConflictedEntry).length,",
    ),
    mutate(
      text,
      "stashable: shown.filter((e) => !staysOutOfStash(e)).length,",
      "stashable: shown.length,",
    ),
  ];
  for (const mutant of mutants)
    assert.notDeepEqual(folderRouteProblems(mutant), []);
});

test("panel pin mutation controls go red", () => {
  const text = source(PANEL);
  const mutants = [
    mutate(
      text,
      "bulkRowTargets(selectedKeys, entries)",
      "bulkRowTargets(new Set(), entries)",
    ),
    // Swapped back to the raw rows, Discard sends conflicted paths again.
    mutate(
      text,
      "entries: selectedDiscard.targets,",
      "entries: bulk.unstagedRows,",
    ),
    mutate(
      text,
      "const selectedDiscard = excludeConflicted(bulk.unstagedRows);",
      "const selectedDiscard = { targets: bulk.unstagedRows, conflicted: [] };",
    ),
    mutate(
      text,
      "entries: selectedDiscard.targets,",
      "entries: bulk.pathEntries,",
    ),
    // A comment spelling the pinned scope must not satisfy the pin.
    mutate(
      text,
      "entries: selectedDiscard.targets,",
      "entries: bulk.stagedRows, // entries: selectedDiscard.targets",
    ),
    mutate(
      text,
      "discardableCount={selectedDiscard.targets.length}",
      "discardableCount={bulk.unstagedRows.length}",
    ),
    mutate(text, "anyConflicted={anyConflicted}", "anyConflicted={false}"),
    mutate(
      text,
      "const anyConflicted = conflictedPaths.length > 0;",
      "const anyConflicted = selectedDiscard.conflicted.length > 0;",
    ),
    mutate(
      text,
      "rowEntry(entries, path, staged)",
      "entries.find((en) => en.path === path)",
    ),
    mutate(
      text,
      "discardSelected: requestDiscardSelected,",
      "discardSelected: requestStashSelected,",
    ),
    mutate(text, "rowCount={bulk.rowCount}", "rowCount={selectedKeys.size}"),
    mutate(
      text,
      "unstagedRowCount={bulk.unstagedRows.length}",
      "unstagedRowCount={bulk.pathEntries.length}",
    ),
    mutate(
      text,
      "pathCount={bulk.pathEntries.length}",
      "pathCount={bulk.rowCount}",
    ),
    mutate(
      text,
      "const bulk = bulkRowTargets",
      "const selectedEntries = entries;\n  const bulk = bulkRowTargets",
    ),
  ];
  for (const mutant of mutants) assert.notDeepEqual(panelProblems(mutant), []);
});

test("menu grep mutation controls go red", () => {
  const mutant = mutate(
    source(MENU),
    "{isConflictedEntry(entry) && aiEnabled",
    '{entry.unstaged === "conflicted" && aiEnabled',
  );
  assert.notDeepEqual(menuClassGrepProblems(mutant), []);
  // Each ban alone: a record-kind compare, and the conflict identifier.
  assert.deepEqual(
    menuClassGrepProblems(
      mutate(
        source(MENU),
        'const hasHistory = untrackable || entry.staged === "deleted";',
        'const hasHistory = untrackable || !(entry.staged !== "deleted");',
      ),
    ),
    ["the menu re-spells a record-kind rule inline"],
  );
  assert.deepEqual(
    menuClassGrepProblems(
      mutate(
        source(MENU),
        "{isConflictedEntry(entry) && aiEnabled",
        "{isConflicted(entry) && aiEnabled",
      ),
    ),
    ["the menu re-spells the conflict predicate"],
  );
});

test("the bulk handlers and hotkeys target row-based lists", () => {
  assert.deepEqual(targetProblems(source(PANEL)), []);
});

test("target pin mutation controls go red", () => {
  const text = source(PANEL);
  const mutants = [
    mutate(
      text,
      "bulk.unstagedRows.filter(canStage)",
      "bulk.pathEntries.filter(canStage)",
    ),
    mutate(
      text,
      "stageGuarded(stageableSelected)",
      "stageGuarded(bulk.unstagedRows)",
    ),
    // The MM cross-side unstage: a path-level list unstages unselected sides.
    mutate(
      text,
      "bulk.stagedRows.flatMap(unstagePaths)",
      "bulk.pathEntries.flatMap(unstagePaths)",
    ),
    mutate(text, "entries: bulk.pathEntries,", "entries: bulk.stagedRows,"),
    mutate(text, "split: bulk.splitPaths.length > 0", "split: false"),
    mutate(
      text,
      "const patterns = bulk.pathEntries.map(",
      "const patterns = bulk.stagedRows.map(",
    ),
    mutate(
      text,
      "bulk.pathEntries.flatMap((e) => aiExcludePatternLinesForPath",
      "bulk.unstagedRows.flatMap((e) => aiExcludePatternLinesForPath",
    ),
    mutate(
      text,
      "const tracked = bulk.trackedPathEntries;",
      "const tracked = bulk.pathEntries;",
    ),
    mutate(
      text,
      "!mutating && stageableSelected.length > 0,",
      "!mutating && bulk.pathEntries.length > 0,",
    ),
    mutate(
      text,
      "!mutating && bulk.stagedRows.length > 0,",
      "!mutating && bulk.pathEntries.length > 0,",
    ),
    // A comment spelling the pinned enable must not satisfy the pin.
    mutate(
      text,
      "!mutating && bulk.stagedRows.length > 0,",
      "!mutating && selectedKeys.size > 0, // !mutating && bulk.stagedRows.length > 0,",
    ),
  ];
  for (const mutant of mutants) assert.notDeepEqual(targetProblems(mutant), []);
});

test("the single-row Untrack rule mutation control goes red", () => {
  const mutant = mutate(
    source(MENU),
    "const untrackable = canUntrack(entry);",
    'const untrackable = entry.unstaged !== "untracked" && entry.staged !== "added";',
  );
  assert.notDeepEqual(menuClassGrepProblems(mutant), []);
});

const CLEAR_OFFER =
  "useStashReapplyMarker.getState().clearFor(stashScope.repo);";

/** Problems with the stash confirm's reapply-offer clear and both confirms'
 *  selection rule; empty when pinned. */
function confirmProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  // A refused or empty stash creates nothing, so the recorded backup's offer
  // must survive it: the clear rides only the paths that made a stash.
  const body = functionBody(masked, "confirmStash");
  if (body === null) return ["confirmStash not found"];
  const all = body.indexOf("await stashAll.mutateAsync(undefined);");
  const paths = body.indexOf("await stashPaths.mutateAsync(");
  const matched = body.search(/\bif \(matched\) \{/);
  if (all === -1 || paths === -1 || matched === -1)
    return ["confirmStash's mutations or its matched branch are not found"];
  const allCatch = body.indexOf("catch", all);
  const matchedOpen = body.indexOf("{", matched);
  const matchedClose = matchBrace(body, matchedOpen);
  const clears = [...body.matchAll(/\bclearFor\(/g)].map((m) => m.index);
  if (clears.length !== 2)
    problems.push(`confirmStash clears the offer ${clears.length} times`);
  if (!clears.some((at) => at > all && at < allCatch))
    problems.push("the stash-all arm doesn't clear after its stash resolves");
  if (!clears.some((at) => at > matchedOpen && at < matchedClose))
    problems.push("the paths arm doesn't clear inside its matched branch");
  if (clears.some((at) => at < all))
    problems.push("confirmStash clears the offer before any stash exists");
  // A folder action leaves an unrelated selection alone; the others clear it.
  // Cancel stays live while a write is pending, so a newer dialog and a newer
  // selection may exist when this one settles: finish closes only the scope it
  // confirmed and clears through clearSelectionIfUnchanged with the selection
  // generation and repo captured at the confirm. The mask blanks "files", so
  // the kind check reads the unmasked body.
  for (const [fn, scope, setter] of [
    ["confirmDiscard", "discardScope", "setDiscardScope"],
    ["confirmStash", "stashScope", "setStashScope"],
  ]) {
    const finish = new RegExp(
      String.raw`const confirming = ${scope};\s*` +
        String.raw`const gen = selectionGen\.current;\s*` +
        String.raw`const finish = \(\) => \{\s*` +
        String.raw`${setter}\(\(cur\) => \(cur === confirming \? null : cur\)\);\s*` +
        String.raw`if \(confirming\.kind !== "files" \|\| confirming\.folder === undefined\)\s*` +
        String.raw`clearSelectionIfUnchanged\(gen, confirming\.repo\);\s*\};`,
    );
    const at = masked.search(new RegExp(String.raw`\basync function ${fn}\(`));
    const fnBody = functionBody(masked, fn);
    const open = masked.indexOf("{", at);
    const raw =
      at === -1 || fnBody === null
        ? null
        : text.slice(open, open + fnBody.length);
    if (raw === null || !finish.test(raw.replace(/\/\/[^\n]*\n/g, "\n")))
      problems.push(`${fn}'s finish clears a folder action's selection`);
  }
  return problems;
}

test("the stash confirm clears the reapply offer only once a stash exists", () => {
  assert.deepEqual(confirmProblems(source(PANEL)), []);
});

test("confirm pin mutation controls go red", () => {
  const text = source(PANEL);
  const inMatched = `      if (matched) {\n        ${CLEAR_OFFER}\n`;
  const allArm =
    "        await stashAll.mutateAsync(undefined);\n" +
    "        // A new stash buries the recorded backup, so a refused stash leaves its\n" +
    '        // offer; git\'s "No local changes to save" also resolves and clears it.\n' +
    `        ${CLEAR_OFFER}\n`;
  const pathsTargets =
    "    const targets = stashScope.entries.map((e) => e.path);";
  const stashFinish =
    "    const confirming = stashScope;\n    const gen = selectionGen.current;\n    const finish = () => {";
  const clearIfUnchanged =
    "        clearSelectionIfUnchanged(gen, confirming.repo);";
  const subsetClear = [
    "        setSelectedKeys((cur) =>",
    "          cur.size > 0 && [...cur].every((k) => selection.has(k))",
    "            ? new Set()",
    "            : cur,",
    "        );",
  ].join("\n");
  const discardFinishHead =
    '      setDiscardScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n';
  const withoutMatchedClear = mutate(text, inMatched, "      if (matched) {\n");
  const withoutAllClear = mutate(
    text,
    allArm,
    "        await stashAll.mutateAsync(undefined);\n",
  );
  const mutants = [
    // Back above the paths mutation: a refused stash would wipe the offer.
    mutate(
      withoutMatchedClear,
      pathsTargets,
      `    ${CLEAR_OFFER}\n${pathsTargets}`,
    ),
    // After the matched branch: an empty stash would wipe the offer.
    mutate(
      withoutMatchedClear,
      '        toast.info("Nothing to stash");\n      }\n',
      `        toast.info("Nothing to stash");\n      }\n      ${CLEAR_OFFER}\n`,
    ),
    // Back above both mutations, where it sat before any stash existed.
    mutate(withoutAllClear, stashFinish, `    ${CLEAR_OFFER}\n${stashFinish}`),
    withoutAllClear,
    mutate(
      text,
      `      setDiscardScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n${clearIfUnchanged}`,
      "      setDiscardScope((cur) => (cur === confirming ? null : cur));\n      setSelectedKeys(new Set());",
    ),
    // An older write's settle wipes a newer selection made after Cancel.
    mutate(
      text,
      `      setDiscardScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n${clearIfUnchanged}`,
      `      setDiscardScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n        setSelectedKeys(new Set());`,
    ),
    mutate(
      text,
      `      setStashScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n${clearIfUnchanged}`,
      `      setStashScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)\n        setSelectedKeys(new Set());`,
    ),
    // The identity form: a status poll's prune mid-write leaves the pruned
    // remainder of the confirmed selection selected.
    mutate(
      text,
      `${discardFinishHead}${clearIfUnchanged}`,
      `${discardFinishHead}        setSelectedKeys((cur) => (cur === selection ? new Set() : cur));`,
    ),
    // The subset form: a deliberate re-click of a confirmed row, or a same-path
    // key in another repo, reads as the confirmed selection and is wiped.
    mutate(
      text,
      `${discardFinishHead}${clearIfUnchanged}`,
      `${discardFinishHead}${subsetClear}`,
    ),
    // No snapshot: the clear has no generation captured at the confirm.
    mutate(
      text,
      stashFinish,
      "    const confirming = stashScope;\n    const finish = () => {",
    ),
    mutate(
      text,
      '      setStashScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files" || confirming.folder === undefined)',
      '      setStashScope((cur) => (cur === confirming ? null : cur));\n      if (confirming.kind !== "files")',
    ),
    // A masked-string blind spot: the kind check must still name "files".
    mutate(
      text,
      '      setStashScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "files"',
      '      setStashScope((cur) => (cur === confirming ? null : cur));\n      // A folder action leaves an unrelated selection alone, like folder Stage.\n      if (confirming.kind !== "all"',
    ),
    // A pending confirm's settle closes a newer dialog opened after Cancel.
    mutate(
      text,
      "setDiscardScope((cur) => (cur === confirming ? null : cur));",
      "setDiscardScope(null);",
    ),
    mutate(
      text,
      "setStashScope((cur) => (cur === confirming ? null : cur));",
      "setStashScope(null);",
    ),
    // Reading the live scope instead of the captured one.
    mutate(
      text,
      `      if (confirming.kind !== "files" || confirming.folder === undefined)\n${clearIfUnchanged}\n    };\n    if (discardScope.kind`,
      `      if (discardScope.kind !== "files" || discardScope.folder === undefined)\n${clearIfUnchanged}\n    };\n    if (discardScope.kind`,
    ),
  ];
  for (const mutant of mutants)
    assert.notDeepEqual(confirmProblems(mutant), []);
});

/** Handlers that clear the selection after an await: each captures the
 *  selection generation and repo before it and clears through the helper. */
const POST_AWAIT_CLEARS = [
  "stageSelected",
  "unstageSelected",
  "ignoreSelected",
  "aiExcludeSelected",
  "untrackSelected",
  "confirmDiscard",
  "confirmStash",
];
const GEN_BUMP = "selectionGen.current += 1;";

/** Problems with ChangesPanel's selection generation: the helper checks both
 *  the generation and the live repo, it is the only clear, every post-await
 *  clearer captures first, and every writer that installs a new selection
 *  bumps while a prune (shrinking what the user chose) never does. */
function selectionGenProblems(text) {
  const problems = [];
  const masked = maskNonCode(text, true);
  const helper =
    /\bfunction clearSelectionIfUnchanged\(gen: number, repo: string\) \{/.exec(
      masked,
    );
  if (!helper) return ["clearSelectionIfUnchanged is not declared"];
  const hOpen = helper.index + helper[0].length - 1;
  const hClose = matchBrace(masked, hOpen);
  const hBody = text.slice(hOpen, hClose);
  const guard = hBody.search(/\bif \(/);
  const clear = hBody.indexOf("setSelectedKeys(new Set());");
  if (!/selectionGen\.current !== gen\b/.test(hBody.slice(0, clear)))
    problems.push("clearSelectionIfUnchanged must check the generation");
  if (!/!landedIn\(repo\)\.live\b/.test(hBody.slice(0, clear)))
    problems.push("clearSelectionIfUnchanged must check the live repo");
  if (
    guard === -1 ||
    clear < guard ||
    !/\)\s*return;/.test(hBody.slice(guard, clear))
  )
    problems.push("clearSelectionIfUnchanged must return before its clear");
  for (const m of masked.matchAll(/\bsetSelectedKeys\(new Set\(\)\)/g)) {
    if (m.index > hOpen && m.index < hClose) continue;
    problems.push("a direct selection clear outside clearSelectionIfUnchanged");
  }
  for (const fn of POST_AWAIT_CLEARS) {
    const body = functionBody(masked, fn);
    if (body === null) {
      problems.push(`${fn} is not found`);
      continue;
    }
    const capture = body.indexOf("const gen = selectionGen.current;");
    const firstAwait = body.search(/(?<![\w$])await(?![\w$])/);
    if (
      capture === -1 ||
      firstAwait === -1 ||
      capture > firstAwait ||
      !/\bclearSelectionIfUnchanged\(gen, /.test(body)
    )
      problems.push(
        `${fn} must capture the generation before its await and clear through the helper`,
      );
  }
  for (const m of masked.matchAll(/\bsetSelectedKeys\(/g)) {
    if (m.index > hOpen && m.index < hClose) continue;
    const open = m.index + m[0].length - 1;
    const arg = masked.slice(open, matchBrace(masked, open));
    const prune =
      /\b(pruneHiddenKeys|pruneCollapsedSectionKeys)\(|\blive\.has\(/.test(arg);
    const bumped = masked.slice(0, m.index).trimEnd().endsWith(GEN_BUMP);
    const line = text.slice(0, m.index).split("\n").length;
    if (prune && bumped)
      problems.push(
        `a prune must not bump the selection generation (line ${line})`,
      );
    if (!prune && !bumped)
      problems.push(
        `a new-selection writer must bump the selection generation (line ${line})`,
      );
  }
  return problems;
}

test("selection clears after an await go through the generation helper", () => {
  assert.deepEqual(selectionGenProblems(source(PANEL)), []);
});

test("selection generation pin mutation controls go red", () => {
  const text = source(PANEL);
  const cases = [
    [
      mutate(
        text,
        "      await unstage.mutateAsync(bulk.stagedRows.flatMap(unstagePaths));\n      clearSelectionIfUnchanged(gen, repo);",
        "      await unstage.mutateAsync(bulk.stagedRows.flatMap(unstagePaths));\n      setSelectedKeys(new Set());",
      ),
      /a direct selection clear outside clearSelectionIfUnchanged/,
    ],
    [
      mutate(
        text,
        "    if (mods.ctrlOrMeta) {\n      selectionGen.current += 1;\n",
        "    if (mods.ctrlOrMeta) {\n",
      ),
      /a new-selection writer must bump the selection generation/,
    ],
    [
      mutate(
        text,
        "    setSelectedKeys((prev) => {\n      const next = new Set([...prev].filter((k) => live.has(k)));",
        "    selectionGen.current += 1;\n    setSelectedKeys((prev) => {\n      const next = new Set([...prev].filter((k) => live.has(k)));",
      ),
      /a prune must not bump the selection generation/,
    ],
    [
      mutate(
        text,
        "if (selectionGen.current !== gen || !landedIn(repo).live) return;",
        "if (selectionGen.current !== gen) return;",
      ),
      /must check the live repo/,
    ],
    [
      mutate(
        text,
        "if (selectionGen.current !== gen || !landedIn(repo).live) return;",
        "if (!landedIn(repo).live) return;",
      ),
      /must check the generation/,
    ],
    [
      mutate(
        text,
        "    ];\n    const gen = selectionGen.current;\n",
        "    ];\n",
      ),
      /aiExcludeSelected must capture the generation before its await/,
    ],
  ];
  for (const [mutant, message] of cases) {
    const problems = selectionGenProblems(mutant);
    assert.ok(
      problems.some((p) => message.test(p)),
      `expected ${message}, got ${JSON.stringify(problems)}`,
    );
  }
});

// Untracked Windows-reserved names stay out of a path stash (the backend drops
// them), so every panel-side Stash count leaves them out: the menu's counts
// and the success toast. The menu's labels are pinned by
// src/test/changes-context-menu.test.tsx, the confirm's copy and the rule itself
// by scripts/changes-confirm-copy.test.mjs.
const STASH_PANEL_PINS = [
  [
    "const stashablePathCount = bulk.pathEntries.filter(\n    (e) => !staysOutOfStash(e),\n  ).length;",
    "stashablePathCount doesn't leave reserved names out",
  ],
  [
    "stashablePathCount={stashablePathCount}",
    "the menu's stashablePathCount is not the panel's",
  ],
  [
    "stashableCount: shown.filter((e) => !staysOutOfStash(e)).length,",
    "folderCounts.stashableCount doesn't leave reserved names out",
  ],
  [
    "const stashed = stashScope.entries.filter((e) => !staysOutOfStash(e));\n        toast.success(\n          stashed.length === 1\n            ? `Stashed ${stashed[0].path}`\n            : `Stashed ${stashed.length} files`,\n        );",
    "the stash toast doesn't count what was stashed",
  ],
];

/** Problems with the Stash counts; empty when pinned. */
function stashCountProblems(panel) {
  const problems = [];
  for (const [pin, why] of STASH_PANEL_PINS)
    if (!panel.includes(pin)) problems.push(why);
  return problems;
}

test("every panel-side Stash count leaves untracked reserved names out", () => {
  assert.deepEqual(stashCountProblems(source(PANEL)), []);
});

test("stash count pin mutation controls go red", () => {
  const panel = source(PANEL);
  const panelMutants = [
    mutate(
      panel,
      "const stashablePathCount = bulk.pathEntries.filter(\n    (e) => !staysOutOfStash(e),\n  ).length;",
      "const stashablePathCount = bulk.pathEntries.length;",
    ),
    mutate(
      panel,
      "const stashed = stashScope.entries.filter((e) => !staysOutOfStash(e));",
      "const stashed = stashScope.entries;",
    ),
    mutate(
      panel,
      "stashableCount: shown.filter((e) => !staysOutOfStash(e)).length,",
      "stashableCount: shown.length,",
    ),
    mutate(
      panel,
      "stashablePathCount={stashablePathCount}",
      "stashablePathCount={bulk.pathEntries.length}",
    ),
  ];
  for (const mutant of panelMutants)
    assert.notDeepEqual(stashCountProblems(mutant), []);
});
