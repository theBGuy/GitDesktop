// The Actions tab's server-side run filters: the facet model the panel keeps,
// its mapping onto the hook's RunFilters, and the per-provider tables the
// popover offers. Runtime-import-free (type imports only), so the install-less
// guards job can import it; labels that need status.tsx live in the .tsx layer.
import type { ForgeProvider, ProviderName } from "@/lib/git/types";
import type { RunFilters, Workflow } from "@/lib/github/actions";

/** "This branch" follows HEAD; a branch picked by name stays put. */
export type BranchFacet = { current: true } | { name: string };

export interface Facets {
  workflow?: { id: number; name: string };
  event?: string;
  status?: string;
  branch?: BranchFacet;
  actor?: { name: string; id: string };
}

export const EMPTY_FACETS: Facets = Object.freeze({});

export type FacetKind = "workflow" | "event" | "status" | "branch" | "actor";

/** Chip and popover-group order. */
export const FACET_ORDER: readonly FacetKind[] = [
  "workflow",
  "event",
  "status",
  "branch",
  "actor",
];

function isCurrentBranch(b: BranchFacet | undefined): b is { current: true } {
  return b !== undefined && "current" in b;
}

function branchValue(
  b: BranchFacet | undefined,
  currentBranch: string | null,
): string | undefined {
  if (b === undefined) return undefined;
  return "current" in b ? (currentBranch ?? undefined) : b.name;
}

/** The hook's filters for a facet set. A detached HEAD under "This branch"
 *  sends no branch at all, and an empty string is never emitted. */
export function toRunFilters(
  f: Facets,
  currentBranch: string | null,
): RunFilters {
  const out: RunFilters = {};
  const branch = branchValue(f.branch, currentBranch);
  if (branch) out.branch = branch;
  if (f.workflow) out.workflowId = f.workflow.id;
  if (f.event) out.event = f.event;
  if (f.status) out.status = f.status;
  if (f.actor?.id) out.actor = f.actor.id;
  return out;
}

function facetSet(f: Facets, kind: FacetKind): boolean {
  return f[kind] !== undefined && f[kind] !== "";
}

/** The set facets that render a chip: "This branch" is shown by its pressed
 *  toggle instead, so it never chips and never counts on the funnel. */
export function chipFacets(f: Facets): FacetKind[] {
  return FACET_ORDER.filter(
    (k) => facetSet(f, k) && !(k === "branch" && isCurrentBranch(f.branch)),
  );
}

export function activeFacetCount(f: Facets): number {
  return chipFacets(f).length;
}

export function anyFacetActive(f: Facets): boolean {
  return chipFacets(f).length > 0 || isCurrentBranch(f.branch);
}

/** The facets that narrow the read: "This branch" on a detached HEAD sends no
 *  branch (toRunFilters), so it narrows nothing and counts as inactive. */
export function liveFacets(f: Facets, currentBranch: string | null): Facets {
  return isCurrentBranch(f.branch) && currentBranch === null
    ? withoutFacet(f, "branch")
    : f;
}

/** Facets per repo, most recently changed last; a repo whose facets clear
 *  drops out, and only the newest REPO_FACETS_CAP repos are kept. */
export type RepoFacets = readonly { repo: string; facets: Facets }[];

export const REPO_FACETS_CAP = 8;

export function facetsFor(m: RepoFacets, repo: string): Facets {
  return m.find((e) => e.repo === repo)?.facets ?? EMPTY_FACETS;
}

export function withRepoFacets(
  m: RepoFacets,
  repo: string,
  facets: Facets,
): RepoFacets {
  const rest = m.filter((e) => e.repo !== repo);
  const next = anyFacetActive(facets) ? [...rest, { repo, facets }] : rest;
  return next.slice(-REPO_FACETS_CAP);
}

export function withFacet<K extends FacetKind>(
  f: Facets,
  kind: K,
  value: NonNullable<Facets[K]>,
): Facets {
  return { ...f, [kind]: value };
}

export function withoutFacet(f: Facets, kind: FacetKind): Facets {
  const next = { ...f };
  delete next[kind];
  return next;
}

/** A popover row picked: sets its facet, replacing that facet's value. A
 *  branch picked by name stays put even when it is the current branch. */
