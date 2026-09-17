import { useQuery } from "@tanstack/react-query";
import {
  addUserWorktree,
  listUserWorktrees,
  lockWorktree,
  moveUserWorktree,
  repairWorktrees,
  unlockWorktree,
} from "../worktree";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";

export const worktreeKey = (repo: string) =>
  ["repo", repo, "user-worktrees"] as const;

/** Shared so an imperative `fetchQuery` on this key can't run under different
 *  options than the hook: a local `git worktree list` read, and react-query's
 *  default "online" mode parks the fetch whenever the OS reports no connection —
 *  a parked query is neither loading nor errored, so a consumer awaiting one
 *  waits forever. */
export function userWorktreesOptions(repo: string) {
  return {
    queryKey: worktreeKey(repo),
    queryFn: () => listUserWorktrees(repo),
    networkMode: "always" as const,
  };
}

/** The repo's user-facing worktrees (session worktrees filtered out by the
 *  backend). `enabled` gates the fetch to the surface asking for it — the
 *  manager, the branch switcher and its cleanup dialog, the branch pickers;
 *  the repo header reads it ungated for the worktree subtitle. */
export function useUserWorktrees(repo: string, enabled = true) {
  return useQuery({
    ...userWorktreesOptions(repo),
    enabled: enabled && Boolean(repo),
    // On the HOOK only — the header observes this key on every open repo, so
    // without a staleTime the window-focus refetch re-spawns `git worktree
    // list` on each Alt-Tab back (mutations invalidate the key regardless).
    // Every hook consumer shares the bound and opens on data up to 30s old,
    // so only external git changes ride the window. The switcher's imperative
    // fetchQuery spreads the OPTIONS and must keep fetch-always semantics for
    // its checkout-redirect guard.
    staleTime: 30_000,
  });
}

/** Creates a user worktree. Invalidates the worktree list + branches (a new
 *  branch may have been created). */
export function useAddUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      path: string;
      branch: string;
      newBranch: boolean;
      baseRef?: string;
    }) =>
      addUserWorktree(
        repo,
        args.path,
        args.branch,
        args.newBranch,
        args.baseRef,
      ),
    { invalidate: [worktreeKey(repo), repoKeys.branches(repo)] },
  );
}

/** Renames (moves) a user worktree to a new path. */
export function useMoveUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { from: string; to: string }) =>
      moveUserWorktree(repo, args.from, args.to),
    { invalidate: [worktreeKey(repo)] },
  );
}

/** Locks a user worktree (optionally with a reason). */
export function useLockUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; reason?: string }) =>
      lockWorktree(repo, args.path, args.reason),
    { invalidate: [worktreeKey(repo)] },
  );
}

/** Unlocks a user worktree. */
export function useUnlockUserWorktree(repo: string) {
  return useRepoMutation(repo, (path: string) => unlockWorktree(repo, path), {
    invalidate: [worktreeKey(repo)],
  });
}

/** Repairs worktree links after the repo folder was moved or renamed. */
export function useRepairWorktrees(repo: string) {
  return useRepoMutation(repo, (_: void) => repairWorktrees(repo), {
    invalidate: [worktreeKey(repo)],
  });
}
