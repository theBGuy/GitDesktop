// Pins the reference card's stand-in state choice
// (src/components/markdown/ref-card-state.ts): only a pull request whose state
// came from the issue read's stand-in AND reads OPEN renders the neutral
// "open or draft" form; CLOSED and MERGED stand-ins keep their definite pills,
// and only a flagged OPEN pull request neutralizes. Stdlib only, importing the
// import-free module straight from src under Node's type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPEN_OR_DRAFT_VISIBLE,
  openOrDraftWord,
  refCardStateChoice,
} from "../src/components/markdown/ref-card-state.ts";

test("an OPEN pull-request stand-in renders the neutral form", () => {
  assert.equal(
    refCardStateChoice({ flavor: "pr", state: "OPEN", stateUncertain: true }),
    "openOrDraft",
  );
  assert.equal(OPEN_OR_DRAFT_VISIBLE, "Open or draft");
  assert.equal(openOrDraftWord("pull request"), "Pull request, open or draft");
  assert.equal(
    openOrDraftWord("merge request"),
    "Merge request, open or draft",
  );
});

test("CLOSED and MERGED stand-ins keep their definite pills", () => {
  for (const state of ["CLOSED", "MERGED"]) {
    assert.equal(
      refCardStateChoice({ flavor: "pr", state, stateUncertain: true }),
      "definite",
      state,
    );
  }
});

test("only a flagged OPEN pull request neutralizes", () => {
  assert.equal(refCardStateChoice({ flavor: "pr", state: "OPEN" }), "definite");
  assert.equal(
    refCardStateChoice({ flavor: "pr", state: "OPEN", stateUncertain: false }),
    "definite",
  );
  assert.equal(
    refCardStateChoice({
      flavor: "issue",
      state: "OPEN",
      stateUncertain: true,
    }),
    "definite",
  );
  // A state the build doesn't know falls to prPill's own unknown arm.
  assert.equal(
    refCardStateChoice({ flavor: "pr", state: "LOCKED", stateUncertain: true }),
    "definite",
  );
});
