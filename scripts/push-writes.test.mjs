// Pins the pure branch-push bookkeeping: which cache entries count as a push of a
// repo, how their variables read back, the label a branch row's spinner shows,
// the hold reasons, the HEAD-push latch, and the delayed list re-read's
// coalescing. A wrong answer here never errors — a variables-shape change reads
// as "no push" and the row's holds silently drop, and a lost key leaves a list
// stale — so each shape is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `push-writes.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRANCH_PUSH_KEY,
  branchPreparingLabel,
  branchPublishLabel,
  branchPushHoldItemReason,
  branchPushHoldReason,
  branchPushKey,
  branchPushLabel,
  LIST_RECHECK_MS,
  nextPushLatch,
  pendingBranchPushesFor,
  recheckListsLater,
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
  startedOn: null,
  remote: null,
  remoteBranch: null,
  setUpstream: false,
  paused: false,
  fromHeader: false,
  foreign: false,
  creates: false,
  renaming: false,
  ...overrides,
});

const tracked = { upstream: "origin/feature", upstreamGone: false };

test("the key is the prefix plus the repo, disjoint from tag pushes", () => {
  assert.deepEqual(branchPushKey("/repo"), ["branch-push", "/repo"]);
  assert.deepEqual(branchPushKey("/repo", undefined), ["branch-push", "/repo"]);
  // The identity rides AFTER the path, so a path-prefix read still matches.
  assert.deepEqual(branchPushKey("/repo", "/repo/.git"), [
    "branch-push",
    "/repo",
    "/repo/.git",
  ]);
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
          creates: true,
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
      startedOn: null,
      remote: "fork",
      remoteBranch: "pr-head",
      setUpstream: true,
      paused: true,
      fromHeader: false,
      foreign: false,
      creates: true,
      renaming: false,
    },
  ]);
});

const renameVars = {
  oldName: "old",
  newName: "new",
  remote: "origin",
  expectedOldTip: "abc123",
};
const renameState = (branch, overrides = {}) => ({
  mutationId: 9,
  branch,
  startedOn: null,
  remote: "origin",
  remoteBranch: "new",
  setUpstream: true,
  paused: false,
  fromHeader: false,
  foreign: false,
  creates: false,
  renaming: true,
  ...overrides,
});

test("a remote rename reads back as two states, its old name and its new one", () => {
  const out = pendingBranchPushesFor(
    [entry(renameVars, { mutationId: 9 })],
    "/repo",
  );
  assert.deepEqual(out, [renameState("old"), renameState("new")]);
});

test("a remote rename keeps paused and the mutation id on both states", () => {
  const out = pendingBranchPushesFor(
    [entry(renameVars, { mutationId: 9, paused: true })],
    "/repo",
  );
  assert.deepEqual(out, [
    renameState("old", { paused: true }),
    renameState("new", { paused: true }),
  ]);
});

test("a sibling checkout's remote rename is foreign by identity", () => {
  const entries = [
    { key: branchPushKey("/wt", ID), vars: renameVars, mutationId: 9 },
  ];
  assert.deepEqual(pendingBranchPushesFor(entries, "/main", ID), [
    renameState("old", { foreign: true }),
    renameState("new", { foreign: true }),
  ]);
  assert.deepEqual(pendingBranchPushesFor(entries, "/main"), []);
  assert.deepEqual(pendingBranchPushesFor(entries, "/main", "/nobody"), []);
});

test("a rename missing or mistyping a name or its remote reads as today's push", () => {
  const malformed = [
    { oldName: "old", newName: "new" },
    { oldName: "old", newName: 3, remote: "origin" },
    { oldName: null, newName: "new", remote: "origin" },
    { newName: "new", remote: "origin" },
  ];
  const out = pendingBranchPushesFor(
    malformed.map((v) => entry(v)),
    "/repo",
  );
  assert.equal(out.length, 4);
  for (const [i, p] of out.entries()) {
    assert.equal(p.renaming, false, `row ${i}`);
    assert.equal(p.branch, null, `row ${i}`);
    assert.equal(p.remoteBranch, null, `row ${i}`);
  }
  // A remote field still reads as the push's remote, as for any push.
  assert.equal(out[1].remote, "origin");
});

