import { invoke } from "@/lib/tauri/invoke";
import type { MergePreview, RemoteLens } from "../types";

export type MergeStrategy = "merge" | "squash" | "rebase" | "fast_forward";

/** Outcome of starting or finishing a local-PR merge: `merged` committed; `conflicts`
 *  paused in an isolated worktree for the user to resolve, without touching their
 *  branch or working tree (the worktree fields feed finish/abort). */
export interface LocalPrMergeOutcome {
  status: "merged" | "conflicts";
  conflicts: string[];
  /** The base tip after a successful merge (informational). */
  baseTip: string;
  /** The detached worktree holding the in-progress merge; null when merged clean. */
  worktreePath: string | null;
  /** The worktree's id, passed to finish; null when merged clean. */
  worktreeId: string | null;
  /** The oplog entry id, passed to finish/abort. */
  opId: string | null;
}

export const gitMergeLocalPr = (
  repoPath: string,
  base: string,
  head: string,
  message: string,
  strategy: MergeStrategy,
) =>
  invoke<LocalPrMergeOutcome>("git_merge_local_pr", {
    repoPath,
    base,
    head,
    message,
    strategy,
  });

/** Commits a paused local-PR merge once its conflicts are resolved (staged) in the
 *  worktree at `worktreePath`. May itself return `conflicts` again for a multi-step
 *  rebase that re-pauses (in the same worktree). */
export const gitFinishLocalPrMerge = (
  repoPath: string,
  base: string,
  strategy: MergeStrategy,
  message: string,
  worktreePath: string,
  worktreeId: string,
  opId: string | null,
) =>
  invoke<LocalPrMergeOutcome>("git_finish_local_pr_merge", {
    repoPath,
    base,
    strategy,
    message,
    worktreePath,
    worktreeId,
    opId,
  });

/** Rolls a paused local-PR merge back by deleting the merge worktree — the user's
 *  branch and working tree were never touched, so nothing else to undo. */
export const gitAbortLocalPrMerge = (
  repoPath: string,
  worktreePath: string,
  opId: string | null,
) =>
  invoke<void>("git_abort_local_pr_merge", {
    repoPath,
    worktreePath,
    opId,
  });

/** Outcome of merging a remote PR's base INTO its head branch: `pushed` merged clean
 *  and the head branch was updated on the forge (never force); `conflicts` paused in
 *  an isolated worktree for the user to resolve (its fields feed finish/abort). */
export interface RemotePrResolveOutcome {
  status: "pushed" | "conflicts";
  /** May be EMPTY on a `conflicts` outcome that re-attached to an existing worktree
   *  whose conflicts are all resolved already — Finish is the next step, not a fault. */
  conflicts: string[];
  /** The detached worktree holding the paused merge; null when it pushed clean. */
  worktreePath: string | null;
  /** The worktree's id, passed to finish; null when it pushed clean. */
  worktreeId: string | null;
  /** The head branch's new tip after a successful push (informational). */
  pushedSha: string | null;
}

/** An existing resolve worktree, as returned by {@link gitFindRemotePrResolve}. The id
 *  is backend-owned — never derived from the path. */
export interface RemotePrResolveHandle {
  worktreePath: string;
  worktreeId: string;
}

/** Merges the lens remote's `<base>` into the PR's head branch in a hidden detached
 *  worktree — the user's branch and working tree are untouched. Idempotent: an existing
 *  resolve worktree for this PR+lens comes back as `conflicts` instead of a duplicate. */
export const gitMergeRemotePr = (
  repoPath: string,
  number: number,
  base: string,
  head: string,
  message: string | null,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveOutcome>("git_merge_remote_pr", {
    repoPath,
    number,
    base,
    head,
    message,
    lens,
  });

/** Commits a paused remote-PR resolution and pushes the head branch. Errors while any
 *  conflict is unresolved, and errors KEEPING the worktree if the remote head moved. */
export const gitFinishRemotePrResolve = (
  repoPath: string,
  head: string,
  worktreePath: string,
  worktreeId: string,
  message: string | null,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveOutcome>("git_finish_remote_pr_resolve", {
    repoPath,
    head,
    worktreePath,
    worktreeId,
    message,
    lens,
  });

/** Discards a paused remote-PR resolution by deleting its worktree — nothing was
 *  pushed and the user's branch was never touched, so nothing else to undo. */
export const gitAbortRemotePrResolve = (
  repoPath: string,
  worktreePath: string,
) => invoke<void>("git_abort_remote_pr_resolve", { repoPath, worktreePath });

/** The existing resolve worktree for this PR under this lens, or null — lets the view
 *  offer to resume a resolution left behind by an earlier session. */
export const gitFindRemotePrResolve = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveHandle | null>("git_find_remote_pr_resolve", {
    repoPath,
    number,
    lens,
  });

/** In-memory prediction of whether merging `head` into `base` will conflict, for
 *  the pre-merge preview line. Reuses the existing `MergePreview` shape. */
export const gitConflictPreview = (
  repoPath: string,
  base: string,
  head: string,
) => invoke<MergePreview>("git_conflict_preview", { repoPath, base, head });
