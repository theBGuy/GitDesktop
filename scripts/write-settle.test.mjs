// Pins how a project or view write settles into the cache: which keys its patch
// touched, merging the answer over only those, rolling back only those and only
// while the cache still holds this write's value — and which reads a whole-repo
// settle has to heal. A wrong merge never errors: it erases a sibling write's
// landed change, or keeps pre-close permission verdicts on a just-closed project,
// until the settle's re-read, so each rule is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `write-settle.ts` may
// import types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStraddleHealer,
  mergeTouched,
  projectTouchedKeys,
  readStraddlesSettle,
  restoreTouched,
  straddleOutcome,
  viewTouchedKeys,
} from "../src/lib/git/queries/write-settle.ts";

const project = (over = {}) => ({
  id: "P1",
  title: "Roadmap",
  number: 3,
  closed: false,
  viewerCanUpdate: true,
  viewerCanClose: true,
  viewerCanReopen: false,
  shortDescription: "Q4",
  ...over,
});

test("a project patch touches the keys it carries; a touched closed adds the permission verdicts", () => {
  assert.deepEqual(projectTouchedKeys({ title: "New" }), ["title"]);
  assert.deepEqual(projectTouchedKeys({ closed: true }), [
    "closed",
    "viewerCanClose",
    "viewerCanReopen",
  ]);
  assert.deepEqual(
    projectTouchedKeys({ title: undefined, shortDescription: "" }),
    ["shortDescription"],
  );
});

test("a view patch touches exactly the keys it carries", () => {
  assert.deepEqual(viewTouchedKeys({ layout: "table" }), ["layout"]);
  assert.deepEqual(viewTouchedKeys({ name: "A", visibleFieldIds: [] }), [
    "name",
    "visibleFieldIds",
  ]);
  assert.deepEqual(viewTouchedKeys({ name: undefined }), []);
});

test("a close merges the answer's permission verdicts but leaves a sibling edit's title", () => {
  // The cache holds an overlapping rename's landed title; the close's answer was
  // computed before that rename committed. The verdict values are arbitrary: the
  // answer's are authoritative, whatever they are.
  const cache = project({ title: "Renamed", closed: true });
  const answer = project({
    closed: true,
    viewerCanClose: false,
    viewerCanReopen: true,
  });
  const merged = mergeTouched(
    cache,
    projectTouchedKeys({ closed: true }),
    answer,
  );
  assert.equal(merged.title, "Renamed");
  assert.equal(merged.closed, true);
  assert.equal(merged.viewerCanClose, false);
  assert.equal(merged.viewerCanReopen, true);
});

test("an answer lacking a touched key DELETES it — absent, never a present undefined", () => {
  const cache = project();
  const { shortDescription: _, ...answer } = project();
  const merged = mergeTouched(cache, ["shortDescription"], answer);
  assert.equal(Object.hasOwn(merged, "shortDescription"), false);
  assert.equal(merged.title, "Roadmap");
});

test("the merge copies and never mutates its target", () => {
  const cache = project();
  const merged = mergeTouched(cache, ["title"], project({ title: "X" }));
  assert.notEqual(merged, cache);
  assert.equal(cache.title, "Roadmap");
});

test("rollback restores a touched key still holding this write's optimistic value", () => {
  const before = project();
  const optimistic = project({ title: "Typo" });
  const current = project({ title: "Typo", closed: true }); // a sibling close landed
  const restored = restoreTouched(current, ["title"], optimistic, before);
  assert.equal(restored.title, "Roadmap");
  assert.equal(restored.closed, true);
});

test("rollback leaves a touched key a LATER write has since changed", () => {
  const before = project();
  const optimistic = project({ title: "Typo" });
  const current = project({ title: "Later" });
  const restored = restoreTouched(current, ["title"], optimistic, before);
  assert.equal(restored, current);
  assert.equal(restored.title, "Later");
});

test("rollback re-deletes a key the entity lacked before the write", () => {
  const { shortDescription: _, ...before } = project();
  const optimistic = { ...before, shortDescription: "Added" };
  const current = { ...before, shortDescription: "Added" };
  const restored = restoreTouched(
    current,
    ["shortDescription"],
    optimistic,
    before,
  );
  assert.equal(Object.hasOwn(restored, "shortDescription"), false);
});

test("rollback restores a cleared (absent) key when the cache still lacks it", () => {
  const before = project();
  const { shortDescription: _, ...optimistic } = project();
  const current = { ...optimistic };
  const restored = restoreTouched(
    current,
    ["shortDescription"],
    optimistic,
    before,
  );
  assert.equal(restored.shortDescription, "Q4");
});

test("rollback compares id lists by value, not identity", () => {
  const view = (visibleFieldIds) => ({
    id: "V",
    name: "N",
    layout: "board",
    visibleFieldIds,
  });
  const restored = restoreTouched(
    view(["a", "b"]),
    ["visibleFieldIds"],
    view(["a", "b"]),
    view(["a"]),
  );
  assert.deepEqual(restored.visibleFieldIds, ["a"]);
});

const query = (fetchStatus, data, active) => ({
  state: { fetchStatus, data },
  isActive: () => active,
});

test("an inactive read in flight straddles the settle; an active one with data does not", () => {
  assert.equal(readStraddlesSettle(query("fetching", { x: 1 }, false)), true);
  assert.equal(readStraddlesSettle(query("fetching", { x: 1 }, true)), false);
});

test("a first load in flight straddles the settle, active or not", () => {
  assert.equal(readStraddlesSettle(query("fetching", undefined, true)), true);
  assert.equal(readStraddlesSettle(query("fetching", undefined, false)), true);
});

