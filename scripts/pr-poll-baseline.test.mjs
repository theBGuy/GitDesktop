// Pins the PR poller's baseline merge — the rule that keeps a red rollup the
// backend could not confirm from firing a checks notification, and the limit
// that stops that hold from silencing a PR for good. Each guard answers a
// failure: a transient confirm miss sending a false failed/passed pair, a
// persistent one hiding a real failure forever, and a PR first seen
// unconfirmed never getting a baseline at all.
//
// The import reaches straight into `src/` on Node's default type stripping
// (>= 23.6), so `pr-poll-baseline.ts` must keep every import type-only.
//
// Node's stdlib test runner and node: imports only, no dev dependency.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_UNCONFIRMED_POLLS,
  mergePollBaseline,
} from "../src/features/repository/pr-poll-baseline.ts";

const row = (over) => ({
  number: 400,
  state: "OPEN",
  checksState: "FAILURE",
  checksUnconfirmed: false,
  headSha: "aaa",
  ...over,
});

/** Runs `polls` through the merge in order, as the hook does. */
const replay = (polls) => {
  let before = null;
  let streaks = new Map();
  const seen = [];
  for (const data of polls) {
    const next = mergePollBaseline(before, data, streaks);
    before = next.snapshot;
    streaks = next.streaks;
    seen.push({ row: before.get(400), streak: streaks.get(400) ?? 0 });
  }
  return seen;
};

test("an unconfirmed row holds its confirmed baseline", () => {
  const [, held] = replay([
    [row({ checksState: "SUCCESS" })],
    [row({ checksState: "FAILURE", checksUnconfirmed: true, headSha: "bbb" })],
  ]);
  assert.equal(held.row.checksState, "SUCCESS");
  assert.equal(held.row.checksUnconfirmed, false);
  assert.equal(held.streak, 1);
  // Only the checks state is held; the rest of the row is this poll's.
  assert.equal(held.row.headSha, "bbb");
});

test("a row first seen unconfirmed stays an unknown baseline", () => {
  const [first, second] = replay([
    [row({ checksUnconfirmed: true })],
    [row({ checksUnconfirmed: true })],
  ]);
  for (const seen of [first, second]) {
    assert.equal(seen.row.checksState, "FAILURE");
    assert.equal(seen.row.checksUnconfirmed, true, "primes, never a baseline");
  }
});

test("the limit releases a row to GitHub's precomputed rollup", () => {
  const unconfirmed = row({ checksState: "FAILURE", checksUnconfirmed: true });
  const seen = replay([
    [row({ checksState: "SUCCESS" })],
    ...Array.from({ length: MAX_UNCONFIRMED_POLLS + 2 }, () => [unconfirmed]),
  ]);
  for (let poll = 1; poll <= MAX_UNCONFIRMED_POLLS; poll++) {
    assert.equal(seen[poll].row.checksState, "SUCCESS", `poll ${poll} holds`);
  }
  for (const released of seen.slice(MAX_UNCONFIRMED_POLLS + 1)) {
    assert.equal(released.row.checksState, "FAILURE");
    assert.equal(released.row.checksUnconfirmed, false);
  }

  // A row first seen unconfirmed gets a baseline once released.
  const fresh = replay(
    Array.from({ length: MAX_UNCONFIRMED_POLLS + 1 }, () => [unconfirmed]),
  );
  assert.equal(fresh.at(-1).row.checksUnconfirmed, false);
});

test("a confirmed poll resets the streak", () => {
  const unconfirmed = row({ checksUnconfirmed: true });
  const seen = replay([
    [row({ checksState: "SUCCESS" })],
    ...Array.from({ length: MAX_UNCONFIRMED_POLLS }, () => [unconfirmed]),
    [row({ checksState: "SUCCESS" })],
    [unconfirmed],
  ]);
  assert.equal(seen[MAX_UNCONFIRMED_POLLS].streak, MAX_UNCONFIRMED_POLLS);
  assert.equal(seen[MAX_UNCONFIRMED_POLLS + 1].streak, 0);
  const after = seen.at(-1);
  assert.equal(after.streak, 1);
  assert.equal(after.row.checksState, "SUCCESS", "a fresh streak holds again");
});

test("a PR that leaves the poll drops its streak", () => {
  const first = mergePollBaseline(
    null,
    [row({ checksUnconfirmed: true }), row({ number: 401 })],
    new Map(),
  );
  assert.deepEqual([...first.streaks], [[400, 1]]);
  const next = mergePollBaseline(
    first.snapshot,
    [row({ number: 401 })],
    first.streaks,
  );
  assert.deepEqual([...next.streaks], []);
  assert.deepEqual([...next.snapshot.keys()], [401]);
});