test("a real push still reads renaming false", () => {
  const [out] = pendingBranchPushesFor(
    [entry({ setUpstream: true, branch: "new", remote: "origin" })],
    "/repo",
  );
  assert.equal(out.renaming, false);
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

// One repository checked out twice (/main, /wt; identity /id), plus /other: a
// different repository with a same-named branch.
const ID = "/id";
const twoCheckouts = [
  {
    key: branchPushKey("/main", ID),
    vars: { setUpstream: false, branch: "a" },
  },
  { key: branchPushKey("/wt", ID), vars: { setUpstream: false, branch: "b" } },
  { key: branchPushKey("/wt"), vars: { setUpstream: false, branch: "c" } },
  {
    key: branchPushKey("/other", "/other-id"),
    vars: { setUpstream: false, branch: "a" },
  },
];
const readBack = (repo, identity) =>
  pendingBranchPushesFor(twoCheckouts, repo, identity).map((p) => [
    p.branch,
    p.foreign,
  ]);

test("identity: own pushes read back unmarked, a sibling's marked foreign", () => {
  assert.deepEqual(readBack("/main", ID), [
    ["a", false],
    ["b", true],
  ]);
  // A push filed before its checkout's identity resolved (c) is path-only.
  assert.deepEqual(readBack("/wt", ID), [
    ["a", true],
    ["b", false],
    ["c", false],
  ]);
});

test("identity: omitted or unknown, only the checkout's own path matches", () => {
  assert.deepEqual(readBack("/main"), [["a", false]]);
  assert.deepEqual(readBack("/main", undefined), [["a", false]]);
  // An absent identity never matches an absent one.
  assert.deepEqual(readBack("/fresh"), []);
  assert.deepEqual(readBack("/fresh", "/nobody"), []);
});

test("identity: hostile key segments and variables match nothing they shouldn't", () => {
  const out = pendingBranchPushesFor(
    [
      { key: ["branch-push", "/x", ID], vars: "a" },
      { key: ["branch-push", "/x", ID], vars: null },
      { key: ["branch-push", "/x", { id: ID }], vars: { branch: "a" } },
      { key: ["tag-push", "/x", ID], vars: { branch: "a" } },
      {
        key: ["branch-push", "/x", ID],
        vars: { branch: "constructor", startedOn: 4 },
      },
    ],
    "/main",
    ID,
  );
  assert.deepEqual(
    out.map((p) => [p.branch, p.startedOn, p.foreign]),
    [["constructor", null, true]],
  );
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
        {
          setUpstream: "yes",
          branch: 3,
          remote: {},
          remoteBranch: [],
          startedOn: 4,
          creates: "yes",
        },
        { mutationId: undefined, paused: "true" },
      ),
    ],
    "/repo",
  );
  assert.deepEqual(out, {
    mutationId: null,
    branch: null,
    startedOn: null,
    remote: null,
    remoteBranch: null,
    setUpstream: false,
    paused: false,
    fromHeader: false,
    foreign: false,
    creates: false,
    renaming: false,
  });
});

test("creates reads back true only for a literal true", () => {
  const out = pendingBranchPushesFor(
    [
      entry({ setUpstream: false, creates: true }),
      entry({ setUpstream: false, creates: false }),
      entry({ setUpstream: false, creates: 1 }),
      entry({ setUpstream: false, creates: "true" }),
      entry({ setUpstream: false }),
    ],
    "/repo",
  );
  assert.deepEqual(
    out.map((p) => p.creates),
    [true, false, false, false, false],
  );
});

