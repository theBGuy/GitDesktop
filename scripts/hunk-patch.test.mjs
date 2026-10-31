// Pins buildHunkPatch (src/lib/git/hunks.ts): a rename/copy file header is
// rewritten as a plain modification of the new path before the patch reaches
// `git apply`, exactly as the Rust build_partial_patch rewrites it (applied in
// reverse, the pairing would undo the rename itself), and every other header
// passes through byte-identical. The import reaches straight into src/ under
// Node's type stripping; the module has no runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHunkPatch, parseHunks } from "../src/lib/git/hunks.ts";

/** A staged rename+edit of a name with a space, exactly as `git diff --cached`
 *  writes it: `---`/`+++` carry a trailing TAB, `diff --git` none. Verbatim
 *  copy of SPACE_RENAME_DIFF in src-tauri/src/git/diff.rs. */
const SPACE_RENAME_DIFF =
  "diff --git a/sp ace2.txt b/sp ace3.txt\nsimilarity index 77%\nrename from sp ace2.txt\nrename to sp ace3.txt\nindex 01f84f8..2169c5f 100644\n--- a/sp ace2.txt\t\n+++ b/sp ace3.txt\t\n@@ -1,5 +1,5 @@\n l1\n-l2\n+l2 EDIT\n l3\n l4\n l5\n";
/** The Rust builder's normalized patch for it, which the Rust apply test
 *  proves applies: verbatim copy of SPACE_RENAME_PATCH (cross-builder pin). */
const SPACE_RENAME_PATCH =
  "diff --git a/sp ace3.txt b/sp ace3.txt\nindex 01f84f8..2169c5f 100644\n--- a/sp ace3.txt\t\n+++ b/sp ace3.txt\t\n@@ -1,5 +1,5 @@\n l1\n-l2\n+l2 EDIT\n l3\n l4\n l5\n";
/** A C-quoted (space + non-ASCII) rename+edit from raw git with
 *  `core.quotePath=true`: verbatim copy of QUOTED_RENAME_DIFF in diff.rs. */
const QUOTED_RENAME_DIFF =
  'diff --git a/x y.txt "b/x y\\303\\251.txt"\nsimilarity index 77%\nrename from x y.txt\nrename to "x y\\303\\251.txt"\nindex 01f84f8..4a7bb98 100644\n--- a/x y.txt\t\n+++ "b/x y\\303\\251.txt"\t\n@@ -6,5 +6,5 @@ l5\n l6\n l7\n l8\n-l9\n+l9 EDIT\n l10\n';

/** The patch for hunk `i` of a diff. */
function hunkPatch(diff, i = 0) {
  const parsed = parseHunks(diff);
  return buildHunkPatch(parsed, parsed.hunks[i]);
}

test("a space-name rename patch is byte-equal to the Rust-normalized literal", () => {
  assert.equal(hunkPatch(SPACE_RENAME_DIFF), SPACE_RENAME_PATCH);
});

test("a C-quoted rename reuses the +++ token, quoted a/ side included", () => {
  assert.deepEqual(hunkPatch(QUOTED_RENAME_DIFF).split("\n").slice(0, 5), [
    'diff --git "a/x y\\303\\251.txt" "b/x y\\303\\251.txt"',
    "index 01f84f8..4a7bb98 100644",
    '--- "a/x y\\303\\251.txt"\t',
    '+++ "b/x y\\303\\251.txt"\t',
    "@@ -6,5 +6,5 @@ l5",
  ]);
});

test("a non-rename header passes through byte-identical", () => {
  const modified =
    "diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\nindex 1..2 100755\n--- a/m.sh\n+++ b/m.sh\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  assert.equal(hunkPatch(modified), modified);
  const spaced =
    "diff --git a/sp ace.txt b/sp ace.txt\nindex 1..2 100644\n--- a/sp ace.txt\t\n+++ b/sp ace.txt\t\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  assert.equal(hunkPatch(spaced), spaced);
});

test("a rename + mode change keeps its mode and index lines", () => {
  const renamed =
    "diff --git a/m.sh b/n.sh\nold mode 100644\nnew mode 100755\nsimilarity index 90%\nrename from m.sh\nrename to n.sh\nindex 1..2\n--- a/m.sh\n+++ b/n.sh\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  assert.equal(
    hunkPatch(renamed),
    "diff --git a/n.sh b/n.sh\nold mode 100644\nnew mode 100755\nindex 1..2\n--- a/n.sh\n+++ b/n.sh\n@@ -1,1 +1,1 @@\n-a\n+b\n",
  );
});

test("copy and dissimilarity lines drop too, and every hunk gets the header", () => {
  const copied =
    "diff --git a/d/a.txt b/e/b.txt\ndissimilarity index 10%\ncopy from d/a.txt\ncopy to e/b.txt\nindex 1..2 100644\n--- a/d/a.txt\n+++ b/e/b.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n";
  const header =
    "diff --git a/e/b.txt b/e/b.txt\nindex 1..2 100644\n--- a/e/b.txt\n+++ b/e/b.txt\n";
  assert.equal(hunkPatch(copied, 0), `${header}@@ -1,1 +1,1 @@\n-a\n+b\n`);
  assert.equal(hunkPatch(copied, 1), `${header}@@ -9,1 +9,1 @@\n-c\n+d\n`);
});

test("a pure rename has no hunks, so no patch is built", () => {
  const pure =
    "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n";
  assert.deepEqual(parseHunks(pure).hunks, []);
});
