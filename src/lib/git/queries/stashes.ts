import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { keepPreviousDataForRepo } from "./core";
import { useRepoMutation } from "./internal";

export function useStashCount(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "stash-count"] as const,
    queryFn: () => api.gitStashCount(repo),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

export function useDiscardAll(repo: string) {
  return useRepoMutation(repo, () => api.gitDiscardAll(repo));
}

export function useDiscardPaths(repo: string) {
  return useRepoMutation(
    repo,
    (paths: { path: string; untracked: boolean }[]) =>
      api.gitDiscardPaths(repo, paths),
  );
}

export function useStashAll(repo: string) {
  return useRepoMutation(repo, () => api.gitStashAll(repo));
}

export function useStashPaths(repo: string) {
  return useRepoMutation(repo, (paths: string[]) =>
    api.gitStashPaths(repo, paths),
  );
}

export function useStashPop(repo: string) {
  return useRepoMutation(repo, () => api.gitStashPop(repo));
}

export function useStashList(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "stashes"] as const,
    queryFn: () => api.gitStashList(repo),
    enabled,
    networkMode: "always",
  });
}

export function useStashFiles(repo: string, index: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "stash-files", index ?? -1] as const,
    queryFn: () => api.gitStashFiles(repo, index ?? 0),
    enabled: index !== null,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

export function useStashFileDiff(
  repo: string,
  index: number | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "stash-diff",
      index ?? -1,
      filePath ?? "",
    ] as const,
    queryFn: () => api.gitStashFileDiff(repo, index ?? 0, filePath ?? ""),
    enabled: index !== null && filePath !== null,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

export function useStashApply(repo: string) {
  return useRepoMutation(repo, (args: { index: number; pop: boolean }) =>
    api.gitStashApply(repo, args.index, args.pop),
  );
}

export function useStashDrop(repo: string) {
  return useRepoMutation(repo, (index: number) =>
    api.gitStashDrop(repo, index),
  );
}

/** Dangling stash commits recovered via `git fsck` — the LAZY fsck trigger for
 *  the Stashes dialog's "Recoverable" view. `fsck` is slow, so enable this only
 *  while that view is actually shown. */
export function useOrphanedStashes(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "orphaned-stashes"] as const,
    queryFn: () => api.gitOrphanedStashes(repo),
    enabled,
    // fsck is slow: don't re-scan on every toggle back to Recoverable (Rescan forces
    // one), and keep the list on screen during a refetch instead of blanking to a
    // spinner.
    staleTime: 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

export function useOrphanedStashFiles(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "orphaned-stash-files", sha ?? ""] as const,
    queryFn: () => api.gitOrphanedStashFiles(repo, sha ?? ""),
    enabled: sha !== null,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

export function useOrphanedStashFileDiff(
  repo: string,
  sha: string | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "orphaned-stash-diff",
      sha ?? "",
      filePath ?? "",
    ] as const,
    queryFn: () =>
      api.gitOrphanedStashFileDiff(repo, sha ?? "", filePath ?? ""),
    enabled: sha !== null && filePath !== null,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

/** Restore an orphaned stash to the working tree (`git stash apply <sha>` — never
 *  drops). Default whole-repo invalidation refreshes the status and stash lists. */
export function useRestoreOrphaned(repo: string) {
  return useRepoMutation(repo, (sha: string) =>
    api.gitRestoreOrphaned(repo, sha),
  );
}

/** Reconcile-on-read for the interrupted-op recovery banner. Lives under the repo
 *  subtree, so a ConflictBanner Continue/Abort re-runs it and clears the banner. */
export function useOplogCheck(repo: string, enabled = true) {
  return useQuery({
    queryKey: ["repo", repo, "oplog-check"] as const,
    queryFn: () => api.gitOplogCheck(repo),
    enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

/** The full operation journal, gated to fetch only while the history dialog is
 *  open (a pure read, but no reason to run it otherwise). */
export function useOplogHistory(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "oplog"] as const,
    queryFn: () => api.gitOplogList(repo),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

/** Dismiss a journal entry so it stops surfacing as interrupted. Default
 *  invalidation refetches the repo subtree, clearing the banner. */
export function useDismissOplog(repo: string) {
  return useRepoMutation(repo, (id: string) => api.gitOplogDismiss(repo, id));
}
