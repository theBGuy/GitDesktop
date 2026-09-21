// Pins the PR-create lane's TWO clocks and its split authority. The lane serves
// one entry to two jobs: the duplicate-create guard (plus the repo-view banner),
// which any open-axis page or the guard timeout releases, and the list's held
// spot, which only closed-or-merged evidence, the long stop, or the PULLS PANEL
// may delete — sibling surfaces fetch unfiltered pages, so a watcher deleting on
// one of those would drop the strip while the panel's page still lacks the row.
// Every test here is a case where letting one clock or one page speak for both
// loses the user's place in the list or strands a refusal.
//
// The imports below reach straight into `src/` and rely on Node's default type
// stripping (>= 23.6), which ERASES types rather than compiling them and
// resolves no bundler aliases: the two store modules therefore carry their
// runtime imports relative and extensioned. An `@/` value import added to
// either fails this file, which is the point. Package imports resolve normally,
// so the real zustand store and a real QueryClient are what run here.
//
// Node's stdlib test runner, so the CI `guards` job runs
// `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { QueryClient } from "@tanstack/react-query";
import {
  consumeLastFailed,
  laneBlocks,
  markPrCreated,
  releasePrCreateGuard,
  settlePrCreate,
  settlePrCreateIfCurrent,
  startPrCreate,
  usePrCreateStore,
} from "../src/lib/stores/pr-create.ts";
import { armPrCreateHandOff } from "../src/lib/stores/pr-create-handoff.ts";

// Already lower-cased with forward slashes, so `normPath` is the identity here
// and the store's bucket key is this exact string.
const REPO = "c:/repos/demo";
const LENS = "origin";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The display half of a claim — what the strip and the banner paint. */
const display = (title) => ({
  title,
  draft: false,
  lens: LENS,
  noun: "pull request",
});

/** `usePrList`'s key: repo, lens (index 3), state (index 4), then limit+filter. */
const listKey = (state, { lens = LENS, limit = 50 } = {}) => [
  "repo",
  REPO,
  "pr-list",
  lens,
  state,
  limit,
  null,
];

/** A list row carrying only what the watcher reads. Real pages are `PrInfo`,
 *  which has a dozen more fields; none of them reach this code path. */
const row = (number, state = "OPEN") => ({ number, state });

const entryFor = (head) => usePrCreateStore.getState().byRepo[REPO]?.[head];

/** Publishes a page, then lets react-query's notify manager deliver it — the
 *  cache subscription the watcher holds fires on a macrotask, not inline. */
async function publish(qc, key, rows) {
  qc.setQueryData(key, rows);
  await sleep(10);
}

afterEach(() => {
  usePrCreateStore.setState({ byRepo: {} });
});

test("the entry outlives its guard, and a fresh claim replaces it", async () => {
  const qc = new QueryClient();
  const head = "feature-a";
  assert.equal(startPrCreate(REPO, head, "main", display("Add a thing")), null);
  markPrCreated(REPO, head, { number: 101, url: "https://x/101" });
  const claimed = entryFor(head).startedAt;
  // The long stop is far out of reach; only the guard timer fires below.
  armPrCreateHandOff(
    qc,
    { repoPath: REPO, head, lens: LENS, number: 101, startedAt: claimed },
    { guardTimeoutMs: 10, longStopMs: 10_000 },
  );
  await sleep(60);

  const held = entryFor(head);
  // NEGATIVE CONTROL: this assertion FAILS against the pre-change code, which
  // deleted the entry at the timeout — it is the revert detector for this file.
  assert.ok(held, "the held entry survives its guard timeout");
  assert.equal(held.phase, "created");
  assert.equal(held.guardReleased, true);
  // `usePrCreatePhase`'s selector is `entry && laneBlocks(entry) ? phase : null`
  // and the banner filters on the same predicate, so this false IS both of them
  // going quiet.
  assert.equal(laneBlocks(held), false, "guard, banner and hints all released");

  await sleep(5); // a distinct `Date.now()` for the replacing claim
  assert.equal(
    startPrCreate(REPO, head, "main", display("Add another thing")),
    null,
    "a released lane admits the next create",
  );
  const replacement = entryFor(head);
  assert.equal(replacement.phase, "creating");
  assert.notEqual(replacement.startedAt, claimed, "a fresh claim, not a patch");
  assert.equal(laneBlocks(replacement), true);

  // The superseded watcher reaps itself on the next cache event, which is also
  // what frees its timers so this test can end.
  await publish(qc, listKey("open"), [row(101)]);
  assert.ok(entryFor(head), "the stale watcher leaves the new claim alone");
  settlePrCreate(REPO, head, "release");
});

