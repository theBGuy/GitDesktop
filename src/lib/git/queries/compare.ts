import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { keepPreviousDataForRepo, repoKeys } from "./core";

export function useCompareBranches(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.compare(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitCompareBranches(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
  });
}

/** `base..compare` only, for the callers that never read `behind` — one log
 *  walk instead of two. Same enabled gate as {@link useCompareBranches}. */
export function useBranchAhead(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.branchAhead(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitBranchAhead(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
  });
}

/** Just how many commits `base..compare` holds, for callers that render only
 *  the number. Same enabled gate as {@link useCompareBranches}. */
export function useBranchAheadCount(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.branchAheadCount(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitBranchAheadCount(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
  });
}

export function useBranchDiffFiles(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.branchDiffFiles(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitBranchDiffFiles(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** `enabled`: same caller gate as `useCommitFileDiff` — hold the fetch off while
 *  `file` still comes from a placeholder file list. */
export function useBranchFileDiff(
  repo: string,
  base: string | null,
  compare: string | null,
  file: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: repoKeys.branchFileDiff(
      repo,
      base ?? "",
      compare ?? "",
      file ?? "",
    ),
    queryFn: () =>
      api.gitBranchFileDiff(repo, base ?? "", compare ?? "", file ?? ""),
    enabled:
      enabled &&
      base !== null &&
      compare !== null &&
      base !== compare &&
      file !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** The fork point the three-dot compare diffs against — the old side whole-file
 *  reads must use. Same enabled gate and placeholder policy as
 *  {@link useBranchDiffFiles}, so callers can pair the two on one
 *  `isPlaceholderData` check. */
export function useMergeBase(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.mergeBase(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitMergeBase(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Whether every SHA is a local commit object. Deliberately no
 *  `keepPreviousData`: a verdict belongs to the exact set it was measured on, and
 *  one PR's "present" must never stand in for the next one's. The key sits under
 *  the repo subtree so checkout/fetch's whole-repo invalidation re-measures it,
 *  and `refetchOnMount: "always"` covers any narrower writer — the probe is a
 *  millisecond-class `git rev-parse`. */
export function useObjectsPresent(repo: string | null, oids: string[]) {
  const joined = oids.join(",");
  return useQuery({
    queryKey: repoKeys.objectsPresent(repo ?? "", joined),
    queryFn: () => api.gitObjectsPresent(repo ?? "", oids),
    enabled: repo !== null && oids.length > 0,
    refetchOnMount: "always",
  });
}

/** Whether the open repo's folder still exists — the probe empty states check
 *  before blaming anything else, since a deleted checkout fails every repo-scoped
 *  read the same way a missing or signed-out CLI does. Short `staleTime` so a
 *  restored folder recovers on the next focus refetch; `retry: false` because an
 *  fs check has nothing to retry. */
export function usePathPresent(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "path-present"] as const,
    queryFn: () => api.pathIsDir(repo),
    staleTime: 5_000,
    retry: false,
    // Polled, not focus-only: the probe mounts only inside ForgeNotReady, so a deletion
    // while that state is already on screen has no focus change to ride in on.
    refetchInterval: 5_000,
    // Local IPC read: the default "online" mode parks it while the OS reports no
    // connection, which would hold the probe undefined for the whole session.
    networkMode: "always",
  });
}
