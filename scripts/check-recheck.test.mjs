// Pins src/features/pulls/check-recheck.ts: how the PR checks rollup rescues a
// check the PR still reports pending while its run's head-list row reads
// finished. Each such check attempt reads the head list on first sight, then
// re-reads it with the PR's checks at 15, 30 and 60 s, and never re-arms. A
// wrong answer never errors: it either leaves an outside re-run unpolled, or
// re-reads a finished run forever, so each transition is a case.
//
// The import reaches straight into `src/` under Node's type stripping; the
// module's one import is the import-free run-status module, so this suite needs
// no install.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKS_RECHECK_DELAYS_MS,
  RECHECK_COALESCE_MS,
  recheckIdentities,
  reconcileRecheck,
} from "../src/features/pulls/check-recheck.ts";

const T0 = 1_800_000_000_000;
const SEC = 1000;

const check = (runId, jobId, extra = {}) => ({
  runId,
  jobId,
  name: `job ${jobId}`,
  startedAt: "2026-10-27T10:00:00Z",
  pending: true,
  ...extra,
});
const isPending = (c) => c.pending;
/** The identities of `checks` over `rowsById`, live and active. */
const identities = (checks, rowsById) =>
  recheckIdentities(checks, isPending, rowsById);
const rows = (...entries) =>
  new Map(
    entries.map(([id, status, updatedAt = "u1"]) => [
      id,
      { status, updatedAt },
    ]),
  );

/** Runs one reconcile and returns the next state plus its actions. */
const step = (state, live, visible, now, active) =>
  reconcileRecheck(state, live, visible, now, active);

test("the ladder re-reads at 15, 30 and 60 s, coalescing within 1 s", () => {
  assert.deepEqual([...CHECKS_RECHECK_DELAYS_MS], [15_000, 30_000, 60_000]);
  assert.equal(RECHECK_COALESCE_MS, 1_000);
});

test("an identity is the run plus all its checks' sorted job ids", () => {
  const ids = identities(
    [
      check("1", "j2"),
      check("1", "j1"),
      check("1", "j3", { pending: false }),
      check("2", "j9"),
    ],
    rows(["1", "completed"], ["2", "completed"]),
  );
  assert.deepEqual(ids, { live: ["1|j1,j2,j3", "2|j9"], active: [] });
});

test("only a run whose head row exists and reads finished is a mismatch", () => {
  const pending = [check("1", "a"), check("2", "b"), check("3", "c")];
  // Run 1 finished: in. Run 2 still active: out. Run 3 absent: the per-run
  // fallback's, out.
  // Run 2's row is active: it is reported apart, so it pauses, never resolves.
  assert.deepEqual(
    identities(pending, rows(["1", "completed"], ["2", "in_progress"])),
    { live: ["1|a"], active: ["2|b"] },
  );
  assert.deepEqual(identities([], rows(["1", "completed"])), {
    live: [],
    active: [],
  });
});

test("a run needs a pending check, and a check needs a run id", () => {
  // Every check of run 1 settled: no mismatch, whatever its row says.
  assert.deepEqual(
    identities(
      [
        check("1", "a", { pending: false }),
        check("1", "b", { pending: false }),
      ],
      rows(["1", "completed"]),
    ),
    { live: [], active: [] },
  );
  // A pending check without a run id (an external status) is skipped.
  assert.deepEqual(
    identities(
      [check(undefined, "x"), check("", "y")],
      rows(["1", "completed"]),
    ),
    { live: [], active: [] },
  );
});

test("a check without a job id is identified by name@startedAt", () => {
  const ids = identities(
    [
      check("1", undefined, {
        name: "lint",
        startedAt: "2026-10-27T10:00:00Z",
      }),
    ],
    rows(["1", "completed"]),
  );
  assert.deepEqual(ids.live, ["1|lint@2026-10-27T10:00:00Z"]);
  // Without a start time the name stands alone after the @.
  const bare = identities(
    [check("1", undefined, { name: "lint", startedAt: undefined })],
    rows(["1", "completed"]),
  );
  assert.deepEqual(bare.live, ["1|lint@"]);
});

