// Pins src/features/pulls/watch-routes.ts: which completion watchers the PR
// checks rollup mounts. A wrong answer never errors: it either fans out a run
// view per watched run when the head poll fails (a rate limit multiplied), or
// leaves a watched run with no watcher at all, so each arm is a case.
//
// The import reaches straight into `src/` under Node's type stripping; the
// module is import-free, so this suite needs no install.
import assert from "node:assert/strict";
import { test } from "node:test";

import { watchRoutes } from "../src/features/pulls/watch-routes.ts";

/** A healthy, answered GitHub head poll carrying runs 1 and 2, rollup open. */
const base = {
  provider: "github",
  headSha: "a".repeat(40),
  headLoaded: true,
  headError: false,
  headIds: new Set(["1", "2"]),
  mountedWatchIds: ["1", "2", "3"],
  runningRunIds: ["1", "3"],
  open: true,
};
const routes = (over) => watchRoutes({ ...base, ...over });

test("off GitHub every watched run takes a run view", () => {
  for (const provider of ["gitlab", "bitbucket", undefined]) {
    assert.deepEqual(routes({ provider, headIds: new Set() }), {
      runViewIds: ["1", "2", "3"],
      jobsReadIds: [],
    });
  }
});

test("a PR with no known head sha takes the per-run path for every run", () => {
  assert.deepEqual(
    routes({ headSha: null, headLoaded: false, headIds: new Set() }),
    { runViewIds: ["1", "2", "3"], jobsReadIds: [] },
  );
});

test("a pending head poll mounts no run views", () => {
  assert.deepEqual(routes({ headLoaded: false, headIds: new Set() }), {
    runViewIds: [],
    jobsReadIds: [],
  });
});

test("an errored head poll over stale data mounts no run views", () => {
  // The stale list still answers the jobs reads it carries.
  assert.deepEqual(routes({ headError: true }), {
    runViewIds: [],
    jobsReadIds: ["1"],
  });
});

test("a healthy head list mounts run views only for runs it doesn't carry", () => {
  assert.deepEqual(routes({}).runViewIds, ["3"]);
  assert.deepEqual(routes({ mountedWatchIds: [] }).runViewIds, []);
});

test("a collapsed rollup reads no jobs", () => {
  assert.deepEqual(routes({ open: false }).jobsReadIds, []);
});

test("an open rollup reads jobs only for running runs the list carries", () => {
  assert.deepEqual(routes({}).jobsReadIds, ["1"]);
  assert.deepEqual(routes({ runningRunIds: [] }).jobsReadIds, []);
});

test("no id is both a run view and a jobs read", () => {
  const { runViewIds, jobsReadIds } = routes({});
  assert.equal(
    runViewIds.some((id) => jobsReadIds.includes(id)),
    false,
  );
});
