import { invoke } from "@/lib/tauri/invoke";
import type {
  BranchStats,
  CodeFreqPoint,
  CommunityInsights,
  ContributorChurn,
  ForgeForkActivity,
  ForgeForkDivergence,
  PunchCard,
  RepoDependencies,
  RepoStats,
  RepoTraffic,
  WeekCount,
} from "../types";

export const gitRepoStats = (repoPath: string) =>
  invoke<RepoStats>("git_repo_stats", { repoPath });

/** Stats for the commits/diff `branch` has that `base` doesn't. */
export const gitBranchStats = (
  repoPath: string,
  branch: string,
  base: string,
) => invoke<BranchStats>("git_branch_stats", { repoPath, branch, base });

// Insights graphs — `weeks > 0` limits to a trailing window; `0` is all history.
export const gitContributorActivity = (repoPath: string, weeks: number) =>
  invoke<ContributorChurn[]>("git_contributor_activity", { repoPath, weeks });

export const gitCommitActivity = (repoPath: string, weeks: number) =>
  invoke<WeekCount[]>("git_commit_activity", { repoPath, weeks });

export const gitCodeFrequency = (repoPath: string, weeks: number) =>
  invoke<CodeFreqPoint[]>("git_code_frequency", { repoPath, weeks });

export const gitPunchCard = (repoPath: string, weeks: number) =>
  invoke<PunchCard>("git_punch_card", { repoPath, weeks });

export const ghCommunityInsights = (repoPath: string) =>
  invoke<CommunityInsights>("gh_community_insights", { repoPath });

export const ghRepoTraffic = (repoPath: string) =>
  invoke<RepoTraffic>("gh_repo_traffic", { repoPath });

export const ghRepoDependencies = (repoPath: string) =>
  invoke<RepoDependencies>("gh_repo_dependencies", { repoPath });

/** One week of GitHub's star history: its Sunday 00:00 UTC epoch in seconds (a
 *  calendar-date label, not an instant) and the stars gained that week. */
export interface StarWeek {
  week: number;
  total: number;
}

/** One page of star history, newest week first and dense back to the repo's
 *  first week. `available` is false only on page 1, when GitHub answered
 *  not-found or denied. `lastPage` is null without a Link header and on the
 *  real last page, so only page 1's counts the pages; `stargazersCount` comes
 *  on page 1 only. */
export interface StarHistoryPage {
  available: boolean;
  weeks: StarWeek[];
  nextPage: number | null;
  lastPage: number | null;
  stargazersCount: number | null;
}

export const ghStarHistoryPage = (repoPath: string, page: number) =>
  invoke<StarHistoryPage>("gh_star_history_page", { repoPath, page });

export const forgeForkActivity = (repoPath: string) =>
  invoke<ForgeForkActivity>("forge_fork_activity", { repoPath });

export const forgeForkDivergence = (
  repoPath: string,
  forkFullName: string,
  baseBranch: string,
  forkBranch: string,
) =>
  invoke<ForgeForkDivergence>("forge_fork_divergence", {
    repoPath,
    forkFullName,
    baseBranch,
    forkBranch,
  });
