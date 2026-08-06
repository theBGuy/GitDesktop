import { useQuery } from "@tanstack/react-query";
import { keepPreviousDataForRepo } from "@/lib/git/queries";
import { invoke } from "@/lib/tauri/invoke";

// ── Types (mirror the Rust structs in github/security_findings.rs) ───────────

/** Why a category has (or hasn't) findings. `"available"` is the ONLY value that
 *  lets an empty list mean "clean" — every other value names a blocker the panel
 *  must render instead, so nothing ever defaults to reassuring. */
export type FindingAvailability =
  | "available"
  | "notEnabled"
  | "forbidden"
  | "indeterminate";

export interface DependabotAlertsOut {
  availability: FindingAvailability;
  /** The server's own explanation for a non-available envelope; null otherwise. */
  detail: string | null;
  alerts: DependabotAlertOut[];
  /** More findings may exist past the fetched window — the limit filled, or the
   *  walk stopped without proving it reached the end. */
  truncated: boolean;
}

export interface DependabotAlertOut {
  number: number;
  state: string;
  packageName: string;
  ecosystem: string;
  manifestPath: string;
  scope: string | null;
  severity: string;
  summary: string;
  description: string;
  ghsaId: string;
  cveId: string | null;
  cvssScore: number | null;
  vulnerableVersionRange: string | null;
  firstPatchedVersion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoAdvisoriesOut {
  availability: FindingAvailability;
  detail: string | null;
  advisories: RepoAdvisoryOut[];
  truncated: boolean;
}

export interface RepoAdvisoryOut {
  ghsaId: string;
  cveId: string | null;
  summary: string;
  description: string | null;
  severity: string | null;
  state: string;
  htmlUrl: string;
  publishedAt: string | null;
  updatedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string | null;
  cvssScore: number | null;
  vulnerabilities: AdvisoryVulnerabilityOut[];
}

export interface AdvisoryVulnerabilityOut {
  packageName: string;
  ecosystem: string;
  vulnerableVersionRange: string | null;
  patchedVersions: string | null;
}

// ── API wrappers ─────────────────────────────────────────────────────────────
//
// GitHub-only: Dependabot alerts and repository security advisories have no
// GitLab/Bitbucket analogue, so these stay `gh_*` and the panel gates on the
// `securityFindings` capability rather than dispatching per provider.

export const ghDependabotAlerts = (repoPath: string, limit: number) =>
  invoke<DependabotAlertsOut>("gh_dependabot_alerts", { repoPath, limit });

export const ghRepoAdvisories = (repoPath: string, limit: number) =>
  invoke<RepoAdvisoriesOut>("gh_repo_advisories", { repoPath, limit });

// ── Queries ──────────────────────────────────────────────────────────────────
//
// No refetchInterval on either: findings change on the scale of hours, so they
// fetch on tab open and manual refresh only. `active` (the Findings tab being
// visible) gates the fetch — <Activity> defers a hidden panel's effects but not
// its queries. `limit` is part of the key so a Load-more is a distinct entry;
// keepPreviousDataForRepo keeps the loaded rows painted while it refetches.

export function useDependabotAlerts(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "alerts", limit] as const,
    queryFn: () => ghDependabotAlerts(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useRepoAdvisories(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "advisories", limit] as const,
    queryFn: () => ghRepoAdvisories(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}
