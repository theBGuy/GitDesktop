// Pins the PR checks rollup's re-run offer derivation — the rules that decide
// which runs the button acts on. Each guard here answers a failure that either
// acts on the wrong run or withholds the offer forever: a timestamp-less status
// context borrowing another repo's run id, a GitHub re-run rejected because the
// run is still in flight, a GitLab pipeline permanently gated by its own manual
// job, and a latch that frees or strands itself on a snapshot transient.
//
// The import reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES
// types rather than compiling them and resolves no bundler aliases, so
// `checks-rerun.ts` must keep every import type-only. A runtime import added
// there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failedRunSignatures,
  rerunnableRuns,
} from "../src/features/pulls/checks-rerun.ts";

/** The presentation buckets the rollup passes in, keyed off the raw status the
 *  forge reported — the shape `checkPresentation` produces, without its icons. */
const bucketOf = (check) => {
  const s = check.status.toUpperCase();
  if (s === "SUCCESS") return "passed";
  if (["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"].includes(s))
    return "failed";
  if (["CANCELLED", "SKIPPED", "NEUTRAL", "STALE"].includes(s))
    return "skipped";
  return "pending";
};

const check = (over) => ({ name: "build", status: "FAILURE", ...over });

const offer = (over) =>
  rerunnableRuns({
    checks: [],
    bucketOf,
    runningRunIds: [],
    latched: new Map(),
    provider: "github",
    ...over,
  });

test("a failed check with no completion time contributes no run", () => {
  // The measured StatusContext shape: an external check whose targetUrl happens
  // to parse as an Actions-run URL, reported FAILURE with no timestamps. The id
  // can name another repository's run, so it must never reach the offer.
  const checks = [
    check({ name: "external", runId: "999", completedAt: undefined }),
    check({ name: "build", runId: "7", completedAt: "2026-01-01T10:00:00Z" }),
  ];
  assert.deepEqual(
    failedRunSignatures(checks, bucketOf),
    new Map([["7", "2026-01-01T10:00:00Z"]]),
  );
  assert.deepEqual(offer({ checks }), [["7", "2026-01-01T10:00:00Z"]]);
});

test("a run's signature joins its failed checks' completions, sorted", () => {
  const checks = [
    check({ name: "b", runId: "7", completedAt: "2026-01-01T10:05:00Z" }),
    check({ name: "a", runId: "7", completedAt: "2026-01-01T10:01:00Z" }),
    check({ name: "ok", runId: "7", status: "SUCCESS", completedAt: "x" }),
  ];
  assert.deepEqual(
    failedRunSignatures(checks, bucketOf),
    new Map([["7", "2026-01-01T10:01:00Z 2026-01-01T10:05:00Z"]]),
    "only failed checks, and order of arrival does not change the signature",
  );
});

test("GitHub drops a run that still has a job in flight", () => {
  // One run can hold a failed check while a sibling job runs on, and GitHub
  // refuses to re-run a run that has not finished.
  const checks = [
    check({ runId: "7", completedAt: "t1" }),
    check({ runId: "8", completedAt: "t2" }),
  ];
  assert.deepEqual(
    offer({ checks, runningRunIds: ["7"] }).map(([id]) => id),
    ["8"],
  );
});

test("GitLab keeps a run its pending bucket would have gated", () => {
  // GitLab collapses running/pending/manual into one PENDING check status, so an
  // activity gate would hide the offer forever on a pipeline with a manual job.
  const checks = [check({ runId: "7", completedAt: "t1" })];
  assert.deepEqual(
    offer({ checks, runningRunIds: ["7"], provider: "gitlab" }).map(
      ([id]) => id,
    ),
    ["7"],
    "the running-run subtraction is GitHub-only",
  );
});

test("a latched run stays out while its signature is unchanged", () => {
  const checks = [check({ runId: "7", completedAt: "t1" })];
  assert.deepEqual(
    offer({ checks, latched: new Map([["7", "t1"]]) }),
    [],
    "a stale-FAILED read that never showed the pending window keeps it retired",
  );
});

test("a changed signature releases the latch", () => {
  // Both forges stamp a fresh completion per attempt, so a different signature
  // IS a new attempt's failure — no pending snapshot need ever be observed.
  const checks = [check({ runId: "7", completedAt: "t2" })];
  assert.deepEqual(offer({ checks, latched: new Map([["7", "t1"]]) }), [
    ["7", "t2"],
  ]);
});

test("a raced-empty snapshot offers nothing and leaves the latch standing", () => {
  const latched = new Map([["7", "t1"]]);
  assert.deepEqual(offer({ checks: [], latched }), [], "nothing to offer");
  assert.deepEqual(
    latched,
    new Map([["7", "t1"]]),
    "the caller's latch is untouched",
  );
  // …and the pre-re-run read that follows must not re-offer the run.
  assert.deepEqual(
    offer({ checks: [check({ runId: "7", completedAt: "t1" })], latched }),
    [],
  );
});

test("an unsettled provider still derives runs, and the gates above decide", () => {
  // `undefined` = the forge probe has not answered; the component gates rendering
  // on that separately, so the derivation must not silently empty here.
  const checks = [check({ runId: "7", completedAt: "t1" })];
  assert.deepEqual(
    offer({ checks, provider: undefined }).map(([id]) => id),
    ["7"],
  );
});