test("a HEAD push (no branch) keeps a null branch for the latch to resolve", () => {
  const [out] = pendingBranchPushesFor(
    [entry({ setUpstream: false, source: "header" }, { mutationId: 9 })],
    "/repo",
  );
  assert.equal(out.branch, null);
  assert.equal(out.mutationId, 9);
  assert.equal(out.startedOn, null);
});

test("a HEAD push's recorded start reads back", () => {
  const [out] = pendingBranchPushesFor(
    [entry({ setUpstream: false, source: "header", startedOn: "main" })],
    "/repo",
  );
  assert.equal(out.branch, null);
  assert.equal(out.startedOn, "main");
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

test("label: a remote rename names its remote ahead of every other arm", () => {
  const gone = { upstream: "origin/old", upstreamGone: true };
  for (const row of [tracked, gone, { upstream: null, upstreamGone: false }])
    for (const target of [null, { remote: "fork", branch: "x" }])
      for (const branch of ["old", "new"])
        assert.equal(
          branchPushLabel(renameState(branch), row, target),
          "Renaming on origin",
        );
  const [read] = pendingBranchPushesFor(
    [entry({ ...renameVars, remote: "upstream" })],
    "/repo",
  );
  assert.equal(branchPushLabel(read, tracked, null), "Renaming on upstream");
  // The same destination without the rename mark keeps the push's label.
  assert.equal(
    branchPushLabel(renameState("new", { renaming: false }), tracked, null),
    "Pushing to origin/new",
  );
});

test("label: cross-name beats creates, setUpstream, untracked and tracked", () => {
  const p = push({
    remote: "fork",
    remoteBranch: "pr-head",
    setUpstream: true,
    creates: true,
  });
  assert.equal(branchPushLabel(p, tracked, null), "Pushing to fork/pr-head");
  assert.equal(
    branchPushLabel(p, { upstream: null, upstreamGone: false }, null),
    "Pushing to fork/pr-head",
  );
});

test("label: a cross-name entry without a remote falls through, never null/x", () => {
  const p = push({ remote: null, remoteBranch: "pr-head" });
  assert.equal(branchPushLabel(p, tracked, null), "Pushing to origin/feature");
  assert.equal(
    branchPushLabel(p, { upstream: null, upstreamGone: false }, null),
    "Pushing",
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
  assert.equal(
    branchPushLabel(read, tracked, null),
    "Pushing to origin/feature",
  );
});

test("label: a recorded create publishes, whatever the row", () => {
  for (const row of [
    tracked,
    { upstream: null, upstreamGone: false },
    { upstream: "origin/feature", upstreamGone: true },
  ]) {
    assert.equal(
      branchPushLabel(push({ creates: true, remote: "origin" }), row, null),
      "Publishing to origin",
    );
    assert.equal(
      branchPushLabel(
        push({ creates: true, branch: null, remote: "fork" }),
        row,
        null,
      ),
      "Publishing to fork",
    );
  }
});

test("label: creates with no remote says Publishing branch", () => {
  assert.equal(
    branchPushLabel(push({ creates: true }), tracked, null),
    "Publishing branch",
  );
  assert.equal(
    branchPushLabel(
      push({ creates: true, setUpstream: true, branch: null }),
      {
        upstream: null,
        upstreamGone: false,
      },
      null,
    ),
    "Publishing branch",
  );
  assert.equal(branchPublishLabel(null), "Publishing branch");
  assert.equal(branchPublishLabel("fork"), "Publishing to fork");
});

test("label: setUpstream without creates never says Publishing", () => {
  // An update-and-track: the remote already has the branch.
  assert.equal(
    branchPushLabel(
      push({ setUpstream: true, remote: "origin" }),
      tracked,
      null,
    ),
    "Pushing to origin",
  );
  assert.equal(
    branchPushLabel(
      push({ setUpstream: true, remote: "origin" }),
      {
        upstream: null,
        upstreamGone: false,
      },
      null,
    ),
    "Pushing to origin",
  );
  assert.equal(
    branchPushLabel(push({ setUpstream: true }), tracked, null),
    "Pushing",
  );
});

test("label: an untracked or upstream-gone row without creates pushes to the remote", () => {
  assert.equal(
    branchPushLabel(
      push({ remote: "upstream" }),
      {
        upstream: null,
        upstreamGone: false,
      },
      null,
    ),
    "Pushing to upstream",
  );
  assert.equal(
    branchPushLabel(
      push({ remote: "origin" }),
      {
        upstream: "origin/feature",
        upstreamGone: true,
      },
      null,
    ),
    "Pushing to origin",
  );
  // No remote and no live upstream: no destination is assumed.
  assert.equal(
    branchPushLabel(push(), { upstream: null, upstreamGone: false }, null),
    "Pushing",
  );
});

test("label: a tracked row names its upstream", () => {
  assert.equal(
    branchPushLabel(push(), tracked, null),
    "Pushing to origin/feature",
  );
  // The push's own remote never overrides the row's upstream on this arm.
  assert.equal(
    branchPushLabel(push({ remote: "other" }), tracked, null),
    "Pushing to origin/feature",
  );
});

test("label: a push to the row's routed destination names it", () => {
  const fork = { remote: "fork", branch: "feature" };
  // Named or unnamed remote that matches: the routed destination.
  assert.equal(
    branchPushLabel(push(), tracked, fork),
    "Pushing to fork/feature",
  );
  assert.equal(
    branchPushLabel(push({ remote: "fork" }), tracked, fork),
    "Pushing to fork/feature",
  );
  // A push naming another remote, a retrack or a HEAD push: not this arm.
  assert.equal(
    branchPushLabel(push({ remote: "origin" }), tracked, fork),
    "Pushing to origin/feature",
  );
  assert.equal(
    branchPushLabel(push({ setUpstream: true, remote: "fork" }), tracked, fork),
    "Pushing to fork",
  );
  assert.equal(
    branchPushLabel(push({ branch: null }), tracked, fork),
    "Pushing",
  );
  // Earlier arms still win: cross-name and a recorded create.
  assert.equal(
    branchPushLabel(
      push({ remote: "fork", remoteBranch: "pr-head" }),
      tracked,
      fork,
    ),
    "Pushing to fork/pr-head",
  );
  assert.equal(
    branchPushLabel(push({ creates: true, remote: "fork" }), tracked, fork),
    "Publishing to fork",
  );
  // No target keeps the upstream arm.
  assert.equal(
    branchPushLabel(push(), tracked, null),
    "Pushing to origin/feature",
  );
});

test("label: a HEAD push without creates names no destination", () => {
  // A bare `git push` follows pushRemote / pushDefault / push.default, so the
  // row's upstream may not be where it lands.
  assert.equal(
    branchPushLabel(push({ branch: null }), tracked, null),
    "Pushing",
  );
  assert.equal(
    branchPushLabel(push({ branch: null, setUpstream: true }), tracked, null),
    "Pushing",
  );
  assert.equal(
    branchPushLabel(
      push({ branch: null, remote: "origin" }),
      {
        upstream: null,
        upstreamGone: false,
      },
      null,
    ),
    "Pushing",
  );
});

test("preparing label: names the detection's remote, or none", () => {
  assert.equal(branchPreparingLabel("origin"), "Preparing to push to origin");
  assert.equal(branchPreparingLabel(null), "Preparing to push");
});

test("label partition: Publishing exactly for a recorded create that isn't cross-name", () => {
  const rows = [
    tracked,
    { upstream: null, upstreamGone: false },
    { upstream: "origin/feature", upstreamGone: true },
  ];
  let cases = 0;
  for (const remote of ["fork", null])
    for (const remoteBranch of ["pr-head", null])
      for (const creates of [true, false])
        for (const branch of ["feature", null])
          for (const setUpstream of [true, false])
            for (const row of rows) {
              cases++;
              const p = push({
                remote,
                remoteBranch,
                creates,
                branch,
                setUpstream,
              });
              const label = branchPushLabel(p, row, null);
              const crossName = remote !== null && remoteBranch !== null;
              const at = JSON.stringify({ p, row, label });
              assert.equal(
                label.startsWith("Publishing"),
                creates && !crossName,
                at,
              );
              assert.ok(!label.startsWith("Preparing"), at);
              if (!(creates && !crossName))
                assert.ok(label.startsWith("Pushing"), at);
            }
  assert.equal(cases, 96);
});

test("hold reasons: a parked push is waiting, never a write the control sends", () => {
  assert.equal(branchPushHoldReason(false), "A push is running.");
  assert.equal(
    branchPushHoldReason(true),
    "A push is waiting for the connection.",
  );
  assert.equal(branchPushHoldItemReason(false), "a push is running");
  assert.equal(
    branchPushHoldItemReason(true),
    "a push is waiting for the connection",
  );
});

// A HEAD push as the latch reads it: no branch, a cache id.
const headPush = (mutationId) => push({ branch: null, mutationId });

test("latch: a HEAD push latches to the current branch", () => {
  assert.deepEqual(nextPushLatch({}, [headPush(4)], [4], "main"), {
    4: "main",
  });
});

test("latch: named pushes and id-less entries are ignored", () => {
  assert.equal(
    nextPushLatch({}, [push({ mutationId: 4 }), headPush(null)], [4], "main"),
    null,
  );
});

test("latch: a second call over the same reads changes nothing", () => {
  const once = nextPushLatch({}, [headPush(4)], [4], "main");
  assert.equal(nextPushLatch(once, [headPush(4)], [4], "main"), null);
  // A later checkout never re-latches a push already latched.
  assert.equal(nextPushLatch(once, [headPush(4)], [4], "feature"), null);
});

test("latch: an id still pending in another repo is kept", () => {
  // This repo's snapshot no longer holds it (a switch away), every repo's does.
  assert.equal(nextPushLatch({ 4: "main" }, [], [4], "other"), null);
});

test("latch: a settled id is pruned, and a new one latches beside the rest", () => {
  assert.deepEqual(nextPushLatch({ 4: "main", 5: "dev" }, [], [5], "x"), {
    5: "dev",
  });
  assert.deepEqual(
    nextPushLatch({ 4: "main" }, [headPush(6)], [6], "feature"),
    { 6: "feature" },
  );
});

test("latch: a null current branch latches nothing, but still prunes", () => {
  assert.equal(nextPushLatch({}, [headPush(4)], [4], null), null);
  assert.deepEqual(nextPushLatch({ 4: "main" }, [headPush(6)], [6], null), {});
});

test("latch: an id not pending in any repo is never latched", () => {
  // A snapshot that tore ahead of the id list must not latch what the prune drops.
  assert.equal(nextPushLatch({}, [headPush(4)], [], "main"), null);
});

test("latch: a recorded start beats the current branch, even an unknown one", () => {
  const started = push({ branch: null, mutationId: 4, startedOn: "main" });
  assert.deepEqual(nextPushLatch({}, [started], [4], "feature"), { 4: "main" });
  assert.deepEqual(nextPushLatch({}, [started], [4], null), { 4: "main" });
});

// The delayed list re-read. The stub client records each invalidation's filter;
// a filter's predicate is replayed over query keys to see what it covers. Each
// test uses its own repo: the pending map is module state.
const spyClient = () => {
  const calls = [];
  return { calls, invalidateQueries: (filter) => calls.push(filter) };
};
const covers = (filter, queryKey) => filter.predicate({ queryKey });

test("list re-read: the delay is 8 s", () => {
  assert.equal(LIST_RECHECK_MS, 8000);
});

test("list re-read: two arms in one window fire ONE invalidation over the union", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const qc = spyClient();
  const repo = "/union";
  // A remote-branch delete's unlensed prefixes, then a merge's lensed keys
  // (overlapping) and an issue close's list (disjoint).
  recheckListsLater(qc, repo, [
    ["repo", repo, "pr-list"],
    ["repo", repo, "pr-review-state"],
  ]);
  recheckListsLater(qc, repo, [
    ["repo", repo, "pr-list", "origin"],
    ["repo", repo, "prs", "origin"],
    ["repo", repo, "issue-list", "origin"],
  ]);
  t.mock.timers.tick(LIST_RECHECK_MS);
  assert.equal(qc.calls.length, 1);
  const [f] = qc.calls;
  for (const key of [
    ["repo", repo, "pr-list", "upstream", "open", 30, null],
    ["repo", repo, "pr-list", "origin", "closed", 30, null],
    ["repo", repo, "pr-review-state", "origin", "digest"],
    ["repo", repo, "prs", "origin", "feature"],
    ["repo", repo, "issue-list", "origin", "open", 30, null],
  ])
    assert.equal(covers(f, key), true, JSON.stringify(key));
  for (const key of [
    ["repo", repo, "prs", "upstream", "feature"],
    ["repo", repo, "issue-list", "upstream", "open", 30, null],
    ["repo", repo, "pr-ci", "origin"],
    ["repo", "/other", "pr-list", "origin"],
    ["repo", repo],
  ])
    assert.equal(covers(f, key), false, JSON.stringify(key));
});

test("list re-read: a later arm re-arms the one timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const qc = spyClient();
  const repo = "/rearm";
  recheckListsLater(qc, repo, [["repo", repo, "pr-list"]]);
  t.mock.timers.tick(7_000);
  recheckListsLater(qc, repo, [["repo", repo, "issue-list"]]);
  t.mock.timers.tick(7_000);
  assert.equal(qc.calls.length, 0);
  t.mock.timers.tick(1_000);
  assert.equal(qc.calls.length, 1);
  assert.equal(covers(qc.calls[0], ["repo", repo, "pr-list", "origin"]), true);
  assert.equal(covers(qc.calls[0], ["repo", repo, "issue-list", "x"]), true);
});

test("list re-read: a fire drops the entry, so the next arm owes only its own keys", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const qc = spyClient();
  const repo = "/fresh";
  recheckListsLater(qc, repo, [["repo", repo, "pr-list"]]);
  t.mock.timers.tick(LIST_RECHECK_MS);
  recheckListsLater(qc, repo, [["repo", repo, "issue-list"]]);
  t.mock.timers.tick(LIST_RECHECK_MS);
  assert.equal(qc.calls.length, 2);
  assert.equal(covers(qc.calls[1], ["repo", repo, "pr-list", "origin"]), false);
  assert.equal(
    covers(qc.calls[1], ["repo", repo, "issue-list", "origin"]),
    true,
  );
  t.mock.timers.tick(60_000);
  assert.equal(qc.calls.length, 2);
});

test("list re-read: another repo's arm keeps its own timer and keys", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const qc = spyClient();
  recheckListsLater(qc, "/a", [["repo", "/a", "pr-list"]]);
  t.mock.timers.tick(4_000);
  recheckListsLater(qc, "/b", [["repo", "/b", "pr-list"]]);
  t.mock.timers.tick(4_000);
  assert.equal(qc.calls.length, 1);
  assert.equal(covers(qc.calls[0], ["repo", "/a", "pr-list", "origin"]), true);
  assert.equal(covers(qc.calls[0], ["repo", "/b", "pr-list", "origin"]), false);
  t.mock.timers.tick(4_000);
  assert.equal(qc.calls.length, 2);
  assert.equal(covers(qc.calls[1], ["repo", "/b", "pr-list", "origin"]), true);
});