test("an open-axis page releases the guard and keeps the place", async () => {
  const qc = new QueryClient();
  const head = "feature-open";
  startPrCreate(REPO, head, "main", display("Open containment"));
  markPrCreated(REPO, head, { number: 202, url: "https://x/202" });
  // The guard timer is out of reach, so any release below came from the page.
  armPrCreateHandOff(
    qc,
    {
      repoPath: REPO,
      head,
      lens: LENS,
      number: 202,
      startedAt: entryFor(head).startedAt,
    },
    { guardTimeoutMs: 10_000, longStopMs: 80 },
  );

  await publish(qc, listKey("open"), [row(202)]);
  const held = entryFor(head);
  assert.ok(held, "deleting the spot is the panel's call, not the watcher's");
  assert.equal(held.guardReleased, true, "but the PR provably exists");

  await sleep(120);
  assert.equal(entryFor(head), undefined, "the long stop still runs");
  assert.equal(
    usePrCreateStore.getState().byRepo[REPO],
    undefined,
    "the repo bucket is pruned with its last entry",
  );
});

test("releasing an already-released guard notifies nobody", () => {
  // The watcher calls this on EVERY matching page while the hold lasts, so the
  // already-released arm returning the same state object is what keeps a held
  // strip from re-rendering on every list refetch.
  const head = "feature-repeat";
  startPrCreate(REPO, head, "main", display("Repeat"));
  markPrCreated(REPO, head, { number: 121, url: "https://x/121" });
  const startedAt = entryFor(head).startedAt;

  let notifies = 0;
  const unsubscribe = usePrCreateStore.subscribe(() => {
    notifies += 1;
  });
  releasePrCreateGuard(REPO, head, startedAt);
  releasePrCreateGuard(REPO, head, startedAt);
  releasePrCreateGuard(REPO, head, startedAt);
  unsubscribe();

  assert.equal(notifies, 1, "only the transition is a state change");
  assert.equal(entryFor(head).guardReleased, true);
  settlePrCreate(REPO, head, "release");
});

test("settlePrCreateIfCurrent settles only the claim it names", () => {
  const head = "feature-identity";
  startPrCreate(REPO, head, "main", display("Identity"));
  markPrCreated(REPO, head, { number: 111, url: "https://x/111" });
  const startedAt = entryFor(head).startedAt;

  settlePrCreateIfCurrent(REPO, head, startedAt - 1);
  assert.ok(entryFor(head), "another claim's stamp is a no-op");
  settlePrCreateIfCurrent(REPO, head, startedAt);
  assert.equal(entryFor(head), undefined);
  settlePrCreateIfCurrent(REPO, head, startedAt);
  assert.equal(entryFor(head), undefined, "and it is idempotent");
});

