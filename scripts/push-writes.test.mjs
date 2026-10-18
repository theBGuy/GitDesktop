// Pins the pure branch-push bookkeeping: which cache entries count as a push of a
// repo, how their variables read back, and the label a branch row's spinner
// shows. A wrong answer here never errors — a variables-shape change reads as
// "no push" and the row's holds silently drop — so each shape is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `push-writes.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRANCH_PUSH_KEY,
  branchPublishLabel,
  branchPushKey,
  branchPushLabel,
  pendingBranchPushesFor,
} from "../src/lib/git/queries/push-writes.ts";

const entry = (vars, extra = {}) => ({
  key: branchPushKey("/repo"),
  vars,
  mutationId: 1,
  ...extra,
});

const push = (overrides = {}) => ({
  mutationId: 1,
  branch: "feature",
  remote: null,
  remoteBranch: null,
  setUpstream: false,
  paused: false,
  fromHeader: false,
  ...overrides,
});

const tracked = { upstream: "origin/feature", upstreamGone: false };

test("the key is the prefix plus the repo, disjoint from tag pushes", () => {
  assert.deepEqual(branchPushKey("/repo"), ["branch-push", "/repo"]);
  assert.deepEqual(BRANCH_PUSH_KEY, ["branch-push"]);
  assert.notEqual(BRANCH_PUSH_KEY[0], "tag-push");
});

test("a push of the repo reads back every field, mutationId and paused included", () => {
  const out = pendingBranchPushesFor(
    [
      entry(
        {
          setUpstream: true,
          branch: "feature",
          remote: "fork",
          remoteBranch: "pr-head",
          force: false,
        },
        { mutationId: 7, paused: true },
      ),
    ],
    "/repo",
  );
  assert.deepEqual(out, [
    {
      mutationId: 7,
      branch: "feature",
      remote: "fork",
      remoteBranch: "pr-head",
      setUpstream: true,
      paused: true,
      fromHeader: false,
    },
  ]);
});

test("another repo's push, another prefix, and a keyless entry are dropped", () => {
  const out = pendingBranchPushesFor(
    [
      { key: branchPushKey("/other"), vars: { setUpstream: false } },
      { key: ["tag-push", "/repo"], vars: { setUpstream: false } },
      { key: undefined, vars: { setUpstream: false } },
      { key: ["branch-push"], vars: { setUpstream: false } },
    ],
    "/repo",
  );
  assert.deepEqual(out, []);
});

test("non-object variables are no push and are dropped", () => {
  const out = pendingBranchPushesFor(
    [entry(undefined), entry(null), entry("feature"), entry(42)],
    "/repo",
  );
  assert.deepEqual(out, []);
});

test("missing or mistyped fields read as null / false, never guessed", () => {
  const [out] = pendingBranchPushesFor(
    [
      entry(
        { setUpstream: "yes", branch: 3, remote: {}, remoteBranch: [] },
        { mutationId: undefined, paused: "true" },
      ),
    ],
    "/repo",
  );
  assert.deepEqual(out, {
    mutationId: null,
    branch: null,
    remote: null,
    remoteBranch: null,
    setUpstream: false,
    paused: false,
    fromHeader: false,
  });
});

test("a HEAD push (no branch) keeps a null branch for the latch to resolve", () => {
  const [out] = pendingBranchPushesFor(
    [entry({ setUpstream: false, source: "header" }, { mutationId: 9 })],
    "/repo",
  );
  assert.equal(out.branch, null);
  assert.equal(out.mutationId, 9);
});

test("a branch named like an Object.prototype member reads as itself", () => {
  const out = pendingBranchPushesFor(
    [
      entry({ setUpstream: false, branch: "__proto__" }),
      entry({ setUpstream: false, branch: "constructor" }, { mutationId: 2 }),
    ],
    "/repo",
  );
  assert.deepEqual(
    out.map((p) => p.branch),
    ["__proto__", "constructor"],
  );
});

