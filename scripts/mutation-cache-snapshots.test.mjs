// Pins the pure projections behind the cache-scan pending-write holds (PR writes,
// review-thread writes, discussion upvotes, board writes): which pending mutations
// a view holds on, and what it reads off each. A wrong answer here never errors —
// a hold silently drops, or crosses into another repo or PR — so each matching
// rule is a case, over fake mutation objects shaped like query-core's.
//
// The imports reach straight into `src/` and rely on Node's default type stripping
// (>= 23.6), which resolves no bundler aliases: both modules may import types only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pendingBoardWritesFor,
  pendingItemWriteFor,
  pendingProjectWritesFor,
  statusWriteKind,
} from "../src/lib/git/queries/board-writes.ts";
import {
  forkByNameKey,
  isPendingFor,
  pendingDiscussionUpvoteFor,
  pendingForkFor,
  pendingLabelEditFor,
  pendingMutationEntries,
  pendingTagPushesFor,
  pendingThreadWritesFor,
  pendingWritesFor,
  prWriteKey,
  readPendingPrWrite,
  tagPushKey,
} from "../src/lib/git/queries/pr-writes.ts";
import {
  NO_PENDING_RUN_WRITES,
  pendingJobState,
  pendingRunState,
  pendingRunWritesFor,
  rerunFamilyState,
} from "../src/lib/git/queries/run-writes.ts";

/** A fake cache mutation: what `MutationCache.findAll` hands a snapshot. */
const mutation = (mutationId, mutationKey, variables, isPaused = false) => ({
  mutationId,
  options: { mutationKey },
  state: { variables, isPaused },
});

test("a cache mutation projects to an entry carrying its id, key, vars and pause", () => {
  assert.deepEqual(
    pendingMutationEntries([
      mutation(4, ["pr-write", "merge", "C:/a"], 7, true),
      mutation(9, undefined, undefined),
    ]),
    [
      {
        mutationId: 4,
        key: ["pr-write", "merge", "C:/a"],
        vars: 7,
        paused: true,
      },
      { mutationId: 9, key: undefined, vars: undefined, paused: false },
    ],
  );
});

test("PR writes match their repo by KEY segment, never by variables", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["pr-write", "merge", "C:/a"], { number: 3, repo: "C:/b" }),
    mutation(2, ["pr-write", "merge", "C:/b"], { number: 3, repo: "C:/a" }),
  ]);
  const writes = pendingWritesFor(entries, "C:/a", readPendingPrWrite);
  assert.deepEqual(
    writes.map((w) => w.target),
    [3],
  );
  assert.equal(writes.length, 1);
});

test("board writes match their repo by VARIABLES and pass the mutation id through", () => {
  const entries = pendingMutationEntries([
    // The key carries no repo by design; the variables are the source of truth.
    mutation(11, ["board-write", "convert"], { repo: "C:/a", itemId: "I_1" }),
    mutation(12, ["board-write", "bulk-move"], {
      repo: "C:/a",
      itemIds: ["I_2", "I_3"],
    }),
    mutation(13, ["board-write", "convert"], { repo: "C:/b", itemId: "I_9" }),
    // An unknown key shape degrades to a null kind but still counts.
    mutation(14, ["board-write"], { repo: "C:/a", number: 42 }, true),
  ]);
  assert.deepEqual(pendingBoardWritesFor(entries, "C:/a"), [
    {
      mutationId: 11,
      kind: "convert",
      itemId: "I_1",
      number: null,
      count: null,
      isPaused: false,
    },
    {
      mutationId: 12,
      kind: "bulk-move",
      itemId: null,
      number: null,
      count: 2,
      isPaused: false,
    },
    {
      mutationId: 14,
      kind: null,
      itemId: null,
      number: 42,
      count: null,
      isPaused: true,
    },
  ]);
});

test("project and view writes run side by side, each with its own pause", () => {
  const projects = pendingMutationEntries([
    mutation(
      21,
      ["project-write", "update"],
      { repo: "C:/a", projectId: "P_1", patch: { closed: true } },
      true,
    ),
  ]);
  const views = pendingMutationEntries([
    mutation(22, ["project-view-write", "duplicate"], {
      repo: "C:/a",
      projectId: "P_1",
    }),
  ]);
  assert.deepEqual(pendingProjectWritesFor(projects, views, "C:/a", "P_1"), [
    { mutationId: 21, kind: "project-close", isPaused: true },
    { mutationId: 22, kind: "view-duplicate", isPaused: false },
  ]);
});