test("normal finish: the PR lags, then resolves; one head read, steps dropped", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  assert.equal(r.actions.refetchHead, true);
  assert.equal(r.actions.reread, false);
  assert.equal(r.actions.nextDueMs, T0 + 15_000);
  // The PR's next read shows the check finished: the identity leaves the set.
  r = step(r.state, [], true, T0 + 5 * SEC, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
  assert.equal(r.state.get("1|a").done, true);
  // A later lagging snapshot of the same attempt never re-arms it.
  r = step(r.state, ["1|a"], true, T0 + 20 * SEC, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
});

test("an outside re-run after a normal finish gets a new identity", () => {
  // The first attempt finishes while the rollup is open: its check lags the
  // runs list for a moment, then clears.
  const before = rows(["1", "completed", "u1"]);
  let live = identities([check("1", "a")], before).live;
  let r = step(new Map(), live, true, T0, []);
  assert.equal(r.actions.refetchHead, true);
  r = step(r.state, [], true, T0 + 5 * SEC, []);
  // A re-run started in the browser: new check runs (new job ids) appear over
  // the same stale finished row before the head list catches up.
  live = identities([check("1", "b")], before).live;
  r = step(r.state, live, true, T0 + 120 * SEC, []);
  assert.equal(r.actions.refetchHead, true);
  assert.equal(r.actions.nextDueMs, T0 + 135 * SEC);
});

test("a lagging check re-reads at 15, 30 and 60 s, then is done for good", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, ["1|a"], true, T0 + 15_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: T0 + 30_000,
  });
  r = step(r.state, ["1|a"], true, T0 + 30_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: T0 + 60_000,
  });
  r = step(r.state, ["1|a"], true, T0 + 60_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: null,
  });
  assert.equal(r.state.get("1|a").done, true);
  r = step(r.state, ["1|a"], true, T0 + 600_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
});

test("a step is due exactly one coalescing window early, never sooner", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, ["1|a"], true, T0 + 15_000 - RECHECK_COALESCE_MS - 1, []);
  assert.equal(r.actions.reread, false);
  r = step(r.state, ["1|a"], true, T0 + 15_000 - RECHECK_COALESCE_MS, []);
  assert.equal(r.actions.reread, true);
});

test("collapse mid-schedule, then re-open: overdue steps fire once", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, ["1|a"], true, T0 + 15_000, []);
  assert.equal(r.actions.reread, true);
  // Collapsed: nothing fires and nothing resolves.
  r = step(r.state, ["1|a"], false, T0 + 20_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
  // Re-opened past the 30 s step but before 60 s: one re-read, then 60 s.
  r = step(r.state, ["1|a"], true, T0 + 45_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: T0 + 60_000,
  });
  // Re-opened past every step: the remaining ones collapse into one re-read.
  let s = step(new Map(), ["2|b"], true, T0, []).state;
  s = step(s, ["2|b"], false, T0 + 1_000, []).state;
  const late = step(s, ["2|b"], true, T0 + 90_000, []);
  assert.deepEqual(late.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: null,
  });
  assert.equal(late.state.get("2|b").done, true);
});

test("hide and show resume like collapse; the head read never repeats", () => {
  // A tab hide tears the effect down, leaving the state; the show reconciles
  // again from the original first-seen time.
  let r = step(new Map(), ["1|a"], true, T0, []);
  assert.equal(r.actions.refetchHead, true);
  r = step(r.state, ["1|a"], true, T0 + 32_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: T0 + 60_000,
  });
  assert.equal(r.state.get("1|a").firstSeenMs, T0);
});

test("two identities first seen together share one head read and one re-read", () => {
  let r = step(new Map(), ["1|a", "2|b"], true, T0, []);
  assert.equal(r.actions.refetchHead, true);
  r = step(r.state, ["1|a", "2|b"], true, T0 + 15_000, []);
  assert.equal(r.actions.reread, true);
  assert.equal(r.actions.nextDueMs, T0 + 30_000);
  assert.equal(r.state.get("1|a").firedSteps, 1);
  assert.equal(r.state.get("2|b").firedSteps, 1);
  // One seen a moment later still rides the same tick.
  let s = step(new Map(), ["1|a"], true, T0, []).state;
  s = step(s, ["1|a", "2|b"], true, T0 + 400, []).state;
  const tick = step(s, ["1|a", "2|b"], true, T0 + 15_000, []);
  assert.equal(tick.actions.reread, true);
  assert.equal(tick.state.get("2|b").firedSteps, 1);
  assert.equal(tick.actions.nextDueMs, T0 + 30_000);
});

