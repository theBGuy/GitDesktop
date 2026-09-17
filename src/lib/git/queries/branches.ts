import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reloadReviewNotes } from "@/lib/review-notes/store";
import { useUiStore } from "@/lib/stores/ui";
import * as api from "../api";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";

export function useBranches(repo: string) {
  return useQuery({
    queryKey: repoKeys.branches(repo),
    queryFn: () => api.gitBranches(repo),
  });
}

/** Branches that exist on a remote (reflecting the last fetch), for the switcher's
 *  "Remote" group. `enabled` gates the fetch so it only runs while the menu is
 *  open, like the divergence/worktree queries. */
export function useRemoteBranches(repo: string, enabled = true) {
  return useQuery({
    queryKey: ["repo", repo, "remote-branches"] as const,
    queryFn: () => api.gitRemoteBranches(repo),
    enabled: enabled && Boolean(repo),
    staleTime: 30_000,
  });
}

export function useCheckoutBranch(repo: string) {
  return useRepoMutation(repo, (name: string) =>
    api.gitCheckoutBranch(repo, name),
  );
}

export function useCheckoutRemoteBranch(repo: string) {
  return useRepoMutation(repo, (args: { remote: string; name: string }) =>
    api.gitCheckoutRemoteBranch(repo, args.remote, args.name),
  );
}

export function useCreateBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      name: string;
      checkout: boolean;
      startPoint?: string;
      noTrack?: boolean;
    }) =>
      api.gitCreateBranch(
        repo,
        args.name,
        args.checkout,
        args.startPoint,
        args.noTrack,
      ),
  );
}

export function useDefaultBranch(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "default-branch"] as const,
    queryFn: () => api.gitDefaultBranch(repo),
  });
}

export function useRenameBranch(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: { oldName: string; newName: string }) =>
      api.gitRenameBranch(repo, args.oldName, args.newName),
    {
      onSuccess: (_data, args) => {
        // Re-key the branch's commit draft before the status refetch reports the new
        // name, so the draft (and any generation streaming into it) survives.
        // Renames from outside the app (MCP, a terminal `git branch -m`) have no such
        // hook and still lose the draft when the ambient poll flips the key.
        useUiStore
          .getState()
          .migrateCommitDraft(repo, args.oldName, args.newName);
        // The backend moved the branch's reviewer note on disk as part of the rename;
        // reload the in-memory store BEFORE invalidating (the focus bridge's pattern in
        // App.tsx) so the Create-PR dialog reads the note under the new name without
        // waiting for a focus cycle. Fire-and-forget — this callback must stay sync.
        void reloadReviewNotes()
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ["review-notes"] }),
          )
          .catch(() => {
            // Best-effort: a failed reload just leaves the last known state.
          });
      },
    },
  );
}

export function useSetBranchArchived(repo: string) {
  return useRepoMutation(repo, (args: { name: string; archived: boolean }) =>
    api.gitSetBranchArchived(repo, args.name, args.archived),
  );
}

export function useDeleteBranch(repo: string) {
  return useRepoMutation(repo, (name: string) =>
    api.gitDeleteBranch(repo, name),
  );
}

/** Deletes a branch on its remote (`git push <remote> --delete`). Invalidates
 *  the remote-branches list (the row disappears) and the local branches (their
 *  upstream may now be gone). */
export function useDeleteRemoteBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { remote: string; name: string }) =>
      api.gitDeleteRemoteBranch(repo, args.remote, args.name),
    {
      invalidate: [["repo", repo, "remote-branches"], repoKeys.branches(repo)],
    },
  );
}

export function useMergeBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      branch: string;
      squash: boolean;
      noFf: boolean;
      strategy: api.MergeConflictStrategy;
    }) =>
      api.gitMerge(repo, args.branch, args.squash, args.noFf, args.strategy),
  );
}

/** Predicts a merge's outcome (fast-forward / clean / conflict / …) in memory,
 *  for the merge picker. Strategy-aware — re-runs when the conflict strategy
 *  changes so the prediction matches what the merge will actually do. Enabled
 *  only while the picker is open with a branch. */
export function useMergePreview(
  repo: string,
  branch: string,
  strategy: api.MergeConflictStrategy,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "merge-preview", branch, strategy] as const,
    queryFn: () => api.gitMergePreview(repo, branch, strategy),
    enabled: enabled && branch !== "",
    staleTime: 15_000,
  });
}

export function useRebaseBranch(repo: string) {
  return useRepoMutation(repo, (branch: string) => api.gitRebase(repo, branch));
}

/** Rebases the current branch onto `newBase`, replaying only `oldBase..HEAD`
 *  (the "branched off the wrong branch" fix). Conflicts leave the rebase in
 *  progress for the conflict banner, exactly like {@link useRebaseBranch}. */
export function useRebaseOnto(repo: string) {
  return useRepoMutation(repo, (args: { newBase: string; oldBase: string }) =>
    api.gitRebaseOnto(repo, args.newBase, args.oldBase),
  );
}

/** Ahead/behind of every local branch vs `base`. Gated on `enabled` (it's N rev-list
 *  calls) and keyed under the repo so branch mutations invalidate it. */
export function useBranchDivergence(
  repo: string,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "divergence", base] as const,
    queryFn: () => api.gitBranchDivergence(repo, base ?? ""),
    enabled: enabled && Boolean(base),
    // Local rev-list reads only. react-query's default "online" mode parks the
    // fetch whenever the OS reports no connection, and a parked query is neither
    // loading nor errored — consumers would silently render without divergence.
    networkMode: "always",
  });
}

export function useUpdateBranchFrom(repo: string) {
  return useRepoMutation(repo, (args: { branch: string; base: string }) =>
    api.gitUpdateBranchFrom(repo, args.branch, args.base),
  );
}

/**
 * Whether a diverged branch's upstream was rewritten under it (a remote rebase
 * or force-push), and what a reset to that upstream would cost.
 *
 * LAZY on purpose: `enabled` must stay false unless a surface is actually facing
 * a diverged branch, so the ordinary in-sync path spawns no git. Keyed under the
 * repo, so the whole-subtree invalidation every fetch/pull/push mutation already
 * runs refreshes it. Local rev-list reads only — `networkMode: "always"` keeps
 * an offline OS from parking the query into a permanent pending state, matching
 * {@link useBranchDivergence}.
 */
export function useBranchRewriteStatus(
  repo: string,
  branch: string | null,
  opts: { enabled: boolean },
) {
  return useQuery({
    ...branchRewriteStatusOptions(repo, branch ?? ""),
    enabled: opts.enabled && Boolean(branch),
  });
}

/** The one options object behind {@link useBranchRewriteStatus}. Exported so an
 *  IMPERATIVE probe — a palette action that has to decide before it acts, with no
 *  render to hang a hook on — reads and caches exactly what the hook would, rather
 *  than a second spelling that can drift from it. */
export function branchRewriteStatusOptions(repo: string, branch: string) {
  return {
    queryKey: ["repo", repo, "rewrite-status", branch] as const,
    queryFn: () => api.gitBranchRewriteStatus(repo, branch),
    staleTime: 30_000,
    networkMode: "always" as const,
  };
}

/** Points a NON-current branch at its upstream's tip, refusing if that upstream
 *  moved away from `expectedTip` since the caller measured it. The current branch
 *  takes {@link useHardResetToCommit} instead — only that moves the working tree
 *  with it. */
export function useBranchResetToUpstream(repo: string) {
  return useRepoMutation(
    repo,
    (args: { branch: string; expectedTip: string }) =>
      api.gitBranchResetToUpstream(repo, args.branch, args.expectedTip),
  );
}
