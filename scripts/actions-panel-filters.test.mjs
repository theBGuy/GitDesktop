// Pins the Actions tab's facet model and link table
// (src/features/actions/run-filters.ts, src/features/actions/forge-actions-links.ts):
// the facet -> RunFilters mapping, the chip and badge counts, the GitHub
// 1,000-run window rule, the per-provider support/status/event tables, the
// client-side mirror of the backend's filter-value validation, and the link
// rows, whose labels Insights' LinkOutsCard shares. Runs in the no-install
// guards job: both modules import nothing at runtime, and no .tsx is imported.
//
// Each check is a function over the module's export, run on the real export
// and on an in-memory mutant to prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const filters = await import("@/features/actions/run-filters");
const links = await import("@/features/actions/forge-actions-links");

const LINK_OUTS_CARD = new URL(
  "../src/features/repository/insights/LinkOutsCard.tsx",
  import.meta.url,
);

/** Runs `check` on the real value (must pass) and on the mutant (must fail). */
function pinWithMutant(check, real, mutant) {
  assert.deepEqual(check(real), [], "the real export passes");
  assert.notDeepEqual(check(mutant), [], "the mutant fails");
}

function failuresOf(cases) {
  const out = [];
  for (const [name, ok] of cases) if (!ok) out.push(name);
  return out;
}

const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

const checkToRunFilters = (toRunFilters) =>
  failuresOf([
    [
      "current + main",
      same(toRunFilters({ branch: { current: true } }, "main"), {
        branch: "main",
      }),
    ],
    [
      "current + detached",
      same(toRunFilters({ branch: { current: true } }, null), {}),
    ],
    ["named", same(toRunFilters({ branch: { name: "x" } }, "main"), { branch: "x" })],
    [
      "workflow",
      same(toRunFilters({ workflow: { id: 7, name: "CI" } }, null), {
        workflowId: 7,
      }),
    ],
    [
      "actor",
      same(toRunFilters({ actor: { name: "Ada", id: "u" } }, null), {
        actor: "u",
      }),
    ],
    ["empty", same(toRunFilters(filters.EMPTY_FACETS, "main"), {})],
    [
      "all five",
      same(
        toRunFilters(
          {
            workflow: { id: 3, name: "CI" },
            event: "push",
            status: "failure",
            branch: { name: "dev" },
            actor: { name: "a", id: "a" },
          },
          null,
        ),
        {
          branch: "dev",
          workflowId: 3,
          event: "push",
          status: "failure",
          actor: "a",
        },
      ),
    ],
  ]);

test("toRunFilters maps each facet onto the hook's filters, never an empty string", () => {
  pinWithMutant(checkToRunFilters, filters.toRunFilters, (f, c) => {
    const out = filters.toRunFilters(f, c);
    return { ...out, branch: out.branch ?? "" };
  });
});

const checkWindow = (windowApplies) =>
  failuresOf([
    ["github+status", windowApplies("github", { status: "failure" }) === true],
    ["github+workflow only", windowApplies("github", { workflowId: 7 }) === false],
    ["gitlab+status", windowApplies("gitlab", { status: "failed" }) === false],
    ["github+branch", windowApplies("github", { branch: "main" }) === true],
    ["github+event", windowApplies("github", { event: "push" }) === true],
    ["github+actor", windowApplies("github", { actor: "a" }) === true],
    ["github+none", windowApplies("github", {}) === false],
    ["unknown provider", windowApplies(undefined, { branch: "x" }) === false],
  ]);

test("windowApplies anchors on the window only for GitHub's query-param facets", () => {
  pinWithMutant(
    checkWindow,
    filters.windowApplies,
    (p, f) => p === "github" && Object.keys(f).length > 0,
  );
});

