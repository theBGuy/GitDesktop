import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  ClockCountdownIcon,
  DotsThreeIcon,
  GitBranchIcon,
  GitMergeIcon,
  PencilSimpleIcon,
  RobotIcon,
  SparkleIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DiffStat } from "@/components/diff-stat";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { SelectControl } from "@/components/form/fields";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
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
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { CommitsList } from "@/features/conversations/CommitsList";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { LabelsPopover } from "@/features/conversations/LabelsPopover";
import { ProjectsPopover } from "@/features/conversations/ProjectsPopover";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import { AuthorAvatar, LabelChip } from "@/features/conversations/Thread";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import type { LineWidget } from "@/features/diff/DiffSurface";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import { aiExcludePatterns, filterDiffByAiIgnore } from "@/lib/ai/ignore";
import { triggerAutomations } from "@/lib/automations/runner";
import { prOpenEligible } from "@/lib/automations/sync";
import {
  isDeletionBlocked,
  isMergeMethodAllowed,
  isPromotionBranch,
} from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import {
  gitFetch,
  type MergeStrategy,
  type MinimizeReason,
  type RemotePrResolveHandle,
} from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import { useForgeGhHost } from "@/lib/git/host";
import {
  forgeFeatureReady,
  PIPELINE_IN_FLIGHT,
  prDiffOptions,
  prUpdateBranchKeys,
  repoKeys,
  TRIAGE_ACCESS_ITEM_REASON,
  triageAccessReason,
  useAbortRemotePrResolve,
  useApplySuggestion,
  useApprovePr,
  useCheckoutPr,
  useClosePr,
  useCommentPr,
  useConflictPreview,
  useDefaultBranch,
  useDeletePrComment,
  useDeleteReviewComment,
  useEditPr,
  useEditPrComment,
  useEditReviewComment,
  useFindRemotePrResolve,
  useForgeStatus,
  useGlArmAutoMerge,
  useGlCancelAutoMerge,
  useGlMrMergeState,
  useMergePr,
  useMergeRemotePr,
  useMinimizeComment,
  usePrApprovals,
  usePrBaseDivergence,
  usePrDetails,
  usePrDiff,
  usePrList,
  usePrMergeability,
  usePrReactions,
  usePrReviewThreads,
  usePrTimeline,
  usePrUpdateBranch,
  useReopenPr,
  useRepoStatus,
  useRepoWriteAccess,
  useRequestChangesPr,
  useSetPrAssignees,
  useSetPrDraft,
  useSetPrReviewers,
  useStackAdd,
  useStackCreate,
  useStackDissolve,
  useThreadReply,
  useThreadResolve,
  useToggleReaction,
  useUnapprovePr,
  useUnminimizeComment,
  useUnrequestChangesPr,
  writeAccessReason,
} from "@/lib/git/queries";
import {
  detectStackOffer,
  isNativeStack,
  offerIdentity,
  STACK_OFFER_PAGE_LIMIT,
} from "@/lib/git/stack-chains";
import {
  type ApprovalState,
  type ForgeProvider,
  type ForgeUserRef,
  type PrDetails,
  type PrThreadOut,
  providerLabel,
  type RemoteLens,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useGenerateChordHint } from "@/lib/hotkeys/useGenerateChord";
import { useJiraLink } from "@/lib/jira/queries";
import type { PrSection } from "@/lib/pulls/pr-section";
import {
  useClearReviewDrafts,
  useReviewDrafts,
} from "@/lib/pulls/review-drafts";
import { useRepoLens } from "@/lib/repo-lens/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { queuedMergeKey, useUiStore } from "@/lib/stores/ui";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { ChecksRollup } from "./ChecksRollup";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { PendingReviewBar } from "./PendingReviewBar";
import { PrActivityFeed, usePrThreadClaims } from "./PrActivityFeed";
import { PrCommitDetail } from "./PrCommitDetail";
import {
  blockedMergeLine,
  gitlabBlockedLine,
  PR_SWITCH_LOADING_REASON,
  type PrMergeabilityArm,
  PrMergeabilityBanner,
  type PromotionKind,
} from "./PrMergeabilityBanner";
import { PrReviewPanel } from "./PrReviewPanel";
import { PrTasksChip, PrTasksSection } from "./PrTasksSection";
import {
  MergePrDialog,
  MrTimeTracking,
  PrFilesPane,
} from "./RemotePrViewParts";
import {
  DISCARD_RESOLVE_CONFIRM,
  ResolveRemotePrView,
} from "./ResolveRemotePrView";
import { ReviewComposer } from "./ReviewComposer";
import { ReviewersPopover, userRefHint } from "./ReviewersPopover";
import { ReviewThreadsBlock, type SuggestionApply } from "./ReviewThreads";
import {
  StackOffer,
  type StackOfferHandle,
  StackSection,
  stackMergeDisclosure,
} from "./StackSection";
import { SubmitReviewDialog } from "./SubmitReviewDialog";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import {
  unmetRequiredChecks,
  useBranchRequiredChecks,
} from "./useBranchRequiredChecks";
import {
  useCancelOnIdentityChange,
  useGeneratePrDescription,
} from "./useGeneratePrDescription";
import {
  composeBodyWithJiraRefs,
  composeBodyWithRefs,
  splitBodyRefBlock,
  useJiraMentionChips,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";
import { usePrCapabilities } from "./usePrCapabilities";

/** The git remote a lens resolves to, mirroring the backend's own mapping
 *  (github/mod.rs:73 `lens_remote`). Exhaustive on purpose: a widened `RemoteLens`
 *  must fail the build here rather than silently fall back to `origin` and quietly
 *  predict conflicts against the wrong repository. */
function lensRemoteName(lens: RemoteLens): string {
  switch (lens) {
    case "origin":
      return "origin";
    case "upstream":
      return "upstream";
    default: {
      const exhaustive: never = lens;
      return exhaustive;
    }
  }
}

const MERGE_LABEL: Record<MergeStrategy, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  fast_forward: "Fast-forward",
};

/** Each strategy's server-side repo setting. Bitbucket's fast_forward has no
 *  GitHub server toggle, so it reads `null` (unknown). */
const SERVER_MERGE_FLAG: Record<
  MergeStrategy,
  (pr: PrDetails) => boolean | null
> = {
  merge: (pr) => pr.mergeCommitAllowed,
  squash: (pr) => pr.squashMergeAllowed,
  rebase: (pr) => pr.rebaseMergeAllowed,
  fast_forward: () => null,
};

/** Which merge strategies a provider offers. GitLab has no per-MR rebase-merge
 *  (that's the project's merge_method setting); fast-forward is Bitbucket's. */
const PROVIDER_MERGE_STRATEGIES: Record<
  ForgeProvider,
  readonly MergeStrategy[]
> = {
  github: ["merge", "squash", "rebase"],
  gitlab: ["merge", "squash"],
  bitbucket: ["merge", "squash", "fast_forward"],
};

/** Tab labels for this view's sections, function-valued because three of the four
 *  carry a live count. */
const SECTION_LABEL: Record<PrSection, (pr: PrDetails) => string> = {
  conversation: (pr) => `Conversation (${pr.comments.length})`,
  commits: (pr) => `Commits (${pr.commits.length})`,
  files: (pr) => `Files (${pr.files.length})`,
  review: () => "Review",
};

/** Whether a GitHub merge method is disabled by the repo's server-side merge
 *  settings. Only an explicit `false` gates — `null`/`undefined` means unknown
 *  (fetch failed, or a non-GitHub provider) and never disables. */
function isServerMergeDisabled(pr: PrDetails, s: MergeStrategy): boolean {
  return SERVER_MERGE_FLAG[s](pr) === false;
}