test("every entry is kept, in cache order, twins included", () => {
  const out = pendingBranchPushesFor(
    [
      entry({ setUpstream: false, branch: "b" }, { mutationId: 3 }),
      entry({ setUpstream: false, branch: "a" }, { mutationId: 1 }),
      entry(
        { setUpstream: false, branch: "b" },
        { mutationId: 5, paused: true },
      ),
    ],
    "/repo",
  );
  assert.deepEqual(
    out.map((p) => [p.mutationId, p.branch, p.paused]),
    [
      [3, "b", false],
      [1, "a", false],
      [5, "b", true],
    ],
  );
});

test('fromHeader is set by source "header" and nothing else', () => {
  const out = pendingBranchPushesFor(
    [
      entry({ setUpstream: false, source: "header" }),
      entry({ setUpstream: false, source: "Header" }),
      entry({ setUpstream: false, source: true }),
      entry({ setUpstream: false }),
      entry({ setUpstream: false, fromHeader: true }),
    ],
    "/repo",
  );
  assert.deepEqual(
    out.map((p) => p.fromHeader),
    [true, false, false, false, false],
  );
});

test("label: cross-name beats setUpstream, untracked and tracked", () => {
  const p = push({
    remote: "fork",
    remoteBranch: "pr-head",
    setUpstream: true,
  });
  assert.equal(branchPushLabel(p, tracked), "Pushing to fork/pr-head");
  assert.equal(
    branchPushLabel(p, { upstream: null, upstreamGone: false }),
    "Pushing to fork/pr-head",
  );
});

test("label: a cross-name entry without a remote falls through, never null/x", () => {
  const p = push({ remote: null, remoteBranch: "pr-head" });
  assert.equal(branchPushLabel(p, tracked), "Pushing to origin/feature");
  assert.equal(
    branchPushLabel(p, { upstream: null, upstreamGone: false }),
    "Publishing branch",
  );
  // A mistyped remote is read as absent before the label sees it.
  const [read] = pendingBranchPushesFor(
    [
      entry({
        setUpstream: false,
        branch: "feature",
        remote: 5,
        remoteBranch: "pr-head",
      }),
    ],
    "/repo",
  );
  assert.equal(branchPushLabel(read, tracked), "Pushing to origin/feature");
});

test("label: setUpstream beats a tracked row", () => {
  assert.equal(
    branchPushLabel(push({ setUpstream: true, remote: "origin" }), tracked),
    "Publishing to origin",
  );
});

test("label: an untracked or upstream-gone row publishes", () => {
  assert.equal(
    branchPushLabel(push({ remote: "upstream" }), {
      upstream: null,
      upstreamGone: false,
    }),
    "Publishing to upstream",
  );
  assert.equal(
    branchPushLabel(push({ remote: "origin" }), {
      upstream: "origin/feature",
      upstreamGone: true,
    }),
    "Publishing to origin",
  );
});

test("label: a publish with no remote never assumes origin", () => {
  assert.equal(
    branchPushLabel(push({ setUpstream: true }), tracked),
    "Publishing branch",
  );
  assert.equal(
    branchPushLabel(push(), { upstream: null, upstreamGone: false }),
    "Publishing branch",
  );
  assert.equal(branchPublishLabel(null), "Publishing branch");
  assert.equal(branchPublishLabel("fork"), "Publishing to fork");
});

test("label: a tracked row names its upstream", () => {
  assert.equal(branchPushLabel(push(), tracked), "Pushing to origin/feature");
  // The push's own remote never overrides the row's upstream on this arm.
  assert.equal(
    branchPushLabel(push({ remote: "other" }), tracked),
    "Pushing to origin/feature",
  );
});

test("label: a HEAD push of a tracked row names no destination", () => {
  // A bare `git push` follows pushRemote / pushDefault / push.default, so the
  // row's upstream may not be where it lands.
  assert.equal(branchPushLabel(push({ branch: null }), tracked), "Pushing");
  // Only the tracked arm changes: a HEAD push that publishes still says so.
  assert.equal(
    branchPushLabel(push({ branch: null, setUpstream: true }), tracked),
    "Publishing branch",
  );
  assert.equal(
    branchPushLabel(push({ branch: null }), {
      upstream: null,
      upstreamGone: false,
    }),
    "Publishing branch",
  );
});
