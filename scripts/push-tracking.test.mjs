// Pins the push-to-origin hotkey's destination confirms: a fresh read of what a
// branch tracks must agree with the listed row the push is decided from, and
// any disagreement reads as the list catching up (a refusal, never a push).
//
// The import below reaches straight into `src/` under Node's type stripping,
// which resolves no aliases, so `push-tracking.ts` must stay import-free beyond
// type-only imports. The wiring the pure helpers can't see (both hotkey routes
// calling them, the sync bar's open-gated remote-branches read) is pinned by
// source scans at the bottom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  headTrackingMatchesRow,
  rowTrackingMatches,
} from "../src/lib/git/push-tracking.ts";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const head = (over = {}) => ({
  name: "feat",
  detached: false,
  oid: "abc",
  upstream: "origin/feat",
  ahead: 1,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "feat",
  pushNameMismatch: false,
  upstreamIsRemoteDefault: null,
  ...over,
});

const row = (over = {}) => ({
  name: "feat",
  isCurrent: true,
  upstream: "origin/feat",
  lastCommitDate: "2026-10-15T00:00:00Z",
  archived: false,
  upstreamAhead: 1,
  upstreamBehind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamRemoteRef: "refs/heads/feat",
  ...over,
});

const UNTRACKED_HEAD = {
  upstream: null,
  upstreamRemote: null,
  upstreamBranch: null,
};
const UNTRACKED_ROW = {
  upstream: null,
  upstreamRemote: null,
  upstreamRemoteRef: null,
};

test("head vs row: both untracked match", () => {
  assert.equal(
    headTrackingMatchesRow(head(UNTRACKED_HEAD), row(UNTRACKED_ROW)),
    true,
  );
});

test("head vs row: a gone flag that differs is a mismatch", () => {
  assert.equal(
    headTrackingMatchesRow(head({ upstreamGone: true }), row()),
    false,
  );
  assert.equal(
    headTrackingMatchesRow(head(), row({ upstreamGone: true })),
    false,
  );
});

test("head vs row: upstream presence that differs is a mismatch", () => {
  assert.equal(headTrackingMatchesRow(head(UNTRACKED_HEAD), row()), false);
  assert.equal(headTrackingMatchesRow(head(), row(UNTRACKED_ROW)), false);
});

test("head vs row: the same remote and branch match", () => {
  assert.equal(headTrackingMatchesRow(head(), row()), true);
});

test("head vs row: tracking moved to another branch is a mismatch", () => {
  // `git branch -u origin/main feat` outside the app: the row still says feat.
  assert.equal(
    headTrackingMatchesRow(
      head({ upstream: "origin/main", upstreamBranch: "main" }),
      row(),
    ),
    false,
  );
});

test("head vs row: tracking moved to another remote is a mismatch", () => {
  assert.equal(
    headTrackingMatchesRow(
      head({ upstream: "fork/feat", upstreamRemote: "fork" }),
      row(),
    ),
    false,
  );
});

test("head vs row: a local upstream matches the list's `.` and null forms", () => {
  // Status nulls the remote of a local upstream; the branch list passes git's
  // `.` through (src-tauri/src/git/branches.rs keeps any non-empty remotename).
  const local = head({
    upstream: "main",
    upstreamRemote: null,
    upstreamBranch: null,
  });
  assert.equal(
    headTrackingMatchesRow(
      local,
      row({
        upstream: "main",
        upstreamRemote: ".",
        upstreamRemoteRef: "refs/heads/main",
      }),
    ),
    true,
  );
  assert.equal(
    headTrackingMatchesRow(
      local,
      row({ upstream: "main", upstreamRemote: null, upstreamRemoteRef: null }),
    ),
    true,
  );
});

test("head vs row: a failed split read never matches a remote row", () => {
  assert.equal(
    headTrackingMatchesRow(
      head({ upstreamRemote: null, upstreamBranch: null }),
      row(),
    ),
    false,
  );
});

test("head vs row: a non-branch upstream on both sides matches", () => {
  assert.equal(
    headTrackingMatchesRow(
      head({ upstream: "origin/pull/7/head", upstreamBranch: null }),
      row({
        upstream: "origin/pull/7/head",
        upstreamRemoteRef: "refs/pull/7/head",
      }),
    ),
    true,
  );
});

test("row vs row: equal tracking matches", () => {
  assert.equal(rowTrackingMatches(row(), row({ upstreamAhead: 3 })), true);
});

test("row vs row: each tracking field that differs is a mismatch", () => {
  for (const over of [
    { upstream: "origin/main" },
    { upstreamGone: true },
    { upstreamRemote: "fork" },
    { upstreamRemoteRef: "refs/heads/main" },
  ]) {
    assert.equal(
      rowTrackingMatches(row(over), row()),
      false,
      JSON.stringify(over),
    );
  }
});

/** The body of a two-space-indented function inside the component. */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = src.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return src.slice(start, end);
}

test("both push-to-origin routes confirm tracking before pushing", () => {
  const src = source("src/features/repository/BranchSwitcher.tsx");
  const current = functionBody(
    src,
    "async function pushCurrentBranchToOrigin(",
  );
  assert.match(current, /!headTrackingMatchesRow\(fresh, listed\)/);
  const listed = functionBody(src, "async function pushListedBranchToOrigin(");
  assert.match(listed, /!rowTrackingMatches\(freshRow, row\)/);
  // The open-list arm goes through the confirming route, never straight to the
  // push decision.
  const hotkey = src.slice(src.indexOf('"push-to-origin",'));
  const openArm = hotkey.slice(0, hotkey.indexOf("if (!currentBranch)"));
  assert.match(openArm, /void pushListedBranchToOrigin\(row\);/);
  assert.doesNotMatch(openArm, /pushBranchToOrigin\(/);
});

test("the sync bar reads remote branches only while the mismatch menu is open", () => {
  const src = source("src/features/repository/SyncControls.tsx");
  const call = src.match(/useRemoteBranches\(([^)]*)\)/);
  assert.ok(call, "useRemoteBranches( call not found");
  assert.match(call[1], /\bpushMenuOpen\b/);
});
