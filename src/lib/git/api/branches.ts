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

export const gitSetBranchKeepLocal = (
  repoPath: string,
  name: string,
  keepLocal: boolean,
) => invoke<void>("git_set_branch_keep_local", { repoPath, name, keepLocal });

/** What a completed rename reports beyond success. */
export interface RenameBranchOutcome {
  /** Set when the branch was renamed but its local pull requests couldn't all be
   *  moved to the new name; shown as the success toast's description. */
  warning: string | null;
}

export const gitRenameBranch = (
  repoPath: string,
  oldName: string,
  newName: string,
) =>
  invoke<RenameBranchOutcome>("git_rename_branch", {
    repoPath,
    oldName,
    newName,
  });

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
 *  Two measured shas pin it. `expectedTip` is the upstream tip the user was
 *  shown: the backend re-resolves the upstream and refuses if it has moved, so a
 *  background fetch during the confirmation can't redirect the reset.
 *  `expectedLocalTip` is the branch's own tip then: the backend refuses if the
 *  branch itself moved, so a commit landed meanwhile is never dropped. */
export const gitBranchResetToUpstream = (
  repoPath: string,
  branch: string,
  expectedTip: string,
  expectedLocalTip: string,
) =>
  invoke<void>("git_branch_reset_to_upstream", {
    repoPath,
    branch,
    expectedTip,
    expectedLocalTip,
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

/** What an update did. `holder` is the other checkout the update ran inside (the
 *  `worktree list --porcelain` path spelling) when another checkout holds the
 *  branch, else null. */
export type UpdateBranchOutcome = {
  outcome: "merge" | "up-to-date" | "fast-forward";
  holder: string | null;
};

export const gitUpdateBranchFrom = (
  repoPath: string,
  branch: string,
  base: string,
) =>
  invoke<UpdateBranchOutcome>("git_update_branch_from", {
    repoPath,
    branch,
    base,
  });

/** Current tip SHA of each requested local branch (one for-each-ref call).
 *  Branches that don't exist are omitted. Used to watch open local PRs' heads. */
export const gitBranchTips = (repoPath: string, branches: string[]) =>
  invoke<Record<string, string>>("git_branch_tips", { repoPath, branches });

/** "clean": every change on the branch reached the base, at its tip or in a
 *  first-parent commit of its history, or the branch is an older version of a
 *  merged pull request whose final head passes the same check.
 *  "changes": merging into the base tip wrote another tree or conflicted, and
 *  no other route cleared it, which doesn't prove the branch was never merged.
 *  "unknown": the check couldn't decide; never read as clean. */
export type ContentVerdict = "clean" | "changes" | "unknown";

/** The commit content verdicts compare against. `refName` is the short display
 *  form ("main" / "origin/main"); `tree` is `sha`'s tree, resolved once. */
export interface ContentCheckBase {
  refName: string;
  sha: string;
  tree: string;
}

export interface BranchContentMerged {
  branch: string;
  verdict: ContentVerdict;
  /** The tip the verdict was computed for; null when the branch didn't resolve. */
  headSha: string | null;
  /** The base-history commit that cleared the check, for the branch or its PR
   *  head; null for any clean at the base tip, and whenever not clean. Never the
   *  base tip itself, so it is never a stand-in for the base sha. The first
   *  candidate, in search order, whose tree holds the branch's changes: usually
   *  the commit they landed in, but a later commit that also holds them when the
   *  landing wasn't a candidate or ranked behind it. */
  landedIn: string | null;
  /** True only when the clean came through the merged pull request's head. */
  viaPrHead: boolean;
}

/** Why an open has no base: a configured merge driver, merge.default or
 *  merge.renormalize (checked in that order), an unreadable config, git older
 *  than 2.38, a git version that can't be read, or neither side resolving. */
export type ContentCheckOff =
  | "mergeDriver"
  | "mergeDefault"
  | "mergeRenormalize"
  | "configUnreadable"
  | "gitTooOld"
  | "gitVersionUnreadable"
  | "noBase";

/** Exactly one of `base` and `offReason` is non-null. */
export interface ContentCheckBaseRead {
  base: ContentCheckBase | null;
  offReason: ContentCheckOff | null;
}

/** The newer of the default branch and its remote-tracking counterpart, or why
 *  the check is off. */
export const gitContentCheckBase = (repoPath: string, defaultBranch: string) =>
  invoke<ContentCheckBaseRead>("git_content_check_base", {
    repoPath,
    defaultBranch,
  });

/** One branch's verdict against a base from {@link gitContentCheckBase}. A git
 *  failure never reads clean: it reads "unknown", or keeps the base-tip run's
 *  "changes" when a later route fails; it rejects only on invalid input.
 *  `prHead` is the head of the branch's merged pull request, lowercase hex or
 *  null: callers validate it, so nothing relies on the backend ignoring a bad
 *  one. */
export const gitBranchContentMerged = (
  repoPath: string,
  baseSha: string,
  baseTree: string,
  branch: string,
  prHead: string | null,
) =>
  invoke<BranchContentMerged>("git_branch_content_merged", {
    repoPath,
    baseSha,
    baseTree,
    branch,
    prHead,
  });