test("an identity gone while hidden is resolved only once visible", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, [], false, T0 + 5_000, []);
  assert.equal(r.state.get("1|a").done, false);
  // Back on screen and still live: it resumes rather than counting as solved.
  r = step(r.state, ["1|a"], true, T0 + 16_000, []);
  assert.equal(r.actions.reread, true);
  // Back on screen and gone: now it is resolved.
  r = step(r.state, [], true, T0 + 17_000, []);
  assert.equal(r.state.get("1|a").done, true);
});

test("a row turning active pauses its identity; the next finish starts afresh", () => {
  // t0: the new attempt's check reads pending over the cached finished row.
  let r = step(new Map(), ["1|a"], true, T0, []);
  assert.equal(r.actions.refetchHead, true);
  // t2s: the forced head read shows the run executing. Paused, not resolved.
  r = step(r.state, [], true, T0 + 2 * SEC, ["1|a"]);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
  assert.equal(r.state.get("1|a").done, false);
  // t300s: the run finished and the PR's read lags: one fresh episode.
  r = step(r.state, ["1|a"], true, T0 + 300 * SEC, []);
  assert.equal(r.actions.refetchHead, true);
  assert.equal(r.actions.nextDueMs, T0 + 315 * SEC);
  r = step(r.state, ["1|a"], true, T0 + 315 * SEC, []);
  assert.equal(r.actions.reread, true);
  // Once the check resolves, the identity is done for good.
  r = step(r.state, [], true, T0 + 320 * SEC, []);
  assert.equal(r.state.get("1|a").done, true);
});

test("a sibling job settling mid-ladder keeps the identity and its schedule", () => {
  const finished = rows(["1", "completed"]);
  const both = identities([check("1", "a"), check("1", "b")], finished).live;
  let r = step(new Map(), both, true, T0, []);
  // Job b settles; job a still reads pending.
  const one = identities(
    [check("1", "a"), check("1", "b", { pending: false })],
    finished,
  ).live;
  assert.deepEqual(one, both);
  r = step(r.state, one, true, T0 + 15_000, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: true,
    nextDueMs: T0 + 30_000,
  });
});

test("a partial re-run (one job's id changes) is a new identity", () => {
  const finished = rows(["1", "completed"]);
  const first = identities(
    [check("1", "a", { pending: false }), check("1", "b")],
    finished,
  ).live;
  const rerun = identities(
    [check("1", "a", { pending: false }), check("1", "b2")],
    finished,
  ).live;
  assert.notDeepEqual(first, rerun);
  let r = step(new Map(), first, true, T0, []);
  r = step(r.state, [], true, T0 + 5 * SEC, []);
  r = step(r.state, rerun, true, T0 + 60 * SEC, []);
  assert.equal(r.actions.refetchHead, true);
});

test("a paused identity whose check resolves is done for good", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, [], true, T0 + 2 * SEC, ["1|a"]);
  // The check stops reading pending while the run executes: resolved.
  r = step(r.state, [], true, T0 + 10 * SEC, []);
  assert.equal(r.state.get("1|a").done, true);
  assert.equal(r.state.get("1|a").paused, false);
  // A lagging snapshot of the same attempt later never re-arms it.
  r = step(r.state, ["1|a"], true, T0 + 300 * SEC, []);
  assert.deepEqual(r.actions, {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  });
});

test("a used-up ladder seen executing pauses, then its finish starts afresh", () => {
  let r = step(new Map(), ["1|a"], true, T0, []);
  r = step(r.state, ["1|a"], true, T0 + 60_000, []);
  assert.equal(r.state.get("1|a").done, true);
  // The check still reads stale; the head list then shows the run executing.
  r = step(r.state, [], true, T0 + 100 * SEC, ["1|a"]);
  assert.equal(r.state.get("1|a").paused, true);
  // It finishes and the PR's read lags: one fresh episode.
  r = step(r.state, ["1|a"], true, T0 + 300 * SEC, []);
  assert.equal(r.actions.refetchHead, true);
  assert.equal(r.actions.nextDueMs, T0 + 315 * SEC);
});
