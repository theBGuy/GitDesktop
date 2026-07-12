import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckCircleIcon,
  ClockCountdownIcon,
  DotsThreeIcon,
  GitBranchIcon,
  GitMergeIcon,
  PencilSimpleIcon,
  SparkleIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  type CommitRow,
  CommitsList,
} from "@/features/conversations/CommitsList";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { LabelsPopover } from "@/features/conversations/LabelsPopover";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import {
  AuthorAvatar,
  hasVisibleBody,
  LabelChip,
  Thread,
} from "@/features/conversations/Thread";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import type { LineWidget } from "@/features/diff/DiffSurface";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import {
  isDeletionBlocked,
  isMergeMethodAllowed,
} from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import type { MergeStrategy, MinimizeReason } from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import { useForgeGhHost } from "@/lib/git/host";
import {
  PIPELINE_IN_FLIGHT,
  prDiffOptions,
  useApplySuggestion,
  useApprovePr,
  useCheckoutPr,
  useClosePr,
  useCommentPr,
  useDefaultBranch,
  useDeletePrComment,
  useDeleteReviewComment,
  useEditPr,
  useEditPrComment,
  useEditReviewComment,
  useForgeStatus,
  useGlArmAutoMerge,
  useGlCancelAutoMerge,
  useGlMrMergeState,
  useMergePr,
  useMinimizeComment,
  usePrApprovals,
  usePrDetails,
  usePrDiff,
  usePrReactions,
  usePrReviewThreads,
  usePrTimeline,
  useReadyPr,
  useReopenPr,
  useRepoStatus,
  useRequestChangesPr,
  useSetPrAssignees,
  useSetPrDraft,
  useSetPrReviewers,
  useThreadReply,
  useThreadResolve,
  useToggleReaction,
  useUnapprovePr,
  useUnminimizeComment,
  useUnrequestChangesPr,
} from "@/lib/git/queries";
import {
  type ApprovalState,
  type ForgeProvider,
  providerLabel,
  type ReviewThreadOut,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  useClearReviewDrafts,
  useReviewDrafts,
} from "@/lib/pulls/review-drafts";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ChecksRollup } from "./ChecksRollup";
import { PendingReviewBar } from "./PendingReviewBar";
import { PrCommitDetail } from "./PrCommitDetail";
import { PrReviewPanel } from "./PrReviewPanel";
import { PrTasksChip, PrTasksSection } from "./PrTasksSection";
import {
  PushedCommitsRow,
  StaleReviewMarker,
  sortTimeline,
  type TimelineEntry,
  TimelineEventRow,
} from "./PrTimeline";
import {
  MergePrDialog,
  MrTimeTracking,
  PrFilesPane,
} from "./RemotePrViewParts";
import { ReviewComposer } from "./ReviewComposer";
import { ReviewersPopover, userRefHint } from "./ReviewersPopover";
import {
  ReviewThreadList,
  ReviewThreadsBlock,
  SUBMIT_HINT,
  type SuggestionApply,
  threadToMarkdown,
} from "./ReviewThreads";
import { SubmitReviewDialog } from "./SubmitReviewDialog";
import { useGeneratePrDescription } from "./useGeneratePrDescription";
import { usePrCapabilities } from "./usePrCapabilities";

type Section = "conversation" | "commits" | "files" | "review";

const MERGE_LABEL: Record<MergeStrategy, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  fast_forward: "Fast-forward",
};

