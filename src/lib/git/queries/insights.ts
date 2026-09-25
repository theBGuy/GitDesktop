import { useQuery } from "@tanstack/react-query";
import * as api from "../api";

/** Repo-wide stats; the scan is heavy, so only fetch while the dialog is up. */
export function useRepoStats(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "stats"] as const,
    queryFn: () => api.gitRepoStats(repo),
    enabled,
    staleTime: 5 * 60_000,
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

export function useBranchStats(
  repo: string,
  branch: string | null,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "branch-stats", branch ?? "", base ?? ""] as const,
    queryFn: () => api.gitBranchStats(repo, branch ?? "", base ?? ""),
    enabled: enabled && branch !== null && base !== null && branch !== base,
    staleTime: 60_000,
    networkMode: "always",
  });
}

// ── Insights graphs ──────────────────────────────────────────────────────────
// All keyed on the trailing window (`weeks`) so toggling it refetches. Local-git
// queries are cheap to keep fresh; the gh community call is gated on a GitHub repo.

export function useContributorActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "contributors", weeks] as const,
    queryFn: () => api.gitContributorActivity(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCommitActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "commit-activity", weeks] as const,
    queryFn: () => api.gitCommitActivity(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCodeFrequency(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "code-frequency", weeks] as const,
    queryFn: () => api.gitCodeFrequency(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function usePunchCard(repo: string, weeks: number, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "punch-card", weeks] as const,
    queryFn: () => api.gitPunchCard(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCommunityInsights(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "community"] as const,
    queryFn: () => api.ghCommunityInsights(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoTraffic(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "traffic"] as const,
    queryFn: () => api.ghRepoTraffic(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useForkActivity(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "forks"] as const,
    queryFn: () => api.forgeForkActivity(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Ahead/behind for ONE fork, keyed per fork *and* per branch pair so a default-branch
 *  change can't serve the previous pair's counts. `enabled` carries the row's explicit
 *  request — nothing compares until the user asks — and both branch names must be
 *  known to have a comparison at all. */
export function useForkDivergence(
  repo: string,
  forkFullName: string,
  baseBranch: string | null,
  forkBranch: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "insights",
      "fork-compare",
      forkFullName,
      baseBranch ?? "",
      forkBranch ?? "",
    ] as const,
    queryFn: () =>
      api.forgeForkDivergence(
        repo,
        forkFullName,
        baseBranch ?? "",
        forkBranch ?? "",
      ),
    enabled: enabled && !!baseBranch && !!forkBranch,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoDependencies(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "dependencies"] as const,
    queryFn: () => api.ghRepoDependencies(repo),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
}
