// Pins how the create-PR dialog derives its label selection from the AI's
// proposal, the user's picks, and the user's removals. The contract under test:
// a proposal only counts under the target it was validated against, a newer
// proposal replaces an older one wholesale, and a removal outlasts every later
// proposal until the dialog reseeds.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which erases `import type` but resolves no bundler
// aliases, so `pr-label-selection.ts` must keep its imports type-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyAiProposal,
  deriveSelectedLabels,
  sameLabelTarget,
  toggleLabelSets,
} from "../src/features/pulls/pr-label-selection.ts";

const FORK = { repoPath: "C:/repos/app", lens: "origin" };
const PARENT = { repoPath: "C:/repos/app", lens: "upstream" };
const OTHER_REPO = { repoPath: "C:/repos/lib", lens: "origin" };
const OTHER_REPO_PARENT = { repoPath: "C:/repos/lib", lens: "upstream" };

const NONE = new Set();
const derive = (ai, current, added = NONE, removed = NONE) => [
  ...deriveSelectedLabels({ ai, added, removed, current }),
];

test("targets match only on the same repo AND the same lens", () => {
  assert.equal(sameLabelTarget(FORK, { ...FORK }), true);
  // repoPath differs only
  assert.equal(sameLabelTarget(FORK, OTHER_REPO), false);
  // lens differs only
  assert.equal(sameLabelTarget(FORK, PARENT), false);
  // both differ
  assert.equal(sameLabelTarget(FORK, OTHER_REPO_PARENT), false);
});

test("proposals of 0, 1 and 3 names derive as given under their own target", () => {
  for (const names of [[], ["bug"], ["bug", "ui", "docs"]]) {
    assert.deepEqual(derive(applyAiProposal(names, FORK), FORK), names);
  }
  assert.deepEqual(derive(null, FORK), []);
});

test("a proposal made for another target is excluded (negative control)", () => {
  const ai = applyAiProposal(["bug", "ui", "docs"], FORK);
  for (const current of [PARENT, OTHER_REPO, OTHER_REPO_PARENT])
    assert.deepEqual(derive(ai, current), [], JSON.stringify(current));
  // Flipping back to the proposal's own target restores it.
  assert.deepEqual(derive(ai, FORK), ["bug", "ui", "docs"]);
});

test("a later proposal replaces the earlier one (negative control)", () => {
  let ai = applyAiProposal(["bug", "docs"], FORK);
  ai = applyAiProposal(["ui-polish"], FORK);
  assert.deepEqual(derive(ai, FORK), ["ui-polish"]);
  // An empty proposal clears what the model had proposed.
  ai = applyAiProposal([], FORK);
  assert.deepEqual(derive(ai, FORK), []);
});

test("a half-typed name that matched a real label is superseded by the fuller parse", () => {
  // "ui" IS a real label of its own, so the parser accepted it mid-stream while
  // "ui-polish" was still arriving.
  let ai = applyAiProposal(["ui"], FORK);
  assert.deepEqual(derive(ai, FORK), ["ui"]);
  ai = applyAiProposal(["ui-polish"], FORK);
  assert.deepEqual(derive(ai, FORK), ["ui-polish"]);
});

test("a removed AI name stays removed across later proposals and runs", () => {
  const removed = new Set(["bug"]);
  let ai = applyAiProposal(["bug", "docs"], FORK);
  assert.deepEqual(derive(ai, FORK, NONE, removed), ["docs"]);
  // A later chunk of the same run proposes it again.
  ai = applyAiProposal(["bug", "docs", "ui"], FORK);
  assert.deepEqual(derive(ai, FORK, NONE, removed), ["docs", "ui"]);
  // A second run (or the structured pick) proposes only it.
  ai = applyAiProposal(["bug"], FORK);
  assert.deepEqual(derive(ai, FORK, NONE, removed), []);
});

test("a removed manual pick stays out even when the model proposes it", () => {
  // toggleLabel(off) moves a name from `added` to `removed`.
  const added = new Set();
  const removed = new Set(["perf"]);
  const ai = applyAiProposal(["perf", "bug"], FORK);
  assert.deepEqual(derive(ai, FORK, added, removed), ["bug"]);
});

