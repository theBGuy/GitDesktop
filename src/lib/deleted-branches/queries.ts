import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { gitBranchTips } from "@/lib/git/api";
import { keepPreviousDataForRepo, useRepoIdentity } from "@/lib/git/queries";
import { repoIdentityStrict } from "@/lib/git/repo-identity";
import { readTipStates } from "./restore";
import { DELETED_BRANCHES_KEY, loadDeletedBranches } from "./store";

export { DELETED_BRANCHES_KEY };

/** A running Restore or Remove from list; an object, so a release clears only
 *  its own claim. */
export type DeletedBranchFlight = { kind: "restoring" | "removing" };

/** The running press per repository identity (the normalized checkout path while
 *  that is unresolved), shared by every Recover lost work mount and checkout.
 *  Never cleared on a repo switch: it is keyed, and each press clears its own. */
export const useDeletedBranchFlights = create<{
  flights: ReadonlyMap<string, DeletedBranchFlight>;
}>(() => ({ flights: new Map() }));

/** Claims `key` for a press; null when a press already runs there or under
 *  `alsoHeldBy` (the path key a press took before the identity resolved).
 *  Synchronous, so a second press in the same render is refused. */
export function claimDeletedBranchFlight(
  key: string,
  kind: DeletedBranchFlight["kind"],
  alsoHeldBy?: string,
): DeletedBranchFlight | null {
  const { flights } = useDeletedBranchFlights.getState();
  if (flights.has(key)) return null;
  if (alsoHeldBy !== undefined && flights.has(alsoHeldBy)) return null;
  const token: DeletedBranchFlight = { kind };
  useDeletedBranchFlights.setState({
    flights: new Map(flights).set(key, token),
  });
  return token;
}

/** Ends the claim on `key` only while it is still `token`'s. */
export function releaseDeletedBranchFlight(
  key: string,
  token: DeletedBranchFlight,
) {
  const { flights } = useDeletedBranchFlights.getState();
  if (flights.get(key) !== token) return;
  const next = new Map(flights);
  next.delete(key);
  useDeletedBranchFlights.setState({ flights: next });
}

/** The list a repository's Recover lost work shows. Read from the repo's identity,
 *  so every linked worktree reads one list; disabled while that lookup is pending.
 *  The key also carries the checkout path, since the read merges entries still
 *  stored under that raw path, so two checkouts never share an answer. Once the
 *  lookup has failed, the read resolves the identity strictly itself: the writers
 *  never key on the raw path, so a failure must reach the read-failed arm, whose
 *  Retry resolves it again. */
export function useDeletedBranches(repoPath: string, enabled: boolean) {
  const { data: identity, isError } = useRepoIdentity(repoPath);
  return useQuery({
    queryKey:
      identity === undefined
        ? ([...DELETED_BRANCHES_KEY, repoPath, "unresolved"] as const)
        : ([...DELETED_BRANCHES_KEY, identity, repoPath] as const),
    queryFn: () =>
      identity === undefined
        ? repoIdentityStrict(repoPath).then((id) =>
            loadDeletedBranches(id, repoPath),
          )
        : loadDeletedBranches(identity, repoPath),
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
 *  Restore; each answer is per commit, so the old map stays true for its tips.
 *  Never stale: a commit pruned outside the app must read pruned on open and on
 *  focus. */
export function useDeletedTipStates(
  repoPath: string,
  tips: readonly string[],
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "deleted-tip-states", tips.join(",")] as const,
    queryFn: () => readTipStates(repoPath, tips),
    enabled: enabled && tips.length > 0,
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousDataForRepo(repoPath),
    networkMode: "always",
  });
}

/** The live tips of listed names that exist again, so a row whose branch is
 *  back at the recorded commit can clear. Keyed on the names as an array (a
 *  name can hold a comma) inside the repo subtree, so a repo write re-reads it.
 *  No placeholder: until this read answers, such a row stays held. It rejects
 *  on a failed git run, which leaves the row pressable under the failed-check
 *  note: the press runs its own name check and overwrites nothing. */
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