test("writes match the repo AND the named project; a create matches the repo alone", () => {
  const projects = pendingMutationEntries([
    mutation(31, ["project-write", "delete"], {
      repo: "C:/a",
      projectId: "P_1",
    }),
    // Same repo, the other project: dropped once a project is named.
    mutation(35, ["project-write", "update"], {
      repo: "C:/a",
      projectId: "P_2",
      patch: { closed: true },
    }),
    // A create names no project yet, so it shows whichever board is up.
    mutation(36, ["project-write", "create"], { repo: "C:/a", title: "New" }),
    mutation(32, ["project-write", "create"], { repo: "C:/b" }),
  ]);
  const views = pendingMutationEntries([
    mutation(33, ["project-view-write", "update"], {
      repo: "C:/a",
      projectId: "P_1",
      patch: { layout: "board" },
    }),
    // Same repo, the other project: dropped once a project is named.
    mutation(34, ["project-view-write", "update"], {
      repo: "C:/a",
      projectId: "P_2",
      patch: { name: "Triage" },
    }),
  ]);
  assert.deepEqual(
    pendingProjectWritesFor(projects, views, "C:/a", "P_1").map((w) => [
      w.mutationId,
      w.kind,
    ]),
    [
      [31, "project-delete"],
      [36, "project-create"],
      [33, "view-layout"],
    ],
  );
  // Unnamed, every write in the repo counts.
  assert.deepEqual(
    pendingProjectWritesFor(projects, views, "C:/a", null).map((w) => w.kind),
    [
      "project-delete",
      "project-close",
      "project-create",
      "view-layout",
      "view-rename",
    ],
  );
});

test("a parked create in one repo stays pending there after another repo's create", () => {
  // The panel's observer would describe only the LATER (repo B) call; the cache
  // read keeps repo A's parked create, under A's open project too.
  const projects = pendingMutationEntries([
    mutation(
      61,
      ["project-write", "create"],
      { repo: "C:/a", title: "A" },
      true,
    ),
    mutation(62, ["project-write", "create"], { repo: "C:/b", title: "B" }),
  ]);
  assert.deepEqual(pendingProjectWritesFor(projects, [], "C:/a", "P_1"), [
    { mutationId: 61, kind: "project-create", isPaused: true },
  ]);
  assert.deepEqual(pendingProjectWritesFor(projects, [], "C:/b", null), [
    { mutationId: 62, kind: "project-create", isPaused: false },
  ]);
});

test("an update's patch names its verb; an unreadable one stays generic", () => {
  const projects = pendingMutationEntries([
    mutation(41, ["project-write", "update"], {
      repo: "C:/a",
      patch: { closed: false },
    }),
    mutation(42, ["project-write", "update"], {
      repo: "C:/a",
      patch: { title: "Roadmap" },
    }),
    mutation(43, ["project-write"], { repo: "C:/a" }),
  ]);
  const views = pendingMutationEntries([
    mutation(44, ["project-view-write", "update"], {
      repo: "C:/a",
      projectId: "P_1",
      patch: { visibleFieldIds: ["F_1"] },
    }),
    mutation(45, ["project-view-write", "update"], {
      repo: "C:/a",
      projectId: "P_1",
      patch: "garbage",
    }),
  ]);
  assert.deepEqual(
    pendingProjectWritesFor(projects, views, "C:/a", "P_1").map((w) => w.kind),
    ["project-reopen", "project-edit", null, "view-fields", "view-edit"],
  );
});