test("a blocking lane refuses a second create, a released one admits it", async () => {
  const qc = new QueryClient();
  const head = "feature-refused";
  assert.equal(startPrCreate(REPO, head, "main", display("First")), null);
  // The refusal is a string the caller toasts; its exact copy belongs to the
  // hint table, so only its presence is pinned here.
  assert.equal(
    typeof startPrCreate(REPO, head, "main", display("Second")),
    "string",
    "a running create refuses",
  );
  markPrCreated(REPO, head, { number: 909, url: "https://x/909" });
  assert.equal(
    typeof startPrCreate(REPO, head, "main", display("Third")),
    "string",
    "so does a created lane whose guard still holds",
  );

  armPrCreateHandOff(
    qc,
    {
      repoPath: REPO,
      head,
      lens: LENS,
      number: 909,
      startedAt: entryFor(head).startedAt,
    },
    { guardTimeoutMs: 10, longStopMs: 10_000 },
  );
  await sleep(50);
  assert.equal(
    startPrCreate(REPO, head, "main", display("Fourth")),
    null,
    "a released hold admits the next create",
  );

  await publish(qc, listKey("open"), [row(909)]); // reaps the stale watcher
  settlePrCreate(REPO, head, "release");
});

test("a closed or merged row settles the lane too", async () => {
  const qc = new QueryClient();
  const head = "feature-merged";
  startPrCreate(
    REPO,
    head,
    "main",
    display("Merged before the list caught up"),
  );
  markPrCreated(REPO, head, { number: 303, url: "https://x/303" });
  armPrCreateHandOff(
    qc,
    {
      repoPath: REPO,
      head,
      lens: LENS,
      number: 303,
      startedAt: entryFor(head).startedAt,
    },
    { guardTimeoutMs: 10_000, longStopMs: 10_000 },
  );

  // It legitimately left the open list, so holding its spot would paint a strip
  // for a dead PR.
  await publish(qc, listKey("closed"), [row(303, "MERGED")]);
  assert.equal(entryFor(head), undefined);
});

test("a closed-axis OPEN row and another lens's page hold nothing back", async () => {
  const qc = new QueryClient();
  const head = "feature-leaky";
  startPrCreate(REPO, head, "main", display("Leaky closed list"));
  markPrCreated(REPO, head, { number: 404, url: "https://x/404" });
  armPrCreateHandOff(
    qc,
    {
      repoPath: REPO,
      head,
      lens: LENS,
      number: 404,
      startedAt: entryFor(head).startedAt,
    },
    // Out of reach, so every verdict below is the page's and not a timer's.
    { guardTimeoutMs: 10_000, longStopMs: 10_000 },
  );

  // A provider whose closed list leaks still-open rows proves nothing about the
  // open list the strip sits in.
  await publish(qc, listKey("closed"), [row(404, "OPEN")]);
  assert.equal(entryFor(head).guardReleased, false, "a leaky closed page");
  // A bare number is only valid under the lens that produced it.
  await publish(qc, listKey("open", { lens: "upstream" }), [row(404)]);
  assert.equal(entryFor(head).guardReleased, false, "another lens's page");
  // The positive control: this lane's own open axis does release.
  await publish(qc, listKey("open"), [row(404)]);
  assert.equal(entryFor(head).guardReleased, true);

  await publish(qc, listKey("closed"), [row(404, "CLOSED")]);
  assert.equal(entryFor(head), undefined, "closed evidence still deletes");
});

test("the long stop removes an entry no list ever shows", async () => {
  const qc = new QueryClient();
  const head = "feature-invisible";
  startPrCreate(REPO, head, "main", display("Never listed"));
  markPrCreated(REPO, head, { number: 505, url: "https://x/505" });
  armPrCreateHandOff(
    qc,
    {
      repoPath: REPO,
      head,
      lens: LENS,
      number: 505,
      startedAt: entryFor(head).startedAt,
    },
    { guardTimeoutMs: 10_000, longStopMs: 30 },
  );

  await sleep(100);
  assert.equal(entryFor(head), undefined, "the hold is bounded");
});

