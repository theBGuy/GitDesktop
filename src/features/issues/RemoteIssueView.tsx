import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { HeldFrame, heldParentProps } from "@/components/held-frame";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { Markdown } from "@/components/markdown/markdown";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import { ConversationScrollArea } from "@/features/conversations/ConversationScrollArea";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import {
  detailNoticeMessage,
  offlinePendingMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import {
  AuthorAvatar,
  hasVisibleBody,
  Thread,
} from "@/features/conversations/Thread";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { useThreadJumpHotkeys } from "@/features/conversations/useThreadJumpHotkeys";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import {
  sortTimeline,
  type TimelineEntry,
  TimelineEventRow,
} from "@/features/pulls/PrTimeline";
import { copyText } from "@/lib/clipboard";
import { entityKeyNumber, entityKeyScope } from "@/lib/entity-hold";
import { presentError } from "@/lib/error-summary";
import type { LockReason, MinimizeReason } from "@/lib/git/api";
import { useForgeGhHost } from "@/lib/git/host";
import {
  forgeFeatureReady,
  pendingIssueWrite,
  repoKeys,
  TRIAGE_ACCESS_ITEM_REASON,
  triageAccessReason,
  useCloseIssue,
  useCommentIssue,
  useDeleteIssue,
  useDeleteIssueComment,
  useEditIssue,
  useEditIssueComment,
  useForgeStatus,
  useGhRepos,
  useGlMemberProjects,
  useIssueDependencies,
  useIssueDetails,
  useIssueDevelopment,
  useIssueReactions,
  useIssueRelations,
  useIssueTimeline,
  useLockIssue,
  useMinimizeComment,
  usePendingIssueWrites,
  usePinIssue,
  useReopenIssue,
  useRepoWriteAccess,
  useToggleReaction,
  useTransferIssue,
  useUnlockIssue,
  useUnminimizeComment,
  WRITE_ACCESS_ITEM_REASON,
  writeAccessReason,
} from "@/lib/git/queries";
import {
  type IssueInfo,
  providerLabel,
  type RemoteLens,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  COMMENT_DELETE_PENDING_REASON,
  COMMENT_POST_PENDING_REASON,
  OFFLINE_ITEM_REASON,
  pendingItemReason,
  pendingWriteReason,
  RIDING_COMMENT_CLOSE_HELD,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { lensKey, useRepoLens } from "@/lib/repo-lens/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { refuseIfSwitched, repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useEntityHold, useRevealGuard } from "@/lib/use-entity-hold";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
import { useLatestRef } from "@/lib/use-latest-ref";
import { PlanIssueButton } from "../plan/PlanIssueButton";
import { readAnswered } from "../pulls/pr-section-answered";
import { SolveIssueButton } from "../sessions/SolveIssueButton";
import { IssueSubIssues } from "./IssueRelations";
import {
  DeleteIssueDialog,
  ISSUE_SWITCH_LOADING_REASON,
  IssueLoadingFrame,
  IssueSidebar,
  TransferIssueDialog,
} from "./RemoteIssueViewParts";

/** GitHub's lock reasons (menu label → API value); null locks with no reason. */
const LOCK_REASONS: [string, LockReason | null][] = [
  ["No reason", null],
  ["Off-topic", "off_topic"],
  ["Resolved", "resolved"],
  ["Spam", "spam"],
  ["Too heated", "too_heated"],
];

/** What the close prompt's title adds per route: GitHub's "not planned" close is
 *  a different act from a plain one, and only the title says so. */
const CLOSE_TITLE_QUALIFIER = {
  completed: "",
  not_planned: " as not planned",
} as const;

/** The issue's row in any cached list page of this repo and lens, read at
 *  render for the loading frame's title and state; undefined when no list
 *  holds it (an arrival from another tab). */
function cachedIssueRow(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  number: number,
): IssueInfo | undefined {
  for (const [key, rows] of queryClient.getQueriesData<IssueInfo[]>({
    queryKey: repoKeys.issueList(repo),
  })) {
    // `useIssueList`'s key: index 3 is the lens, and a fork numbers its
    // issues independently of its parent.
    if (key[3] !== lens || !Array.isArray(rows)) continue;
    const row = rows.find((r) => r.number === number);
    if (row) return row;
  }
  return undefined;
}

/**
 * Full read+write view for a GitHub issue: header, description, threaded
 * conversation, comment composer, label editor, close-with-reason / reopen, and
 * edit. Labels and comment edit/delete/hide reuse the PR GraphQL mutations,
 * which key off node ids and so work unchanged for issues.
 */
export function RemoteIssueView({
  repoPath,
  number,
}: {
  repoPath: string;
  number: number;
}) {
  // The read view is provider-neutral. The remaining GitHub-only mutations
  // (pin, sub-issues, close reason) route through `gh_*` commands and stay
  // gated on `canWrite` — "not a known read-only provider" rather than
  // `=== "github"`, so that while the (separate) forge-status query is still
  // pending or after it fails, a GitHub issue keeps its write controls exactly
  // as before — only an explicitly-detected GitLab/Bitbucket repo suppresses
  // them.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const remoteLabel = providerLabel(provider);
  // The single lens-resolution point for this surface (package B2): every issue
  // read/write below targets the fork (origin) or its parent (upstream).
  const lens = useRepoLens(repoPath);
  const queryClient = useQueryClient();
  // The viewer's permission on the lens repo — a PERMISSION axis the per-action
  // flags below don't cover, so it never hides a control: it only disables one,
  // and only on an explicit denial. Triage is its own, LOWER tier: labels,
  // assignees, milestones, hide-comments, close/reopen and the other
  // issue-metadata rows come with it without push, so those read `canTriage`;
  // pin, transfer, delete and branch creation are write-tier. Each blocked flag
  // derives from its reason so the two can never disagree.
  const writeAccess = useRepoWriteAccess(repoPath, lens, !!provider);
  const writeReason = writeAccessReason(writeAccess.data);
  const triageReason = triageAccessReason(writeAccess.data);
  const writeBlocked = !!writeReason;
  const triageBlocked = !!triageReason;
  // A disabled menu item drops pointer events, so its explanation goes in the
  // label; each suffix is empty whenever its axis allows the action.
  const triageItemReason = triageReason ? TRIAGE_ACCESS_ITEM_REASON : undefined;
  const writeItemReason = writeReason ? WRITE_ACCESS_ITEM_REASON : undefined;
  // Set while offline. Close, pin, lock and the transfer/delete confirms hold on
  // it at the press; the composer's writes are left to park, and
  // `composerReason` says so.
  const offlineHold = useOfflineHold();
  const itemSuffix = writeItemReason ? ` — ${writeItemReason}` : "";
  const triageSuffix = triageItemReason ? ` — ${triageItemReason}` : "";
  // GitLab WRITES land per-action. Each shared control is
  // `canWrite || forgeFeatureReady(...)` so GitHub keeps its controls while a
  // forge-status query is pending/failed (canWrite default-true) AND a ready GitLab
  // repo positively enables just these.
  const canComment = canWrite || forgeFeatureReady(forge.data, "issueComment");
  const canChangeState =
    canWrite || forgeFeatureReady(forge.data, "issueState");
  // Labels + assignees are shared controls (both providers) — same `canWrite || …`
  // gate: GitHub keeps them up while forge-status is pending, GitLab un-gates when ready.
  const canEditLabels =
    canWrite || forgeFeatureReady(forge.data, "issueLabels");
  const canEditAssignees =
    canWrite || forgeFeatureReady(forge.data, "issueAssignees");
  // Title/body editing and the milestone picker are shared controls too.
  const canEdit = canWrite || forgeFeatureReady(forge.data, "issueEdit");
  const canSetMilestone =
    canWrite || forgeFeatureReady(forge.data, "issueMilestone");
  // Lock, transfer/move, delete, and duplicate are shared "More actions" too;
  // pin stays GitHub-only via `canWrite`. GitLab locks without a reason and
  // "moves" instead of transferring — labels/submenus branch on the provider.
  const isGitLab = provider === "gitlab";
  // Locking is write-tier on GitHub but only Reporter (triage) on GitLab, so
  // the lock arms take their axis from the provider.
  const lockBlocked = isGitLab ? triageBlocked : writeBlocked;
  const lockSuffix = isGitLab ? triageSuffix : itemSuffix;
  const canLock = canWrite || forgeFeatureReady(forge.data, "issueLock");
  const canTransfer =
    canWrite || forgeFeatureReady(forge.data, "issueTransfer");
  const canDelete = canWrite || forgeFeatureReady(forge.data, "issueDelete");
  const canDuplicate = canWrite || forgeFeatureReady(forge.data, "issueCreate");
  // Confidential + due date are GitLab-UNIQUE (no GitHub analogue), so unlike
  // the shared controls above there's no `canWrite ||` arm — the flag alone
  // gates, and it's false for GitHub.
  const canSetConfidential = forgeFeatureReady(forge.data, "issueConfidential");
  const canSetDueDate = forgeFeatureReady(forge.data, "issueDueDate");
  // Time tracking + related issues are GitLab-unique too — flag alone gates.
  const canTrackTime = forgeFeatureReady(forge.data, "timeTracking");
  const canLinkIssues = forgeFeatureReady(forge.data, "issueLinks");
  // The selected issue's details. They answer the hold and start loading the
  // moment the selection moves, while the view still paints the issue it holds.
  const targetDetails = useIssueDetails(repoPath, number, lens);
  const mentions = useMentionCandidates({ repoPath, lens, provider });
  const comment = useCommentIssue(repoPath, lens);
  const closeIssue = useCloseIssue(repoPath, lens);
  const reopenIssue = useReopenIssue(repoPath, lens);
  const editIssue = useEditIssue(repoPath, lens);
  const editComment = useEditIssueComment(repoPath, lens);
  const deleteComment = useDeleteIssueComment(repoPath, lens);
  const minimizeComment = useMinimizeComment(repoPath);
  const unminimizeComment = useUnminimizeComment(repoPath);
  const pinIssue = usePinIssue(repoPath, lens);
  const lockIssue = useLockIssue(repoPath, lens);
  const unlockIssue = useUnlockIssue(repoPath, lens);
  const transferIssue = useTransferIssue(repoPath, lens);
  const deleteIssue = useDeleteIssue(repoPath, lens);
  // Pin and lock hold rather than park, like close: a parked one would change
  // the issue whenever the connection returns. Each menu item names its hold in
  // the label; the access axis outranks both, being the one no wait clears.
  // Read per issue from the cache, not the observers: this view outlives an
  // issue switch, and an observer tracks only its latest call, so a second
  // issue's write would hide the first's and let it send again.
  const pendingWrites = usePendingIssueWrites(repoPath);
  const pinning = pendingIssueWrite(
    pendingWrites,
    "pin",
    (v) => v.number === number && v.pinned,
  );
  const unpinning = pendingIssueWrite(
    pendingWrites,
    "pin",
    (v) => v.number === number && !v.pinned,
  );
  const locking = pendingIssueWrite(
    pendingWrites,
    "lock",
    (v) => v.number === number,
  );
  const unlocking = pendingIssueWrite(
    pendingWrites,
    "unlock",
    (v) => v === number,
  );
  const pinPending = pinning !== undefined || unpinning !== undefined;
  const lockPending = locking !== undefined || unlocking !== undefined;
  const pinHeld = (() => {
    switch (true) {
      case pinning !== undefined:
        return pendingItemReason(pinning.paused, "pinning…");
      case unpinning !== undefined:
        return pendingItemReason(unpinning.paused, "unpinning…");
      case !!offlineHold:
        return OFFLINE_ITEM_REASON;
      default:
        return undefined;
    }
  })();
  const lockHeld = (() => {
    switch (true) {
      case locking !== undefined:
        return pendingItemReason(locking.paused, "locking…");
      case unlocking !== undefined:
        return pendingItemReason(unlocking.paused, "unlocking…");
      case !!offlineHold:
        return OFFLINE_ITEM_REASON;
      default:
        return undefined;
    }
  })();
  const pinSuffix = itemSuffix || (pinHeld ? ` — ${pinHeld}` : "");
  const lockHeldSuffix = lockSuffix || (lockHeld ? ` — ${lockHeld}` : "");
  const selectIssue = useUiStore((s) => s.selectIssue);
  const openPr = useUiStore((s) => s.openPr);
  const repoName = useUiStore((s) => s.repoName);
  const liveRepoPath = useUiStore((s) => s.repoPath);
  const selectedIssue = useUiStore((s) => s.selectedIssue);
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  // Whether this view owns the current selection: the mounted view lags the
  // selection through a switch, and only the selected one may answer the palette.
  const isSelectedIssue =
    selectedIssue?.kind === "remote" && selectedIssue.id === String(number);
  // Reactions are a shared control (GitLab awards emoji); the fetch is gated so
  // it never fires for a provider whose reactions aren't wired (Bitbucket).
  const canReact = canWrite || forgeFeatureReady(forge.data, "issueReactions");
  // Editing/deleting your OWN comments is a shared control (GitHub + GitLab) —
  // same `canWrite || …` gate as comment CREATE above; the per-comment
  // `viewerDidAuthor` check narrows it to the author. Bitbucket issues aren't
  // wired, so `issueCommentEdit` is false there.
  const canEditOwnComments =
    canWrite || forgeFeatureReady(forge.data, "issueCommentEdit");
  // Activity-timeline events (labels, assignment, milestones, cross-references,
  // state changes) interleaved into the feed below; provider-neutral via the
  // backend's `forge_issue_timeline`. The composite gate is load-bearing: an
  // unresolved provider must not fetch, and Bitbucket issues aren't wired.
  const timelineEnabled = !!provider && provider !== "bitbucket";
  // Only a known GitHub repo is sure to carry the sub-issue, relationship and
  // development sections, so only there do they reserve their slots and hold
  // the swap until they answer.
  const githubRail = provider === "github";
  // The lens is part of the identity: it can collapse to "origin" without a
  // remount (upstream remote goes away), leaving the number pointing at another
  // repo.
  const issueIdentity = `${repoPath}#${lens}#${number}`;
  // The selected issue's feed and rail reads, observed here so the hold knows
  // when that issue can land whole; the view itself renders the SHOWN issue's.
  const selectedTimeline = useIssueTimeline(
    repoPath,
    number,
    timelineEnabled,
    lens,
  );
  const selectedRelations = useIssueRelations(
    repoPath,
    githubRail ? number : null,
    lens,
  );
  const selectedDependencies = useIssueDependencies(
    repoPath,
    githubRail ? number : null,
    lens,
  );
  const selectedDevelopment = useIssueDevelopment(
    repoPath,
    githubRail ? number : null,
    lens,
  );
  // Warms with the hold, so the reaction bars land in the swap, not after it.
  const selectedReactions = useIssueReactions(
    repoPath,
    canReact ? number : null,
    lens,
  );
  const targetOwn =
    targetDetails.data !== undefined && !targetDetails.isPlaceholderData;
  // A reveal that also moves the issue (openIssue from notifications, My work,
  // the Projects board, a markdown ref) paints the loading frame until the
  // deferred selection catches up, and never holds the issue it replaces: that
  // one was never on screen. The guard reads the hold's shown key from the
  // last step, since it runs before this render's.
  const issuesTabShown = useUiStore((s) => s.repoTab === "issues");
  const [lastShown, setLastShown] = useState(issueIdentity);
  const reveal = useRevealGuard({
    visible: issuesTabShown,
    liveKey:
      selectedIssue?.kind === "remote"
        ? `${repoPath}#${lens}#${selectedIssue.id}`
        : null,
    viewKey: issueIdentity,
    shownKey: lastShown,
  });
  // Through a switch the previous issue stays on screen, dimmed and inert, until
  // the selected one can replace it in one step or the bound runs out. A failed
  // details read lands at once: its error arm is the answer.
  const hold = useEntityHold({
    key: issueIdentity,
    settled:
      (targetDetails.isError && !targetOwn) ||
      (targetOwn &&
        (timelineEnabled ? readAnswered(selectedTimeline) : !forge.isPending) &&
        (!canReact || readAnswered(selectedReactions)) &&
        (!githubRail ||
          (readAnswered(selectedRelations) &&
            readAnswered(selectedDependencies) &&
            readAnswered(selectedDevelopment)))),
    // The issue on screen must be this repo's, under this lens: the number
    // alone means another issue elsewhere, so no hold spans a scope change.
    // Not the placeholder: a hover prefetch caches the target's details, and
    // the held paint is the shown issue's own details, read below.
    canHold: entityKeyScope(lastShown) === entityKeyScope(issueIdentity),
    paused: targetDetails.isPaused && !targetOwn,
    // Holds only when the tab was ALREADY visible and painted this view's
    // issue: an arrival with the tab shows the new issue directly. In-tab
    // moves keep holding.
    active: reveal.active,
  });
  if (lastShown !== hold.shownKey) setLastShown(hold.shownKey);
  // The issue on screen: the held one while holding, else the selection. Every
  // per-issue read the view RENDERS keys on it, so a held view never mixes in
  // parts of the issue loading behind it; writes keep addressing `number` and
  // hold through `detailsStale`.
  const shownIdentity = hold.shownKey;
  const shownNumber = entityKeyNumber(shownIdentity);
  const details = useIssueDetails(repoPath, shownNumber, lens);
  // The rendered details are another issue's placeholder: the loading and
  // offline arms, never a hold (the held issue's details are its own).
  const detailsPlaceholder = details.isPlaceholderData;
  // Handlers and in-menu items refuse on this; controls visible at rest read
  // `detailsPlaceholder` (see `staleReason`).
  const detailsStale = hold.holding || detailsPlaceholder;
  const reactions = useIssueReactions(
    repoPath,
    canReact ? shownNumber : null,
    lens,
  );
  const timeline = useIssueTimeline(
    repoPath,
    shownNumber,
    timelineEnabled,
    lens,
  );
  // Feed-constant, so it's read once here rather than per event row; the
  // repo-path variant avoids the active-repo hook's second store subscription.
  const ghHost = useForgeGhHost(repoPath);
  const toggleReactionMutation = useToggleReaction(repoPath, "issue");

  const composerRef = useRef<MarkdownEditorHandle>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDest, setTransferDest] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      await editIssue.mutateAsync({ number, title, body });
    },
    successToast: "Issue updated",
  });
  // A different issue must never inherit this one's open delete/transfer/edit
  // dialogs — a render-time state adjustment, not an effect. The SHOWN identity
  // keys the draft and the sidebar below, remounting its per-issue drafts.
  const compose = useKeyedEntityState(shownIdentity, "");
  const [lastIdentity, setLastIdentity] = useState(issueIdentity);
  if (issueIdentity !== lastIdentity) {
    setLastIdentity(issueIdentity);
    setDeletingCommentId(null);
    setDeleteOpen(false);
    setTransferOpen(false);
    setTransferDest("");
    edit.setOpen(false);
  }
  // Live identity for write continuations: one started on an issue the user has
  // since left must not close the next issue's dialogs.
  const issueIdentityRef = useLatestRef(issueIdentity);
  // Destination suggestions come from the viewer's repos on the SAME provider
  // as this repo; each query only fires while its dialog variant is open. The
  // GitLab list is repo-scoped so it targets the repo's own (possibly
  // self-managed) host, not glab's default.
  const transferRepos = useGhRepos(transferOpen && !isGitLab);
  const transferProjects = useGlMemberProjects(
    repoPath,
    transferOpen && isGitLab,
  );

  const onError = (e: unknown) => toastError(e);

  const issue = details.data;

  // The feed lands whole: comments and timeline events appear together once the
  // shown issue's timeline has answered, so no event inserts above a comment
  // after the fact. A DISABLED timeline never leaves pending, so with none
  // coming a settled forge probe stands in for it.
  // Reactions ride the same landing: the bars draw their chips before the
  // add button, so late counts would push it sideways. A disabled read
  // (`canReact` false) never answers, so it never holds anything.
  const reactionsReady = !canReact || readAnswered(reactions);
  const feedReady =
    reactionsReady &&
    (timelineEnabled ? readAnswered(timeline) : !forge.isPending);
  // The thread's hotkeys wait for the feed too: a jump would land on its
  // skeleton rows.
  const threadActive = isSelectedIssue && !!issue && !detailsStale && feedReady;
  const jumpRef = useThreadJumpHotkeys(threadActive);
  // The composer sits below the thread AND the sidebar, so reaching it by Tab
  // means crossing the whole rail — this is the keyboard route past it. Enabled
  // only while the box is actually on screen.
  useHotkeyAction(
    "focus-comment",
    () => composerRef.current?.focus(),
    threadActive && canComment,
  );

  const detailPane = resolveDetailPane({
    pending: details.isPending,
    error: details.isError,
    hasData: issue !== undefined,
    paused: details.isPaused,
    fetching: details.isFetching,
  });
  // A pressed Retry resets the never-loaded read to pending, swapping the error
  // for the skeleton. Every arm's root is the same host div, so React keeps that
  // node through the swap and on into the loaded issue, and focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    detailPane === "error" && details.isError,
  );
  // The loading frame stands in for the LIVE selection: through a reveal,
  // `number` is still the deferred previous issue. Only a remote issue of this
  // repo (this lens being the live one) has a row to look up.
  const frameNumber =
    selectedIssue?.kind === "remote" && liveRepoPath === repoPath
      ? Number(selectedIssue.id)
      : null;
  const frameKey =
    frameNumber === null ? null : `${repoPath}#${lens}#${frameNumber}`;
  // Whether the frame found a cached list row, decided once per live selection:
  // a row arriving mid-frame would re-lay the header the frame already drew.
  const [frameRow, setFrameRow] = useState<{
    key: string;
    row: IssueInfo | null;
  } | null>(null);
  // Which arm draws. A placeholder the hold isn't holding is never drawn: past
  // the bound, or with no settled issue to hold, it is the previous issue under
  // this one's number, so the loading frame stands in, as it does through a
  // reveal that lags the selection.
  const arm =
    reveal.revealing ||
    detailPane === "skeleton" ||
    (detailsPlaceholder && hold.phase === "loading")
      ? "loading"
      : detailPane === "offline"
        ? "offline"
        : detailPane === "error" || !issue
          ? "error"
          : "content";
  // Each frame episode decides afresh.
  if (arm !== "loading" && frameRow !== null) setFrameRow(null);
  // A swap that unmounts the focused node (in-view navigation onto an issue that
  // lands without a hold, or an arm change) would drop focus to <body>; land it
  // on the host. Change-only, so a mount never takes focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${shownIdentity}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);
  // Every arm draws inside the same host and frame, so React keeps both nodes
  // (and the frame's focus sink) through each swap, and a Retry's focus lands
  // on the host.
  const shell = (content: ReactNode) => (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="@container/issue-detail h-full outline-none"
      {...heldParentProps(hold.holding)}
    >
      <HeldFrame
        holding={hold.holding}
        className="flex h-full min-h-0 flex-col"
      >
        {content}
      </HeldFrame>
    </div>
  );
  if (arm === "loading") {
    // The loaded header's controls, held where they will stand, gated on the
    // list row's state as the loaded ones are on the issue's. With no cached
    // row, Solve and Edit assume an open issue, the common case.
    let listRow: IssueInfo | null = null;
    if (frameKey !== null && frameNumber !== null) {
      if (frameRow?.key === frameKey) listRow = frameRow.row;
      else {
        listRow =
          cachedIssueRow(queryClient, repoPath, lens, frameNumber) ?? null;
        setFrameRow({ key: frameKey, row: listRow });
      }
    }
    const rowOpen = listRow === null || listRow.state === "OPEN";
    return shell(
      <IssueLoadingFrame
        title={listRow?.title}
        number={listRow?.number ?? number}
        composer={canComment ? "comment" : canChangeState ? "bar" : null}
        actions={
          <>
            <PlanIssueButton
              title=""
              body=""
              disabledReason={ISSUE_SWITCH_LOADING_REASON}
            />
            {rowOpen && (
              <SolveIssueButton
                repoPath={repoPath}
                title=""
                body=""
                disabledReason={ISSUE_SWITCH_LOADING_REASON}
              />
            )}
            {rowOpen && canEdit && (
              <DisabledReasonButton
                variant="outline"
                size="xs"
                disabled
                reason={ISSUE_SWITCH_LOADING_REASON}
              >
                <PencilSimpleIcon data-icon="inline-start" />
                Edit
              </DisabledReasonButton>
            )}
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled
              reason={ISSUE_SWITCH_LOADING_REASON}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              {remoteLabel}
            </DisabledReasonButton>
            {(canLock || canDuplicate || canTransfer || canDelete) && (
              <DisabledReasonButton
                variant="outline"
                size="xs"
                aria-label="More actions"
                disabled
                reason={ISSUE_SWITCH_LOADING_REASON}
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DisabledReasonButton>
            )}
          </>
        }
      />,
    );
  }
  if (arm === "offline") {
    return shell(
      <DiffPlaceholder message={offlinePendingMessage("this issue")} />,
    );
  }
  if (arm === "error" || !issue) {
    // The failure class isn't knowable here, so the headline claims only which
    // host the read was aimed at and the summary beneath carries the reason. The
    // host goes unnamed while its own probe hasn't answered, rather than guessed.
    const loadFailed = provider
      ? `Couldn't load this issue from ${remoteLabel}.`
      : "Couldn't load this issue from the remote.";
    const errorSummary = details.error
      ? presentError(details.error).summary
      : null;
    return shell(
      <DiffPlaceholder
        message={details.isError ? loadFailed : "Could not load this issue"}
        action={
          details.isError ? (
            <div className="flex flex-col items-center gap-2">
              {errorSummary ? (
                <p className="max-w-md text-center text-xs">{errorSummary}</p>
              ) : null}
              <Button
                ref={retryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => details.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
      />,
    );
  }

  const isOpen = issue.state === "OPEN";
  // Controls visible at rest hold only over the placeholder: a hold draws none
  // of it, its controls keeping their look inside the inert frame. Handlers and
  // items painted only inside an open menu (which can sit open as a hold
  // starts) refuse on the hold too. Either reason ranks BELOW any permission
  // reason: that one never lifts and is still true once the issue lands.
  const staleReason = detailsPlaceholder
    ? ISSUE_SWITCH_LOADING_REASON
    : undefined;
  const heldItemReason = detailsStale ? ISSUE_SWITCH_LOADING_REASON : undefined;
  // Offline, the selected issue's reads key on its number under the previous
  // issue's paint; held, every read keys on the shown issue, so they agree.
  const feedMismatch = detailsPlaceholder;
  const detailFailed = refreshFailed(details);
  const detailNotice = detailNoticeMessage({
    noun: "issue",
    isError: detailFailed,
    stale: detailsPlaceholder,
  });
  // The shown issue's own writes, from the cache: this view outlives an issue
  // switch, so another issue's comment or close must not hold this one. Their
  // variables carry no lens, so a lens flip at the same number holds the other
  // lens's issue until the write settles — accepted, it only holds.
  const commenting = pendingIssueWrite(
    pendingWrites,
    "comment",
    (v) => v.number === shownNumber,
  );
  const closing = pendingIssueWrite(
    pendingWrites,
    "close",
    (v) => v.number === shownNumber,
  );
  const reopening = pendingIssueWrite(
    pendingWrites,
    "reopen",
    (v) => v === shownNumber,
  );
  const deletingComment = pendingIssueWrite(
    pendingWrites,
    "delete-comment",
    (v) => v.number === shownNumber,
  );
  const transferring = pendingIssueWrite(
    pendingWrites,
    "transfer",
    (v) => v.number === shownNumber,
  );
  const deleting = pendingIssueWrite(
    pendingWrites,
    "delete",
    (v) => v === shownNumber,
  );
  const busy =
    commenting !== undefined ||
    closing !== undefined ||
    reopening !== undefined ||
    detailsPlaceholder;
  // Which term of `busy` to name, ranked: the switch window outranks a write the
  // viewer started, being the hold they can't have caused themselves. Shared by
  // the composer and the close/reopen controls below — every one of them holds
  // for exactly these same terms. A write pressed offline is parked, not running.
  const composerReason = (() => {
    switch (true) {
      case detailsPlaceholder:
        return staleReason;
      case commenting !== undefined:
        return pendingWriteReason(
          commenting.paused,
          COMMENT_POST_PENDING_REASON,
        );
      case closing !== undefined:
        return pendingWriteReason(closing.paused, "Closing this issue…");
      case reopening !== undefined:
        return pendingWriteReason(reopening.paused, "Reopening this issue…");
      default:
        return undefined;
    }
  })();
  // Close's own hold: the shared terms, then offline.
  const closeBlocked = busy || triageBlocked || !!offlineHold;
  const closeReason = triageReason ?? composerReason ?? offlineHold;
  const comments = issue.comments.filter((c) => hasVisibleBody(c.body));

  function submitComment() {
    const body = compose.value.trim();
    if (!body || detailsStale) return;
    // Clear the draft immediately (the perceived-speed win) and append the
    // synthetic comment optimistically; on error restore the draft, but only if
    // that issue's composer is still empty so we never clobber newly-typed text.
    const submittedFor = issueIdentity;
    compose.set("");
    void comment
      .mutateAsync({ number, body, author: forge.data?.login ?? "You" })
      .catch((e) => {
        compose.setFor(submittedFor, (prev) => (prev.trim() ? prev : body));
        onError(e);
      });
  }

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) => {
    // Every quotable body — the issue's and each rendered comment's — belongs to
    // the issue on screen, which mid-switch is the previous one, while the draft
    // it would land in is keyed to the new one.
    if (detailsStale) return;
    makeQuoteReply({ composerRef, setBody: compose.set })(body);
  };

  // A typed draft rides Close/Reopen rather than being discarded by them. Gated
  // on `canComment` so the labels below never promise a comment the provider
  // won't take.
  const draftRidesStateChange = canComment && !!compose.value.trim();
  const draftSuffix = draftRidesStateChange ? " — posts your draft" : "";

  /** Posts the riding draft ahead of a state change. False means the comment
   *  failed and the state change is abandoned: the draft stays put for a retry,
   *  so a lost note can never be the price of a failed close. */
  async function postRidingDraft(): Promise<boolean> {
    if (!draftRidesStateChange) return true;
    const body = compose.value.trim();
    const submittedFor = issueIdentity;
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

  async function doClose(reason: "completed" | "not_planned") {
    // The caret menu can sit open across a selection switch or a mutation, so
    // the hold has to be re-checked here — item clicks bypass the trigger's
    // disable.
    if (busy || detailsStale || triageBlocked) return;
    // Captured before the await: posting clears the draft, and the error arm
    // below has to know a comment already went out.
    const withComment = draftRidesStateChange;
    // The post and the close build from the live repo's options, so a switch
    // during either await refuses rather than writes there.
    const closeIn = repoPath;
    // Ahead of the riding draft: a cancelled confirm must leave the comment
    // unposted.
    const ok = await useConfirm.getState().ask({
      title: `Close issue #${number}${CLOSE_TITLE_QUALIFIER[reason]}?`,
      body: `Everyone watching is notified and the issue leaves the open list. Reopening puts it back, but the notification can't be unsent.${
        withComment ? " Your draft posts as a comment first." : ""
      }`,
      confirmLabel: withComment ? "Close with comment" : "Close issue",
      holdOffline: true,
    });
    // Ahead of the riding draft too: a close refused offline posts nothing.
    if (
      !ok ||
      refuseWhileOffline() ||
      refuseIfSwitched(
        closeIn,
        withComment ? "nothing was posted or closed" : "nothing was closed",
      )
    )
      return;
    // Again below the riding post: the connection can drop while it runs, and a
    // comment that went out is named in the refusal.
    if (!(await postRidingDraft())) return;
    if (refuseWhileOffline(withComment ? RIDING_COMMENT_CLOSE_HELD : undefined))
      return;
    if (
      withComment &&
      refuseIfSwitched(
        closeIn,
        "your comment was posted, but the issue wasn't closed",
        "before the close started",
      )
    )
      return;
    try {
      await closeIssue.mutateAsync({ number, reason });
    } catch (e) {
      if (withComment) {
        toastErrorWithNote(
          e,
          "Your comment was posted, but closing failed — try Close again.",
        );
      } else {
        onError(e);
      }
      return;
    }
    toast.success(`Closed #${number}`);
  }

  async function doReopen() {
    if (busy || detailsStale || triageBlocked) return;
    const withComment = draftRidesStateChange;
    // The reopen builds from the live repo's options after the riding post's
    // await, so a switch during it refuses rather than reopens there.
    const reopenIn = repoPath;
    if (!(await postRidingDraft())) return;
    if (
      withComment &&
      refuseIfSwitched(
        reopenIn,
        "your comment was posted, but the issue wasn't reopened",
        "before the reopen started",
      )
    )
      return;
    try {
      await reopenIssue.mutateAsync(number);
    } catch (e) {
      if (withComment) {
        toastErrorWithNote(
          e,
          "Your comment was posted, but reopening failed — try Reopen again.",
        );
      } else {
        onError(e);
      }
      return;
    }
    toast.success(`Reopened #${number}`);
  }

  function saveCommentEdit(commentId: string, body: string) {
    // The comment id is the rendered issue's while the write addresses `number`
    // — GitLab routes by both, so a mismatched pair 404s.
    if (detailsStale) return;
    // Detached: Thread closes its inline editor on submit, so there is nothing
    // left for an await to hold open.
    void editComment
      .mutateAsync({ number, commentId, body })
      .then(() => toast.success("Comment updated"))
      .catch(onError);
  }

  // Both take a comment id off the RENDERED issue, which through a switch is the
  // previous one, so either would hide a comment on the issue the viewer just
  // left. The menu items disable on the same wait; these arms back them up.
  async function hideComment(commentId: string, classifier: MinimizeReason) {
    if (detailsStale) return;
    try {
      await minimizeComment.mutateAsync({ commentId, classifier });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Comment hidden");
  }

  async function unhideComment(commentId: string) {
    if (detailsStale) return;
    try {
      await unminimizeComment.mutateAsync(commentId);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Comment shown");
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    // The subject is the rendered issue's body or one of its comments, while the
    // write and its optimistic patch address `number` — GitLab routes by both, so
    // a mismatched pair awards the wrong note or 404s. The bars disable on the
    // same flag; this arm is the belt-and-braces behind them.
    if (detailsStale) return;
    void toggleReactionMutation
      .mutateAsync({
        reactionsKey: repoKeys.reactions(repoPath, ["issue", lens, number]),
        number,
        bodyId: details.data?.id ?? "",
        subjectId,
        content,
        active,
      })
      .catch(onError);
  }

  /** Opens the title/body editor seeded from the issue as it stands. */
  function openIssueEdit() {
    if (!issue || detailsStale) return;
    edit.openEdit({ title: issue.title, body: issue.body });
  }

  // Seeds + opens the GitHub create dialog (IssuesPanel consumes the draft).
  // Labels carry over since they're from this same repo.
  function duplicateIssue() {
    if (!issue || detailsStale) return;
    setPendingIssueDraft({
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
    });
  }

  /** Drill into a PR/issue a timeline reference row points at. The bare number it
   *  hands over resolves under the CURRENT lens, so the call site wires this only
   *  under the origin lens (see the lens note on `onOpenRef` there). Each arm is the
   *  navigation its own surface uses (Development panel / related issues). */
  function openRef(kind: "pr" | "issue", refNumber: number) {
    if (kind === "pr") {
      // The store's navigator, so the Pulls list aligns its open/closed tab with
      // the referenced PR's real state — a timeline reference points at merged
      // and closed ones as often as open ones. No lens write: this handler is
      // wired only under the origin lens, which is the lens the number came from.
      openPr({
        kind: "remote",
        repoPath,
        repoName: repoName ?? repoNameFromPath(repoPath),
        ref: String(refNumber),
        section: null,
      });
      return;
    }
    selectIssue({ kind: "remote", id: String(refNumber) });
  }

  /** Clear the selection only while it still points at this issue under the
   *  lens the write fired on (`firedUnder`, a pre-await read of the lens
   *  cache) — the write can settle after the user selected another issue or
   *  flipped the fork/upstream switcher, which unmounts this view; the cache
   *  outlives it. An undefined read is a cold cache, not "origin". */
  function deselectIfStillHere(firedUnder: RemoteLens | undefined) {
    const liveLens = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    if (firedUnder !== undefined && liveLens !== firedUnder) return;
    const { selectedIssue: sel, repoPath: liveRepo } = useUiStore.getState();
    if (liveRepo !== repoPath) return;
    if (sel?.kind === "remote" && sel.id === String(number)) selectIssue(null);
  }

  async function submitTransfer() {
    const destination = transferDest.trim();
    // The dialog's Enter submit reaches here past its held button. `number`
    // is the selection, so the previous issue still on screen holds it.
    if (!destination || detailsStale || refuseWhileOffline()) return;
    const firedUnder = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    const startedFor = issueIdentity;
    let url: string;
    try {
      url = await transferIssue.mutateAsync({ number, destination });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(
      `${isGitLab ? "Moved" : "Transferred"} #${number}`,
      url
        ? {
            description: url,
            action: { label: "View", onClick: () => openUrl(url) },
          }
        : undefined,
    );
    if (startedFor === issueIdentityRef.current) setTransferOpen(false);
    // The issue no longer lives in this repo; clear the now-stale view.
    deselectIfStillHere(firedUnder);
  }

  async function confirmDelete() {
    // As in submitTransfer: `number` is the selection, while the dialog's hold
    // reads the issue on screen, so the two must agree before it fires.
    if (detailsStale || refuseWhileOffline()) return;
    const firedUnder = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    const startedFor = issueIdentity;
    const closeIfStillHere = () => {
      if (startedFor === issueIdentityRef.current) setDeleteOpen(false);
    };
    try {
      await deleteIssue.mutateAsync(number);
    } catch (e) {
      onError(e);
      closeIfStillHere();
      return;
    }
    toast.success(`Deleted #${number}`);
    closeIfStillHere();
    deselectIfStillHere(firedUnder);
  }

  /** `wasPinned` comes from the render the click landed on: the refetch that
   *  follows already carries the new state, so the verb has to be captured. */
  async function togglePin(wasPinned: boolean) {
    if (pinPending || refuseWhileOffline()) return;
    try {
      await pinIssue.mutateAsync({ number, pinned: !wasPinned });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(wasPinned ? "Unpinned" : "Pinned");
  }

  async function doLock(reason: LockReason | null) {
    if (lockPending || refuseWhileOffline()) return;
    try {
      await lockIssue.mutateAsync({ number, reason });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation locked");
  }

  async function doUnlock() {
    if (lockPending || refuseWhileOffline()) return;
    try {
      await unlockIssue.mutateAsync(number);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation unlocked");
  }

  async function removeComment(commentId: string) {
    // Functional: by the settle the dialog may hold another comment, on this
    // issue or the next one.
    const closeIfStillOpen = () =>
      setDeletingCommentId((cur) => (cur === commentId ? null : cur));
    try {
      await deleteComment.mutateAsync({ number, commentId });
    } catch (e) {
      // Closes on failure too: DeleteCommentDialog never closes itself, and the
      // toast already carries the outcome.
      onError(e);
      closeIfStillOpen();
      return;
    }
    toast.success("Comment deleted");
    closeIfStillOpen();
  }

  // Repo suggestions for the transfer/move destination (excludes archived
  // repos, which can't receive issues); only loaded while the dialog is open.
  const repoQuery = transferDest.trim().toLowerCase();
  const repoSuggestions = (
    isGitLab
      ? (transferProjects.data ?? [])
      : (transferRepos.data?.repos ?? [])
          .filter((r) => !r.archived)
          .map((r) => r.nameWithOwner)
  )
    .filter((n) => !repoQuery || n.toLowerCase().includes(repoQuery))
    .slice(0, 6);

  // The activity feed: comments interleaved with timeline events, oldest→newest,
  // on the PR feed's slot convention (comments 2, events 3). Keys are slot-prefixed
  // because a comment id and an event index share one child list.
  const feedEntries: TimelineEntry[] = [];
  for (const c of comments) {
    feedEntries.push({
      date: c.date,
      sortKey: 2,
      node: (
        <Thread
          key={`comment-${c.id}`}
          thread={c}
          onQuote={
            canWrite && !detailsStale ? () => quoteReply(c.body) : undefined
          }
          onSaveEdit={
            canEditOwnComments && c.viewerDidAuthor && !detailsStale
              ? (body) => saveCommentEdit(c.id, body)
              : undefined
          }
          // Withholding the handler only drops the menu entry: an editor already
          // open when a placeholder took over holds its Save here. During a hold
          // the inert frame covers it (no focus or pointer reaches it).
          editHeld={detailsPlaceholder}
          onDelete={
            canEditOwnComments && c.viewerDidAuthor && !detailsStale
              ? () => setDeletingCommentId(c.id)
              : undefined
          }
          onHide={
            canWrite && !c.isMinimized
              ? (classifier) => void hideComment(c.id, classifier)
              : undefined
          }
          onUnhide={
            canWrite && c.isMinimized
              ? () => void unhideComment(c.id)
              : undefined
          }
          // Hide/Unhide sit in the comment's menu, which can be open as a
          // hold starts, so they hold on it. The permission reason ranks first:
          // it's the one still true once the selected issue is on screen.
          disabledReason={triageItemReason ?? heldItemReason}
          reactions={canReact ? reactions.data?.comments[c.id] : undefined}
          onToggleReaction={
            canReact
              ? (content, active) => toggleReaction(c.id, content, active)
              : undefined
          }
          reactionsHeld={detailsPlaceholder}
          reactionsReason={staleReason}
          // The picker is portaled out of the hold's `inert`, so it closes then.
          reactionPickerHeld={detailsStale}
          mentions={mentions}
        />
      ),
    });
  }
  // Offline, details keep the PREVIOUS issue painted while the timeline keys on
  // the NEW number and can resolve first — hold events until the identities
  // agree, or the feed interleaves two issues.
  for (const [i, ev] of (feedMismatch ? [] : (timeline.data ?? [])).entries()) {
    feedEntries.push({
      date: ev.date,
      sortKey: 3,
      node: (
        <TimelineEventRow
          key={`event-${i}`}
          event={ev}
          ghHost={ghHost}
          // `ForgeStatus.repo` is the ORIGIN slug, so a chip's same-repo verdict is
          // only trustworthy under the origin lens: off it, a ref living in the fork
          // matches the slug while the drill-in resolves against the upstream repo
          // and lands on a different entity. BOTH props gate on the lens — the
          // handler so off-lens refs are inert, and selfRepo so they keep their
          // explicit owner/name prefix instead of reading as this repo's number.
          onOpenRef={lens === "origin" ? openRef : undefined}
          selfRepo={
            lens === "origin" ? (forge.data?.repo ?? undefined) : undefined
          }
        />
      ),
    });
  }
  const feed = sortTimeline(feedEntries);

  // The close/reopen arm LEADS the bottom bar in both permission states — inside
  // the composer's action row (Comment is the primary and stays last), or alone
  // in the bar when the provider permits state changes but not comments, so
  // Close keeps the same corner either way. The composer call site supplies its
  // own spacer; the state-only bar left-aligns, so this fragment carries none.
  const stateActions = (
    <>
      {canChangeState &&
        (isOpen ? (
          <>
            {/* The label swaps while a draft rides along: the action changed
                meaning, and only the label reaches a viewer before the click. */}
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={closeBlocked}
              reason={closeReason}
              onClick={() => doClose("completed")}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close issue"}
            </DisabledReasonButton>
            {/* Close reasons are a GitHub concept; GitLab has none. */}
            {canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <DisabledReasonButton
                      variant="outline"
                      size="icon-sm"
                      aria-label="Other close options"
                      disabled={closeBlocked}
                      reason={closeReason}
                    />
                  }
                >
                  <CaretDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                  {/* A menu item drops pointer events when disabled and has no
                      room for a title, so the draft promise rides the label —
                      the same reason-in-label idiom the items above use. */}
                  <DropdownMenuItem onClick={() => doClose("completed")}>
                    Close as completed{draftSuffix}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => doClose("not_planned")}>
                    Close as not planned{draftSuffix}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ) : (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={busy || triageBlocked}
            reason={triageReason ?? composerReason}
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
        ))}
    </>
  );

  return shell(
    <>
      <DegradedListNotice
        noun="this issue"
        degraded={detailPane === "content-degraded"}
        message={detailNotice}
        onRetry={detailFailed ? () => details.refetch() : undefined}
        className="shrink-0 border-b px-4 py-1.5"
      />
      <header className="space-y-2 border-b px-4 py-3">
        {/* `flex-auto`, not `flex-1`: a basis-0 title never triggers the wrap, so
            the actions would stay put and the title collapse instead. Growing also
            replaces the spacer that used to right-align them. */}
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="min-w-0 flex-auto text-sm font-medium break-words">
            {issue.title}{" "}
            <span className="font-normal text-muted-foreground">
              #{issue.number}
            </span>
          </h2>
          {/* Both seed an AI run from the rendered issue, so they hold while
              that issue isn't the one you selected. */}
          <PlanIssueButton
            title={issue.title}
            body={issue.body}
            disabledReason={staleReason}
          />
          {isOpen && (
            <SolveIssueButton
              repoPath={repoPath}
              title={issue.title}
              body={issue.body}
              disabledReason={staleReason}
            />
          )}
          {isOpen && canEdit && (
            // A natively-disabled Button swallows its own `title`, so the wait
            // needs the reason prop to reach the viewer at all.
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={detailsPlaceholder}
              reason={staleReason}
              onClick={openIssueEdit}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </DisabledReasonButton>
          )}
          {/* The URL is the rendered issue's, the previous one mid-switch. */}
          <DisabledReasonButton
            variant="outline"
            size="xs"
            disabled={detailsPlaceholder}
            reason={staleReason}
            onClick={() => openUrl(issue.url)}
            title={`Open this issue on ${remoteLabel}`}
            className="cursor-pointer"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {remoteLabel}
          </DisabledReasonButton>
          {(canLock || canDuplicate || canTransfer || canDelete) && (
            <DropdownMenu>
              {/* Every item but Transfer is withheld while the rendered issue is
                  the previous one, so hold the menu shut rather than open a near-
                  empty popup. */}
              <DropdownMenuTrigger
                render={
                  <DisabledReasonButton
                    variant="outline"
                    size="xs"
                    aria-label="More actions"
                    disabled={detailsPlaceholder}
                    reason={staleReason}
                  />
                }
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {/* Absent while a placeholder is served: the verb comes from the
                    rendered issue's pin state while the write addresses
                    `number`, and a disabled item can't say why it's held. */}
                {canWrite && !detailsStale && (
                  <DropdownMenuItem
                    className={MENU_HELD_ROW_CLASS}
                    disabled={writeBlocked || pinHeld !== undefined}
                    onClick={() => void togglePin(issue.isPinned)}
                  >
                    {issue.isPinned ? "Unpin issue" : "Pin issue"}
                    {pinSuffix}
                  </DropdownMenuItem>
                )}
                {/* Absent while a placeholder is served: which affordance renders
                    comes from the LOADED issue's lock state, so a click during that
                    window would lock or unlock the issue you actually selected. */}
                {canLock &&
                  !detailsStale &&
                  (issue.locked ? (
                    <DropdownMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      disabled={lockBlocked || lockHeld !== undefined}
                      onClick={() => void doUnlock()}
                    >
                      Unlock conversation{lockHeldSuffix}
                    </DropdownMenuItem>
                  ) : isGitLab ? (
                    // GitLab locks without a reason — a plain item, no submenu.
                    <DropdownMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      disabled={lockBlocked || lockHeld !== undefined}
                      onClick={() => void doLock(null)}
                    >
                      Lock conversation{lockHeldSuffix}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuSub>
                      {/* The vendored sub-trigger carries no disabled styling
                          of its own (unlike menu items), so the dim rides a
                          call-site class. */}
                      <DropdownMenuSubTrigger
                        disabled={lockBlocked || lockHeld !== undefined}
                        className="data-disabled:opacity-50"
                      >
                        Lock conversation…{lockHeldSuffix}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {LOCK_REASONS.map(([label, reason]) => (
                          <DropdownMenuItem
                            key={reason ?? "none"}
                            className={MENU_HELD_ROW_CLASS}
                            disabled={lockBlocked || lockHeld !== undefined}
                            onClick={() => void doLock(reason)}
                          >
                            {label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                {/* Both items above it are absent while stale, so the rule would
                    otherwise open the menu with nothing over it. */}
                {(canWrite || canLock) && !detailsStale && (
                  <DropdownMenuSeparator />
                )}
                {/* Absent while a placeholder is served: the draft it seeds is the
                    rendered issue's, which isn't the one you selected. */}
                {canDuplicate && !detailsStale && (
                  <DropdownMenuItem onClick={duplicateIssue}>
                    Duplicate issue
                  </DropdownMenuItem>
                )}
                {/* Held, not absent, while stale: the menu can sit open across
                    a switch, and the transfer addresses `number`, not the
                    issue on screen. */}
                {canTransfer && (
                  <DropdownMenuItem
                    className={MENU_HELD_ROW_CLASS}
                    disabled={writeBlocked || detailsStale}
                    onClick={() => {
                      setTransferDest("");
                      setTransferOpen(true);
                    }}
                  >
                    {isGitLab ? "Move issue…" : "Transfer issue…"}
                    {itemSuffix ||
                      (heldItemReason ? ` — ${heldItemReason}` : "")}
                  </DropdownMenuItem>
                )}
                {/* Absent while a placeholder is served: the confirm names the
                    rendered issue's title while the delete addresses `number`,
                    and a disabled item can't say why it's held. */}
                {canDelete && !detailsStale && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={writeBlocked}
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete issue…{itemSuffix}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={isOpen ? "default" : "secondary"}>
            {issue.state.toLowerCase()}
          </Badge>
          {issue.isPinned && <Badge variant="secondary">pinned</Badge>}
          {issue.locked && (
            <Badge variant="secondary">
              locked
              {issue.activeLockReason
                ? ` · ${issue.activeLockReason.replace(/_/g, "-")}`
                : ""}
            </Badge>
          )}
          <AuthorAvatar
            login={issue.author}
            avatarUrl={issue.authorAvatarUrl}
          />
          <span>{issue.author || "unknown"}</span>
          {parseableDate(issue.createdAt) && (
            <>
              <span>•</span>
              <span>
                opened <RelativeTime date={issue.createdAt} />
              </span>
            </>
          )}
        </div>
      </header>
      {/* Below ~672px of pane the 256px rail leaves under ~57ch of body, so it
          stacks under the thread instead (see IssueRail). */}
      <div className="flex min-h-0 flex-1 @max-2xl/issue-detail:flex-col">
        {/* `min-h-0` only bites once stacked: the auto minimum size applies to the
            flex MAIN axis, so in the column the body would otherwise floor at its
            thread's full height and push a scrollbar onto the document. */}
        <div className="flex min-w-0 flex-1 flex-col @max-2xl/issue-detail:min-h-0">
          {/* Keyed so a newly shown issue opens at its top. */}
          <ConversationScrollArea
            key={shownIdentity}
            ref={jumpRef}
            className="flex-1"
          >
            <div className="space-y-4 p-4">
              <div className="group space-y-1">
                <p className="flex items-center gap-2 text-xs">
                  <AuthorAvatar
                    login={issue.author}
                    avatarUrl={issue.authorAvatarUrl}
                  />
                  <span className="font-medium">
                    {issue.author || "unknown"}
                  </span>
                  {parseableDate(issue.createdAt) && (
                    <span className="text-muted-foreground">
                      opened <RelativeTime date={issue.createdAt} />
                    </span>
                  )}
                  <span className="flex-1" />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Description actions"
                          className="text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                        />
                      }
                    >
                      <DotsThreeIcon className="size-4" weight="bold" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        onClick={() => copyText(issue.url, "Link copied")}
                      >
                        Copy link
                      </DropdownMenuItem>
                      {/* Absent, not disabled, while the body belongs to the
                          previous issue — the same shape the comment menus take
                          when their `onQuote` is withheld. */}
                      {canWrite &&
                        hasVisibleBody(issue.body) &&
                        !detailsStale && (
                          <DropdownMenuItem
                            onClick={() => quoteReply(issue.body)}
                          >
                            Quote reply
                          </DropdownMenuItem>
                        )}
                      <DropdownMenuItem
                        onClick={() => copyText(issue.body, "Markdown copied")}
                      >
                        Copy markdown
                      </DropdownMenuItem>
                      {/* Absent, not disabled, while the description belongs to
                          the previous issue: the dialog seeds from it, and a
                          disabled item drops pointer events so no hint could
                          reach the viewer to explain it. */}
                      {isOpen && canEdit && !detailsStale && (
                        <DropdownMenuItem onClick={openIssueEdit}>
                          Edit
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </p>
                {hasVisibleBody(issue.body) ? (
                  <Markdown refs={mentions.refs}>{issue.body}</Markdown>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No description provided.
                  </p>
                )}
                {canReact && !reactionsReady && (
                  // The bar's 24px row, until its counts land.
                  <div aria-hidden className="flex h-6 items-center">
                    <Skeleton className="h-5 w-12" />
                  </div>
                )}
                {canReact && reactionsReady && (
                  // The counts are a read and stay; only the toggles hold.
                  <ReactionBar
                    reactions={reactions.data?.body ?? []}
                    disabled={detailsPlaceholder}
                    reason={staleReason}
                    held={detailsStale}
                    onToggle={(content, active) =>
                      toggleReaction(issue.id, content, active)
                    }
                  />
                )}
              </div>
              {canWrite && (
                <IssueSubIssues
                  // Remounts per shown issue like the sidebar: its add/create
                  // state is local, and a dialog left open across a switch would
                  // re-point its parent id as the placeholder resolves.
                  key={shownIdentity}
                  repoPath={repoPath}
                  issueId={issue.id}
                  number={shownNumber}
                  lens={lens}
                  reserve={githubRail}
                  held={hold.holding}
                  // The writes take the rendered issue's id while the list is
                  // fetched for `number` — hold them until the two agree. A
                  // viewer who can't write hears that first instead: their reason
                  // is the one still true once the switch lands.
                  disabledReason={writeReason ?? staleReason}
                />
              )}
              {feedReady ? (
                <>
                  {feed.map((e) => e.node)}
                  {feed.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No comments yet.
                    </p>
                  )}
                </>
              ) : (
                <ListRowSkeletons
                  rows={3}
                  lines={2}
                  indent={false}
                  name="the conversation"
                />
              )}
            </div>
          </ConversationScrollArea>
        </div>
        <IssueSidebar
          // Remounts the rail per shown issue so its sections' drafts (the
          // uncontrolled "Add spent" input, the link picker) can't commit
          // against a new number.
          key={shownIdentity}
          repoPath={repoPath}
          number={shownNumber}
          issue={issue}
          canWrite={canWrite}
          canEditLabels={canEditLabels}
          canEditAssignees={canEditAssignees}
          canSetMilestone={canSetMilestone}
          canSetConfidential={canSetConfidential}
          canSetDueDate={canSetDueDate}
          canTrackTime={canTrackTime}
          canLinkIssues={canLinkIssues}
          remoteLabel={remoteLabel}
          lens={lens}
          // The remount clears the rail's drafts, but `issue` is still the
          // placeholder through a switch and every picker seeds from it, so they
          // hold until details are fresh — triage first, since it outlasts the wait.
          pickerDisabledReason={triageReason ?? staleReason}
          writeItemReason={writeItemReason}
          loadingReason={staleReason}
          reserve={githubRail}
          held={hold.holding}
          paletteEnabled={isSelectedIssue && hold.interactive}
        />
      </div>
      {/* Below the thread AND the rail: the conversation is the widest thing on
          this surface, so the box you write in spans the same width the other
          conversation surfaces (which have no rail) already get.
          Comment is allowed after the issue closes too, matching GitHub. On
          GitLab the composer + close/reopen show, but the GitHub-only
          close-reason dropdown stays hidden (GitLab has no reasons);
          Bitbucket has neither, so the whole bar hides. */}
      {canComment ? (
        <CommentComposer
          ref={composerRef}
          ariaLabel="Leave a comment"
          placeholder="Leave a comment…"
          value={compose.value}
          onChange={compose.set}
          onSubmit={submitComment}
          mentions={mentions}
          submitLabel="Comment"
          busy={busy}
          reason={composerReason}
          // Close/reopen lead, Comment ends the row where a form's submit is
          // looked for. Clear is site-rendered rather than the shared `onClear`
          // one so it sits just left of Comment: the shared Clear is `ml-auto`,
          // which would put it past the submit button.
          leadingActions={
            <>
              {stateActions}
              <span className="flex-1" />
              {compose.value.trim() && (
                <DisabledReasonButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  reason={composerReason}
                  onClick={() => compose.set("")}
                  title="Discard this draft (e.g. a quote reply)"
                >
                  Clear
                </DisabledReasonButton>
              )}
            </>
          }
        />
      ) : canChangeState ? (
        <div className="space-y-2 border-t p-3">
          <div className="flex items-center gap-2">{stateActions}</div>
        </div>
      ) : null}

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open && hold.interactive}
        onOpenChange={edit.setOpen}
        title="Edit issue"
        description={`Updates the title and description of #${number} on ${remoteLabel}.`}
        contentClassName="sm:max-w-lg"
        bodyTextareaClassName="max-h-72 min-h-24 resize-y font-mono"
        mentions={mentions}
      />

      <DeleteCommentDialog
        commentId={hold.interactive ? deletingCommentId : null}
        onClose={() => setDeletingCommentId(null)}
        pending={deletingComment !== undefined}
        reason={pendingWriteReason(
          deletingComment?.paused ?? false,
          COMMENT_DELETE_PENDING_REASON,
        )}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) => void removeComment(commentId)}
      />

      <TransferIssueDialog
        open={transferOpen && hold.interactive}
        onClose={() => setTransferOpen(false)}
        number={number}
        dest={transferDest}
        onDestChange={setTransferDest}
        suggestions={repoSuggestions}
        pending={transferring !== undefined}
        heldReason={offlineHold}
        onSubmit={() => void submitTransfer()}
        move={isGitLab}
      />

      <DeleteIssueDialog
        open={deleteOpen && hold.interactive}
        onClose={() => setDeleteOpen(false)}
        number={number}
        title={issue.title}
        pending={deleting !== undefined}
        heldReason={offlineHold}
        onConfirm={() => void confirmDelete()}
        remoteLabel={remoteLabel}
        roleHint={
          isGitLab ? "needs Owner access" : "requires admin or triage access"
        }
      />
    </>,
  );
}
