import { invoke } from "@/lib/tauri/invoke";
import type {
  Branch,
  BranchDivergence,
  BranchRewriteStatus,
  MergePreview,
  RemoteBranch,
} from "../types";

export const gitBranches = (repoPath: string) =>
  invoke<Branch[]>("git_branches", { repoPath });

export const gitRemoteBranches = (repoPath: string) =>
  invoke<RemoteBranch[]>("git_remote_branches", { repoPath });

export const gitCheckoutBranch = (repoPath: string, name: string) =>
  invoke<void>("git_checkout_branch", { repoPath, name });

export const gitCheckoutRemoteBranch = (
  repoPath: string,
  remote: string,
  name: string,
) => invoke<void>("git_checkout_remote_branch", { repoPath, remote, name });

export const gitCreateBranch = (
  repoPath: string,
  name: string,
  checkout: boolean,
  startPoint?: string,
  noTrack?: boolean,
) =>
  invoke<void>("git_create_branch", {
    repoPath,
    name,
    checkout,
    startPoint: startPoint ?? null,
    noTrack: noTrack ?? false,
  });

export const gitSetBranchArchived = (
  repoPath: string,
  name: string,
  archived: boolean,
) => invoke<void>("git_set_branch_archived", { repoPath, name, archived });

export const gitRenameBranch = (
  repoPath: string,
  oldName: string,
  newName: string,
) => invoke<void>("git_rename_branch", { repoPath, oldName, newName });

export const gitDeleteBranch = (repoPath: string, name: string) =>
  invoke<void>("git_delete_branch", { repoPath, name });

/** Deletes `name` on `remote` (`git push <remote> --delete`). Idempotent when
 *  the remote ref is already gone. */
export const gitDeleteRemoteBranch = (
  repoPath: string,
  remote: string,
  name: string,
) => invoke<void>("git_delete_remote_branch", { repoPath, remote, name });

export const gitDefaultBranch = (repoPath: string) =>
  invoke<string | null>("git_default_branch", { repoPath });

/** Conflict-auto-resolve strategy for a merge: "none" stops on conflicts,
 *  "ours"/"theirs" auto-resolve conflicting hunks via `-X`. */
export type MergeConflictStrategy = "none" | "ours" | "theirs";

export const gitMerge = (
  repoPath: string,
  branch: string,
  squash: boolean,
  noFf: boolean,
  strategy: MergeConflictStrategy,
) => invoke<void>("git_merge", { repoPath, branch, squash, noFf, strategy });

export const gitMergePreview = (
  repoPath: string,
  branch: string,
  strategy: MergeConflictStrategy,
) => invoke<MergePreview>("git_merge_preview", { repoPath, branch, strategy });

export const gitRebase = (repoPath: string, branch: string) =>
  invoke<void>("git_rebase", { repoPath, branch });

/** Rebases the current branch onto `newBase`, replaying only the commits after
 *  `oldBase` (`oldBase..HEAD`) — the "branched off the wrong branch" fix. */
export const gitRebaseOnto = (
  repoPath: string,
  newBase: string,
  oldBase: string,
) => invoke<void>("git_rebase_onto", { repoPath, newBase, oldBase });

export const gitBranchDivergence = (repoPath: string, base: string) =>
  invoke<BranchDivergence[]>("git_branch_divergence", { repoPath, base });

/** Whether `branch`'s upstream was rewritten under it, and what a reset to that
 *  upstream would cost. Read-only (rev-parse / rev-list only). */
export const gitBranchRewriteStatus = (repoPath: string, branch: string) =>
  invoke<BranchRewriteStatus>("git_branch_rewrite_status", {
    repoPath,
    branch,
  });

/** Points `branch` at its upstream's tip without checking it out. Refuses when
 *  the branch is checked out anywhere (naming the worktree, or pointing at the
 *  sync controls for the current branch — that arm takes `gitReset` (commit-ops.ts)
 *  in `"hard"` mode, which moves the working tree too).
 *
 *  `expectedTip` is the sha the caller measured and showed the user: the backend
 *  re-resolves the upstream and refuses if it has moved since, so a background
 *  fetch during the confirmation can't redirect the reset. */
export const gitBranchResetToUpstream = (
  repoPath: string,
  branch: string,
  expectedTip: string,
) =>
  invoke<void>("git_branch_reset_to_upstream", {
    repoPath,
    branch,
    expectedTip,
  });

export interface MergePair {
  base: string;
  head: string;
}

export interface BranchMergeState {
  /** `head` is fully merged into `base` (nothing left to merge). */
  merged: boolean;
  /** The `head` branch still exists locally. */
  headExists: boolean;
}

/** Per pair: whether `head` is merged into `base`, and whether `head` exists. */
export const gitBranchMergeStates = (repoPath: string, pairs: MergePair[]) =>
  invoke<BranchMergeState[]>("git_branch_merge_states", { repoPath, pairs });

/** Resolves to "up-to-date" | "fast-forward" | "merge". */
export const gitUpdateBranchFrom = (
  repoPath: string,
  branch: string,
  base: string,
) => invoke<string>("git_update_branch_from", { repoPath, branch, base });

/** Current tip SHA of each requested local branch (one for-each-ref call).
 *  Branches that don't exist are omitted. Used to watch open local PRs' heads. */
export const gitBranchTips = (repoPath: string, branches: string[]) =>
  invoke<Record<string, string>>("git_branch_tips", { repoPath, branches });