test("manual picks union with the proposal and survive target flips", () => {
  const added = new Set(["perf"]);
  const ai = applyAiProposal(["bug"], FORK);
  assert.deepEqual(derive(ai, FORK, added), ["bug", "perf"]);
  // Under the other target the proposal drops out and the manual pick stays;
  // the dialog's intersection with that target's labels decides what shows.
  assert.deepEqual(derive(ai, PARENT, added), ["perf"]);
  assert.deepEqual(derive(ai, FORK, added), ["bug", "perf"]);
  // A name both proposed and picked appears once.
  assert.deepEqual(derive(ai, FORK, new Set(["bug"])), ["bug"]);
});

test("the displayed and submitted set is the selection within the target's labels", () => {
  // Mirrors the dialog: `repoLabels.filter((l) => selected.has(l.name))`.
  const parentLabels = ["bug", "triage"];
  const added = new Set(["perf", "triage"]);
  const forkProposal = applyAiProposal(["bug", "docs"], FORK);
  const shown = (current, available) => {
    const selected = deriveSelectedLabels({
      ai: forkProposal,
      added,
      removed: NONE,
      current,
    });
    return available.filter((name) => selected.has(name));
  };
  // On the parent: the fork's proposal is gone even where a name exists there
  // too ("bug"), and the manual "perf" the parent lacks never reaches submit.
  assert.deepEqual(shown(PARENT, parentLabels), ["triage"]);
  assert.deepEqual(shown(FORK, ["bug", "docs", "perf", "triage", "ui"]), [
    "bug",
    "docs",
    "perf",
    "triage",
  ]);
});

test("applyAiProposal copies its input, so a later mutation can't leak in", () => {
  const names = ["bug"];
  const ai = applyAiProposal(names, FORK);
  names.push("docs");
  assert.deepEqual(derive(ai, FORK), ["bug"]);
});

// The dialog's checkbox: `toggleLabelSets` is the whole of its arithmetic.
const toggle = (edits, name, on) =>
  toggleLabelSets(edits.added, edits.removed, name, on);
const NO_EDITS = { added: new Set(), removed: new Set() };

test("unchecking a proposed name and checking it again brings it back to stay", () => {
  let ai = applyAiProposal(["bug", "docs"], FORK);
  let edits = toggle(NO_EDITS, "bug", false);
  assert.deepEqual(derive(ai, FORK, edits.added, edits.removed), ["docs"]);
  edits = toggle(edits, "bug", true);
  assert.deepEqual(derive(ai, FORK, edits.added, edits.removed), [
    "bug",
    "docs",
  ]);
  // The lifted tombstone stays lifted when a later proposal carries the name.
  ai = applyAiProposal(["bug"], FORK);
  assert.deepEqual(derive(ai, FORK, edits.added, edits.removed), ["bug"]);
  assert.deepEqual([...edits.removed], []);
});

test("checking a name and unchecking it again leaves it removed", () => {
  let edits = toggle(NO_EDITS, "perf", true);
  assert.deepEqual(derive(null, FORK, edits.added, edits.removed), ["perf"]);
  edits = toggle(edits, "perf", false);
  assert.deepEqual([...edits.added], []);
  assert.deepEqual([...edits.removed], ["perf"]);
  // Now a tombstone: a later proposal carrying it can't bring it back.
  const ai = applyAiProposal(["perf", "bug"], FORK);
  assert.deepEqual(derive(ai, FORK, edits.added, edits.removed), ["bug"]);
});

test("toggling returns fresh sets and leaves its inputs untouched", () => {
  const added = new Set(["a"]);
  const removed = new Set(["b"]);
  const next = toggleLabelSets(added, removed, "b", true);
  assert.notEqual(next.added, added);
  assert.notEqual(next.removed, removed);
  assert.deepEqual([...added], ["a"]);
  assert.deepEqual([...removed], ["b"]);
  assert.deepEqual([...next.added], ["a", "b"]);
  assert.deepEqual([...next.removed], []);
});
