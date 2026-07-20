import { forgeFeatureReady } from "@/lib/git/queries";
import type { ForgeProvider, ForgeStatus } from "@/lib/git/types";

/**
 * Per-action write-capability flags for a remote PR/MR, derived purely from the
 * repo's forge status + detected provider.
 *
 * Gating convention (the repo's forge-gating seam):
 * - `canWrite` is the legacy GitHub full-write gate — "not a known read-only
 *   provider" (`provider !== "gitlab" && provider !== "bitbucket"`) rather than
 *   `=== "github"`. While the forge-status query is still pending or after it
 *   fails, a GitHub PR keeps its write controls exactly as before; only an
 *   explicitly-detected GitLab/Bitbucket repo suppresses them.
 * - A SHARED control (GitHub + a wired provider) gates on
 *   `canWrite || forgeFeatureReady(forge, "<feature>")` — GitHub keeps it while
 *   forge-status is pending/failed (canWrite default-true), and a ready
 *   GitLab/Bitbucket repo positively enables just that action.
 * - A provider-ONLY control (no GitHub analogue here, e.g. GitLab approve/assignees,
 *   Bitbucket tasks/reviewers) gates on the forge feature ALONE — never
 *   `canWrite || …`, which would duplicate a GitHub control that lives elsewhere.
 *
 * This is a plain function of its inputs (no hooks, refs, or effects) so the caller
 * owns the `useForgeStatus` query; it just reshapes that data into the flat flag set.
 */