test("a rail write holds its own item, and reads parked only when all are", () => {
  const target = { repo: "C:/a", lens: "origin", kind: "issue", number: 7 };
  const entries = pendingMutationEntries([
    mutation(
      51,
      ["project-item-fields"],
      { ...target, projectId: "P_1" },
      true,
    ),
    // Another item, lens, kind or repo never holds this one.
    mutation(52, ["project-item-fields"], { ...target, number: 8 }),
    mutation(53, ["project-item-fields"], { ...target, lens: "upstream" }),
    mutation(54, ["project-item-fields"], { ...target, kind: "pr" }),
    mutation(55, ["project-item-fields"], { ...target, repo: "C:/b" }),
  ]);
  assert.deepEqual(pendingItemWriteFor(entries, target), {
    pending: true,
    paused: true,
  });
  const running = pendingMutationEntries([
    mutation(56, ["project-item-fields"], target, true),
    mutation(57, ["project-item-fields"], target, false),
  ]);
  assert.deepEqual(pendingItemWriteFor(running, target), {
    pending: true,
    paused: false,
  });
  assert.deepEqual(pendingItemWriteFor([], target), {
    pending: false,
    paused: false,
  });
});

test("thread writes read both keys, filter by number AND lens, and OR the pauses", () => {
  const vars = (number, lens, threadId) => ({ number, lens, threadId });
  const entries = pendingMutationEntries([
    mutation(1, ["thread-reply", "C:/a"], vars(5, "origin", "T1")),
    mutation(2, ["thread-reply", "C:/a"], vars(5, "origin", "T1"), true),
    mutation(3, ["thread-resolve", "C:/a"], vars(5, "origin", "T2")),
    // Other PR, other lens, other repo, unknown kind: none of them hold.
    mutation(4, ["thread-reply", "C:/a"], vars(6, "origin", "T3")),
    mutation(5, ["thread-reply", "C:/a"], vars(5, "upstream", "T4")),
    mutation(6, ["thread-resolve", "C:/b"], vars(5, "origin", "T5")),
    mutation(7, ["thread-edit", "C:/a"], vars(5, "origin", "T6")),
  ]);
  assert.deepEqual(pendingThreadWritesFor(entries, "C:/a", 5, "origin"), {
    reply: { T1: { paused: true } },
    resolve: { T2: { paused: false } },
  });
  assert.deepEqual(pendingThreadWritesFor([], "C:/a", 5, "origin"), {
    reply: {},
    resolve: {},
  });
  // A key prefix that names an Object.prototype member is just an unknown kind.
  for (const prefix of ["constructor", "__proto__", "toString"])
    assert.deepEqual(
      pendingThreadWritesFor(
        pendingMutationEntries([
          mutation(8, [prefix, "C:/a"], vars(5, "origin", "T7")),
        ]),
        "C:/a",
        5,
        "origin",
      ),
      { reply: {}, resolve: {} },
      prefix,
    );
});

test("a discussion upvote holds its own discussion in its own repo", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["toggle-discussion-upvote", "C:/a"], { number: 8 }),
    mutation(2, ["toggle-discussion-upvote", "C:/a"], { number: 8 }, true),
    mutation(3, ["toggle-discussion-upvote", "C:/a"], { number: 9 }, true),
    mutation(4, ["toggle-discussion-upvote", "C:/b"], { number: 8 }, true),
  ]);
  // One running toggle beside a parked one reads as in flight: parked means ALL.
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/a", 8), {
    pending: true,
    paused: false,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/a", 9), {
    pending: true,
    paused: true,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries.slice(0, 1), "C:/a", 8), {
    pending: true,
    paused: false,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/a", 10), {
    pending: false,
    paused: false,
  });
  assert.deepEqual(pendingDiscussionUpvoteFor(entries, "C:/c", 8), {
    pending: false,
    paused: false,
  });
});

