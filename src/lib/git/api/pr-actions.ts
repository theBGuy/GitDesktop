import { invoke } from "@/lib/tauri/invoke";
import type {
  ApprovalState,
  ForgeUserRef,
  GitLabMrMergeState,
  PrTask,
  RemoteLens,
} from "../types";
import type { MergeStrategy } from "./pr-resolve";

/** Set a merge/pull request's assignees — GitHub + GitLab (`implemented.mrAssignees`);
 *  Bitbucket has no PR assignee concept. */
export const forgeMrSetAssignees = (
  repoPath: string,
  number: number,
  assignees: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_mr_set_assignees", { repoPath, number, assignees, lens });

// MR comment, close/reopen, title/body edit and merge are provider-neutral, as are
// full reviews (see `forgePrReviewSubmit` in pr-reviews.ts). `asBot` posts as the
// configured GitLab review-bot identity instead of the signed-in user (other
// providers ignore it).
export const forgePrComment = (
  repoPath: string,
  number: number,
  body: string,
  asBot: boolean | undefined,
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_comment", {
    repoPath,
    number,
    body,
    asBot: asBot ?? null,
    lens,
  });

// MR approve/unapprove and request-changes are GitLab + Bitbucket controls (GitHub
// does both via its Review menu); the approvals read drives their states.
export const forgePrApprovals = (repoPath: string, number: number) =>
  invoke<ApprovalState>("forge_pr_approvals", { repoPath, number });

export const forgePrApprove = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_approve", { repoPath, number, lens });

export const forgePrUnapprove = (repoPath: string, number: number) =>
  invoke<void>("forge_pr_unapprove", { repoPath, number });

/** Request changes on an MR (adds the viewer as a reviewer when needed); a
 *  non-empty `body` is posted as a comment alongside. */
export const forgePrRequestChanges = (
  repoPath: string,
  number: number,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_pr_request_changes", { repoPath, number, body, lens });

/** Revoke the viewer's requested-changes state — Bitbucket-only (its revoke works
 *  on every plan, making the control a true toggle; GitLab's undo is Premium). */
export const forgePrUnrequestChanges = (repoPath: string, number: number) =>
  invoke<void>("forge_pr_unrequest_changes", { repoPath, number });

/** Toggle a PR's draft state both ways, for all three providers. Bitbucket PUTs
 *  `draft`; GitLab shells `glab mr update --ready|--draft`; GitHub shells
 *  `gh pr ready [--undo]`. `lens` is GitHub-only (fork identity) — passed through
 *  and ignored by the GitLab/Bitbucket arms. */
export const forgePrSetDraft = (
  repoPath: string,
  number: number,
  draft: boolean,
  lens?: RemoteLens,
) => invoke<void>("forge_pr_set_draft", { repoPath, number, draft, lens });

/** Replace a PR's reviewer list (ids from `forgePrReviewerCandidates`) — all
 *  three providers (`implemented.mrReviewers`); create-time reviewers remain
 *  Bitbucket-only. */
export const forgePrSetReviewers = (
  repoPath: string,
  number: number,
  reviewers: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_set_reviewers", { repoPath, number, reviewers, lens });

/** Reviewer-picker candidates for a PR — Bitbucket: workspace members minus the
 *  user the server would reject. For an existing PR pass its number (the PR author
 *  is excluded); at create time pass `null` (no PR yet — the viewer is excluded). */
export const forgePrReviewerCandidates = (
  repoPath: string,
  number: number | null,
  lens: RemoteLens,
) =>
  invoke<ForgeUserRef[]>("forge_pr_reviewer_candidates", {
    repoPath,
    number,
    lens,
  });

// Comment edit/delete are provider-neutral (GitHub via `gh`, GitLab via `glab`,
// Bitbucket via its API). `number` is the PR/MR (or issue) the comment lives on —
// GitLab/Bitbucket address the note by MR/issue + comment id, GitHub ignores it.
export const forgePrEditComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_pr_edit_comment", { repoPath, number, commentId, body });

export const forgePrDeleteComment = (
  repoPath: string,
  number: number,
  commentId: string,
) => invoke<void>("forge_pr_delete_comment", { repoPath, number, commentId });

// Edit/delete a comment inside a file:line-anchored review thread (the same
// provider-neutral dispatch as the conversation ones; `commentId` is the thread
// comment's provider id).
export const forgePrEditReviewComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_pr_edit_review_comment", {
    repoPath,
    number,
    commentId,
    body,
  });

export const forgePrDeleteReviewComment = (
  repoPath: string,
  number: number,
  commentId: string,
) =>
  invoke<void>("forge_pr_delete_review_comment", {
    repoPath,
    number,
    commentId,
  });

/** GitHub `ReportedContentClassifiers` reasons for hiding a comment. */
export type MinimizeReason =
  | "OFF_TOPIC"
  | "OUTDATED"
  | "RESOLVED"
  | "DUPLICATE"
  | "SPAM"
  | "ABUSE";

export const ghPrMinimizeComment = (
  repoPath: string,
  commentId: string,
  classifier: MinimizeReason,
) =>
  invoke<void>("gh_pr_minimize_comment", { repoPath, commentId, classifier });

export const ghPrUnminimizeComment = (repoPath: string, commentId: string) =>
  invoke<void>("gh_pr_unminimize_comment", { repoPath, commentId });