export function withPicked(
  f: Facets,
  item: { kind: FacetKind; value: string; label: string },
): Facets {
  switch (item.kind) {
    case "workflow":
      return withFacet(f, "workflow", {
        id: Number(item.value),
        name: item.label,
      });
    case "branch":
      return withFacet(f, "branch", { name: item.value });
    case "actor":
      return withFacet(f, "actor", { name: item.label, id: item.value });
    default:
      return withFacet(f, item.kind, item.value);
  }
}

/** One string per distinct filter set, for change detection. */
export function filtersSignature(filters: RunFilters): string {
  return JSON.stringify([
    filters.branch ?? null,
    filters.workflowId ?? null,
    filters.event ?? null,
    filters.status ?? null,
    filters.actor ?? null,
  ]);
}

/** GitHub caps filtered run queries: totals floor at 2,500 and only 1,000 rows
 *  page (measured 2026-09-27). A branch-filtered total is an unmarked floor past
 *  a window paging can never reach, so the count line anchors on the window.
 *  The cap is GitHub's, so other providers' totals render as reported. */
export const FILTERED_RUN_WINDOW = 1000;

/** Whether the count line anchors on FILTERED_RUN_WINDOW: GitHub's query-param
 *  facets page through the capped search, while a workflow filter alone reads
 *  the workflow's own run list and reports its real total. */
export function windowApplies(
  provider: ForgeProvider | null | undefined,
  filters: RunFilters,
): boolean {
  return (
    provider === "github" &&
    !!(filters.branch || filters.event || filters.status || filters.actor)
  );
}

export type FacetSupport = "picker" | "free" | "picker+free" | "none";

/** What each forge can filter on: "picker" offers known values, "free" takes a
 *  typed value, "none" omits the group. GitLab and Bitbucket have no workflow
 *  entity; GitLab's pipeline list carries no user to suggest; Bitbucket filters
 *  by creator uuid, which nobody can type. */
export const FACET_SUPPORT: Record<
  ForgeProvider,
  Record<FacetKind, FacetSupport>
