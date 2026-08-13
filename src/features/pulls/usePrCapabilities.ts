import { forgeFeatureReady } from "@/lib/git/queries";
import type {
  ForgeProvider,
  ForgeRepoWriteAccess,
  ForgeStatus,
} from "@/lib/git/types";

/**
 * Per-action write-capability flags for a remote PR/MR, derived from the repo's
 * forge status + detected provider. A plain function of its inputs (no hooks or
 * effects), so the caller owns the `useForgeStatus` query.
 *
 * Gating convention (the repo's forge-gating seam):
 * - `canWrite` is "not a known read-only provider" (not `=== "github"`), so a
 *   GitHub PR keeps its controls while forge-status is pending/failed; only an
 *   explicitly-detected GitLab/Bitbucket repo suppresses them.
 * - A SHARED control (GitHub + a wired provider) gates on
 *   `canWrite || forgeFeatureReady(forge, "<feature>")`.
 * - A provider-ONLY control (no GitHub analogue here, e.g. GitLab auto-merge,
 *   Bitbucket tasks) gates on the forge feature ALONE — `canWrite || …` would
 *   duplicate a GitHub control that lives elsewhere.
 *
 * Axes, never conflated: every `can*` flag above is AVAILABILITY (is this action
 * wired for this provider?) and decides what RENDERS. `writeBlocked` is
 * PERMISSION and decides only what is ENABLED — consumers disable-with-reason
 * and never hide on permission. Triage is a SEPARATE, lower tier granting
 * labels, assignees, milestones, review requests, hiding comments and
 * close/reopen without push, so a triage control keys on `triageAccessReason`,
 * never on `writeBlocked`. Absent or unanswered probe data leaves
 * `writeBlocked` false (fail open).
 */
export function usePrCapabilities(
  forgeData: ForgeStatus | undefined,
  provider: ForgeProvider | null | undefined,
  writeAccess?: ForgeRepoWriteAccess,
) {
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const canComment = canWrite || forgeFeatureReady(forgeData, "mrComment");
  const canChangeState = canWrite || forgeFeatureReady(forgeData, "mrState");
  const canEdit = canWrite || forgeFeatureReady(forgeData, "mrEdit");
  // Bodyless approve/unapprove on GitLab + Bitbucket; GitHub approves via the Review
  // menu, so this is forge-flag-only (never canWrite).
  const canApprove = forgeFeatureReady(forgeData, "mrApprove");
  // Request-changes follows the same forge-only shape (GitHub's lives in the
  // Review menu). On GitLab it's one-shot (the direct undo is Premium-only); on
  // Bitbucket the revoke works everywhere, so the control is a true toggle.
  const canRequestChanges = forgeFeatureReady(forgeData, "mrRequestChanges");
  // Bitbucket-only, and the one flag here read straight off `provider` — no forge
  // feature covers revoke. RemotePrView uses it for the request-changes toggle
  // direction: off Bitbucket the handler no-ops and the title explains the manual clear.
  const canUnrequestChanges = provider === "bitbucket";
  // Shared control — merge is wired on all three providers.
  const canMerge = canWrite || forgeFeatureReady(forgeData, "mrMerge");
  // Merge-when-pipeline-succeeds is GitLab-only — no in-app auto-merge on
  // GitHub/Bitbucket.
  const canAutoMerge = forgeFeatureReady(forgeData, "mrAutoMerge");
  // Shared on GitHub + GitLab; Bitbucket PRs have no labels (`mrLabels` false there).
  const canEditLabels = canWrite || forgeFeatureReady(forgeData, "mrLabels");
  // Shared on GitHub + GitLab; Bitbucket is out both ways (canWrite false,
  // mrAssignees false).
  const canEditAssignees =
    canWrite || forgeFeatureReady(forgeData, "mrAssignees");
  // Shared on all three, yet gated on the flag alone (GitHub's `mrReviewers` is
  // true) — so unlike the other shared controls it stays off while forge-status
  // is pending/failed.
  const canEditReviewers = forgeFeatureReady(forgeData, "mrReviewers");
  // GitLab/Bitbucket only. GitHub's Ready / Convert-to-draft routes through
  // `gh pr ready [--undo]` on `canWrite`, and RemotePrView shows the pair as
  // `canToggleDraft || (isGitHub && canWrite)`.
  const canToggleDraft = forgeFeatureReady(forgeData, "mrDraftToggle");
  // Time tracking is GitLab-only too (GitHub has no built-in time tracking).
  const canTrackTime = forgeFeatureReady(forgeData, "timeTracking");
  // PR tasks are a native Bitbucket concept — no GitHub/GitLab analogue wired.
  const canTasks = forgeFeatureReady(forgeData, "prTasks");
  // Reply is wired on all three; RESOLVE is not — Bitbucket exposes no
  // comment-resolution endpoint, so `mrThreadResolve` is false there and the
  // resolve control never appears.
  const canThreadReply =
    canWrite || forgeFeatureReady(forgeData, "mrThreadReply");
  const canThreadResolve =
    canWrite || forgeFeatureReady(forgeData, "mrThreadResolve");
  // Shared (GitLab awards emoji); Bitbucket has none, so `mrReactions` is false
  // there and the fetch never fires.
  const canReact = canWrite || forgeFeatureReady(forgeData, "mrReactions");
  // Shared on all three; the per-comment `viewerDidAuthor` check narrows it to the
  // author.
  const canEditOwnComments =
    canWrite || forgeFeatureReady(forgeData, "mrCommentEdit");
  const canEditOwnThreadComments =
    canWrite || forgeFeatureReady(forgeData, "mrThreadCommentEdit");
  // Commit comments/notes — wired on all three providers.
  const canCommentCommits =
    canWrite || forgeFeatureReady(forgeData, "commitComments");
  // New file:line thread — distinct from reply/resolve on an existing one.
  const canCreateThread =
    canWrite || forgeFeatureReady(forgeData, "mrThreadCreate");
  // Batch review (verdict + summary + pending draft comments) — wired on all three
  // providers.
  const canSubmitReview =
    canWrite || forgeFeatureReady(forgeData, "mrReviewSubmit");
  // Only an explicit denial blocks: null/undefined (probe pending, failed, or
  // unable to answer) must behave exactly as before.
  const writeBlocked = writeAccess?.canPush === false;

  return {
    canWrite,
    writeBlocked,
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
