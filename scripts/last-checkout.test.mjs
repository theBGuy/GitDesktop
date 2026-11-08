// Pins the reopen-last-worktree decision table: which recents row hints a
// remembered worktree, and when a click on it redirects there instead of the
// main checkout. Every compare folds both producers (git prints forward slashes,
// validate_repo hands back backslashes on Windows, and paths compare
// case-insensitively there), so the local fold is pinned equal to normPath.
// Also pins the store's place in the relocate migration's identity roster: every
// per-repo identity store is re-homed on relocate so no orphan keys accumulate
// (the re-keyed record keeps its old paths, so it won't redirect afterwards).
//
// The imports below reach straight into `src/` and rely on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so both modules must
// stay import-free. Node's stdlib test runner only, no dev dependency: the CI
// `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { normPath } from "../src/lib/git/path.ts";
import {
  FUTURE_AT_SLACK_MS,
  findReopenRecord,
  foldPath,
  listedMainIs,
  rememberedIsListed,
  reopenHint,
  resolveReopenTarget,
} from "../src/lib/last-checkout/resolve.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "src/lib/repo-data-migration.ts";

const MAIN = "C:\\repos\\demo";
const WT = "C:/repos/demo-wt";
const ID = "C:/repos/demo/.git";
const OTHER_ID = "C:/repos/other/.git";
// The caller's clock; every fixture's `at` sits well before it.
const NOW = 1_000_000;

const record = (extra = {}) => ({
  identity: ID,
  path: WT,
  mainPath: MAIN,
  at: 1_000,
  ...extra,
});
const list = (...worktrees) => worktrees;
const main = (path = "C:/repos/demo") => ({ path, isMain: true });
const linked = (path = WT) => ({ path, isMain: false });

const target = (extra = {}) =>
  resolveReopenTarget({
    clickedRoot: MAIN,
    record: record(),
    preferMain: false,
    openIdentity: OTHER_ID,
    worktrees: list(main(), linked()),
    ...extra,
  });

test("A1: a main row with a listed non-main record redirects to it", () => {
  assert.equal(findReopenRecord([record()], MAIN, null, NOW)?.path, WT);
  assert.equal(target(), WT);
  assert.equal(target({ openIdentity: null }), WT);
});

test("A2: the open repo's own identity goes to main", () => {
  assert.equal(target({ openIdentity: ID }), null);
  assert.equal(target({ openIdentity: "c:\\REPOS\\demo\\.git" }), null);
});

test("A2b: the remembered worktree being the open checkout finds no record", () => {
  assert.equal(findReopenRecord([record()], MAIN, WT, NOW), null);
  assert.equal(
    findReopenRecord([record()], MAIN, "c:\\Repos\\Demo-WT", NOW),
    null,
  );
  assert.equal(reopenHint([record()], MAIN, WT, NOW), null);
});

test("A3: a worktree row opens itself", () => {
  assert.equal(findReopenRecord([record()], WT, null, NOW), null);
  assert.equal(
    findReopenRecord([record({ mainPath: WT, path: WT })], WT, null, NOW),
    null,
  );
});

test("A4: every miss falls back to main", () => {
  assert.equal(findReopenRecord([], MAIN, null, NOW), null);
  // Another repo's record never answers for this row.
  const foreign = record({ path: "C:/repos/b-wt", mainPath: "C:/repos/b" });
  assert.equal(findReopenRecord([foreign], MAIN, null, NOW), null);
  // The record is main: it names the row's own checkout.
  assert.equal(
    findReopenRecord([record({ path: "c:/repos/demo" })], MAIN, null, NOW),
    null,
  );
  assert.equal(target({ record: null }), null);
  assert.equal(target({ preferMain: true }), null);
  assert.equal(target({ worktrees: list(main()) }), null);
  assert.equal(target({ worktrees: list(main(), linked("C:/x")) }), null);
  assert.equal(target({ worktrees: null }), null);
  assert.equal(target({ openIdentity: "unresolved" }), null);
  // The record's path listed only as main never counts as a linked worktree.
  assert.equal(rememberedIsListed(list(main(WT)), WT), false);
});

test("A4b: a fresh list whose main lives elsewhere goes to main", () => {
  assert.equal(
    target({ worktrees: list(main("C:/elsewhere"), linked()) }),
    null,
  );
  assert.equal(target({ worktrees: list(linked()) }), null);
});

test("A5: every compare folds case and separators on both sides", () => {
  // record.mainPath <-> clickedRoot / rowPath
  assert.equal(
    findReopenRecord([record()], "c:/REPOS/demo", null, NOW)?.path,
    WT,
  );
  assert.equal(
    target({
      clickedRoot: "c:/repos/DEMO",
      worktrees: list(main(MAIN), linked()),
    }),
    WT,
  );
  // record.path <-> worktree-list paths
  assert.equal(
    target({ worktrees: list(main(), linked("c:\\REPOS\\demo-wt")) }),
    WT,
  );
  assert.equal(rememberedIsListed(list(linked("C:/A/B")), "c:\\a\\b"), true);
  // rowPath <-> currentPath
  assert.equal(findReopenRecord([record()], MAIN, "c:/repos/DEMO", NOW), null);
  // record.path <-> currentPath
  assert.equal(
    findReopenRecord([record()], MAIN, "C:\\REPOS\\DEMO-WT", NOW),
    null,
  );
  // The stored spelling is returned unfolded.
  assert.equal(target(), WT);
});

test("foldPath mirrors normPath over the variant corpus", () => {
  for (const p of [
    "C:\\x\\y",
    "c:/X/Y",
    "C:/Repos/Demo-WT",
    "c:\\repos\\DEMO\\",
    "\\\\server\\Share\\Repo",
    "/home/User/repo",
    "D:/Mixed\\Seps/Path",
    "",
  ])
    assert.equal(foldPath(p), normPath(p), p);
});

