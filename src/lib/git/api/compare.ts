import { invoke } from "@/lib/tauri/invoke";
import type {
  BranchComparison,
  CommitSummary,
  DeltaDiff,
  DiffStatEntry,
  FileDiff,
  StagedDiff,
} from "../types";

export const gitCompareBranches = (
  repoPath: string,
  base: string,
  compare: string,
) =>
  invoke<BranchComparison>("git_compare_branches", { repoPath, base, compare });

export const gitBranchAhead = (
  repoPath: string,
  base: string,
  compare: string,
) => invoke<CommitSummary[]>("git_branch_ahead", { repoPath, base, compare });

export const gitBranchAheadCount = (
  repoPath: string,
  base: string,
  compare: string,
) => invoke<number>("git_branch_ahead_count", { repoPath, base, compare });

export const gitBranchDiffFiles = (
  repoPath: string,
  base: string,
  compare: string,
) =>
  invoke<DiffStatEntry[]>("git_branch_diff_files", { repoPath, base, compare });

export const gitBranchFileDiff = (
  repoPath: string,
  base: string,
  compare: string,
  filePath: string,
) =>
  invoke<FileDiff>("git_branch_file_diff", {
    repoPath,
    base,
    compare,
    filePath,
  });

/** The fork point of two refs. The compare surfaces diff three-dot, so their old
 *  side must be read from this commit rather than from `base`. */
export const gitMergeBase = (repoPath: string, base: string, compare: string) =>
  invoke<string>("git_merge_base", { repoPath, base, compare });

/** Whether every SHA is already a local commit object (no network). Gates reads
 *  that need a remote PR's commits to exist in this checkout. */
export const gitObjectsPresent = (repoPath: string, oids: string[]) =>
  invoke<boolean>("git_objects_present", { repoPath, oids });

/** Three-dot `base...compare` diff. `exclude` takes gitignore-style patterns the
 *  backend filters out of the text and file list (counting them in
 *  `excludedFiles`); generation callers pass the user's AI-ignore patterns here.
 *  Review callers omit them and filter client-side instead
 *  (`filterDiffByAiIgnore`), which covers forge-supplied PR diffs too. */
export const gitBranchDiff = (
  repoPath: string,
  base: string,
  compare: string,
  maxBytes?: number,
  exclude?: string[],
) =>
  invoke<StagedDiff>("git_branch_diff", {
    repoPath,
    base,
    compare,
    maxBytes: maxBytes ?? null,
    exclude: exclude ?? null,
  });

/** The literal `fromRef..toRef` diff — "what changed since the last review".
 *  Soft, best-effort: never throws for missing/rewritten history; the result's
 *  `reason` says why the delta is absent so the caller can fall back. */
export const gitDiffBetweenRefs = (
  repoPath: string,
  fromRef: string,
  toRef: string,
  maxBytes?: number,
) =>
  invoke<DeltaDiff>("git_diff_between_refs", {
    repoPath,
    fromRef,
    toRef,
    maxBytes: maxBytes ?? null,
  });

/** Best-effort fetch of specific commit SHAs from origin, so a remote PR's
 *  prior-review delta can resolve when the PR was never checked out. Returns
 *  whether the fetch succeeded; callers treat failure as "no delta". */
export const gitFetchObjects = (repoPath: string, refs: string[]) =>
  invoke<boolean>("git_fetch_objects", { repoPath, refs });

/** Fixed-string `git grep` at a rev, as `path:line:content` lines ("" = no
 *  matches). Used by the agentic HTTP review tool loop to search at the PR head. */
export const gitGrepAtRef = (
  repoPath: string,
  pattern: string,
  atRef: string,
  maxHits?: number,
) => invoke<string>("git_grep_at_ref", { repoPath, pattern, atRef, maxHits });
