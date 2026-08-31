import { invoke } from "@/lib/tauri/invoke";

/** A git worktree: an isolated branch checkout (used for agent sessions). */
export interface WorktreeInfo {
  /** Short session id (also the worktree directory name). */
  id: string;
  /** Absolute path to the worktree checkout. */
  path: string;
  /** The session branch (`gd/session/<id>`), or "" if detached. */
  branch: string;
  /** The commit the worktree was created from — base for the cumulative
   *  `base..HEAD` session diff. Resolved by create; "" from list. */
  base: string;
}

/** Creates a throwaway worktree off `baseRef` (default HEAD) on a fresh
 *  `gd/session/<id>` branch, for an agent session to run inside. */
export const createWorktree = (repoPath: string, baseRef?: string) =>
  invoke<WorktreeInfo>("git_worktree_create", {
    repoPath,
    baseRef: baseRef ?? null,
  });

/** Lists the repo's worktrees (for discovering orphans to clean up). */
export const listWorktrees = (repoPath: string) =>
  invoke<WorktreeInfo[]>("git_worktree_list", { repoPath });

/** A user-facing worktree (richer than `WorktreeInfo`): used by the worktree
 *  manager. Agent-session worktrees are filtered out by the backend and never
 *  appear here. */
export interface UserWorktree {
  /** Absolute path to the checkout (forward slashes, as git reports it). */
  path: string;
  /** Checked-out branch, or "" when detached. */
  branch: string;
  /** The worktree's HEAD commit sha (full). */
  head: string;
  /** The repo's main worktree (listed first); can't be removed. */
  isMain: boolean;
  /** Detached HEAD — no branch checked out. */
  isDetached: boolean;
  /** `git worktree lock`ed — blocks remove without force. */
  isLocked: boolean;
  /** Lock reason, when one was given (else ""). */
  lockReason: string;
  /** Epoch ms of the worktree's last git activity, probed from its index file's
   *  mtime with HEAD as the fallback. null when neither is readable. */
  lastActivityMs: number | null;
}

/** Lists the repo's *user* worktrees for the worktree manager — every checkout
 *  except the agent-session ones, which are app-internal and protected. */
export const listUserWorktrees = (repoPath: string) =>
  invoke<UserWorktree[]>("git_worktree_list_user", { repoPath });

/** Creates a user worktree at `path`. `newBranch` branches a fresh `branch` off
 *  `baseRef` (default HEAD); otherwise it checks out the existing `branch`.
 *  Rejects loudly when the branch is already checked out elsewhere. */
export const addUserWorktree = (
  repoPath: string,
  path: string,
  branch: string,
  newBranch: boolean,
  baseRef?: string,
) =>
  invoke<void>("git_worktree_add_user", {
    repoPath,
    path,
    branch,
    newBranch,
    baseRef: baseRef ?? null,
  });

/** Renames (moves) a user worktree from `fromPath` to `toPath`
 *  (`git worktree move`). Rejects the main worktree, an existing target, or a
 *  locked worktree (git's own message). */
export const moveUserWorktree = (
  repoPath: string,
  fromPath: string,
  toPath: string,
) => invoke<void>("git_worktree_move", { repoPath, fromPath, toPath });

/** Locks a worktree (`git worktree lock`) so git won't prune/move/remove it
 *  without force. `reason` is optional and shown back to the user. */
export const lockWorktree = (repoPath: string, path: string, reason?: string) =>
  invoke<void>("git_worktree_lock", { repoPath, path, reason: reason ?? null });

/** Unlocks a previously locked worktree. */
export const unlockWorktree = (repoPath: string, path: string) =>
  invoke<void>("git_worktree_unlock", { repoPath, path });

/** Repairs worktree links (`git worktree repair`) after the repo folder was
 *  moved or renamed. Safe + idempotent. */
export const repairWorktrees = (repoPath: string) =>
  invoke<void>("git_worktree_repair", { repoPath });

/** Removes a session worktree and (when given) deletes its branch. `force` is
 *  required to drop a worktree with uncommitted changes. */
export const removeWorktree = (
  repoPath: string,
  path: string,
  branch: string | null,
  force: boolean,
) => invoke<void>("git_worktree_remove", { repoPath, path, branch, force });

/** Prunes stale worktree admin entries (e.g. after a crash). */
export const pruneWorktrees = (repoPath: string) =>
  invoke<void>("git_worktree_prune", { repoPath });

/** Re-creates a kept session's worktree, checking out its EXISTING branch at
 *  `path` so the user can resume work (the branch already holds the kept work). */
export const resumeWorktree = (
  repoPath: string,
  path: string,
  branch: string,
) => invoke<void>("git_worktree_resume", { repoPath, path, branch });

/** Stages everything (incl. untracked) in a worktree and commits it. Returns
 *  the new commit hash, or null when the agent changed nothing. Used to commit
 *  each agent turn as a checkpoint. */
export const commitWorktreeAll = (worktreePath: string, message: string) =>
  invoke<string | null>("git_worktree_commit_all", { worktreePath, message });

/** Collapses a session branch's per-turn commits since `base` into one commit.
 *  Returns false when HEAD is already at base. Used by Keep when squashing. */
export const squashWorktree = (
  worktreePath: string,
  base: string,
  message: string,
) => invoke<boolean>("git_worktree_squash", { worktreePath, base, message });
