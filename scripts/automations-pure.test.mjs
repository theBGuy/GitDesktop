// Pins the automation decisions that are pure data: the local-ref freshness
// predicate behind a remote PR review's diff source, and the two store helpers
// that bound and shape-guard `automation-results.json`. A stale local ref makes
// the reviewer read a clean but WRONG diff, and that stays invisible at runtime,
// so the predicate's false arms are the point of this file.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES types
// rather than compiling them and resolves no bundler aliases, so `pure.ts` must
// stay type-only in its imports. A runtime import added there fails this file.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isStoredResult,
  localRefsFresh,
  pruneByCreatedAt,
} from "../src/lib/automations/pure.ts";

// --------------------------------------------------------- localRefsFresh

// The real comparator lives in `automations/sync.ts`, which imports Tauri, so
// the predicate takes it as an argument and these tests inject their own.
const exactSha = (a, b) => a === b && a !== "";

/** A branch whose upstream vouches for it; overrides model each failing axis. */
const branch = (over = {}) => ({
  name: "main",
  isCurrent: false,
  upstream: "origin/main",
  lastCommitDate: "2026-09-01T00:00:00Z",
  archived: false,
  upstreamAhead: 0,
  upstreamBehind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  ...over,
});

const HEAD_SHA = "a".repeat(40);

test("a tracked, in-sync base and a head at the event's sha are fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch()],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    true,
  );
});

test("no head sha means nothing to verify against", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch()],
      "",
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("a missing local head branch is not fresh", () => {
  assert.equal(
    localRefsFresh({}, [branch()], HEAD_SHA, "main", "feature/x", exactSha),
    false,
  );
});

test("a head sha the local tip doesn't match is not fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": "b".repeat(40) },
      [branch()],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("both refs stale is not fresh — a moved head outranks the base check", () => {
  // The measured shape: the local trees agree with each other but not with the
  // PR, so a local diff would come back clean and empty of the real change.
  assert.equal(
    localRefsFresh(
      { "feature/x": "b".repeat(40) },
      [branch({ upstreamBehind: 3 })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("a fresh head over a base behind its upstream is not fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch({ upstreamBehind: 1 })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("a fresh head over a base ahead of its upstream is not fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch({ upstreamAhead: 1 })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("an untracked base can't vouch for itself", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch({ upstream: null })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("a base whose upstream is gone can't vouch for itself", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch({ upstreamGone: true })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("a base branch absent from the list is not fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [branch({ name: "release" })],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("an empty branch list is not fresh", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": HEAD_SHA },
      [],
      HEAD_SHA,
      "main",
      "feature/x",
      exactSha,
    ),
    false,
  );
});

test("an empty local tip is not fresh even under a lenient comparator", () => {
  assert.equal(
    localRefsFresh(
      { "feature/x": "" },
      [branch()],
      HEAD_SHA,
      "main",
      "feature/x",
      () => true,
    ),
    false,
  );
});

test("the injected comparator decides short-vs-full sha matches", () => {
  const prefixSha = (a, b) => a.startsWith(b) || b.startsWith(a);
  const args = [
    { "feature/x": HEAD_SHA },
    [branch()],
    "aaaaaaa",
    "main",
    "feature/x",
  ];
  assert.equal(localRefsFresh(...args, prefixSha), true);
  assert.equal(localRefsFresh(...args, exactSha), false);
});

// --------------------------------------------------------- pruneByCreatedAt

const rec = (id, createdAt) => ({ id, createdAt });

test("records come back newest first", () => {
  const out = pruneByCreatedAt(
    [
      rec("old", "2026-09-01T00:00:00Z"),
      rec("new", "2026-09-03T00:00:00Z"),
      rec("mid", "2026-09-02T00:00:00Z"),
    ],
    20,
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["new", "mid", "old"],
  );
});

test("the cap keeps the newest and drops the rest", () => {
  const out = pruneByCreatedAt(
    [
      rec("a", "2026-09-01T00:00:00Z"),
      rec("b", "2026-09-02T00:00:00Z"),
      rec("c", "2026-09-03T00:00:00Z"),
    ],
    2,
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["c", "b"],
  );
});

test("an unparseable stamp sorts after every dated record, either way round", () => {
  const junk = rec("junk", "not a date");
  const dated = rec("dated", "2026-09-01T00:00:00Z");
  for (const input of [
    [junk, dated],
    [dated, junk],
  ]) {
    assert.deepEqual(
      pruneByCreatedAt(input, 20).map((r) => r.id),
      ["dated", "junk"],
    );
  }
});

test("unparseable stamps keep their insertion order among themselves", () => {
  const out = pruneByCreatedAt(
    [rec("first", "nope"), rec("second", ""), rec("third", "also nope")],
    20,
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["first", "second", "third"],
  );
});

test("a junk stamp costs its own position, never a dated record's", () => {
  const out = pruneByCreatedAt(
    [
      rec("junk", "nope"),
      rec("old", "2026-09-01T00:00:00Z"),
      rec("new", "2026-09-02T00:00:00Z"),
    ],
    2,
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["new", "old"],
  );
});

test("an empty list prunes to an empty list", () => {
  assert.deepEqual(pruneByCreatedAt([], 20), []);
});

test("fewer records than the cap are all kept", () => {
  const out = pruneByCreatedAt([rec("only", "2026-09-01T00:00:00Z")], 20);
  assert.deepEqual(
    out.map((r) => r.id),
    ["only"],
  );
});

// ---------------------------------------------------------- isStoredResult

const stored = (over = {}) => ({
  schemaVersion: 1,
  id: "run-1",
  repoPath: "C:/repo",
  subject: "fix: a thing",
  mode: "general",
  text: "review body",
  createdAt: "2026-09-01T00:00:00Z",
  hash: "c".repeat(40),
  ...over,
});

test("a complete record passes", () => {
  assert.equal(isStoredResult(stored()), true);
});

test("the unchecked fields are optional to the guard", () => {
  const partial = stored();
  delete partial.mode;
  delete partial.repoPath;
  delete partial.schemaVersion;
  assert.equal(isStoredResult(partial), true);
});

test("each guarded field must be a string", () => {
  for (const field of ["id", "text", "subject", "createdAt", "hash"]) {
    assert.equal(isStoredResult(stored({ [field]: 7 })), false, field);
    const missing = stored();
    delete missing[field];
    assert.equal(isStoredResult(missing), false, field);
  }
});

test("non-objects and null are rejected", () => {
  for (const x of [null, undefined, "run-1", 7, true]) {
    assert.equal(isStoredResult(x), false, String(x));
  }
});

test("an array has no guarded fields, so it is rejected", () => {
  assert.equal(isStoredResult([stored()]), false);
});