test("a watcher whose head was re-claimed touches neither clock", async () => {
  const qc = new QueryClient();
  const head = "feature-reclaimed";
  startPrCreate(REPO, head, "main", display("First"));
  markPrCreated(REPO, head, { number: 606, url: "https://x/606" });
  const first = entryFor(head).startedAt;
  armPrCreateHandOff(
    qc,
    { repoPath: REPO, head, lens: LENS, number: 606, startedAt: first },
    { guardTimeoutMs: 30, longStopMs: 120 },
  );

  // The first create leaves and a second claims the same head before either of
  // the stale watcher's timers fires.
  settlePrCreate(REPO, head, "release");
  await sleep(20);
  startPrCreate(REPO, head, "main", display("Second"));
  markPrCreated(REPO, head, { number: 607, url: "https://x/607" });
  const second = entryFor(head).startedAt;
  assert.notEqual(second, first, "the two claims are distinguishable");

  // A page the stale watcher would have acted on. The reap it performs here is
  // only observable through this outcome: the subscription teardown itself needs
  // module internals this file deliberately doesn't reach into.
  await publish(qc, listKey("open"), [row(606)]);
  assert.equal(
    entryFor(head).guardReleased,
    false,
    "a stale watcher cannot release the new lane's guard",
  );

  await sleep(60); // past the stale guard timer, short of its long stop
  assert.equal(entryFor(head).guardReleased, false, "nor can its guard timer");
  assert.equal(laneBlocks(entryFor(head)), true);

  await sleep(140); // past the stale long stop
  assert.ok(entryFor(head), "nor settle it");
  settlePrCreate(REPO, head, "release");
});

test("two heads in one repo are held independently", async () => {
  const qc = new QueryClient();
  for (const [head, number] of [
    ["feature-one", 701],
    ["feature-two", 702],
  ]) {
    startPrCreate(REPO, head, "main", display(head));
    markPrCreated(REPO, head, { number, url: `https://x/${number}` });
    armPrCreateHandOff(
      qc,
      {
        repoPath: REPO,
        head,
        lens: LENS,
        number,
        startedAt: entryFor(head).startedAt,
      },
      { guardTimeoutMs: 10, longStopMs: 10_000 },
    );
  }
  await sleep(60);
  assert.equal(entryFor("feature-one").guardReleased, true);
  assert.equal(entryFor("feature-two").guardReleased, true);

  // Each watcher tests its OWN number, so one PR leaving the open list never
  // drops a sibling's place.
  await publish(qc, listKey("closed"), [row(701, "MERGED")]);
  assert.equal(entryFor("feature-one"), undefined);
  assert.ok(entryFor("feature-two"), "the sibling keeps its place");

  await publish(qc, listKey("closed"), [
    row(701, "MERGED"),
    row(702, "MERGED"),
  ]);
  assert.equal(usePrCreateStore.getState().byRepo[REPO], undefined);
});

test("settlePrCreate's delete and failed-create latch are unchanged", () => {
  const head = "feature-settle";
  const other = "feature-sibling";

  startPrCreate(REPO, head, "main", display("Failing"));
  startPrCreate(REPO, other, "main", display("Sibling"));
  settlePrCreate(REPO, head, "error");
  assert.equal(entryFor(head), undefined, "the entry goes either way");
  assert.ok(
    usePrCreateStore.getState().byRepo[REPO],
    "a surviving sibling keeps the repo bucket",
  );
  assert.equal(consumeLastFailed(REPO, head), true, "an error latches");
  assert.equal(consumeLastFailed(REPO, head), false, "read once, then spent");

  // "release" frees the lane and leaves any other latch standing.
  settlePrCreate(REPO, head, "error");
  startPrCreate(REPO, head, "main", display("Retry"));
  settlePrCreate(REPO, head, "release");
  assert.equal(consumeLastFailed(REPO, head), true, "release latches nothing");

  // "success" clears, as does the phase flip that precedes it.
  settlePrCreate(REPO, head, "error");
  settlePrCreate(REPO, head, "success");
  assert.equal(consumeLastFailed(REPO, head), false);
  settlePrCreate(REPO, head, "error");
  startPrCreate(REPO, head, "main", display("Retry again"));
  markPrCreated(REPO, head, { number: 808, url: "https://x/808" });
  assert.equal(consumeLastFailed(REPO, head), false, "the flip clears it too");

  settlePrCreate(REPO, head, "release");
  settlePrCreate(REPO, other, "release");
  assert.equal(usePrCreateStore.getState().byRepo[REPO], undefined);
});