test("run writes fold per run and per job, matching ids across number and string", () => {
  const entries = pendingMutationEntries([
    // The run view cancels by number; a parked twin from the menu leaves it
    // running (the wave's rule: parked only when every write is).
    mutation(1, ["ci-run-write", "cancel-run", "C:/a"], 101),
    mutation(2, ["ci-run-write", "cancel-run", "C:/a"], 101, true),
    // Two parked cancels of one run: parked.
    mutation(7, ["ci-run-write", "cancel-run", "C:/a"], 303, true),
    mutation(8, ["ci-run-write", "cancel-run", "C:/a"], "303", true),
    // The PR checks re-run by string id, the run view by number: one run.
    mutation(3, ["ci-run-write", "rerun-run", "C:/a"], {
      runId: "202",
      failed: true,
    }),
    mutation(4, ["ci-run-write", "rerun-run", "C:/a"], {
      runId: 202,
      failed: false,
    }),
    // One run under two kinds: its own cancel AND a re-run of one of its jobs.
    mutation(5, ["ci-run-write", "rerun-job", "C:/a"], {
      jobId: "J1",
      runId: 101,
    }),
    mutation(6, ["ci-run-write", "play-job", "C:/a"], "J2", true),
  ]);
  const writes = pendingRunWritesFor(entries, "C:/a");
  assert.deepEqual(writes, {
    runs: [
      { runId: "101", cancel: { paused: false }, jobRerun: { paused: false } },
      { runId: "303", cancel: { paused: true } },
      { runId: "202", rerun: { paused: false, failed: true, whole: true } },
    ],
    jobs: [
      { jobId: "J1", rerun: { paused: false } },
      { jobId: "J2", play: { paused: true } },
    ],
  });
  assert.equal(pendingRunState(writes, 202), pendingRunState(writes, "202"));
  assert.notEqual(pendingRunState(writes, 202), undefined);
  assert.equal(pendingRunState(writes, 404), undefined);
  assert.deepEqual(pendingJobState(writes, "J2"), {
    jobId: "J2",
    play: { paused: true },
  });
  assert.equal(pendingJobState(writes, "J3"), undefined);
});

test("run writes stay in their repo and their kind", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["ci-run-write", "cancel-run", "C:/b"], 101),
    // A dispatch targets no run, and an unknown kind holds nothing.
    mutation(2, ["ci-run-write", "dispatch", "C:/a"], {
      workflow: "9",
      gitRef: "main",
      inputs: {},
    }),
    mutation(3, ["ci-run-write", "approve-workflow", "C:/a"], { runId: 101 }),
    // Another family's key with a run-shaped variable is no run write.
    mutation(4, ["pr-write", "cancel-run", "C:/a"], 101),
    mutation(8, ["pr-write", "approve-run", "C:/a"], { runId: 101 }),
    // Unreadable ids hold nothing.
    mutation(5, ["ci-run-write", "cancel-run", "C:/a"], ""),
    mutation(6, ["ci-run-write", "rerun-run", "C:/a"], { failed: true }),
    mutation(7, ["ci-run-write", "cancel-run", "C:/a"], Number.NaN),
  ]);
  assert.deepEqual(pendingRunWritesFor(entries, "C:/a"), NO_PENDING_RUN_WRITES);
  const other = pendingRunWritesFor(entries, "C:/b");
  assert.deepEqual(other, {
    runs: [{ runId: "101", cancel: { paused: false } }],
    jobs: [],
  });
  // A cancel never stands in for a re-run.
  assert.equal(rerunFamilyState(pendingRunState(other, 101)), undefined);
  // Ids named like Object.prototype members are plain ids.
  assert.equal(pendingRunState(other, "constructor"), undefined);
});

test("an approval holds its own run, beside the run's other writes, parked only when all are", () => {
  const entries = pendingMutationEntries([
    // The run view approves by number, the PR checks pass a lens too.
    mutation(1, ["ci-run-write", "approve-run", "C:/a"], { runId: 7 }),
    mutation(
      2,
      ["ci-run-write", "approve-run", "C:/a"],
      { runId: 7, lens: "upstream" },
      true,
    ),
    mutation(3, ["ci-run-write", "cancel-run", "C:/a"], 7),
    mutation(4, ["ci-run-write", "approve-run", "C:/a"], { runId: 8 }),
    // Two parked approvals of one run: parked.
    mutation(7, ["ci-run-write", "approve-run", "C:/a"], { runId: 10 }, true),
    mutation(8, ["ci-run-write", "approve-run", "C:/a"], { runId: 10 }, true),
    // Other repo; an approval with no readable run id.
    mutation(5, ["ci-run-write", "approve-run", "C:/b"], { runId: 9 }),
    mutation(6, ["ci-run-write", "approve-run", "C:/a"], { lens: "origin" }),
  ]);
  const writes = pendingRunWritesFor(entries, "C:/a");
  assert.deepEqual(writes, {
    runs: [
      // One running approval beside a parked twin keeps the run in flight.
      { runId: "7", approve: { paused: false }, cancel: { paused: false } },
      { runId: "8", approve: { paused: false } },
      { runId: "10", approve: { paused: true } },
    ],
    jobs: [],
  });
  assert.deepEqual(pendingRunState(writes, "10")?.approve, { paused: true });
  // An approval is not a re-run.
  assert.equal(rerunFamilyState(pendingRunState(writes, 8)), undefined);
  assert.equal(pendingRunState(writes, 9), undefined);
});

