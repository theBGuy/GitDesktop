// Pins search all's pure layer (src/features/history/history-search.ts): the
// SHA arm's on-branch hits lead in wire order, grep rows follow minus any
// commit already listed, off-branch hits split out; the dead-vs-stale arm
// read and the coverage table; and the empty-state copy, including the
// singular count and the checked line's three outcomes.
//
// Not testable here: the hex-shape predicates (they live in the react-query
// module) and the panel's rendering; src/test/history-search.test.tsx covers
// both.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARM_FAILED_LINES,
  armRead,
  GREP_ARM_FAILED_LINE,
  loadedCheckedLine,
  mergeSearchResults,
  SEARCH_ALL_CHECKED_LINE,
  SEARCH_ALL_CHECKED_MESSAGES_LINE,
  SEARCH_ALL_FAILED_LINE,
  SHA_ARM_FAILED_LINE,
  searchAllCheckedLineFor,
  searchCoverage,
} from "../src/features/history/history-search.ts";

const commit = (hash) => ({
  hash,
  subject: hash,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});
const hit = (hash, onBranch) => ({ commit: commit(hash), onBranch });
const hashes = (list) => list.map((c) => c.hash);

test("merge: no SHA answer leaves the grep rows as they are", () => {
  const out = mergeSearchResults(undefined, [commit("a1"), commit("a2")]);
  assert.deepEqual(hashes(out.rows), ["a1", "a2"]);
  assert.deepEqual(out.offBranch, []);
});

test("merge: SHA hits alone, wire order kept", () => {
  const out = mergeSearchResults([hit("c2", true), hit("c1", true)], []);
  assert.deepEqual(hashes(out.rows), ["c2", "c1"]);
});

test("merge: a commit both arms matched appears once, at its SHA position", () => {
  const out = mergeSearchResults(
    [hit("b2", true)],
    [commit("b1"), commit("b2"), commit("b3")],
  );
  assert.deepEqual(hashes(out.rows), ["b2", "b1", "b3"]);
});

test("merge: off-branch hits split out in wire order, never as rows", () => {
  const out = mergeSearchResults(
    [hit("d1", true), hit("d3", false), hit("d2", false)],
    [commit("d4")],
  );
  assert.deepEqual(hashes(out.rows), ["d1", "d4"]);
  assert.deepEqual(hashes(out.offBranch), ["d3", "d2"]);
});

test("arm read: dead only without data; a failure over kept data is stale", () => {
  assert.equal(armRead({ hasData: false, failed: false }), "answering");
  assert.equal(armRead({ hasData: true, failed: false }), "answering");
  assert.equal(armRead({ hasData: true, failed: true }), "stale");
  assert.equal(armRead({ hasData: false, failed: true }), "dead");
});

test("coverage: the four cells", () => {
  const c = (shaFailed, grepFailed, hasShaMatches) =>
    searchCoverage({ shaFailed, grepFailed, hasShaMatches });
  assert.equal(c(false, false, false), "full");
  assert.equal(c(true, false, false), "sha-failed");
  assert.equal(c(false, true, true), "grep-failed");
  assert.equal(c(false, true, false), "none");
  assert.equal(c(true, true, false), "none");
});

test("coverage: a stale SHA arm still answers for a dead grep", () => {
  const dead = (hasData, failed) => armRead({ hasData, failed }) === "dead";
  assert.equal(
    searchCoverage({
      shaFailed: dead(true, true),
      grepFailed: dead(false, true),
      hasShaMatches: true,
    }),
    "grep-failed",
  );
});

test("footer failure lines: one per one-dead-arm coverage, no new copy", () => {
  assert.deepEqual(ARM_FAILED_LINES, {
    "sha-failed": SHA_ARM_FAILED_LINE,
    "grep-failed": GREP_ARM_FAILED_LINE,
  });
  assert.equal(SEARCH_ALL_FAILED_LINE, "Couldn't search all history.");
});

test("loaded checked line: singular for one commit", () => {
  assert.equal(
    loadedCheckedLine(1),
    "Checked the subject, author and SHA of 1 loaded commit.",
  );
  assert.equal(
    loadedCheckedLine(2),
    "Checked the subject, author and SHA of 2 loaded commits.",
  );
});

test("search-all checked line: failed arm, short hex, default", () => {
  const line = (i) =>
    searchAllCheckedLineFor({ shortHex: false, armFailed: false, ...i });
  assert.equal(line({ armFailed: true }), null);
  assert.equal(line({ armFailed: true, shortHex: true }), null);
  assert.equal(line({ shortHex: true }), SEARCH_ALL_CHECKED_MESSAGES_LINE);
  assert.equal(
    SEARCH_ALL_CHECKED_MESSAGES_LINE,
    "Checked the message of every commit.",
  );
  assert.equal(line({}), SEARCH_ALL_CHECKED_LINE);
  assert.equal(line({}), "Checked the message and SHA of every commit.");
});
