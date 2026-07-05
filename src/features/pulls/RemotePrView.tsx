import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
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
import { CommitsList } from "@/features/conversations/CommitsList";
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
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { isMergeMethodAllowed } from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import type {
  MergeStrategy,
  MinimizeReason,
  ReviewAction,
} from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import {
  forgeFeatureReady,
  PIPELINE_IN_FLIGHT,
  prDiffOptions,
  useApplySuggestion,
  useApprovePr,
  useCheckoutPr,
  useClosePr,
  useCommentPr,
  useDeletePrComment,
  useEditPr,
  useEditPrComment,
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
  useReadyPr,
  useReopenPr,
  useRepoStatus,
  useRequestChangesPr,
  useReviewPr,
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
import { type ApprovalState, providerLabel } from "@/lib/git/types";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PrReviewPanel } from "./PrReviewPanel";
import { PrTasksChip, PrTasksSection } from "./PrTasksSection";
import {
  MergePrDialog,
  MrTimeTracking,
  PrFilesPane,
} from "./RemotePrViewParts";
import { ReviewersPopover, userRefHint } from "./ReviewersPopover";
import {
  ReviewThreadsBlock,
  SUBMIT_HINT,
  type SuggestionApply,
  threadToMarkdown,
} from "./ReviewThreads";
import { useGeneratePrDescription } from "./useGeneratePrDescription";

type Section = "conversation" | "commits" | "files" | "review";

const MERGE_LABEL: Record<MergeStrategy, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  fast_forward: "Fast-forward",
};

/**
 * Tone + glyph for a CI check, so pass/fail isn't conveyed by color alone.
 */