test("a run's re-run family is its own re-run or a job re-run, parked only when both are", () => {
  const entries = pendingMutationEntries([
    mutation(1, ["ci-run-write", "rerun-run", "C:/a"], {
      runId: 1,
      failed: false,
    }),
    mutation(2, ["ci-run-write", "rerun-job", "C:/a"], {
      jobId: "J9",
      runId: "1",
    }),
    mutation(
      3,
      ["ci-run-write", "rerun-job", "C:/a"],
      { jobId: "J8", runId: 2, lens: "origin" },
      true,
    ),
    mutation(
      4,
      ["ci-run-write", "rerun-run", "C:/a"],
      { runId: 2, failed: true },
      true,
    ),
    // A parked run re-run beside a running job re-run: still in flight.
    mutation(
      5,
      ["ci-run-write", "rerun-run", "C:/a"],
      { runId: 3, failed: true },
      true,
    ),
    mutation(6, ["ci-run-write", "rerun-job", "C:/a"], {
      jobId: "J7",
      runId: 3,
    }),
  ]);
  const writes = pendingRunWritesFor(entries, "C:/a");
  assert.deepEqual(rerunFamilyState(pendingRunState(writes, 1)), {
    paused: false,
  });
  assert.deepEqual(rerunFamilyState(pendingRunState(writes, "2")), {
    paused: true,
  });
  assert.deepEqual(rerunFamilyState(pendingRunState(writes, 3)), {
    paused: false,
  });
  assert.deepEqual(pendingRunState(writes, 2)?.rerun, {
    paused: true,
    failed: true,
    whole: false,
  });
  assert.equal(rerunFamilyState(undefined), undefined);
});

/** A label edit's variables, as the picker fires them. */
const labelVars = (kind, number) => ({
  kind,
  number,
  labelableId: `L_${number}`,
  addIds: [],
  removeIds: [],
});

test("a label edit holds its own entity: repo by KEY, kind and number by variables", () => {
  const entries = pendingMutationEntries([
    mutation(41, prWriteKey("labels", "C:/a"), labelVars("mr", 3), true),
    mutation(42, prWriteKey("labels", "C:/a"), labelVars("mr", 4)),
    mutation(43, prWriteKey("labels", "C:/b"), labelVars("mr", 5)),
    mutation(44, prWriteKey("labels", "C:/a"), labelVars("issue", 6)),
    // Another PR write at the same number is not a label edit.
    mutation(45, prWriteKey("merge", "C:/a"), { number: 7 }),
  ]);
  assert.deepEqual(pendingLabelEditFor(entries, "C:/a", "mr", 3), {
    pending: true,
    paused: true,
  });
  assert.deepEqual(pendingLabelEditFor(entries, "C:/a", "mr", 4), {
    pending: true,
    paused: false,
  });
  // Repo scoping: PR 5's edit was filed against another repo.
  assert.deepEqual(pendingLabelEditFor(entries, "C:/a", "mr", 5), {
    pending: false,
    paused: false,
  });
  // The surface is part of the identity: issue 6 holds no PR 6, and vice versa.
  assert.equal(pendingLabelEditFor(entries, "C:/a", "mr", 6).pending, false);
  assert.equal(pendingLabelEditFor(entries, "C:/a", "issue", 6).pending, true);
  assert.equal(pendingLabelEditFor(entries, "C:/a", "mr", 7).pending, false);
  // A running edit beside the parked one on PR 3: parked only when ALL are.
  const mixed = pendingMutationEntries([
    mutation(46, prWriteKey("labels", "C:/a"), labelVars("mr", 3)),
  ]);
  assert.deepEqual(
    pendingLabelEditFor([...entries, ...mixed], "C:/a", "mr", 3),
    { pending: true, paused: false },
  );
});