> = {
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

const PIPELINE_PROVIDER_NAMES: Record<"gitlab" | "bitbucket", ProviderName> = {
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

export const UNSUPPORTED_FACET_NOTE = (provider: "gitlab" | "bitbucket") =>
  `Workflow filters aren't available for ${PIPELINE_PROVIDER_NAMES[provider]} pipelines.`;

/** Each forge's own status filter values, sent as is. */
export const STATUS_FACETS: Record<ForgeProvider, readonly string[]> = {
  // The REST run-list enum, plus gh's startup_failure.
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

/** Each forge's event (trigger) filter values. GitHub's and GitLab's popovers
 *  add events seen on loaded rows; Bitbucket's rows carry lowercased trigger
 *  names its filter doesn't take, so it offers this list alone. */
export const EVENT_FACETS: Record<ForgeProvider, readonly string[]> = {
  github: [
    "push",
    "pull_request",
    "pull_request_target",
    "workflow_dispatch",
    "schedule",
    "release",
    "issues",
    "issue_comment",
    "workflow_run",
    "workflow_call",
    "repository_dispatch",
    "create",
    "delete",
    "deployment",
    "deployment_status",
    "discussion",
    "discussion_comment",
    "fork",
    "gollum",
    "label",
    "merge_group",
    "milestone",
    "page_build",
    "public",
    "pull_request_review",
    "pull_request_review_comment",
    "registry_package",
    "status",
    "watch",
    "branch_protection_rule",
    "check_run",
    "check_suite",
    "dynamic",
  ],
  // CI_PIPELINE_SOURCE values, sent as `source=`.
  gitlab: [
    "push",
    "web",
    "trigger",
    "schedule",
    "api",
    "external",
    "pipeline",
    "chat",
    "webide",
    "merge_request_event",
    "external_pull_request_event",
    "parent_pipeline",
    "ondemand_dast_scan",
    "ondemand_dast_validation",
    "security_orchestration_policy",
  ],
  // `trigger_type=` values.
  bitbucket: ["PUSH", "MANUAL", "SCHEDULED", "PARENT_STEP"],
};

/** The popover's Event rows: the fixed list, then (GitHub, GitLab) any other
 *  event seen on loaded rows, sorted. */
export function eventOptions(
  provider: ForgeProvider,
  seen: readonly string[],
): string[] {
  const fixed = EVENT_FACETS[provider];
  if (provider === "bitbucket") return [...fixed];
  const extras = [...new Set(seen)]
    .filter((e) => e !== "" && !fixed.includes(e))
    .sort((a, b) => a.localeCompare(b));
  return [...fixed, ...extras];
}

/** The popover's Branch rows: the current branch first, then branches seen on
 *  loaded rows, deduped, never empty. */
export function branchOptions(
  currentBranch: string | null,
  seen: readonly string[],
): string[] {
  const out = currentBranch ? [currentBranch] : [];
  for (const b of seen) if (b !== "" && !out.includes(b)) out.push(b);
  return out;
}

/** Every state but "active" (disabled_manually, disabled_inactivity, the REST
 *  enum's deleted and disabled_fork) reads as disabled. */
export function isDisabledWorkflow(state: string): boolean {
  return state !== "active";
}

/** Workflows by name, every disabled one after every active one. */
export function sortWorkflows<W extends Pick<Workflow, "name" | "state">>(
  workflows: readonly W[],
): W[] {
  return [...workflows].sort(
    (a, b) =>
      Number(isDisabledWorkflow(a.state)) -
        Number(isDisabledWorkflow(b.state)) || a.name.localeCompare(b.name),
  );
}

export type FacetValueVerdict = "ok" | "chars" | "length";

/** Mirrors the backend facet check (MAX_RUN_FACET_BYTES in github/actions.rs);
 *  scripts/run-facet-cap.test.mjs keeps the two equal. */
export const MAX_RUN_FACET_BYTES = 200;

/** The client-side mirror of the backend's RunFilters validation, so the
 *  popover never offers a value the read would refuse: at most 200 UTF-8 bytes,
 *  non-empty, no whitespace or control character. `\p{Cc}` covers U+0085, which
 *  `\s` misses, so this is a superset of Rust's is_whitespace || is_control. */
export function facetValueVerdict(v: string): FacetValueVerdict {
  if (new TextEncoder().encode(v).length > MAX_RUN_FACET_BYTES) return "length";
  if (v.length === 0 || /[\s\p{Cc}]/u.test(v)) return "chars";
  return "ok";
}

export function isValidFacetValue(v: string): boolean {
  return facetValueVerdict(v) === "ok";
}

export type FreeEntryVerdict = FacetValueVerdict | "dash";

/** A typed branch is checked as a ref name, never by the 200-byte facet rule:
 *  the backend's ref check refuses an empty name or a leading "-", and git
 *  refuses whitespace and control characters in any ref. */
export function branchValueVerdict(v: string): FreeEntryVerdict {
  if (v.length === 0 || /[\s\p{Cc}]/u.test(v)) return "chars";
  if (v.startsWith("-")) return "dash";
  return "ok";
}

/** The verdict on a free-entry row's typed value, by its facet. */
export function freeEntryVerdict(kind: FacetKind, v: string): FreeEntryVerdict {
  return kind === "branch" ? branchValueVerdict(v) : facetValueVerdict(v);
}

export const INVALID_FREE_ENTRY_TEXT: Record<
  Exclude<FreeEntryVerdict, "ok">,
  string
> = {
  chars: "Can't contain spaces or control characters",
  length: `Too long (over ${MAX_RUN_FACET_BYTES} characters)`,
  dash: "Can't start with a hyphen",
};

const FACET_WORD: Record<FacetKind, string> = {
  workflow: "Workflow",
  event: "Event",
  status: "Status",
  branch: "Branch",
  actor: "Actor",
};

const CHIP_VALUE: Record<FacetKind, (f: Facets) => string> = {
  workflow: (f) => f.workflow?.name ?? "",
  event: (f) => f.event ?? "",
  status: (f) => f.status ?? "",
  branch: (f) => (f.branch && "name" in f.branch ? f.branch.name : ""),
  actor: (f) => f.actor?.name ?? "",
};

/** A chip's facet word and value: the workflow's name (never its path), the
 *  raw event and status values (the .tsx layer labels statuses), the branch
 *  name and the actor's name. */
export function chipLabel(
  kind: FacetKind,
  f: Facets,
): { facet: string; value: string } {
  return { facet: FACET_WORD[kind], value: CHIP_VALUE[kind](f) };
}
