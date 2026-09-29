import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { RewriteStep } from "../types";
import { useRepoMutation } from "./internal";

export function useResetToCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitReset(repo, hash), {
    // Local history write — never park it offline.
    networkMode: "always",
  });
}

/** Moves the CURRENT branch and the working tree to `hash`. The backend refuses
 *  outright while tracked changes are outstanding, so the caller's confirm can
 *  promise a clean tree is required rather than pre-flighting one. */
export function useHardResetToCommit(repo: string) {
  return useRepoMutation(
    repo,
    (hash: string) => api.gitReset(repo, hash, "hard"),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCheckoutCommit(repo: string) {
  return useRepoMutation(
    repo,
    (hash: string) => api.gitCheckoutCommit(repo, hash),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useRevertCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitRevert(repo, hash), {
    // Local history write — never park it offline.
    networkMode: "always",
  });
}

export function useCherryPick(repo: string) {
  return useRepoMutation(
    repo,
    (hash: string) => api.gitCherryPick(repo, hash),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCherryPickOnto(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hashes: string[]; targetBranch: string }) =>
      api.gitCherryPickOnto(repo, args.hashes, args.targetBranch),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCreateTag(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; hash: string }) =>
      api.gitTag(repo, args.name, args.hash),
    {
      // Pinned: the call and its invalidation close over `repo`, and the history/tags
      // hosts survive a repo switch — without the key a switch retargets the pending
      // create, tagging the wrong repo.
      identity: ["create-tag", repo],
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useRewriteCommits(repo: string) {
  return useRepoMutation(
    repo,
    (args: { base: string; steps: RewriteStep[] }) =>
      api.gitRewriteCommits(repo, args.base, args.steps),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Starts a resumable interactive rebase (for plans containing an `edit`); the
 *  rebase pauses and the conflict/op banner takes over. */
export function useRebaseEdit(repo: string) {
  return useRepoMutation(
    repo,
    (args: { base: string; steps: RewriteStep[] }) =>
      api.gitRebaseEdit(repo, args.base, args.steps),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
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
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}
