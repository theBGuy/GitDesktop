import { Popover } from "@base-ui/react/popover";
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  GitMergeIcon,
  InfoIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TagIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DetailTitleRow } from "@/components/detail-title-row";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Markdown } from "@/components/markdown/markdown";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { ProviderIcon } from "@/components/provider-icon";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { CommitsList } from "@/features/conversations/CommitsList";
import { ConversationScrollArea } from "@/features/conversations/ConversationScrollArea";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { LocalComment } from "@/features/conversations/LocalComment";
import { useCancelOnIdentityChange } from "@/features/conversations/useAiStream";
import { useLocalConversation } from "@/features/conversations/useLocalConversation";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { useThreadJumpHotkeys } from "@/features/conversations/useThreadJumpHotkeys";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { useStashReapplyRecovery } from "@/features/repository/useStashReapplyRecovery";
import {
  isMergeMethodAllowed,
  isPromotionBranch,
} from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import {
  gitBranchDiff,
  type LocalPrMergeAbortOutcome,
  type MergeStrategy,
} from "@/lib/git/api";
import {
  AUTOSTASH_WRITES_FAMILY,
  conflictPreviewQueryKey,
  forgeFeatureReady,
  LOCAL_PR_WRITES_KEY,
  type LocalPrUpdateDiscardVars,
  type LocalPrUpdateFinishVars,
  type LocalPrUpdateStartVars,
  MERGE_UPDATE_ABORT_FAILED_NOTE,
  MERGE_UPDATE_UNFINISHED_MESSAGE,
  type MergeRefusal,
  pendingWriteMatching,
  pendingWriteOfKind,
  refuseWhileBranchPushes,
  refuseWhilePushRuns,
  repoKeys,
  useAbortLocalPrMerge,
  useBranchDiffFiles,
  useCompareBranches,
  useConflictPreview,
  useDefaultBranch,
  useDiscardLocalPrUpdate,
  useForgeStatus,
  useMergeLocalPr,
  usePendingLocalPrWrites,
  usePendingRepoWrites,
  useRepoStatus,
  useStartLocalPrUpdate,
  useUpdateBranchFrom,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useGenerateChordHint } from "@/lib/hotkeys/useGenerateChord";