test("This branch never chips or counts; a named branch and the rest each chip once", () => {
  const check = ({ chipFacets, activeFacetCount, anyFacetActive }) =>
    failuresOf([
      ["current: no chip", same(chipFacets({ branch: { current: true } }), [])],
      ["current: 0", activeFacetCount({ branch: { current: true } }) === 0],
      ["current: active", anyFacetActive({ branch: { current: true } })],
      ["named: chip", same(chipFacets({ branch: { name: "x" } }), ["branch"])],
      ["named: 1", activeFacetCount({ branch: { name: "x" } }) === 1],
      ["empty: inactive", !anyFacetActive(filters.EMPTY_FACETS)],
      [
        "five set, branch current: 4 chips in order",
        same(
          chipFacets({
            workflow: { id: 1, name: "CI" },
            event: "push",
            status: "failure",
            branch: { current: true },
            actor: { name: "a", id: "a" },
          }),
          ["workflow", "event", "status", "actor"],
        ),
      ],
      [
        "five set, branch named: 5 chips in FACET_ORDER",
        same(
          chipFacets({
            actor: { name: "a", id: "a" },
            branch: { name: "x" },
            status: "failure",
            event: "push",
            workflow: { id: 1, name: "CI" },
          }),
          ["workflow", "event", "status", "branch", "actor"],
        ),
      ],
    ]);
  pinWithMutant(check, filters, {
    ...filters,
    chipFacets: (f) => filters.FACET_ORDER.filter((k) => f[k] !== undefined),
    activeFacetCount: (f) =>
      filters.FACET_ORDER.filter((k) => f[k] !== undefined).length,
  });
  assert.equal(Object.isFrozen(filters.EMPTY_FACETS), true);
  assert.deepEqual(filters.FACET_ORDER, [
    "workflow",
    "event",
    "status",
    "branch",
    "actor",
  ]);
});

const SUPPORT = {
  github: {
    workflow: "picker",
    event: "picker",
    status: "picker",
    branch: "picker+free",
    actor: "picker+free",
  },
  gitlab: {
    workflow: "none",
    event: "picker",
    status: "picker",
    branch: "picker+free",
    actor: "free",
  },
  bitbucket: {
    workflow: "none",
    event: "picker",
    status: "picker",
    branch: "picker+free",
    actor: "picker",
  },
};

test("FACET_SUPPORT holds the 15-cell provider x facet matrix", () => {
  const check = (table) => (same(table, SUPPORT) ? [] : ["matrix differs"]);
  pinWithMutant(check, filters.FACET_SUPPORT, {
    ...filters.FACET_SUPPORT,
    gitlab: { ...filters.FACET_SUPPORT.gitlab, workflow: "picker" },
  });
  assert.equal(
    filters.UNSUPPORTED_FACET_NOTE("gitlab"),
    "Workflow filters aren't available for GitLab pipelines.",
  );
  assert.equal(
    filters.UNSUPPORTED_FACET_NOTE("bitbucket"),
    "Workflow filters aren't available for Bitbucket pipelines.",
  );
});

const STATUS = {
  github: [
    "queued",
    "in_progress",
    "waiting",
    "requested",
    "pending",
    "completed",
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "startup_failure",
    "action_required",
    "neutral",
    "stale",
  ],
  gitlab: [
    "created",
    "waiting_for_resource",
    "preparing",
    "waiting_for_callback",
    "pending",
    "running",
    "success",
    "failed",
    "canceling",
    "canceled",
    "skipped",
    "manual",
    "scheduled",
  ],
  bitbucket: [
    "PARSING",
    "PENDING",
    "PAUSED",
    "HALTED",
    "BUILDING",
    "ERROR",
    "PASSED",
    "FAILED",
    "STOPPED",
    "UNKNOWN",
  ],
};

test("STATUS_FACETS lists each forge's native status values", () => {
  const check = (table) =>
    failuresOf([
      ["github", same([...table.github], STATUS.github)],
      ["gitlab", same([...table.gitlab], STATUS.gitlab)],
      ["bitbucket", same([...table.bitbucket], STATUS.bitbucket)],
    ]);
  pinWithMutant(check, filters.STATUS_FACETS, {
    ...filters.STATUS_FACETS,
    github: filters.STATUS_FACETS.github.filter((s) => s !== "startup_failure"),
  });
  assert.equal(STATUS.github.length, 15);
  assert.equal(STATUS.gitlab.length, 13);
  assert.equal(STATUS.bitbucket.length, 10);
});

test("EVENT_FACETS: GitHub's list ends in dynamic, GitLab's 15 sources, Bitbucket's 4 trigger types", () => {
  const check = (table) =>
    failuresOf([
      ["github has dynamic", table.github.includes("dynamic")],
      ["github has push", table.github.includes("push")],
      ["github count", table.github.length === 33],
      ["gitlab count", table.gitlab.length === 15],
      [
        "gitlab has merge_request_event",
        table.gitlab.includes("merge_request_event"),
      ],
      [
        "bitbucket exact",
        same([...table.bitbucket], ["PUSH", "MANUAL", "SCHEDULED", "PARENT_STEP"]),
      ],
    ]);
  pinWithMutant(check, filters.EVENT_FACETS, {
    ...filters.EVENT_FACETS,
    github: filters.EVENT_FACETS.github.filter((e) => e !== "dynamic"),
  });
});

