// Search-all's pure merge, coverage and copy. Imported straight into
// `scripts/history-search.test.mjs` under Node's type stripping, so the module
// must stay free of runtime imports.
import type { CommitPrefixMatch, CommitSummary } from "@/lib/git/types";

/** On-branch SHA hits first (wire order kept), then grep rows minus
 *  duplicates; off-branch hits split out in wire order. Dedupes on the full
 *  hash, which both arms read from the same log format. */
export function mergeSearchResults(
  sha: readonly CommitPrefixMatch[] | undefined,
  grep: readonly CommitSummary[],
): { rows: CommitSummary[]; offBranch: CommitSummary[] } {
  const rows: CommitSummary[] = [];
  const offBranch: CommitSummary[] = [];
  const seen = new Set<string>();
  for (const m of sha ?? []) {
    if (!m.onBranch) {
      offBranch.push(m.commit);
    } else if (!seen.has(m.commit.hash)) {
      seen.add(m.commit.hash);
      rows.push(m.commit);
    }
  }
  for (const c of grep) {
    if (!seen.has(c.hash)) {
      seen.add(c.hash);
      rows.push(c);
    }
  }
  return { rows, offBranch };
}

export type SearchCoverage = "full" | "sha-failed" | "grep-failed" | "none";

/** Which arms answered. `shaFailed` already implies the query was eligible
 *  for the SHA arm. `hasShaMatches` counts every match the SHA read returned,
 *  on this branch or off it. A dead grep is "none" unless those matches came
 *  from a SHA read that is still answering: a failed refetch's cache is stale. */
export function searchCoverage(i: {
  shaFailed: boolean;
  grepFailed: boolean;
  hasShaMatches: boolean;
}): SearchCoverage {
  if (i.grepFailed) {
    return i.hasShaMatches && !i.shaFailed ? "grep-failed" : "none";
  }
  return i.shaFailed ? "sha-failed" : "full";
}

/** Off-branch notice rows shown before the overflow line takes over. */
export const OFF_BRANCH_NOTICE_CAP = 3;

export const loadedNoMatchLine = (q: string) =>
  `No loaded commits match "${q}"`;
export const loadedCheckedLine = (n: number) =>
  `Checked the subject, author and SHA of ${n} loaded commit${n === 1 ? "" : "s"}.`;
export const searchAllNoMatchLine = (q: string) =>
  `No commits on this branch match "${q}"`;
export const SEARCH_ALL_CHECKED_LINE =
  "Checked the message and SHA of every commit.";
export const SEARCH_ALL_CHECKED_MESSAGES_LINE =
  "Checked the message of every commit.";

/** The search-all empty state's second line, or null when an arm failed (its
 *  failure line takes the slot). A 1-3-char hex query never ran the SHA arm,
 *  so its line claims messages only; a query no SHA can match keeps the full
 *  line. The booleans come from the queries-module predicates. */
export function searchAllCheckedLineFor(i: {
  shortHex: boolean;
  armFailed: boolean;
}): string | null {
  if (i.armFailed) return null;
  return i.shortHex
    ? SEARCH_ALL_CHECKED_MESSAGES_LINE
    : SEARCH_ALL_CHECKED_LINE;
}

export const OFF_BRANCH_NOTICE_SUFFIX = " isn't on this branch";
export const offBranchOverflowLine = (k: number) =>
  `+${k} more matches aren't on this branch`;
export const OPEN_COMMIT_LABEL = "Open commit";
export const SHA_ARM_FAILED_LINE =
  "Couldn't check SHAs. Matches cover messages only.";
export const GREP_ARM_FAILED_LINE =
  "Couldn't search messages. Matches cover SHAs only.";
export const SEARCH_ALL_FAILED_LINE = "Couldn't search all history.";

/** The failure line under rows still showing, per degraded coverage. */
export const ARM_FAILED_LINES: Record<
  Exclude<SearchCoverage, "full">,
  string
> = {
  "sha-failed": SHA_ARM_FAILED_LINE,
  "grep-failed": GREP_ARM_FAILED_LINE,
  none: SEARCH_ALL_FAILED_LINE,
};
