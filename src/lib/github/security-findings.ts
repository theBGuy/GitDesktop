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
  /** The server answered, but nothing has been reported yet — the feature may be
   *  unconfigured or its first run may still be going. Distinct from
   *  `notEnabled`, which the wire proves; this state can't tell the two apart. */
  | "noResultsYet"
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
  /** `"direct"` / `"transitive"` when GitHub states it; null when it doesn't —
   *  the two read very differently to someone deciding whether to act. */
  relationship: string | null;
  /** Every CVSS version the advisory carries (v3 and v4 coexist). */
  cvss: CvssOut[];
  references: ReferenceOut[];
  cwes: CweOut[];
}

export interface CvssOut {
  version: string;
  score: number | null;
  vectorString: string;
  /** The vector decoded into human labels; empty when the vector couldn't be
   *  parsed, in which case the raw `vectorString` is all there is to show. */
  metrics: CvssMetricOut[];
}

export interface CvssMetricOut {
  label: string;
  value: string;
}

export interface ReferenceOut {
  url: string;
  label: string;
}

export interface CweOut {
  cweId: string;
  name: string;
}

export interface CodeScanningAlertsOut {
  availability: FindingAvailability;
  detail: string | null;
  alerts: CodeScanningAlertOut[];
  truncated: boolean;
}

export interface CodeScanningAlertOut {
  number: number;
  state: string;
  ruleId: string;
  ruleName: string | null;
  ruleDescription: string | null;
  /** The SARIF level — `note` / `warning` / `error`. A different ladder from the
   *  advisory severities, so it is labeled in its own words, never mapped onto
   *  Critical/High. */
  severity: string | null;
  /** The security severity (critical/high/medium/low) when the rule carries one. */
  securitySeverity: string | null;
  toolName: string;
  toolVersion: string | null;
  path: string;
  startLine: number | null;
  message: string;
  ref: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretScanningAlertsOut {
  availability: FindingAvailability;
  detail: string | null;
  alerts: SecretScanningAlertOut[];
  truncated: boolean;
}

export interface SecretScanningAlertOut {
  number: number;
  state: string;
  secretType: string;
  secretTypeDisplayName: string;
  /** `active` / `inactive` / `unknown` — GitHub only validates secrets for
   *  providers it has a checker for, so null means "never checked". */
  validity: string | null;
  publiclyLeaked: boolean | null;
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
// GitHub-only: every findings category here (Dependabot, code scanning, secret
// scanning, repository advisories) has no GitLab/Bitbucket analogue, so these
// stay `gh_*` and the panel gates on the `securityFindings` capability rather
// than dispatching per provider.

export const ghDependabotAlerts = (repoPath: string, limit: number) =>
  invoke<DependabotAlertsOut>("gh_dependabot_alerts", { repoPath, limit });

export const ghRepoAdvisories = (repoPath: string, limit: number) =>
  invoke<RepoAdvisoriesOut>("gh_repo_advisories", { repoPath, limit });

export const ghCodeScanningAlerts = (repoPath: string, limit: number) =>
  invoke<CodeScanningAlertsOut>("gh_code_scanning_alerts", { repoPath, limit });

export const ghSecretScanningAlerts = (repoPath: string, limit: number) =>
  invoke<SecretScanningAlertsOut>("gh_secret_scanning_alerts", {
    repoPath,
    limit,
  });

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

export function useCodeScanningAlerts(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "codeScanning", limit] as const,
    queryFn: () => ghCodeScanningAlerts(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useSecretScanningAlerts(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "secretScanning", limit] as const,
    queryFn: () => ghSecretScanningAlerts(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}
