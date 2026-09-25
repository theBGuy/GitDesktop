import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { repoKeys } from "./core";

/** Shared so every observer of a repo's status key fetches under the same options:
 *  the fetch takes them from whichever observer starts it. */
export function repoStatusOptions(repo: string) {
  return {
    queryKey: repoKeys.status(repo),
    queryFn: () => api.gitStatus(repo),
    // A local git read, so it must not park on the default "online" mode the way
    // a forge call does — gates that hold until this answers would never lift.
    networkMode: "always" as const,
  };
}

export function useRepoStatus(repo: string) {
  return useQuery({
    ...repoStatusOptions(repo),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}

/** Per-file line counts for the Changes panel's rows. The key MUST stay a child
 *  of {@link repoKeys.status} — internal.ts's `workingTreeKeys` invalidates that
 *  key as a PREFIX, so every staging-class mutation already refreshes these counts
 *  with no extra wiring. `enabled` gates it on the Changes tab being active and the
 *  tree being dirty; a `<TabPanel>`-hidden panel still renders and would otherwise poll. */
export function useWorkingLineStats(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: [...repoKeys.status(repo), "line-stats"],
    queryFn: () => api.gitWorkingLineStats(repo),
    enabled,
    networkMode: "always",
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}

/** Commits on HEAD not on any remote — the "unpublished" count for a branch with no
 *  upstream, where `branch.ahead` is undefined (a never-pushed branch's pre-fork-point
 *  commits already live on `origin/<base>`, so the whole branch isn't unpushed).
 *  `enabled` fires it only in that case. Keyed under the repo so commit/push/fetch
 *  invalidation refetches it. */
export function useUnpushedCount(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "unpushed-count"] as const,
    queryFn: () => api.gitUnpushedCount(repo),
    enabled: enabled && Boolean(repo),
    staleTime: 10_000,
    networkMode: "always",
  });
}

/** Owners (from each repo's origin remote) for grouping the repo list. */
export function useRepoOwners(paths: string[]) {
  const sorted = [...paths].sort();
  return useQuery({
    queryKey: ["repo-owners", sorted] as const,
    queryFn: () => api.gitRepoOwners(sorted),
    enabled: sorted.length > 0,
    staleTime: 10 * 60 * 1000,
    // gcTime: Infinity — keep owners warm across popover opens so refreshes stay
    // instant (the stored owner on each RecentRepo is the primary anti-reflow path).
    gcTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });
}
