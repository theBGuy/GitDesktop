// Pins src/lib/github/run-poll.ts: how often each CI run-watching read polls,
// laddered by the age of the run's current attempt. A wrong answer never errors:
// it either spends the shared GitHub budget on a run nobody is waiting on, or
// reports a finished run late, so each arm is a case.
//
// The imports reach straight into `src/` under Node's type stripping; both
// modules' one import is the import-free run-status module, so this suite needs
// no install.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyPollInterval } from "../src/features/actions/run-notify-diff.ts";
import {
  headRunsPollIntervalMs,
  listRunsPollIntervalMs,
  newestJobStartedAt,
  RUN_POLL_FAST_MS,
  RUN_POLL_MID_MS,
  RUN_POLL_SLOW_MS,
  runDetailPollIntervalMs,
  runJobsPollIntervalMs,
  runPollIntervalMs,
  runsPollIntervalMs,
} from "../src/lib/github/run-poll.ts";

const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);
const SEC = 1000;
const MIN = 60 * SEC;

const run = (status, createdAt, extra = {}) => ({
  status,
  createdAt,
  ...extra,
});

test("the tier constants are the ladder the spec pins", () => {
  assert.equal(RUN_POLL_FAST_MS, 5000);
  assert.equal(RUN_POLL_MID_MS, 15_000);
  assert.equal(RUN_POLL_SLOW_MS, 60_000);
});

test("an active run ladders by age: fresh 5 s, then 15 s, then 60 s", () => {
  assert.equal(runPollIntervalMs(run("in_progress", ago(MIN)), NOW), 5000);
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(5 * MIN)), NOW),
    15_000,
  );
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(30 * MIN)), NOW),
    60_000,
  );
});

test("the tier edges: 2 min starts the mid tier, 10 min the slow one", () => {
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(2 * MIN)), NOW),
    15_000,
  );
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(2 * MIN - 1)), NOW),
    5000,
  );
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(10 * MIN)), NOW),
    60_000,
  );
  assert.equal(
    runPollIntervalMs(run("in_progress", ago(10 * MIN - 1)), NOW),
    15_000,
  );
});

test("a waiting run polls slowly at any age: only an approval moves it", () => {
  assert.equal(runPollIntervalMs(run("waiting", ago(10 * SEC)), NOW), 60_000);
  assert.equal(runPollIntervalMs(run("waiting", ago(30 * MIN)), NOW), 60_000);
});

test("a finished run contributes no poll at any age", () => {
  assert.equal(runPollIntervalMs(run("completed", ago(MIN)), NOW), false);
  assert.equal(runPollIntervalMs(run("completed", ago(30 * MIN)), NOW), false);
});

test("an unreadable or future basis fails toward the fast tier", () => {
  assert.equal(runPollIntervalMs(run("in_progress", ""), NOW), 5000);
  assert.equal(runPollIntervalMs(run("in_progress", "not a date"), NOW), 5000);
  assert.equal(
    runPollIntervalMs(run("in_progress", iso(NOW + 60 * MIN)), NOW),
    5000,
  );
});

test("queued, pending and requested runs ladder by age like in_progress", () => {
  for (const status of ["queued", "pending", "requested"]) {
    assert.equal(runPollIntervalMs(run(status, ago(MIN)), NOW), 5000, status);
    assert.equal(
      runPollIntervalMs(run(status, ago(5 * MIN)), NOW),
      15_000,
      status,
    );
    assert.equal(
      runPollIntervalMs(run(status, ago(30 * MIN)), NOW),
      60_000,
      status,
    );
  }
});

