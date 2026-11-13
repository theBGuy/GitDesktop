// Pins the deleted-branches record's place in the relocate migration's identity
// roster: the record is per repository identity, so a relocate must re-home it
// or the deleted branches listed under the old path are orphaned. Its entries
// carry an `id`, so the merge class is id-merge (both sides' entries survive).
//
// Node's stdlib test runner only, no dev dependency: the CI `guards` job runs
// `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "src/lib/repo-data-migration.ts";

/** Problems with the store's migration entry, `[]` when pinned: one live,
 *  uncommented id-merge entry for deleted-branches.json inside IDENTITY_STORES. */
function identityStoreProblems(text) {
  const start = text.indexOf("const IDENTITY_STORES: IdentityStore[] = [");
  if (start === -1) return ["IDENTITY_STORES is missing"];
  const end = text.indexOf("\n];", start);
  if (end === -1) return ["IDENTITY_STORES is unterminated"];
  const body = text.slice(start, end);
  const live = body.match(
    /^\s*\{\s*file:\s*"deleted-branches\.json",\s*merge:\s*"id-merge"\s*\},?\s*$/gm,
  );
  const any = body.match(/"deleted-branches\.json"/g);
  if (live?.length !== 1)
    return ["deleted-branches.json is not one id-merge IDENTITY_STORES entry"];
  if (any?.length !== 1)
    return ["deleted-branches.json is named more than once in IDENTITY_STORES"];
  return [];
}

test("the deleted-branches record is in the relocate migration's identity roster", () => {
  const text = readFileSync(join(ROOT, MIGRATION), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.deepEqual(identityStoreProblems(text), []);
  const needle = '  { file: "deleted-branches.json", merge: "id-merge" },\n';
  assert.ok(text.includes(needle), "the mutation needle applies");
  for (const [label, mutant] of [
    ["entry removed", text.replace(needle, "")],
    ["entry commented out", text.replace(needle, `  // ${needle.trimStart()}`)],
    [
      "merge class keep-new",
      text.replace(needle, needle.replace("id-merge", "keep-new")),
    ],
    [
      "merge class inner-key",
      text.replace(needle, needle.replace("id-merge", "inner-key")),
    ],
    ["entry duplicated", text.replace(needle, `${needle}${needle}`)],
  ]) {
    assert.notDeepEqual(identityStoreProblems(mutant), [], label);
  }
});

test("an entry outside IDENTITY_STORES does not count", () => {
  const text = [
    "const IDENTITY_STORES: IdentityStore[] = [",
    '  { file: "local-prs.json", merge: "id-merge" },',
    "];",
    '  { file: "deleted-branches.json", merge: "id-merge" },',
    "",
  ].join("\n");
  assert.notDeepEqual(identityStoreProblems(text), []);
});