export function RemotePrView({
  repoPath,
  number,
}: {
  repoPath: string;
  number: number;
}) {
  const queryClient = useQueryClient();
  // The read view is provider-neutral; GitHub-only mutations (full reviews,
  // ready-for-review, checkout) route through `gh_*` and gate on `canWrite`
  // ("not a known read-only provider"), NOT `provider === "github"` — so a pending
  // or failed forge-status probe never strips a GitHub PR's write controls.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const remoteLabel = providerLabel(provider);
  const prNoun = provider === "gitlab" ? "merge request" : "pull request";
  // The single lens-resolution point for this surface: every PR read/write below
  // targets the fork (origin) or its parent (upstream) — "origin" everywhere but a
  // GitHub fork whose lens is set upstream.
  const lens = useRepoLens(repoPath);
  // Which PR is on screen. `repoPath` because a number is only unique within one
  // repo, and the lens because it can flip while this view stays MOUNTED —
  // removing the upstream remote collapses the gate, so the same number becomes a
  // different repo's PR.
  const entityKey = `${repoPath}#${lens}#${number}`;
  // The viewer's push permission on the lens repo — the axis the per-action
  // forge flags don't cover. Only fetched once a provider is known; an
  // unanswered probe leaves every control exactly as it is.
  const writeAccess = useRepoWriteAccess(
    repoPath,
    lens,
    !!forge.data?.provider,
  );
  const writeReason = writeAccessReason(writeAccess.data);
  // Labels, assignees, reviewers, hiding comments and close/reopen are granted
  // at TRIAGE tier, below push — gating them on the write axis would strip a
  // triager's controls.
  const triageReason = triageAccessReason(writeAccess.data);
  const triageBlocked = !!triageReason;
  // Menu items can't show a tooltip once disabled — they carry the compact
  // reason in their label instead.
  const triageItemReason = triageReason ? TRIAGE_ACCESS_ITEM_REASON : undefined;
  // Per-action write-capability flags from forge status + provider (gating
  // convention: usePrCapabilities).
  const {
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
  } = usePrCapabilities(forge.data, provider, writeAccess.data);
  const details = usePrDetails(repoPath, number, lens);
  // Every handler that refuses while the rendered PR is the previous one reads
  // this, so each of their entry points can hold too rather than sit enabled and
  // do nothing. Declared up here beside `details` because the gates that need it
  // (the update-branch derivation among them) run well before the strip does.
  const detailsStale = details.isPlaceholderData;
  const prDiff = usePrDiff(repoPath, number, lens);
  const setAssignees = useSetPrAssignees(repoPath, lens);
  const setReviewers = useSetPrReviewers(repoPath, lens);
  // For the read-only assignee/reviewer chips (closed/merged PRs): GitHub avatars
  // are login-derived, GitLab/Bitbucket carry a real avatarUrl on the ref.
  const ghHost = useForgeGhHost(repoPath);
  const mentions = useMentionCandidates({ repoPath, lens, provider });
  const comment = useCommentPr(repoPath, lens);
  const checkout = useCheckoutPr(repoPath, lens);
  const repoStatus = useRepoStatus(repoPath);
  const applySuggestion = useApplySuggestion(repoPath);
  const mergePr = useMergePr(repoPath, lens);
  const closePr = useClosePr(repoPath, lens);
  const reopenPr = useReopenPr(repoPath, lens);
  // Approval + reviewer state drives the approve toggle and Request-changes
  // control (GitLab + Bitbucket); only fetched for a ready repo with an open MR
  // (null disables the read for GitHub / closed MRs).
  const approvals = usePrApprovals(
    repoPath,
    (canApprove || canRequestChanges) && details.data?.state === "OPEN"
      ? number
      : null,
  );
  const approvePr = useApprovePr(repoPath, lens);
  const unapprovePr = useUnapprovePr(repoPath);
  const requestChangesPr = useRequestChangesPr(repoPath, lens);
  const unrequestChangesPr = useUnrequestChangesPr(repoPath);
  // Auto-merge state (GitLab-only): a null number disables the read (GitHub / closed
  // MRs) and stops its refetchInterval — it polls so the view notices the pipeline
  // completing and the auto-merge firing. The repoTab gate is load-bearing: an
  // <Activity>-hidden subtree still renders; staleTime (5s) refetches on return.
  const repoTab = useUiStore((s) => s.repoTab);
  const mergeState = useGlMrMergeState(
    repoPath,
    repoTab === "pulls" && canAutoMerge && details.data?.state === "OPEN"
      ? number
      : null,
  );
  const armAutoMerge = useGlArmAutoMerge(repoPath);
  const cancelAutoMerge = useGlCancelAutoMerge(repoPath);
  const isOpenPr = details.data?.state === "OPEN";
  // Mergeability against the base — the conflict banner's server truth. Same repoTab
  // gate as the auto-merge poll above and for the same reason: it polls, and an
  // <Activity>-hidden subtree still fetches. Non-open PRs have no answer to give.
  const mergeability = usePrMergeability(
    repoPath,
    number,
    lens,
    repoTab === "pulls" && isOpenPr,
  );
  const lensRemote = lensRemoteName(lens);
  const serverState = mergeability.data?.state;
  // A read that never landed — unreachable, not undecided. A settled answer that a later
  // refresh failed on keeps that answer: server truth outranks the local prediction, so
  // a bare `isError` here would paint a stale prediction over a mergeable PR.
  const forgeUnreachable = mergeability.isError && !mergeability.data;
  // The local prediction stands in wherever the forge has no mergeability to give —
  // Bitbucket by design, or a read that never landed (it runs on local refs and never
  // fetches, so it answers with the forge unreachable) — and it NAMES the conflicting
  // files when the forge says "conflicting" but won't say where. Never for a fork head:
  // a same-named branch under our remote would make the prediction lie. The placeholder
  // term is the PR-switch guard — details serves the PREVIOUS PR's refs while the new
  // mergeability read has none. Hoisted because a DISABLED query keeps serving its last
  // value, so every reader of the prediction has to gate on this too.
  const previewEnabled =
    repoTab === "pulls" &&
    isOpenPr &&
    !details.isPlaceholderData &&
    !details.data?.crossRepository &&
    (serverState === "unavailable" ||
      serverState === "conflicting" ||
      forgeUnreachable);
  const conflictPreview = useConflictPreview(
    repoPath,
    `${lensRemote}/${details.data?.baseRefName ?? ""}`,
    `${lensRemote}/${details.data?.headRefName ?? ""}`,
    previewEnabled,
  );
  // An unfinished resolve worktree for this PR (e.g. left by an earlier session).
  // Offered via the banner, never auto-entered — taking the view over unasked would
  // hide the pull request the user came to read.
  const findResolve = useFindRemotePrResolve(
    repoPath,
    number,
    lens,
    repoTab === "pulls" && isOpenPr,
  );
  // How far the base has moved on — GitHub-only (the command has no forge dispatch
  // and errors elsewhere). Hoisted like `previewEnabled` because a disabled query
  // keeps serving its last value, so every reader has to gate on this too.
  const divergenceEnabled =
    repoTab === "pulls" && provider === "github" && isOpenPr;
  const divergence = usePrBaseDivergence(
    repoPath,
    number,
    lens,
    divergenceEnabled,
  );
  // The divergence query's own identity axes, so an awaited update-branch answer can
  // tell "still this PR" from "the view moved on".
  const divergenceIdentity = [repoPath, number, lens].join("|");
  const updateBranch = usePrUpdateBranch(repoPath);
  const mergeRemotePr = useMergeRemotePr(repoPath, lens);
  const abortRemotePrResolve = useAbortRemotePrResolve(repoPath);
  // The AI-resolution store the takeover follows — the banner's "Resolve with AI"
  // seeds its walk here so the surface opens already working through the files.
  const startAll = useConflictResolve((s) => s.startAll);
  // The conflict resolution this view is driving — started here or resumed from the
  // rediscovered worktree. Non-null takes the whole view over.
  const [resolve, setResolve] = useState<RemotePrResolveHandle | null>(null);
  const editComment = useEditPrComment(repoPath, lens);
  const deleteComment = useDeletePrComment(repoPath, lens);
  const editReviewComment = useEditReviewComment(repoPath, lens);
  const deleteReviewComment = useDeleteReviewComment(repoPath, lens);
  const minimizeComment = useMinimizeComment(repoPath);
  const unminimizeComment = useUnminimizeComment(repoPath);
  const setDraft = useSetPrDraft(repoPath, lens);
  const editPr = useEditPr(repoPath, lens);
  // File:line-anchored review threads, shared by the Conversation block and the
  // Files-tab diff anchors — so the read lives at the top level. It gates on the PR
  // number alone (a flaky status probe mustn't hide threads); the WRITE controls
  // below stay gated on the per-provider Implemented flags.
  const reviewThreads = usePrReviewThreads(repoPath, number, lens);
  const threadReply = useThreadReply(repoPath, number, lens);
  const threadResolve = useThreadResolve(repoPath, number, lens);
  // The reactions fetch is gated on `canReact` (see usePrCapabilities) so it never
  // fires for a provider whose reactions aren't wired (Bitbucket).
  const reactions = usePrReactions(repoPath, canReact ? number : null, lens);
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "pr", lens, number, "reactions"] as const,
    details.data?.id ?? "",
    { target: "mr", number },
  );
  const [section, setSection] = useState<PrSection>("conversation");
  // A review thread the user asked to jump to (timeline "View thread"). Handed to
  // whichever ReviewThreadList owns it; that list reveals the (possibly
  // resolved/collapsed) thread and clears this via onRevealed.
  const [revealThreadId, setRevealThreadId] = useState<string | null>(null);
  // The review card a notification asked to land on. Deliberately its OWN state
  // rather than a read of the store hint: the hint is handed over only once this
  // view's details are real (below), long after the sub-tab hint has settled.
  const [revealReviewId, setRevealReviewId] = useState<string | null>(null);
  // Activity-timeline events (force-pushes, labels, state changes, review requests,
  // approvals) interleaved into the Conversation feed; provider-neutral via the
  // backend's `forge_pr_timeline`. Fetch only while Conversation is showing AND a
  // provider resolved — the <Activity>-hidden subtree still renders, so the
  // composite gate is load-bearing.
  const timeline = usePrTimeline(
    repoPath,
    number,
    section === "conversation" && !!provider,
    lens,
  );
  const pendingPrSection = useUiStore((s) => s.pendingPrSection);
  const setPendingPrSection = useUiStore((s) => s.setPendingPrSection);
  const pendingReviewId = useUiStore((s) => s.pendingReviewId);
  const setPendingReviewId = useUiStore((s) => s.setPendingReviewId);
  const selectedPr = useUiStore((s) => s.selectedPr);
  const selectPr = useUiStore((s) => s.selectPr);
  // Merge-queue record for THIS pull request. The forge reports the queue once,
  // in the merge outcome, and nothing fetchable carries it afterwards, so the
  // store is the only source and the PR leaving OPEN is the only retraction.
  // Keyed on the same repo+number+LENS identity `divergenceIdentity` uses: the
  // lens flips while this view stays mounted, and origin and upstream can both
  // have a pull request numbered 7.
  const queuedKey = queuedMergeKey(repoPath, number, lens);
  const mergeQueued = useUiStore((s) => Boolean(s.queuedMerges[queuedKey]));
  const markMergeQueued = useUiStore((s) => s.markMergeQueued);
  const clearMergeQueued = useUiStore((s) => s.clearMergeQueued);
  // Details are authoritative once they land: a merged or closed pull request is
  // out of the queue however it got there. The placeholder gate is what makes the
  // retraction safe — `queuedKey` follows the number and lens immediately while
  // `details` still serves the PREVIOUS pull request, so switching away to a
  // merged one and back would otherwise read ITS state against THIS key and drop
  // the record for good. Same gate on the chip below, so both read one truth.
  const queuedDetailsReady = !details.isPlaceholderData;
  const prState = details.data?.state;
  useEffect(() => {
    if (!queuedDetailsReady) return;
    if (mergeQueued && prState !== undefined && prState !== "OPEN")
      clearMergeQueued(queuedKey);
  }, [queuedDetailsReady, mergeQueued, prState, queuedKey, clearMergeQueued]);
  // Whether this view owns the current selection. Several hint/palette paths
  // gate on it so a still-mounted lagging view (deferredPr) can't answer first.
  const isSelectedPr =
    selectedPr?.kind === "remote" && selectedPr.id === String(number);
  const aiEnabled = useAiEnabled();
  // The sub-tabs the strip renders — every writer of `section` gates on this, so
  // no path can select a tab that isn't there. The AI Review tab needs only the
  // diff (forge-neutral) and a way to post the result as a comment, so it
  // follows canComment, which covers GitLab MRs too (canWrite implies
  // canComment for GitHub).
  const availableSections = useMemo<PrSection[]>(
    () =>
      aiEnabled && canComment
        ? ["conversation", "commits", "files", "review"]
        : ["conversation", "commits", "files"],
    [aiEnabled, canComment],
  );
  // Until the forge probe answers, `canComment` is a provisional verdict: an
  // unresolved provider fails open through canWrite, so the Review tab reads
  // available and then drops once a GitLab/Bitbucket answer lands. Both effects
  // below wait for the real answer rather than act on the guess. Only the forge
  // query counts — `writeAccess` feeds `writeBlocked`, not availability, and it
  // stays pending forever on a repo with no provider (it's a disabled query).
  const capabilitiesSettled = !forge.isPending;
  // A notification's click-through lands here via a pending hint; switch to the
  // hinted sub-tab once if it's available, then clear the hint either way so
  // an unusable hint can't fire against a later PR. (Until capabilities settle
  // the hint is left armed — navigating away in that sub-second window can
  // carry it to the next PR; accepted.)
  useEffect(() => {
    if (!capabilitiesSettled) return;
    if (pendingPrSection !== null && isSelectedPr) {
      if (availableSections.includes(pendingPrSection))
        setSection(pendingPrSection);
      setPendingPrSection(null);
    }
  }, [
    pendingPrSection,
    setPendingPrSection,
    isSelectedPr,
    availableSections,
    capabilitiesSettled,
  ]);
  // Availability can drop away under the selection (Hide AI toggled, a
  // capability lost on refetch), which would leave a blank body under a strip
  // with no pressed tab — fall back to the tab every PR always has. Layout
  // effect: a passive one paints that empty frame before reconciling.
  useLayoutEffect(() => {
    if (!capabilitiesSettled) return;
    if (!availableSections.includes(section)) setSection("conversation");
  }, [availableSections, section, capabilitiesSettled]);
  const rulesConfig = useEffectiveBranchRules(repoPath);
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);
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
  const drafts = useReviewDrafts(repoPath, lens, number);
  const clearDrafts = useClearReviewDrafts(repoPath, lens, number);
  // The composer/thread-create side of the forge detection: a strict provider key
  // (default "github" — gh is the authoritative default for an unrecognized host).
  const providerKey: ForgeProvider = provider ?? "github";

  // Palette-only PR actions — mounted here so they live only while a remote PR is
  // open. Every one whose enablement reads `details.data` also gates on
  // `!details.isPlaceholderData`: during a switch that data is the previous PR's,
  // so the command would offer (and act on) a PR the user never opened.
  const draftCount = drafts.data?.length ?? 0;
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  useHotkeyAction(
    "submit-review",
    () => setSubmitOpen(true),
    isSelectedPr &&
      canSubmitReview &&
      details.data?.state === "OPEN" &&
      !details.isPlaceholderData,
  );
  useHotkeyAction(
    "discard-pending-review",
    () => setDiscardConfirmOpen(true),
    isSelectedPr && draftCount > 0,
  );
  // The shared Ready / Convert-to-draft pair: visible when a wired provider
  // (GitLab/Bitbucket) flags `mrDraftToggle`, or on GitHub via `canWrite` (its
  // Ready/Convert routes through `gh pr ready [--undo]`).
  const isGitHubProvider = providerKey === "github";
  const draftPairVisible = canToggleDraft || (isGitHubProvider && canWrite);
  // One in-flight PR mutation at a time: every footer/state control and its palette
  // twin disables while any of these runs. Declared above the palette wiring so both
  // share the exact same gate. Placeholder details are the previously shown PR's and
  // the footer's verbs derive from them, so the same gate holds through a switch.
  const busy =
    details.isPlaceholderData ||
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
    setDraft.isPending;
  // WHICH draft action exists is picked off `isDraft`, so placeholder details would
  // offer the PREVIOUS PR's. Retain the last FRESH value and the PR it belonged to;
  // a mismatch means nothing fresh has landed for this one yet, and neither action is
  // offered. Both retained values are primitives — an object would re-set every
  // render. The stale arms feed null so a mount landing mid-switch seeds neither.
  const retainedDraftFor = useRetained(
    details.isPlaceholderData ? null : entityKey,
    !details.isPlaceholderData,
  );
  const retainedIsDraft = useRetained(
    details.isPlaceholderData ? null : (details.data?.isDraft ?? null),
    !details.isPlaceholderData,
  );
  const shownIsDraft = retainedDraftFor === entityKey ? retainedIsDraft : null;
  // Palette twins of the footer's draft controls — same `setDraft` mutation, same
  // frozen identity, and Ready also fires the ready-review automation. Registration
  // is effect-synced, so an `enabled` term alone still leaves the keypress a frame
  // to land mid-switch; each handler re-checks the identity it is about to write.
  useHotkeyAction(
    "pr-ready-for-review",
    () => {
      if (shownIsDraft !== true) return;
      setDraft.mutate(
        { number, draft: false },
        {
          onSuccess: () => {
            toast.success("Marked ready for review");
            void fireReadyReview();
          },
          onError,
        },
      );
    },
    isSelectedPr && draftPairVisible && shownIsDraft === true && !busy,
  );
  useHotkeyAction(
    "pr-convert-to-draft",
    () => {
      if (shownIsDraft !== false) return;
      setDraft.mutate(
        { number, draft: true },
        {
          onSuccess: () => toast.success("Converted to draft"),
          onError,
        },
      );
    },
    isSelectedPr &&
      draftPairVisible &&
      shownIsDraft === false &&
      details.data?.state === "OPEN" &&
      !busy,
  );

  // Palette twins of the Stack section's arrow keys: step one position up or down
  // the stack. Each action is enabled only when a member actually sits at that
  // position, so it DISABLES at the stack's ends (never wrapping — a stack is a
  // dependency chain) and whenever the member list is missing, rather than
  // offering a command that would silently do nothing.
  function stackNeighbor(delta: 1 | -1) {
    const info = details.data?.stack;
    if (!info) return undefined;
    return (details.data?.stackMembers ?? []).find(
      (m) => m.position === info.position + delta,
    );
  }
  function goToStackNeighbor(delta: 1 | -1) {
    // Re-resolved on activation: `enabled` is a render snapshot, while `run` reads
    // live state through useEffectEvent.
    const target = stackNeighbor(delta);
    if (target) selectPr({ kind: "remote", id: String(target.number) });
  }
  useHotkeyAction(
    "pr-stack-next",
    () => goToStackNeighbor(1),
    isSelectedPr && !details.isPlaceholderData && !!stackNeighbor(1),
  );
  useHotkeyAction(
    "pr-stack-previous",
    () => goToStackNeighbor(-1),
    isSelectedPr && !details.isPlaceholderData && !!stackNeighbor(-1),
  );

  // Stack writes are GitHub-only, and the chain that would be stacked is read
  // off the OPEN PR list. Keep this gate strict: it's a second list fetch, and
  // an already-stacked PR (or one whose stack probe failed, where a null stack
  // means "unknown") has nothing to offer. A fork PR is refused here, ahead of
  // that fetch and its stacks join; `detectStackOffer` keeps its own row-level
  // fork filter (stack-chains.ts) for the other members of the list. Every term
  // below reads `details`, so the offer waits for the SELECTED PR's — under the
  // placeholder it would decide eligibility from the previous one.
  const offerEnabled =
    providerKey === "github" &&
    !details.isPlaceholderData &&
    details.data?.state === "OPEN" &&
    canEdit &&
    !details.data?.stack &&
    !(details.data?.stackUnknown ?? false) &&
    !details.data?.crossRepository;
  const offerList = usePrList(
    repoPath,
    offerEnabled,
    "open",
    STACK_OFFER_PAGE_LIMIT,
    lens,
  );
  const stackCreate = useStackCreate(repoPath, lens);
  const stackAdd = useStackAdd(repoPath, lens);
  const stackDissolve = useStackDissolve(repoPath, lens);
  // The offer's own expansion lives in the component; the palette twins reach it
  // through this handle so both entry points land on the same Confirm button.
  const offerRef = useRef<StackOfferHandle>(null);
  const openPrs = offerEnabled ? (offerList.data ?? []) : [];
  const currentRow = openPrs.find((p) => p.number === number);
  const stackOffer = currentRow ? detectStackOffer(currentRow, openPrs) : null;
  // The offer's members in the same bottom→top order, dropped if a member has
  // somehow left the list between detection and render.
  const offerRows = (stackOffer?.members ?? []).flatMap((n) => {
    const row = openPrs.find((p) => p.number === n);
    return row ? [{ number: row.number, title: row.title }] : [];
  });
  const stackWriteError = stackCreate.error ?? stackAdd.error ?? null;
  // A fork row is dropped from the chain rather than voiding the list, so it only
  // explains THIS PR's missing offer when it would have been its CHILD. The mirror
  // test (a fork whose head is this PR's base) is not specific: fork PRs are
  // routinely opened from `main`, which is most PRs' base, so it would make the note
  // permanent furniture on ordinary pull requests.
  const forkChild =
    currentRow != null &&
    openPrs.some(
      (p) =>
        p.crossRepository === true && p.baseRefName === currentRow.headRefName,
    );
  // Why a chain that may well exist still gets no offer. Only the ADVISORY refusals
  // are named — the detector's structural arms (no chain, ambiguity, a stacked
  // neighbor) genuinely mean "nothing to stack", and a note there is noise. Read off
  // `openPrs`, so a disabled offer query can never speak for a PR the suggestion was
  // never attempted on.
  const stackOfferNote = (() => {
    if (stackOffer) return null;
    switch (true) {
      // Ordered as `detectStackOffer` refuses: the two fail-closed list guards
      // first, then the row-level fork exclusion.
      case openPrs.some((p) => p.stackUnknown === true):
        return "Stack suggestions are paused — GitDesktop couldn't read every open pull request's stack state.";
      case openPrs.length >= STACK_OFFER_PAGE_LIMIT:
        return "Stack suggestions are paused — too many open pull requests to scan reliably.";
      case forkChild:
        return "A fork pull request targets this branch, but fork pull requests can't join a stack — their branches live in another repository.";
      default:
        return null;
    }
  })();

  function confirmStackOffer() {
    // `offerEnabled` withholds the offer entirely until details are the selected
    // PR's, so the placeholder arm here is insurance against a looser gate later.
    if (!stackOffer || details.isPlaceholderData) return;
    if (stackOffer.kind === "create") {
      stackCreate.mutate(stackOffer.members, {
        onSuccess: (outcome) =>
          toast.success(
            `Stack created — ${outcome.members.length} pull requests`,
          ),
      });
      return;
    }
    const { stackNumber } = stackOffer;
    stackAdd.mutate(
      { stackNumber, pullRequests: stackOffer.members },
      {
        // The response lists the stack's members AFTER the append, so its length
        // is the new total — not just what this write added.
        onSuccess: (outcome) =>
          toast.success(
            `Added to stack #${stackNumber} — ${outcome.members.length} pull requests`,
          ),
      },
    );
  }

  // A failed write's message belongs beside the affordance, not in a toast — so
  // Cancel clears it along with the preview.
  function cancelStackOffer() {
    stackCreate.reset();
    stackAdd.reset();
  }

  // Write state belongs to ONE offer on ONE PR: this component isn't remounted
  // per PR (RepositoryView renders it without a key), and a list refetch can
  // reshape the chain under the same PR. Either way a surviving error — or
  // pending flag — would render against an offer it was never fired for, so
  // both triggers reset through this one path. The ref makes the mount pass a
  // no-op: there's nothing to clear yet.
  const stackWriteKey = `${number}|${stackOffer ? offerIdentity(stackOffer) : ""}`;
  const stackWriteFor = useRef(stackWriteKey);
  const resetStackWrites = useEffectEvent(() => cancelStackOffer());
  useEffect(() => {
    if (stackWriteFor.current === stackWriteKey) return;
    stackWriteFor.current = stackWriteKey;
    resetStackWrites();
  }, [stackWriteKey]);

  // The stack number the dissolve writes, parsed once. A native stack's id is a
  // numeric string by contract, so a value that won't parse means the contract
  // broke — null then withdraws the affordance (and its palette twin with it)
  // rather than sending the forge a NaN.
  const dissolveStackNumber = (() => {
    const info = details.data?.stack;
    if (!isNativeStack(info)) return null;
    const parsed = Number(info?.id);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  })();
  // Dissolve is offered only for a stack GitDesktop can actually write: a
  // GitHub-native one (a GitLab-inferred chain has no stack to dissolve).
  const canDissolveStack =
    dissolveStackNumber !== null && details.data?.state === "OPEN" && canEdit;

  async function dissolveStack() {
    const info = details.data?.stack;
    // The confirm names this stack's id and size, both read off the rendered PR.
    if (!info || dissolveStackNumber === null || details.isPlaceholderData)
      return;
    const count = details.data?.stackMembers.length || info.size;
    const ok = await useConfirm.getState().ask({
      title: `Dissolve stack #${info.id}?`,
      body: `Its ${count} pull requests stay open on their branches — they just stop merging together as a stack.`,
      confirmLabel: "Dissolve stack",
      confirmVariant: "destructive",
    });
    if (!ok) return;
    stackDissolve.mutate(dissolveStackNumber, {
      onSuccess: () => toast.success(`Dissolved stack #${info.id}`),
      onError,
    });
  }

  useHotkeyAction(
    "pr-stack-create",
    () => offerRef.current?.expand(),
    isSelectedPr && !details.isPlaceholderData && stackOffer?.kind === "create",
  );
  useHotkeyAction(
    "pr-stack-add",
    () => offerRef.current?.expand(),
    isSelectedPr && !details.isPlaceholderData && stackOffer?.kind === "add",
  );
  useHotkeyAction(
    "pr-stack-dissolve",
    () => void dissolveStack(),
    isSelectedPr &&
      !details.isPlaceholderData &&
      canDissolveStack &&
      !stackDissolve.isPending,
  );

  // Server truth first; the local preview only fills the gap where the forge has none.
  // An older cached row without `crossRepository` counts as not-a-fork — the backend's
  // push refuses anything but a fast-forward either way.
  const serverConflicting = serverState === "conflicting";
  // `previewEnabled` multiplies in because react-query keeps serving a disabled query's
  // last value: once a resolve pushes and the server flips off "conflicting", the stale
  // prediction would otherwise keep the banner offering Resolve on a clean PR.
  const predictedConflict =
    previewEnabled && conflictPreview.data?.status === "conflict";
  // Only a positive prediction names files; a clean/unknown/pending one names none, and
  // the banner then shows its sentence alone rather than an empty placeholder.
  const predictedFiles = predictedConflict
    ? (conflictPreview.data?.conflicts ?? [])
    : [];
  const resolveWorktree = resolve ?? findResolve.data ?? null;
  const canResolveConflicts =
    !!isOpenPr &&
    !details.data?.crossRepository &&
    (serverConflicting || predictedConflict);
  // Only a clean prediction is a claim worth making on the unreachable arm; an unknown
  // or still-running one has nothing to say. Gated like every other prediction reader.
  const predictedClean =
    previewEnabled && conflictPreview.data?.status === "clean";
  // GitHub reports a PR the base branch's rules are refusing as MERGEABLE with a
  // BLOCKED merge-state — the merge itself is clean, the rules are the refusal.
  const blockedByRules =
    provider === "github" &&
    serverState === "mergeable" &&
    mergeability.data?.detail === "BLOCKED";
  // GitLab's twin: the merge is clean and `detailed_merge_status` (or the free-form
  // `merge_error` that outranks it) names the rule refusing it. Null whenever the
  // detail names nothing worth a line, which is what keeps the arm off. Bitbucket has
  // no mergeability to interpret and is deliberately absent from both.
  const gitlabBlockedNote =
    provider === "gitlab" && serverState === "mergeable"
      ? gitlabBlockedLine(mergeability.data?.detail ?? "")
      : null;
  const behindBy = divergenceEnabled ? (divergence.data?.behindBy ?? 0) : 0;
  // Same gate as `behindBy` — a disabled divergence query keeps serving its last value,
  // and a latch left armed on one PR must never paint onto the next.
  const updatingBranch = divergenceEnabled && divergence.updating;
  // Only a click arms the word on an update, so a background divergence read can never
  // toast; the identity travels with it because a PR or lens switch retires the answer
  // rather than reporting it against whatever is on screen now.
  const awaitedUpdate = useRef<{ identity: string; base: string } | null>(null);
  const settleUpdate = useEffectEvent(() => {
    const awaited = awaitedUpdate.current;
    if (!awaited) return;
    awaitedUpdate.current = null;
    if (awaited.identity !== divergenceIdentity) return;
    // Past this line the component's repoPath/number/lens ARE the awaited PR's — they
    // are what `divergenceIdentity` is built from, and the guard above just matched it.
    if (behindBy === 0) {
      // The mutation's invalidation ran at 202-accept time, against a head that had not
      // moved yet, so details/commits/files and the checks rollup still hold the
      // pre-update read. Refresh them before the toast claims the update landed. The
      // divergence key stays out: the poll just read it, and that read is what got here.
      void Promise.all(
        prUpdateBranchKeys(repoPath, number, lens).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      // A long update spends the mergeability ladder against the UNKNOWN that GitHub
      // reports throughout, so the refetch above would land on a gave-up arm. The head
      // just moved: the question is new again, and the ladder has to start over with it.
      mergeability.retry();
      // The remote head moved, so the local repo's tracking refs and ahead/behind
      // counts are stale — the same background catch-up the merge path runs. Not
      // awaited and silent: the update already landed, and a fetch failure toast
      // would misreport it (the header's Fetch stays the manual fallback).
      void gitFetch(repoPath)
        .then(() =>
          queryClient.invalidateQueries({ queryKey: repoKeys.all(repoPath) }),
        )
        .catch(() => undefined);
      toast.success(`Branch updated from ${awaited.base}.`);
      return;
    }
    // The ladder conceded with the head still behind: GitHub's job outlived it. Say
    // where things stand rather than claiming either outcome, and DON'T invalidate or
    // restart the mergeability ladder — nothing has been observed to change, the job is
    // still running so six fresh rungs would just exhaust against UNKNOWN again, and the
    // strip's own Retry is the honest affordance. Focus and the stale windows catch the
    // eventual landing.
    toast.info(`GitHub is still updating this branch from ${awaited.base}.`);
  });
  // Runs on mount and on either dep's change, not only the transition out of updating —
  // the ref guard is what makes a run with nothing pending a no-op. Held off while the
  // divergence query is disabled: `updatingBranch` reads false there for reasons that
  // have nothing to do with the job finishing.
  useEffect(() => {
    if (updatingBranch || !divergenceEnabled) return;
    settleUpdate();
  }, [updatingBranch, divergenceEnabled]);
  // Updating the branch pushes the base onto the head, so it takes push permission —
  // and on a fork the contributor's "allow edits by maintainers" too. Only an
  // explicit denial blocks; unknown must never read as one.
  const updateBlockedReason =
    writeReason ??
    (details.data?.crossRepository && details.data.maintainerCanModify === false
      ? "The contributor hasn't allowed edits from maintainers."
      : undefined);

  // A promotion pull request: the head carries work onward (main → staging), so it is
  // permanently behind its base by design and "Update branch" would merge the base
  // back INTO it, inverting the flow. Either the head IS this repository's default
  // branch — a topology probe false-positives on stacked pull requests and
  // `allowUpdateBranch` is absent for non-push viewers, so that name comparison is the
  // whole test — or the repo's rules name it a promotion branch, which covers
  // staging → production and the upstream lens.
  //
  // `crossRepository` guards both arms: `headRefName` is UNQUALIFIED, so a fork's own
  // `main` (or its `staging`) matches by name alone. `lens === "origin"` guards only
  // the default arm, since `useDefaultBranch` reads ORIGIN's default while `details`
  // follows the lens; a configured pattern is the user's assertion about the branch
  // NAMES of this repo's fork family, so it applies on either lens by design.
  // Default wins the tie, and the kind decides only the words the copy uses.
  const promotionKind: PromotionKind = (() => {
    const head = details.data?.headRefName;
    if (!head || details.data?.crossRepository) return null;
    switch (true) {
      case lens === "origin" && head === defaultBranch.data:
        return "default";
      case isPromotionBranch(rulesConfig, head):
        return "configured";
      default:
        return null;
    }
  })();
  const promotionLike = promotionKind !== null;

  // Neither arm can fire until its input lands, so an update started in that window
  // races the demotion and inverts the flow this feature exists to protect. Every
  // entry point holds on both — the banner via `updateBusy`, the hotkey via
  // `canUpdateBranch`, and `runUpdateBranch` itself. The default-branch hold is
  // origin-only, where the comparison could change the answer; elsewhere that arm is
  // false by design. A FAILED read is deliberately not held on either: it falls open,
  // matching LocalPrView's twin, since nothing would arrive to lift the hold.
  const defaultBranchSettling = lens === "origin" && defaultBranch.isPending;

  // The banner's arm: server truth, then the local prediction where the forge has
  // none, then the resume offer — the resolve worktree is only worth its own line
  // when there's nothing more urgent to say about the merge. `updating` outranks
  // `checking` because GitHub reports mergeability UNKNOWN for the whole async update
  // window, and that arm would otherwise hide the very thing the user just started.
  // Behind-the-base and the unreachable line are the quietest of all, so they fill
  // only an arm that would otherwise stay silent.
  const bannerArm: PrMergeabilityArm = (() => {
    switch (true) {
      case !isOpenPr:
        return null;
      case serverConflicting:
        return "conflicting";
      case predictedConflict:
        return "predicted";
      case !!findResolve.data:
        return "resume";
      case updatingBranch:
        return "updating";
      case mergeability.data?.state === "checking":
        return mergeability.polling ? "checking" : "unknown";
      // A settled answer that a later read failed to refresh stays invisible; only a
      // read that never landed leaves the banner with nothing but the local prediction.
      case forgeUnreachable:
        return "unreachable";
      // Below the answer-shaped arms above only for reading order: a BLOCKED detail
      // rides a settled "mergeable" answer, which neither `checking` nor
      // `unreachable` can be true of. It does outrank `behind` — rules the base is
      // enforcing are more pressing than a base that has merely moved on.
      case blockedByRules || gitlabBlockedNote !== null:
        return "blocked";
      case behindBy > 0:
        return "behind";
      default:
        return null;
    }
  })();
  // Both halves below read `details`, which through a PR switch still serves the
  // PREVIOUS pull request — and revisiting a blocked PR serves its cached mergeability
  // synchronously, so the arm can be "blocked" while the base ref and checks belong to
  // the last one. Naming that PR's checks, or reading rules for its base, would both
  // be wrong.
  // `blockedByRules` and not merely the arm: the rules read below is a GitHub command,
  // and the arm now also fires for GitLab, which names its own reason.
  const blockedDetailsReady =
    bannerArm === "blocked" && blockedByRules && !details.isPlaceholderData;
  // The base branch's required checks, read only for the arm that names them. The
  // repoTab term is the <Activity> gate every sibling read here carries: a hidden
  // subtree still refetches, and this one would respawn `gh` on every focus regain.
  const requiredChecks = useBranchRequiredChecks(
    repoPath,
    details.data?.baseRefName ?? "",
    lens,
    repoTab === "pulls" && blockedDetailsReady,
  );
  // A failed or empty rules read leaves this empty and the line stays generic — the
  // banner never waits on the join to say that the merge is blocked.
  const blockedRequirements = blockedDetailsReady
    ? unmetRequiredChecks(
        requiredChecks.data?.contexts ?? [],
        details.data?.checks ?? [],
        providerKey,
      )
    : [];
  // Approvals ride the same read; nothing in the PR's checks could name them, so they
  // are reported as a requirement rather than joined into the unmet list.
  const blockedApprovals = blockedDetailsReady
    ? (requiredChecks.data?.requiredApprovingReviewCount ?? null)
    : null;
  // `blocked` outranks `behind` on the ladder, so a PR that is both would otherwise
  // lose every route to the update (button, caret, hotkey, palette) while the rules
  // block it: the strip's sentence changes, the affordance does not. Neither arm
  // needs an `updating` term — both sit below it. The submitting window precedes
  // the latch.
  // `promotionLike` reads placeholder-served `details` while `behindBy` comes from
  // the per-number divergence cache, so a stale render can show the old PR's
  // verdict. Redundant today (every route gates staleness itself) — kept so this
  // named predicate stays self-sufficient for the next consumer.
  const canUpdateBranch =
    (bannerArm === "behind" || (bannerArm === "blocked" && behindBy > 0)) &&
    !detailsStale &&
    !promotionLike &&
    !defaultBranchSettling &&
    !rulesSettling &&
    updateBlockedReason === undefined &&
    !updateBranch.isPending;

  /** Enter the isolated-worktree resolution: a merge that pauses there on conflicts,
   *  and just pushes when there are none. `withAi` hands the conflicts the backend
   *  just reported straight to the AI walk, so the takeover opens already working. */
  function runResolve(withAi: boolean) {
    if (details.isPlaceholderData || resolve) return;
    const info = details.data;
    if (!info) return;
    // Always route through the backend, even when `findResolve` reports a worktree: it
    // re-attaches to one for this PR+lens from live porcelain rather than a cached read
    // (and does so before any fetch, so continuing stays fast). A cached handle can be
    // stale — a just-discarded one would mount the takeover on a deleted path.
    mergeRemotePr.mutate(
      { number, base: info.baseRefName, head: info.headRefName },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "pushed") {
            toast.success(
              `No conflicts after all — merged ${info.baseRefName} and pushed`,
            );
            return;
          }
          if (outcome.worktreePath && outcome.worktreeId) {
            setResolve({
              worktreePath: outcome.worktreePath,
              worktreeId: outcome.worktreeId,
            });
            // The takeover follows this same store's `activePath`, so starting the walk
            // here makes it open each file as the AI works through it.
            if (withAi && outcome.conflicts.length > 0)
              startAll(outcome.conflicts);
            return;
          }
          // "conflicts" with no worktree to open is a broken outcome — say so rather
          // than leaving the user on an unchanged view wondering what happened.
          toast.error("Could not open the conflict resolution worktree");
        },
        onError,
      },
    );
  }

  async function discardResolve() {
    const target = resolve ?? findResolve.data;
    if (!target) return;
    if (!(await useConfirm.getState().ask(DISCARD_RESOLVE_CONFIRM))) return;
    abortRemotePrResolve.mutate(
      { worktreePath: target.worktreePath },
      {
        onSuccess: () => {
          setResolve(null);
          toast.success("Resolution discarded");
        },
        onError,
      },
    );
  }

  // Also fires on the resume arm — a leftover worktree is resumable even once the
  // server has flipped back to mergeable, and the banner offers it there.
  useHotkeyAction(
    "pr-resolve-conflicts",
    () => runResolve(false),
    isSelectedPr &&
      !details.isPlaceholderData &&
      (canResolveConflicts || resolveWorktree !== null) &&
      !resolve &&
      !mergeRemotePr.isPending,
  );

  /** Bring the head up to date with its base, on the remote. The rebase variant
   *  rewrites the head's history and force-pushes it — on a fork that branch is the
   *  contributor's — so it asks first. */
  async function runUpdateBranch(rebase: boolean) {
    if (details.isPlaceholderData) return;
    const base = details.data?.baseRefName;
    if (!base) return;
    // The one refusal rule, shared by the button, the menu item, the palette and
    // any future caller — no UI gate is the only thing between a viewer who may
    // not push (or a second click) and the mutation. It derives from the rendered
    // PR, the previous one during a switch — hence the placeholder refusal above.
    if (
      updateBlockedReason !== undefined ||
      updateBranch.isPending ||
      updatingBranch ||
      // A promotion pull request would merge the base back INTO the head. The
      // demotion has to live here too, or it is only as good as the surfaces that
      // happen to read `canUpdateBranch` — and it has to include both windows
      // where the demotion hasn't been decided yet, or a fast hotkey slips
      // through with `promotionLike` still false.
      promotionLike ||
      defaultBranchSettling ||
      rulesSettling
    )
      return;
    if (rebase) {
      const ok = await useConfirm.getState().ask({
        title: `Rebase onto ${base}?`,
        body: "Rebasing rewrites the pull request branch's history and force-pushes it. On a fork pull request, that branch belongs to the contributor.",
        confirmLabel: "Rebase and update",
      });
      if (!ok) return;
    }
    updateBranch.mutate(
      { number, rebase, lens },
      {
        // GitHub only ACCEPTED the job here, so the word goes to the poll: the strip
        // holds the updating line and `settleUpdate` speaks once a read has seen the
        // head catch up (or the ladder concede). Arming only follows a ladder that
        // actually took the request — a refused one would leave the ref waiting for a
        // poll that never runs, and fire its toast on some later visit to this PR.
        onSuccess: () => {
          if (divergence.awaitUpdate())
            awaitedUpdate.current = { identity: divergenceIdentity, base };
        },
        onError,
      },
    );
  }

  useHotkeyAction(
    "pr-update-branch",
    () => void runUpdateBranch(false),
    isSelectedPr && !details.isPlaceholderData && canUpdateBranch,
  );

  const compose = useKeyedEntityState(entityKey, "");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  // The review-thread comment pending delete-confirmation — a separate id from
  // the conversation-comment dialog above so the two dialogs never collide.
  const [deletingThreadCommentId, setDeletingThreadCommentId] = useState<
    string | null
  >(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  // The cleanup note a queued merge came back with (a head-branch deletion that
  // failed), carried on the chip's tooltip. Keyed so it can never paint onto
  // another pull request; the queue record itself lives in the store, which is
  // why the chip survives a switch away and back while this detail doesn't.
  const [queuedWarning, setQueuedWarning] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("merge");
  const [deleteBranch, setDeleteBranch] = useState(false);
  // Whether the open merge dialog is arming auto-merge (vs merging now) — set by
  // the dropdown item that opened it, read by confirmMerge + the dialog copy.
  const [mergeAuto, setMergeAuto] = useState(false);
  // Linked-issue chips on the EDIT path: the chips OWN the trailing ref block, so
  // on save the body is re-composed from the (stripped) text + the chips' refs —
  // never a raw body that would double the refs the chips already carry.
  const canLinkIssues = !!forge.data && forgeFeatureReady(forge.data, "issues");
  // Bitbucket repos have no native tracker, so a LINKED Jira project drives a
  // mention-only cluster on the edit path instead. Mutually exclusive with the
  // native cluster.
  const jiraLink = useJiraLink(repoPath);
  const canJiraMention =
    !canLinkIssues && provider === "bitbucket" && !!jiraLink.data;
  // The edit dialog's base-branch picker (seeded on each open, below). It rides
  // the dialog's local state rather than the shared form, which the issue views
  // reuse and which has no base field.
  const [editBase, setEditBase] = useState("");
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      await editPr.mutateAsync({
        number,
        title,
        // The active cluster owns the trailing ref block — re-compose from the
        // stripped text + its chips, never the raw body (that would double the refs).
        body:
          canJiraMention && jiraChips.length > 0
            ? composeBodyWithJiraRefs(body, jiraChips)
            : canLinkIssues
              ? composeBodyWithRefs(body, linkedIssues)
              : body,
        // Retarget only when the picker actually moved: an unchanged base is
        // still a forge write, and GitHub rejects one on a stacked PR.
        base:
          editBase && editBase !== details.data?.baseRefName
            ? editBase
            : undefined,
      });
    },
    successToast: "Pull request updated",
  });
  // Local branches for the base picker, fetched only while the dialog is open.
  // The PR's current base is force-kept: it may be archived, or (fork/upstream
  // lens) have no local branch at all, and it must stay displayable either way.
  const { items: branchItems, annotations: branchAnnotations } =
    useBranchPickerOptions(repoPath, edit.open, [
      details.data?.baseRefName,
      defaultBranch.data,
    ]);
  const currentBase = details.data?.baseRefName ?? "";
  const baseItems =
    currentBase && !(currentBase in branchItems)
      ? { [currentBase]: currentBase, ...branchItems }
      : branchItems;
  // Shared chip state machine — enabled only while the edit dialog is open. The
  // body's own trailing refs are peeled into chips at open (`resetWith` in
  // openEdit), so body text and chips are never two sources of truth.
  const {
    chips: linkedIssues,
    resetWith: resetLinkedIssues,
    toggleKeyword: toggleIssueKeyword,
    remove: removeIssue,
    pick: pickIssue,
    buildCandidates: buildIssueCandidates,
    upsertFromDraft: upsertAiIssues,
  } = useLinkedIssueChips({
    repoPath,
    lens,
    enabled: canLinkIssues && edit.open,
    headBranch: details.data?.headRefName ?? null,
    commitSubjects: details.data?.commits.map((c) => c.headline) ?? [],
  });
  // Jira mention chips — the Bitbucket-only sibling cluster on the edit path.
  const {
    chips: jiraChips,
    resetWith: resetJiraChips,
    remove: removeJiraChip,
    pick: pickJiraChip,
    buildCandidates: buildJiraCandidates,
    upsertFromDraft: upsertAiJira,
  } = useJiraMentionChips({
    repoPath,
    enabled: canJiraMention && edit.open,
    headBranch: details.data?.headRefName ?? null,
    commitSubjects: details.data?.commits.map((c) => c.headline) ?? [],
    link: jiraLink.data ?? null,
  });
  const prGen = useGeneratePrDescription(repoPath);
  const composerRef = useRef<MarkdownEditorHandle>(null);
  // The generate-commit-message binding's title suffix. The chord itself lives in
  // EditTitleBodyDialog; this is only the label, so a rebinding drives both.
  const generateHint = useGenerateChordHint();

  const onError = (e: unknown) => toastError(e);

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) => {
    // Every quotable body — the description and each rendered comment — belongs to
    // the PR on screen, which mid-switch is the previous one, while the draft it
    // would land in is keyed to the new one.
    if (details.isPlaceholderData) return;
    makeQuoteReply({ composerRef, setBody: compose.set })(body);
  };

  // GitLab + Bitbucket approve/unapprove — one toggle keyed on whether the viewer
  // approved. GitLab's `user_can_approve` is unreliable on Free (false even when
  // approving works), so don't pre-disable; permission errors surface via toast.
  // The approval status lives in a SEPARATE query, so flip it optimistically —
  // otherwise the label lags a full approve-POST + refetch. Success invalidation
  // reconciles; errors roll back.
  async function toggleApproval() {
    if (details.isPlaceholderData) return;
    const approved = approvals.data?.viewerHasApproved ?? false;
    const action = approved ? unapprovePr : approvePr;
    // Must mirror usePrApprovals' key exactly — its lens segment is always the
    // literal "origin"; a mismatch makes this optimistic flip a no-op.
    const key = [
      "repo",
      repoPath,
      "pr",
      "origin",
      number,
      "approvals",
    ] as const;
    // Cancel any in-flight approvals refetch first — otherwise it can resolve
    // AFTER this optimistic flip and silently revert the click (the approval
    // state lives in a separate query, so nothing else guards it).
    await queryClient.cancelQueries({ queryKey: key });
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

  // Request changes — a true toggle on Bitbucket (revoke works on every plan);
  // one-shot on GitLab (the direct undo is Premium-only; approving clears it). Same
  // optimistic flip as the approve toggle — the state lives in the separate
  // approvals query.
  async function requestChanges() {
    if (details.isPlaceholderData) return;
    const requested = approvals.data?.viewerRequestedChanges ?? false;
    // Already requested on GitLab: the button is a focusable state indicator
    // (its title says how to clear); a re-click must not fire the Premium-only
    // undo path. Bitbucket falls through to the revoke below.
    if (requested && !canUnrequestChanges) return;
    // Same as toggleApproval: mirror usePrApprovals' literal "origin" lens segment.
    const key = [
      "repo",
      repoPath,
      "pr",
      "origin",
      number,
      "approvals",
    ] as const;
    // Same guard as toggleApproval: cancel an in-flight approvals refetch so it
    // can't land after the optimistic flip and revert it.
    await queryClient.cancelQueries({ queryKey: key });
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
    const submittedFor = entityKey;
    requestChangesPr.mutate(
      { number, body: compose.value.trim() },
      {
        onSuccess: () => {
          toast.success("Requested changes");
          compose.clearFor(submittedFor);
        },
        onError: (e) => {
          if (prev) queryClient.setQueryData(key, prev);
          onError(e);
        },
      },
    );
  }

  function submitComment() {
    const body = compose.value.trim();
    if (!body || details.isPlaceholderData) return;
    // Clear the draft immediately (the perceived-speed win) and append the
    // synthetic comment optimistically; on error restore the draft, but only if
    // that PR's composer is still empty so we never clobber newly-typed text.
    const submittedFor = entityKey;
    compose.set("");
    comment.mutate(
      { number, body, author: forge.data?.login ?? "You" },
      {
        onSuccess: () => toast.success("Comment added"),
        onError: (e) => {
          compose.setFor(submittedFor, (prev) => (prev.trim() ? prev : body));
          onError(e);
        },
      },
    );
  }

  // A typed draft rides Close/Reopen rather than being discarded by them. Gated
  // on `canComment` so the labels below never promise a comment the provider
  // won't take.
  const draftRidesStateChange = canComment && !!compose.value.trim();

  /** Posts the riding draft ahead of a state change. False means the comment
   *  failed and the state change is abandoned: the draft stays put for a retry,
   *  so a lost note can never be the price of a failed close. */
  async function postRidingDraft(): Promise<boolean> {
    if (!draftRidesStateChange) return true;
    const body = compose.value.trim();
    const submittedFor = entityKey;
    try {
      await comment.mutateAsync({
        number,
        body,
        author: forge.data?.login ?? "You",
      });
      // Only a landed comment clears the draft.
      compose.clearFor(submittedFor);
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  async function doClose() {
    // Re-checked in the handler: the footer disables on the same hold, but a
    // click can land across a selection switch before the disable repaints.
    if (busy || triageBlocked) return;
    // Captured before the await: posting clears the draft, and the error arm
    // below has to know a comment already went out.
    const withComment = draftRidesStateChange;
    // Ahead of the riding draft: a cancelled confirm must leave the comment
    // unposted.
    const ok = await useConfirm.getState().ask({
      title: `Close ${prNoun} #${number}?`,
      body: `Everyone watching is notified and the ${prNoun} leaves the open list. Reopening puts it back, but the notification can't be unsent.${
        withComment ? " Your draft posts as a comment first." : ""
      }`,
      confirmLabel: withComment ? "Close with comment" : `Close ${prNoun}`,
    });
    if (!ok) return;
    if (!(await postRidingDraft())) return;
    closePr.mutate(number, {
      // The riding comment posts through `mutateAsync`, which skips the
      // "Comment added" toast the ordinary submit gets, so the confirmation
      // here has to account for both writes.
      onSuccess: () =>
        toast.success(
          withComment
            ? `Closed #${number} and posted your comment`
            : `Closed #${number}`,
        ),
      onError: (e) =>
        withComment
          ? toastErrorWithNote(
              e,
              "Your comment was posted, but closing failed — try Close again.",
            )
          : onError(e),
    });
  }

  async function doReopen() {
    if (busy || triageBlocked) return;
    const withComment = draftRidesStateChange;
    if (!(await postRidingDraft())) return;
    reopenPr.mutate(number, {
      onSuccess: () =>
        toast.success(
          withComment
            ? `Reopened #${number} and posted your comment`
            : `Reopened #${number}`,
        ),
      onError: (e) =>
        withComment
          ? toastErrorWithNote(
              e,
              "Your comment was posted, but reopening failed — try Reopen again.",
            )
          : onError(e),
    });
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
        onSuccess: (outcome) => {
          // A queued merge was accepted but hasn't landed, so announce the state
          // once — mirroring the auto-merge arm — instead of a "Merged" success
          // that the queue detail would immediately contradict.
          if (outcome.queued) {
            toast.success(
              outcome.cleanupWarning ?? `Merge queued for #${number}`,
            );
            // The toast is gone in seconds and nothing fetchable carries queue
            // state, so record it: the chip below is the only lasting sign the
            // merge is waiting rather than done.
            markMergeQueued(queuedKey);
            setQueuedWarning(
              outcome.cleanupWarning
                ? { key: queuedKey, text: outcome.cleanupWarning }
                : null,
            );
          } else {
            toast.success(`Merged #${number}`);
            // Merged for real; a cleanupWarning here means only the post-merge
            // remote head-branch deletion failed. Surface it as a (non-error)
            // warning so the successful merge isn't dressed up as a failure.
            if (outcome.cleanupWarning) {
              toast.warning(outcome.cleanupWarning, { duration: 10000 });
            }
          }
          setMergeOpen(false);
        },
        onError: (e) => {
          // Where the rules are the known reason, say which requirement is unmet
          // alongside the refusal — the same line the strip is already showing, and
          // on GitLab the only place the reason is worded at all (the backend's
          // message deliberately doesn't duplicate this table).
          if (bannerArm === "blocked")
            toastErrorWithNote(
              e,
              gitlabBlockedNote ??
                blockedMergeLine(blockedRequirements, blockedApprovals),
            );
          else onError(e);
          setMergeOpen(false);
        },
      },
    );
  }

  const pr = details.data;
  // An in-app Mark-ready fires its own pr-open review: the catch-up poller only
  // covers PRs inside its 14-day window (sync.ts), so a long-lived draft readied here
  // would otherwise never get a first review. Gated by `prOpenEligible` — the SAME
  // eligibility the external catch-up path enforces, so both paths behave identically.
  // That guard, not claim dedup, is what prevents a double review: a manual panel
  // review saves via `saveReview` WITHOUT taking an automation claim, so claim dedup
  // can't see it. Event shape mirrors sync.ts; the marker-comment lift recovers
  // reviewer notes, so none ride the event.
  async function fireReadyReview() {
    if (!pr) return;
    const headSha = pr.commits.at(-1)?.oid;
    if (!(await prOpenEligible(repoPath, String(number), headSha ?? "")))
      return;
    triggerAutomations({
      kind: "pr-open",
      repoPath,
      base: pr.baseRefName,
      head: pr.headRefName,
      // gh GraphQL returns commits oldest-first, so the head is the last.
      headSha,
      title: pr.title,
      // No body/commit subjects on this path — the PR diff is the source of
      // truth (catch-up + pr-sync fire them empty the same way).
      body: "",
      commitSubjects: [],
      target: { type: "remote", number },
    });
  }
  // One derivation of which review owns which line-comment threads, shared by the
  // feed and the residual block below it.
  const threadClaims = usePrThreadClaims(pr, reviewThreads.data);
  // Guards for the merge dialog's "delete head branch on the remote" checkbox:
  // every forge refuses to delete the DEFAULT branch (so the option is hidden),
  // and a local branch RULE can block deleting the head (so it's disabled with a
  // reason, mirroring the switcher's Delete menu item). Name-keyed against this
  // repo's default — the common same-repo case; a fork PR whose head is
  // coincidentally named like our default is an accepted v1 over-hide — which is
  // why this stays the bare comparison and NOT `promotionLike`, whose same-repo
  // term exists to refuse exactly that match.
  const headIsDefault =
    pr != null &&
    defaultBranch.data != null &&
    pr.headRefName === defaultBranch.data;
  const headDeletionBlocked =
    pr != null && isDeletionBlocked(rulesConfig, pr.headRefName);
  // Branch rules load async, so `headDeletionBlocked` can flip true after the user
  // already ticked "delete branch" — drop the choice then. The dialog's own `checked`
  // override already keeps the render correct; this keeps the underlying state honest
  // (it can't linger stale-true behind the now-disabled checkbox).
  useEffect(() => {
    if (headDeletionBlocked) setDeleteBranch(false);
  }, [headDeletionBlocked]);
  const fileSections = useMemo(
    () => splitUnifiedDiff(prDiff.data ?? ""),
    [prDiff.data],
  );

  // Reset per-PR view state when a different PR is shown — a render-time state
  // adjustment, not an effect. Keyed on the lens-bearing identity, not the number:
  // a lens flip under a mounted view is a different repo's PR at the same number.
  // The same identity re-keys the metadata pickers, whose drafts live inside them.
  const [lastEntity, setLastEntity] = useState(entityKey);
  if (entityKey !== lastEntity) {
    setLastEntity(entityKey);
    setSelectedPath(null);
    setSelectedCommitOid(null);
    // Everything below is bound to the PR it was opened on — the conflict-resolution
    // takeover, the dialogs and confirmations — so a different PR must inherit
    // none of it.
    setResolve(null);
    setDeletingCommentId(null);
    setDeletingThreadCommentId(null);
    setSubmitOpen(false);
    setDiscardConfirmOpen(false);
    setMergeOpen(false);
    setMergeAuto(false);
    setMergeStrategy("merge");
    setDeleteBranch(false);
    edit.setOpen(false);
  }
  // The edit dialog's in-flight generation belongs to the PR it was started on; the
  // cancel is imperative, so it rides an effect rather than the block above.
  useCancelOnIdentityChange(entityKey, prGen.cancel);
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

  // GitHub-only: when every one of the three merge methods is disabled by the repo's
  // settings or by a GitDesktop branch rule, a menu of all-disabled items is useless
  // — disable the Merge trigger itself with an explanation. `null`/unknown server
  // flags never count as disabled, so a failed settings fetch can't trip it.
  // GitLab/Bitbucket gate their methods elsewhere.
  const allMergeMethodsBlocked =
    pr != null &&
    provider !== "gitlab" &&
    provider !== "bitbucket" &&
    (["merge", "squash", "rebase"] as const).every(
      (s) =>
        isServerMergeDisabled(pr, s) ||
        !isMergeMethodAllowed(rulesConfig, pr.baseRefName, s),
    );

  // Auto-merge derived state (GitLab-only). The arm affordance shows only while the
  // head pipeline is in flight; the footer indicator shows once armed. Both classify
  // the pipeline status against the same shared in-flight set as the poll.
  const pipelineInFlight = (PIPELINE_IN_FLIGHT as readonly string[]).includes(
    mergeState.data?.pipelineStatus ?? "",
  );
  const autoMergeArmed = mergeState.data?.autoMergeEnabled ?? false;
  // What a stacked merge lands beyond the PR on screen — null when this PR is
  // unstacked or everything below it already merged, leaving today's copy right.
  // Known stacks gate on the stack's own id, not the detected provider: forge
  // status can be pending or failed here (canMerge deliberately stays on then),
  // which would otherwise drop the disclosure on GitHub and invent one on GitLab.
  // `hostCascades` is the unknown arm's fallback — no stack, so no id to read.
  const stackMerge = stackMergeDisclosure({
    stack: pr?.stack,
    members: pr?.stackMembers,
    stackUnknown: pr?.stackUnknown ?? false,
    prNoun,
    atomic: isNativeStack(pr?.stack),
    hostCascades: providerKey === "github",
  });

  // Approval display (GitLab + Bitbucket): a quiet count shown only when there's
  // something to report — someone approved, or a GitLab Premium project requires
  // N approvals.
  const approval = approvals.data;
  const approvalNote =
    approval &&
    (approval.approvalsRequired > 0 || approval.approvedBy.length > 0)
      ? approval.approvalsRequired > 0
        ? `${approval.approvedBy.length} of ${approval.approvalsRequired} approvals`
        : `${approval.approvedBy.length} approval${approval.approvedBy.length === 1 ? "" : "s"}`
      : null;
  // What a control that holds through the switch says, in one wording. It ranks
  // BELOW any permission or read-error reason wherever both hold: those never
  // lift on their own and are the ones still true once the switch lands.
  const staleReason = detailsStale ? PR_SWITCH_LOADING_REASON : undefined;
  // Which term of `busy` the composer names, ranked: the switch window outranks a
  // write the viewer started, being the hold they can't have caused themselves.
  const composerReason = (() => {
    switch (true) {
      case detailsStale:
        return staleReason;
      case comment.isPending:
        return "Posting your comment…";
      case mergePr.isPending:
        return `Merging this ${prNoun}…`;
      case closePr.isPending:
        return `Closing this ${prNoun}…`;
      case reopenPr.isPending:
        return `Reopening this ${prNoun}…`;
      case approvePr.isPending:
        return "Submitting your approval…";
      case unapprovePr.isPending:
        return "Revoking your approval…";
      case requestChangesPr.isPending:
        return "Requesting changes…";
      case unrequestChangesPr.isPending:
        return "Revoking your change request…";
      case armAutoMerge.isPending:
        return "Enabling auto-merge…";
      case cancelAutoMerge.isPending:
        return "Canceling auto-merge…";
      case setDraft.isPending:
        return "Updating draft status…";
      default:
        return undefined;
    }
  })();
  // The metadata pickers seed from the rendered PR and commit the WHOLE set on
  // close, so one opened mid-switch would write the previous PR's members under
  // the new number. Their triggers disable on a reason, so this rides that seam.
  const pickerReason = triageReason ?? staleReason;
  // A review notification's click-through, taken over from the store only once
  // the rendered details are THIS pull request's: a scroll fired against
  // placeholder rows lands on another PR's cards. The Conversation feed owns the
  // anchors, so the handoff waits for that sub-tab too — the hinted tab arrives
  // through `pendingPrSection` in its own commit.
  //
  // Details alone aren't enough: threads decide which reviews claim inline
  // blocks and the timeline interleaves rows ABOVE the target, so either landing
  // afterwards would push a scrolled-to card back off screen. Waiting for all
  // three to settle (an ERROR settles too — the feed renders what it has) keeps
  // this to one attempt against the finished layout. A DISABLED timeline (no
  // provider resolved yet) is neither, so the reveal waits and fires once the
  // probe answers; if it never does, the request simply lapses.
  const revealInputsSettled =
    details.isSuccess &&
    !detailsStale &&
    (reviewThreads.isSuccess || reviewThreads.isError) &&
    (timeline.isSuccess || timeline.isError);
  useEffect(() => {
    if (pendingReviewId === null || !isSelectedPr) return;
    if (!revealInputsSettled || section !== "conversation") return;
    setRevealReviewId(pendingReviewId);
    setPendingReviewId(null);
  }, [
    pendingReviewId,
    setPendingReviewId,
    isSelectedPr,
    revealInputsSettled,
    section,
  ]);
  // Exactly one attempt. Child layout effects run before this one, so the target
  // row has already scrolled itself if it rendered; a review with no visible body
  // and no state renders no row at all, and dropping the request is the fail-soft
  // there — never a retry loop or a jump to the top of the feed.
  useLayoutEffect(() => {
    if (revealReviewId !== null) setRevealReviewId(null);
  }, [revealReviewId]);

  // The palette's route to the comment box. Every term the composer itself is
  // gated on rides here too, so the action is offered only where there is a box
  // to focus: a resolve takes the whole view over, and the other sub-tabs have
  // no composer.
  useHotkeyAction(
    "focus-comment",
    () => composerRef.current?.focus(),
    isSelectedPr &&
      canComment &&
      section === "conversation" &&
      !resolve &&
      !!pr &&
      !details.isPlaceholderData &&
      !details.isError,
  );

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
    // Offline, deleted, access lost — the class isn't knowable here, so the headline
    // claims only what is: which host the read was aimed at. Naming one class would
    // demote the true reason to the summary beneath. The host goes unnamed when its
    // own probe hasn't answered, rather than guessed.
    const loadFailed = provider
      ? `Couldn't load this ${prNoun} from ${remoteLabel}.`
      : `Couldn't load this ${prNoun} from the remote.`;
    const errorSummary = details.error
      ? presentError(details.error).summary
      : null;
    return (
      <DiffPlaceholder
        message={details.isError ? loadFailed : `Could not load this ${prNoun}`}
        action={
          details.isError ? (
            <div className="flex flex-col items-center gap-2">
              {/* The headline can't name the failure class, so the real reason —
                  offline, deleted, no access — lives here. */}
              {errorSummary ? (
                <p className="max-w-md text-center text-xs">{errorSummary}</p>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={details.isFetching}
                onClick={() => details.refetch()}
              >
                {details.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : undefined
        }
      />
    );
  }

  // Open the Edit dialog: the chips OWN the trailing ref block, so peel any exact
  // `Closes #N` / `Relates to #N` lines off the body into chips (keyword preserved)
  // and open the editor with the STRIPPED text; on save it's re-appended from chips.
  // No tracker ⇒ no chips, open the raw body. `prForGen` aliases the narrowed `pr`
  // because TS doesn't carry the outer `!pr` guard into these hoisted closures.
  const prForGen = pr;
  function openEditWithChips() {
    // Every seed below is read off the rendered PR, which is the previous one
    // during a switch — an edit opened then would carry its title and body.
    if (detailsStale) return;
    // Seed the base picker from the PR as it stands, so a re-open never carries
    // a previous session's unsaved pick.
    setEditBase(prForGen.baseRefName);
    if (canLinkIssues) {
      // Native active: numeric refs → chips; any trailing Jira line rides back in
      // `text` so an unedited save can't drop it.
      const { text, refs } = splitBodyRefBlock(prForGen.body, "native");
      edit.openEdit({ title: prForGen.title, body: text });
      resetLinkedIssues(refs);
    } else if (canJiraMention) {
      // Jira active: mention keys → chips; any trailing numeric line rides back in
      // `text` (mirror preservation).
      const { text, jiraRefs } = splitBodyRefBlock(prForGen.body, "jira");
      edit.openEdit({ title: prForGen.title, body: text });
      resetJiraChips(jiraRefs);
    } else {
      edit.openEdit({ title: prForGen.title, body: prForGen.body });
    }
  }

  // AI title+description generation — shared by the Edit dialog's Generate button
  // and its mod+g chord.
  function runGenerate() {
    prGen.generateFromDiff(
      // Reuse the diff already cached by usePrDiff — and, crucially,
      // resolve it from the PR's own diff (not local base..head refs),
      // so this works for fork PRs / unfetched head branches.
      async (settings) => {
        const [text, exclude] = await Promise.all([
          queryClient.ensureQueryData(prDiffOptions(repoPath, number, lens)),
          aiExcludePatterns(repoPath, settings.aiIgnorePatterns),
        ]);
        const files = prForGen.files.map((f) => ({
          path: f.path,
          added: f.additions,
          deleted: f.deletions,
          isBinary: false,
        }));
        // A forge-supplied diff arrives whole, so it is filtered client-side.
        // NEVER write the result back into the query cache: the same string
        // feeds the Files tab, the review threads and the AI review panel, all
        // of which want the full diff.
        const hidden = await filterDiffByAiIgnore({
          repoPath,
          text,
          files,
          exclude,
        });
        return {
          text: hidden.text,
          truncated: false,
          files: hidden.files,
          excludedFiles: hidden.excludedFiles,
        };
      },
      prForGen.baseRefName,
      prForGen.headRefName,
      prForGen.commits.map((c) => c.headline),
      (d) => {
        edit.form.setFieldValue("title", d.title);
        edit.form.setFieldValue("body", d.body);
        // Union the model's proposed issue links into the chip cluster (same
        // rules as create — relate-default, dismissed-set, AI sparkle).
        upsertAiIssues({ closes: d.closes, relates: d.relates });
        // Union the model's proposed Jira mentions into the mention cluster.
        upsertAiJira({ jiraMentions: d.jiraMentions });
      },
      // Provider-aware prompt copy; null host → base GitHub wording.
      provider ?? undefined,
      // Labels and reviewer notes aren't part of the edit path — no proposed labels.
      [],
      undefined,
      // Grounded issue candidates — chips pinned first, then top-ranked open
      // issues (empty ⇒ the prompt's issue-reference ban stays intact).
      buildIssueCandidates(),
      // Grounded Jira mention candidates (Bitbucket + linked project); empty
      // unless the Jira cluster is active.
      canJiraMention ? buildJiraCandidates() : undefined,
    );
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

  // The pane keeps rendering the previous PR's diff through a switch, so its lines
  // can belong to another PR than the `number` a new thread would be created under.
  const diffStale = detailsStale || prDiff.isPlaceholderData;
  // The inline line-comment composer for the Files tab: only when the provider allows
  // creating a thread, anchored to the selected file (its section prefills a
  // suggestion's code). Absent otherwise ⇒ read-only diff.
  const reviewLineWidget: LineWidget | undefined =
    canCreateThread && effectivePath && !diffStale
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
              lens={lens}
              onClose={onClose}
            />
          ),
        }
      : undefined;

  // Gating inputs + the write for the per-suggestion Apply, shared by the
  // Conversation thread block and the Files-tab anchors. `onApply` supplies
  // `stageWhenClean: true` (SuggestionApply's arg omits it) so a clean file is staged
  // like GitHub's "Commit suggestion".
  const suggestionApply: SuggestionApply = {
    headRefName: pr.headRefName,
    currentBranch: repoStatus.data?.branch?.name ?? null,
    onApply: (a) => applySuggestion.mutateAsync({ ...a, stageWhenClean: true }),
  };

  const isOpen = pr.state === "OPEN";
  // GitHub owns a native stack's bases — retargeting one out from under the stack
  // is rejected, so the edit dialog's picker says why instead of letting the save
  // fail. An inferred (GitLab) chain or an unknown stack stays editable:
  // retargeting mid-chain is legitimate there and the server arbitrates.
  const baseLockedNote =
    pr.stack && isNativeStack(pr.stack)
      ? `Part of stack #${pr.stack.id} — dissolve the stack to change the base branch.`
      : null;
  // Split reviewers so the editable picker only ever manages humans: bot requests
  // (e.g. GitHub Copilot) are display-only chips and must never ride through the
  // popover's onChange as a desired reviewer. GitLab/Bitbucket never set isBot.
  const humanReviewers = pr.reviewers.filter((r) => !r.isBot);
  const botReviewers = pr.reviewers.filter((r) => r.isBot);
  // Completed reviewers — those who already submitted a verdict: they leave gh's
  // `reviewRequests` (so they're gone from `pr.reviewers`) but their review stays in
  // `pr.reviews`. GitHub's own sidebar keeps showing them with their state. A plain
  // derivation, not a hook — this is past the component's early returns.
  const completedReviewers = [
    ...deriveCompletedReviewers(pr.reviews, pr.reviewers),
    ...pr.completedReviewers.map((cr) => ({
      login: cr.user.id,
      label: cr.user.label,
      isBot: cr.user.isBot,
      avatarUrl: cr.user.avatarUrl,
      state: cr.state.toUpperCase(),
    })),
  ];
  // Logins that already render as completed chips. For GitLab/Bitbucket an acted
  // reviewer stays in `pr.reviewers` (the full assigned set — the picker preserves
  // them on save) AND appears in `pr.completedReviewers`, so the read-only pending
  // list filters these out to avoid a duplicate pending+completed chip. GitHub never
  // overlaps (its completed reviewers have already left `pr.reviewers`).
  const completedLogins = new Set(completedReviewers.map((c) => c.login));
  function saveCommentEdit(commentId: string, body: string) {
    // The comment id is the rendered PR's while the write addresses `number` —
    // GitLab routes by both, so a mismatched pair edits nothing it showed.
    if (detailsStale) return;
    editComment.mutate(
      { number, commentId, body },
      {
        onSuccess: () => toast.success("Comment updated"),
        onError,
      },
    );
  }

  function saveThreadCommentEdit(commentId: string, body: string) {
    // Same pairing as saveCommentEdit, on the review-thread side.
    if (detailsStale) return;
    editReviewComment.mutate(
      { number, commentId, body },
      {
        onSuccess: () => toast.success("Comment updated"),
        onError,
      },
    );
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    // The subject is the rendered PR's body or one of its comments, while the
    // write and its optimistic patch address `number` — GitLab routes by both, so
    // a mismatched pair awards the wrong note or 404s. The bars disable on the
    // same flag; this arm is the belt-and-braces behind them.
    if (detailsStale) return;
    toggleReactionMutation.mutate({ subjectId, content, active }, { onError });
  }

  // Both take a comment id off the RENDERED pr, which through a switch is the
  // previous one, so either would hide a comment on the PR the viewer just left.
  // The menu items disable on the same wait; these arms back them up.
  function hideComment(commentId: string, classifier: MinimizeReason) {
    if (detailsStale) return;
    minimizeComment.mutate(
      { commentId, classifier },
      { onSuccess: () => toast.success("Comment hidden"), onError },
    );
  }

  function unhideComment(commentId: string) {
    if (detailsStale) return;
    unminimizeComment.mutate(commentId, {
      onSuccess: () => toast.success("Comment shown"),
      onError,
    });
  }

  // A conflict resolution in flight takes over the whole PR view: the merge lives in
  // an isolated worktree, and ResolveRemotePrView drives its file list, editor and
  // Finish/Discard in place of the PR's normal sections and footer.
  if (resolve) {
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
            <Badge variant="secondary" className="capitalize">
              {pr.state.toLowerCase()}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{pr.headRefName}</span>
            <span>→</span>
            <span className="font-mono">{pr.baseRefName}</span>
          </div>
        </header>
        <ResolveRemotePrView
          repoPath={repoPath}
          head={pr.headRefName}
          base={pr.baseRefName}
          worktreePath={resolve.worktreePath}
          worktreeId={resolve.worktreeId}
          lens={lens}
          onDone={() => setResolve(null)}
        />
      </div>
    );
  }

  // The Merge control's state. Hoisted because the refusal has to sit on the
  // wrapping span while `disabled` sits on the trigger — a disabled trigger is
  // what actually keeps the menu (and with it an unguarded merge) shut.
  const mergeBlocked =
    busy ||
    writeBlocked ||
    pr.isDraft ||
    mergeGuardMissing ||
    allMergeMethodsBlocked;
  // Permission outranks the availability hints: a viewer who can't push can't
  // act on any of them. The wait outranks them in turn — every hint below reads
  // the RENDERED pr, which through a switch is the previous one, so each would
  // describe a pull request the viewer didn't pick.
  const mergeReason =
    writeReason ??
    staleReason ??
    (pr.isDraft
      ? `Mark the ${prNoun} ready before merging`
      : mergeGuardMissing
        ? "Reload to merge — couldn't load the head commit to guard the merge"
        : allMergeMethodsBlocked
          ? "No merge method is enabled by both this repository's settings and its branch rules"
          : `Merge this ${prNoun}`);

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
              // A status, not an action — no button role and no tab stop.
              // role="img" prunes the icon AND the wording, so the label states
              // the whole thing on its own.
              <span
                role="img"
                aria-label={`Checked out — ${pr.headRefName} is the current branch`}
                title={`${pr.headRefName} is the current branch`}
                className="inline-flex h-6 shrink-0 items-center gap-1 border border-border bg-background pr-2 pl-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground"
              >
                <CheckCircleIcon className="size-3" aria-hidden />
                Checked out
              </span>
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
            // A natively-disabled Button swallows its own `title`, so the wait
            // needs the reason prop to reach the viewer at all.
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={detailsStale}
              reason={staleReason}
              onClick={openEditWithChips}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </DisabledReasonButton>
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
          <span>{displayLogin(pr.author)}</span>
          <span>•</span>
          <span className="font-mono">{pr.headRefName}</span>
          <span>→</span>
          <span className="font-mono">{pr.baseRefName}</span>
          <DiffStat
            added={pr.additions}
            deleted={pr.deletions}
            className="flex items-center gap-2"
          />
        </div>
        {/* Entity-keyed pickers — labels, assignees, projects, reviewers: each
            seeds a draft on open, commits it on close against LIVE props, and a
            keyboard PR switch leaves the popover open; unkeyed, the old draft
            lands on the new PR. Projects is the exception to the commit clause:
            its memberships come from a query rather than props, so its close
            diffs the draft against the set SEEDED at open (or at the first settle
            after it), never the live one — live items serve only as the item-id
            lookup for unlinks.
            Labels/assignees/projects prefix keys as SIBLINGS: duplicate keys in
            one children array make React drop the earlier duplicates' unmount,
            leaking stale rows. Reviewers' prefix is consistency: own wrapper div. */}
        {isOpen && canEditLabels ? (
          <LabelsPopover
            key={`labels-${entityKey}`}
            repoPath={repoPath}
            enabled
            number={number}
            target="mr"
            labelableId={pr.id}
            labels={pr.labels}
            lens={lens}
            disabledReason={pickerReason}
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
        {/* Assignee picker (GitHub + GitLab). A closed/merged PR falls back to
            read-only chips, like the labels row. */}
        {isOpen && canEditAssignees ? (
          <AssigneesPopover
            key={`assignees-${entityKey}`}
            repoPath={repoPath}
            enabled
            value={pr.assignees}
            commitOnClose
            lens={lens}
            disabledReason={pickerReason}
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
        {/* GitHub Projects membership (GitHub-only). Unlike labels/assignees it has
            no read-only fallback: its chips come from their own query rather than
            from `pr`, so a closed PR would pay a fetch to show them. */}
        {isOpen && providerKey === "github" ? (
          <ProjectsPopover
            key={`projects-${entityKey}`}
            repoPath={repoPath}
            enabled
            kind="pr"
            number={number}
            contentId={pr.id}
            lens={lens}
            disabledReason={pickerReason}
          />
        ) : null}
        {/* Reviewers picker (all three providers). A closed/merged PR falls back to
            read-only chips. Bot requests (e.g. Copilot) are display-only and split out
            here so the popover's onChange — which emits its `value` as the desired
            set — can never ride a bot through. */}
        {isOpen && canEditReviewers ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <ReviewersPopover
              key={`reviewers-${entityKey}`}
              repoPath={repoPath}
              number={number}
              enabled
              value={humanReviewers}
              lens={lens}
              disabledReason={pickerReason}
              onChange={(next) =>
                setReviewers.mutate(
                  { number, reviewers: next },
                  { onError: toastError },
                )
              }
            />
            {botReviewers.map((user) => (
              <BotReviewerChip key={user.id} user={user} ghHost={ghHost} />
            ))}
            {completedReviewers.map((reviewer) => (
              <CompletedReviewerChip
                key={reviewer.login}
                reviewer={reviewer}
                ghHost={ghHost}
              />
            ))}
          </div>
        ) : (
          (pr.reviewers.length > 0 || completedReviewers.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {humanReviewers
                .filter((h) => !completedLogins.has(h.id))
                .map((user) => {
                  const hint = userRefHint(user, humanReviewers);
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
              {botReviewers.map((user) => (
                <BotReviewerChip key={user.id} user={user} ghHost={ghHost} />
              ))}
              {completedReviewers.map((reviewer) => (
                <CompletedReviewerChip
                  key={reviewer.login}
                  reviewer={reviewer}
                  ghHost={ghHost}
                />
              ))}
            </div>
          )
        )}
        {/* GitLab-only time-tracking summary; a popover with estimate/add-spent
            while the MR is open, static once closed. */}
        {canTrackTime && (
          <MrTimeTracking
            repoPath={repoPath}
            number={number}
            open={isOpen}
            // No stale arm, unlike the pickers beside it: the stats query carries
            // no placeholder and the write payload is what the viewer typed, both
            // keyed by `number` — only `open` above reads the rendered MR's state.
            disabledReason={triageReason}
          />
        )}
        {/* Bitbucket-only PR-tasks chip — quiet until there are unresolved tasks;
            jumps to the Tasks section. Same usePrTasks query as the section. */}
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
        {/* Stack members, bottom-first — self-hiding for an unstacked PR, so an
            unstacked header is unchanged. Mutually exclusive with the offer
            below it: an offer only exists while this PR is unstacked. */}
        <StackSection
          stack={pr.stack}
          members={pr.stackMembers}
          currentNumber={number}
          onSelect={(n) => selectPr({ kind: "remote", id: String(n) })}
          onDissolve={canDissolveStack ? dissolveStack : undefined}
          dissolving={stackDissolve.isPending}
          // `dissolveStack` refuses while the rendered stack is the previous PR's,
          // so hold its control — without the spinner a real write would show.
          disabled={detailsStale}
        />
        {stackOffer && (
          <StackOffer
            ref={offerRef}
            offer={stackOffer}
            rows={offerRows}
            pending={stackCreate.isPending || stackAdd.isPending}
            // Unreachable while stale — no offer exists then — so this is the
            // rendered twin of `confirmStackOffer`'s insurance arm, not a live gate.
            disabled={detailsStale}
            error={
              stackWriteError ? presentError(stackWriteError).summary : null
            }
            onConfirm={confirmStackOffer}
            onCancel={cancelStackOffer}
          />
        )}
        {/* Sits where the offer would, and only when there is none — plain text in
            flow, so the absence explains itself instead of reading as a dead slot. */}
        {stackOfferNote ? (
          <p className="text-xs text-muted-foreground">{stackOfferNote}</p>
        ) : null}
        <ChecksRollup
          checks={pr.checks}
          repoPath={repoPath}
          provider={providerKey}
          crossRepository={!!pr.crossRepository}
        />
        <div className="flex gap-1 pt-1">
          {availableSections.map((s) => (
            <Button
              key={s}
              variant={section === s ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={section === s}
              onClick={() => setSection(s)}
            >
              {SECTION_LABEL[s](pr)}
            </Button>
          ))}
        </div>
      </header>

      <PrMergeabilityBanner
        arm={bannerArm}
        base={pr.baseRefName}
        head={pr.headRefName}
        promotionKind={promotionKind}
        provider={provider}
        forkBlocked={!!pr.crossRepository}
        hasResolveWorktree={resolveWorktree !== null}
        busy={
          mergeRemotePr.isPending ||
          abortRemotePrResolve.isPending ||
          detailsStale
        }
        conflictFiles={predictedFiles}
        predictedClean={predictedClean}
        forgeUnreachable={forgeUnreachable}
        behindBy={behindBy}
        blockedRequirements={blockedRequirements}
        blockedApprovals={blockedApprovals}
        blockedReason={gitlabBlockedNote}
        updateBlockedReason={updateBlockedReason}
        // Busy-shaped, not a reason — the banner supplies its own words for the wait,
        // which now spans GitHub's whole queued update rather than one CLI call.
        updateBusy={
          updateBranch.isPending ||
          updatingBranch ||
          detailsStale ||
          defaultBranchSettling ||
          rulesSettling
        }
        // The two waits the generic busy wording would misdescribe, so each gets its
        // own arm rather than claiming the pull request is still loading.
        updateAwaitingDefault={defaultBranchSettling}
        updateAwaitingRules={rulesSettling}
        updateSubmitting={updateBranch.isPending}
        onResolve={() => runResolve(false)}
        onResolveWithAi={() => runResolve(true)}
        onDiscard={() => void discardResolve()}
        onRetry={mergeability.retry}
        onUpdateBranch={() => void runUpdateBranch(false)}
        onUpdateWithRebase={() => void runUpdateBranch(true)}
        retryBusy={mergeability.isFetching}
      />

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
            // Scopes the run's per-PR stores (prior reviews, own-comments digest) to
            // the lens this view resolved — a fork's two lenses are different PRs.
            lens,
            // Provider-aware review copy (MR/merge-request noun, markdown flavor).
            provider: provider ?? undefined,
            // gh GraphQL returns commits oldest-first, so the head is the last.
            headSha: pr.commits.at(-1)?.oid,
            // Reuse the diff already cached by usePrDiff (mounted above) instead of
            // re-fetching it — PR diffs are among the slowest loads in the app.
            loadDiff: () =>
              queryClient
                .ensureQueryData(prDiffOptions(repoPath, number, lens))
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
          // The context above is seeded from the rendered PR, so through a switch
          // `stale` holds both the run and the post — without the spinner that
          // `posting` shows for a real one.
          stale={detailsStale}
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
          {/* overflow-hidden contains the thread's natural height (vendored Root is
              `relative`-only) so a long PR can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
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
                      {/* Absent, not disabled, while the description belongs to
                          the previous PR — the same shape the thread menus take
                          when their `onQuote` is withheld. */}
                      {!detailsStale && (
                        <DropdownMenuItem onClick={() => quoteReply(pr.body)}>
                          Quote reply
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => copyText(pr.body, "Markdown copied")}
                      >
                        Copy markdown
                      </DropdownMenuItem>
                      {/* Absent for the same reason as Quote reply, and because
                          a disabled item drops pointer events — no hint could
                          reach the viewer to explain it. */}
                      {isOpen && canEdit && !detailsStale && (
                        <DropdownMenuItem onClick={openEditWithChips}>
                          Edit
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {canReact && (
                  // The counts are a read and stay; only the toggles hold, and the
                  // bar carries the wait itself (a disabled button swallows `title`).
                  <ReactionBar
                    reactions={reactions.data?.body ?? []}
                    disabled={detailsStale}
                    reason={staleReason}
                    onToggle={(content, active) =>
                      toggleReaction(pr.id, content, active)
                    }
                  />
                )}
              </div>
              {/* Bitbucket-only PR tasks checklist, between the description and the
                  threads. Gated on the flag alone. */}
              {canTasks && (
                <PrTasksSection
                  repoPath={repoPath}
                  number={number}
                  // The open-state verb comes off the rendered pr while the task
                  // writes address `number`, so a switch would offer Add against a
                  // pull request whose own state hasn't arrived yet.
                  editable={pr.state === "OPEN" && !detailsStale}
                />
              )}
              <PrActivityFeed
                pr={pr}
                timeline={timeline.data}
                reactions={reactions.data}
                claims={threadClaims}
                providerKey={providerKey}
                suggestionApply={suggestionApply}
                fileDiffLookup={fileDiffLookup}
                mentions={mentions}
                // Hide/Unhide stay visible but disabled through the switch. The
                // permission reason ranks first — it's the one still true once the
                // selected pull request is on screen.
                disabledReason={triageItemReason ?? staleReason}
                revealThreadId={revealThreadId}
                setRevealThreadId={setRevealThreadId}
                revealReviewId={revealReviewId}
                onReviewRevealed={() => setRevealReviewId(null)}
                setSection={setSection}
                // Drill into the commit via the Commits-tab machinery
                // (selectedCommitOid → PrCommitDetail).
                onSelectCommit={(oid) => {
                  setSelectedCommitOid(oid);
                  setSection("commits");
                }}
                canWrite={canWrite}
                canThreadReply={canThreadReply}
                canThreadResolve={canThreadResolve}
                canEditOwnThreadComments={canEditOwnThreadComments}
                canEditOwnComments={canEditOwnComments}
                canReact={canReact}
                onQuote={detailsStale ? undefined : quoteReply}
                onThreadReply={(threadId, body) =>
                  threadReply.mutateAsync({ threadId, body })
                }
                onThreadResolve={(threadId, resolved) =>
                  threadResolve.mutateAsync({ threadId, resolved })
                }
                // All four pair a rendered comment id with `number`, so they're
                // withheld through a switch; `editHeld` covers an editor already
                // open when it began.
                onEditThreadComment={
                  detailsStale ? undefined : saveThreadCommentEdit
                }
                onDeleteThreadComment={
                  detailsStale ? undefined : setDeletingThreadCommentId
                }
                onEditComment={detailsStale ? undefined : saveCommentEdit}
                onDeleteComment={
                  detailsStale ? undefined : setDeletingCommentId
                }
                editHeld={detailsStale}
                onHideComment={hideComment}
                onUnhideComment={unhideComment}
                onToggleReaction={toggleReaction}
                reactionsHeld={detailsStale}
                reactionsReason={staleReason ?? null}
              />
              {/* Residual review threads — those NOT shown inline under a review
                  above: all threads on GitLab/Bitbucket (no reviewId), plus
                  standalone line comments on GitHub. Retitled when reviews claimed
                  threads above so it doesn't read as a duplicate. */}
              <ReviewThreadsBlock
                threads={threadClaims.residualThreads}
                heading={
                  threadClaims.claimedThreadIds.size > 0
                    ? "Other line comments"
                    : "Review comments"
                }
                isError={reviewThreads.isError}
                onQuote={detailsStale ? undefined : quoteReply}
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
                  canEditOwnThreadComments && !detailsStale
                    ? saveThreadCommentEdit
                    : undefined
                }
                onDeleteComment={
                  canEditOwnThreadComments && !detailsStale
                    ? setDeletingThreadCommentId
                    : undefined
                }
                editHeld={detailsStale}
                provider={providerKey}
                apply={suggestionApply}
                fileDiffLookup={fileDiffLookup}
                mentions={mentions}
                revealThreadId={revealThreadId}
                onRevealed={() => setRevealThreadId(null)}
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
            <CommentComposer
              ref={composerRef}
              value={compose.value}
              onChange={compose.set}
              onSubmit={submitComment}
              onClear={() => compose.set("")}
              submitLabel="Comment"
              ariaLabel="Leave a comment"
              placeholder="Leave a comment…"
              mentions={mentions}
              busy={busy}
              // Every term of `busy` gets words, so a held Submit is never mute —
              // including the switch, where the comment would post against the
              // previously rendered PR.
              reason={composerReason}
              actions={
                <>
                  {/* The Review control opens the batch submit dialog for every
                      provider (verdict + summary + pending draft comments). GitHub
                      rides `canWrite` via canSubmitReview; GitLab/Bitbucket enable it
                      through the forge flag. */}
                  {isOpen && canSubmitReview && (
                    <DisabledReasonButton
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      // `busy` folds in the placeholder window, where the review
                      // would open against the previously rendered PR. The pending
                      // arms carry no reason here, as on the neighbours.
                      reason={staleReason}
                      onClick={() => setSubmitOpen(true)}
                      title="Submit a review (verdict, summary, and any pending comments)"
                    >
                      Review…
                    </DisabledReasonButton>
                  )}
                  {isOpen && canApprove && (
                    <>
                      <DisabledReasonButton
                        variant="outline"
                        size="sm"
                        // On an approvals read-error we can't know the viewer's state,
                        // so disable rather than present a confident (possibly wrong)
                        // Approve that would fire the wrong direction on click. The
                        // failed read has no other surface, so it rides `reason` —
                        // hoverable and announced while the button is unavailable.
                        disabled={
                          busy || approvals.isPending || approvals.isError
                        }
                        reason={
                          approvals.isError
                            ? "Couldn't load approval state"
                            : staleReason
                        }
                        // Unknown state is announced as unknown: a failed read
                        // must not claim "not pressed" while the reason says the
                        // state couldn't be loaded.
                        aria-pressed={
                          approvals.isError
                            ? undefined
                            : (approval?.viewerHasApproved ?? false)
                        }
                        onClick={toggleApproval}
                        title={
                          approval?.viewerHasApproved
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
                      </DisabledReasonButton>
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
                    <DisabledReasonButton
                      variant="outline"
                      size="sm"
                      // Bitbucket: a true toggle. GitLab: one-shot — once requested
                      // the button is the state indicator (the direct undo is
                      // Premium-only), so it stays ENABLED with a no-op handler and
                      // its how-to-clear title reachable. Same disable-on-unknown
                      // posture as the approve toggle: `reason` carries the read
                      // failure nothing else reports, and DisabledReasonButton keeps
                      // the disabled button focusable so that reason is announced
                      // rather than lost.
                      disabled={
                        busy || approvals.isPending || approvals.isError
                      }
                      reason={
                        approvals.isError
                          ? "Couldn't load review state"
                          : staleReason
                      }
                      // Unknown state is announced as unknown (same as approve).
                      aria-pressed={
                        approvals.isError
                          ? undefined
                          : (approval?.viewerRequestedChanges ?? false)
                      }
                      onClick={requestChanges}
                      title={
                        approval?.viewerRequestedChanges
                          ? canUnrequestChanges
                            ? "Revoke your change request"
                            : "You've requested changes — approve, or remove yourself as a reviewer on GitLab, to clear"
                          : compose.value.trim()
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
                    </DisabledReasonButton>
                  )}
                </>
              }
            />
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
                lens={lens}
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
          {/* Pending-review status bar — hidden until a draft exists. */}
          <PendingReviewBar
            repoPath={repoPath}
            lens={lens}
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
            lens={lens}
            number={number}
            lineWidget={reviewLineWidget}
            onQuote={detailsStale ? undefined : quoteReply}
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
            mentions={mentions}
            // gh GraphQL returns commits oldest-first, so the head is the last —
            // pin the file-row Blame at the PR's tip.
            blameRev={pr.commits.at(-1)?.oid}
          />
        </div>
      )}

      {/* The open-MR footer hosts Close + Merge alongside the shared Ready /
          Convert-to-draft pair — shown when any is available, each control gated
          individually. */}
      {isOpen && (canChangeState || canMerge || canWrite) && (
        <div className="flex items-center gap-2 border-t p-3">
          {/* One Ready / Convert-to-draft pair for all three providers: GitLab
              (`glab mr update`) and Bitbucket (PUT `draft`) via `canToggleDraft`;
              GitHub folds in via `canWrite` and routes the same `setDraft` mutation
              through `gh pr ready [--undo]`. Draft → primary Ready (fires the
              ready-review automation); open → a quieter Convert-to-draft. */}
          {draftPairVisible && shownIsDraft === true && (
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={busy || writeBlocked}
              reason={writeReason ?? staleReason}
              onClick={() =>
                setDraft.mutate(
                  { number, draft: false },
                  {
                    onSuccess: () => {
                      toast.success("Marked ready for review");
                      void fireReadyReview();
                    },
                    onError,
                  },
                )
              }
            >
              Ready for review
            </DisabledReasonButton>
          )}
          {draftPairVisible && shownIsDraft === false && (
            <DisabledReasonButton
              variant="ghost"
              size="sm"
              disabled={busy || writeBlocked}
              reason={writeReason ?? staleReason}
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
            </DisabledReasonButton>
          )}
          {/* The merge is in the forge's queue, not landed. Same icon + words
              shape as the auto-merge chip below (not color-alone), and it stands
              until the pull request itself leaves OPEN — read behind the same
              placeholder gate as the retraction, so a lagging `details` can't
              blank the chip during a PR switch. */}
          {mergeQueued && isOpenPr && queuedDetailsReady && (
            <span
              className="flex items-center gap-1 text-xs text-info"
              title={
                queuedWarning?.key === queuedKey
                  ? queuedWarning.text
                  : "Merges when the queue reaches it"
              }
            >
              <ClockCountdownIcon className="size-3.5 shrink-0" />
              Queued to merge
            </span>
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
              <DisabledReasonButton
                variant="outline"
                size="sm"
                disabled={busy || writeBlocked}
                reason={writeReason ?? staleReason}
                onClick={() =>
                  cancelAutoMerge.mutate(number, {
                    onSuccess: () => toast.success("Auto-merge canceled"),
                    onError,
                  })
                }
              >
                Cancel auto-merge
              </DisabledReasonButton>
            </div>
          )}
          <span className="flex-1" />
          {canChangeState && (
            // The label swaps while a draft rides along: the action changed
            // meaning, and only the label reaches a viewer before the click.
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={busy || triageBlocked}
              reason={triageReason ?? staleReason}
              onClick={doClose}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close"}
            </DisabledReasonButton>
          )}
          {canMerge && (
            <DropdownMenu>
              {/* A natively-disabled Button swallows `title`, so the hint rides a
                  wrapping span (house idiom). The span stays OUTSIDE the trigger:
                  as the trigger it would take the click the disabled button
                  refuses and open the menu anyway — merging past every gate,
                  including GitLab's stale-head guard. */}
              <span
                title={mergeReason}
                className={cn(
                  "inline-flex",
                  mergeBlocked && "cursor-not-allowed",
                )}
              >
                <DropdownMenuTrigger
                  disabled={mergeBlocked}
                  render={<Button size="sm" />}
                >
                  <GitMergeIcon data-icon="inline-start" />
                  Merge
                  <CaretDownIcon data-icon="inline-end" />
                </DropdownMenuTrigger>
              </span>
              <DropdownMenuContent align="end" className="w-56">
                {/* Branch-rule gating is GitHub branch-protection data, so it
                    never applies to GitLab/Bitbucket. */}
                {PROVIDER_MERGE_STRATEGIES[providerKey].map((s) => {
                  const isGitHub =
                    provider !== "gitlab" &&
                    provider !== "bitbucket" &&
                    // Bitbucket's "fast_forward" isn't a GitHub MergeMethod and
                    // never reaches this arm (bitbucket is excluded above) — the
                    // narrowing also keeps `s` a valid MergeMethod for the checks.
                    s !== "fast_forward";
                  // Repo-level server setting; only an explicit `false` disables
                  // (unknown never gates).
                  const serverDisabled =
                    isGitHub && isServerMergeDisabled(pr, s);
                  const locallyBlocked =
                    isGitHub &&
                    !isMergeMethodAllowed(rulesConfig, pr.baseRefName, s);
                  const blocked = serverDisabled || locallyBlocked;
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
                      {serverDisabled
                        ? " — disabled in repository settings"
                        : locallyBlocked && " — blocked by branch rule"}
                    </DropdownMenuItem>
                  );
                })}
                {/* GitLab auto-merge: while the head pipeline is in flight and not
                    already armed, offer merge-when-pipeline-succeeds variants. */}
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
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={busy || triageBlocked}
            reason={triageReason ?? staleReason}
            onClick={doReopen}
            title={
              draftRidesStateChange
                ? "Reopens and posts your draft as a comment"
                : undefined
            }
          >
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            {draftRidesStateChange ? "Reopen with comment" : "Reopen"}
          </DisabledReasonButton>
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
        stackNotice={stackMerge?.notice}
        confirmLabel={stackMerge?.confirmLabel}
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
        description={`Updates the title, description, and base branch of #${number} on ${remoteLabel}.`}
        contentClassName="sm:max-w-lg"
        bodyTextareaClassName="max-h-72 min-h-24 resize-y font-mono"
        mentions={mentions}
        onGenerate={aiEnabled ? runGenerate : undefined}
        generating={prGen.generating}
        belowBody={
          <>
            <BaseBranchField
              value={editBase}
              items={baseItems}
              annotations={branchAnnotations}
              onChange={setEditBase}
              lockedNote={baseLockedNote}
            />
            {canLinkIssues ? (
              <LinkedIssuesField
                repoPath={repoPath}
                lens={lens}
                chips={linkedIssues}
                onToggleKeyword={toggleIssueKeyword}
                onRemove={removeIssue}
                onPick={pickIssue}
                disabled={prGen.generating}
              />
            ) : canJiraMention ? (
              <LinkedIssuesField
                variant="jira"
                repoPath={repoPath}
                link={jiraLink.data ?? null}
                jiraChips={jiraChips}
                onRemove={removeJiraChip}
                onPick={pickJiraChip}
                disabled={prGen.generating}
              />
            ) : null}
          </>
        }
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
              onClick={runGenerate}
              title={`Generate the title and description with AI${generateHint}`}
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

      {/* The batch submit-review dialog (Review control, pending-review bar, palette
          action). Verdict caps ride canWrite for GitHub, forge flags elsewhere.
          Keyed on the entity: it owns verdict/summary/error state that ONLY its own
          onOpenChange resets, so a switch has to remount it — closing it from the
          reset block alone would leave the previous PR's verdict on the next open. */}
      <SubmitReviewDialog
        key={entityKey}
        repoPath={repoPath}
        number={number}
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        caps={{
          canApprove: canWrite || canApprove,
          canRequestChanges: canWrite || canRequestChanges,
        }}
        remoteLabel={remoteLabel}
        lens={lens}
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
            onSuccess: () => setDiscardConfirmOpen(false),
          })
        }
      />
    </div>
  );
}

/**
 * The edit dialog's base-branch picker, injected at this call site rather than
 * added to the shared dialog (the issue views reuse it and have no base). Follows
 * the create-PR base picker's composition — an `items` map so the closed trigger
 * shows a label, never a raw value.
 */
function BaseBranchField({
  value,
  items,
  annotations,
  onChange,
  lockedNote,
}: {
  value: string;
  items: Record<string, string>;
  annotations: Record<string, ReactNode>;
  onChange: (value: string) => void;
  /** Why the picker is locked; present ⇒ disabled. Rendered as visible text
   *  beside the control, never a `title` on it — a disabled control fires no
   *  tooltip, so the reason would be unreachable. */
  lockedNote: string | null;
}) {
  return (
    <div className="space-y-2">
      {/* sizeToContent: branch names run long, so the popup sizes to its widest
          option rather than the trigger — same as the create-PR picker. */}
      <SelectControl
        label="Base branch"
        items={items}
        value={value}
        onValueChange={onChange}
        annotations={annotations}
        disabled={lockedNote !== null}
        sizeToContent
      />
      {lockedNote && (
        <p className="flex items-start gap-1 text-xs text-warning">
          <WarningIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          {lockedNote}
        </p>
      )}
    </div>
  );
}

/** GitHub's Copilot review-bot login (the same value the AI-review context maps to
 *  a "GitHub Copilot" display name). Its reviews arrive under this login. */
const COPILOT_LOGIN = "copilot-pull-request-reviewer";

/** A reviewer who has already submitted a verdict, in display shape. */
interface CompletedReviewer {
  login: string;
  label: string;
  isBot: boolean;
  /** The reviewer's avatar URL when the provider supplies one (GitLab/Bitbucket).
   *  Empty for GitHub, where `ForgeUserAvatar` derives it from the login. */
  avatarUrl: string;
  /** Uppercased review state — APPROVED / CHANGES_REQUESTED / COMMENTED. */
  state: string;
}

/**
 * Derives the completed-reviewer chips from a PR's reviews. Keeps only submitted
 * verdicts (APPROVED / CHANGES_REQUESTED / COMMENTED), the latest per author, and
 * drops anyone still in the pending request set (they render as pending instead,
 * so there's never a duplicate). Copilot and `[bot]` logins are flagged as bots.
 */
function deriveCompletedReviewers(
  reviews: PrThreadOut[],
  pending: ForgeUserRef[],
): CompletedReviewer[] {
  const pendingLogins = new Set(pending.map((r) => r.id.toLowerCase()));
  const latestByAuthor = new Map<string, PrThreadOut>();
  for (const review of reviews) {
    const s = review.state.toUpperCase();
    if (s !== "APPROVED" && s !== "CHANGES_REQUESTED" && s !== "COMMENTED") {
      continue;
    }
    if (!review.author || pendingLogins.has(review.author.toLowerCase())) {
      continue;
    }
    const prev = latestByAuthor.get(review.author);
    // Latest verdict wins; a tie or unparseable date keeps the first seen.
    if (!prev || review.date > prev.date) {
      latestByAuthor.set(review.author, review);
    }
  }
  return Array.from(latestByAuthor.values()).map((review) => {
    const login = review.author;
    const isCopilot = login.toLowerCase() === COPILOT_LOGIN;
    const isBot = isCopilot || /\[bot\]$/i.test(login);
    return {
      login,
      label: isCopilot ? "Copilot" : login,
      isBot,
      // GitHub avatars are login-derived; ForgeUserAvatar falls back when empty.
      avatarUrl: "",
      state: review.state.toUpperCase(),
    };
  });
}

/** Icon + tone + accessible word for a completed reviewer's state, so the verdict
 *  never rides on color alone. Tones are token classes; unknown states fall back to
 *  the neutral comment presentation. */
function reviewStatePresentation(state: string): {
  Icon: typeof CheckCircleIcon;
  tone: string;
  word: string;
} {
  if (state === "APPROVED") {
    return { Icon: CheckCircleIcon, tone: "text-success", word: "approved" };
  }
  if (state === "CHANGES_REQUESTED") {
    return {
      Icon: XCircleIcon,
      tone: "text-destructive",
      word: "requested changes",
    };
  }
  return { Icon: ChatCircleIcon, tone: "text-info", word: "commented" };
}

/** Read-only chip for a reviewer who already submitted a verdict: state icon +
 *  avatar (robot glyph for bots) + label, with the state word in title AND
 *  aria-label so meaning never rides on color alone. Non-interactive — completed
 *  reviews are managed on the forge. */
function CompletedReviewerChip({
  reviewer,
  ghHost,
}: {
  reviewer: CompletedReviewer;
  ghHost: string | null;
}) {
  const { Icon, tone, word } = reviewStatePresentation(reviewer.state);
  const name = `${reviewer.label} — ${word}`;
  return (
    <span
      title={name}
      aria-label={name}
      className="inline-flex items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground"
    >
      <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
      {reviewer.isBot ? (
        <RobotIcon aria-hidden className="size-3 shrink-0" />
      ) : (
        <ForgeUserAvatar
          user={{
            id: reviewer.login,
            label: reviewer.label,
            avatarUrl: reviewer.avatarUrl,
            isBot: false,
          }}
          ghHost={ghHost}
          decorative
        />
      )}
      {reviewer.label}
    </span>
  );
}

/** Read-only chip for a bot requested reviewer (e.g. Copilot): the human chip idiom
 *  plus a robot glyph, with the accessible name on the whole chip (title +
 *  aria-label). Non-interactive — reviewing bots are managed on the forge. */
function BotReviewerChip({
  user,
  ghHost,
}: {
  user: ForgeUserRef;
  ghHost: string | null;
}) {
  const name = `${user.label} — review requested from a bot, managed on the forge`;
  return (
    <span
      title={name}
      aria-label={name}
      className="inline-flex items-center gap-1 border py-0.5 pr-1.5 pl-0.5 text-[11px] text-muted-foreground"
    >
      <ForgeUserAvatar user={user} ghHost={ghHost} decorative />
      {user.label}
      <RobotIcon aria-hidden className="size-3 shrink-0" />
    </span>
  );
}