test("a re-run's attempt start, not the run's creation, sets the cadence", () => {
  assert.equal(
    runPollIntervalMs(
      run("in_progress", ago(7 * 24 * 60 * MIN), { startedAt: ago(MIN) }),
      NOW,
    ),
    5000,
  );
  // An empty or unreadable start falls back to the creation time.
  assert.equal(
    runPollIntervalMs(
      run("in_progress", ago(30 * MIN), { startedAt: "" }),
      NOW,
    ),
    60_000,
  );
  assert.equal(
    runPollIntervalMs(
      run("in_progress", ago(30 * MIN), { startedAt: "garbage" }),
      NOW,
    ),
    60_000,
  );
});

test("newestJobStartedAt picks the latest readable job start", () => {
  const a = ago(30 * MIN);
  const b = ago(MIN);
  assert.equal(
    newestJobStartedAt([{ startedAt: a }, { startedAt: b }, { startedAt: "" }]),
    b,
  );
  assert.equal(newestJobStartedAt([{ startedAt: b }, { startedAt: a }]), b);
  assert.equal(newestJobStartedAt([]), "");
  assert.equal(
    newestJobStartedAt([{ startedAt: "" }, { startedAt: "nope" }]),
    "",
  );
});

test("runsPollIntervalMs takes the fastest active run, or stops", () => {
  assert.equal(
    runsPollIntervalMs(
      [run("completed", ago(MIN)), run("in_progress", ago(5 * MIN))],
      NOW,
    ),
    15_000,
  );
  assert.equal(
    runsPollIntervalMs(
      [run("completed", ago(MIN)), run("completed", ago(MIN))],
      NOW,
    ),
    false,
  );
  assert.equal(runsPollIntervalMs([], NOW), false);
  assert.equal(runsPollIntervalMs(undefined, NOW), false);
  assert.equal(
    runsPollIntervalMs(
      [run("waiting", ago(30 * MIN)), run("in_progress", ago(MIN))],
      NOW,
    ),
    5000,
  );
});

test("listRunsPollIntervalMs: the newest run's ladder drives the fast arm", () => {
  assert.equal(
    listRunsPollIntervalMs(
      [run("in_progress", ago(MIN)), run("completed", ago(MIN))],
      NOW,
    ),
    5000,
  );
  assert.equal(
    listRunsPollIntervalMs(
      [run("in_progress", ago(30 * MIN)), run("completed", ago(MIN))],
      NOW,
    ),
    60_000,
  );
  // A newest run held for approval no longer pins the fast cadence.
  assert.equal(
    listRunsPollIntervalMs(
      [run("waiting", ago(10 * SEC)), run("completed", ago(MIN))],
      NOW,
    ),
    60_000,
  );
});

test("listRunsPollIntervalMs: a same-push executing run is fast too", () => {
  assert.equal(
    listRunsPollIntervalMs(
      [
        run("completed", ago(MIN), { headSha: "abc" }),
        run("in_progress", ago(MIN), { headSha: "abc" }),
      ],
      NOW,
    ),
    5000,
  );
});

test("listRunsPollIntervalMs: other active runs hold the list at 60 s", () => {
  // A different push's run, and an old waiting sibling, only hold.
  assert.equal(
    listRunsPollIntervalMs(
      [
        run("completed", ago(MIN), { headSha: "abc" }),
        run("in_progress", ago(MIN), { headSha: "def" }),
      ],
      NOW,
    ),
    60_000,
  );
  assert.equal(
    listRunsPollIntervalMs(
      [
        run("completed", ago(MIN), { headSha: "abc" }),
        run("waiting", ago(30 * MIN), { headSha: "abc" }),
      ],
      NOW,
    ),
    60_000,
  );
  // An empty newest sha never matches a sibling's empty sha.
  assert.equal(
    listRunsPollIntervalMs(
      [
        run("completed", ago(MIN), { headSha: "" }),
        run("in_progress", ago(MIN), { headSha: "" }),
      ],
      NOW,
    ),
    60_000,
  );
});

