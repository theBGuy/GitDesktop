// Pins the deletion arms' byte-truth consult in `fallbackArm`: a modify/delete
// survivor reads edited from the backend's raw-byte `workingMatchesSurvivor`
// verdict whenever it is non-null, since lossy decodes of distinct non-UTF-8
// bytes can collide (an edit reads untouched) and the decode alone can't tell
// an untouched non-UTF-8 file from an edited one. Only a null or absent verdict
// falls back to the CRLF-agnostic string compare, whose single left-to-right
// pass over CRLF pairs is pinned here as the Rust `nlf_bytes` twin.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-parse.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fallbackArm } from "../src/lib/git/conflict-parse.ts";

// The lossy decode of two different cp1252 bytes: identical strings.
const LOSSY = "caf\uFFFD\n";

const survivorSides = (working, verdict, workingExists = true) => ({
  working,
  base: "base\n",
  ours: null,
  theirs: LOSSY,
  aiIgnored: { ignored: false, unreadable: false },
  workingExists,
  workingUndecodable: true,
  undecodable: true,
  workingHash: workingExists ? "0".repeat(40) : null,
  ...(verdict === undefined ? {} : { workingMatchesSurvivor: verdict }),
});

test("a false verdict reads edited even when the lossy decodes collide", () => {
  assert.equal(fallbackArm(survivorSides(LOSSY, false)), "deletionEdited");
});

test("a true verdict reads untouched even when the decodes differ", () => {
  assert.equal(fallbackArm(survivorSides("caf\uFFFD\r\n", true)), "deletion");
  assert.equal(fallbackArm(survivorSides("other\n", true)), "deletion");
});

test("a null or absent verdict falls back to the string compare", () => {
  for (const verdict of [null, undefined]) {
    const label = String(verdict);
    assert.equal(fallbackArm(survivorSides(LOSSY, verdict)), "deletion", label);
    assert.equal(
      fallbackArm(survivorSides("caf\uFFFD\r\n", verdict)),
      "deletion",
      `${label}: CRLF-only difference`,
    );
    assert.equal(
      fallbackArm(survivorSides("edited\n", verdict)),
      "deletionEdited",
      label,
    );
  }
});

test("a deleted working file never reads edited", () => {
  assert.equal(fallbackArm(survivorSides("", null, false)), "deletion");
  assert.equal(fallbackArm(survivorSides("", false, false)), "deletion");
});

// The fallback compare's normalization: one non-overlapping pass, so `\r\r\n`
// keeps one `\r`, a lone `\r` stays, and a BOM is content.
test("the string fallback normalizes exactly like nlf_bytes", () => {
  const arm = (working, theirs) =>
    fallbackArm({ ...survivorSides(working, null), theirs });
  // `\r\r\n` → `\r\n`, never `\n`: a CR run doesn't collapse.
  assert.equal(arm("a\r\r\n", "a\r\n"), "deletionEdited");
  assert.equal(arm("a\r\r\n", "a\n"), "deletionEdited");
  assert.equal(arm("a\r\r\n", "a\r\r\n"), "deletion");
  assert.equal(arm("a\r", "a"), "deletionEdited");
  assert.equal(arm("a", "a\n"), "deletionEdited");
  assert.equal(arm("\uFEFFa\r\n", "\uFEFFa\n"), "deletion");
  assert.equal(arm("\uFEFFa\n", "a\n"), "deletionEdited");
});
