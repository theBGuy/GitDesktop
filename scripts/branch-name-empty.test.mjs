// Pins the branch-name generator's empty-state toast: each side (working tree,
// committed work) is described by what hid it, a side holding only files whose
// names aren't readable text is never described as having no changes, and the
// unreadable-names note appears exactly when a side labelled by its patterns
// also holds unreadable names its own sentence doesn't state.
//
// The module is dependency-free, so Node's type stripping loads it directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchNameEmptyMessage,
  UNREADABLE_NOTE,
} from "../src/features/repository/branch-name-empty.ts";

const BASE = "main";
const side = (patternHidden, unreadable = 0) => ({ patternHidden, unreadable });
const STATES = {
  patterns: side(true),
  unreadable: side(false, 2),
  none: side(false),
};
const both = (tree, committed) =>
  branchNameEmptyMessage({
    tree,
    committed,
    fallbackBase: BASE,
    useWorkingTree: true,
  });
const hasNote = (message) => message.endsWith(UNREADABLE_NOTE);

test("a patterns side's own unreadable names are noted beside an unreadable side", () => {
  // Tree: 3 hidden, 1 of them unreadable; committed work: unreadable names only.
  const message = both(side(true, 1), side(false, 2));
  assert.ok(message.includes(`only net changes vs ${BASE} are files`), message);
  assert.ok(hasNote(message), message);
  // The mirror shape: committed patterns carry unreadable names too.
  assert.ok(hasNote(both(side(false, 2), side(true, 1))));
});

test("the note stays off when no patterns side holds unreadable names", () => {
  for (const [label, tree, committed] of [
    ["patterns, none unreadable × unreadable", side(true), side(false, 2)],
    ["unreadable × patterns, none unreadable", side(false, 2), side(true)],
    ["unreadable × unreadable", side(false, 1), side(false, 2)],
    ["patterns × patterns, none unreadable", side(true), side(true)],
    ["none × none", side(false), side(false)],
  ]) {
    assert.ok(!hasNote(both(tree, committed)), label);
  }
});

test("the note follows a patterns side on every surface shape", () => {
  assert.ok(hasNote(both(side(false), side(true, 1))), "both sides");
  assert.ok(hasNote(both(side(true, 1), side(true))), "both patterned");
  const noFallback = (tree) =>
    branchNameEmptyMessage({
      tree,
      committed: side(false),
      fallbackBase: null,
      useWorkingTree: true,
    });
  assert.ok(hasNote(noFallback(side(true, 1))), "no fallback, patterns");
  assert.ok(!hasNote(noFallback(side(false, 1))), "no fallback, unreadable");
  const committedOnly = (committed) =>
    branchNameEmptyMessage({
      tree: side(false),
      committed,
      fallbackBase: BASE,
      useWorkingTree: false,
    });
  assert.ok(hasNote(committedOnly(side(true, 1))), "committed only, patterns");
  assert.ok(
    !hasNote(committedOnly(side(false, 1))),
    "committed only, unreadable",
  );
});

test("no cell denies changes a side holds", () => {
  for (const [treeName, tree] of Object.entries(STATES)) {
    for (const [committedName, committed] of Object.entries(STATES)) {
      const label = `${treeName}-${committedName}`;
      const message = both(tree, committed);
      if (treeName !== "none") {
        assert.ok(!message.includes("No in-progress changes"), label);
      }
      if (committedName !== "none") {
        assert.ok(!message.includes("no net changes"), label);
      }
      if (committedName === "unreadable" || treeName === "unreadable") {
        assert.ok(message.includes("aren't readable text"), label);
      }
      if (treeName === "patterns" || committedName === "patterns") {
        assert.ok(message.includes("AI ignore patterns"), label);
      }
    }
  }
});
