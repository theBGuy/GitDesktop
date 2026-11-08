import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { StarHistoryPage } from "../api";
import * as api from "../api";
import { keepPreviousDataForRepo } from "./core";

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
// All keyed on the trailing window (`weeks`) so toggling it refetches. The local
// graphs keep the other window's data as placeholder meanwhile (same repo only),
// so a toggle never drops a card back to its skeleton; consumers dim on
// `isPlaceholderData`. The gh community call is gated on a GitHub repo.

export function useContributorActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "contributors", weeks] as const,
    queryFn: () => api.gitContributorActivity(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
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
    placeholderData: keepPreviousDataForRepo(repo),
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
    placeholderData: keepPreviousDataForRepo(repo),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function usePunchCard(repo: string, weeks: number, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "punch-card", weeks] as const,
    queryFn: () => api.gitPunchCard(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
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

/** The repo's star history, one GitHub page (≤30 weeks) per fetch; the card
 *  drives how many pages load. No window axis in the key: the 52-week view is
 *  the newest pages of the same series. The long staleTime matches the other
 *  expensive read, since a refetch re-requests every loaded page in sequence. */
export function useStarHistory(repo: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["repo", repo, "insights", "starHistory"] as const,
    queryFn: ({ pageParam }) => api.ghStarHistoryPage(repo, pageParam),
    initialPageParam: 1,
    // Only the page after the one just fetched, within the API's 100 pages,
    // drives another fetch: the backend already refuses any other "next", so
    // this is defense in depth.
    getNextPageParam: (last: StarHistoryPage, _pages, lastPageParam) =>
      last.nextPage !== null &&
      last.nextPage === lastPageParam + 1 &&
      last.nextPage <= 100
        ? last.nextPage
        : undefined,
    enabled,
    // Never stale while in error over loaded pages: the window-focus pass
    // retries errored reads with a finite staleTime, and each try re-walks
    // every loaded page to fail at the same one. The Retries recover it.
    staleTime: (query) =>
      query.state.status === "error" && query.state.data !== undefined
        ? Number.POSITIVE_INFINITY
        : 30 * 60_000,
    retry: false,
  });
}
