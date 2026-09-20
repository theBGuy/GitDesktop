import { useQuery } from "@tanstack/react-query";
import { keepPreviousDataForRepo } from "@/lib/git/queries";
import { invoke } from "@/lib/tauri/invoke";

// ── Types (mirror the Rust structs behind `forge_bb_commit_findings`) ────────

/** Whether a commit was found to read Code Insights reports from. `"available"`
 *  is the ONLY value that lets an empty report list mean "nothing published" —
 *  every other value names a blocker the panel must render instead, so an empty
 *  list never defaults to "clean". */
export type BbFindingsAvailability =
  | "available"
  /** The commit resolved, but no reports are published against it. */
  | "noReports"
  /** Neither the requested nor the default branch resolved remotely. */
  | "refNotFound"
  | "forbidden"
  | "indeterminate";

/** Code Insights reports read from ONE commit — commit-scoped, like GitLab's
 *  pipeline artifacts and unlike GitHub's repository-wide alert stores. The
 *  panel's provenance strip is what makes that visible, so the commit travels
 *  with the reports. */
export interface BbFindingsOut {
  availability: BbFindingsAvailability;
  /** A partial-read sentence when `availability` is `"available"`; the
   *  classified explanation for every other value. */
  detail: string | null;
  /** The checkout branch we looked for a commit on ("HEAD" when detached). */
  requestedRef: string;
  /** The commit came from the default branch instead of `requestedRef`. */
  usedFallback: boolean;
  /** The default branch name when `usedFallback`; null otherwise. */
  fallbackRef: string | null;
  /** The repository's default branch name whenever the repo fetch answered —
   *  which ref was *looked at*, not which one supplied the reports. */
  defaultRef: string | null;
  commitSha: string | null;
  /** API-provided, and absent often enough that no copy may assume it. */
  commitWebUrl: string | null;
  reports: BbReportOut[];
  /** The report walk stopped with a next page still remaining. */
  truncated: boolean;
}

export interface BbReportOut {
  uuid: string;
  externalId: string | null;
  title: string | null;
  details: string | null;
  /** Raw: `SECURITY` | `COVERAGE` | `TEST` | `BUG`, or anything Bitbucket adds. */
  reportType: string | null;
  reporter: string | null;
  /** Raw: `PASSED` | `FAILED` | `PENDING`, or anything Bitbucket adds. */
  result: string | null;
  /** Already http(s)-gated Rust-side. */
  link: string | null;
  createdOn: string | null;
  data: BbReportDataOut[];
  annotations: BbAnnotationOut[];
  /** More annotations exist on this report than the limit asked for. */
  annotationsTruncated: boolean;
  /** This report's annotation read failed outright, or lost rows to unreadable
   *  entries — either way the rows shown are not the whole report, which is
   *  distinct from a report that genuinely carries none. */
  annotationsUnreadable: boolean;
}

export interface BbReportDataOut {
  title: string | null;
  /** Raw: `NUMBER` | `DURATION` | `BOOLEAN` | `PERCENTAGE` | `TEXT` | `DATE` |
   *  `LINK`, or anything Bitbucket adds. */
  type: string | null;
  /** Heterogeneous third-party JSON: format by `type`, and never render as a
   *  link — only the `link` fields are gated. */
  value: unknown;
}

export interface BbAnnotationOut {
  uuid: string;
  externalId: string | null;
  /** Raw: `VULNERABILITY` | `CODE_SMELL` | `BUG`, or anything Bitbucket adds. */
  annotationType: string | null;
  /** Raw `CRITICAL` | `HIGH` | `MEDIUM` | `LOW`; null means the report stated
   *  none, which is never defaulted to a rung it didn't claim. */
  severity: string | null;
  /** Bitbucket caps this at 450 characters server-side. */
  summary: string | null;
  details: string | null;
  path: string | null;
  line: number | null;
  /** Already http(s)-gated Rust-side. */
  link: string | null;
  result: string | null;
  createdOn: string | null;
}

/** A report's display name, falling through the tolerated-empty fields the
 *  tolerant parse can leave behind. `||`, not `??`: an empty string must fall
 *  through the same as a null. Shared by the section header and the detail pane
 *  so a title-less report is identified identically in both. */
export const bbReportLabel = (report: BbReportOut): string =>
  report.title || report.reporter || report.externalId || "Report";

/** A report's pass/fail state. A ladder of its own — a `FAILED` report is the
 *  reporter's own verdict, never a finding severity — and anything unrecognized
 *  (including null) reads as unspecified rather than being called a pass. */
export type BbResultLevel = "passed" | "failed" | "pending" | "unknown";

const BB_RESULT_LABEL: Record<BbResultLevel, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Pending",
  unknown: "Unspecified",
};

export function bbResultLevel(result: string | null): BbResultLevel {
  switch (result?.toLowerCase()) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

/** The user-facing name for a result, normalized exactly as the chip does. */
export const bbResultLabel = (result: string | null): string =>
  BB_RESULT_LABEL[bbResultLevel(result)];

/** Names where a link actually goes. Code Insights `link` fields point at
 *  whatever tool published the report (an advisory database, a scanner's own
 *  docs), so a label naming the forge would name a site the URL isn't on.
 *  `hostname` is IDNA-normalized by the URL parser, so a spoofed host arrives
 *  here as punycode rather than as look-alike glyphs. */
export function linkOutLabel(url: string | null): string {
  if (!url) return "Open link";
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host ? `Open on ${host}` : "Open link";
  } catch {
    return "Open link";
  }
}

/** What a report covers, in words. Bitbucket documents four kinds; one it adds
 *  later shows as it arrived rather than being dropped or relabeled. */
export function bbReportTypeLabel(reportType: string): string {
  switch (reportType.toUpperCase()) {
    case "SECURITY":
      return "Security";
    case "COVERAGE":
      return "Coverage";
    case "TEST":
      return "Test";
    case "BUG":
      return "Bug";
    default:
      return reportType;
  }
}

/** What an annotation reports, in words. Bitbucket documents three kinds; one it
 *  adds later shows as it arrived rather than being dropped or relabeled. */
export function bbAnnotationTypeLabel(annotationType: string): string {
  switch (annotationType.toUpperCase()) {
    case "VULNERABILITY":
      return "Vulnerability";
    case "CODE_SMELL":
      return "Code smell";
    case "BUG":
      return "Bug";
    default:
      return annotationType;
  }
}

// ── API wrappers ─────────────────────────────────────────────────────────────

export const bbCommitFindings = (repoPath: string, limit: number) =>
  invoke<BbFindingsOut>("forge_bb_commit_findings", { repoPath, limit });

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * One query for every Code Insights report on the commit: they hang off a single
 * commit resolution, so splitting them per report would re-resolve it each time.
 * No refetchInterval — reports change per commit, so this fetches on tab open and
 * manual refresh only. `active` (the Findings tab being visible) gates the fetch;
 * <Activity> defers a hidden panel's effects but not its queries. `limit` is part
 * of the key so a Load-more is a distinct entry; keepPreviousDataForRepo keeps the
 * loaded rows painted while it refetches.
 */
export function useBitbucketFindings(
  repo: string,
  enabled: boolean,
  active: boolean,
  limit: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "findings", "bitbucket", limit] as const,
    queryFn: () => bbCommitFindings(repo, limit),
    enabled: enabled && active,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}