test("eventOptions merges seen events for GitHub and GitLab but never for Bitbucket", () => {
  assert.deepEqual(filters.eventOptions("bitbucket", ["push", "manual"]), [
    "PUSH",
    "MANUAL",
    "SCHEDULED",
    "PARENT_STEP",
  ]);
  const gh = filters.eventOptions("github", ["zz_custom", "push", "aa_custom"]);
  assert.deepEqual(gh.slice(-2), ["aa_custom", "zz_custom"]);
  assert.equal(gh.filter((e) => e === "push").length, 1);
  const gl = filters.eventOptions("gitlab", ["merge_request_event", "x"]);
  assert.deepEqual(gl.slice(-1), ["x"]);
  assert.deepEqual(filters.branchOptions("main", ["dev", "main", "", "dev"]), [
    "main",
    "dev",
  ]);
  assert.deepEqual(filters.branchOptions(null, ["dev"]), ["dev"]);
});

test("sortWorkflows orders by name with every disabled workflow last", () => {
  const sorted = filters.sortWorkflows([
    { name: "Zeta", state: "active" },
    { name: "alpha", state: "disabled_manually" },
    { name: "CI", state: "active" },
    { name: "beta", state: "deleted" },
    { name: "deploy", state: "active" },
  ]);
  assert.deepEqual(
    sorted.map((w) => w.name),
    ["CI", "deploy", "Zeta", "alpha", "beta"],
  );
});

// Built from char codes so no escape spelling can land as a literal character.
const ch = (code) => String.fromCharCode(code);

const checkVerdict = (verdict) =>
  failuresOf([
    ["main", verdict("main") === "ok"],
    ["feature/x", verdict("feature/x") === "ok"],
    ["empty", verdict("") === "chars"],
    ["spaces only", verdict("   ") === "chars"],
    ["space", verdict("in progress") === "chars"],
    ["newline", verdict(`a${ch(10)}b`) === "chars"],
    ["NUL", verdict(`a${ch(0)}b`) === "chars"],
    ["NEL", verdict(`a${ch(0x85)}b`) === "chars"],
    ["NBSP", verdict(`a${ch(0xa0)}b`) === "chars"],
    ["201 bytes", verdict(ch(0x20ac).repeat(67)) === "length"],
    ["200 bytes", verdict("a".repeat(200)) === "ok"],
    ["200 bytes, 3-byte chars", verdict(`${ch(0x20ac).repeat(66)}ab`) === "ok"],
    ["201 bytes with a space", verdict(`${"a".repeat(200)} `) === "length"],
  ]);

test("facetValueVerdict mirrors the backend's filter-value check, length first", () => {
  pinWithMutant(checkVerdict, filters.facetValueVerdict, (v) =>
    v.length > 200 ? "length" : v.length === 0 ? "chars" : "ok",
  );
  // A copy counting UTF-16 units instead of UTF-8 bytes fails too.
  assert.notDeepEqual(
    checkVerdict((v) =>
      v.length > 200 ? "length" : filters.facetValueVerdict(v.slice(0, 1)),
    ),
    [],
  );
  assert.equal(filters.isValidFacetValue("main"), true);
  assert.equal(filters.isValidFacetValue("a b"), false);
  assert.deepEqual(filters.INVALID_FREE_ENTRY_TEXT, {
    chars: "Can't contain spaces or control characters",
    length: "Too long (over 200 bytes)",
    dash: "Can't start with a hyphen",
  });
});

test("a typed branch is checked as a ref, with no byte cap", () => {
  const long = "b".repeat(300);
  const cases = (verdict) =>
    failuresOf([
      ["feature/x is ok", verdict("feature/x") === "ok"],
      ["300 bytes is ok", verdict(long) === "ok"],
      ["empty is chars", verdict("") === "chars"],
      ["a space is chars", verdict("feature x") === "chars"],
      ["a tab is chars", verdict("a\tb") === "chars"],
      ["a leading hyphen is dash", verdict("-x") === "dash"],
    ]);
  pinWithMutant(cases, filters.branchValueVerdict, filters.facetValueVerdict);
  assert.equal(filters.freeEntryVerdict("branch", long), "ok");
  assert.equal(filters.freeEntryVerdict("actor", long), "length");
  assert.equal(filters.freeEntryVerdict("actor", "-x"), "ok");
});

test("liveFacets drops This branch only on a detached HEAD", () => {
  const pressed = { branch: { current: true }, status: "failure" };
  assert.deepEqual(filters.liveFacets(pressed, null), { status: "failure" });
  assert.equal(filters.liveFacets(pressed, "main"), pressed);
  const named = { branch: { name: "x" } };
  assert.equal(filters.liveFacets(named, null), named);
  assert.equal(
    filters.anyFacetActive(filters.liveFacets({ branch: { current: true } }, null)),
    false,
  );
});