test("listRunsPollIntervalMs: nothing active stops the poll", () => {
  assert.equal(
    listRunsPollIntervalMs(
      [run("completed", ago(MIN)), run("completed", ago(MIN))],
      NOW,
    ),
    false,
  );
  assert.equal(listRunsPollIntervalMs([], NOW), false);
  assert.equal(listRunsPollIntervalMs(undefined, NOW), false);
});

// Congruence with notifyPollInterval (src/features/actions/run-notify-diff.ts,
// pinned by scripts/run-notify-diff.test.mjs): both modules spell the same
// fast-arm rule, a newest active run or an executing run of the newest run's
// push, so a change to either rule reddens this case. Every run here is fresh,
// so the list's fast arm answers the fast tier. A newest `waiting` run is left
// out on purpose: the list ladders it to the slow tier, the notifier does not.
test("the list's fast arm agrees with notifyPollInterval", () => {
  const fx = (status, headSha, id) => ({
    id,
    status,
    conclusion: "",
    createdAt: ago(MIN),
    headSha,
  });
  const fixtures = [
    [[fx("in_progress", "abc", 2), fx("completed", "abc", 1)], true],
    [[fx("queued", "abc", 2), fx("completed", "abc", 1)], true],
    [[fx("pending", "abc", 1)], true],
    [[fx("completed", "abc", 2), fx("in_progress", "abc", 1)], true],
    [[fx("completed", "abc", 2), fx("queued", "abc", 1)], false],
    [[fx("completed", "abc", 2), fx("in_progress", "def", 1)], false],
    [[fx("completed", "", 2), fx("in_progress", "", 1)], false],
    [[fx("completed", "abc", 2), fx("completed", "abc", 1)], false],
    [[], false],
  ];
  for (const [runs, fast] of fixtures) {
    const list = listRunsPollIntervalMs(runs, NOW);
    const listFast = list !== false && list < RUN_POLL_SLOW_MS;
    const notifyFast = notifyPollInterval(runs) < 45_000;
    assert.equal(listFast, fast, JSON.stringify(runs));
    assert.equal(notifyFast, fast, JSON.stringify(runs));
  }
});

