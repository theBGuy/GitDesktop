// Pins how the linked-issue chip cluster stays bound to the target it was made
// for. The contract under test: every target (repo AND lens) owns its own
// bucket of chips and dismissals, writes land in the bucket of the target they
// were captured under whatever is on screen, and a flip back restores a
// target's cluster exactly as it was left.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which erases `import type` but resolves no bundler
// aliases, so `linked-issue-selection.ts` must keep its imports type-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addExtractedIssue,
  backfillFromOpenPage,
  bucketFor,
  dismissIssue,
  EMPTY_LINKED_ISSUE_BUCKET,
  fillIssueMeta,
  INITIAL_LINKED_ISSUE_BUCKETS,
  linkedIssueTargetKey,
  pickIssue,
  routeBucketUpdate,
  seedBuckets,
  toggleIssueKeyword,
  upsertAiIssues,
} from "../src/features/pulls/linked-issue-selection.ts";
import { sameLabelTarget } from "../src/features/pulls/pr-label-selection.ts";

const FORK = { repoPath: "C:/repos/app", lens: "origin" };
const PARENT = { repoPath: "C:/repos/app", lens: "upstream" };
const OTHER_REPO = { repoPath: "C:/repos/lib", lens: "origin" };
const OTHER_REPO_PARENT = { repoPath: "C:/repos/lib", lens: "upstream" };
const K_FORK = linkedIssueTargetKey(FORK);
const K_PARENT = linkedIssueTargetKey(PARENT);
const K_OTHER = linkedIssueTargetKey(OTHER_REPO);

const chip = (number, over = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "OPEN",
  keyword: "relates",
  source: "manual",
  aiSuggestedClose: false,
  ...over,
});
const numbers = (bucket) => bucket.chips.map((c) => c.number);
const fedOf = (...ns) =>
  new Map(ns.map((n) => [n, { title: `Fed ${n}`, state: "OPEN" }]));
const route = (buckets, key, update) =>
  routeBucketUpdate(buckets, key, buckets.generation, update);
const seed = (key, chips, prev = INITIAL_LINKED_ISSUE_BUCKETS) =>
  seedBuckets(prev.generation + 1, key, chips);

