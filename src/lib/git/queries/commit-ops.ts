import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { RewriteStep } from "../types";
import { useRepoMutation } from "./internal";

export function useResetToCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitReset(repo, hash));
}

/** Moves the CURRENT branch and the working tree to `hash`. The backend refuses
 *  outright while tracked changes are outstanding, so the caller's confirm can
 *  promise a clean tree is required rather than pre-flighting one. */
export function useHardResetToCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) =>
    api.gitReset(repo, hash, "hard"),
  );
}

export function useCheckoutCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) =>
    api.gitCheckoutCommit(repo, hash),
  );
}

export function useRevertCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitRevert(repo, hash));
}

export function useCherryPick(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitCherryPick(repo, hash));
}

export function useCherryPickOnto(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hashes: string[]; targetBranch: string }) =>
      api.gitCherryPickOnto(repo, args.hashes, args.targetBranch),
  );
}

export function useCreateTag(repo: string) {
  return useRepoMutation(repo, (args: { name: string; hash: string }) =>
    api.gitTag(repo, args.name, args.hash),
  );
}

export function useRewriteCommits(repo: string) {
  return useRepoMutation(repo, (args: { base: string; steps: RewriteStep[] }) =>
    api.gitRewriteCommits(repo, args.base, args.steps),
  );
}

/** Starts a resumable interactive rebase (for plans containing an `edit`); the
 *  rebase pauses and the conflict/op banner takes over. */
export function useRebaseEdit(repo: string) {
  return useRepoMutation(repo, (args: { base: string; steps: RewriteStep[] }) =>
    api.gitRebaseEdit(repo, args.base, args.steps),
  );
}

/** Full messages for the unpushed commits `base..HEAD`, as a hash→message map,
 *  for the Edit-history editor's reword/squash defaults. Enabled only when the
 *  dialog is open with a base. */
export function useUnpushedMessages(
  repo: string,
  base: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "unpushed-messages", base] as const,
    queryFn: async () => {
      const list = await api.gitUnpushedMessages(repo, base);
      return Object.fromEntries(list.map((c) => [c.hash, c.message]));
    },
    enabled: enabled && base !== "",
    staleTime: 0,
  });
}
