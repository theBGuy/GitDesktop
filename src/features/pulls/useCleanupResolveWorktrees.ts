import { useEffect, useRef } from "react";
import { gitCleanupOrphanedResolveWorktrees } from "@/lib/git/api";
import { useLocalPrs } from "@/lib/pulls/queries";

/**
 * Reclaims leaked conflict-resolution worktrees on repo open — a crash mid-resolve
 * can leave a hidden one behind. Sweeps ONCE per repo (tracked in `sweptRepo`). The
 * one command it calls runs two sweeps:
 *
 * - LOCAL PR (`gd-resolve-*`), keep-set driven: the set is every active paused
 *   merge's `pendingMerge.worktreePath`, taken from the list read below.
 * - REMOTE PR (`gd-pr-resolve-*`), keep-set FREE: the backend instead keeps any
 *   worktree that holds something — a merge in progress, a dirty tree, or a commit
 *   not yet on a remote — and fails closed on an unreadable signal.
 *
 * Gating on `prs.isSuccess` is load-bearing for the local sweep alone: running
 * before the list loads would pass an empty keep-set and delete a genuinely-active
 * resolve worktree. The remote sweep needs no such gate and merely rides along, so
 * the shared gate is deliberately conservative — a failed list read skips remote
 * housekeeping for that repo-open, which costs nothing but a later sweep.
 *
 * Best-effort: errors are swallowed. Mount once per repo.
 */
export function useCleanupResolveWorktrees(repoPath: string) {
  const prs = useLocalPrs(repoPath);
  const sweptRepo = useRef<string | null>(null);

  useEffect(() => {
    // `repoPath` is "" when no repo is open (RepositoryView passes `?? ""`);
    // never sweep in that case.
    if (!repoPath || !prs.isSuccess || sweptRepo.current === repoPath) return;
    sweptRepo.current = repoPath;
    const keep = (prs.data ?? [])
      .map((p) => p.pendingMerge?.worktreePath)
      .filter((p): p is string => Boolean(p));
    gitCleanupOrphanedResolveWorktrees(repoPath, keep).catch(() => undefined);
  }, [repoPath, prs.isSuccess, prs.data]);
}
