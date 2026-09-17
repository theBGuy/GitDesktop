import { invoke } from "@/lib/tauri/invoke";

/** Hands a repo-aware CLI review a detached checkout of `sha` so it reads the
 *  PR head's files without moving the active branch: one reused worktree per
 *  repository, or a throwaway mint when that one is unavailable. Returns the
 *  path, or null when one isn't needed/possible (already on that commit, object
 *  not local, or both checkouts failed) — caller uses the repo root. */
export const gitReviewWorktree = (repoPath: string, sha: string) =>
  invoke<string | null>("git_review_worktree", { repoPath, sha });

/** Releases the review workspace: the reused per-repo worktree is unclaimed, a
 *  throwaway mint is removed. Best-effort, idempotent. */
export const gitRemoveWorktree = (repoPath: string, worktreePath: string) =>
  invoke<void>("git_remove_worktree", { repoPath, worktreePath });

/** Reclaims leaked local-PR conflict worktrees: removes every hidden `gd-resolve-*`
 *  worktree whose path is NOT in `keepPaths`. Pass every active paused merge's
 *  `pendingMerge.worktreePath` (as it came from the merge outcome) so an in-progress
 *  resolve is spared. Best-effort housekeeping, run once on repo open. */
export const gitCleanupOrphanedResolveWorktrees = (
  repoPath: string,
  keepPaths: string[],
) =>
  invoke<void>("git_cleanup_orphaned_resolve_worktrees", {
    repoPath,
    keepPaths,
  });
