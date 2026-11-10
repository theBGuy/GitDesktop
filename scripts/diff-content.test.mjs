// Pins the content comparison the commit view's placeholder gates share.
// Dep-free like diff-split.test.mjs: the import reaches straight into src/, so
// diff-content.ts must stay free of aliased runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILE_DIFF_FIELDS,
  sameDiffContent,
} from "../src/lib/git/diff-content.ts";

/** A FileDiff with every field set, so each one can differ on its own. */
const full = () => ({
  filePath: "src/a.txt",
  isBinary: false,
  isTruncated: false,
  text: "diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
  undecodable: false,
  oldPath: "src/old.txt",
  whitespaceHidden: false,
  whitespaceOnly: false,
});

/** The same field with another value of its type. */
const other = (value) => (typeof value === "boolean" ? !value : `${value}x`);

test("the fixture sets exactly the compared fields", () => {
  assert.deepEqual([...FILE_DIFF_FIELDS].sort(), Object.keys(full()).sort());
});

test("distinct objects with equal content compare equal", () => {
  const stamped = full();
  const shown = full();
  assert.notEqual(shown, stamped);
  assert.equal(sameDiffContent(stamped, shown), true);
});

test("the stamped object itself compares equal", () => {
  const stamped = full();
  assert.equal(sameDiffContent(stamped, stamped), true);
});

test("omitted optional fields compare equal", () => {
  const bare = () => ({
    filePath: "a.txt",
    isBinary: true,
    isTruncated: false,
    text: "",
  });
  assert.equal(sameDiffContent(bare(), bare()), true);
});

for (const key of FILE_DIFF_FIELDS) {
  test(`a different ${key} compares unequal`, () => {
    const stamped = full();
    const shown = { ...full(), [key]: other(stamped[key]) };
    assert.equal(sameDiffContent(stamped, shown), false);
  });
}

test("an absent shown read compares unequal", () => {
  assert.equal(sameDiffContent(full(), undefined), false);
});