import { type LocalPr, openPendingUpdate } from "@/lib/pulls/local";
import type { PrSection } from "@/lib/pulls/pr-section";
import {
  LOCAL_PR_RECORD_WRITES_FAMILY,
  localPrKey,
  useLocalPrs,
  useUpdateLocalPr,
} from "@/lib/pulls/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useToastClearance } from "@/lib/use-toast-clearance";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { LocalPrLifecycleRow } from "./LocalPrTimeline";
import { localMergeStripArm } from "./merge-strip-arm";
import {
  AWAITING_DEFAULT_BRANCH_REASON,
  AWAITING_PROMOTION_RULES_REASON,
  LocalPrMergeStrip,
  type LocalStripResolve,
  type PromotionKind,
  updateOperation,
} from "./PrMergeabilityBanner";
import { PromoteLocalPrDialog } from "./PromoteLocalPrDialog";
import { PrReviewPanel } from "./PrReviewPanel";
import {
  coalesceCommitRuns,
  PushedCommitsRow,
  sortTimeline,
  type TimelineEntry,
} from "./PrTimeline";
// The copy below is read only inside handlers, never at render (a test that stubs
// this module supplies the component alone).
import {
  DISCARD_UPDATE_CONFIRM,
  discardSettledToast,
  ResolveConflictsView,
  updateConflictsToast,
  updatedToast,
} from "./ResolveConflictsView";
import { useGeneratePrDescription } from "./useGeneratePrDescription";
import {
  composeBodyWithRefs,
  splitBodyRefBlock,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";

/** The verb a completed merge reports, per strategy. */
const MERGED_VERB: Record<MergeStrategy, string> = {
  merge: "Merged",
  squash: "Squashed and merged",
  rebase: "Rebased and merged",
  fast_forward: "Merged",
};

/** Tab labels for this view's sections. `files` is undefined until the branch-diff
 *  read lands, and the tab then shows no count rather than a wrong one. */
const SECTION_LABEL: Record<
  PrSection,
  (counts: {
    comments: number;
    commits: number;
    files: number | undefined;
  }) => string
> = {
  conversation: (c) => `Conversation (${c.comments})`,
  commits: (c) => `Commits (${c.commits})`,
  files: (c) => `Files${c.files === undefined ? "" : ` (${c.files})`}`,
  review: () => "Review",
};

/** Merge's reasons, spelled once. Both are the button's tooltip reason; only
 *  MERGE_DIRTY_TREE also renders as the footer's visible line, so the two read the
 *  same string. */
const MERGE_NEEDS_APPROVAL = "Approve the PR before merging";
const MERGE_DIRTY_TREE =
  "Commit or stash your changes before merging into the current branch";
/** A resolve's reasons. The dirty-head sentence is the Rust start's refusal
 *  (DIRTY_HEAD_UPDATE) spelled for the strip and Finish; the preparing one names the
 *  action because it shows on controls that are not that action. */
const RESOLVE_DIRTY_HEAD =
  "Commit or stash your changes to update the current branch";
const UPDATE_PREPARING_REASON = "Preparing to resolve conflicts…";
const UPDATE_UNFINISHED_REASON =
  "Finish or discard the unfinished conflict resolution first";

/** Each refusal's toast once the newcomer's worktree is discarded, and its note when
 *  that discard fails or leaves the worktree. */
const MERGE_REFUSED: Record<
  MergeRefusal,
  { message: string; abortFailed: string }
> = {
  "not-open": {
    message:
      "This pull request is no longer open, so the paused merge was discarded.",
    abortFailed:
      "This pull request is no longer open, and the paused merge couldn't be discarded, so it is still there.",
  },
  merging: {
    message:
      "This pull request already has a paused merge, so the new one was discarded.",
    abortFailed:
      "This pull request already has a paused merge, and the new one couldn't be discarded, so it is still there.",
  },
  updating: {
    message: MERGE_UPDATE_UNFINISHED_MESSAGE,
    abortFailed: MERGE_UPDATE_ABORT_FAILED_NOTE,
  },
};

/** A record write that changes the approval: `approved` (the value it sets) is what
 *  the Merge and Approve hold reads back from the mutation cache. */
type ApprovalWriteVars = {
  id: string;
  mutate: (pr: LocalPr) => LocalPr;
  approved: boolean;
};

/** The one approval toggle, rendered in the composer and the footer so the two
 *  mounts cannot drift. */
function ApproveToggle({
  approved,
  held,
  onToggle,
}: {
  approved: boolean;
  held: boolean;
  onToggle: () => void;
}) {
  return (
    <DisabledReasonButton
      variant={approved ? "secondary" : "outline"}
      size="sm"
      aria-pressed={approved}
      disabled={held}
      reason="Saving…"
      onClick={onToggle}
    >
      <CheckCircleIcon data-icon="inline-start" />
      {approved ? "Approved" : "Approve"}
    </DisabledReasonButton>
  );
}

export function LocalPrView({
  repoPath,
  id,
}: {
  repoPath: string;
  id: string;
}) {
  const prs = useLocalPrs(repoPath);
  const pr = prs.data?.find((p) => p.id === id);
  const update = useUpdateLocalPr(repoPath);
  // The list key the merge and the update writes re-read before they settle.
  const recordKey = localPrKey(repoPath);
  const merge = useMergeLocalPr(repoPath, recordKey);
  const abortMerge = useAbortLocalPrMerge(repoPath);
  const updateBranchFrom = useUpdateBranchFrom(repoPath);
  // Read from the mutation cache, not the hooks' observers: this view unmounts on a
  // local -> remote -> local hop, and a remount's fresh observers never saw the write.
  const localWrites = usePendingLocalPrWrites(repoPath);
  const runningMerge = pendingWriteOfKind(localWrites, "merge");
  const runningUpdate = pendingWriteOfKind(localWrites, "update-from");
  // The record-store writes, read per PR below: this view outlives a PR switch,
  // and its observers would hold whichever PR is shown next.
  const storeWrites = usePendingRepoWrites(
    LOCAL_PR_RECORD_WRITES_FAMILY,
    repoPath,
  );
  const recovery = useStashReapplyRecovery(repoPath);
  // The recovery's compound, read from the cache for the same remount reason.
  const autostashWrites = usePendingRepoWrites(
    AUTOSTASH_WRITES_FAMILY,
    repoPath,
  );
  const status = useRepoStatus(repoPath);
  const selectedPr = useUiStore((s) => s.selectedPr);
  const pendingPrSection = useUiStore((s) => s.pendingPrSection);
  const setPendingPrSection = useUiStore((s) => s.setPendingPrSection);
  const [section, setSection] = useState<PrSection>("conversation");
  // A section pick is a user action whose state lives here, so it claims the
  // epoch first and a pending continuation yields to it. The automatic
  // corrections below (the pending landing, the fallback) set it silently.
  const pickSection = (next: PrSection) => {
    useUiStore.getState().noteUserInteraction();
    setSection(next);
  };
  // Commits-tab drill-in: the selected commit's hash, or null for the list.
  // Reset when the viewed PR changes (below).
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
    null,
  );
  const aiEnabled = useAiEnabled();
  const portalContainer = usePanelPortalContainer();
  // The sub-tabs the strip renders — every writer of `section` gates on this, so
  // no path can select a tab that isn't there. A local PR has no forge, so the
  // Review tab rides the AI setting alone (no capability axis to consult).
  const availableSections = useMemo<PrSection[]>(
    () =>
      aiEnabled
        ? ["conversation", "commits", "files", "review"]
        : ["conversation", "commits", "files"],
    [aiEnabled],
  );
  // A notification's click-through lands here via a pending hint; switch to the
  // hinted sub-tab once if it's available, then clear the hint either way — an
  // unusable hint must not survive to fire against a later PR. Guarded on this
  // being the *selected* PR so a still-mounted lagging view (deferredPr) can't
  // swallow the hint first.
  useEffect(() => {
    const isSelected = selectedPr?.kind === "local" && selectedPr.id === id;
    if (pendingPrSection !== null && isSelected) {
      if (availableSections.includes(pendingPrSection))
        setSection(pendingPrSection);
      setPendingPrSection(null);
    }
  }, [
    pendingPrSection,
    setPendingPrSection,
    selectedPr,
    id,
    availableSections,
  ]);
  // Availability can drop away under the selection (Hide AI toggled), which
  // would leave a blank body under a strip with no pressed tab — fall back to
  // the tab every PR always has. Layout effect: a passive one paints that empty
  // frame before reconciling.
  useLayoutEffect(() => {
    if (!availableSections.includes(section)) setSection("conversation");
  }, [availableSections, section]);
  const rulesConfig = useEffectiveBranchRules(repoPath);
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);
  const {
    comment,
    setComment,
    labelInput,
    setLabelInput,
    deletingCommentId,
    setDeletingCommentId,
    composerRef,
    quoteReply,
    addComment,
    editComment,
    deleteComment,
    setCommentHidden,
    addLabel,
    removeLabel,
  } = useLocalConversation(id, pr, async (mutate) => {
    if (pr) await update.mutateAsync({ id: pr.id, mutate });
  });
  const [promoteOpen, setPromoteOpen] = useState(false);
  // Close/Reopen's and the review post's click-time holds, before the cache
  // notification that feeds `updateHold` lands: both writes append a comment, so
  // a second press in that window would post it twice. `updateHold` carries the
  // hold across a PR switch; the object tokens compare-and-clear, so a settle
  // never releases another press's slot. The panel's `post` gates re-entry on
  // `posting`.
  const [statusSavingFor, setStatusSavingFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  const [postingReviewFor, setPostingReviewFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  // Approve's click slot, the same shape: `updateHold` matches every record
  // write of this PR, so a posted comment would flash Approve held.
  const [approveSavingFor, setApproveSavingFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  // Update branch's click slot, held until the strip's reads answer for the moved
  // head: the write settles before its invalidation's refetch lands, so the
  // retained "behind" answer would offer Update branch again in between.
  const [updateSettlingFor, setUpdateSettlingFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  // The same hold when Update branch's dirty-tree refusal went to the stash-and-reapply
  // recovery: from the moment its compound runs (`ran`, seen through `recovery.pending`,
  // since the recovery runs it unawaited) until the strip's reads answer after it. A
  // prompt dismissed without running leaves it inert.
  const [recoveringFor, setRecoveringFor] = useState<{
    repo: string;
    id: string;
    base: string;
    head: string;
    ran: boolean;
  } | null>(null);
  // The same hold after a conflict resolution moved the head (a clean start, a
  // finish, a discard that had landed): set as the write answers, cleared once the
  // strip's reads answer for the new tip.
  const [resolveSettlingFor, setResolveSettlingFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  // Resolve conflicts' click slot: the start holds from the press, before the
  // batched cache notification that feeds `preparing` lands, so a second press in
  // that window starts nothing.
  const [startingFor, setStartingFor] = useState<{
    repo: string;
    id: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const ghStatus = useForgeStatus(repoPath);
  const provider = ghStatus.data?.provider;
  // A local PR's body and comments autolink the forge's references like any other
  // body, and its editors complete them. Local PRs have no lens, so "origin".
  const mentions = useMentionCandidates({ repoPath, lens: "origin", provider });
  // Promote copy names the detected forge. The label spans all three providers;
  // the noun stays two-way because only GitLab calls it a merge request.
  const promoteLabel = providerLabel(provider);
  const promoteNoun = provider === "gitlab" ? "merge request" : "pull request";
  // Linked-issue chips on the local-PR edit path: the chips OWN the trailing ref
  // block (peeled at open, re-composed on save). A local PR's `Closes #N` lines
  // survive promotion verbatim into the real forge PR, so these become real
  // closing refs later — that's intended.
  const canLinkIssues =
    !!ghStatus.data && forgeFeatureReady(ghStatus.data, "issues");
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      if (!pr) return;
      const finalBody = canLinkIssues
        ? composeBodyWithRefs(body, linkedIssues)
        : body;
      await update.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({ ...cur, title, body: finalBody }),
      });
    },
  });
  // A different PR must never inherit this one's drill-in, half-typed label, or
  // open delete/promote/edit dialogs — a render-time state adjustment, not an
  // effect.
  const [lastId, setLastId] = useState(id);
  if (id !== lastId) {
    setLastId(id);
    setSelectedCommitHash(null);
    setLabelInput("");
    setDeletingCommentId(null);
    setPromoteOpen(false);
    edit.setOpen(false);
  }
  const prGen = useGeneratePrDescription(repoPath);
  // The edit dialog's in-flight generation belongs to the PR it was started on; the
  // cancel is imperative, so it rides an effect rather than the block above.
  useCancelOnIdentityChange(id, prGen.cancel);
  // The generate-commit-message binding's title suffix. The chord itself lives in
  // EditTitleBodyDialog; this is only the label, so a rebinding drives both.
  const generateHint = useGenerateChordHint();

  const comparison = useCompareBranches(
    repoPath,
    pr?.base ?? null,
    pr?.head ?? null,
  );
  // Shared chip state machine — enabled only while the edit dialog is open (and
  // the tracker is usable). Local PRs have no lens concept, so read the forge's
  // own issues ("origin"). Body refs are peeled into chips at open (`resetWith`
  // in openEdit), so the body and the chips are never two sources of truth.
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
    lens: "origin",
    enabled: canLinkIssues && edit.open,
    headBranch: pr?.head ?? null,
    commitSubjects: comparison.data?.ahead?.map((c) => c.subject) ?? [],
  });
  const diffFiles = useBranchDiffFiles(
    repoPath,
    pr?.base ?? null,
    pr?.head ?? null,
  );
  // The merge runs in an isolated worktree, so a dirty working tree only blocks
  // it when `base` IS the branch you're currently on (git won't check that ref
  // out into a second worktree while it has uncommitted tracked changes). When
  // base is some other branch, the merge never touches your tree.
  const baseIsCurrent =
    pr !== undefined && status.data?.branch?.name === pr.base;
  const hasTrackedChanges = (status.data?.entries ?? []).some(
    (e) =>
      e.staged !== null || (e.unstaged !== null && e.unstaged !== "untracked"),
  );
  const dirtyBlocks = baseIsCurrent && hasTrackedChanges;
  const canMerge = pr?.status === "open" && pr.approved;

  // A conflict-resolving update (base merged INTO head). Its writes are read from the
  // cache by PR id: this view outlives a PR switch.
  const startUpdate = useStartLocalPrUpdate(repoPath, recordKey);
  const discardUpdate = useDiscardLocalPrUpdate(repoPath, recordKey);
  const gitWrites = usePendingRepoWrites(LOCAL_PR_WRITES_KEY[0], repoPath);
  const activeUpdate = openPendingUpdate(pr);
  const preparing =
    (startingFor?.repo === repoPath && startingFor.id === id) ||
    pendingWriteMatching(
      gitWrites,
      "update-resolve",
      (v: LocalPrUpdateStartVars) => v.id === id,
    ) !== undefined;
  const finishingUpdate =
    pendingWriteMatching(
      gitWrites,
      "finish-update",
      (v: LocalPrUpdateFinishVars) => v.id === id,
    ) !== undefined;
  const discardingUpdate =
    pendingWriteMatching(
      gitWrites,
      "discard-update",
      (v: LocalPrUpdateDiscardVars) => v.id === id,
    ) !== undefined;
  const otherStart =
    pendingWriteOfKind(localWrites, "update-resolve") !== undefined &&
    !preparing;
  // Whether the editor shows, per repo and PR. Decided on the first render that has
  // the record of a PR this view just came to, so an update that already exists
  // opens (restart included) and one that arrives later leaves the strip's resume arm.
  const [updateEditor, setUpdateEditor] = useState<{
    repo: string;
    id: string;
    open: string | null;
  } | null>(null);
  if (
    pr !== undefined &&
    !(updateEditor?.repo === repoPath && updateEditor.id === pr.id)
  ) {
    setUpdateEditor({
      repo: repoPath,
      id: pr.id,
      open: activeUpdate?.worktreeId ?? null,
    });
  }
  const updateTakeover =
    activeUpdate !== undefined &&
    updateEditor?.repo === repoPath &&
    updateEditor.id === pr?.id &&
    updateEditor.open === activeUpdate.worktreeId;
  const mergeTakeover = !!pr?.pendingMerge?.worktreePath;
  // Either paused merge takes the whole view over, footer and strip included.
  const takeover = mergeTakeover || updateTakeover;
  const headIsCurrent =
    pr !== undefined && status.data?.branch?.name === pr.head;
  const headDirty = headIsCurrent && hasTrackedChanges;
  // The merge strip's conflict prediction. A read-only merge-tree run, so it runs
  // for every open PR, approved or not, and whatever blocks Merge.
  const conflictPreview = useConflictPreview(
    repoPath,
    pr?.base ?? "",
    pr?.head ?? "",
    pr?.status === "open",
  );
  const defaultBranch = useDefaultBranch(repoPath);

  // Everything from here to the early return feeds a hook argument, so it is
  // declared above that return (a const below it would be in its dead zone).
  const isSelectedPr = selectedPr?.kind === "local" && selectedPr.id === id;
  // A promotion pull request (main → staging) stays permanently behind its base,
  // and "Update branch" would merge the base back INTO the head, inverting the
  // flow. The head IS the default branch (a name comparison: a topology probe
  // false-positives on stacked PRs), or the repo's rules name it a promotion
  // branch. The kind decides the strip's promotion line and withholds the update.
  const promotionKind: PromotionKind = (() => {
    switch (true) {
      case pr !== undefined &&
        !!defaultBranch.data &&
        pr.head === defaultBranch.data:
        return "default";
      case pr !== undefined && isPromotionBranch(rulesConfig, pr.head):
        return "configured";
      default:
        return null;
    }
  })();
  const behindBy = comparison.data?.behind.length;
  // From the pending writes, not `runningUpdate`: that is only the FIRST pending
  // update-from, and the branch switcher runs the same write.
  const thisUpdateSettling =
    updateSettlingFor?.repo === repoPath && updateSettlingFor.id === pr?.id;
  if (recoveringFor !== null && !recoveringFor.ran && recovery.pending)
    setRecoveringFor({ ...recoveringFor, ran: true });
  const recoverySettling =
    recoveringFor?.repo === repoPath &&
    recoveringFor.id === pr?.id &&
    (recoveringFor.ran || recovery.pending);
  // A remounted view's slot and observer start empty, so the compound itself is
  // also matched in the cache: it merges this base into the checked-out head.
  const recoveryCompoundRunning =
    pr !== undefined &&
    headIsCurrent &&
    pendingWriteMatching(
      autostashWrites,
      "merge",
      (ref: unknown) => ref === pr.base,
    ) !== undefined;
  const recoveryRead =
    recoveringFor?.ran && !recovery.pending ? recoveringFor : null;
  const settleRecovery = useEffectEvent(
    (target: NonNullable<typeof recoveringFor>) => {
      void refetchStripReads(target).finally(() =>
        setRecoveringFor((cur) => (cur === target ? null : cur)),
      );
    },
  );
  useEffect(() => {
    if (recoveryRead) settleRecovery(recoveryRead);
  }, [recoveryRead]);
  // A finish moves this head too, and its reads settle after the record clears.
  const resolveSettling =
    resolveSettlingFor?.repo === repoPath && resolveSettlingFor.id === pr?.id;
  const thisUpdateRunning =
    pr !== undefined &&
    (thisUpdateSettling ||
      recoverySettling ||
      recoveryCompoundRunning ||
      resolveSettling ||
      finishingUpdate ||
      localWrites.some(
        (w) =>
          w.kind === "update-from" && w.head === pr.head && w.base === pr.base,
      ));
  // One reason holds Resolve, Continue and Discard together; while an update is
  // unfinished it carries only holds that block all three, so Discard stays
  // reachable on a dirty tree.
  const resolveHeldReason = (() => {
    switch (true) {
      // While its start runs the start button says "Preparing…" itself, never a
      // later reason; a record that lands meanwhile holds Discard and Continue.
      case preparing:
        return activeUpdate !== undefined ? UPDATE_PREPARING_REASON : undefined;
      case discardingUpdate:
        return "Discarding this update…";
      case finishingUpdate:
        return "Finishing this update…";
      case activeUpdate !== undefined:
        return undefined;
      case runningMerge?.head != null && runningMerge.base != null:
        return `Merging ${runningMerge.head} into ${runningMerge.base}…`;
      case runningMerge !== undefined:
        return "Merging…";
      case thisUpdateRunning:
        return "Updating this branch…";
      case runningUpdate?.head != null && runningUpdate.base != null:
        return `Updating ${runningUpdate.head} from ${runningUpdate.base}…`;
      case runningUpdate !== undefined:
        return "Updating a branch…";
      case otherStart:
        return "Another conflict resolution is being prepared…";
      case recovery.pending:
        return "Another git operation is running.";
      case headDirty:
        return RESOLVE_DIRTY_HEAD;
      default:
        return undefined;
    }
  })();
  const resolveNote = pr?.approved
    ? `${updateOperation(pr.base, pr.head)}. Finishing clears the approval.`
    : undefined;
  const resolveSlot: LocalStripResolve | null =
    pr === undefined
      ? null
      : {
          unfinished: activeUpdate !== undefined,
          preparing,
          heldReason: resolveHeldReason,
          note: resolveNote,
          onResolve: () =>
            activeUpdate ? openUpdateEditor() : void doStartResolve(),
          onDiscard: () => void doDiscardUpdate(),
        };
  const strip = localMergeStripArm({
    isOpen: pr?.status === "open",
    preview: {
      enabled: pr !== undefined && pr.base !== "" && pr.head !== "",
      isPending: conflictPreview.isPending,
      isError: conflictPreview.isError,
      data: conflictPreview.data,
    },
    comparison: {
      enabled: pr !== undefined && pr.base !== pr.head,
      isPending: comparison.isPending,
      behindBy,
    },
    promotionKind,
    promotionSettling: defaultBranch.isPending || rulesSettling,
    updating: thisUpdateRunning,
    resolve: resolveSlot,
  });
  // PENDING only (neither read is ever disabled): a FAILED read falls open to an
  // ordinary PR instead of holding forever behind a stale "checking…".
  const promotionSettlingReason = (() => {
    switch (true) {
      case !strip.awaitingPromotion:
        return undefined;
      case defaultBranch.isPending:
        return AWAITING_DEFAULT_BRANCH_REASON;
      default:
        return AWAITING_PROMOTION_RULES_REASON;
    }
  })();
  const canStartResolve =
    strip.offerResolve &&
    !preparing &&
    resolveHeldReason === undefined &&
    promotionSettlingReason === undefined &&
    !pr?.pendingMerge?.worktreePath;
  const updateHeldReason = (() => {
    switch (true) {
      case thisUpdateRunning:
        return "Updating this branch…";
      case preparing:
        return UPDATE_PREPARING_REASON;
      case discardingUpdate:
        return "Discarding this update…";
      case activeUpdate !== undefined:
        return UPDATE_UNFINISHED_REASON;
      case runningUpdate?.head != null && runningUpdate.base != null:
        return `Updating ${runningUpdate.head} from ${runningUpdate.base}…`;
      case runningUpdate !== undefined:
        return "Updating a branch…";
      case recovery.pending:
        return "Another git operation is running.";
      default:
        return promotionSettlingReason;
    }
  })();
  const canUpdateBranch = strip.offerUpdate && updateHeldReason === undefined;

  const threadActive =
    isSelectedPr && section === "conversation" && !!pr && !takeover;
  const jumpRef = useThreadJumpHotkeys(threadActive);
  // The palette's route to the comment box. Every term the composer itself is
  // gated on rides here too: a paused merge takes the whole view over, and the
  // other sub-tabs have no composer.
  useHotkeyAction(
    "focus-comment",
    () => composerRef.current?.focus(),
    threadActive,
  );
  // The strip's Update branch, from the palette: the same refusal as the button.
  useHotkeyAction(
    "pr-update-branch",
    () => void doUpdateBranch(),
    isSelectedPr && pr !== undefined && !takeover && canUpdateBranch,
  );
  // The strip's Resolve conflicts / Continue resolving, from the palette: the same
  // refusals as the buttons.
  useHotkeyAction(
    "pr-resolve-conflicts",
    () => resolveSlot?.onResolve(),
    isSelectedPr &&
      pr !== undefined &&
      !takeover &&
      (canStartResolve ||
        (strip.arm === "resume" && resolveHeldReason === undefined)),
  );
  // Where focus lands when an update's takeover swaps in or out under it: the
  // control that held it unmounts with the view it sat in.
  const viewSinkRef = useRef<HTMLSpanElement>(null);
  useFocusOnControlsSwap(updateTakeover, viewSinkRef);

  // Off while an early return paints instead: no PR, or a takeover, which renders
  // its own view in place of this bar.
  const actionBarRef = useRef<HTMLDivElement>(null);
  useToastClearance(actionBarRef, !!pr && !takeover);

  if (!pr) {
    return (
      <DiffPlaceholder message="This local pull request no longer exists" />
    );
  }

  const updateHold = pendingWriteMatching(
    storeWrites,
    "update",
    (v: { id: string }) => v.id === pr.id,
  );
  const ownsSlot = (slot: { repo: string; id: string } | null) =>
    slot?.repo === repoPath && slot.id === pr.id;
  const statusHeld = updateHold !== undefined || ownsSlot(statusSavingFor);
  const reviewPosting = updateHold !== undefined || ownsSlot(postingReviewFor);
  // The click slot covers the instant before the cache notice; the cache read keeps the
  // hold across a remount (this view unmounts on a local -> remote -> local hop).
  const approveHeld =
    ownsSlot(approveSavingFor) ||
    pendingWriteMatching(
      storeWrites,
      "update",
      (v: ApprovalWriteVars) =>
        v.id === pr.id && typeof v.approved === "boolean",
    ) !== undefined;

  const ahead = comparison.data?.ahead ?? [];

  // AI title+description generation — shared by the Edit dialog's Generate button
  // and its mod+g chord. Verbatim the button's prior onClick body. `pr` is aliased
  // to a narrowed const so the (hoisted) function body sees it as defined.
  const prForGen = pr;
  function runGenerate() {
    // Local PRs have real local branches — the base..head branch-diff path works,
    // and (like create) keeps base GitHub prompt wording (no provider) and
    // proposes no labels. The trailing args are reviewer notes (none on an edit)
    // and the grounded issue candidates.
    prGen.generate(
      prForGen.base,
      prForGen.head,
      ahead.map((c) => c.subject),
      (d) => {
        edit.form.setFieldValue("title", d.title);
        edit.form.setFieldValue("body", d.body);
        // Union the model's proposed issue links into the chip cluster (same
        // rules as create — relate-default, dismissed-set, AI sparkle).
        upsertAiIssues({ closes: d.closes, relates: d.relates });
      },
      undefined,
      [],
      undefined,
      buildIssueCandidates(),
    );
  }
  const fileCount = diffFiles.data?.length;
  // Shared JiraRefRow sources for both header branches (conflict-takeover +
  // normal) so the two can't diverge. Branch name LAST so title/description
  // attribution wins a key that also appears in the branch name.
  const jiraRefSources = [
    { label: "title", text: pr.title },
    { label: "description", text: pr.body },
    { label: "branch name", text: pr.head },
  ];

  async function toggleApprove() {
    if (!pr || approveHeld) return;
    // An absolute value read at click, not a flip of whatever is stored, and not
    // optimistic: Merge's gate must rest on the stored record.
    const next = !pr.approved;
    const mine = { repo: repoPath, id: pr.id };
    setApproveSavingFor(mine);
    // `approved` names the write as an approval change for the hold's cache read.
    const vars: ApprovalWriteVars = {
      id: pr.id,
      mutate: (cur) => ({ ...cur, approved: next }),
      approved: next,
    };
    try {
      await update.mutateAsync(vars);
    } catch (e) {
      toastError(e);
    } finally {
      setApproveSavingFor((cur) => (cur === mine ? null : cur));
    }
  }

  // A typed note rides Close/Reopen rather than being discarded by them.
  const draftRidesStateChange = !!comment.trim();

  /** Close/Reopen, carrying any typed note. The note is appended in the SAME
   *  record mutation as the status flip, so the store can never persist one
   *  without the other; the draft clears only once that write lands. */
  async function setStatus(next: "open" | "closed") {
    // Appending the note makes this non-idempotent, and the mutate callback
    // re-reads the record from disk — so a second click lands after the first
    // note is already stored and would post it twice.
    if (!pr || statusHeld || (next === "closed" && (preparing || activeUpdate)))
      return;
    const note = comment.trim();
    const mine = { repo: repoPath, id: pr.id };
    setStatusSavingFor(mine);
    try {
      await update.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({
          ...cur,
          comments: note
            ? [
                ...cur.comments,
                {
                  id: crypto.randomUUID(),
                  body: note,
                  createdAt: new Date().toISOString(),
                },
              ]
            : cur.comments,
          status: next,
          closedAt: next === "closed" ? new Date().toISOString() : undefined,
        }),
      });
      setComment("");
    } catch (e) {
      // Nothing was written, the note included — say so rather than leave a
      // silent no-op behind a button that promised to post it.
      toastError(e);
    } finally {
      setStatusSavingFor((cur) => (cur === mine ? null : cur));
    }
  }

  function openEdit() {
    if (!pr) return;
    // The chips OWN the trailing ref block: peel any exact `Closes #N` /
    // `Relates to #N` lines off the end of the body into chips (keyword
    // preserved) and open the editor with the STRIPPED text. On save the block is
    // re-appended from chips. With the tracker unavailable there are no chips.
    if (canLinkIssues) {
      const { text, refs } = splitBodyRefBlock(pr.body, "native");
      edit.openEdit({ title: pr.title, body: text });
      resetLinkedIssues(refs);
    } else {
      edit.openEdit({ title: pr.title, body: pr.body });
    }
  }

  // Awaited, not per-call callbacks: this view's effects tear down when the
  // selection or the repo tab changes, and react-query drops per-call callbacks
  // once the observer has no listeners. Here that would lose a landed merge's
  // record write (it would still read open) or a refused merge's discard.
  async function doMerge(strategy: MergeStrategy) {
    // Any local merge in flight refuses another: they share the refs it advances.
    if (!pr || runningMerge || preparing || activeUpdate) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    // The merge advances base without the network lock, so only a push of
    // base itself holds it.
    const current = status.data?.branch?.name ?? null;
    if (refuseWhileBranchPushes(queryClient, repoPath, pr.base, current))
      return;
    const message = pr.body.trim() ? `${pr.title}\n\n${pr.body}` : pr.title;
    try {
      const outcome = await merge.mutateAsync({
        id: pr.id,
        base: pr.base,
        head: pr.head,
        message,
        strategy,
      });
      if (outcome.status === "merged") {
        // The record write is awaited ahead of its toast: a store write can
        // reject (a concurrent MCP writer, a locked store), and a merge
        // reported as landed while the record still reads open is the exact
        // desync this view has no second chance to repair.
        await update.mutateAsync({
          id: pr.id,
          mutate: (cur) => ({
            ...cur,
            status: "merged",
            mergedAt: new Date().toISOString(),
          }),
        });
        toast.success(`${MERGED_VERB[strategy]} ${pr.head} into ${pr.base}`);
        return;
      }
      // Conflicts: the merge is paused in an isolated worktree (the user's
      // branch and working tree are untouched), and the mutation recorded it on
      // the PR, so this view swaps to the in-place ResolveConflictsView. A record
      // that closed, gained another window's paused merge, or gained an update
      // meanwhile was kept as it is, and only this merge's worktree is discarded:
      // the resolutions exclude each other.
      if (outcome.refused !== null) {
        const copy = MERGE_REFUSED[outcome.refused];
        let aborted: LocalPrMergeAbortOutcome;
        try {
          aborted = await abortMerge.mutateAsync({
            worktreePath: outcome.worktreePath,
            opId: outcome.opId,
          });
        } catch (e) {
          toastErrorWithNote(e, copy.abortFailed);
          return;
        }
        // The just-minted worktree is registered, so a removal always closes its
        // entry: only whether the worktree went decides the words.
        toastError(
          new Error(aborted.removed ? copy.message : copy.abortFailed),
        );
        return;
      }
      toast.warning("Merge has conflicts — resolve them to finish");
    } catch (e) {
      toastError(e);
    }
  }

  /** The strip's "Update branch" action, also the palette's. Awaited because the
   *  dirty-tree refusal reaches the stash-and-reapply prompt only through this
   *  rejection; dropping it on teardown would withdraw the offer entirely. */
  async function doUpdateBranch() {
    if (!pr || !canUpdateBranch) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    // An in-place update (head is the current branch) also queues on the
    // network lock behind any push of this checkout, as BranchSwitcher's does.
    const current = status.data?.branch?.name ?? null;
    if (
      refuseWhileBranchPushes(queryClient, repoPath, pr.head, current) ||
      (pr.head === current && refuseWhilePushRuns(queryClient, repoPath))
    ) {
      return;
    }
    const mine = { repo: repoPath, id: pr.id };
    const moved = { repo: repoPath, base: pr.base, head: pr.head };
    setUpdateSettlingFor(mine);
    try {
      const outcome = await updateBranchFrom.mutateAsync({
        branch: pr.head,
        base: pr.base,
      });
      toast.success(
        outcome.outcome === "up-to-date"
          ? `${pr.head} is already up to date with ${pr.base}`
          : `Updated ${pr.head} from ${pr.base}`,
      );
      await refetchStripReads(moved);
    } catch (e) {
      // Only an in-place update (head IS the current branch) can be refused
      // over uncommitted changes — the throwaway worktree path is always
      // clean. Anything else toasts.
      if (
        status.data?.branch?.name === pr.head &&
        recovery.handleError(e, {
          operationLabel: "update",
          detail: pr.base,
          reappliedMessage: `Updated from ${pr.base} and reapplied your changes.`,
          plainMessage: `Updated ${pr.head} from ${pr.base}`,
          run: { op: "merge", ref: pr.base },
        })
      ) {
        setRecoveringFor({ ...moved, id: mine.id, ran: false });
        return;
      }
      toastError(e);
    } finally {
      setUpdateSettlingFor((cur) => (cur === mine ? null : cur));
    }
  }

  /** Re-reads the strip's prediction and comparison for the PR a write moved, by
   *  that PR's keys: the view's observers follow a PR or repo switch, and an
   *  inactive query is only marked stale by the write's invalidation. Joins a
   *  refetch already running rather than cancelling it; a failed read resolves too
   *  and shows as failed. */
  function refetchStripReads(moved: {
    repo: string;
    base: string;
    head: string;
  }) {
    return Promise.all([
      queryClient.refetchQueries(
        {
          queryKey: conflictPreviewQueryKey(moved.repo, moved.base, moved.head),
          exact: true,
          type: "all",
        },
        { cancelRefetch: false },
      ),
      queryClient.refetchQueries(
        {
          queryKey: repoKeys.compare(moved.repo, moved.base, moved.head),
          exact: true,
          type: "all",
        },
        { cancelRefetch: false },
      ),
    ]);
  }

  /** Holds the strip as `updating` from the moment a resolve moved this head until
   *  its reads answer for the new tip. */
  function settleMovedHead(target: {
    repo: string;
    id: string;
    base: string;
    head: string;
  }) {
    const mine = { repo: target.repo, id: target.id };
    setResolveSettlingFor(mine);
    void refetchStripReads(target).finally(() =>
      setResolveSettlingFor((cur) => (cur === mine ? null : cur)),
    );
  }

  /** Resolve conflicts, from the strip or the palette. The record write and the
   *  list re-read run inside the mutation; the editor opens only for the PR and repo
   *  it started on, and only when the user did nothing else meanwhile. */
  async function doStartResolve() {
    if (!pr || !canStartResolve) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    useUiStore.getState().noteUserInteraction();
    const started = { repo: repoPath, id: pr.id, base: pr.base, head: pr.head };
    const epoch = useUiStore.getState().interactionEpoch;
    const slot = { repo: started.repo, id: started.id };
    setStartingFor(slot);
    try {
      const result = await startUpdate.mutateAsync({
        id: started.id,
        base: started.base,
        head: started.head,
      });
      const away = landedIn(started.repo).away;
      if (result.status === "updated") {
        settleMovedHead(started);
        toast.success(
          updatedToast(
            started.head,
            started.base,
            result.approvalCleared,
            away,
          ),
        );
        if (result.recordError)
          toastError(
            new Error(
              `Updated ${started.head} from ${started.base}, but couldn't update the pull request record: ${result.recordError}`,
            ),
          );
        return;
      }
      toast.warning(updateConflictsToast(started.head, started.base, away));
      if (useUiStore.getState().interactionEpoch === epoch)
        setUpdateEditor((cur) =>
          cur?.repo === started.repo && cur.id === started.id
            ? { ...cur, open: result.worktreeId }
            : cur,
        );
    } catch (e) {
      toastError(e);
    } finally {
      setStartingFor((cur) => (cur === slot ? null : cur));
    }
  }

  /** Continue resolving: reopens the editor over the unfinished update. */
  function openUpdateEditor() {
    if (!pr || !activeUpdate) return;
    useUiStore.getState().noteUserInteraction();
    setUpdateEditor({
      repo: repoPath,
      id: pr.id,
      open: activeUpdate.worktreeId,
    });
  }

  /** Back to PR: leaves the editor; the update and its worktree stay. */
  function closeUpdateEditor() {
    useUiStore.getState().noteUserInteraction();
    setUpdateEditor((cur) => (cur ? { ...cur, open: null } : cur));
  }

  /** The strip's Discard, confirmed. The confirm is repo-scoped: a repository
   *  switch while it is open answers no. */
  async function doDiscardUpdate() {
    if (!pr || !activeUpdate) return;
    const target = {
      ...activeUpdate,
      repo: repoPath,
      id: pr.id,
      head: pr.head,
    };
    const moved = { repo: repoPath, id: pr.id, base: pr.base, head: pr.head };
    if (!(await useConfirm.getState().ask(DISCARD_UPDATE_CONFIRM))) return;
    useConflictResolve.getState().retire(target.worktreePath);
    try {
      const result = await discardUpdate.mutateAsync({
        id: target.id,
        head: target.head,
        worktreePath: target.worktreePath,
        worktreeId: target.worktreeId,
        opId: target.opId,
        journalRepo: target.journalRepo,
      });
      if (result.status === "updated") settleMovedHead(moved);
      toast.success(
        discardSettledToast(
          result,
          target.head,
          target.base,
          landedIn(target.repo).away,
        ),
      );
    } catch (e) {
      toastError(e);
    }
  }

  /** The strip's Retry: the comparison too when its read failed, so the behind
   *  clause can return without waiting for an invalidation. */
  function onRetry() {
    void conflictPreview.refetch();
    if (comparison.isError) void comparison.refetch();
  }

  // Focus's landing on either side of an update takeover, named for where it is.
  const viewSink = (
    <span
      ref={viewSinkRef}
      tabIndex={-1}
      role="group"
      aria-label={updateTakeover ? "Conflict editor" : "Pull request"}
      className="sr-only"
    />
  );

  // A paused merge (into the base) or a paused update (base into head) takes over
  // the whole PR view: the work lives in an isolated worktree, and
  // ResolveConflictsView drives its file list, editor and Finish in place of the
  // PR's sections, strip and footer actions. One header serves both.
  if (takeover) {
    return (
      <div className="flex h-full flex-col">
        {viewSink}
        <header className="space-y-2 border-b px-4 py-3">
          <DetailTitleRow heading={pr.title}>
            <Badge variant="secondary" className="capitalize">
              {pr.status}
            </Badge>
          </DetailTitleRow>
          <JiraRefRow repoPath={repoPath} sources={jiraRefSources} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{pr.head}</span>
            <span>→</span>
            <span className="font-mono">{pr.base}</span>
            <span>•</span>
            <span>
              local · <RelativeTime date={pr.createdAt} />
            </span>
          </div>
        </header>
        <ResolveConflictsView
          repoPath={repoPath}
          pr={pr}
          mode={mergeTakeover ? "merge" : "update"}
          finishHeldReason={
            !mergeTakeover && headDirty ? RESOLVE_DIRTY_HEAD : undefined
          }
          onBack={mergeTakeover ? undefined : closeUpdateEditor}
          onHeadMoved={settleMovedHead}
        />
      </div>
    );
  }

  // The Merge control's state. `disabled`/`reason` land on the rendered
  // DisabledReasonButton, never the trigger — its own inner useButton swallows
  // activation while blocked, which is what actually keeps the menu shut.
  // A local merge advances refs every local PR shares (and touches the working tree
  // when its base is the current branch), so any running local merge holds this
  // PR's Merge too — only the wording is scoped, naming that merge.
  // `canMerge` reads the stored record, so an approval change still saving holds
  // Merge too: a withdrawal in flight must not leave the PR mergeable.
  const mergeBlocked =
    !canMerge ||
    runningMerge !== undefined ||
    dirtyBlocks ||
    approveHeld ||
    preparing ||
    activeUpdate !== undefined;
  // This same string doubles as the hover title while nothing blocks. The
  // active merge outranks `dirtyBlocks`: a merge already in flight can't be
  // unblocked by committing or stashing, so a dirty tree that shows up mid-merge
  // must not override "Merging…" with a remedy that doesn't apply.
  // A resolve preparing or unfinished outranks approval: approving wouldn't unblock it.
  // A merge in flight outranks approval too, which can't stop it. An approval change
  // still saving outranks the stored record's verdict on it.
  const mergeReason = (() => {
    switch (true) {
      case preparing:
        return UPDATE_PREPARING_REASON;
      case activeUpdate !== undefined:
        return UPDATE_UNFINISHED_REASON;
      case runningMerge?.head === pr.head && runningMerge.base === pr.base:
        return "Merging…";
      case runningMerge?.head != null && runningMerge.base != null:
        return `Merging ${runningMerge.head} into ${runningMerge.base}…`;
      case runningMerge !== undefined:
        return "Merging…";
      case approveHeld:
        return "Saving…";
      case !canMerge:
        return MERGE_NEEDS_APPROVAL;
      case dirtyBlocks:
        return MERGE_DIRTY_TREE;
      default:
        return `Merge ${pr.head} into ${pr.base}`;
    }
  })();

  // Close and Publish both end the open PR, so an update preparing or unfinished
  // holds them; its Discard sits in the strip above.
  const resolveBlocksClose = preparing || activeUpdate !== undefined;
  const closeReason = (() => {
    switch (true) {
      case statusHeld:
        return "Saving…";
      case preparing:
        return UPDATE_PREPARING_REASON;
      default:
        return UPDATE_UNFINISHED_REASON;
    }
  })();

  return (
    <div className="flex h-full flex-col">
      {viewSink}
      <header className="space-y-2 border-b px-4 py-3">
        <DetailTitleRow heading={pr.title}>
          {pr.status === "open" && (
            <Button
              variant="outline"
              size="xs"
              onClick={openEdit}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
          )}
          <Badge
            variant={pr.status === "open" ? "default" : "secondary"}
            className="capitalize"
          >
            {pr.status}
          </Badge>
          {pr.approved && pr.status === "open" && (
            <Badge variant="secondary">approved</Badge>
          )}
          {pr.archived && <Badge variant="secondary">archived</Badge>}
        </DetailTitleRow>
        <JiraRefRow repoPath={repoPath} sources={jiraRefSources} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{pr.head}</span>
          <span>→</span>
          <span className="font-mono">{pr.base}</span>
          <span>•</span>
          <span>
            local · <RelativeTime date={pr.createdAt} />
          </span>
        </div>
        {(pr.labels.length > 0 || pr.status === "open") && (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Trigger first, so it never shifts as chips come and go. */}
            {pr.status === "open" && (
              <Popover.Root>
                <Popover.Trigger
                  render={
                    <Button variant="ghost" size="xs" aria-label="Add label" />
                  }
                >
                  <TagIcon data-icon="inline-start" />
                  Labels
                </Popover.Trigger>
                <Popover.Portal container={portalContainer}>
                  <Popover.Positioner
                    align="start"
                    sideOffset={4}
                    className="isolate z-50"
                  >
                    <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                      <p className="px-1 pb-1.5 text-xs font-medium">
                        Add label
                      </p>
                      <div className="flex gap-2 px-1">
                        <Input
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addLabel();
                            }
                          }}
                          placeholder="e.g. bug, refactor"
                          className="h-7 flex-1"
                          autoComplete="off"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!labelInput.trim()}
                          onClick={addLabel}
                        >
                          Add
                        </Button>
                      </div>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
            {pr.labels.map((label) => (
              <span
                key={label}
                className="flex items-center gap-1 border px-1.5 py-0.5 text-[11px]"
              >
                {label}
                {pr.status === "open" && (
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeLabel(label)}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1 pt-1">
          {availableSections.map((s) => (
            <Button
              key={s}
              variant={section === s ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={section === s}
              onClick={() => pickSection(s)}
            >
              {SECTION_LABEL[s]({
                comments: pr.comments.length,
                commits: ahead.length,
                files: fileCount,
              })}
            </Button>
          ))}
        </div>
      </header>

      <LocalPrMergeStrip
        arm={strip.arm}
        base={pr.base}
        head={pr.head}
        promotionKind={promotionKind}
        behindBy={behindBy ?? 0}
        conflictFiles={
          conflictPreview.data?.status === "conflict"
            ? conflictPreview.data.conflicts
            : []
        }
        approved={pr.approved}
        offerUpdate={strip.offerUpdate}
        offerResolve={strip.offerResolve}
        updateHeldReason={updateHeldReason}
        promotionSettlingReason={promotionSettlingReason}
        onUpdateBranch={() => void doUpdateBranch()}
        onRetry={onRetry}
        retryBusy={conflictPreview.isFetching}
        resolve={resolveSlot}
      />

      {aiEnabled && section === "review" && (
        <PrReviewPanel
          prKind="local"
          prRef={id}
          context={{
            title: pr.title,
            body: pr.body,
            commitSubjects: ahead.map((c) => c.subject),
            repoPath,
            // A local PR has no forge lens; "origin" keeps its per-PR review stores
            // on the keys they used before the lens dimension existed.
            lens: "origin",
            // `ahead` (git log) is newest-first, so the head is the first entry.
            headSha: ahead[0]?.hash,
            loadDiff: () =>
              gitBranchDiff(repoPath, pr.base, pr.head, 200000).then((d) => ({
                text: d.text,
                truncated: d.truncated,
                files: d.files,
              })),
          }}
          posting={reviewPosting}
          // The body arrives pre-branded from the panel; stamp the synthetic
          // author so it renders as a GitDesktop-posted review, not authorless.
          // `opts` (asBot) is a remote-forge concern — ignored for local PRs.
          onPost={async (body) => {
            const mine = { repo: repoPath, id: pr.id };
            setPostingReviewFor(mine);
            try {
              await update.mutateAsync({
                id: pr.id,
                mutate: (cur) => ({
                  ...cur,
                  comments: [
                    ...cur.comments,
                    {
                      id: crypto.randomUUID(),
                      body,
                      author: "GitDesktop",
                      createdAt: new Date().toISOString(),
                    },
                  ],
                }),
              });
            } catch (e) {
              toastError(e);
              throw e; // let the panel skip its success toast / text clear
            } finally {
              setPostingReviewFor((cur) => (cur === mine ? null : cur));
            }
          }}
        />
      )}

      {section === "conversation" && (
        <>
          <ConversationScrollArea ref={jumpRef} className="flex-1">
            <div className="space-y-4 p-4">
              <div className="group flex items-start justify-between gap-2 border-b pb-3">
                <div className="min-w-0 flex-1">
                  {pr.body.trim() ? (
                    <Markdown refs={mentions.refs}>{pr.body}</Markdown>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No description.
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
                    <DropdownMenuItem onClick={() => quoteReply(pr.body)}>
                      Quote reply
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => copyText(pr.body, "Markdown copied")}
                    >
                      Copy markdown
                    </DropdownMenuItem>
                    {pr.status === "open" && (
                      <DropdownMenuItem onClick={openEdit}>
                        Edit
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {/* The merged activity feed: the created lifecycle marker +
                  commits + comments + a merged/closed marker, date-sorted
                  oldest→newest (matching the remote PR timeline). Each source
                  maps to a {date, sortKey, node} entry — comments keep every
                  callback they had before (they're relocated, not rewritten);
                  commits ride as bare markers that coalesce into a grouped
                  "pushed N commits" row. There's always a created row, so the
                  feed is never empty. */}
              {(() => {
                const entries: TimelineEntry[] = [];

                // Created — always present (there's always a createdAt).
                entries.push({
                  date: pr.createdAt,
                  sortKey: 0,
                  node: (
                    <LocalPrLifecycleRow
                      key="lifecycle-created"
                      kind="created"
                      date={pr.createdAt}
                    />
                  ),
                });

                // Commits from `ahead` — carried as bare markers; adjacent runs
                // coalesce into a single "pushed N commits" row after sorting.
                for (const c of ahead) {
                  entries.push({
                    date: c.date,
                    sortKey: 1,
                    commit: {
                      id: c.hash,
                      subject: c.subject,
                      shortSha: c.hash.slice(0, 7),
                      author: c.author,
                      date: c.date,
                    },
                  });
                }

                // Comments (existing cards, every callback preserved).
                for (const c of pr.comments) {
                  entries.push({
                    date: c.createdAt,
                    sortKey: 2,
                    node: (
                      <LocalComment
                        key={c.id}
                        comment={c}
                        onQuote={() => quoteReply(c.body)}
                        onSaveEdit={(body) => editComment(c.id, body)}
                        onDelete={() => setDeletingCommentId(c.id)}
                        onHide={() => setCommentHidden(c.id, true)}
                        onUnhide={() => setCommentHidden(c.id, false)}
                        mentions={mentions}
                      />
                    ),
                  });
                }

                // Terminal lifecycle marker: merged, or closed (with a graceful
                // timestamp-less marker for older records that predate closedAt).
                if (pr.status === "merged") {
                  entries.push({
                    date: pr.mergedAt ?? "",
                    sortKey: 3,
                    node: (
                      <LocalPrLifecycleRow
                        key="lifecycle-merged"
                        kind="merged"
                        date={pr.mergedAt}
                      />
                    ),
                  });
                } else if (pr.status === "closed" && pr.closedAt) {
                  entries.push({
                    date: pr.closedAt,
                    sortKey: 3,
                    node: (
                      <LocalPrLifecycleRow
                        key="lifecycle-closed"
                        kind="closed"
                        date={pr.closedAt}
                      />
                    ),
                  });
                }

                // Coalesce adjacent commit markers into grouped "pushed N" rows;
                // everything else renders its own node.
                const rendered = coalesceCommitRuns(
                  sortTimeline(entries),
                  (run, runStart) => (
                    <PushedCommitsRow
                      key={`push-${runStart}-${run[0].id}`}
                      commits={run}
                      onSelectCommit={(hash) => {
                        setSelectedCommitHash(hash);
                        pickSection("commits");
                      }}
                    />
                  ),
                );

                return <div className="space-y-4">{rendered}</div>;
              })()}
            </div>
          </ConversationScrollArea>
          {/* Shown for closed PRs too, so you can comment / quote-reply after
              closing; approving stays open-only. */}
          <CommentComposer
            toastClearance
            ref={composerRef}
            value={comment}
            onChange={setComment}
            onSubmit={addComment}
            onClear={() => setComment("")}
            submitLabel="Comment"
            ariaLabel="Leave a note"
            placeholder="Leave a note…"
            mentions={mentions}
            actions={
              pr.status === "open" && (
                <ApproveToggle
                  approved={pr.approved}
                  held={approveHeld}
                  onToggle={() => void toggleApprove()}
                />
              )
            }
          />
        </>
      )}

      {section === "commits" &&
        (selectedCommitHash ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedCommitHash(null)}
                aria-label="Back to commits"
                className="-ml-2 h-7 text-muted-foreground hover:text-foreground"
              >
                ‹ Commits
              </Button>
            </div>
            {/* Local commits exist in the repo, so the full commit detail (with
                its actions menu — checkout/revert/cherry-pick/amend) applies. */}
            <div className="min-h-0 flex-1">
              <CommitDetailView repoPath={repoPath} hash={selectedCommitHash} />
            </div>
          </div>
        ) : (
          <CommitsList
            commits={ahead.map((c) => ({
              id: c.hash,
              subject: c.subject,
              shortSha: c.hash.slice(0, 7),
              author: c.author,
              date: c.date,
            }))}
            emptyMessage="No commits to merge."
            onSelect={setSelectedCommitHash}
            selectedId={selectedCommitHash}
          />
        ))}

      {section === "files" && (
        <div className="min-h-0 flex-1">
          <BranchDiffView
            repoPath={repoPath}
            base={pr.base}
            compare={pr.head}
          />
        </div>
      )}

      <div
        ref={actionBarRef}
        className="flex flex-wrap items-center gap-2 border-t p-3"
      >
        {pr.status === "open" && (
          <>
            {/* Its own full-width line above the buttons: the reason is too long
                for the button row at narrow widths, and the docked footer grows
                upward, so Approve and Merge stay under the pointer. */}
            {mergeReason === MERGE_DIRTY_TREE && (
              <p className="flex basis-full items-start justify-end gap-1.5 text-xs text-muted-foreground">
                <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0">{MERGE_DIRTY_TREE}</span>
              </p>
            )}
            {forgeFeatureReady(ghStatus.data, "mrCreate") && (
              <DisabledReasonButton
                variant="outline"
                size="sm"
                disabled={resolveBlocksClose}
                reason={
                  preparing ? UPDATE_PREPARING_REASON : UPDATE_UNFINISHED_REASON
                }
                onClick={() => setPromoteOpen(true)}
                title={`Push the branch and open this ${promoteNoun} on ${promoteLabel}`}
              >
                {/* ProviderIcon forwards no attributes, so the wrapper carries the
                    `data-icon` the button's leading-icon padding keys off. An unset
                    provider takes the same GitHub default providerLabel does. */}
                <span data-icon="inline-start" className="flex">
                  <ProviderIcon provider={provider ?? "github"} />
                </span>
                Publish to {promoteLabel}
              </DisabledReasonButton>
            )}
            {/* The label swaps while a note rides along: the action changed
                meaning, and only the label reaches a viewer before the click. */}
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={statusHeld || resolveBlocksClose}
              reason={closeReason}
              onClick={() => void setStatus("closed")}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close"}
            </DisabledReasonButton>
            {/* One right-aligned group, so at a narrow pane Approve and Merge wrap
                together and stay under the reason line. */}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ApproveToggle
                approved={pr.approved}
                held={approveHeld}
                onToggle={() => void toggleApprove()}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <DisabledReasonButton
                      size="sm"
                      disabled={mergeBlocked}
                      reason={mergeReason}
                      title={mergeReason}
                    />
                  }
                >
                  <GitMergeIcon data-icon="inline-start" />
                  Merge
                  <CaretDownIcon data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    disabled={
                      !isMergeMethodAllowed(rulesConfig, pr.base, "merge")
                    }
                    onClick={() => void doMerge("merge")}
                  >
                    Create a merge commit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      !isMergeMethodAllowed(rulesConfig, pr.base, "squash")
                    }
                    onClick={() => void doMerge("squash")}
                  >
                    Squash and merge
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      !isMergeMethodAllowed(rulesConfig, pr.base, "rebase")
                    }
                    onClick={() => void doMerge("rebase")}
                  >
                    Rebase and merge
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
        {pr.status === "closed" && (
          <>
            <span className="flex-1" />
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={statusHeld}
              reason="Saving…"
              onClick={() => void setStatus("open")}
              title={
                draftRidesStateChange
                  ? "Reopens and posts your draft as a comment"
                  : undefined
              }
            >
              <ArrowCounterClockwiseIcon data-icon="inline-start" />
              {draftRidesStateChange ? "Reopen with comment" : "Reopen"}
            </DisabledReasonButton>
          </>
        )}
      </div>

      <PromoteLocalPrDialog
        repoPath={repoPath}
        pr={pr}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={(open) => {
          // The dialog stays mounted, so cancel any in-flight generation on close.
          if (!open) prGen.cancel();
          edit.setOpen(open);
        }}
        title="Edit pull request"
        description="Updates the title and description of this local pull request."
        contentClassName={undefined}
        bodyTextareaClassName="max-h-72"
        mentions={mentions}
        onGenerate={aiEnabled ? runGenerate : undefined}
        generating={prGen.generating}
        generateDisabled={ahead.length === 0}
        belowBody={
          canLinkIssues ? (
            <LinkedIssuesField
              repoPath={repoPath}
              lens="origin"
              chips={linkedIssues}
              onToggleKeyword={toggleIssueKeyword}
              onRemove={removeIssue}
              onPick={pickIssue}
              disabled={prGen.generating}
            />
          ) : undefined
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
              disabled={ahead.length === 0}
              onClick={runGenerate}
              // The chord is only offered while it would do something — a
              // disabled Generate's shortcut is dead too.
              title={
                ahead.length > 0
                  ? `Generate the title and description with AI${generateHint}`
                  : "Generate the title and description with AI"
              }
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
        description="Removes this comment from the local pull request. This cannot be undone."
        onConfirm={(commentId) => {
          deleteComment(commentId);
          setDeletingCommentId(null);
        }}
      />

      {recovery.dialog}
    </div>
  );
}
