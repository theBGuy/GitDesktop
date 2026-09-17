import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
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

export function useRepoStatus(repo: string) {
  return useQuery({
    queryKey: repoKeys.status(repo),
    queryFn: () => api.gitStatus(repo),
    // A local git read, so it must not park on the default "online" mode the way
    // a forge call does — gates that hold until this answers would never lift.
    networkMode: "always",
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}

/** Per-file line counts for the Changes panel's rows. The key MUST stay a child
 *  of {@link repoKeys.status} — {@link workingTreeKeys} invalidates that key as a
 *  PREFIX, so every staging-class mutation already refreshes these counts with no
 *  extra wiring. `enabled` gates it on the Changes tab being active and the tree
 *  being dirty; a `<TabPanel>`-hidden panel still renders and would otherwise poll. */
export function useWorkingLineStats(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: [...repoKeys.status(repo), "line-stats"],
    queryFn: () => api.gitWorkingLineStats(repo),
    enabled,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}

export function useBranches(repo: string) {
  return useQuery({
    queryKey: repoKeys.branches(repo),
    queryFn: () => api.gitBranches(repo),
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
  });
}

export function useFileDiff(
  repo: string,
  file: { path: string; staged: boolean; untracked: boolean } | null,
) {
  return useQuery({
    // `untracked` is in the key so the untracked→tracked flip (after staging part
    // of a new file) subscribes to a fresh query — the `--no-index` "all new"
    // diff and the normal remainder diff must not share a cache entry, or an
    // invalidation race could leave the stale all-lines view on screen.
    queryKey: [
      ...repoKeys.diff(repo, file?.path ?? "", file?.staged ?? false),
      file?.untracked ?? false,
    ] as const,
    queryFn: () =>
      api.gitDiffFile(
        repo,
        file?.path ?? "",
        file?.staged ?? false,
        file?.untracked ?? false,
      ),
    enabled: file !== null,
  });
}

/**
 * A file's cumulative diff in an agent session worktree vs the session's base commit.
 * `base` is in the key so a restarted session's new base can't cache-hit; idle until
 * `enabled` (the step is expanded). While `live` it polls: the agent edits the worktree
 * through its own CLI, outside any app mutation that could invalidate this, so an open
 * diff would otherwise freeze.
 */
export function useSessionFileDiff(
  repo: string,
  filePath: string,
  base: string,
  enabled: boolean,
  live: boolean,
) {
  return useQuery({
    queryKey: [...repoKeys.diff(repo, filePath, false), "session-base", base],
    queryFn: () => api.gitSessionFileDiff(repo, filePath, base),
    enabled: enabled && Boolean(repo && filePath && base),
    refetchInterval: enabled && live ? 1500 : false,
    refetchIntervalInBackground: false,
  });
}
