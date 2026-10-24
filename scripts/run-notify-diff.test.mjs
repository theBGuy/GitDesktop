// Pins src/features/actions/run-notify-diff.ts: which runs of a branch's latest
// poll the run notifier announces against the previous poll (the prime), and which
// poll may become the first prime. A wrong answer never errors: it either floods a
// backlog of old runs or stays silent on a run that finished, so each arm is a case.
//
// The import reaches straight into `src/` under Node's type stripping; the module's
// one import is the import-free run-status module, so this suite needs no install.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptsAsPrime,
  BETWEEN_POLLS_MAX_MS,
  PRIME_SKEW_MS,
  primeFrom,
  runsToNotify,
} from "../src/features/actions/run-notify-diff.ts";

const T0 = Date.parse("2026-10-24T12:00:00Z");
/** The next idle poll after one fetched at T0. */
const NEXT = T0 + 45_000;
const iso = (ms) => new Date(ms).toISOString();

const run = (id, status, conclusion = "", createdAt = iso(T0)) => ({
  id,
  status,
  conclusion,
  createdAt,
});
const ids = (runs) => runs.map((r) => r.id);

test("the first poll only primes: a null prime announces nothing", () => {
  assert.deepEqual(
    runsToNotify(
      null,
      [run(1, "completed", "success"), run(2, "completed", "failure")],
      NEXT,
    ),
    [],
  );
});

test("a witnessed active-to-completed edge announces success and failure", () => {
  const prime = primeFrom(
    [run(1, "in_progress"), run(2, "queued"), run(3, "waiting")],
    T0,
  );
  const next = [
    run(1, "completed", "success"),
    run(2, "completed", "failure"),
    run(3, "completed", "timed_out"),
  ];
  assert.deepEqual(ids(runsToNotify(prime, next, NEXT)), [1, 2, 3]);
});

test("a witnessed edge announces across any gap: a sleep, an outage, a mute", () => {
  const prime = primeFrom([run(1, "in_progress")], T0);
  assert.deepEqual(
    ids(runsToNotify(prime, [run(1, "completed", "failure")], T0 + 3_600_000)),
    [1],
  );
});

test("skipped, cancelled and neutral conclusions stay quiet", () => {
  const prime = primeFrom(
    [run(1, "in_progress"), run(2, "in_progress"), run(3, "in_progress")],
    T0,
  );
  const next = [
    run(1, "completed", "skipped"),
    run(2, "completed", "cancelled"),
    run(3, "completed", "neutral"),
  ];
  assert.deepEqual(runsToNotify(prime, next, NEXT), []);
});

test("a run still running, or already completed in the prime, announces nothing", () => {
  const prime = primeFrom(
    [run(1, "in_progress"), run(2, "completed", "success")],
    T0,
  );
  assert.deepEqual(
    runsToNotify(
      prime,
      [run(1, "in_progress"), run(2, "completed", "success")],
      NEXT,
    ),
    [],
  );
});

test("a run that started and finished between polls announces once", () => {
  const prime = primeFrom([run(10, "completed", "success")], T0);
  const next = [
    run(11, "completed", "failure"),
    run(10, "completed", "success"),
  ];
  assert.deepEqual(ids(runsToNotify(prime, next, NEXT)), [11]);
  // The next poll primes on it, so it never announces again.
  assert.deepEqual(
    runsToNotify(primeFrom(next, NEXT), next, NEXT + 45_000),
    [],
  );
});

test("between-polls admits only ADJACENT polls: a long gap announces nothing new", () => {
  const prime = primeFrom([run(10, "completed", "success")], T0);
  const next = [run(11, "completed", "failure")];
  // NEGATIVE CONTROL: without the adjacency guard the long gaps announce run 11.
  assert.deepEqual(ids(runsToNotify(prime, next, T0 + 8_000)), [11]);
  assert.deepEqual(
    ids(runsToNotify(prime, next, T0 + BETWEEN_POLLS_MAX_MS)),
    [11],
  );
  assert.deepEqual(
    runsToNotify(prime, next, T0 + BETWEEN_POLLS_MAX_MS + 1),
    [],
  );
  // A machine asleep for an hour, or a forge outage, wakes to the backlog quietly.
  assert.deepEqual(runsToNotify(prime, next, T0 + 3_600_000), []);
  // The empty-prime arm is a between-polls arm too.
  const empty = primeFrom([], T0);
  const fresh = run(7, "completed", "success", iso(T0 + 30_000));
  assert.deepEqual(ids(runsToNotify(empty, [fresh], NEXT)), [7]);
  assert.deepEqual(runsToNotify(empty, [fresh], T0 + 3_600_000), []);
});