test("a review submit holds its PR through the PR-write aggregate, either lens", () => {
  const entries = pendingMutationEntries([
    mutation(51, prWriteKey("submit-review", "C:/a"), {
      number: 8,
      verdict: "comment",
      comments: [],
    }),
  ]);
  const writes = pendingWritesFor(entries, "C:/a", readPendingPrWrite);
  assert.equal(isPendingFor(writes, "submit-review", 8, "origin"), true);
  assert.equal(isPendingFor(writes, "submit-review", 8, "upstream"), true);
  assert.equal(isPendingFor(writes, "submit-review", 9, "origin"), false);
  assert.equal(isPendingFor(writes, "comment", 8, "origin"), false);
  assert.deepEqual(pendingWritesFor(entries, "C:/b", readPendingPrWrite), []);
});

test("a fork holds the repo it forks on its provider, and maps the pause", () => {
  const entries = pendingMutationEntries([
    mutation(
      61,
      forkByNameKey("github"),
      { provider: "github", owner: "o", name: "r" },
      true,
    ),
    mutation(62, forkByNameKey("gitlab"), {
      provider: "gitlab",
      owner: "o",
      name: "s",
    }),
  ]);
  assert.deepEqual(pendingForkFor(entries, "github", "o", "r"), {
    pending: true,
    paused: true,
  });
  // Another repo by the same owner, and the same repo on another provider.
  assert.equal(pendingForkFor(entries, "github", "o", "s").pending, false);
  assert.equal(pendingForkFor(entries, "gitlab", "o", "r").pending, false);
  assert.deepEqual(pendingForkFor(entries, "gitlab", "o", "s"), {
    pending: true,
    paused: false,
  });
});

test("tag pushes read as a per-repo SET of tags, a tag paused only if every push is", () => {
  const entries = pendingMutationEntries([
    mutation(71, tagPushKey("C:/a"), "v1"),
    mutation(72, tagPushKey("C:/a"), "v2", true),
    mutation(73, tagPushKey("C:/a"), "v1", true),
    mutation(74, tagPushKey("C:/b"), "v3"),
    // A tag named like an Object.prototype member is a tag like any other.
    mutation(75, tagPushKey("C:/a"), "constructor"),
    // Variables that aren't a tag name hold nothing.
    mutation(76, tagPushKey("C:/a"), { name: "v4" }),
  ]);
  // v1 has a running push beside its parked one, so it reads as in flight.
  assert.deepEqual(pendingTagPushesFor(entries, "C:/a"), [
    { tag: "v1", paused: false },
    { tag: "v2", paused: true },
    { tag: "constructor", paused: false },
  ]);
  assert.deepEqual(pendingTagPushesFor(entries, "C:/b"), [
    { tag: "v3", paused: false },
  ]);
  assert.deepEqual(pendingTagPushesFor(entries, "C:/c"), []);
  // Order-free: a parked push seen first still yields to a running one after it.
  const parkedFirst = pendingMutationEntries([
    mutation(77, tagPushKey("C:/a"), "v5", true),
    mutation(78, tagPushKey("C:/a"), "v5"),
  ]);
  assert.deepEqual(pendingTagPushesFor(parkedFirst, "C:/a"), [
    { tag: "v5", paused: false },
  ]);
});

