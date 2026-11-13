import { useQuery } from "@tanstack/react-query";
import { gitBranchTips } from "@/lib/git/api";
import { keepPreviousDataForRepo, useRepoIdentity } from "@/lib/git/queries";
import { repoIdentityStrict } from "@/lib/git/repo-identity";
import { readTipStates } from "./restore";
import { DELETED_BRANCHES_KEY, loadDeletedBranches } from "./store";

export { DELETED_BRANCHES_KEY };

/** The list a repository's Recover lost work shows. Keyed by the repo's identity,
 *  so every linked worktree reads one list; disabled while that lookup is pending.
 *  Once it has failed, the read resolves the identity strictly itself: the writers
 *  never key on the raw path, so a failure must reach the read-failed arm, whose
 *  Retry resolves it again. */
export function useDeletedBranches(repoPath: string, enabled: boolean) {
  const { data: identity, isError } = useRepoIdentity(repoPath);
  return useQuery({
    queryKey:
      identity === undefined
        ? ([...DELETED_BRANCHES_KEY, repoPath, "unresolved"] as const)
        : ([...DELETED_BRANCHES_KEY, identity] as const),
    queryFn: () =>
      identity === undefined
        ? repoIdentityStrict(repoPath).then(loadDeletedBranches)
        : loadDeletedBranches(identity),
    enabled: enabled && (identity !== undefined || isError),
    // Another instance or checkout may have written since the last read.
    staleTime: 0,
    // Local read: the default "online" mode would park it offline.
    networkMode: "always",
  });
}

/** Whether each listed tip's commit still exists. Inside the repo subtree, so a
 *  repo write's settle re-reads it. A list change keeps the previous answers on
 *  screen while the new key reads, so a pruned row's footer never flickers to
 *  Restore; each answer is per commit, so the old map stays true for its tips. */
export function useDeletedTipStates(
  repoPath: string,
  tips: readonly string[],
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "deleted-tip-states", tips.join(",")] as const,
    queryFn: () => readTipStates(repoPath, tips),
    enabled: enabled && tips.length > 0,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousDataForRepo(repoPath),
    networkMode: "always",
  });
}

/** The live tips of listed names that exist again, so a row whose branch is
 *  back at the recorded commit can clear. Keyed on the names as an array (a
 *  name can hold a comma) inside the repo subtree, so a repo write re-reads it.
 *  No placeholder: until this read answers, such a row stays held. */
export function useDeletedNameTips(
  repoPath: string,
  names: readonly string[],
  enabled: boolean,
) {
  const sorted = [...new Set(names)].sort();
  return useQuery({
    queryKey: ["repo", repoPath, "deleted-name-tips", sorted] as const,
    queryFn: () => gitBranchTips(repoPath, sorted),
    enabled: enabled && sorted.length > 0,
    staleTime: 30_000,
    retry: false,
    networkMode: "always",
  });
}