test("facets are kept per repo, newest last, cleared repos dropped, capped", () => {
  const { facetsFor, withRepoFacets, REPO_FACETS_CAP, EMPTY_FACETS } = filters;
  let m = withRepoFacets([], "A", { status: "failure" });
  m = withRepoFacets(m, "B", { event: "push" });
  assert.deepEqual(facetsFor(m, "A"), { status: "failure" });
  assert.deepEqual(facetsFor(m, "B"), { event: "push" });
  assert.equal(facetsFor(m, "C"), EMPTY_FACETS);
  m = withRepoFacets(m, "A", { status: "success" });
  assert.deepEqual(
    m.map((e) => e.repo),
    ["B", "A"],
  );
  m = withRepoFacets(m, "B", EMPTY_FACETS);
  assert.deepEqual(
    m.map((e) => e.repo),
    ["A"],
  );
  for (let i = 0; i < REPO_FACETS_CAP + 3; i++)
    m = withRepoFacets(m, `r${i}`, { event: "push" });
  assert.equal(m.length, REPO_FACETS_CAP);
  assert.equal(facetsFor(m, "A"), EMPTY_FACETS);
  assert.deepEqual(facetsFor(m, `r${REPO_FACETS_CAP + 2}`), { event: "push" });
});

test("chipLabel names the workflow, never its path, and the raw facet values", () => {
  const f = {
    workflow: { id: 1, name: "CI" },
    status: "failure",
    branch: { name: "dev" },
    actor: { name: "Ada Lovelace", id: "{uuid-1}" },
    event: "push",
  };
  assert.deepEqual(filters.chipLabel("workflow", f), {
    facet: "Workflow",
    value: "CI",
  });
  assert.deepEqual(filters.chipLabel("status", f), {
    facet: "Status",
    value: "failure",
  });
  assert.deepEqual(filters.chipLabel("branch", f), {
    facet: "Branch",
    value: "dev",
  });
  assert.deepEqual(filters.chipLabel("actor", f), {
    facet: "Actor",
    value: "Ada Lovelace",
  });
  assert.deepEqual(filters.chipLabel("event", f), {
    facet: "Event",
    value: "push",
  });
  assert.notEqual(
    filters.filtersSignature({ status: "failure" }),
    filters.filtersSignature({ event: "failure" }),
  );
});

/** The (label, suffix) pairs Insights' LinkOutsCard links too. */
const SHARED_PAIRS = [
  ["Actions usage", "/actions/metrics/usage"],
  ["Actions performance", "/actions/metrics/performance"],
  ["CI/CD analytics", "/-/pipelines/charts"],
  ["Deployments", "/deployments"],
];

const checkLinks = (rows, cardSource) => {
  const out = [];
  if (rows.length !== 12) out.push(`12 rows, got ${rows.length}`);
  if (new Set(rows.map((r) => r.id)).size !== rows.length) out.push("ids repeat");
  for (const r of rows)
    if (!r.id.startsWith(`open-actions-${r.provider}-`))
      out.push(`${r.id} doesn't name its provider`);
  for (const [label, suffix] of SHARED_PAIRS) {
    if (!rows.some((r) => r.label === label && r.suffix === suffix))
      out.push(`no row ${label} ${suffix}`);
    if (!cardSource.includes(`{ label: "${label}", suffix: "${suffix}" }`))
      out.push(`LinkOutsCard lacks ${label} ${suffix}`);
  }
  return out;
};

test("ACTIONS_LINKS: 12 provider-named rows sharing LinkOutsCard's labels", () => {
  const card = readFileSync(LINK_OUTS_CARD, "utf8").replace(/\r\n/g, "\n");
  const check = (rows) => checkLinks(rows, card);
  pinWithMutant(
    check,
    links.ACTIONS_LINKS,
    links.ACTIONS_LINKS.map((r) =>
      r.label === "Actions usage" ? { ...r, label: "Usage" } : r,
    ),
  );
  assert.deepEqual(
    links.linksFor("gitlab").map((r) => r.label),
    [
      "Pipelines & caches",
      "Environments",
      "CI/CD settings (runners)",
      "CI/CD analytics",
    ],
  );
  assert.equal(links.linksFor("github").length, 6);
  assert.equal(links.linksFor("bitbucket").length, 2);
  assert.deepEqual(links.linksFor(undefined), []);
  assert.deepEqual(links.linksFor(null), []);
  assert.equal(
    links.ACTIONS_LINKS.find((r) => r.id === "open-actions-github-runners")
      ?.muted,
    "Admins",
  );
  assert.equal(links.manageGroupLabel("GitLab"), "Open on GitLab");
});
