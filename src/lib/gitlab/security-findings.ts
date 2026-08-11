import { useQuery } from "@tanstack/react-query";
import { keepPreviousDataForRepo } from "@/lib/git/queries";
import { invoke } from "@/lib/tauri/invoke";

// ── Types (mirror the Rust structs behind `forge_gl_pipeline_findings`) ──────

/** Whether a pipeline was found to read reports from. Only `"found"` carries a
 *  `pipeline`; the other three name why there is nothing to read, so an empty
 *  findings list never defaults to "clean". */
export type GlPipelineState = "found" | "none" | "runningOnly" | "unavailable";

/** Why a category has (or hasn't) findings. `"available"` is the ONLY value that
 *  lets an empty list mean "clean" — every other value names a blocker the panel
 *  must render instead. */
export type GlFindingAvailability =
  | "available"
  /** The pipeline ran, but with no job of this kind. */
  | "notConfigured"
  /** The job ran, but its report isn't in the job's `artifacts:paths`. */
  | "reportNotReadable"
  /** The pipeline's artifacts have aged out of GitLab's retention. */
  | "expired"
  /** The job for this category hasn't finished in this pipeline yet. */
  | "analysisPending"
  | "forbidden"
  | "indeterminate";

/** Findings read from ONE pipeline's report artifacts — commit-scoped, unlike
 *  GitHub's repository-wide alert stores. The panel's provenance strip is what
 *  makes that visible, so `pipeline` travels with the categories. */
export interface GlFindingsOut {
  pipelineState: GlPipelineState;
  /** Non-null iff `pipelineState === "found"`. */
  pipeline: GlPipelineRefOut | null;
  /** The checkout branch we looked for pipelines on ("HEAD" when detached). */
  requestedRef: string;
  /** The pipelines came from the default branch instead of `requestedRef`. */
  usedFallback: boolean;
  /** The default branch name when `usedFallback`; null otherwise. */
  fallbackRef: string | null;
  /** The project's default branch name, set whenever the project fetch answered
   *  and the project has a default branch — including when no pipelines were
   *  found at all. Distinct from `fallbackRef`, which means a default-branch
   *  pipeline was actually used: this one says which ref was *looked at*, not
   *  which one supplied findings. */
  defaultRef: string | null;
  /** e.g. `https://gitlab.com/group/name`, no trailing slash; null when unknown. */
  projectWebUrl: string | null;
  sast: GlSecureCategoryOut;
  secretDetection: GlSecureCategoryOut;
  codeQuality: GlCodeQualityCategoryOut;
}

export interface GlPipelineRefOut {
  id: number;
  iid: number;
  status: string;
  sha: string;
  ref: string;
  webUrl: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface GlSecureCategoryOut {
  availability: GlFindingAvailability;
  /** The server's own explanation for a non-available envelope; null otherwise. */
  detail: string | null;
  findings: GlSecureFindingOut[];
  /** More findings exist in the report than the limit asked for. */
  truncated: boolean;
}

export interface GlCodeQualityCategoryOut {
  availability: GlFindingAvailability;
  detail: string | null;
  findings: GlCodeQualityFindingOut[];
  truncated: boolean;
}

export interface GlSecureFindingOut {
  id: string;
  name: string;
  /** Raw and capitalized as the report spells it — `"Critical"`…`"Unknown"`, and
   *  `""` when the report omitted it. */
  severity: string;
  description: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  scannerName: string;
  identifiers: GlIdentifierOut[];
}

export interface GlIdentifierOut {
  type: string;
  name: string;
  value: string;
  url: string | null;
}

export interface GlCodeQualityFindingOut {
  fingerprint: string;
  checkName: string;
  /** Raw and lowercase as CodeClimate spells it — `"blocker"`…`"info"`, and `""`
   *  when the report omitted it. A ladder of its own, never a security severity. */
  severity: string;
  description: string;
  path: string;
  line: number | null;
}

/** Stable identity for a SAST or secret-detection finding. Reports may omit the
 *  id entirely, and every id-less finding would otherwise share the empty string
 *  as its identity — so the location stands in, mirroring the fields of Rust's
 *  `SecureKey::Location` (the backend's dedup key). The join is not injective the
 *  way that tuple is: report-controlled text containing the separator can still
 *  collide, degrading to the documented first-match-wins rather than to a mix-up
 *  of unrelated findings. */
export const secureFindingId = (f: GlSecureFindingOut): string =>
  f.id || `${f.name}:${f.file}:${f.startLine ?? ""}`;

/** Stable identity for a code quality finding, mirroring the Rust side's
 *  composite. A fingerprint repeats across files for the same offending
 *  construct — and can be missing entirely — so the check name, path and line all
 *  join the key; without the check name, two different checks at one path:line
 *  collapse into each other. Same caveat as `secureFindingId`: the join is not
 *  injective the way the Rust tuple is, and a separator-bearing collision degrades
 *  to first-match-wins. The panel and the detail pane must derive it identically
 *  or a selected row resolves to the wrong finding. */
export const codeQualityFindingId = (f: GlCodeQualityFindingOut): string =>
  `${f.fingerprint}:${f.checkName}:${f.path}:${f.line ?? ""}`;

// ── API wrappers ─────────────────────────────────────────────────────────────

export const glPipelineFindings = (repoPath: string, limit: number) =>
  invoke<GlFindingsOut>("forge_gl_pipeline_findings", { repoPath, limit });

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * One query for all three GitLab categories: they come from a single pipeline's
 * artifacts, so splitting them would re-resolve that pipeline three times. No
 * refetchInterval — findings change per pipeline, so this fetches on tab open and
 * manual refresh only. `active` (the Findings tab being visible) gates the fetch;
 * <Activity> defers a hidden panel's effects but not its queries. `limit` is part
 * of the key so a Load-more is a distinct entry; keepPreviousDataForRepo keeps the
 * loaded rows painted while it refetches.
 */
export function useGitLabFindings(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "gitlab", limit] as const,
    queryFn: () => glPipelineFindings(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}