test("A5b: degenerate inputs never match", () => {
  assert.equal(findReopenRecord([record()], "", null, NOW), null);
  assert.equal(findReopenRecord([record({ path: "" })], MAIN, null, NOW), null);
  assert.equal(
    findReopenRecord([record({ mainPath: "" })], MAIN, null, NOW),
    null,
  );
  assert.equal(
    findReopenRecord([record({ mainPath: "" })], "", null, NOW),
    null,
  );
  assert.equal(rememberedIsListed(list(linked("")), ""), false);
});

test("L1: the most recent record matching a row wins", () => {
  const older = record({ identity: OTHER_ID, path: "C:/repos/old-wt", at: 5 });
  const newer = record({ at: 9 });
  assert.equal(findReopenRecord([older, newer], MAIN, null, NOW), newer);
  assert.equal(findReopenRecord([newer, older], MAIN, null, NOW), newer);
  // A newer MAIN landing outranks an older worktree record left by a repo the
  // folder no longer holds.
  const mainLanding = record({ path: "C:/repos/demo", at: 20 });
  assert.equal(findReopenRecord([older, mainLanding], MAIN, null, NOW), null);
});

test("L1: a record stamped past the slack ahead of now loses to any trusted one", () => {
  const real = record({ at: 9 });
  const future = record({
    identity: OTHER_ID,
    path: "C:/repos/future-wt",
    at: NOW + FUTURE_AT_SLACK_MS + 1,
  });
  assert.equal(findReopenRecord([future, real], MAIN, null, NOW), real);
  assert.equal(findReopenRecord([real, future], MAIN, null, NOW), real);
  // A future main landing can't hide a trusted worktree record either.
  const futureMain = record({
    identity: OTHER_ID,
    path: "C:/repos/demo",
    at: NOW + 2 * FUTURE_AT_SLACK_MS,
  });
  assert.equal(findReopenRecord([futureMain, real], MAIN, null, NOW), real);
  // At the slack it is still trusted, and alone an untrusted one still answers.
  const edge = record({ ...future, at: NOW + FUTURE_AT_SLACK_MS });
  assert.equal(findReopenRecord([edge, real], MAIN, null, NOW), edge);
  assert.equal(findReopenRecord([future], MAIN, null, NOW), future);
});

test("reopenHint names the remembered folder", () => {
  assert.deepEqual(reopenHint([record()], MAIN, null, NOW), {
    path: WT,
    name: "demo-wt",
  });
  assert.deepEqual(
    reopenHint([record({ path: "C:\\repos\\feat-x\\" })], MAIN, null, NOW),
    { path: "C:\\repos\\feat-x\\", name: "feat-x" },
  );
});

/** Problems with the store's migration entry, `[]` when pinned: one live,
 *  uncommented keep-new entry for last-checkout.json inside IDENTITY_STORES. */
function identityStoreProblems(text) {
  const start = text.indexOf("const IDENTITY_STORES: IdentityStore[] = [");
  if (start === -1) return ["IDENTITY_STORES is missing"];
  const end = text.indexOf("\n];", start);
  if (end === -1) return ["IDENTITY_STORES is unterminated"];
  const body = text.slice(start, end);
  const entries = body.match(
    /^\s*\{\s*file:\s*"last-checkout\.json",\s*merge:\s*"keep-new"\s*\},?\s*$/gm,
  );
  return entries?.length === 1
    ? []
    : ["last-checkout.json is not one keep-new IDENTITY_STORES entry"];
}

test("the store is in the relocate migration's identity roster", () => {
  const text = readFileSync(join(ROOT, MIGRATION), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.deepEqual(identityStoreProblems(text), []);
  const needle = '  { file: "last-checkout.json", merge: "keep-new" },\n';
  assert.ok(text.includes(needle), "the mutation needle applies");
  for (const mutant of [
    text.replace(needle, ""),
    text.replace(needle, `  // ${needle.trimStart()}`),
    text.replace(needle, needle.replace("keep-new", "id-merge")),
    text.replace(needle, `${needle}${needle}`),
  ])
    assert.notDeepEqual(identityStoreProblems(mutant), []);
});

test("L1: an equal at prefers the worktree record, in either store order", () => {
  // Its identity sorts first, so only the kind rule can pick the worktree.
  const mainLanding = record({
    identity: "C:/a/.git",
    path: "C:/repos/demo",
    at: 9,
  });
  const worktree = record({ at: 9 });
  assert.equal(
    findReopenRecord([mainLanding, worktree], MAIN, null, NOW),
    worktree,
  );
  assert.equal(
    findReopenRecord([worktree, mainLanding], MAIN, null, NOW),
    worktree,
  );
  const a = record({ identity: "a", path: "C:/repos/a-wt", at: 9 });
  const b = record({ identity: "b", path: "C:/repos/b-wt", at: 9 });
  assert.equal(findReopenRecord([a, b], MAIN, null, NOW), a);
  assert.equal(findReopenRecord([b, a], MAIN, null, NOW), a);
});

test("listedMainIs: the list's main entry must fold-equal the root", () => {
  assert.equal(listedMainIs(list(main(), linked()), MAIN), true);
  assert.equal(
    listedMainIs(list(main("C:/REPOS/DEMO")), "c:/repos/demo"),
    true,
  );
  assert.equal(listedMainIs(list(main("C:/elsewhere"), linked()), MAIN), false);
  assert.equal(listedMainIs(list(linked()), MAIN), false);
  assert.equal(listedMainIs(list(), MAIN), false);
});