test("a backfilled old completed run below the prime's highest id stays quiet", () => {
  // NEGATIVE CONTROL: without the id guard this run announces.
  const prime = primeFrom(
    [run(50, "in_progress"), run(40, "completed", "success")],
    T0,
  );
  assert.deepEqual(
    runsToNotify(
      prime,
      [run(50, "in_progress"), run(30, "completed", "failure")],
      NEXT,
    ),
    [],
  );
});

test("a full 20-run snapshot announces only the new arrival", () => {
  const older = Array.from({ length: 19 }, (_, i) =>
    run(100 - i, "completed", "success"),
  );
  const prime = primeFrom([run(101, "queued"), ...older], T0);
  const next = [
    run(102, "completed", "success"),
    run(101, "completed", "failure"),
    ...older.slice(0, 18),
  ];
  assert.deepEqual(ids(runsToNotify(prime, next, NEXT)), [102, 101]);
});

test("an empty prime admits only runs created after its skew-adjusted fetch time", () => {
  const prime = primeFrom([], T0);
  assert.equal(prime.maxId, null);
  assert.equal(prime.fetchedAt, T0);
  assert.equal(prime.primedAt, T0 - PRIME_SKEW_MS);
  const next = [
    run(7, "completed", "success", iso(T0 + 30_000)),
    // Inside the skew allowance: admitted (a duplicate is absorbed by the dedupe key).
    run(6, "completed", "failure", iso(T0 - PRIME_SKEW_MS + 1_000)),
    // NEGATIVE CONTROL: without the primedAt guard this old run floods in.
    run(5, "completed", "success", iso(T0 - 3_600_000)),
  ];
  assert.deepEqual(ids(runsToNotify(prime, next, NEXT)), [7, 6]);
});

test("an unparseable createdAt on an empty prime stays quiet, never throws", () => {
  const prime = primeFrom([], T0);
  for (const createdAt of ["", "not a date", undefined, null])
    assert.deepEqual(
      runsToNotify(
        prime,
        [{ ...run(1, "completed", "success"), createdAt }],
        NEXT,
      ),
      [],
      String(createdAt),
    );
});

test("an empty poll replaces the prime, so its admission time advances", () => {
  const first = primeFrom([], T0);
  const later = primeFrom([], T0 + 10 * 60_000);
  assert.equal(later.primedAt - first.primedAt, 10 * 60_000);
  // A run created before the later poll no longer counts as new against it.
  const stale = run(3, "completed", "success", iso(T0 + 60_000));
  assert.deepEqual(ids(runsToNotify(first, [stale], NEXT)), [3]);
  assert.deepEqual(runsToNotify(later, [stale], T0 + 10 * 60_000 + 45_000), []);
});

test("conclusion is empty while a run is active and never announces", () => {
  const prime = primeFrom([run(1, "queued")], T0);
  assert.deepEqual(runsToNotify(prime, [run(1, "in_progress", "")], NEXT), []);
});

test("only a poll fetched at or after the notifier enabled may prime", () => {
  const enabledAt = T0;
  // A cached snapshot from before the enable (a revisit, an unmute), however
  // recent, never primes.
  // NEGATIVE CONTROL: accepting any snapshot primes these.
  assert.equal(acceptsAsPrime(enabledAt, T0 - 1), false);
  assert.equal(acceptsAsPrime(enabledAt, T0 - 25 * 60_000), false);
  // The first fetch after it does, the instant included.
  assert.equal(acceptsAsPrime(enabledAt, T0), true);
  assert.equal(acceptsAsPrime(enabledAt, T0 + 3_000), true);
  // Not enabled yet (or disabled with no prime): nothing primes.
  assert.equal(acceptsAsPrime(null, T0 + 3_000), false);
});
