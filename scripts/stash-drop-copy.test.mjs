// Pins the stash-drop outcome copy (src/features/repository/stash-drop-copy.ts):
// the banner's sentences stay byte-identical, the dialog's gone variant drops the
// "backup" claim its population can't make, the restore-failed sentence names the
// lost entry by its 7-char sha, and both surfaces read the module rather than
// spelling a copy of their own.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  STASH_DROP_GONE,
  STASH_DROP_MOVED,
  stashDropRestoreFailed,
} from "../src/features/repository/stash-drop-copy.ts";

const MOVED = "The stash list changed — nothing was dropped.";
const GONE_BANNER =
  "The backup stash is already gone, so there was nothing to drop.";
const GONE_DIALOG = "That stash is already gone, so there was nothing to drop.";
const RESTORE_FAILED_LEAD = "The stash list changed — a different stash (";
const RESTORE_FAILED_TAIL =
  ") was dropped and couldn't be restored. Recover it under View stashes → Recoverable.";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the banner's sentences are byte-identical", () => {
  assert.equal(STASH_DROP_MOVED, MOVED);
  assert.equal(STASH_DROP_GONE.banner, GONE_BANNER);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    stashDropRestoreFailed(sha),
    `${RESTORE_FAILED_LEAD}0123456${RESTORE_FAILED_TAIL}`,
  );
});

test("the dialog's gone sentence claims no backup stash", () => {
  assert.equal(STASH_DROP_GONE.dialog, GONE_DIALOG);
  assert.doesNotMatch(STASH_DROP_GONE.dialog, /backup/);
  assert.deepEqual(Object.keys(STASH_DROP_GONE).sort(), ["banner", "dialog"]);
});

test("restore-failed names the first 7 characters of the sha only", () => {
  const sha = "f".repeat(7) + "e".repeat(57);
  const text = stashDropRestoreFailed(sha);
  assert.ok(text.includes(`(${"f".repeat(7)})`), text);
  assert.ok(!text.includes("e".repeat(2) + ")"), text);
});

for (const file of [
  "src/features/repository/ConflictBanner.tsx",
  "src/features/repository/StashesDialog.tsx",
]) {
  test(`${file} reads the copy module and spells none of its sentences`, () => {
    const text = source(file);
    assert.match(
      text,
      /from "\.\/stash-drop-copy";/,
      "the surface imports the shared copy",
    );
    for (const sentence of [
      MOVED,
      GONE_BANNER,
      GONE_DIALOG,
      RESTORE_FAILED_LEAD,
      RESTORE_FAILED_TAIL,
      "The stash list changed — nothing was dropped",
      "so there was nothing to drop",
      "couldn't be restored",
    ]) {
      assert.ok(!text.includes(sentence), `${file} spells "${sentence}"`);
    }
  });
}
