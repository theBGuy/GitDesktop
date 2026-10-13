// Pins the run view's loading-frame seed (src/features/actions/run-row-cache.ts):
// only the four list-shaped families under ["repo", repo, "actions"] may seed
// the header, every field is shape-guarded, and the freshest entry wins. The
// `workflows` collision case is the negative control: a prefix scan without
// per-family rejection seeds a workflow as a run and fails it.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedRunRow } from "../src/features/actions/run-row-cache.ts";

const REPO = "C:/repos/demo";
const RUN_ID = 4242;

/** A well-formed WorkflowRun as the list reads return it. */
function run(id, over = {}) {
  return {
    id,
    number: 17,
    displayTitle: `Run ${id}`,
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    headBranch: "main",
    event: "push",
    createdAt: "2026-10-01T12:00:00Z",
    startedAt: "2026-10-01T12:00:05Z",
    updatedAt: "2026-10-01T12:03:00Z",
    url: `https://example.test/runs/${id}`,
    headSha: "abc123",
    workflowDatabaseId: 9,
    ...over,
  };
}

function entry(family, data, dataUpdatedAt = 1000) {
  return {
    key: ["repo", REPO, "actions", family, ""],
    data,
    dataUpdatedAt,
  };
}

function pagedOf(...pages) {
  return {
    pages: pages.map((runs) => ({ runs, totalCount: null, hasMore: true })),
    pageParams: pages.map((_, i) => i + 1),
  };
}

const SEED_FIELDS = [
  "id",
  "number",
  "displayTitle",
  "status",
  "conclusion",
  "workflowName",
  "headBranch",
  "event",
  "createdAt",
  "url",
];

test("runs-paged alone seeds from a deep page", () => {
  const paged = pagedOf([run(1), run(2)], [run(3), run(RUN_ID)]);
  const row = cachedRunRow([entry("runs-paged", paged)], RUN_ID);
  assert.equal(row?.displayTitle, `Run ${RUN_ID}`);
});

test("runs alone seeds", () => {
  const row = cachedRunRow([entry("runs", [run(1), run(RUN_ID)])], RUN_ID);
  assert.equal(row?.id, RUN_ID);
});

test("notify alone seeds", () => {
  const row = cachedRunRow([entry("notify", [run(RUN_ID)])], RUN_ID);
  assert.equal(row?.id, RUN_ID);
});

test("latest alone seeds", () => {
  const row = cachedRunRow([entry("latest", run(RUN_ID))], RUN_ID);
  assert.equal(row?.id, RUN_ID);
});

test("the seed carries exactly the header fields", () => {
  const row = cachedRunRow([entry("runs", [run(RUN_ID)])], RUN_ID);
  assert.deepEqual(Object.keys(row ?? {}).sort(), [...SEED_FIELDS].sort());
});

test("absent from every family: no seed", () => {
  const entries = [
    entry("runs-paged", pagedOf([run(1)], [run(2)])),
    entry("runs", [run(3)]),
    entry("notify", [run(4)]),
    entry("latest", run(5)),
  ];
  assert.equal(cachedRunRow(entries, RUN_ID), undefined);
  assert.equal(cachedRunRow([], RUN_ID), undefined);
});

test("latest holding null: no seed, no throw", () => {
  assert.equal(cachedRunRow([entry("latest", null)], RUN_ID), undefined);
});

test("a workflows entry whose id equals the run id never seeds", () => {
  // A Workflow carrying every run seed field: only the family name keeps it out.
  const workflow = { ...run(RUN_ID), name: "CI", path: ".github/ci.yml" };
  const entries = [
    {
      key: ["repo", REPO, "actions", "workflows"],
      data: [workflow],
      dataUpdatedAt: 1000,
    },
  ];
  assert.equal(cachedRunRow(entries, RUN_ID), undefined);
});

test("detail, log and string-list entries never seed", () => {
  const entries = [
    // RunDetail under "run" carries every seed field too.
    {
      key: ["repo", REPO, "actions", "run", String(RUN_ID)],
      data: { ...run(RUN_ID), jobs: [] },
      dataUpdatedAt: 5000,
    },
    {
      key: ["repo", REPO, "actions", "run", String(RUN_ID), "logs"],
      data: "log text",
      dataUpdatedAt: 5000,
    },
    {
      key: ["repo", REPO, "actions", "job", "77", "logs"],
      data: "job log",
      dataUpdatedAt: 5000,
    },
    {
      key: ["repo", REPO, "actions", "bb-custom-pipelines"],
      data: ["deploy", "nightly"],
      dataUpdatedAt: 5000,
    },
  ];
  assert.equal(cachedRunRow(entries, RUN_ID), undefined);
});