test("a run detail with no active job polls fast: a re-run's new attempt", () => {
  const created = ago(7 * 24 * 60 * MIN);
  const oldJobs = [
    { status: "completed", startedAt: ago(7 * 24 * 60 * MIN - SEC) },
  ];
  // Re-run queued with the previous attempt's finished jobs still loaded.
  assert.equal(
    runDetailPollIntervalMs(
      { status: "queued", createdAt: created, jobs: oldJobs },
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // Active with no jobs loaded at all.
  assert.equal(
    runDetailPollIntervalMs(
      { status: "in_progress", createdAt: created, jobs: [] },
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // A held run stays slow even with no active job.
  assert.equal(
    runDetailPollIntervalMs(
      { status: "waiting", createdAt: created, jobs: [] },
      NOW,
    ),
    RUN_POLL_SLOW_MS,
  );
  assert.equal(
    runDetailPollIntervalMs(
      { status: "completed", createdAt: created, jobs: oldJobs },
      NOW,
    ),
    false,
  );
});

test("a run detail ladders from max(createdAt, newest job start)", () => {
  const job = (status, startedAt) => ({ status, startedAt });
  // An active job of a fresh attempt sets the basis.
  assert.equal(
    runDetailPollIntervalMs(
      {
        status: "in_progress",
        createdAt: ago(60 * MIN),
        jobs: [job("in_progress", ago(MIN))],
      },
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // A job start earlier than createdAt never ages the run past it.
  assert.equal(
    runDetailPollIntervalMs(
      {
        status: "in_progress",
        createdAt: ago(5 * MIN),
        jobs: [job("in_progress", ago(60 * MIN))],
      },
      NOW,
    ),
    RUN_POLL_MID_MS,
  );
  // A Go-zero start (Date.parse accepts it) and an unreadable one are ignored,
  // so with no readable createdAt either the basis is unknown: the fast tier.
  assert.equal(
    runDetailPollIntervalMs(
      {
        status: "in_progress",
        createdAt: "",
        jobs: [
          job("in_progress", "0001-01-01T00:00:00Z"),
          job("queued", "garbage"),
        ],
      },
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // A readable job start still sets the basis when createdAt is unreadable.
  assert.equal(
    runDetailPollIntervalMs(
      {
        status: "in_progress",
        createdAt: "",
        jobs: [job("in_progress", ago(30 * MIN))],
      },
      NOW,
    ),
    RUN_POLL_SLOW_MS,
  );
  assert.equal(
    newestJobStartedAt([
      { startedAt: "0001-01-01T00:00:00Z" },
      { startedAt: "" },
    ]),
    "",
  );
});

test("a jobs read keeps polling while its run row is active", () => {
  const done = [{ status: "completed" }, { status: "completed" }];
  // Re-run started elsewhere: row active, cached jobs all from the old attempt.
  assert.equal(
    runJobsPollIntervalMs(done, run("in_progress", ago(MIN)), NOW),
    RUN_POLL_FAST_MS,
  );
  assert.equal(
    runJobsPollIntervalMs(done, run("in_progress", ago(5 * MIN)), NOW),
    RUN_POLL_MID_MS,
  );
  // Row finished and every job finished: the read parks.
  assert.equal(
    runJobsPollIntervalMs(done, run("completed", ago(MIN)), NOW),
    false,
  );
  // No row and every job finished: parks too.
  assert.equal(runJobsPollIntervalMs(done, null, NOW), false);
  // Nothing loaded yet with no row: the fast tier.
  assert.equal(runJobsPollIntervalMs(undefined, null, NOW), RUN_POLL_FAST_MS);
  // An active job with no row keeps the fast tier.
  assert.equal(
    runJobsPollIntervalMs([{ status: "in_progress" }], null, NOW),
    RUN_POLL_FAST_MS,
  );
});

test("a pending check whose head row reads finished keeps the head poll awake", () => {
  const row = (id, status, createdAt = ago(MIN)) => ({ id, status, createdAt });
  const done = [row(1, "completed"), row(2, "completed")];
  // Nothing pending and nothing active: the poll stops.
  assert.equal(headRunsPollIntervalMs(done, [], NOW), false);
  // The PR still reports run 2 pending while its row reads finished: a new
  // attempt may be starting, so the poll keeps the mid tier.
  assert.equal(headRunsPollIntervalMs(done, ["2"], NOW), RUN_POLL_MID_MS);
  // A pending run whose row is active keeps its own faster ladder tier.
  assert.equal(
    headRunsPollIntervalMs(
      [row(1, "completed"), row(2, "in_progress")],
      ["2"],
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // A pending id the list does not carry changes nothing: the per-run
  // fallback watches it.
  assert.equal(headRunsPollIntervalMs(done, ["3"], NOW), false);
  assert.equal(
    headRunsPollIntervalMs(
      [row(1, "in_progress", ago(5 * MIN)), row(2, "completed")],
      ["3"],
      NOW,
    ),
    RUN_POLL_MID_MS,
  );
  // An active fresh row elsewhere outranks the finished pending row.
  assert.equal(
    headRunsPollIntervalMs(
      [row(1, "in_progress"), row(2, "completed")],
      ["2"],
      NOW,
    ),
    RUN_POLL_FAST_MS,
  );
  // A slow active row elsewhere is lifted to the mid tier by the pending row.
  assert.equal(
    headRunsPollIntervalMs(
      [row(1, "in_progress", ago(30 * MIN)), row(2, "completed")],
      ["2"],
      NOW,
    ),
    RUN_POLL_MID_MS,
  );
  // Empty or unanswered rows: the base value.
  assert.equal(headRunsPollIntervalMs([], ["2"], NOW), false);
  assert.equal(headRunsPollIntervalMs(undefined, ["2"], NOW), false);
});