export function usePrCapabilities(
  forgeData: ForgeStatus | undefined,
  provider: ForgeProvider | null | undefined,
) {
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  // GitLab MR WRITES land per-action (full reviews stay GitHub-only via
  // `canWrite`). Each shared control is
  // `canWrite || forgeFeatureReady(...)` so GitHub keeps its controls while a
  // forge-status query is pending/failed (canWrite default-true) AND a ready GitLab
  // repo positively enables just these.
  const canComment = canWrite || forgeFeatureReady(forgeData, "mrComment");
  const canChangeState = canWrite || forgeFeatureReady(forgeData, "mrState");
  // Title/body editing is a shared control too.
  const canEdit = canWrite || forgeFeatureReady(forgeData, "mrEdit");
  // GitLab's approve/unapprove is a bodyless toggle with no GitHub analogue (GitHub
  // approves via the Review menu above), so it's GitLab-only and gated on the forge
  // feature directly — NOT `canWrite || …`, which would duplicate the Review control.
  const canApprove = forgeFeatureReady(forgeData, "mrApprove");
  // Request-changes follows the same forge-only shape (GitHub's lives in the
  // Review menu). On GitLab it's one-shot (the direct undo is Premium-only); on
  // Bitbucket the revoke works everywhere, so the control is a true toggle.
  const canRequestChanges = forgeFeatureReady(forgeData, "mrRequestChanges");
  // Bitbucket's revoke — drives the toggle direction below.
  const canUnrequestChanges = provider === "bitbucket";
  // Merge is a SHARED control (GitHub `gh pr merge`, GitLab `glab`), so it uses the
  // `canWrite || …` gate like comment/close — GitHub keeps it while forge-status is
  // pending/failed; a ready GitLab repo enables it too.
  const canMerge = canWrite || forgeFeatureReady(forgeData, "mrMerge");
  // Auto-merge (merge-when-pipeline-succeeds) is GitLab-only like the approve toggle
  // (GitHub has no in-app PR auto-merge), so the flag alone gates — never `canWrite || …`.
  const canAutoMerge = forgeFeatureReady(forgeData, "mrAutoMerge");
  // Labels are a shared control (both providers) — same `canWrite || …` gate.
  const canEditLabels = canWrite || forgeFeatureReady(forgeData, "mrLabels");
  // Assignees are a shared control now (GitHub + GitLab), so they use the same
  // `canWrite || …` gate as labels: GitHub keeps the picker while forge-status is
  // pending/failed, and a ready GitLab repo enables it. Bitbucket stays out —
  // `canWrite` is false there and `mrAssignees` is false.
  const canEditAssignees =
    canWrite || forgeFeatureReady(forgeData, "mrAssignees");
  // The reviewers picker is a shared control on all three providers now
  // (GitHub diffs pending user requests via `gh pr edit`, GitLab PUTs
  // `reviewer_ids`, Bitbucket picks workspace members).
  const canEditReviewers = forgeFeatureReady(forgeData, "mrReviewers");
  // The shared draft toggle (both ways) for GitLab + Bitbucket, gated on the forge
  // feature alone — never `canWrite || …`. GitHub is NOT in this flag: its
  // Ready / Convert-to-draft path goes via `gh pr ready [--undo]` gated on
  // `canWrite`, and the footer folds that in as `canToggleDraft || (isGitHub &&
  // canWrite)`, so `mrDraftToggle` stays false for GitHub (see the forge-gating
  // convention above).
  const canToggleDraft = forgeFeatureReady(forgeData, "mrDraftToggle");
  // Time tracking is GitLab-only too (GitHub has no built-in time tracking).
  const canTrackTime = forgeFeatureReady(forgeData, "timeTracking");
  // PR tasks are a native Bitbucket concept (no GitHub/GitLab analogue wired), so
  // the flag alone gates the section + header chip — never `canWrite || …`.
  const canTasks = forgeFeatureReady(forgeData, "prTasks");
  // Review-thread reply/resolve are shared controls (GitHub + wired providers) —
  // same `canWrite || …` gate as comment/merge so GitHub keeps them while
  // forge-status is pending/failed, and a ready provider positively enables them.
  const canThreadReply =
    canWrite || forgeFeatureReady(forgeData, "mrThreadReply");
  const canThreadResolve =
    canWrite || forgeFeatureReady(forgeData, "mrThreadResolve");
  // Reactions are a shared control (GitLab awards emoji); the fetch is gated so
  // it never fires for a provider whose reactions aren't wired (Bitbucket).
  const canReact = canWrite || forgeFeatureReady(forgeData, "mrReactions");
  // Editing/deleting your OWN comments is a shared control (GitHub + GitLab +
  // Bitbucket) — same `canWrite || …` gate; the per-comment `viewerDidAuthor`
  // check narrows it to the author. GitHub keeps it while forge-status is
  // pending/failed; a ready GitLab/Bitbucket repo enables it too.
  const canEditOwnComments =
    canWrite || forgeFeatureReady(forgeData, "mrCommentEdit");
  // Editing/deleting your OWN review-thread comments is a shared control too —
  // thread-scoped like reply/resolve, same `canWrite || …` gate; the per-comment
  // `viewerDidAuthor` check narrows it to the author.
  const canEditOwnThreadComments =
    canWrite || forgeFeatureReady(forgeData, "mrThreadCommentEdit");
  // Commenting on individual commits is a shared control (GitHub commit comments +
  // GitLab commit notes) — same `canWrite || …` gate so GitHub keeps it while
  // forge-status is pending/failed, and a ready GitLab repo positively enables it.
  const canCommentCommits =
    canWrite || forgeFeatureReady(forgeData, "commitComments");
  // Creating a new file:line review thread is a shared control too (distinct from
  // reply/resolve on an existing thread), same `canWrite || …` gate.
  const canCreateThread =
    canWrite || forgeFeatureReady(forgeData, "mrThreadCreate");
  // Submitting a batch review (verdict + summary + draft comments) is a shared
  // control — same gate; GitHub keeps its Review-menu submit while forge-status is
  // pending/failed, a ready provider enables the batch path.
  const canSubmitReview =
    canWrite || forgeFeatureReady(forgeData, "mrReviewSubmit");

  return {
    canWrite,
    canComment,
    canChangeState,
    canEdit,
    canApprove,
    canRequestChanges,
    canUnrequestChanges,
    canMerge,
    canAutoMerge,
    canEditLabels,
    canEditAssignees,
    canEditReviewers,
    canToggleDraft,
    canTrackTime,
    canTasks,
    canThreadReply,
    canThreadResolve,
    canReact,
    canEditOwnComments,
    canEditOwnThreadComments,
    canCommentCommits,
    canCreateThread,
    canSubmitReview,
  };
}
