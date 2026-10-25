// Pins History's "Cherry-pick to branch" hold
// (src/features/history/pick-onto-hold.ts): an operation in progress outranks
// everything, a branch list with nothing loaded says it is loading or couldn't
// be read, and only a list that answered may say there are no other branches.
// The menu copy for each hold lives in HistoryPanel.tsx and isn't read here.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickOntoHold } from "../src/features/history/pick-onto-hold.ts";

const LOADED = {
  opInProgress: false,
  hasData: true,
  isPending: false,
  isError: false,
  targetCount: 2,
  candidateCount: 2,
};
const hold = (over) => pickOntoHold({ ...LOADED, ...over });
const NO_DATA = { hasData: false, targetCount: 0, candidateCount: 0 };

test("pickOntoHold: offerable destinations enable the rows", () => {
  assert.equal(hold({}), null);
});

test("pickOntoHold: an operation in progress outranks every arm", () => {
  for (const [label, over] of [
    ["loaded", {}],
    ["pending, no data", { ...NO_DATA, isPending: true }],
    ["errored, no data", { ...NO_DATA, isError: true }],
    ["all archived", { targetCount: 0 }],
    ["one-branch repo", { targetCount: 0, candidateCount: 0 }],
  ]) {
    assert.equal(hold({ ...over, opInProgress: true }), "op", label);
  }
});

test("pickOntoHold: a list with nothing loaded never claims no branches", () => {
  assert.equal(hold({ ...NO_DATA, isPending: true }), "loading");
  assert.equal(hold({ ...NO_DATA, isError: true }), "unreadable");
});

test("pickOntoHold: the data arms, from a list that answered", () => {
  assert.equal(
    hold({ targetCount: 0, candidateCount: 3 }),
    "all-archived",
    "every other branch archived",
  );
  assert.equal(
    hold({ targetCount: 0, candidateCount: 0 }),
    "no-branches",
    "a one-branch repo",
  );
});

test("pickOntoHold: loaded data under a failed refetch keeps the data arms", () => {
  assert.equal(hold({ isError: true }), null, "destinations still offered");
  assert.equal(
    hold({ isError: true, targetCount: 0, candidateCount: 1 }),
    "all-archived",
  );
  assert.equal(
    hold({ isError: true, targetCount: 0, candidateCount: 0 }),
    "no-branches",
  );
  assert.equal(
    hold({ isPending: true }),
    null,
    "a loaded list refetching is not loading",
  );
});