export function RemotePrView({
  repoPath,
  number,
}: {
  repoPath: string;
  number: number;
}) {
  const queryClient = useQueryClient();
  // The read view is provider-neutral. The remaining GitHub-only mutations (full
  // reviews, ready-for-review, checkout helpers) route through `gh_*` commands
  // and stay gated on `canWrite` — "not a known read-only provider" rather than
  // `=== "github"`, so that while the (separate) forge-status query is still
  // pending or after it fails, a GitHub PR keeps its write controls exactly as
  // before — only an explicitly-detected GitLab/Bitbucket repo suppresses them.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const remoteLabel = providerLabel(provider);
  const prNoun = provider === "gitlab" ? "merge request" : "pull request";
  // Per-action write-capability flags, derived purely from forge status + provider
  // (see usePrCapabilities for the full gating convention). Destructured so every
  // downstream reference keeps compiling unchanged.
  const {
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
  } = usePrCapabilities(forge.data, provider);
  const details = usePrDetails(repoPath, number);
  const prDiff = usePrDiff(repoPath, number);
  const setAssignees = useSetPrAssignees(repoPath);
  const setReviewers = useSetPrReviewers(repoPath);
  // For the read-only assignee/reviewer chips (closed/merged PRs): GitHub avatars
  // are login-derived, GitLab/Bitbucket carry a real avatarUrl on the ref.
  const ghHost = useForgeGhHost(repoPath);
  const comment = useCommentPr(repoPath);
  const checkout = useCheckoutPr(repoPath);
  const repoStatus = useRepoStatus(repoPath);
  const applySuggestion = useApplySuggestion(repoPath);
  const mergePr = useMergePr(repoPath);
  const closePr = useClosePr(repoPath);
  const reopenPr = useReopenPr(repoPath);
  // Approval + reviewer state drives the GitLab-only approve toggle and
  // Request-changes control; only fetched for a ready GitLab repo with an open MR
  // (null disables the read for GitHub / closed MRs).
  const approvals = usePrApprovals(
    repoPath,
    (canApprove || canRequestChanges) && details.data?.state === "OPEN"
      ? number
      : null,
  );
  const approvePr = useApprovePr(repoPath);
  const unapprovePr = useUnapprovePr(repoPath);
  const requestChangesPr = useRequestChangesPr(repoPath);
  const unrequestChangesPr = useUnrequestChangesPr(repoPath);
  // Auto-merge state (GitLab-only): read only for a ready GitLab repo with an open
  // MR (null disables the read for GitHub / closed MRs). It polls server-side so the
  // view notices the pipeline completing and the auto-merge firing. Gate on the Pulls
  // tab being active too: the <Activity>-hidden subtree still renders, so the composite
  // gate is load-bearing — a disabled query (null number) stops the refetchInterval, and
  // staleTime (5s) means returning to the tab refetches immediately.
  const repoTab = useUiStore((s) => s.repoTab);
  const mergeState = useGlMrMergeState(
    repoPath,
    repoTab === "pulls" && canAutoMerge && details.data?.state === "OPEN"
      ? number
      : null,
  );
  const armAutoMerge = useGlArmAutoMerge(repoPath);
  const cancelAutoMerge = useGlCancelAutoMerge(repoPath);
  const editComment = useEditPrComment(repoPath);
  const deleteComment = useDeletePrComment(repoPath);
  const editReviewComment = useEditReviewComment(repoPath);
  const deleteReviewComment = useDeleteReviewComment(repoPath);
  const minimizeComment = useMinimizeComment(repoPath);
  const unminimizeComment = useUnminimizeComment(repoPath);
  const readyPr = useReadyPr(repoPath);
  const setDraft = useSetPrDraft(repoPath);
  const editPr = useEditPr(repoPath);
  // File:line-anchored review threads (Copilot/CodeRabbit/human line comments).
  // The read serves both the Conversation block below and (later) the Files
  // diff anchors, so it lives here at the top level. The read gates on the PR
  // number alone (a flaky status probe mustn't hide threads); the WRITE controls
  // below stay gated on the per-provider Implemented flags.
  const reviewThreads = usePrReviewThreads(repoPath, number);
  const threadReply = useThreadReply(repoPath, number);
  const threadResolve = useThreadResolve(repoPath, number);
  // The reactions fetch is gated on `canReact` (see usePrCapabilities) so it never
  // fires for a provider whose reactions aren't wired (Bitbucket).
  const reactions = usePrReactions(repoPath, canReact ? number : null);
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "pr", number, "reactions"] as const,
    details.data?.id ?? "",
    { target: "mr", number },
  );
  const [section, setSection] = useState<Section>("conversation");
  // The activity-timeline events (force-pushes, labels, state changes, review
  // requests, approvals) that interleave into the Conversation feed. Now
  // provider-neutral — the backend's `forge_pr_timeline` dispatches per provider
  // (GitHub/GitLab/Bitbucket). Fetch only while the Conversation tab is showing
  // AND we resolved a remote provider — a hidden tab or an unknown provider must
  // not fetch (the <Activity>-hidden subtree still renders, so the composite gate
  // is load-bearing).
  const timeline = usePrTimeline(
    repoPath,
    number,
    section === "conversation" && !!provider,
  );
  const pendingPrSection = useUiStore((s) => s.pendingPrSection);
  const setPendingPrSection = useUiStore((s) => s.setPendingPrSection);
  const selectedPr = useUiStore((s) => s.selectedPr);
  // The activity dock's "View" lands here via a pending hint; switch to the
  // review sub-tab once, then clear it. Guarded on this being the *selected* PR
  // so a still-mounted lagging view (deferredPr) can't swallow the hint first.
  useEffect(() => {
    const isSelected =
      selectedPr?.kind === "remote" && selectedPr.id === String(number);
    if (pendingPrSection === "review" && isSelected) {
      setSection("review");
      setPendingPrSection(null);
    }
  }, [pendingPrSection, setPendingPrSection, selectedPr, number]);
  const aiEnabled = useAiEnabled();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Commits-tab drill-in: the selected commit's oid, or null for the list. Reset
  // when the PR number changes (below, alongside the file-selection reset).
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(
    null,
  );
  // The submit-review dialog's open state (the Review control + palette action).
  const [submitOpen, setSubmitOpen] = useState(false);
  // Pending-review drafts (local-only until submitted); shared by the Files-tab
  // anchors, the PendingReviewBar count, and the ReviewComposer's draft count.
  const drafts = useReviewDrafts(repoPath, number);
  const clearDrafts = useClearReviewDrafts(repoPath, number);
  // The composer/thread-create side of the forge detection: a strict provider key
  // (default "github" — gh is the authoritative default for an unrecognized host).
  const providerKey: ForgeProvider = provider ?? "github";

  // Palette-only PR actions (mounted here, so only live while a remote PR is
  // open). "Submit review…" opens the dialog when the provider allows a batch
  // review; "Discard pending review" confirms then clears the drafts.
  const draftCount = drafts.data?.length ?? 0;
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  useHotkeyAction(
    "submit-review",
    () => setSubmitOpen(true),
    canSubmitReview && details.data?.state === "OPEN",
  );
  useHotkeyAction(
    "discard-pending-review",
    () => setDiscardConfirmOpen(true),
    draftCount > 0,
  );

  const [composeBody, setComposeBody] = useState("");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  // The review-thread comment pending delete-confirmation — a separate id from
  // the conversation-comment dialog above so the two dialogs never collide.
  const [deletingThreadCommentId, setDeletingThreadCommentId] = useState<
    string | null
  >(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("merge");
  const [deleteBranch, setDeleteBranch] = useState(false);
  // Whether the open merge dialog is arming auto-merge (vs merging now) — set by
  // the dropdown item that opened it, read by confirmMerge + the dialog copy.
  const [mergeAuto, setMergeAuto] = useState(false);
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      await editPr.mutateAsync({ number, title, body });
    },
    successToast: "Pull request updated",
  });
  const prGen = useGeneratePrDescription(repoPath);
  const composerRef = useRef<MarkdownEditorHandle>(null);

  const onError = (e: unknown) => toastError(e);

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) =>
    makeQuoteReply({ composerRef, setBody: setComposeBody })(body);

  // GitLab approve/unapprove — a single toggle keyed on whether the viewer has
  // approved. `user_can_approve` is unreliable on Free (false even when approving
  // works), so we don't pre-disable; a genuine permission error surfaces via toast.
  // The status lives in a *separate* glab query, so we flip it OPTIMISTICALLY here:
  // otherwise the label lags a click by a full approve-POST + approvals-refetch and
  // looks broken. The success invalidation reconciles the real count; errors roll back.
  function toggleApproval() {
    const approved = approvals.data?.viewerHasApproved ?? false;
    const action = approved ? unapprovePr : approvePr;
    const key = ["repo", repoPath, "pr", number, "approvals"] as const;
    const prev = queryClient.getQueryData<ApprovalState>(key);
    const login = forge.data?.login ?? "";
    if (prev) {
      queryClient.setQueryData<ApprovalState>(key, {
        ...prev,
        viewerHasApproved: !approved,
        approvedBy: approved
          ? prev.approvedBy.filter((u) => u !== login)
          : login && !prev.approvedBy.includes(login)
            ? [...prev.approvedBy, login]
            : prev.approvedBy,
        // Approving clears a requested-changes reviewer state server-side
        // (validated live); unapproving doesn't restore it.
        viewerRequestedChanges: approved ? prev.viewerRequestedChanges : false,
      });
    }
    action.mutate(number, {
      onSuccess: () =>
        toast.success(
          approved ? "Approval revoked" : `Approved this ${prNoun}`,
        ),
      onError: (e) => {
        if (prev) queryClient.setQueryData(key, prev);
        onError(e);
      },
    });
  }

  // Request changes — a true toggle on Bitbucket (its revoke works on every
  // plan); one-shot on GitLab (the direct undo is Premium-only; approving, which
  // clears the state, is the natural Free-tier exit). Same optimistic flip as the
  // approve toggle: the state lives in the separate approvals query, so waiting
  // on the write + refetch would look broken.
  function requestChanges() {
    const requested = approvals.data?.viewerRequestedChanges ?? false;
    // Already requested on GitLab: the button is a focusable state indicator
    // (its title says how to clear); a re-click must not fire the Premium-only
    // undo path. Bitbucket falls through to the revoke below.
    if (requested && !canUnrequestChanges) return;
    const key = ["repo", repoPath, "pr", number, "approvals"] as const;
    const prev = queryClient.getQueryData<ApprovalState>(key);
    if (prev) {
      queryClient.setQueryData<ApprovalState>(key, {
        ...prev,
        viewerRequestedChanges: !requested,
      });
    }
    if (requested) {
      unrequestChangesPr.mutate(number, {
        onSuccess: () => toast.success("Change request revoked"),
        onError: (e) => {
          if (prev) queryClient.setQueryData(key, prev);
          onError(e);
        },
      });
      return;
    }
    requestChangesPr.mutate(
      { number, body: composeBody.trim() },
      {
        onSuccess: () => {
          toast.success("Requested changes");
          setComposeBody("");
        },
        onError: (e) => {
          if (prev) queryClient.setQueryData(key, prev);
          onError(e);
        },
      },
    );
  }

  function submitComment() {
    const body = composeBody.trim();
    if (!body) return;
    // Clear the draft immediately (the perceived-speed win) and append the
    // synthetic comment optimistically; on error restore the draft, but only if
    // the composer is still empty so we never clobber newly-typed text.
    setComposeBody("");
    comment.mutate(
      { number, body, author: forge.data?.login ?? "You" },
      {
        onSuccess: () => toast.success("Comment added"),
        onError: (e) => {
          setComposeBody((cur) => (cur.trim() ? cur : body));
          onError(e);
        },
      },
    );
  }

  function confirmMerge() {
    // GitLab stale-view guard: the head sha the user is looking at (the same oid
    // the AI-review path uses). GitLab 409s if the head moved; GitHub ignores it.
    const sha = pr?.commits.at(-1)?.oid;
    // The checkbox is hidden/disabled for a default or rule-protected head, but
    // force the flag false here too so a stale `true` can't reach the forge.
    const deleteHead = deleteBranch && !headIsDefault && !headDeletionBlocked;
    if (mergeAuto) {
      // Arm merge-when-pipeline-succeeds instead of merging now (GitLab-only).
      armAutoMerge.mutate(
        { number, strategy: mergeStrategy, deleteBranch: deleteHead, sha },
        {
          onSuccess: () => {
            setMergeOpen(false);
            toast.success(
              "Auto-merge enabled — merges when the pipeline passes",
            );
          },
          onError: (e) => {
            onError(e);
            setMergeOpen(false);
          },
        },
      );
      return;
    }
    mergePr.mutate(
      {
        number,
        strategy: mergeStrategy,
        deleteBranch: deleteHead,
        sha,
      },
      {
        onSuccess: () => {
          toast.success(`Merged #${number}`);
          setMergeOpen(false);
        },
        onError: (e) => {
          onError(e);
          setMergeOpen(false);
        },
      },
    );
  }

  const pr = details.data;
  // Each rendered review "claims" the line-comment threads it owns (GitHub
  // `reviewId`; always "" on GitLab/Bitbucket, which don't model reviews).
  // Claimed threads render inline under their review in the timeline; the rest
  // fall to the residual block below — so on GitLab/Bitbucket, where nothing is
  // owned, that block stays exactly as before.
  const renderedReviews = (pr?.reviews ?? []).filter(
    (r) => hasVisibleBody(r.body) || r.state,
  );
  // Group threads by the review that owns them (GitHub `reviewId`; "" on
  // GitLab/Bitbucket, which don't model reviews) — built once, then reused for
  // both the claimed-id set and each review's inline slice below.
  const threadsByReview = new Map<string, ReviewThreadOut[]>();
  for (const t of reviewThreads.data ?? []) {
    if (!t.reviewId) continue;
    const bucket = threadsByReview.get(t.reviewId);
    if (bucket) bucket.push(t);
    else threadsByReview.set(t.reviewId, [t]);
  }
  const claimedThreadIds = new Set(
    renderedReviews.flatMap((r) =>
      (threadsByReview.get(r.id) ?? []).map((t) => t.id),
    ),
  );
  const residualThreads = (reviewThreads.data ?? []).filter(
    (t) => !claimedThreadIds.has(t.id),
  );
  // Guards for the merge dialog's "delete head branch on the remote" checkbox:
  // every forge refuses to delete the DEFAULT branch (so the option is hidden),
  // and a local branch RULE can block deleting the head (so it's disabled with a
  // reason, mirroring the switcher's Delete menu item). Name-keyed against this
  // repo's default — the common same-repo case; a fork PR whose head is
  // coincidentally named like our default is an accepted v1 over-hide.
  const headIsDefault =
    pr != null &&
    defaultBranch.data != null &&
    pr.headRefName === defaultBranch.data;
  const headDeletionBlocked =
    pr != null && isDeletionBlocked(rulesConfig, pr.headRefName);
  // Branch rules load asynchronously, so `headDeletionBlocked` can flip true
  // after the dialog is open and the user has already ticked "delete branch".
  // Drop that choice when it does, so the state can't linger stale-true behind
  // the now-disabled checkbox (the dialog's `checked` override already keeps the
  // *render* correct on the same frame; this keeps the underlying state honest).
  useEffect(() => {
    if (headDeletionBlocked) setDeleteBranch(false);
  }, [headDeletionBlocked]);
  const fileSections = useMemo(
    () => splitUnifiedDiff(prDiff.data ?? ""),
    [prDiff.data],
  );

  // Reset the manual file selection when a different PR is shown — a
  // render-time state adjustment, not an effect.
  const [lastNumber, setLastNumber] = useState(number);
  if (number !== lastNumber) {
    setLastNumber(number);
    setSelectedPath(null);
    setSelectedCommitOid(null);
  }
  // Default to the first changed file until the user picks one.
  const effectivePath =
    selectedPath && pr?.files.some((f) => f.path === selectedPath)
      ? selectedPath
      : (pr?.files[0]?.path ?? null);

  // GitLab's merge sends a stale-view `sha` guard sourced from the MR's head commit
  // (`pr.commits.at(-1)`). If the best-effort commits read failed, that's absent and
  // we can't guard — so for GitLab we disable Merge rather than merge unguarded on an
  // irreversible op; reloading refetches the head. (GitHub has no guard, so it's exempt.)
  const mergeGuardMissing = provider === "gitlab" && pr?.commits.length === 0;

  // Auto-merge derived state (GitLab-only). The arm affordance shows only while the
  // head pipeline is in flight; the footer indicator shows once armed. Both classify
  // the pipeline status against the same shared in-flight set as the poll.
  const pipelineInFlight = (PIPELINE_IN_FLIGHT as readonly string[]).includes(
    mergeState.data?.pipelineStatus ?? "",
  );
  const autoMergeArmed = mergeState.data?.autoMergeEnabled ?? false;

  // Approval display (GitLab-only): a quiet count shown only when there's something
  // to report — someone has approved, or a Premium project requires N approvals.
  const approval = approvals.data;
  const approvalNote =
    approval &&
    (approval.approvalsRequired > 0 || approval.approvedBy.length > 0)
      ? approval.approvalsRequired > 0
        ? `${approval.approvedBy.length} of ${approval.approvalsRequired} approvals`
        : `${approval.approvedBy.length} approval${approval.approvedBy.length === 1 ? "" : "s"}`
      : null;

  if (details.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (details.isError || !pr) {
    return <DiffPlaceholder message="Could not load this pull request" />;
  }

  const fileDiff = effectivePath
    ? {
        filePath: effectivePath,
        text: fileSections.get(effectivePath) ?? "",
        isBinary: (fileSections.get(effectivePath) ?? "").includes(
          "Binary files ",
        ),
        isTruncated: false,
      }
    : undefined;

  // A file's unified-diff section by path, so the in-diff thread cards (Files tab)
  // and the Conversation suggestion threads can synthesize a hunk on hunk-less
  // providers (GitLab/Bitbucket) to gain the Apply affordance.
  const fileDiffLookup = (path: string): string | undefined =>
    fileSections.get(path);

  // The inline line-comment composer for the Files tab: enabled only when the
  // provider allows creating a new review thread. Anchored to the currently
  // selected file (its section prefills a suggestion's code). Absent otherwise,
  // so the diff stays read-only exactly as before.
  const reviewLineWidget: LineWidget | undefined =
    canCreateThread && effectivePath
      ? {
          enabled: true,
          render: ({ side, line, fromLine, onClose }) => (
            <ReviewComposer
              repoPath={repoPath}
              number={number}
              path={effectivePath}
              side={side}
              line={line}
              fromLine={fromLine}
              provider={providerKey}
              fileSection={fileSections.get(effectivePath) ?? ""}
              draftCount={draftCount}
              canCreateThread={canCreateThread}
              onClose={onClose}
            />
          ),
        }
      : undefined;

  // Gating inputs + the write for the per-suggestion Apply affordance, shared by
  // the Conversation review-thread block and the Files-tab diff anchors. The
  // current branch is the same status field the header's "Checked out" gate reads
  // (`repoStatus.data?.branch?.name`); onApply supplies `stageWhenClean: true`
  // (SuggestionApply's arg omits it) so a clean file is staged like GitHub's
  // "Commit suggestion".
  const suggestionApply: SuggestionApply = {
    headRefName: pr.headRefName,
    currentBranch: repoStatus.data?.branch?.name ?? null,
    onApply: (a) => applySuggestion.mutateAsync({ ...a, stageWhenClean: true }),
  };

  const isOpen = pr.state === "OPEN";
  const busy =
    comment.isPending ||
    mergePr.isPending ||
    closePr.isPending ||
    reopenPr.isPending ||
    approvePr.isPending ||
    unapprovePr.isPending ||
    requestChangesPr.isPending ||
    unrequestChangesPr.isPending ||
    armAutoMerge.isPending ||
    cancelAutoMerge.isPending ||
    readyPr.isPending ||
    setDraft.isPending;

  function saveCommentEdit(commentId: string, body: string) {
    editComment.mutate(
      { number, commentId, body },
      {
        onSuccess: () => toast.success("Comment updated"),
        onError,
      },
    );
  }

  function saveThreadCommentEdit(commentId: string, body: string) {
    editReviewComment.mutate(
      { number, commentId, body },
      {
        onSuccess: () => toast.success("Comment updated"),
        onError,
      },
    );
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    toggleReactionMutation.mutate({ subjectId, content, active }, { onError });
  }

  function hideComment(commentId: string, classifier: MinimizeReason) {
    minimizeComment.mutate(
      { commentId, classifier },
      { onSuccess: () => toast.success("Comment hidden"), onError },
    );
  }

  function unhideComment(commentId: string) {
    unminimizeComment.mutate(commentId, {
      onSuccess: () => toast.success("Comment shown"),
      onError,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="text-sm font-medium">
            {pr.title}{" "}
            <span className="font-normal text-muted-foreground">
              #{pr.number}
            </span>
          </h2>
          <span className="flex-1" />
          {isOpen &&
            canWrite &&
            (repoStatus.data?.branch?.name === pr.headRefName ? (
              <Button
                variant="outline"
                size="xs"
                disabled
                title={`${pr.headRefName} is the current branch`}
              >
                <CheckCircleIcon data-icon="inline-start" />
                Checked out
              </Button>
            ) : (
              <Button
                variant="outline"
                size="xs"
                disabled={checkout.isPending}
                onClick={() =>
                  checkout.mutate(number, {
                    onSuccess: () =>
                      toast.success(`Checked out ${pr.headRefName}`),
                    onError,
                  })
                }
                title={`Check out ${pr.headRefName} locally`}
              >
                {checkout.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <GitBranchIcon data-icon="inline-start" />
                )}
                Checkout
              </Button>
            ))}
          {isOpen && canEdit && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => edit.openEdit({ title: pr.title, body: pr.body })}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => openUrl(pr.url)}
            title={`Open this ${prNoun} on ${remoteLabel}`}
            className="cursor-pointer"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {remoteLabel}
          </Button>
        </div>
        <JiraRefRow
          repoPath={repoPath}
          sources={[
            { label: "title", text: pr.title },
            { label: "description", text: pr.body },
            { label: "branch name", text: pr.headRefName },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={pr.state === "OPEN" ? "default" : "secondary"}>
            {pr.isDraft ? "Draft" : pr.state.toLowerCase()}
          </Badge>
          <AuthorAvatar login={pr.author} avatarUrl={pr.authorAvatarUrl} />
          <span>{pr.author}</span>
          <span>•</span>
          <span className="font-mono">{pr.headRefName}</span>
          <span>→</span>
          <span className="font-mono">{pr.baseRefName}</span>
          <span className="text-success">+{pr.additions}</span>
          <span className="text-destructive">-{pr.deletions}</span>
        </div>
        {isOpen && canEditLabels ? (
          <LabelsPopover
            repoPath={repoPath}
            enabled
            number={number}
            target="mr"
            labelableId={pr.id}
            labels={pr.labels}
          />
        ) : (
          pr.labels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pr.labels.map((label) => (
                <LabelChip key={label.name} label={label} />
              ))}
            </div>
          )
        )}
        {/* Assignee picker (GitHub + GitLab; same affordance as the issue
            sidebar). A closed/merged PR falls back to read-only chips like the
            labels row. */}
        {isOpen && canEditAssignees ? (
          <AssigneesPopover
            repoPath={repoPath}
            enabled
            value={pr.assignees}
            commitOnClose
            onChange={(next) =>
              setAssignees.mutate(
                { number, assignees: next },
                { onError: toastError },
              )
            }
          />
        ) : (
          pr.assignees.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pr.assignees.map((user) => (
                <span
                  key={user.id}
                  className="inline-flex items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground"
                >
                  <ForgeUserAvatar user={user} ghHost={ghHost} />
                  {user.label}
                </span>
              ))}
            </div>
          )
        )}
        {/* Bitbucket-only reviewers picker (workspace members, minus the author);
            a closed/merged PR falls back to read-only chips like the rows above.
            GitHub/GitLab carry no reviewers here and show nothing, as before. */}
        {isOpen && canEditReviewers ? (
          <ReviewersPopover
            repoPath={repoPath}
            number={number}
            enabled
            value={pr.reviewers}
            onChange={(next) =>
              setReviewers.mutate(
                { number, reviewers: next },
                { onError: toastError },
              )
            }
          />
        ) : (
          pr.reviewers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pr.reviewers.map((user) => {
                const hint = userRefHint(user, pr.reviewers);
                return (
                  <span
                    key={user.id}
                    title={hint ? `${user.label} (${hint})` : undefined}
                    className="inline-flex items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground"
                  >
                    <ForgeUserAvatar user={user} ghHost={ghHost} />
                    {user.label}
                    {hint && (
                      <span className="text-muted-foreground"> · {hint}</span>
                    )}
                  </span>
                );
              })}
            </div>
          )
        )}
        {/* GitLab-only time-tracking summary (clock + est/spent); a popover with
            the estimate/add-spent controls while the MR is open, static once
            closed. GitHub never mounts it (gated on the flag). */}
        {canTrackTime && (
          <MrTimeTracking repoPath={repoPath} number={number} open={isOpen} />
        )}
        {/* Bitbucket-only PR-tasks chip: "{n} open tasks", quiet until there are
            unresolved tasks. Clicking jumps to the Tasks section in the
            conversation column. Reads the same usePrTasks query as the section. */}
        {canTasks && (
          <PrTasksChip
            repoPath={repoPath}
            number={number}
            onView={() => {
              setSection("conversation");
              // Defer the scroll so the conversation column has mounted.
              requestAnimationFrame(() =>
                document
                  .getElementById("pr-tasks-section")
                  ?.scrollIntoView({ block: "nearest", behavior: "auto" }),
              );
            }}
          />
        )}
        <ChecksRollup checks={pr.checks} repoPath={repoPath} />
        <div className="flex gap-1 pt-1">
          {/* The AI Review tab needs only the diff (forge-neutral) and a way to
              post the result as a comment — so it follows canComment, which
              covers GitLab MRs too (canWrite implies canComment for GitHub). */}
          {(
            (aiEnabled && canComment
              ? ["conversation", "commits", "files", "review"]
              : ["conversation", "commits", "files"]) as Section[]
          ).map((s) => (
            <Button
              key={s}
              variant={section === s ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={section === s}
              onClick={() => setSection(s)}
            >
              {s === "conversation"
                ? `Conversation (${pr.comments.length})`
                : s === "commits"
                  ? `Commits (${pr.commits.length})`
                  : s === "files"
                    ? `Files (${pr.files.length})`
                    : "Review"}
            </Button>
          ))}
        </div>
      </header>

      {aiEnabled && canComment && section === "review" && (
        <PrReviewPanel
          prKind="remote"
          prRef={String(number)}
          prNoun={prNoun}
          context={{
            title: pr.title,
            body: pr.body,
            commitSubjects: pr.commits.map((c) => c.headline),
            repoPath,
            // Provider-aware review copy (MR/merge-request noun, markdown flavor).
            provider: provider ?? undefined,
            // gh GraphQL returns commits oldest-first, so the head is the last.
            headSha: pr.commits.at(-1)?.oid,
            // Reuse the diff already cached by usePrDiff (mounted above) instead of
            // re-fetching it — PR diffs are among the slowest loads in the app.
            loadDiff: () =>
              queryClient
                .ensureQueryData(prDiffOptions(repoPath, number))
                .then((text) => ({
                  text,
                  truncated: false,
                  files: pr.files.map((f) => ({
                    path: f.path,
                    added: f.additions,
                    deleted: f.deletions,
                    isBinary: false,
                  })),
                })),
          }}
          posting={comment.isPending}
          // The panel posts its AI review as a comment and passes `asBot: true`,
          // forwarded to the mutation so GitLab attributes it to the review-bot
          // identity (other providers ignore the flag).
          onPost={(body, opts) =>
            comment
              .mutateAsync({
                number,
                body,
                author: forge.data?.login ?? "You",
                asBot: opts?.asBot,
              })
              .catch((e) => {
                onError(e);
                throw e; // let the panel skip its success toast / text clear
              })
          }
        />
      )}

      {section === "conversation" && (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              <div className="group space-y-1 border-b pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {pr.body.trim() ? (
                      <Markdown>{pr.body}</Markdown>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No description provided.
                      </p>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Description actions"
                          className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                        />
                      }
                    >
                      <DotsThreeIcon className="size-4" weight="bold" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        onClick={() => copyText(pr.url, "Link copied")}
                      >
                        Copy link
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => quoteReply(pr.body)}>
                        Quote reply
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => copyText(pr.body, "Markdown copied")}
                      >
                        Copy markdown
                      </DropdownMenuItem>
                      {isOpen && canEdit && (
                        <DropdownMenuItem
                          onClick={() =>
                            edit.openEdit({ title: pr.title, body: pr.body })
                          }
                        >
                          Edit
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {canReact && (
                  <ReactionBar
                    reactions={reactions.data?.body ?? []}
                    onToggle={(content, active) =>
                      toggleReaction(pr.id, content, active)
                    }
                  />
                )}
              </div>
              {/* Bitbucket-only PR tasks checklist — between the description and
                  the review/comment threads. Gated on the flag alone; absent for
                  GitHub/GitLab. */}
              {canTasks && (
                <PrTasksSection
                  repoPath={repoPath}
                  number={number}
                  editable={pr.state === "OPEN"}
                />
              )}
              {/* The merged activity feed: reviews + comments + commits +
                  timeline events, date-sorted oldest→newest (matching GitHub and
                  the prior order). Each source maps to a {date, sortKey, node}
                  entry so the sort is provider-neutral; the review/comment cards
                  keep every prop they had before (they're relocated, not
                  rewritten). Adjacent commit entries coalesce into one
                  "pushed N commits" row. */}
              {(() => {
                // Newest commit date drives approval staleness. gh returns
                // oldest-first, but be defensive: max over all commit dates.
                const newestCommitMs = pr.commits.reduce((max, c) => {
                  const t = new Date(c.date).getTime();
                  return Number.isNaN(t) ? max : Math.max(max, t);
                }, 0);
                const commitsSince = (isoDate: string) => {
                  const t = new Date(isoDate).getTime();
                  if (Number.isNaN(t)) return 0;
                  return pr.commits.filter((c) => {
                    const ct = new Date(c.date).getTime();
                    return !Number.isNaN(ct) && ct > t;
                  }).length;
                };

                const entries: TimelineEntry[] = [];

                // Reviews (existing cards, every prop preserved byte-for-byte). A
                // stale APPROVED/CHANGES_REQUESTED review (its date predates the
                // newest commit) gets a warning marker right after its card.
                for (const r of renderedReviews) {
                  const ownThreads = threadsByReview.get(r.id) ?? [];
                  const copyMarkdown =
                    ownThreads.length > 0
                      ? [
                          r.body.trim() ? r.body.trim() : null,
                          ...ownThreads.map(threadToMarkdown),
                        ]
                          .filter(Boolean)
                          .join("\n\n---\n\n")
                      : undefined;
                  const isVerdict =
                    r.state === "APPROVED" || r.state === "CHANGES_REQUESTED";
                  const reviewMs = new Date(r.date).getTime();
                  const stale =
                    isVerdict &&
                    newestCommitMs > 0 &&
                    !Number.isNaN(reviewMs) &&
                    reviewMs < newestCommitMs;
                  entries.push({
                    date: r.date,
                    sortKey: 1,
                    node: (
                      <div key={`review-${r.id || `${r.author}-${r.date}`}`}>
                        <Thread
                          thread={r}
                          onQuote={
                            canWrite && hasVisibleBody(r.body)
                              ? () => quoteReply(r.body)
                              : undefined
                          }
                          copyMarkdown={copyMarkdown}
                        />
                        {stale && (
                          <StaleReviewMarker
                            commitsSince={commitsSince(r.date)}
                          />
                        )}
                        {ownThreads.length > 0 && (
                          // The review's own line-comment threads, nested under
                          // it (a 1px border-l rail — the same nested-sublist
                          // idiom as the pushed-commits row). GitLab/Bitbucket
                          // never reach here: their threads carry no reviewId, so
                          // nothing is claimed and they stay in the block below.
                          <div className="mt-2 border-l pl-3">
                            <ReviewThreadList
                              threads={ownThreads}
                              onQuote={quoteReply}
                              onReply={
                                canThreadReply
                                  ? (threadId, body) =>
                                      threadReply.mutateAsync({
                                        threadId,
                                        body,
                                      })
                                  : undefined
                              }
                              onResolve={
                                canThreadResolve
                                  ? (threadId, resolved) =>
                                      threadResolve.mutateAsync({
                                        threadId,
                                        resolved,
                                      })
                                  : undefined
                              }
                              onEditComment={
                                canEditOwnThreadComments
                                  ? saveThreadCommentEdit
                                  : undefined
                              }
                              onDeleteComment={
                                canEditOwnThreadComments
                                  ? setDeletingThreadCommentId
                                  : undefined
                              }
                              provider={providerKey}
                              apply={suggestionApply}
                              fileDiffLookup={fileDiffLookup}
                            />
                          </div>
                        )}
                      </div>
                    ),
                  });
                }

                // Conversation comments (existing cards, every prop + the
                // data-comment-id wrapper preserved).
                for (const c of pr.comments.filter((c) =>
                  hasVisibleBody(c.body),
                )) {
                  entries.push({
                    date: c.date,
                    sortKey: 2,
                    node: (
                      <div key={`comment-${c.id}`} data-comment-id={c.id}>
                        <Thread
                          thread={c}
                          onQuote={
                            canWrite ? () => quoteReply(c.body) : undefined
                          }
                          onSaveEdit={
                            canEditOwnComments && c.viewerDidAuthor
                              ? (body) => saveCommentEdit(c.id, body)
                              : undefined
                          }
                          onDelete={
                            canEditOwnComments && c.viewerDidAuthor
                              ? () => setDeletingCommentId(c.id)
                              : undefined
                          }
                          onHide={
                            canWrite && !c.isMinimized
                              ? (classifier) => hideComment(c.id, classifier)
                              : undefined
                          }
                          onUnhide={
                            canWrite && c.isMinimized
                              ? () => unhideComment(c.id)
                              : undefined
                          }
                          reactions={
                            canReact
                              ? reactions.data?.comments[c.id]
                              : undefined
                          }
                          onToggleReaction={
                            canReact
                              ? (content, active) =>
                                  toggleReaction(c.id, content, active)
                              : undefined
                          }
                        />
                      </div>
                    ),
                  });
                }

                // Commits — carried as bare markers; adjacent runs coalesce into
                // a single "pushed N commits" row after sorting.
                for (const c of pr.commits) {
                  entries.push({
                    date: c.date,
                    sortKey: 0,
                    commit: {
                      id: c.oid,
                      subject: c.headline,
                      shortSha: c.oid.slice(0, 7),
                      author: c.author,
                      date: c.date,
                    },
                  });
                }

                // Timeline events — provider-neutral (GitHub, GitLab, Bitbucket);
                // empty otherwise.
                for (const [i, ev] of (timeline.data ?? []).entries()) {
                  entries.push({
                    date: ev.date,
                    sortKey: 3,
                    node: <TimelineEventRow key={`event-${i}`} event={ev} />,
                  });
                }

                const sorted = sortTimeline(entries);

                // Coalesce adjacent commit markers into grouped "pushed N" rows;
                // everything else renders its own node.
                const rendered: React.ReactNode[] = [];
                let run: CommitRow[] = [];
                let runStart = 0;
                const flush = () => {
                  if (run.length === 0) return;
                  rendered.push(
                    <PushedCommitsRow
                      key={`push-${runStart}-${run[0].id}`}
                      commits={run}
                      // Drill into the commit's detail via the existing Commits-tab
                      // machinery (selectedCommitOid → pr.commits.find(oid) →
                      // PrCommitDetail).
                      onSelectCommit={(oid) => {
                        setSelectedCommitOid(oid);
                        setSection("commits");
                      }}
                    />,
                  );
                  run = [];
                };
                for (let i = 0; i < sorted.length; i++) {
                  const entry = sorted[i];
                  if (entry.commit) {
                    if (run.length === 0) runStart = i;
                    run.push(entry.commit);
                  } else {
                    flush();
                    rendered.push(entry.node);
                  }
                }
                flush();

                if (rendered.length === 0) return null;
                return <div className="space-y-4">{rendered}</div>;
              })()}
              {/* Residual review threads — the ones NOT shown inline under a
                  review above: all threads on GitLab/Bitbucket (no reviewId), and
                  standalone line comments on GitHub. Grouped by file, same
                  interactivity. Retitled when reviews claimed threads above so it
                  doesn't read as a duplicate. Nothing when empty/loading. */}
              <ReviewThreadsBlock
                threads={residualThreads}
                heading={
                  claimedThreadIds.size > 0
                    ? "Other line comments"
                    : "Review comments"
                }
                isError={reviewThreads.isError}
                onQuote={quoteReply}
                onReply={
                  canThreadReply
                    ? (threadId, body) =>
                        threadReply.mutateAsync({ threadId, body })
                    : undefined
                }
                onResolve={
                  canThreadResolve
                    ? (threadId, resolved) =>
                        threadResolve.mutateAsync({ threadId, resolved })
                    : undefined
                }
                onEditComment={
                  canEditOwnThreadComments ? saveThreadCommentEdit : undefined
                }
                onDeleteComment={
                  canEditOwnThreadComments
                    ? setDeletingThreadCommentId
                    : undefined
                }
                provider={providerKey}
                apply={suggestionApply}
                fileDiffLookup={fileDiffLookup}
              />
              {pr.reviews.length === 0 &&
                pr.comments.length === 0 &&
                pr.commits.length === 0 &&
                !timeline.data?.length &&
                !reviewThreads.data?.length && (
                  <p className="text-xs text-muted-foreground">
                    No activity yet.
                  </p>
                )}
            </div>
          </ScrollArea>
          {/* Shown for closed/merged PRs too — GitHub lets you comment (and
              quote-reply) after a PR closes; only reviews are open-only. On GitLab
              the composer shows (the first MR writes), but the GitHub-only Review
              menu stays hidden; Bitbucket has neither, so the bar hides. */}
          {canComment && (
            <div className="space-y-2 border-t p-3">
              <MarkdownEditor
                ref={composerRef}
                aria-label="Leave a comment"
                placeholder="Leave a comment…"
                value={composeBody}
                onChange={setComposeBody}
                onKeyDown={(e) => {
                  if (
                    (e.ctrlKey || e.metaKey) &&
                    e.key === "Enter" &&
                    composeBody.trim() &&
                    !busy
                  ) {
                    e.preventDefault();
                    submitComment();
                  }
                }}
                rows={2}
                textareaClassName="max-h-32 min-h-12 resize-y"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!composeBody.trim() || busy}
                  onClick={submitComment}
                  title={SUBMIT_HINT}
                >
                  Comment
                </Button>
                {/* The Review control now opens the batch submit dialog for
                    EVERY provider (verdict + summary + any pending draft
                    comments), replacing the legacy GitHub-only verdict menu.
                    GitHub rides `canWrite` via canSubmitReview; a ready
                    GitLab/Bitbucket repo enables it through the forge flag. */}
                {isOpen && canSubmitReview && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setSubmitOpen(true)}
                    title="Submit a review (verdict, summary, and any pending comments)"
                  >
                    Review…
                  </Button>
                )}
                {isOpen && canApprove && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      // On an approvals read-error we can't know the viewer's state,
                      // so disable rather than present a confident (possibly wrong)
                      // Approve that would fire the wrong direction on click.
                      disabled={
                        busy || approvals.isPending || approvals.isError
                      }
                      aria-pressed={approval?.viewerHasApproved ?? false}
                      onClick={toggleApproval}
                      title={
                        approvals.isError
                          ? "Couldn't load approval state"
                          : approval?.viewerHasApproved
                            ? "Revoke your approval"
                            : `Approve this ${prNoun}`
                      }
                      className={cn(
                        approval?.viewerHasApproved &&
                          "border-success/40 text-success hover:text-success",
                      )}
                    >
                      <CheckCircleIcon data-icon="inline-start" />
                      {approval?.viewerHasApproved ? "Approved" : "Approve"}
                    </Button>
                    {approvalNote && (
                      <span
                        className="text-xs text-muted-foreground"
                        title={
                          approval && approval.approvedBy.length > 0
                            ? `Approved by ${approval.approvedBy.join(", ")}`
                            : undefined
                        }
                      >
                        {approvalNote}
                      </span>
                    )}
                  </>
                )}
                {isOpen && canRequestChanges && (
                  <Button
                    variant="outline"
                    size="sm"
                    // Bitbucket: a true toggle (its revoke works on every plan).
                    // GitLab: one-shot — once requested, the button becomes the
                    // state indicator (the direct undo is Premium-only —
                    // approve, or remove yourself as a reviewer on GitLab, to
                    // clear). It stays FOCUSABLE in that state (the click
                    // no-ops via the handler) so keyboard/AT users can still
                    // reach the how-to-clear title. Same disable-on-unknown
                    // posture as the approve toggle.
                    disabled={busy || approvals.isPending || approvals.isError}
                    aria-pressed={approval?.viewerRequestedChanges ?? false}
                    onClick={requestChanges}
                    title={
                      approvals.isError
                        ? "Couldn't load review state"
                        : approval?.viewerRequestedChanges
                          ? canUnrequestChanges
                            ? "Revoke your change request"
                            : "You've requested changes — approve, or remove yourself as a reviewer on GitLab, to clear"
                          : composeBody.trim()
                            ? "Request changes, posting your draft as a comment"
                            : `Request changes on this ${prNoun} (adds you as a reviewer)`
                    }
                    className={cn(
                      approval?.viewerRequestedChanges &&
                        "border-warning/40 text-warning",
                    )}
                  >
                    <XCircleIcon data-icon="inline-start" />
                    {approval?.viewerRequestedChanges
                      ? "Changes requested"
                      : "Request changes"}
                  </Button>
                )}
                {composeBody.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => setComposeBody("")}
                    title="Discard this draft (e.g. a quote reply)"
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {section === "commits" &&
        (() => {
          // Drill-in: render the selected commit's detail, or the list. A stale
          // oid (e.g. after a refetch dropped the commit) falls back to the list.
          const selectedCommit = selectedCommitOid
            ? pr.commits.find((c) => c.oid === selectedCommitOid)
            : undefined;
          if (selectedCommit) {
            return (
              <PrCommitDetail
                repoPath={repoPath}
                number={number}
                commit={selectedCommit}
                onBack={() => setSelectedCommitOid(null)}
                canCommentCommits={canCommentCommits}
                remoteLabel={remoteLabel}
                provider={providerKey}
              />
            );
          }
          return (
            <CommitsList
              commits={pr.commits.map((c) => ({
                id: c.oid,
                subject: c.headline,
                shortSha: c.oid.slice(0, 7),
                author: c.author,
                date: c.date,
              }))}
              onSelect={setSelectedCommitOid}
              selectedId={selectedCommitOid}
            />
          );
        })()}

      {section === "files" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Pending-review status bar: hidden until a draft exists, then a
              live count + Submit/Discard. Sits directly above the files pane. */}
          <PendingReviewBar
            repoPath={repoPath}
            number={number}
            onSubmit={() => setSubmitOpen(true)}
          />
          <PrFilesPane
            files={pr.files}
            effectivePath={effectivePath}
            onSelectPath={setSelectedPath}
            fileDiff={fileDiff}
            isPending={prDiff.isPending}
            isError={prDiff.isError}
            // The same threads + handlers/gates the Conversation block uses —
            // reuse the top-level read/mutations, don't re-fetch. Quoting from a
            // diff card feeds the view-level composer (persists to Conversation).
            threads={reviewThreads.data}
            drafts={drafts.data}
            repoPath={repoPath}
            number={number}
            lineWidget={reviewLineWidget}
            onQuote={quoteReply}
            onReply={
              canThreadReply
                ? (threadId, body) =>
                    threadReply.mutateAsync({ threadId, body })
                : undefined
            }
            onResolve={
              canThreadResolve
                ? (threadId, resolved) =>
                    threadResolve.mutateAsync({ threadId, resolved })
                : undefined
            }
            provider={providerKey}
            apply={suggestionApply}
            fileDiffLookup={fileDiffLookup}
          />
        </div>
      )}

      {/* The open-MR footer hosts Close + Merge (GitLab writes too) alongside Ready
          (GitHub-only) — show it whenever any is available, and gate each control
          individually. */}
      {isOpen && (canChangeState || canMerge || canWrite) && (
        <div className="flex items-center gap-2 border-t p-3">
          {canWrite && pr.isDraft && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                readyPr.mutate(number, {
                  onSuccess: () => toast.success("Marked ready for review"),
                  onError,
                })
              }
            >
              Ready for review
            </Button>
          )}
          {/* Bitbucket toggles draft BOTH ways (GitHub's gh path above is
              one-way): the same PUT flips it back, so a ready PR offers a
              quieter Convert-to-draft alongside the primary Ready button. */}
          {canToggleDraft && pr.isDraft && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                setDraft.mutate(
                  { number, draft: false },
                  {
                    onSuccess: () => toast.success("Marked ready for review"),
                    onError,
                  },
                )
              }
            >
              Ready for review
            </Button>
          )}
          {canToggleDraft && !pr.isDraft && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title="Turn this pull request back into a draft"
              onClick={() =>
                setDraft.mutate(
                  { number, draft: true },
                  {
                    onSuccess: () => toast.success("Converted to draft"),
                    onError,
                  },
                )
              }
            >
              Convert to draft
            </Button>
          )}
          {/* Auto-merge armed indicator + cancel (GitLab-only) — sits on the left,
              opposite Close/Merge. Not color-alone: icon + words. */}
          {canAutoMerge && autoMergeArmed && (
            <div className="flex items-center gap-2">
              <span
                className="flex items-center gap-1 text-xs text-info"
                title={
                  mergeState.data?.pipelineStatus
                    ? `Merges when the pipeline passes — pipeline: ${mergeState.data.pipelineStatus}`
                    : "Merges when the pipeline passes"
                }
              >
                <ClockCountdownIcon className="size-3.5 shrink-0" />
                Auto-merge enabled
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  cancelAutoMerge.mutate(number, {
                    onSuccess: () => toast.success("Auto-merge canceled"),
                    onError,
                  })
                }
              >
                Cancel auto-merge
              </Button>
            </div>
          )}
          <span className="flex-1" />
          {canChangeState && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                closePr.mutate(number, {
                  onSuccess: () => toast.success(`Closed #${number}`),
                  onError,
                })
              }
            >
              Close
            </Button>
          )}
          {canMerge && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    disabled={busy || pr.isDraft || mergeGuardMissing}
                    title={
                      pr.isDraft
                        ? `Mark the ${prNoun} ready before merging`
                        : mergeGuardMissing
                          ? "Reload to merge — couldn't load the head commit to guard the merge"
                          : `Merge this ${prNoun}`
                    }
                  >
                    <GitMergeIcon data-icon="inline-start" />
                    Merge
                    <CaretDownIcon data-icon="inline-end" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                {/* GitLab has no per-MR rebase-merge (that's the project's merge_method
                    setting), so it gets only merge + squash. Bitbucket offers
                    merge + squash + fast-forward. Branch-rule gating is GitHub
                    branch-protection data, so it never applies to GitLab/Bitbucket. */}
                {(provider === "gitlab"
                  ? (["merge", "squash"] as const)
                  : provider === "bitbucket"
                    ? (["merge", "squash", "fast_forward"] as const)
                    : (["merge", "squash", "rebase"] as const)
                ).map((s) => {
                  const blocked =
                    provider !== "gitlab" &&
                    provider !== "bitbucket" &&
                    // Bitbucket's "fast_forward" isn't a GitHub MergeMethod and
                    // never reaches this arm (bitbucket is excluded above) — the
                    // narrowing also keeps `s` a valid MergeMethod for the check.
                    s !== "fast_forward" &&
                    !isMergeMethodAllowed(rulesConfig, pr.baseRefName, s);
                  return (
                    <DropdownMenuItem
                      key={s}
                      disabled={blocked}
                      onClick={() => {
                        setMergeStrategy(s);
                        setDeleteBranch(false);
                        setMergeAuto(false);
                        setMergeOpen(true);
                      }}
                    >
                      {MERGE_LABEL[s]}
                      {blocked && " — blocked by branch rule"}
                    </DropdownMenuItem>
                  );
                })}
                {/* GitLab auto-merge: while the head pipeline is in flight (and not
                    already armed), offer merge-when-pipeline-succeeds variants that
                    arm via the same confirm dialog. */}
                {canAutoMerge && pipelineInFlight && !autoMergeArmed && (
                  <>
                    <DropdownMenuSeparator />
                    {(["merge", "squash"] as const).map((s) => (
                      <DropdownMenuItem
                        key={`auto-${s}`}
                        title="Merges when the running pipeline succeeds"
                        onClick={() => {
                          setMergeStrategy(s);
                          setDeleteBranch(false);
                          setMergeAuto(true);
                          setMergeOpen(true);
                        }}
                      >
                        Auto-merge: {MERGE_LABEL[s]}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* Bitbucket declined PRs can't be reopened — no API or web affordance, so
          hide it (unlike GitHub/GitLab). */}
      {pr.state === "CLOSED" && canChangeState && provider !== "bitbucket" && (
        <div className="flex items-center gap-2 border-t p-3">
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              reopenPr.mutate(number, {
                onSuccess: () => toast.success(`Reopened #${number}`),
                onError,
              })
            }
          >
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            Reopen
          </Button>
        </div>
      )}

      <MergePrDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        number={number}
        host={remoteLabel}
        prNoun={prNoun}
        headRefName={pr.headRefName}
        baseRefName={pr.baseRefName}
        strategyLabel={MERGE_LABEL[mergeStrategy]}
        deleteBranch={deleteBranch}
        onDeleteBranchChange={setDeleteBranch}
        headIsDefault={headIsDefault}
        deletionBlocked={headDeletionBlocked}
        pending={mergeAuto ? armAutoMerge.isPending : mergePr.isPending}
        onConfirm={confirmMerge}
        auto={mergeAuto}
      />

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={(open) => {
          // The dialog stays mounted, so cancel any in-flight generation when it
          // closes (unlike the create dialogs, which unmount on close).
          if (!open) prGen.cancel();
          edit.setOpen(open);
        }}
        title={`Edit ${prNoun}`}
        description={`Updates the title and description of #${number} on ${remoteLabel}.`}
        contentClassName="sm:max-w-lg"
        bodyTextareaClassName="max-h-72 min-h-24 resize-y font-mono"
        bodyActions={
          !aiEnabled ? undefined : prGen.generating ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={prGen.cancel}
            >
              <XIcon data-icon="inline-start" />
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() =>
                prGen.generateFromDiff(
                  // Reuse the diff already cached by usePrDiff — and, crucially,
                  // resolve it from the PR's own diff (not local base..head refs),
                  // so this works for fork PRs / unfetched head branches.
                  () =>
                    queryClient
                      .ensureQueryData(prDiffOptions(repoPath, number))
                      .then((text) => ({
                        text,
                        truncated: false,
                        files: pr.files.map((f) => ({
                          path: f.path,
                          added: f.additions,
                          deleted: f.deletions,
                          isBinary: false,
                        })),
                      })),
                  pr.baseRefName,
                  pr.headRefName,
                  pr.commits.map((c) => c.headline),
                  (d) => {
                    edit.form.setFieldValue("title", d.title);
                    edit.form.setFieldValue("body", d.body);
                  },
                  // Provider-aware prompt copy; null host → base GitHub wording.
                  provider ?? undefined,
                )
              }
              title="Generate the title and description with AI"
            >
              <SparkleIcon data-icon="inline-start" />
              Generate
            </Button>
          )
        }
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        pending={deleteComment.isPending}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) =>
          deleteComment.mutate(
            { number, commentId },
            {
              onSuccess: () => {
                toast.success("Comment deleted");
                setDeletingCommentId(null);
              },
              onError: (e) => {
                onError(e);
                setDeletingCommentId(null);
              },
            },
          )
        }
      />

      <DeleteCommentDialog
        commentId={deletingThreadCommentId}
        onClose={() => setDeletingThreadCommentId(null)}
        pending={deleteReviewComment.isPending}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) =>
          deleteReviewComment.mutate(
            { number, commentId },
            {
              onSuccess: () => {
                toast.success("Comment deleted");
                setDeletingThreadCommentId(null);
              },
              onError: (e) => {
                onError(e);
                setDeletingThreadCommentId(null);
              },
            },
          )
        }
      />

      {/* The batch submit-review dialog: opened from the Review control, the
          pending-review bar, and the palette action. Verdict caps ride canWrite
          for GitHub, the forge flags for GitLab/Bitbucket. */}
      <SubmitReviewDialog
        repoPath={repoPath}
        number={number}
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        caps={{
          canApprove: canWrite || canApprove,
          canRequestChanges: canWrite || canRequestChanges,
        }}
        remoteLabel={remoteLabel}
      />

      {/* Palette-triggered "Discard pending review" confirmation (the bar has its
          own inline confirm; this is the keyboard/command-palette entry point). */}
      <ConfirmDialog
        open={discardConfirmOpen}
        onCancel={() => setDiscardConfirmOpen(false)}
        title="Discard pending review?"
        body={`This deletes all ${draftCount} pending comment${draftCount === 1 ? "" : "s"}. They haven't been posted yet and can't be recovered.`}
        confirmLabel="Discard review"
        confirmVariant="destructive"
        pending={clearDrafts.isPending}
        onConfirm={() =>
          clearDrafts.mutate(undefined, {
            onError,
            onSuccess: () => setDiscardConfirmOpen(false),
          })
        }
      />
    </div>
  );
}