/** Discards an unsubmitted (PENDING) review by its node id; only its author sees one. */
export const ghPrDiscardPendingReview = (repoPath: string, reviewId: string) =>
  invoke<void>("gh_pr_discard_pending_review", { repoPath, reviewId });

/** Outcome of an ACCEPTED forge merge (a failure rejects the invoke instead).
 *  `queued` means the forge took the merge but hasn't completed it — the PR is
 *  NOT merged yet. `cleanupWarning` carries the human-readable detail either
 *  way: on the merged path that the post-merge remote head-branch deletion
 *  failed (GitHub-only — GitLab and Bitbucket fold deletion into their atomic
 *  merge); on the queued path, what was queued. `null` = nothing to add. */
export interface PrMergeOutcome {
  queued: boolean;
  cleanupWarning: string | null;
}

// MR merge is provider-neutral (GitHub via `gh pr merge`, GitLab via `glab`). `sha`
// is GitLab's optional stale-view guard (it 409s if the head moved since the user
// loaded the MR); GitHub has no analogue and ignores it.
export const forgePrMerge = (
  repoPath: string,
  number: number,
  strategy: MergeStrategy,
  deleteBranch: boolean,
  sha: string | undefined,
  lens: RemoteLens,
) =>
  invoke<PrMergeOutcome>("forge_pr_merge", {
    repoPath,
    number,
    strategy,
    deleteBranch,
    sha: sha ?? null,
    lens,
  });

// GitLab auto-merge (merge-when-pipeline-succeeds) — GitLab-only, gated on
// `implemented.mrAutoMerge`. The merge/pipeline state drives the arm affordance
// and the "auto-merge enabled" footer indicator.
export const forgeGlMrMergeState = (repoPath: string, number: number) =>
  invoke<GitLabMrMergeState>("forge_gl_mr_merge_state", { repoPath, number });

// Arm auto-merge with a strategy ("merge" | "squash"; "rebase" is rejected
// backend-side). `sha` is the same stale-view guard as a plain merge — GitLab
// 409s if the head moved. 405s only when no auto-merge strategy is available and
// the head pipeline isn't passing; a passing one merges immediately instead.
export const forgeGlMrAutoMerge = (
  repoPath: string,
  number: number,
  strategy: MergeStrategy,
  deleteBranch: boolean,
  sha?: string,
) =>
  invoke<void>("forge_gl_mr_auto_merge", {
    repoPath,
    number,
    strategy,
    deleteBranch,
    sha: sha ?? null,
  });

export const forgeGlMrCancelAutoMerge = (repoPath: string, number: number) =>
  invoke<void>("forge_gl_mr_cancel_auto_merge", { repoPath, number });

export const forgePrClose = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_close", { repoPath, number, lens });

export const forgePrReopen = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_reopen", { repoPath, number, lens });

/** Merge (or `rebase`) the base branch into a PR's head — GitHub's
 *  "Update branch". Queued, not synchronous: GitHub answers 202 Accepted and runs
 *  the update afterwards, so resolving means accepted, not that the head has moved. */
export const ghPrUpdateBranch = (
  repoPath: string,
  number: number,
  rebase: boolean,
  lens: RemoteLens,
) => invoke<void>("gh_pr_update_branch", { repoPath, number, rebase, lens });

/** Approve a workflow run GitHub is holding for maintainer approval (a
 *  first-time contributor's fork PR). GitHub-only; the run read/rerun/cancel
 *  wrappers live in `lib/github/actions.ts`. */
export const forgeCiRunApprove = (
  repoPath: string,
  runId: number,
  lens?: RemoteLens,
) =>
  invoke<void>("forge_ci_run_approve", {
    repoPath,
    runId: String(runId),
    lens: lens ?? null,
  });

export const ghPrCheckout = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_pr_checkout", { repoPath, number, lens });

// ── Bitbucket PR tasks ───────────────────────────────────────────────────────

/** A PR's task checklist, in list order (Bitbucket-only — `implemented.prTasks`). */
export const forgeBbPrTasks = (repoPath: string, number: number) =>
  invoke<PrTask[]>("forge_bb_pr_tasks", { repoPath, number });

/** Create a PR task from free-text (empty text is rejected server-side). */
export const forgeBbPrTaskCreate = (
  repoPath: string,
  number: number,
  text: string,
) => invoke<PrTask>("forge_bb_pr_task_create", { repoPath, number, text });

/** Edit a PR task's text (`taskId` is the numeric server id as a String). */
export const forgeBbPrTaskEdit = (
  repoPath: string,
  number: number,
  taskId: string,
  text: string,
) =>
  invoke<PrTask>("forge_bb_pr_task_edit", { repoPath, number, taskId, text });

/** Resolve / unresolve a PR task. */
export const forgeBbPrTaskSetState = (
  repoPath: string,
  number: number,
  taskId: string,
  resolved: boolean,
) =>
  invoke<PrTask>("forge_bb_pr_task_set_state", {
    repoPath,
    number,
    taskId,
    resolved,
  });

/** Delete a PR task. */
export const forgeBbPrTaskDelete = (
  repoPath: string,
  number: number,
  taskId: string,
) => invoke<void>("forge_bb_pr_task_delete", { repoPath, number, taskId });
