export interface RepoOpState {
  merging: boolean;
  rebasing: boolean;
  cherryPicking: boolean;
  reverting: boolean;
  /** An interactive rebase is paused at an `edit` (vs a conflict). */
  editPaused: boolean;
}

export type RepoOp = "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * One journaled entry from GitDesktop's operation log (`oplog.rs`) — a risky compound
 * git op plus the state it started from, so an interrupted op can be traced or
 * recovered. `op`/`status` are typed as their known values but must be rendered
 * tolerantly (a future backend value must not crash the UI). Wire shape is camelCase.
 */
export interface OpLogEntry {
  id: string;
  op:
    | "merge_local_pr"
    | "cherry_pick_onto"
    | "rewrite_commits"
    | "rebase_edit"
    | "pull_rebase_drop";
  /** Human label, e.g. "Squash-merge feature → main". */
  label: string;
  /** "paused" = handed to you mid-op (a stopped cherry-pick or a conflicted rebase
   *  pull), neither in-flight nor finished. "concluded" = that op ended outside the
   *  app, so the journal knows only that it is over (no finish time). */
  status: "pending" | "done" | "failed" | "dismissed" | "paused" | "concluded";
  /** ISO timestamp the op started. */
  startedAt: string;
  /** ISO timestamp the op finished, or null while still open. */
  finishedAt: string | null;
  /** The branch (or "HEAD" if detached) we were on before the op. */
  originalRef: string | null;
  /** Pre-op HEAD sha. */
  originalSha: string;
  /** The reset-rollback target tip, if one was captured. */
  preOpTip: string | null;
  /** Failure detail when `status === "failed"`. */
  error: string | null;
}