test("idle and paused reads never straddle — nothing of theirs reached the server", () => {
  assert.equal(readStraddlesSettle(query("idle", undefined, false)), false);
  assert.equal(readStraddlesSettle(query("paused", undefined, true)), false);
  assert.equal(readStraddlesSettle(query("paused", { x: 1 }, false)), false);
});

const event = (type, fetchStatus) => ({
  type,
  query: { state: { fetchStatus } },
});

test("a watched read lands once an update leaves it no longer fetching", () => {
  assert.equal(straddleOutcome(event("updated", "idle")), "landed");
  assert.equal(straddleOutcome(event("updated", "paused")), "landed");
});

test("a watched read still fetching (an invalidate mark, a retry) keeps waiting", () => {
  assert.equal(straddleOutcome(event("updated", "fetching")), null);
  assert.equal(straddleOutcome(event("observerRemoved", "idle")), null);
  assert.equal(straddleOutcome(event("observerResultsUpdated", "idle")), null);
});

test("a watched query leaving the cache ends the watch with nothing to heal", () => {
  assert.equal(straddleOutcome(event("removed", "fetching")), "removed");
});

test("named edge: a later write of the SAME value is rolled back with this one", () => {
  const before = project();
  const optimistic = project({ title: "Same" });
  const current = project({ title: "Same" }); // a later sibling landed "Same" too
  assert.equal(
    restoreTouched(current, ["title"], optimistic, before).title,
    "Roadmap",
  );
});

/** A stand-in query cache: one subscription at a time, its listener callable by
 *  the test, and every re-invalidation recorded. */
function fakeCache() {
  const cache = {
    listener: null,
    subscribes: 0,
    unsubscribed: 0,
    invalidated: [],
    subscribe(listener) {
      cache.subscribes += 1;
      cache.listener = listener;
      return () => {
        cache.unsubscribed += 1;
        cache.listener = null;
      };
    },
    invalidate(query) {
      cache.invalidated.push(query.name);
    },
    emit(type, query) {
      cache.listener?.({ type, query });
    },
  };
  return cache;
}

/** A healer whose deferred invalidations wait for `flush()`. */
function healerWithQueue() {
  const queue = [];
  const healer = createStraddleHealer((run) => queue.push(run));
  const flush = () => {
    for (const run of queue.splice(0)) run();
  };
  return { healer, flush, queue };
}

const read = (name) => ({ name, state: { fetchStatus: "fetching" } });

test("heal: a landed read is re-invalidated exactly once, deferred off the notification", () => {
  const { healer, flush, queue } = healerWithQueue();
  const cache = fakeCache();
  const q = read("q");
  healer.watch(cache, [q]);
  q.state.fetchStatus = "idle";
  cache.emit("updated", q);
  assert.deepEqual(cache.invalidated, []);
  assert.equal(queue.length, 1);
  flush();
  cache.emit("updated", q);
  flush();
  assert.deepEqual(cache.invalidated, ["q"]);
});

test("heal: a second watch of a read still in flight adds no second watch", () => {
  const { healer, flush } = healerWithQueue();
  const cache = fakeCache();
  const q = read("q");
  healer.watch(cache, [q]);
  assert.equal(healer.isHealing(q), true);
  healer.watch(cache, [q]);
  assert.equal(cache.subscribes, 1);
  q.state.fetchStatus = "idle";
  cache.emit("updated", q);
  flush();
  assert.deepEqual(cache.invalidated, ["q"]);
});

test("heal: a landed read leaves the watch set and can be watched again", () => {
  const { healer, flush } = healerWithQueue();
  const cache = fakeCache();
  const q = read("q");
  healer.watch(cache, [q]);
  q.state.fetchStatus = "idle";
  cache.emit("updated", q);
  flush();
  assert.equal(healer.isHealing(q), false);
  q.state.fetchStatus = "fetching";
  healer.watch(cache, [q]);
  assert.equal(cache.subscribes, 2);
  q.state.fetchStatus = "idle";
  cache.emit("updated", q);
  flush();
  assert.deepEqual(cache.invalidated, ["q", "q"]);
});

test("heal: a removed read never heals, and leaves the watch set", () => {
  const { healer, flush } = healerWithQueue();
  const cache = fakeCache();
  const q = read("q");
  healer.watch(cache, [q]);
  cache.emit("removed", q);
  flush();
  assert.deepEqual(cache.invalidated, []);
  assert.equal(healer.isHealing(q), false);
  assert.equal(cache.unsubscribed, 1);
});

test("heal: the subscription ends with its LAST read, not its first", () => {
  const { healer, flush } = healerWithQueue();
  const cache = fakeCache();
  const a = read("a");
  const b = read("b");
  healer.watch(cache, [a, b]);
  a.state.fetchStatus = "idle";
  cache.emit("updated", a);
  assert.equal(cache.unsubscribed, 0);
  b.state.fetchStatus = "idle";
  cache.emit("updated", b);
  assert.equal(cache.unsubscribed, 1);
  flush();
  assert.deepEqual(cache.invalidated, ["a", "b"]);
});

test("heal: events for unwatched queries and in-flight updates change nothing", () => {
  const { healer, flush } = healerWithQueue();
  const cache = fakeCache();
  const q = read("q");
  healer.watch(cache, [q]);
  cache.emit("updated", read("other"));
  cache.emit("updated", q); // still fetching: an invalidate mark, a retry
  flush();
  assert.deepEqual(cache.invalidated, []);
  assert.equal(cache.unsubscribed, 0);
});

test("heal: watching nothing new subscribes to nothing", () => {
  const { healer } = healerWithQueue();
  const cache = fakeCache();
  healer.watch(cache, []);
  assert.equal(cache.subscribes, 0);
});
