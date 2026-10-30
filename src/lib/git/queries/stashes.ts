import { useQuery } from "@tanstack/react-query";
import { REPO_SHELL_GC_TIME } from "@/lib/query-cache-times";
import * as api from "../api";
import { keepPreviousDataForRepo } from "./core";
import { useRepoMutation } from "./internal";

export function stashCountOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "stash-count"] as const,
    queryFn: () => api.gitStashCount(repo),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

export function useStashCount(repo: string) {
  return useQuery(stashCountOptions(repo));
}

export function useDiscardAll(repo: string) {
  return useRepoMutation(repo, () => api.gitDiscardAll(repo), {
    // Local working-tree write — never park it offline.
    networkMode: "always",
    localOnly: true,
  });
}

export function useDiscardPaths(repo: string) {
  return useRepoMutation(
    repo,
    (paths: { path: string; untracked: boolean }[]) =>
      api.gitDiscardPaths(repo, paths),
    {
      // Local working-tree write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

export function useStashAll(repo: string) {
  return useRepoMutation(repo, () => api.gitStashAll(repo), {
    // Local stash write — never park it offline.
    networkMode: "always",
    localOnly: true,
  });
}

export function useStashPaths(repo: string) {
  return useRepoMutation(
    repo,
    (paths: string[]) => api.gitStashPaths(repo, paths),
    {
      // Local stash write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

export function useStashPop(repo: string) {
  return useRepoMutation(repo, () => api.gitStashPop(repo), {
    // Local stash write — never park it offline.
    networkMode: "always",
    localOnly: true,
  });
}

export function useStashList(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "stashes"] as const,
    queryFn: () => api.gitStashList(repo),
    enabled,
    networkMode: "always",
  });
}

export function useStashApply(repo: string) {
  return useRepoMutation(
    repo,
    (args: { index: number; pop: boolean }) =>
      api.gitStashApply(repo, args.index, args.pop),
    {
      // Local stash write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** SHA-verified drop of the autostash backup. The local-only invalidation
 *  refreshes status and stash-count, which the banner's freshness gate reads. */
export function useDropStashBySha(repo: string) {
  return useRepoMutation(
    repo,
    (sha: string) => api.gitDropStashBySha(repo, sha),
    {
      // Local stash write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** SHA-verified drop of a listed stash wherever it sits in the stack. No
 *  `identity` on purpose: View stashes' busy state and in-flight ref are
 *  per-instance re-entry guards, and without a mutation key the observer keeps
 *  the pending drop, so the dialog stays busy until it settles, across a repo
 *  switch too. */
export function useDropStashAtAnyDepth(repo: string) {
  return useRepoMutation(
    repo,
    (sha: string) => api.gitDropStashBySha(repo, sha, true),
    {
      // Local stash write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
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

/** A stash's files, keyed AND fetched by its commit sha, never its slot: a
 *  slot-keyed read would serve one stash's files under another once the stack
 *  shifts. Works on any stash commit, live (View stashes) or dangling. */
export function useOrphanedStashFiles(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "orphaned-stash-files", sha ?? ""] as const,
    queryFn: () => api.gitOrphanedStashFiles(repo, sha ?? ""),
    enabled: sha !== null,
    placeholderData: keepPreviousDataForRepo(repo),
    networkMode: "always",
  });
}

/** One file's diff from a stash, keyed and fetched by sha (see
 *  {@link useOrphanedStashFiles}). */
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
 *  drops). The local-only invalidation refreshes the status and stash lists. */
export function useRestoreOrphaned(repo: string) {
  return useRepoMutation(
    repo,
    (sha: string) => api.gitRestoreOrphaned(repo, sha),
    {
      // Local stash write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** Reconcile-on-read for the interrupted-op recovery banner. Lives under the repo
 *  subtree, so a ConflictBanner Continue/Abort re-runs it and clears the banner. */
export function oplogCheckOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "oplog-check"] as const,
    queryFn: () => api.gitOplogCheck(repo),
    staleTime: 30_000,
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** The recovery banner's journal check; the read is {@link oplogCheckOptions}. */
export function useOplogCheck(repo: string, enabled = true) {
  return useQuery({ ...oplogCheckOptions(repo), enabled });
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
  return useRepoMutation(repo, (id: string) => api.gitOplogDismiss(repo, id), {
    // Local operation-journal write — never park it offline.
    networkMode: "always",
  });
}