test("target keys agree with sameLabelTarget on repo AND lens", () => {
  const sigs = [FORK, PARENT, OTHER_REPO, OTHER_REPO_PARENT];
  for (const a of sigs)
    for (const b of sigs)
      assert.equal(
        linkedIssueTargetKey(a) === linkedIssueTargetKey(b),
        sameLabelTarget(a, b),
        `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      );
  // A repoPath that embeds the separator of a naive join still can't collide.
  assert.notEqual(
    linkedIssueTargetKey({ repoPath: "a:origin", lens: "upstream" }),
    linkedIssueTargetKey({ repoPath: "a", lens: "origin:upstream" }),
  );
});

test("an untouched target reads the shared empty bucket", () => {
  const buckets = INITIAL_LINKED_ISSUE_BUCKETS;
  assert.equal(bucketFor(buckets, K_FORK), EMPTY_LINKED_ISSUE_BUCKET);
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), []);
});

test("a flip shows the other target's own chips and a flip back restores these", () => {
  let buckets = seed(K_FORK, [chip(12, { keyword: "closes" })]);
  buckets = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [7], relates: [] }, fedOf(7)),
  );
  // Flip to the parent: nothing from the fork shows.
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), []);
  buckets = route(buckets, K_PARENT, (b) => addExtractedIssue(b, chip(3)));
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), [3]);
  // Flip back: the fork's chips return with their keyword and AI flag.
  const fork = bucketFor(buckets, K_FORK);
  assert.deepEqual(numbers(fork), [12, 7]);
  assert.equal(fork.chips[0].keyword, "closes");
  assert.equal(fork.chips[1].aiSuggestedClose, true);
});

test("the same number keeps a separate chip per target", () => {
  let buckets = seed(K_FORK, [chip(12, { keyword: "closes" })]);
  buckets = route(buckets, K_PARENT, (b) => pickIssue(b, chip(12)));
  buckets = route(buckets, K_PARENT, (b) => toggleIssueKeyword(b, 12));
  buckets = route(buckets, K_PARENT, (b) => toggleIssueKeyword(b, 12));
  buckets = route(buckets, K_FORK, (b) => toggleIssueKeyword(b, 12));
  assert.equal(bucketFor(buckets, K_FORK).chips[0].keyword, "relates");
  assert.equal(bucketFor(buckets, K_PARENT).chips[0].keyword, "relates");
  buckets = route(buckets, K_PARENT, (b) => toggleIssueKeyword(b, 12));
  assert.equal(bucketFor(buckets, K_PARENT).chips[0].keyword, "closes");
  assert.equal(bucketFor(buckets, K_FORK).chips[0].keyword, "relates");
});

test("a probe settling after a flip lands in the target it was fired for", () => {
  // Fired on the fork for untitled #12, settles while the parent is on screen.
  let buckets = seed(K_FORK, [chip(12, { title: "" })]);
  buckets = route(buckets, K_PARENT, (b) =>
    pickIssue(b, chip(12, { title: "" })),
  );
  buckets = route(buckets, K_FORK, (b) =>
    fillIssueMeta(b, 12, { title: "Fork twelve", state: "CLOSED" }),
  );
  assert.equal(bucketFor(buckets, K_FORK).chips[0].title, "Fork twelve");
  // Negative control: the parent's own #12 stays untitled for its own probe.
  assert.equal(bucketFor(buckets, K_PARENT).chips[0].title, "");
});

test("an extraction probe settling after a flip seeds its origin target only", () => {
  let buckets = seed(K_FORK, []);
  buckets = route(buckets, K_FORK, (b) => addExtractedIssue(b, chip(40)));
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), []);
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), [40]);
});

test("mid-stream chunks keep landing in the run's target after a flip", () => {
  let buckets = seed(K_FORK, []);
  const runFed = fedOf(5, 6);
  // First chunk under the fork, then the user flips to the parent.
  buckets = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [], relates: [5] }, runFed),
  );
  buckets = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [6], relates: [5] }, runFed),
  );
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), []);
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), [5, 6]);
});

test("dismissing a number on one target never suppresses it on another", () => {
  let buckets = seed(K_FORK, [chip(12)]);
  buckets = route(buckets, K_FORK, (b) => dismissIssue(b, 12));
  const fed = fedOf(12);
  buckets = route(buckets, K_PARENT, (b) =>
    upsertAiIssues(b, { closes: [], relates: [12] }, fed),
  );
  buckets = route(buckets, K_PARENT, (b) => addExtractedIssue(b, chip(12)));
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), [12]);
  // Negative control: the fork still refuses it from both upsert paths.
  buckets = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [12], relates: [] }, fed),
  );
  buckets = route(buckets, K_FORK, (b) => addExtractedIssue(b, chip(12)));
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), []);
});

test("a manual pick lifts the target's dismissal", () => {
  let buckets = seed(K_FORK, [chip(12)]);
  buckets = route(buckets, K_FORK, (b) => dismissIssue(b, 12));
  buckets = route(buckets, K_FORK, (b) => pickIssue(b, chip(12)));
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), [12]);
  assert.equal(bucketFor(buckets, K_FORK).dismissed.has(12), false);
  // An upsert after the pick is no longer blocked.
  buckets = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [12], relates: [] }, fedOf(12)),
  );
  assert.equal(bucketFor(buckets, K_FORK).chips[0].aiSuggestedClose, true);
});

test("upserts union within one target and skip numbers the run never offered", () => {
  let bucket = seed(K_FORK, [chip(1)]).byTarget.get(K_FORK);
  bucket = upsertAiIssues(
    bucket,
    { closes: [2], relates: [1, 3] },
    fedOf(2, 3),
  );
  assert.deepEqual(numbers(bucket), [1, 2, 3]);
  // A later chunk re-proposing the same numbers adds nothing twice.
  bucket = upsertAiIssues(bucket, { closes: [2], relates: [3] }, fedOf(2, 3));
  assert.deepEqual(numbers(bucket), [1, 2, 3]);
  // #99 was never a candidate (the fed map lacks it), so it can't become a chip.
  bucket = upsertAiIssues(bucket, { closes: [99], relates: [] }, fedOf(2, 3));
  assert.deepEqual(numbers(bucket), [1, 2, 3]);
  // AI chips land as relates carrying the fed title.
  assert.deepEqual(bucket.chips[1], {
    number: 2,
    title: "Fed 2",
    state: "OPEN",
    keyword: "relates",
    source: "ai",
    aiSuggestedClose: true,
  });
});

test("a close proposal upgrades an existing chip and a relate never downgrades it", () => {
  let bucket = seed(K_FORK, [chip(4)]).byTarget.get(K_FORK);
  bucket = upsertAiIssues(bucket, { closes: [4], relates: [] }, fedOf(4));
  assert.equal(bucket.chips[0].aiSuggestedClose, true);
  // The upgrade keeps the user's keyword and source.
  assert.equal(bucket.chips[0].keyword, "relates");
  assert.equal(bucket.chips[0].source, "manual");
  bucket = upsertAiIssues(bucket, { closes: [], relates: [4] }, fedOf(4));
  assert.equal(bucket.chips[0].aiSuggestedClose, true);
});

test("proposals from a run that was fed nothing leave the bucket as it is", () => {
  // A chunk settling after a reset reads the cleared fed set: it must not flag
  // chips of the new cycle that it was never told about.
  const buckets = seed(K_FORK, [chip(4), chip(5, { title: "" })]);
  const bucket = buckets.byTarget.get(K_FORK);
  const same = upsertAiIssues(
    bucket,
    { closes: [4, 5, 6], relates: [7] },
    new Map(),
  );
  assert.equal(same, bucket);
  assert.equal(
    route(buckets, K_FORK, (b) =>
      upsertAiIssues(b, { closes: [4], relates: [] }, new Map()),
    ),
    buckets,
  );
  // Negative control: any fed set keeps today's upgrade of a present chip, even
  // one the set doesn't carry.
  const fed = upsertAiIssues(bucket, { closes: [4], relates: [] }, fedOf(9));
  assert.equal(fed.chips[0].aiSuggestedClose, true);
  assert.deepEqual(numbers(fed), [4, 5]);
});

test("a no-op write returns the same bucket and the same map", () => {
  const buckets = seed(K_FORK, [chip(1)]);
  const same = route(buckets, K_FORK, (b) =>
    upsertAiIssues(b, { closes: [], relates: [1] }, fedOf(1)),
  );
  assert.equal(same, buckets);
  const alsoSame = route(buckets, K_PARENT, (b) =>
    fillIssueMeta(b, 1, { title: "x", state: "OPEN" }),
  );
  assert.equal(alsoSame, buckets);
  // Negative control: a real change copies the map, leaving the input as it was.
  const changed = route(buckets, K_PARENT, (b) => pickIssue(b, chip(2)));
  assert.notEqual(changed, buckets);
  assert.equal(buckets.byTarget.has(K_PARENT), false);
});

test("a reseed drops every target's bucket", () => {
  let buckets = seed(K_FORK, [chip(1)]);
  buckets = route(buckets, K_PARENT, (b) => pickIssue(b, chip(2)));
  buckets = route(buckets, K_OTHER, (b) => dismissIssue(b, 3));
  buckets = seed(K_PARENT, [chip(9)], buckets);
  assert.deepEqual([...buckets.byTarget.keys()], [K_PARENT]);
  assert.deepEqual(numbers(bucketFor(buckets, K_PARENT)), [9]);
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), []);
  assert.equal(bucketFor(buckets, K_OTHER).dismissed.has(3), false);
});

test("a repo switch shows a fresh bucket for the new repo", () => {
  let buckets = seed(K_FORK, [chip(12)]);
  buckets = route(buckets, K_FORK, (b) => dismissIssue(b, 5));
  const other = bucketFor(buckets, K_OTHER);
  assert.deepEqual(numbers(other), []);
  assert.equal(other.dismissed.has(5), false);
  // Switching back finds the first repo's cluster intact.
  assert.deepEqual(numbers(bucketFor(buckets, K_FORK)), [12]);
});

test("backfill fills only untitled chips found on the open page", () => {
  let bucket = seed(K_FORK, [
    chip(1, { title: "" }),
    chip(2, { title: "Kept" }),
    chip(3, { title: "" }),
  ]).byTarget.get(K_FORK);
  const page = [
    { number: 1, title: "One", state: "OPEN" },
    { number: 2, title: "Renamed", state: "OPEN" },
  ];
  bucket = backfillFromOpenPage(bucket, page);
  assert.deepEqual(
    bucket.chips.map((c) => c.title),
    ["One", "Kept", ""],
  );
  // Nothing left to fill: the same bucket comes back.
  assert.equal(backfillFromOpenPage(bucket, page), bucket);
});

test("transitions leave their input bucket untouched", () => {
  const bucket = seed(K_FORK, [chip(1)]).byTarget.get(K_FORK);
  dismissIssue(bucket, 1);
  pickIssue(bucket, chip(2));
  toggleIssueKeyword(bucket, 1);
  upsertAiIssues(bucket, { closes: [3], relates: [] }, fedOf(3));
  assert.deepEqual(numbers(bucket), [1]);
  assert.equal(bucket.chips[0].keyword, "relates");
  assert.equal(bucket.dismissed.size, 0);
});

test("a probe fired before a reset lands nowhere after it", () => {
  // Generation N fires an extraction probe for #40, then the dialog reseeds.
  const before = seed(K_FORK, []);
  const firedIn = before.generation;
  const after = seed(K_FORK, [], before);
  assert.equal(after.generation, firedIn + 1);
  const landed = routeBucketUpdate(after, K_FORK, firedIn, (b) =>
    addExtractedIssue(b, chip(40)),
  );
  assert.equal(landed, after);
  assert.deepEqual(numbers(bucketFor(landed, K_FORK)), []);
  // Nor can it revive a bucket the reset dropped on another target.
  const offScreen = routeBucketUpdate(after, K_PARENT, firedIn, (b) =>
    addExtractedIssue(b, chip(40)),
  );
  assert.equal(offScreen.byTarget.has(K_PARENT), false);
  // Negative control: the same probe fired in the current generation lands.
  const current = routeBucketUpdate(after, K_FORK, after.generation, (b) =>
    addExtractedIssue(b, chip(40)),
  );
  assert.deepEqual(numbers(bucketFor(current, K_FORK)), [40]);
});

test("a write stamped with the just-advanced generation lands on the fresh seed", () => {
  // The hook advances its counter to N+1 and seeds with that value in one
  // step, so the reset's own title probes, fired before it renders, carry the
  // new value (extraction bails in that flush and re-runs after the render).
  const warm = seed(K_FORK, [chip(7)]);
  const advanced = warm.generation + 1;
  const reseeded = seedBuckets(advanced, K_FORK, []);
  assert.equal(reseeded.generation, advanced);
  const fresh = routeBucketUpdate(reseeded, K_FORK, advanced, (b) =>
    addExtractedIssue(b, chip(12)),
  );
  assert.deepEqual(numbers(bucketFor(fresh, K_FORK)), [12]);
  // Negative control: the same write stamped with the rendered, pre-reset
  // generation is dropped, which is what the counter exists to avoid.
  const stale = routeBucketUpdate(reseeded, K_FORK, warm.generation, (b) =>
    addExtractedIssue(b, chip(12)),
  );
  assert.equal(stale, reseeded);
});