test("a key outside the actions subtree never seeds", () => {
  const entries = [
    {
      key: ["repo", REPO, "pulls", "runs"],
      data: [run(RUN_ID)],
      dataUpdatedAt: 1,
    },
  ];
  assert.equal(cachedRunRow(entries, RUN_ID), undefined);
});

test("a malformed row is skipped while a sibling entry still seeds", () => {
  const { displayTitle: _dropped, ...noTitle } = run(RUN_ID);
  const entries = [
    entry("runs", [noTitle], 9000),
    entry("notify", [run(RUN_ID, { displayTitle: "Good" })], 1000),
  ];
  assert.equal(cachedRunRow(entries, RUN_ID)?.displayTitle, "Good");
});

test("a malformed first duplicate never hides a well-formed later one", () => {
  // runs-paged can repeat a row across a page boundary.
  const { displayTitle: _dropped, ...noTitle } = run(RUN_ID);
  const paged = pagedOf(
    [run(1), noTitle],
    [run(RUN_ID, { displayTitle: "Later copy" })],
  );
  assert.equal(
    cachedRunRow([entry("runs-paged", paged)], RUN_ID)?.displayTitle,
    "Later copy",
  );
  const flat = [noTitle, run(RUN_ID, { displayTitle: "Same list" })];
  assert.equal(
    cachedRunRow([entry("runs", flat)], RUN_ID)?.displayTitle,
    "Same list",
  );
});

test("every seed field with a wrong type is rejected", () => {
  // `id` is the match key itself; the string-id case below covers it.
  for (const field of SEED_FIELDS.filter((f) => f !== "id")) {
    // A number where a string belongs, and a string where `number` belongs.
    const wrong = field === "number" ? "17" : 17;
    for (const value of [null, undefined, wrong]) {
      const bad = run(RUN_ID, { [field]: value });
      assert.equal(
        cachedRunRow([entry("runs", [bad])], RUN_ID),
        undefined,
        `${field}: ${String(value)} must not seed`,
      );
    }
  }
  // An id serialized as a string never matches the numeric run id.
  const stringId = run(RUN_ID, { id: String(RUN_ID) });
  assert.equal(cachedRunRow([entry("runs", [stringId])], RUN_ID), undefined);
});

test("unreadable entry shapes never throw", () => {
  const throwing = {
    get pages() {
      throw new Error("boom");
    },
  };
  const entries = [
    entry("runs-paged", throwing, 9000),
    entry("runs-paged", { pages: "nope" }, 9000),
    entry("runs-paged", { pages: [null, { runs: "x" }, { runs: [null, 3] }] }),
    entry("runs", { not: "an array" }, 9000),
    entry("notify", "text", 9000),
    entry("latest", 42, 9000),
    entry("latest", run(RUN_ID, { displayTitle: "Survivor" }), 1),
  ];
  assert.equal(cachedRunRow(entries, RUN_ID)?.displayTitle, "Survivor");
});

test("the freshest dataUpdatedAt wins across families", () => {
  const entries = [
    entry("runs", [run(RUN_ID, { status: "in_progress" })], 1000),
    entry("notify", [run(RUN_ID, { status: "completed" })], 2000),
    entry("latest", run(RUN_ID, { status: "queued" }), 1500),
  ];
  assert.equal(cachedRunRow(entries, RUN_ID)?.status, "completed");
});

test("equal dataUpdatedAt ties break runs-paged, runs, notify, latest", () => {
  const at = 3000;
  const paged = entry(
    "runs-paged",
    pagedOf([run(RUN_ID, { status: "p" })]),
    at,
  );
  const runs = entry("runs", [run(RUN_ID, { status: "r" })], at);
  const notify = entry("notify", [run(RUN_ID, { status: "n" })], at);
  const latest = entry("latest", run(RUN_ID, { status: "l" }), at);
  assert.equal(
    cachedRunRow([latest, notify, runs, paged], RUN_ID)?.status,
    "p",
  );
  assert.equal(cachedRunRow([latest, notify, runs], RUN_ID)?.status, "r");
  assert.equal(cachedRunRow([latest, notify], RUN_ID)?.status, "n");
  assert.equal(cachedRunRow([latest], RUN_ID)?.status, "l");
});
