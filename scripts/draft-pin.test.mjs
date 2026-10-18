// Pins the amend branch pin's rename follow (src/lib/stores/draft-pin.ts): a
// failed amend restored through a rename remap must carry its pin onto the new
// branch, or every retry refuses as "the checked-out branch changed".
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftKeyBranch,
  retargetAmendPin,
} from "../src/lib/stores/draft-pin.ts";

const WIN = "C:\\repos\\app";

test("a key's branch is read past the repo prefix, colon in the path or not", () => {
  assert.equal(draftKeyBranch(WIN, `${WIN}:feature/x`), "feature/x");
  assert.equal(draftKeyBranch("/home/u/app", "/home/u/app:main"), "main");
  assert.equal(draftKeyBranch(WIN, "D:\\other:main"), null);
  // A sibling repo whose path extends this one is another repo, not a branch.
  assert.equal(draftKeyBranch(WIN, `${WIN}-2:main`), null);
});

test("a pin naming the renamed branch follows the rename", () => {
  assert.equal(retargetAmendPin("A", WIN, `${WIN}:A`, `${WIN}:A2`), "A2");
});

test("a pin naming anything else is left as it is", () => {
  assert.equal(retargetAmendPin("HEAD", WIN, `${WIN}:A`, `${WIN}:A2`), "HEAD");
  assert.equal(retargetAmendPin("B", WIN, `${WIN}:A`, `${WIN}:A2`), "B");
  assert.equal(retargetAmendPin(null, WIN, `${WIN}:A`, `${WIN}:A2`), null);
  assert.equal(retargetAmendPin("A", WIN, `${WIN}:A`, `${WIN}:A`), "A");
  assert.equal(retargetAmendPin("A", null, `${WIN}:A`, `${WIN}:A2`), "A");
  // A key from another repo (the live repo moved on) is never re-read.
  assert.equal(
    retargetAmendPin("A", "D:\\other", `${WIN}:A`, `${WIN}:A2`),
    "A",
  );
});