test("issue and Jira rail writes scope by repo KEY and keep kind, pause and variables", () => {
  // `usePendingRepoWrites` reads its family through the cache scan's own prefix
  // filter (mirrored here), then this shared projection.
  const read = (kind, vars, paused) => ({ kind, vars, paused });
  const scan = (all, family) =>
    pendingMutationEntries(
      all.filter((m) => m.options.mutationKey[0] === family),
    );
  const all = [
    // Two issues in one repo, one of them parked offline.
    mutation(81, ["issue-write", "due-date", "C:/a"], {
      number: 3,
      dueDate: null,
    }),
    mutation(
      82,
      ["issue-write", "due-date", "C:/a"],
      { number: 4, dueDate: "2026-10-12" },
      true,
    ),
    // One issue under a second kind.
    mutation(83, ["issue-write", "confidential", "C:/a"], {
      number: 3,
      confidential: true,
    }),
    // Another repo's write never holds this one's rows.
    mutation(84, ["issue-write", "due-date", "C:/b"], {
      number: 3,
      dueDate: null,
    }),
    // One issue with a running and a parked write of one kind.
    mutation(86, ["issue-write", "due-date", "C:/a"], {
      number: 5,
      dueDate: null,
    }),
    mutation(
      87,
      ["issue-write", "due-date", "C:/a"],
      { number: 5, dueDate: "2026-10-13" },
      true,
    ),
    // A Jira write in the same repo, under its own family.
    mutation(85, ["jira-write", "due-date", "C:/a"], {
      issueKey: "GD-3",
      dueDate: null,
    }),
  ];
  const issue = pendingWritesFor(scan(all, "issue-write"), "C:/a", read);
  assert.deepEqual(
    issue.map((w) => [w.kind, w.vars.number, w.paused]),
    [
      ["due-date", 3, false],
      ["due-date", 4, true],
      ["confidential", 3, false],
      ["due-date", 5, false],
      ["due-date", 5, true],
    ],
  );
  // Rows match their entity from the variables, within one kind.
  const dueFor = (n) =>
    issue
      .filter((w) => w.kind === "due-date" && w.vars.number === n)
      .map((w) => w.paused);
  assert.deepEqual(dueFor(3), [false]);
  assert.deepEqual(dueFor(4), [true]);
  assert.deepEqual(dueFor(6), []);
  // The wave's ALL-PARKED rule, as `pendingWriteMatching` folds these pauses: a
  // running write beside a parked one reads as saving, never as offline.
  const allParked = (pauses) => pauses.length > 0 && pauses.every(Boolean);
  assert.deepEqual(dueFor(5), [false, true]);
  assert.equal(allParked(dueFor(5)), false);
  assert.equal(allParked(dueFor(4)), true);
  // The two families are disjoint: neither scan sees the other's write.
  const jira = pendingWritesFor(scan(all, "jira-write"), "C:/a", read);
  assert.deepEqual(
    jira.map((w) => [w.kind, w.vars.issueKey, w.paused]),
    [["due-date", "GD-3", false]],
  );
  assert.equal(
    issue.some((w) => "issueKey" in w.vars),
    false,
  );
  assert.deepEqual(
    pendingWritesFor(scan(all, "issue-write"), "C:/c", read),
    [],
  );
});

test("discussion lock writes hold each discussion by its own pending write", () => {
  // Both keys stay live in the cache at once, which an observer (tracking only
  // its latest call) can't show: A's lock must survive B's starting.
  const read = (kind, vars, paused) => ({ kind, vars, paused });
  const writes = pendingWritesFor(
    pendingMutationEntries([
      mutation(
        91,
        ["discussion-write", "lock", "C:/a"],
        { discussionId: "D_A", reason: null },
        true,
      ),
      mutation(92, ["discussion-write", "unlock", "C:/a"], "D_B"),
      mutation(93, ["discussion-write", "lock", "C:/b"], {
        discussionId: "D_C",
        reason: null,
      }),
    ]),
    "C:/a",
    read,
  );
  // The menu's suffix state per discussion, as DiscussionView reads it.
  const stateFor = (id) => ({
    locking: writes
      .filter((w) => w.kind === "lock" && w.vars.discussionId === id)
      .map((w) => w.paused),
    unlocking: writes
      .filter((w) => w.kind === "unlock" && w.vars === id)
      .map((w) => w.paused),
  });
  assert.deepEqual(stateFor("D_A"), { locking: [true], unlocking: [] });
  assert.deepEqual(stateFor("D_B"), { locking: [], unlocking: [false] });
  // Another repo's lock never holds this one's discussions.
  assert.deepEqual(stateFor("D_C"), { locking: [], unlocking: [] });
});

test("a project status write's kind comes from its own key", () => {
  const family = "project-status-write";
  for (const kind of ["create", "update", "delete"])
    assert.equal(statusWriteKind([family, kind]), kind);
  // A key naming no known kind, or no key at all, holds nothing.
  for (const key of [[family, "edit"], [family], [], undefined, [family, 1]])
    assert.equal(statusWriteKind(key), null, JSON.stringify(key));
});