function checkPresentation(status: string): {
  tone: string;
  Icon: typeof CheckCircleIcon;
  label: string;
} {
  const s = status.toUpperCase();
  if (s === "SUCCESS") {
    return {
      tone: "text-success",
      Icon: CheckCircleIcon,
      label: "passed",
    };
  }
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(s)) {
    return {
      tone: "text-destructive",
      Icon: XCircleIcon,
      label: "failed",
    };
  }
  return {
    tone: "text-warning",
    Icon: CircleIcon,
    label: "pending",
  };
}

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
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const remoteLabel = providerLabel(provider);
  const prNoun = provider === "gitlab" ? "merge request" : "pull request";
  // GitLab MR WRITES land per-action (full reviews stay GitHub-only via
  // `canWrite`). Each shared control is
  // `canWrite || forgeFeatureReady(...)` so GitHub keeps its controls while a
  // forge-status query is pending/failed (canWrite default-true) AND a ready GitLab
  // repo positively enables just these.
  const canComment = canWrite || forgeFeatureReady(forge.data, "mrComment");
  const canChangeState = canWrite || forgeFeatureReady(forge.data, "mrState");
  // Title/body editing is a shared control too.
  const canEdit = canWrite || forgeFeatureReady(forge.data, "mrEdit");
  // GitLab's approve/unapprove is a bodyless toggle with no GitHub analogue (GitHub
  // approves via the Review menu above), so it's GitLab-only and gated on the forge
  // feature directly — NOT `canWrite || …`, which would duplicate the Review control.
  const canApprove = forgeFeatureReady(forge.data, "mrApprove");
  // Request-changes follows the same forge-only shape (GitHub's lives in the
  // Review menu). On GitLab it's one-shot (the direct undo is Premium-only); on
  // Bitbucket the revoke works everywhere, so the control is a true toggle.
  const canRequestChanges = forgeFeatureReady(forge.data, "mrRequestChanges");
  // Bitbucket's revoke — drives the toggle direction below.
  const canUnrequestChanges = provider === "bitbucket";
  // Merge is a SHARED control (GitHub `gh pr merge`, GitLab `glab`), so it uses the
  // `canWrite || …` gate like comment/close — GitHub keeps it while forge-status is
  // pending/failed; a ready GitLab repo enables it too.
  const canMerge = canWrite || forgeFeatureReady(forge.data, "mrMerge");
  // Auto-merge (merge-when-pipeline-succeeds) is GitLab-only like the approve toggle
  // (GitHub has no in-app PR auto-merge), so the flag alone gates — never `canWrite || …`.
  const canAutoMerge = forgeFeatureReady(forge.data, "mrAutoMerge");
  // Labels are a shared control (both providers) — same `canWrite || …` gate.
  const canEditLabels = canWrite || forgeFeatureReady(forge.data, "mrLabels");
  // MR assignees are GitLab-only like the approve toggle (GitHub PRs have no
  // assignee picker here), so the flag alone gates — never `canWrite || …`.
  const canEditAssignees = forgeFeatureReady(forge.data, "mrAssignees");
  // The reviewers picker is Bitbucket-only the same way (GitHub's review
  // requests live in its own flow; the GitLab reviewer list isn't wired).
  const canEditReviewers = forgeFeatureReady(forge.data, "mrReviewers");
  // Bitbucket toggles draft BOTH ways via the same edit surface (GitHub's
  // one-way Ready button below stays on `canWrite` + `gh pr ready`).
  const canToggleDraft =
    provider === "bitbucket" && forgeFeatureReady(forge.data, "mrEdit");
  // Time tracking is GitLab-only too (GitHub has no built-in time tracking).
  const canTrackTime = forgeFeatureReady(forge.data, "timeTracking");
  // PR tasks are a native Bitbucket concept (no GitHub/GitLab analogue wired), so
  // the flag alone gates the section + header chip — never `canWrite || …`.
  const canTasks = forgeFeatureReady(forge.data, "prTasks");
  // Review-thread reply/resolve are shared controls (GitHub + wired providers) —
  // same `canWrite || …` gate as comment/merge so GitHub keeps them while
  // forge-status is pending/failed, and a ready provider positively enables them.
  const canThreadReply =
    canWrite || forgeFeatureReady(forge.data, "mrThreadReply");
  const canThreadResolve =
    canWrite || forgeFeatureReady(forge.data, "mrThreadResolve");
  const details = usePrDetails(repoPath, number);
  const prDiff = usePrDiff(repoPath, number);
  const review = useReviewPr(repoPath);
  const setAssignees = useSetPrAssignees(repoPath);
  const setReviewers = useSetPrReviewers(repoPath);
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
  // view notices the pipeline completing and the auto-merge firing.
  const mergeState = useGlMrMergeState(
    repoPath,
    canAutoMerge && details.data?.state === "OPEN" ? number : null,
  );
  const armAutoMerge = useGlArmAutoMerge(repoPath);
  const cancelAutoMerge = useGlCancelAutoMerge(repoPath);
  const editComment = useEditPrComment(repoPath);
  const deleteComment = useDeletePrComment(repoPath);
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
  // Reactions are a shared control (GitLab awards emoji); the fetch is gated so
  // it never fires for a provider whose reactions aren't wired (Bitbucket).
  const canReact = canWrite || forgeFeatureReady(forge.data, "mrReactions");
  const reactions = usePrReactions(repoPath, canReact ? number : null);
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "pr", number, "reactions"] as const,
    details.data?.id ?? "",
    { target: "mr", number },
  );
  const [section, setSection] = useState<Section>("conversation");
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [composeBody, setComposeBody] = useState("");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
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

  function submitReview(action: ReviewAction) {
    review.mutate(
      { number, action, body: composeBody.trim() },
      {
        onSuccess: () => {
          toast.success(
            action === "approve"
              ? "Approved"
              : action === "request_changes"
                ? "Requested changes"
                : "Review submitted",
          );
          setComposeBody("");
        },
        onError,
      },
    );
  }

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
    if (!composeBody.trim()) return;
    comment.mutate(
      { number, body: composeBody.trim() },
      {
        onSuccess: () => {
          toast.success("Comment added");
          setComposeBody("");
        },
        onError,
      },
    );
  }

  function confirmMerge() {
    // GitLab stale-view guard: the head sha the user is looking at (the same oid
    // the AI-review path uses). GitLab 409s if the head moved; GitHub ignores it.
    const sha = pr?.commits.at(-1)?.oid;
    if (mergeAuto) {
      // Arm merge-when-pipeline-succeeds instead of merging now (GitLab-only).
      armAutoMerge.mutate(
        { number, strategy: mergeStrategy, deleteBranch, sha },
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
        deleteBranch,
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
    review.isPending ||
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
      { commentId, body },
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
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={pr.state === "OPEN" ? "default" : "secondary"}>
            {pr.isDraft ? "Draft" : pr.state.toLowerCase()}
          </Badge>
          <AuthorAvatar login={pr.author} />
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
        {/* GitLab-only assignee picker (same affordance as the issue sidebar);
            a closed/merged MR falls back to read-only chips like the labels row.
            GitHub PRs carry no assignees, so they show nothing here, as before. */}
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
              {pr.assignees.map((login) => (
                <span
                  key={login}
                  className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  @{login}
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
                    className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
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
        {pr.checks.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
            {pr.checks.map((c) => {
              const { tone, Icon, label } = checkPresentation(c.status);
              return (
                <span
                  key={c.name}
                  className={cn("flex items-center gap-1 truncate", tone)}
                  title={`${c.name}: ${label}`}
                >
                  <Icon className="size-3 shrink-0" aria-label={label} />
                  {c.name}
                </span>
              );
            })}
          </div>
        )}
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
          onPost={(body) =>
            comment.mutateAsync({ number, body }).catch((e) => {
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
              {/* Events with nothing visible to say (empty body, or only an
                  unfilled-template HTML comment) render as a bare author
                  line — drop them. */}
              {pr.reviews
                .filter((r) => hasVisibleBody(r.body) || r.state)
                .map((r) => {
                  // A GitHub review's real findings live in its file-anchored
                  // threads (Copilot/CodeRabbit reviews often carry an empty or
                  // boilerplate body), so Copy-markdown appends them. Only when the
                  // review has a node id (GitHub) AND owns matching threads; else
                  // undefined ⇒ Thread copies the raw body, byte-identical.
                  const ownThreads =
                    r.id !== ""
                      ? (reviewThreads.data?.filter(
                          (t) => t.reviewId === r.id,
                        ) ?? [])
                      : [];
                  const copyMarkdown =
                    ownThreads.length > 0
                      ? [
                          r.body.trim() ? r.body.trim() : null,
                          ...ownThreads.map(threadToMarkdown),
                        ]
                          .filter(Boolean)
                          .join("\n\n---\n\n")
                      : undefined;
                  return (
                    <Thread
                      // Key on author+timestamp: unique per review submission and
                      // stable (GitHub now carries a node id, but GitLab/Bitbucket
                      // emit no review entries and leave it "").
                      key={`${r.author}-${r.date}`}
                      thread={r}
                      onQuote={
                        canWrite && hasVisibleBody(r.body)
                          ? () => quoteReply(r.body)
                          : undefined
                      }
                      copyMarkdown={copyMarkdown}
                    />
                  );
                })}
              {/* File:line-anchored review threads, grouped by file. Renders
                  nothing when there are none (or while loading); a quiet muted
                  line on error. Reply/resolve gated per provider. */}
              <ReviewThreadsBlock
                threads={reviewThreads.data}
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
                apply={suggestionApply}
              />
              {pr.comments
                .filter((c) => hasVisibleBody(c.body))
                .map((c) => (
                  // Annotated so a Bitbucket PR task attached to this comment can
                  // scroll to it (`viewComment` in PrTasksSection targets
                  // [data-comment-id]). Inert markup for GitHub/GitLab.
                  <div key={c.id} data-comment-id={c.id}>
                    <Thread
                      thread={c}
                      onQuote={canWrite ? () => quoteReply(c.body) : undefined}
                      onSaveEdit={
                        canWrite && c.viewerDidAuthor
                          ? (body) => saveCommentEdit(c.id, body)
                          : undefined
                      }
                      onDelete={
                        canWrite && c.viewerDidAuthor
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
                        canReact ? reactions.data?.comments[c.id] : undefined
                      }
                      onToggleReaction={
                        canReact
                          ? (content, active) =>
                              toggleReaction(c.id, content, active)
                          : undefined
                      }
                    />
                  </div>
                ))}
              {pr.reviews.length === 0 && pr.comments.length === 0 && (
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
                {isOpen && canWrite && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="outline" size="sm" disabled={busy}>
                          Review
                          <CaretDownIcon data-icon="inline-end" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent className="w-52">
                      <DropdownMenuItem onClick={() => submitReview("approve")}>
                        Approve
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => submitReview("comment")}>
                        Comment
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => submitReview("request_changes")}
                      >
                        Request changes
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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

      {section === "commits" && (
        <CommitsList
          commits={pr.commits.map((c) => ({
            id: c.oid,
            subject: c.headline,
            shortSha: c.oid.slice(0, 7),
            author: c.author,
            date: c.date,
          }))}
        />
      )}

      {section === "files" && (
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
          onQuote={quoteReply}
          onReply={
            canThreadReply
              ? (threadId, body) => threadReply.mutateAsync({ threadId, body })
              : undefined
          }
          onResolve={
            canThreadResolve
              ? (threadId, resolved) =>
                  threadResolve.mutateAsync({ threadId, resolved })
              : undefined
          }
          apply={suggestionApply}
        />
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
        onConfirm={(commentId) =>
          deleteComment.mutate(commentId, {
            onSuccess: () => {
              toast.success("Comment deleted");
              setDeletingCommentId(null);
            },
            onError: (e) => {
              onError(e);
              setDeletingCommentId(null);
            },
          })
        }
      />
    </div>
  );
}
