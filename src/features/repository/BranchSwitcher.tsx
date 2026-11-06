import type { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Popover } from "@base-ui/react/popover";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  CloudArrowDownIcon,
  CloudSlashIcon,
  CloudXIcon,
  GitBranchIcon,
  TreeStructureIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  type TouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import {
  isDeletionBlocked,
  isMergeMethodAllowed,
  isPromotionBranch,
  requiresPullRequest,
} from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { clipTitle } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { isDirtyTreeRefusal, presentError } from "@/lib/error-summary";
import { applyFrozenOrder } from "@/lib/frozen-order";
import {
  forgeDetectForkPrForBranch,
  gitBranches,
  gitRemotePushUrl,
  gitRemoteUrl,
} from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  headTrackingMatchesRow,
  rowTrackingMatches,
} from "@/lib/git/push-tracking";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  type BranchPushState,
  branchPublishLabel,
  branchPushHoldItemReason,
  branchPushHoldReason,
  branchPushLabel,
  branchRewriteStatusOptions,
  carriesAllLocalCommits,
  forgeFeatureReady,
  nextPushLatch,
  pendingMutationEntries,
  REMOTE_BRANCHES_STALE_TIME,
  refuseWhilePushRuns,
  remoteBranchesOptions,
  repoKeys,
  repoStatusOptions,
  useBranchAhead,
  useBranchDivergence,
  useBranches,
  useBranchResetToUpstream,
  useBranchRewriteStatus,
  useCheckoutBranch,
  useCheckoutRemoteBranch,
  useDefaultBranch,
  useDeleteBranch,
  useDeleteRemoteBranch,
  useDiscardAll,
  useForgeStatus,
  useHardResetToCommit,
  useMergeBranch,
  usePendingBranchPushes,
  usePendingBranchPushIds,
  usePendingLocalPrWrites,
  usePendingPublishes,
  usePrList,
  usePush,
  useRebaseBranch,
  useRebaseOnto,
  useRemoteBranches,
  useRemotes,
  useRepoStatus,
  userWorktreesOptions,
  useSetBranchArchived,
  useStashAll,
  useStashCount,
  useStashPop,
  useSwitchAutostash,
  useUnlockUserWorktree,
  useUpdateBranchFrom,
  useUserWorktrees,
} from "@/lib/git/queries";
import {
  branchPushKey,
  pendingBranchPushesFor,
} from "@/lib/git/queries/push-writes";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type {
  Branch,
  BranchHead,
  BranchRewriteStatus,
  ForkPrMatch,
  RemoteBranch,
} from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { secondaryClickLabel } from "@/lib/hotkeys/binding";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { focusInOpenModal } from "@/lib/hotkeys/open-modal";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  OFFLINE_ITEM_REASON,
  pendingItemReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import {
  LOCAL_AUDIT_STATE,
  PR_AUDIT_TONE,
  PR_RANK,
  type PrAuditState,
  REMOTE_AUDIT_STATE,
} from "@/lib/pulls/audit";
import { PR_AUDIT_ICON, PR_NOUN } from "@/lib/pulls/pr-state";
import { useLocalPrs } from "@/lib/pulls/queries";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import {
  useAiConfigured,
  useAiEnabled,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
import {
  landedIn,
  refuseIfSwitched,
  repoNameFromPath,
} from "@/lib/stores/notifications";
import { useStashReapplyMarker } from "@/lib/stores/stash-reapply-marker";
import { type SelectedPr, useUiStore } from "@/lib/stores/ui";
import {
  isWorktreePromoting,
  promotionBlocksCheckout,
  useWorktreeRemovalStore,
  useWorktreeRemovals,
  WORKTREE_PROMOTING_MESSAGE,
} from "@/lib/stores/worktree-removal";
import { isAppError } from "@/lib/tauri/invoke";
import { errorToastAction, toastError, toastErrorWithNote } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import {
  BranchMergePickerDialog,
  type MergeRunOptions,
  type PickerMode,
} from "./BranchMergePickerDialog";
import {
  type BranchMenuRow,
  type BranchMenuTarget,
  branchMenuPins,
  buildBranchMenuRows,
  menuTargetOf,
  mergePinnedIndexes,
  rowKeyOf,
} from "./BranchSwitcherRows";
import {
  type BranchListMode,
  branchListRetrying,
  branchListState,
} from "./branch-list-state";
import {
  isLocalUpstream,
  type PushOutcome,
  presenceUnderUrls,
  pushesBranch,
  pushOutcome,
  pushSuccessCopy,
  remoteHasBranch,
  resolveUpdateFromDefault,
  type UpdateSource,
  visibilityApplies,
  willCreateOnRemote,
  willPublish,
} from "./branch-sync-state";
import {
  CleanupBranchesDialog,
  defaultBranchReadFailed,
  prCheckStateFrom,
  worktreeCheckStateFrom,
} from "./CleanupBranchesDialog";
import { CreateBranchDialog } from "./CreateBranchDialog";
import {
  baseName,
  PROMOTION_BLOCKS_CHECKOUT,
  rowCheckoutCopy,
} from "./checkout-copy";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { ForkPrPublishGuard } from "./ForkPrPublishGuard";
import { OperationHistoryDialog } from "./OperationHistoryDialog";
import { PromoteWorktreeDialog } from "./PromoteWorktreeDialog";
import {
  PUBLISH_HOLD_ITEM_REASON,
  PUBLISH_HOLD_REASON,
  refuseWhilePublishing,
} from "./PublishPendingBanner";
import {
  askPublishConfirm,
  PUBLISH_FORK_CHECK_BOUND_MS,
  PUBLISH_FORK_CHECK_NOTE,
  PUBLISH_FORK_CHECK_REASON,
  recordedVisibility,
  useCloseSettled,
  withdrawPublishConfirm,
} from "./publish-confirm";
import { RebaseOntoDialog } from "./RebaseOntoDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { StashesDialog } from "./StashesDialog";
import { statusReadFailed } from "./StatusReadError";
import { SwitchWithChangesDialog } from "./SwitchWithChangesDialog";
import {
  STATUS_PENDING_REASON,
  STATUS_READ_FAILED_REASON,
} from "./sync-controls-state";
import { repoOpenWatermark, useOpenWorktree } from "./useOpenRepoByPath";
import {
  reportAutostashOutcome,
  useStashReapplyRecovery,
} from "./useStashReapplyRecovery";
import {
  LockWorktreeDialog,
  RenameWorktreeDialog,
  refuseWhileLeaving,
  worktreeItemLabel,
} from "./WorktreesDialog";

/** Sentence-initial form of the platform's secondary-click word — for
 *  status-icon hints where the phrase leads a sentence. */
const secondaryClickCapitalized =
  secondaryClickLabel.charAt(0).toUpperCase() + secondaryClickLabel.slice(1);

/** How many closed PRs the branch surfaces scan. Merged state lives only in the
 *  closed list, and gh's default 30 covers too little history for the cleanup
 *  dialog's merged badge. The open list keeps the default so it goes on sharing a
 *  cache entry with the session PR audit. */
const CLOSED_PR_SCAN_LIMIT = 100;

/** How many diverged rows get their rewrite status warmed when the popover opens.
 *  The prefetch exists to keep a right-click from painting a slot whose identity
 *  is still in flight; each entry costs several rev-list spawns, so it is capped
 *  rather than run per branch. Rows past the cap fall back to the waiting slot. */
const MAX_REWRITE_PREFETCH = 4;

/** The current branch's reset-to-upstream refusals when the confirm-time re-read
 *  no longer matches what the row offered: the upstream tip moved, the branch
 *  itself did, or the read couldn't prove the upstream still carries every
 *  commit. KEEP IN STEP: SyncControls' twins name the Pull menu instead of the
 *  branch menu (pinned by scripts/head-watcher.test.mjs). */
const UPSTREAM_MOVED_NOTICE = (upstream: string) =>
  `${upstream} moved since you opened this, so nothing was reset. Reopen the branch menu to see where it stands now.`;
const LOCAL_MOVED_NOTICE = (branch: string) =>
  `${branch} changed since you opened this, so nothing was reset. Reopen the branch menu to see where it stands now.`;
const UNCONFIRMED_NOTICE = (upstream: string, branch: string) =>
  `Couldn't confirm that ${upstream} still has every commit on ${branch}, so nothing was reset. Reopen the branch menu to check again.`;

interface BranchPr {
  state: PrAuditState;
  /** "#123" for a remote PR, "local" for a local-only one. */
  label: string;
  /** The branch this PR targets. A merge into anything but the default branch
   *  can't stand in for "merged into the default branch". */
  base: string;
  select: SelectedPr;
}

/** A publish's fork-PR detection: the row it paints, the remote it would publish
 *  to (null = git's own routing), and the repo it runs in. */
interface PublishDetect {
  branch: string;
  remote: string | null;
  repo: string;
}

/** Sentence-initial state words for the badge's own hint — the audit chip's
 *  labels lead with "PR", which reads wrong mid-sentence here. */
const PR_STATE_LABEL: Record<PrAuditState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** One spelling for a failed branch-list read: the disabled reasons, the list's
 *  failure line, and its status region all describe the same query. */
const BRANCH_LIST_READ_FAILED = "Couldn't read the branch list.";

/** The list's loading status, in `ListRowSkeletons`' "Loading {name}…" shape;
 *  the disabled reasons' "Checking branches…" is a separate, deliberate line. */
const BRANCH_LIST_LOADING = "Loading branches…";

/** The list's announcement per mode while the menu is open; ready says nothing,
 *  the rows do. */
const BRANCH_LIST_STATUS: Record<BranchListMode, string> = {
  pending: BRANCH_LIST_LOADING,
  failed: BRANCH_LIST_READ_FAILED,
  ready: "",
};

const BRANCH_SKELETON_ROWS = 4;

/** Placeholders shaped like a branch row: its `gap-y-0.5 px-3 py-1.5` box, an h-4
 *  name line, and a meta line as tall as the real row's text-[11px] spans (11px
 *  at text-xs's inherited 1/0.75 line-height), so the rows that replace them
 *  shift nothing. Local rather than `ListRowSkeletons`, whose rows are bordered
 *  `py-2` boxes of full-width bars. */
function BranchRowSkeletons() {
  return (
    <div aria-busy>
      {/* Index key: a fixed static list that never reorders. */}
      {Array.from({ length: BRANCH_SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex flex-col gap-y-0.5 px-3 py-1.5">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-2/5" />
          </div>
          <div className="flex h-[calc(11px/0.75)] items-center">
            <Skeleton className="h-2.5 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The failure line's retry, held by `aria-disabled` while the read runs so it
 *  keeps focus for the rescue when rows land. Not ARIA_DISABLED_CLASS: its
 *  pointer-events-none lets a press fall through and take focus off the button,
 *  and 50% opacity on primary misses AA (2.26:1 light, 3.13:1 slate; the muted
 *  token used instead measures 5.18:1 or better, computed from App.css). */
function BranchListRetry({
  retrying,
  retryRef,
  onRetry,
}: {
  retrying: boolean;
  retryRef: (node: HTMLElement | null) => () => void;
  onRetry: () => void;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: retrying,
      reason: BRANCH_LIST_LOADING,
      onClick: onRetry,
    });
  return (
    <span className="flex shrink-0" title={wrapperTitle}>
      <button
        {...nativeProps}
        ref={retryRef}
        type="button"
        aria-describedby={describedBy}
        className="cursor-pointer font-medium text-primary hover:underline aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:no-underline"
      >
        Try again
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}

function MenuRow({
  disabled,
  reason,
  onClick,
  children,
}: {
  disabled?: boolean;
  /** Why the row is held. Absent leaves an ordinary native disable — used where
   *  the label already states the reason. */
  reason?: string | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({ disabled, reason, onClick });
  return (
    // Block, not the span default: the row's `w-full` needs a full-width parent
    // to size against inside the menu's block container.
    <span
      className={cn("block w-full", blockedReason && "cursor-not-allowed")}
      title={wrapperTitle}
    >
      <button
        {...nativeProps}
        type="button"
        aria-describedby={describedBy}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
          ARIA_DISABLED_CLASS,
        )}
      >
        {children}
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}

// First-paint row heights until `measureElement` reads the real ones, all
// py-1.5: a local row is the skeleton's box (an h-4 name line over an 11px meta
// line at text-xs's 1/0.75 line-height), a remote row one text-xs line, a
// section toggle one text-[11px] line at the popup's inherited line-height.
const BRANCH_ROW_ESTIMATE: Record<
  BranchMenuRow<Branch, RemoteBranch>["type"],
  number
> = {
  local: 12 + 16 + 2 + 11 / 0.75,
  "archived-header": 28.5,
  remote: 28,
  "remote-header": 28.5,
};

/** The branch menu's windowed rows. Its own component because `useVirtualizer`
 *  bails its host out of the React Compiler, which keeps BranchSwitcher's body
 *  compilable. Mounted only with rows, so the first row's measurement never
 *  races an empty list. */
function BranchMenuList({
  flatRows,
  activeName,
  target,
  focusNonce,
  filter,
  popupRef,
  renderRow,
}: {
  flatRows: BranchMenuRow<Branch, RemoteBranch>[];
  /** The arrow cursor's nav name. */
  activeName: string | null;
  /** The shared context menu's target, kept mounted while it anchors the menu. */
  target: BranchMenuTarget;
  /** Bumped by keyboard cursor moves only: those scroll and claim focus. */
  focusNonce: number;
  /** The applied filter; a change scrolls back to the top. */
  filter: string;
  /** The popover popup: a focus claim lands only while focus is inside it. */
  popupRef: RefObject<HTMLDivElement | null>;
  renderRow: (row: BranchMenuRow<Branch, RemoteBranch>) => ReactNode;
}) {
  // State, not a ref: the virtualizer must see the element the instant it mounts.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Re-minted per row sequence: the virtualizer keys its measurement projection
  // on this callback's identity, so a stale one paints a row into the previous
  // occupant's measured slot.
  const getItemKey = useCallback(
    (i: number) => rowKeyOf(flatRows[i]),
    [flatRows],
  );
  const count = flatRows.length;
  // The `data-row` of the row holding DOM focus. State, not a ref: it pins a
  // row, so a change must re-render the virtualizer's range.
  const [focusedName, setFocusedName] = useState<string | null>(null);
  const [activePin, targetPin, archivedPin, remotePin, focusedPin] =
    branchMenuPins(flatRows, activeName, target, focusedName);
  // Rows that stay mounted at any scroll position: the cursor row, so an arrow
  // can claim it; the row holding focus, which must outlive the cursor leaving
  // it until the claim moves focus on, or focus drops to <body>; the context
  // menu's anchor while it is open; and both section toggles, so Tab always
  // reaches them.
  const rangeExtractor = useCallback(
    (range: Range) =>
      mergePinnedIndexes(
        defaultRangeExtractor(range),
        [activePin, targetPin, archivedPin, remotePin, focusedPin],
        count,
      ),
    [activePin, targetPin, archivedPin, remotePin, focusedPin, count],
  );
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => BRANCH_ROW_ESTIMATE[flatRows[i].type],
    getItemKey,
    rangeExtractor,
    // Unrounded: virtual-core rounds each row by default, and these rows'
    // natural heights are fractional, so a short list would come out taller
    // than the same rows laid out in flow.
    measureElement: (el, entry) =>
      entry?.borderBoxSize[0]?.blockSize ?? el.getBoundingClientRect().height,
    overscan: 12,
  });

  // Focus follows the KEYBOARD only, so a click never moves the list under the
  // pointer. The ref starts at the nonce this list mounted with and is recorded
  // on every run, so a remount or replay can't claim focus nobody asked for. An
  // arrow onto a row outside the window mounts it (pinned) and scrolls to it;
  // the claim gets a few frames to find it and lands only while focus is still
  // inside the popup.
  const appliedNonce = useRef(focusNonce);
  useEffect(() => {
    const unseen = appliedNonce.current !== focusNonce;
    appliedNonce.current = focusNonce;
    if (activePin < 0 || activeName === null || !unseen) return;
    virtualizer.scrollToIndex(activePin, { align: "auto" });
    let frame = 0;
    let tries = 4;
    const claim = () => {
      tries -= 1;
      const row = scrollEl?.querySelector<HTMLElement>(
        `[data-row="${CSS.escape(activeName)}"]`,
      );
      if (row) {
        const focused = document.activeElement;
        if (
          focused !== row &&
          focused !== null &&
          popupRef.current?.contains(focused)
        )
          row.focus();
        return;
      }
      if (tries === 0) return;
      frame = requestAnimationFrame(claim);
    };
    frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [activePin, activeName, focusNonce, scrollEl, virtualizer, popupRef]);

  // Back to the top when the filter changes the rows; only on a real change,
  // so a replayed effect keeps the position.
  const appliedFilter = useRef(filter);
  useEffect(() => {
    if (appliedFilter.current === filter) return;
    appliedFilter.current = filter;
    virtualizer.scrollToOffset(0);
  }, [filter, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  return (
    <div
      ref={setScrollEl}
      className="overflow-y-auto"
      // React bubbles focus through portals by component tree, so only a
      // target inside this element in the DOM counts. A blur onto another row
      // keeps the name until that row's focus replaces it, never null between.
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.target)) return;
        setFocusedName(
          e.target.closest("[data-row]")?.getAttribute("data-row") ?? null,
        );
      }}
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.target) ||
          (e.relatedTarget instanceof Node &&
            e.currentTarget.contains(e.relatedTarget))
        )
          return;
        setFocusedName(null);
      }}
      // An explicit height, never `max-h`: an unbounded scroll container gives
      // the virtualizer no viewport and the rows vanish. min() keeps the cap and
      // still hugs a short list.
      style={{ height: `min(${totalSize}px, 15rem)` }}
    >
      <div className="relative w-full" style={{ height: `${totalSize}px` }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = flatRows[vi.index];
          return (
            <div
              key={rowKeyOf(row)}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BranchSwitcher({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const branches = useBranches(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const stashCount = useStashCount(repoPath);
  const checkout = useCheckoutBranch(repoPath);
  const checkoutRemote = useCheckoutRemoteBranch(repoPath);
  const deleteBranch = useDeleteBranch(repoPath);
  const deleteRemoteBranch = useDeleteRemoteBranch(repoPath);
  const discardAll = useDiscardAll(repoPath);
  const stashAll = useStashAll(repoPath);
  const stashPop = useStashPop(repoPath);
  const switchAutostash = useSwitchAutostash(repoPath);
  const mergeBranch = useMergeBranch(repoPath);
  const rebaseBranch = useRebaseBranch(repoPath);
  const rebaseOnto = useRebaseOnto(repoPath);
  const updateBranchFrom = useUpdateBranchFrom(repoPath);
  const resetToUpstream = useBranchResetToUpstream(repoPath);
  const hardReset = useHardResetToCommit(repoPath);
  const push = usePush(repoPath);
  // Push, publish and delete-on-remote hold offline rather than park: a parked
  // one lands on the remote whenever the connection returns.
  const offlineHold = useOfflineHold();
  const offlineSuffix = offlineHold ? ` (${OFFLINE_ITEM_REASON})` : "";
  const remotes = useRemotes(repoPath);
  const setBranchArchived = useSetBranchArchived(repoPath);
  const openWorktree = useOpenWorktree();
  const unlockWorktree = useUnlockUserWorktree(repoPath);
  const recovery = useStashReapplyRecovery(repoPath);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  // While either rules scope is on its first read the effective config stands in
  // as empty, so every protection check reads not-blocked — the delete surfaces
  // hold on this rather than acting on that stand-in.
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);
  const amendingHash = useUiStore((s) => s.amendingHash);
  const openSettings = useUiStore((s) => s.openSettings);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();

  const [open, setOpen] = useState(false);
  // A publish prompt asked from the list waits for it to finish closing.
  const listClose = useCloseSettled(open);
  // The publish prompt this switcher asked last, so it withdraws only its own.
  const publishAsk = useRef<ConfirmRequest | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Remote-only branches show expanded by default (the point is to see them);
  // archived shows collapsed (it's intentionally-hidden clutter).
  const [showRemote, setShowRemote] = useState(true);
  const [branchFilter, setBranchFilter] = useState("");
  // The branch row the keyboard nav last landed on (drives arrow-key movement).
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const shownDeleteTarget = useRetained(deleteTarget);
  // The delete confirm's open session: minted by openDelete with the repo it
  // opened in, dropped by every close. The confirm is dismissible mid-delete and
  // this switcher outlives repo switches, so a settle closes only the confirm it
  // was fired from, never one reopened on a same-named branch here or in another
  // repo, and a confirm answered after a switch refuses.
  const deleteSessionRef = useRef<{ repo: string } | null>(null);
  function openDelete(branch: string) {
    deleteSessionRef.current = { repo: repoPath };
    setDeleteTarget(branch);
  }
  function closeDelete() {
    deleteSessionRef.current = null;
    setDeleteTarget(null);
  }
  // The worktree a branch row offers to remove (resolved from `userWorktrees`).
  const [removeWorktreeTarget, setRemoveWorktreeTarget] =
    useState<UserWorktree | null>(null);
  // The remote-only branch pending a server-side delete confirm. Every confirm
  // below records the repo it opened in (`repo`, or the `…In` value itself): a
  // confirm answered after a switch away from it refuses.
  const [remoteDeleteTarget, setRemoteDeleteTarget] = useState<{
    remote: string;
    name: string;
    repo: string;
  } | null>(null);
  const shownRemoteDeleteTarget = useRetained(remoteDeleteTarget);
  const [discardAllIn, setDiscardAllIn] = useState<string | null>(null);
  const [stashAllIn, setStashAllIn] = useState<string | null>(null);
  const [stashPopIn, setStashPopIn] = useState<string | null>(null);
  const [stashesOpen, setStashesOpen] = useState(false);
  // Which view the Stashes dialog opens to — "recoverable" for "Recover lost
  // work…" and its palette action, "stashes" otherwise.
  const [stashesView, setStashesView] = useState<"stashes" | "recoverable">(
    "stashes",
  );
  const [opHistoryOpen, setOpHistoryOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [picker, setPicker] = useState<{
    mode: PickerMode;
    repo: string;
  } | null>(null);
  const [rebaseOntoIn, setRebaseOntoIn] = useState<string | null>(null);
  // The publish intercepted by the fork-PR guard, with everything needed to
  // resume it verbatim if the user publishes anyway.
  const [forkGuard, setForkGuard] = useState<{
    match: ForkPrMatch;
    branch: Branch;
    remote?: string;
    repo: string;
  } | null>(null);
  // A publish still deciding, with the repo it runs in: from the press until
  // its prompt, guard, return or fork-PR check settle, it paints the row's
  // spinner and counts as a running push. The ref mirrors it for the
  // fire-time guard and the hotkey continuations, which a stale render misleads.
  const [publishDetect, setPublishDetect] = useState<PublishDetect | null>(
    null,
  );
  const publishDetectRef = useRef<PublishDetect | null>(null);
  // The pending switch target. `remote` is set only for remote-only rows, which
  // check out via `--track <remote>/<name>` (honoring the row's promised remote
  // + dodging multi-remote DWIM ambiguity); local switches leave it null.
  const [switchTarget, setSwitchTarget] = useState<{
    name: string;
    remote: string | null;
    repo: string;
  } | null>(null);
  // "Reapply after switching" — seeded from the saved preference each time the
  // dialog opens fresh, and persisted back when the user changes it.
  const [reapplyOnSwitch, setReapplyOnSwitch] = useState(false);
  // Whether the user touched that checkbox since the dialog last opened. A ref
  // because the dirty-tree refusal branch reads it after an await. It gates two
  // things: the auto-tick there (an explicit untick is the user's call and is
  // never overridden) and the persist below, so an auto-tick stays session-only.
  const reapplyTouchedRef = useRef(false);
  // Why a first switch attempt didn't work, shown when the dialog re-opens.
  const [switchHint, setSwitchHint] = useState<string | null>(null);
  // The worktree pending a "Promote to main workspace" confirm — set by the
  // palette action and the branch row's worktree menu (the Worktrees dialog
  // hosts its own promote flow).
  const [promoteTarget, setPromoteTarget] = useState<UserWorktree | null>(null);
  // Branch-row worktree menu targets — the rename and lock flows reuse the
  // Worktrees dialog's own dialogs.
  const [renameWorktreeTarget, setRenameWorktreeTarget] =
    useState<UserWorktree | null>(null);
  const [lockWorktreeTarget, setLockWorktreeTarget] =
    useState<UserWorktree | null>(null);

  const head = status.data?.branch;
  const currentName = head?.name ?? null;
  // The live branch name, readable AFTER an await. A handler's closure still holds
  // the `currentName` of the render that created it, and `status.data` read inside
  // one is that same render's snapshot — neither can tell whether HEAD moved
  // during a confirmation the user left open. Same ref pattern SyncControls uses
  // to guard its reset. Load-bearing for `git reset --hard`, which carries no
  // branch identity: it rewrites whatever HEAD points at now.
  const currentNameRef = useRef(currentName);
  useEffect(() => {
    currentNameRef.current = currentName;
  }, [currentName]);
  const currentLabel = head?.detached
    ? `detached @ ${head.oid?.slice(0, 7) ?? "?"}`
    : (currentName ?? "…");
  // Agent-session branches (`gd/session/*`) are app-internal — never list or act
  // on them in the switcher. Critically, a *kept* session's worktree is removed
  // but its branch persists, so without this filter its branch would show here
  // with Delete enabled, and `git branch -D` would destroy a branch the sessions
  // registry still needs to Resume. (Worktrees-side exclusion doesn't cover the
  // branch list, which comes straight from `git for-each-ref`.)
  // Memoized by hand: every downstream memo lists `allBranches` as a dep, so
  // its identity holds per `branches.data` whatever the compiler decides.
  const allBranches = useMemo(
    () =>
      (branches.data ?? []).filter((b) => !b.name.startsWith("gd/session/")),
    [branches.data],
  );
  // Archived branches are hidden from the list and the merge picker.
  const otherBranches = allBranches.filter((b) => !b.isCurrent && !b.archived);
  const defaultName = defaultBranch.data ?? null;
  // Merge-into-current is gated by the current branch's protection: a
  // "require pull request" rule blocks all direct merges, and a merge-method
  // restriction blocks the disallowed methods.
  const lockCurrent = currentName
    ? requiresPullRequest(rulesConfig, currentName)
    : false;
  // A promotion branch takes its changes through promotions, so the one-click
  // update from the default branch is withheld (the current-branch twin of the
  // per-row `rowPromotion`).
  const currentPromotion = Boolean(
    currentName && isPromotionBranch(rulesConfig, currentName),
  );
  const canMergeIntoCurrent =
    !lockCurrent &&
    (currentName
      ? isMergeMethodAllowed(rulesConfig, currentName, "merge")
      : true);
  const canSquashIntoCurrent =
    !lockCurrent &&
    (currentName
      ? isMergeMethodAllowed(rulesConfig, currentName, "squash")
      : true);
  // Ahead/behind vs. the default branch, fetched only while the menu is open.
  // A 30s window on this observer only, so a quick reopen spawns no recount
  // (the hook's comment owns the invalidation contract and its residual).
  const divergence = useBranchDivergence(repoPath, defaultName, open, 30_000);
  const divByName = useMemo(
    () => new Map((divergence.data ?? []).map((d) => [d.name, d] as const)),
    [divergence.data],
  );

  // The row whose context menu is open, when that row is DIVERGED from its own
  // upstream — the only case worth several rev-list spawns. One slot is enough:
  // a context menu is singular, so the probe follows whichever row was opened
  // last and every other row renders as it always has.
  const [rewriteProbe, setRewriteProbe] = useState<string | null>(null);
  const rewrite = useBranchRewriteStatus(repoPath, rewriteProbe, {
    enabled: rewriteProbe !== null,
  });
  // The list's one shared row menu: its target by KEY, set together with the
  // probe above by the list's capture-phase contextmenu handler, before Base UI
  // opens the menu in that same event. The menu resolves the live row from it on
  // every render, so labels and handlers follow a refetch.
  const [menuTarget, setMenuTarget] = useState<BranchMenuTarget>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  // Read by the close-complete callback, which can fire after a reopen during
  // the exit fade and must not clear the new target.
  const branchMenuOpenRef = useRef(false);
  // The right-click that last set the target: a close caused by that same event
  // is the menu moving to the new row, whose probe is already set.
  const menuTargetEvent = useRef<Event | null>(null);
  const branchMenuActions = useRef<ContextMenuPrimitive.Root.Actions>(null);
  // Bumped by keyboard cursor moves only, so the list scrolls and claims focus
  // for the arrows and never for a click.
  const [focusNonce, setFocusNonce] = useState(0);
  // The popover popup, which bounds where the list may claim focus.
  const branchPopupRef = useRef<HTMLDivElement>(null);
  // A closed popover holds no row menu. An item that closes the popover
  // unmounts the menu mid-fade, so its close callbacks never run to clear these.
  if (
    !open &&
    (menuTarget !== null || rewriteProbe !== null || branchMenuOpen)
  ) {
    setMenuTarget(null);
    setRewriteProbe(null);
    setBranchMenuOpen(false);
  }
  useEffect(() => {
    if (!open) branchMenuOpenRef.current = false;
  }, [open]);
  const queryClient = useQueryClient();

  // Warm those probes when the POPOVER opens, so a right-click a moment later
  // paints its final identity instead of the disabled waiting slot swapping
  // under the pointer. The probe is fast enough locally that the swap lands
  // AFTER the menu paints, which reads as a flash; the only way to remove it is
  // to have the answer before the menu exists. The waiting slot stays as the
  // fallback for a genuinely slow probe.
  //
  // A newline-joined signature, not the array: `allBranches` gets a new identity
  // on every branches refetch, and this must re-run when the diverged SET
  // changes, not when its container does. Git forbids control characters in a
  // ref name, so `\n` can't appear inside one.
  //
  // Capped: each entry is several rev-list spawns, and a repo where many branches
  // are BOTH ahead and behind would otherwise fan out one probe per branch on
  // every popover open. The rows past the cap keep the waiting slot, which is
  // exactly what it is for. Four covers the ordinary 0-2 and leaves headroom
  // without turning an open into a burst.
  const divergedSignature = useMemo(
    () =>
      allBranches
        .filter((b) => b.upstreamAhead > 0 && b.upstreamBehind > 0)
        .slice(0, MAX_REWRITE_PREFETCH)
        .map((b) => b.name)
        .join("\n"),
    [allBranches],
  );
  useEffect(() => {
    if (!open || divergedSignature === "") return;
    for (const name of divergedSignature.split("\n")) {
      // `prefetchQuery` honors the options' staleTime, so a still-fresh entry
      // costs nothing and a reopen inside 30s spawns no git at all.
      void queryClient.prefetchQuery(
        branchRewriteStatusOptions(repoPath, name),
      );
    }
  }, [open, divergedSignature, repoPath, queryClient]);

  // Per-branch PR badge: remote PRs (open + closed, the latter carrying merged)
  // fetched while the menu OR the cleanup dialog is open AND the repo's forge
  // reports pull-request support — mirrors the divergence gate above. The cleanup
  // hotkey closes the menu on its way to the dialog, so gating on `open` alone
  // would leave that dialog's merged badges permanently empty. Local PRs are not
  // gated. Both reads are forge-neutral: they work for GitHub and GitLab alike.
  const gh = useForgeStatus(repoPath);
  const canGh = forgeFeatureReady(gh.data, "pullRequests");
  const prsWanted = canGh && (open || cleanupOpen);
  // Origin lens: the branch popover lists the FORK's own branch PRs; the
  // fork/upstream lens is a Pulls/Issues-tab affordance.
  const openPrs = usePrList(repoPath, prsWanted, "open", undefined, "origin");
  const closedPrs = usePrList(
    repoPath,
    prsWanted,
    "closed",
    CLOSED_PR_SCAN_LIMIT,
    "origin",
  );
  const localPrs = useLocalPrs(repoPath);
  const openPr = useUiStore((s) => s.openPr);
  const repoName = useUiStore((s) => s.repoName);
  const setLens = useSetRepoLens(repoPath);

  const prByBranch = useMemo(() => {
    const map = new Map<string, BranchPr>();
    const consider = (branchName: string, cand: BranchPr) => {
      const cur = map.get(branchName);
      if (!cur || PR_RANK[cand.state] > PR_RANK[cur.state]) {
        map.set(branchName, cand);
      }
    };
    // Remote PRs first, so they win ties against a local PR of equal state.
    for (const pr of [...(openPrs.data ?? []), ...(closedPrs.data ?? [])]) {
      // A cross-repository PR's head lives in a contributor's fork, so it must not
      // badge a same-named local branch. Safe as a blanket skip only because both
      // lists above are origin-pinned. A deliberately checked-out fork-PR head
      // loses its badge too: accepted over-hide, since by name alone the two
      // cases are indistinguishable.
      if (pr.crossRepository) continue;
      const state: PrAuditState =
        pr.isDraft && pr.state === "OPEN"
          ? "draft"
          : (REMOTE_AUDIT_STATE[pr.state] ?? "open");
      consider(pr.headRefName, {
        state,
        label: `#${pr.number}`,
        base: pr.baseRefName,
        select: { kind: "remote", id: String(pr.number) },
      });
    }
    for (const pr of localPrs.data ?? []) {
      const state: PrAuditState = LOCAL_AUDIT_STATE[pr.status];
      consider(pr.head, {
        state,
        label: "local",
        base: pr.base,
        select: { kind: "local", id: pr.id },
      });
    }
    return map;
  }, [openPrs.data, closedPrs.data, localPrs.data]);

  // Branch name → the merged PR that carries it, for the cleanup dialog. Remote
  // PRs only: a local PR's merge is a real git merge, which divergence already
  // sees, and it has no PR number to attribute the badge to. The base must be the
  // default branch — a PR merged into a release branch or a stack parent says
  // nothing about the default branch, which is what that dialog is about. A null
  // `defaultName` matches nothing, so an unresolved default badges nothing.
  const mergedPrByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const [name, pr] of prByBranch) {
      if (
        pr.state === "merged" &&
        pr.select.kind === "remote" &&
        pr.base === defaultName
      )
        map.set(name, pr.label);
    }
    return map;
  }, [prByBranch, defaultName]);

  // Branch name → the PR it maps to that closed without merging, any base, for
  // the cleanup dialog's Closed PR criterion. Remote PRs only, as above; a
  // branch whose best-ranked PR merged elsewhere carries neither label.
  const prClosedByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const [name, pr] of prByBranch)
      if (pr.state === "closed" && pr.select.kind === "remote")
        map.set(name, pr.label);
    return map;
  }, [prByBranch]);

  const prNoun = PR_NOUN[gh.data?.provider ?? "github"];
  /** A row's PR in words: its state, the forge's noun, and the PR's label. */
  const prChipLabel = (pr: BranchPr) =>
    pr.select.kind === "local"
      ? `${PR_STATE_LABEL[pr.state]} local pull request`
      : `${PR_STATE_LABEL[pr.state]} ${prNoun} ${pr.label}`;

  const openPrChip = (select: SelectedPr) => {
    // Through the store's navigator rather than a bare select + tab switch: these
    // chips badge merged and closed PRs too, and only this door arms the align
    // that moves the Pulls list to the tab the PR is actually on.
    openPr({
      kind: select.kind,
      repoPath,
      repoName: repoName ?? repoNameFromPath(repoPath),
      ref: select.id,
      section: null,
      // A remote PR here is a fork (origin) PR — force the origin lens (which also
      // clears any stale upstream remote selection) before navigating to it. Inside
      // the navigator's callback, so the lens and the selection land together.
      beforeSelect:
        select.kind === "remote" ? () => setLens("origin") : undefined,
    });
    setOpen(false);
  };

  // Branches checked out in *another* worktree → that worktree's path. Git
  // forbids the same branch in two worktrees, so these can't be checked out
  // here; the row opens that worktree instead. The active repo's own branch is
  // excluded (it's the one you're on). Fetched while the menu OR the cleanup
  // dialog is open: that dialog's archive and delete exclusions read this map,
  // and the cleanup hotkey closes the menu on its way to it.
  const userWorktrees = useUserWorktrees(repoPath, open || cleanupOpen);
  const activeNorm = normPath(repoPath);
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of userWorktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, w.path);
    }
    return map;
  }, [userWorktrees.data, activeNorm]);
  // The same branches with what the cleanup dialog needs to remove their
  // worktree. Main-workspace entries stay in, so the dialog can tell "held by
  // main" (never removable) from "not held".
  const worktreeFacts = useMemo(() => {
    const map = new Map<
      string,
      { path: string; isLocked: boolean; isMain: boolean }
    >();
    for (const w of userWorktrees.data ?? [])
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, {
          path: w.path,
          isLocked: w.isLocked,
          isMain: w.isMain,
        });
    return map;
  }, [userWorktrees.data, activeNorm]);
  // Cross-worktree state (same fetch as the map above): the main workspace the
  // banner links to, the count the Worktrees row shows, and whether you're
  // currently in a linked (non-main) worktree — where a branch checkout lands
  // here, not in main.
  const worktreeList = userWorktrees.data ?? [];
  const currentWorktree = worktreeList.find(
    (w) => normPath(w.path) === activeNorm,
  );
  const mainWorktree = worktreeList.find((w) => w.isMain);
  // Linked ones only: the main workspace isn't a "worktree" in user vocabulary,
  // and this is the set the dialog's own empty state keys on.
  const linkedWorktreeCount = worktreeList.filter((w) => !w.isMain).length;
  const inLinkedWorktree = Boolean(currentWorktree && !currentWorktree.isMain);
  // A worktree whose folder is being removed still lists (the removal outlives
  // the dialog that started it), but nothing may act on it until it settles.
  // Raw paths on both sides: these and the removals' come from listUserWorktrees.
  const removals = useWorktreeRemovals(repoPath);
  const removingPaths = new Set(removals.map((r) => r.path));
  const currentWorktreeName = currentWorktree
    ? baseName(currentWorktree.path)
    : "";
  // Default branch pinned on top, then the rest by most recently committed.
  // Memoized: the compiler won't hoist the `.sort()` copy or the filter
  // allocations, and these recompute on every filter keystroke otherwise.
  const sortedBranches = useMemo(
    () =>
      [...allBranches].sort((a, b) => {
        if (a.name === defaultName) return -1;
        if (b.name === defaultName) return 1;
        return b.lastCommitDate.localeCompare(a.lastCommitDate);
      }),
    [allBranches, defaultName],
  );
  // Row ORDER freezes while the list is open, so an update that moves a branch's
  // commit date doesn't reorder rows under the pointer; row data stays live.
  // Snapshotted IN the open transition, so the first open frame already paints
  // it — `onOpenChange` and the show-branches hotkey are the only ways in. An
  // open before the first read lands holds no snapshot (an empty one would
  // freeze nothing), and the effect below takes it when the rows arrive.
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  // This instance outlives repo switches, and a held cross-repo landing can switch
  // under an open menu: drop the old repo's snapshot and arrow cursor (both name
  // its rows) so the effect below re-snapshots the new list. The filter stays: it
  // is the user's visible input, and the switch can land mid-keystroke.
  const [orderRepo, setOrderRepo] = useState(repoPath);
  if (orderRepo !== repoPath) {
    setOrderRepo(repoPath);
    setFrozenOrder(null);
    setActiveBranch(null);
    setMenuTarget(null);
    setRewriteProbe(null);
  }
  const snapshotOrder = () =>
    setFrozenOrder(
      branches.data === undefined ? null : sortedBranches.map((b) => b.name),
    );
  // Idempotent: it acts only while the open list holds no snapshot, and a close
  // clears the snapshot along with `open`.
  useEffect(() => {
    if (open && frozenOrder === null && branches.data !== undefined)
      setFrozenOrder(sortedBranches.map((b) => b.name));
  }, [open, frozenOrder, branches.data, sortedBranches]);
  const orderedBranches = useMemo(
    () => applyFrozenOrder(sortedBranches, frozenOrder, (b) => b.name),
    [sortedBranches, frozenOrder],
  );
  const listState = branchListState({
    errorUpdateCount: branches.errorUpdateCount,
    hasData: branches.data !== undefined,
  });
  // The Try again line unmounts under focus when the rows land; the filter input
  // survives every list state, so it takes the focus back.
  const listRescue = useRetryFocusRescue(open && listState.mode === "failed");
  const { hostRef: listHostRef, retryRef: listRetryRef } = listRescue;
  // One string for the failure line and the status region, so they can't disagree.
  const listRetrying = branchListRetrying(listState.mode, branches);
  const listLine = listRetrying
    ? BRANCH_LIST_LOADING
    : BRANCH_LIST_STATUS[listState.mode];
  const bq = branchFilter.trim().toLowerCase();
  const visibleBranches = useMemo(
    () =>
      orderedBranches.filter(
        (b) => !b.archived && (!bq || b.name.toLowerCase().includes(bq)),
      ),
    [orderedBranches, bq],
  );
  const archivedBranches = useMemo(
    () =>
      orderedBranches.filter(
        (b) => b.archived && (!bq || b.name.toLowerCase().includes(bq)),
      ),
    [orderedBranches, bq],
  );
  // Both dialogs stay mounted, so the name-generation queries gate on one being
  // open AND on AI being usable at all — otherwise a Hide-AI or unconfigured
  // user pays for `git branch -r` plus two `git log` walks feeding a button that
  // never renders.
  const branchDialogOpen =
    (createOpen || renameTarget !== null) && aiEnabled && aiConfigured;
  // Remote-only branches, fetched while the menu is open or a branch dialog is
  // (the dialog resolves the committed-work base off this list, and the palette
  // can open it without the menu ever opening). Drop ones a local branch already
  // represents (that row shows ahead/behind + PR) and gd/session/* branches;
  // dedupe a branch on multiple remotes to one row.
  const remoteBranchesQuery = useRemoteBranches(
    repoPath,
    open || branchDialogOpen,
  );
  // One prefetch per repo for an open that skips the shell warm-up (a same-repo
  // remount from a non-repo view), so the menu still opens with its Remote group.
  // The hook stays open-gated; a fresh warmed entry makes this a no-op.
  useEffect(() => {
    if (!repoPath) return;
    void queryClient.prefetchQuery({
      ...remoteBranchesOptions(repoPath),
      staleTime: REMOTE_BRANCHES_STALE_TIME,
    });
  }, [repoPath, queryClient]);
  const localNames = useMemo(
    () => new Set(allBranches.map((b) => b.name)),
    [allBranches],
  );
  const remoteOnly = useMemo(() => {
    const seen = new Set<string>();
    return (remoteBranchesQuery.data ?? [])
      .filter(
        (b) =>
          !isSessionBranchName(b.name) &&
          !localNames.has(b.name) &&
          (!bq || b.name.toLowerCase().includes(bq)),
      )
      .filter((b) => (seen.has(b.name) ? false : (seen.add(b.name), true)))
      .sort((a, b) => b.lastCommitDate.localeCompare(a.lastCommitDate));
  }, [remoteBranchesQuery.data, localNames, bq]);
  // One gate for the Remote group's render and its arrow-key rows, so the nav
  // list never reaches a row that isn't on screen.
  const showRemoteSection =
    listState.remoteGroupMayRender && remoteOnly.length > 0;
  // The one row stream the list windows, headers included, and the arrow stops
  // beside it. By hand like the chain above: the list re-keys its rows on this
  // identity.
  const { flatRows, navNames } = useMemo(
    () =>
      buildBranchMenuRows({
        visibleBranches,
        archivedBranches,
        showArchived,
        remoteOnly,
        showRemote,
        showRemoteSection,
      }),
    [
      visibleBranches,
      archivedBranches,
      showArchived,
      remoteOnly,
      showRemote,
      showRemoteSection,
    ],
  );
  // The menu target's LIVE row: local by name, remote by its remote and name
  // pair, so a refetch can't move "Delete on <remote>…" to another remote.
  const menuLocal =
    menuTarget?.kind === "local"
      ? branches.data?.find((b) => b.name === menuTarget.name)
      : undefined;
  const menuRemote =
    menuTarget?.kind === "remote"
      ? remoteOnly.find(
          (b) => b.remote === menuTarget.remote && b.name === menuTarget.name,
        )
      : undefined;
  const menuTargetLive = menuLocal !== undefined || menuRemote !== undefined;
  // What the menu paints: the live row, or the last one it resolved while a
  // vanished target's menu fades out, so it never shows an empty popup.
  const shownMenuRow = useRetained<Branch | RemoteBranch | undefined>(
    menuLocal ?? menuRemote,
  );
  // An open menu whose row is gone (deleted, now local, or cleared by a repo
  // switch) closes before that frame paints. Through the actions handle, so
  // both close callbacks run.
  useLayoutEffect(() => {
    if (branchMenuOpen && !menuTargetLive) branchMenuActions.current?.close();
  }, [branchMenuOpen, menuTargetLive]);
  // The ref being named, whose committed work the AI fallback describes: the
  // rename target (which need NOT be checked out) or the checked-out branch for
  // a create; null ⇒ both closed. Create names the BRANCH, not the literal
  // "HEAD", so the comparison's cache key changes when you switch branches —
  // keyed on "HEAD" a fast Generate would serve the previous branch's commits.
  // A detached HEAD has no branch name to key on and keeps the literal.
  const namedRef =
    renameTarget ?? (createOpen ? (currentName ?? "HEAD") : null);
  // The rename target's live upstream BRANCH, for the dialog's note: read off the
  // merge ref (never the short upstream string), so a gone, local (`.`, which
  // git reports as the remote name) or non-branch upstream gives no note.
  const renameRow =
    renameTarget === null
      ? undefined
      : branches.data?.find((b) => b.name === renameTarget);
  const renameTargetUpstream =
    renameRow &&
    !renameRow.upstreamGone &&
    renameRow.upstreamRemote &&
    renameRow.upstreamRemote !== "." &&
    renameRow.upstreamRemoteRef?.startsWith("refs/heads/")
      ? {
          remote: renameRow.upstreamRemote,
          branch: renameRow.upstreamRemoteRef.slice("refs/heads/".length),
        }
      : null;
  // The same ref in rev form: a branch by its full ref (a bare name resolves to a
  // same-named tag first); the detached literal stays as it is.
  const namedRev =
    namedRef === null || namedRef === "HEAD"
      ? namedRef
      : `refs/heads/${namedRef}`;
  // Until the remote list settles, a missing `origin/<default>` means "not
  // loaded yet", not "absent" — falling back to the local default there is
  // exactly the stale ref this base resolution exists to avoid.
  const remoteBranchesSettled = !remoteBranchesQuery.isPending;
  // The default branch names the comparison base, so its own lookup gates the
  // fallback too: a null `defaultName` while it's still loading must not read as
  // "this repo has no default branch".
  const defaultBranchSettled = !defaultBranch.isPending;
  // Base for the fallback. Prefer the remote-tracking ref: a stale local default
  // skews the three-dot diff, and when origin/HEAD resolved the default name the
  // local twin may not even exist. Null (⇒ no fallback) when neither side has it.
  // The rev is the full ref (a bare `origin/<default>` or `<default>` resolves to a
  // same-named tag first); the label is what the copy shows.
  const committedBase = useMemo((): { rev: string; label: string } | null => {
    // An errored remote list can't be trusted as a base either: no base ⇒ no
    // fallback ⇒ the error state below renders instead of a silent local default.
    if (
      !branchDialogOpen ||
      !defaultName ||
      !remoteBranchesSettled ||
      remoteBranchesQuery.isError
    )
      return null;
    const onOrigin = (remoteBranchesQuery.data ?? []).some(
      (b) => b.remote === "origin" && b.name === defaultName,
    );
    if (onOrigin)
      return {
        rev: `refs/remotes/origin/${defaultName}`,
        label: `origin/${defaultName}`,
      };
    return localNames.has(defaultName)
      ? { rev: `refs/heads/${defaultName}`, label: defaultName }
      : null;
  }, [
    branchDialogOpen,
    defaultName,
    remoteBranchesSettled,
    remoteBranchesQuery.isError,
    remoteBranchesQuery.data,
    localNames,
  ]);
  // Commits the named ref has that the default doesn't. A null base leaves the
  // query disabled (both dialogs closed, or no resolvable default).
  const committedCompare = useBranchAhead(
    repoPath,
    committedBase?.rev ?? null,
    namedRev,
  );
  // Mirrors `useBranchAhead`'s own enabled condition — a query that never
  // runs (base === compare: naming the local default with no `origin/<default>`)
  // must not read as "still loading" forever.
  const comparing =
    committedBase !== null &&
    namedRev !== null &&
    committedBase.rev !== namedRev;
  // Never let the affordance claim there's no committed work on evidence it
  // doesn't have: while any input is in flight say so, and say so distinctly
  // when the lookup failed outright.
  const committedStatus: "ready" | "pending" | "error" = !branchDialogOpen
    ? "ready"
    : !defaultBranchSettled ||
        (Boolean(defaultName) && !remoteBranchesSettled) ||
        (comparing && committedCompare.isPending)
      ? "pending"
      : defaultBranch.isError ||
          remoteBranchesQuery.isError ||
          (comparing && committedCompare.isError)
        ? "error"
        : "ready";
  const committedFallback = useMemo(() => {
    const ahead = committedCompare.data ?? [];
    if (!committedBase || !namedRev || ahead.length === 0) return null;
    // `ahead` is newest-first (plain `git log base..<ref>`); cap the subjects.
    return {
      base: committedBase.label,
      baseRev: committedBase.rev,
      compare: namedRev,
      subjects: ahead.slice(0, 30).map((c) => c.subject),
    };
  }, [committedBase, namedRev, committedCompare.data]);
  // Only label rows with their remote when there's more than one to disambiguate.
  const multipleRemotes = useMemo(
    () =>
      new Set((remoteBranchesQuery.data ?? []).map((b) => b.remote)).size > 1,
    [remoteBranchesQuery.data],
  );
  // Arrow-key nav over the visible rows (+ archived/remote when expanded); Enter
  // on the focused row checks out via the row button's native click.
  const navBranches = navNames;
  const onBranchKeyDown = listKeyboardNav({
    items: navBranches,
    activeIndex: activeBranch === null ? -1 : navBranches.indexOf(activeBranch),
    onActivate: (name) => {
      setActiveBranch(name);
      setFocusNonce((n) => n + 1);
    },
    rowKey: (name) => name,
  });
  // A row focused without the arrows (a context menu's close hands focus back to
  // it, a click, Tab) becomes the arrows' cursor, so the next arrow moves from it.
  const focusRow = (name: string) => {
    if (activeBranch !== name) setActiveBranch(name);
  };
  const stashes = stashCount.data ?? 0;
  const hasChanges = (status.data?.entries.length ?? 0) > 0;
  // Which switch attempt is current. `switchTo` can suspend on the worktree
  // lookup, and the popover reopens long before a stalled `git worktree list`
  // returns — so a later attempt must be able to retire an earlier one rather
  // than both acting.
  const switchRequestRef = useRef(0);
  // The live answer, readable AFTER an await — same pattern as `currentNameRef`.
  // `switchTo` can resume on a worktree lookup that outlived the render it
  // started in, and a tree that turned dirty meanwhile must still get the
  // bring/stash choice instead of a silent checkout.
  const hasChangesRef = useRef(hasChanges);
  useEffect(() => {
    hasChangesRef.current = hasChanges;
  }, [hasChanges]);
  // Rebase refuses only on dirty TRACKED files, so the proactive stash offer
  // keys on this — an untracked-only tree rebases fine, and stashing it
  // unasked would move those files into a stash on any replay conflict.
  const hasTrackedChanges = (status.data?.entries ?? []).some(
    (e) =>
      e.staged !== null || (e.unstaged !== null && e.unstaged !== "untracked"),
  );
  // Naming a branch from changes needs a commit to diff against; an unborn HEAD
  // (no commits) has nothing to compare the working tree to.
  const headExists = Boolean(head?.oid);
  // You can't amend across branches: amend mode targets a specific commit on
  // this branch, so switching would strand the in-progress amend and leave its
  // banner up. Lock the switcher until the user finishes or stops amending.
  const amending = amendingHash !== null;
  // The repo's configured remotes — ground truth for resolving a branch's
  // upstream remote and for the per-remote Publish choices.
  const remoteNames = remotes.data ?? [];

  const onError = (e: unknown) => toastError(e);

  // Awaited, not per-call callbacks: react-query drops those when the observer
  // loses its listeners — a hidden `<Activity>` tab or an unmounted host — and
  // the outcome would never reach the user. Every mutation below follows suit.
  async function setArchived(name: string, archived: boolean) {
    // Unarchiving is exempt, as in the menu's render hold.
    if (archived && refuseWhileBranchPushes(name)) return;
    const done = archived ? `Archived ${name}` : `Unarchived ${name}`;
    try {
      await setBranchArchived.mutateAsync({ name, archived });
      toast.success(done);
    } catch (e) {
      onError(e);
    }
  }

  async function doUnlockWorktree(path: string) {
    try {
      await unlockWorktree.mutateAsync(path);
      toast.success("Worktree unlocked");
    } catch (e) {
      onError(e);
    }
  }

  // Dispatch the actual checkout — remote-only targets track a specific remote,
  // local targets use plain switch. Both share the guards in `switchTo`. The
  // failure handler stays per-CALLER: each one recovers differently.
  async function runCheckout(
    target: { name: string; remote: string | null },
    opts?: { onError?: (e: unknown) => void },
  ) {
    // Read at fire time: the promote's claim never re-renders anything.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    try {
      if (target.remote) {
        await checkoutRemote.mutateAsync({
          remote: target.remote,
          name: target.name,
        });
      } else {
        await checkout.mutateAsync(target.name);
      }
    } catch (e) {
      if (opts !== undefined) {
        if (opts.onError !== undefined) {
          opts.onError(e);
        }
      }
    }
  }

  // Now async: the worktree answer decides whether a row checks out or
  // navigates, and it can still be in flight when the click lands.
  async function switchTo(name: string, remote: string | null = null) {
    if (amending) return; // guarded by the disabled trigger; belt-and-suspenders
    // Claimed after the amending bail so a no-op click can't retire a real
    // attempt that is still resolving.
    const switchRequest = ++switchRequestRef.current;
    setOpen(false);
    // A branch checked out in another worktree can't be checked out here (git
    // forbids it), so the row navigates there instead. No confirm on the badged
    // path — the chip already says where the branch lives, and opening a folder
    // is not a destructive act.
    let wtPath = worktreeByBranch.get(name);
    let resolvedHere: UserWorktree | undefined;
    // The open-gated read hasn't answered yet, or is answering again — and only
    // a NEGATIVE verdict is distrusted: a hit stays a hit (a listed worktree
    // still exists, and mid-removal is `refuseWhileLeaving`'s job), but a miss
    // is worthless from a list that is unanswered or in flight, because
    // react-query serves the previous data through a refetch and every worktree
    // mutation invalidates this key. (The header's always-on observer keeps the
    // key warm under the hook's 30s staleTime, so a miss inside that window is
    // trusted; git's own checkout refusal backstops it.) Routed through
    // `fetchQuery` on that same key so a click during the refetch JOINS it
    // instead of racing it with a second `git worktree list`. A failed lookup
    // falls through to the ordinary checkout, where git refuses with its own
    // message. Local rows only: a remote-only row's name has no local branch
    // by construction, so no worktree can hold it and the lookup would only
    // add a subprocess.
    if (
      remote === null &&
      !wtPath &&
      !userWorktrees.isError &&
      (userWorktrees.data === undefined || userWorktrees.isFetching)
    ) {
      // A watermark, not a claim: the lookup usually ends in a plain checkout,
      // and a claim here would retire a pending repo open on every cold click.
      const noNewerOpen = repoOpenWatermark();
      try {
        // Shared options, not a second spelling: this key's `networkMode:
        // "always"` is what keeps an offline read from PARKING forever, and a
        // parked fetch would hang this await with the popover already closed —
        // no navigation, no checkout, no toast. `retry: false` drops the
        // client's one retry plus backoff when this call STARTS the fetch; a
        // call that joins one already in flight inherits that fetch's options.
        const wts = await queryClient.fetchQuery({
          ...userWorktreesOptions(repoPath),
          retry: false,
        });
        resolvedHere = wts.find(
          (w) => w.branch === name && normPath(w.path) !== activeNorm,
        );
        if (resolvedHere !== undefined) wtPath = resolvedHere.path;
        else wtPath = undefined;
      } catch {
        // fall through
      }
      // BELOW the try/catch, so every exit (resolved, rejected, found-nothing)
      // re-takes each read that gates the global writes past here: the repo (else
      // they hit the one the user left), the attempt (a later pick started its own
      // switch), and amend mode (a checkout would strand it); `hasChangesRef` and
      // the removal store read live. The reapply default stays the click render's
      // value on purpose: it only seeds a checkbox the user then sees.
      const live = useUiStore.getState();
      if (
        switchRequest !== switchRequestRef.current ||
        live.amendingHash !== null ||
        (wtPath !== undefined && !noNewerOpen())
      )
        return;
      if (
        refuseIfSwitched(
          repoPath,
          "no branch was checked out",
          "before the switch started",
        )
      )
        return;
    }
    if (wtPath) {
      // Its folder is on its way out — opening it would land the app in a
      // directory mid-deletion.
      // Read at FIRE time, not from the render's Set: this line can run after
      // the lookup's await, and a removal that started meanwhile would be
      // invisible to a pre-await snapshot. `refuseWhileLeaving` already reads
      // the promote half live; this is its removal twin.
      if (
        refuseWhileLeaving(
          wtPath,
          Boolean(
            useWorktreeRemovalStore.getState().byRepo[repoPath]?.[wtPath],
          ),
        )
      )
        return;
      // Only when this call resolved the worktree itself: that state is exactly
      // the one where the map was empty, so the row carried no chip and the whole
      // app just changed folders with no prior signal. Say so after the fact.
      const openedCopy =
        resolvedHere && rowCheckoutCopy(resolvedHere.isMain).opened(wtPath);
      // The attempt check rides INTO the open: its `validateRepo` and shell
      // warm-up sit downstream of this function's guard, and a newer pick during
      // them leaves the repo unchanged, so only the attempt identity can retire
      // this one. The toast waits for the landing: a failed open, one retired
      // before it was requested, or a Settings-held one that Keep editing
      // cancels never moved the app.
      await openWorktree(
        wtPath,
        () => switchRequest === switchRequestRef.current,
        {
          onApplied: () => {
            if (openedCopy) toast.success(openedCopy);
          },
        },
      );
      return;
    }
    // with work in progress, let the user choose to bring or stash it
    if (hasChangesRef.current) {
      setSwitchHint(null);
      setReapplyOnSwitch(settings.data?.reapplyStashOnSwitch ?? false);
      reapplyTouchedRef.current = false;
      setSwitchTarget({ name, remote, repo: repoPath });
      return;
    }
    void runCheckout({ name, remote }, { onError });
  }

  function bringAndSwitch() {
    if (!switchTarget) return;
    if (refuseIfSwitched(switchTarget.repo, "no branch was checked out")) {
      setSwitchTarget(null);
      return;
    }
    // Ahead of closing the dialog, so a refusal keeps it; `runCheckout` re-checks.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const target = switchTarget;
    // Captured with the target: the refusal branch below runs after an await and
    // must decide from the touched flag as it stood when THIS switch started — a
    // dialog reopened mid-checkout owns the live values.
    const touched = reapplyTouchedRef.current;
    setSwitchTarget(null);
    void runCheckout(target, {
      onError: (e) => {
        // git refused to carry the changes over rather than failing outright —
        // re-open the choice with stashing pointed out, instead of a dead-end
        // toast. Reapply is auto-ticked for this switch alone (session-only: the
        // persist below stays gated on an explicit toggle) so the changes still
        // come along — unless the user unticked it here, which stands.
        if (isDirtyTreeRefusal(e)) {
          // This lands after the checkout's await: a choice reopened in a repo
          // the user has left could only refuse, so say what happened instead.
          if (
            refuseIfSwitched(
              target.repo,
              "no branch was checked out",
              "before the checkout finished",
            )
          )
            return;
          if (!touched) setReapplyOnSwitch(true);
          setSwitchHint(
            "Bringing changes didn't work — git would overwrite them. Stash and switch instead.",
          );
          setSwitchTarget(target);
          return;
        }
        onError(e);
      },
    });
  }

  // One compound (stash → switch → optionally pop) under a single repo lock,
  // for both checkbox states — the unchecked path just skips the pop.
  async function stashAndSwitch() {
    if (!switchTarget) return;
    if (refuseIfSwitched(switchTarget.repo, "no branch was checked out")) {
      setSwitchTarget(null);
      return;
    }
    // Ahead of every state write, so a refusal keeps the dialog and its choices.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const target = switchTarget;
    const reapply = reapplyOnSwitch;
    setSwitchTarget(null);
    if (
      reapplyTouchedRef.current &&
      settings.data &&
      settings.data.reapplyStashOnSwitch !== reapply
    ) {
      // Fire-and-forget, and deliberately silent: a preference that didn't
      // persist must neither delay the switch nor report over its outcome.
      void saveSettings
        .mutateAsync({ ...settings.data, reapplyStashOnSwitch: reapply })
        .catch(() => undefined);
    }
    try {
      const outcome = await switchAutostash.mutateAsync({
        name: target.name,
        remote: target.remote,
        reapply,
      });
      reportAutostashOutcome(
        outcome,
        {
          operation: "Switch",
          reapplied: `Stashed, switched to ${target.name}, and reapplied your changes.`,
          stashedOnly: `Stashed changes and switched to ${target.name} — "Pop latest stash" restores them`,
          plain: `Switched to ${target.name}.`,
          // Names the branch the switch failed to reach — more useful than the
          // generic didn't-finish line.
          stashKept: `Couldn't switch to ${target.name} — your changes are safely stashed; pop them when you're ready.`,
        },
        {
          repoPath,
          operationLabel: "switch",
          detail: target.name,
          detailPreposition: "to",
        },
      );
    } catch (e) {
      onError(e);
    }
  }

  // The dialog seeds its own form field on open; the switcher only flags which
  // branch is being renamed.
  function openRename(branch: string) {
    setOpen(false);
    // The two branch dialogs are mutually exclusive: their palette actions can
    // fire while the other is open, and both feed the SAME committed-work
    // lookup — leaving both open would name a new branch from the rename
    // target's diff.
    setCreateOpen(false);
    setRenameTarget(branch);
  }

  async function doDelete() {
    // Session-checked clears below an await: by the settle the confirm may have
    // been reopened on another branch, or the same name in another repo.
    const session = deleteSessionRef.current;
    if (!deleteTarget || !session) return;
    const deleteIn = session.repo;
    const clearTarget = () => {
      if (deleteSessionRef.current === session) closeDelete();
    };
    if (refuseIfSwitched(deleteIn, "nothing was deleted")) {
      closeDelete();
      return;
    }
    // The guard below reads not-blocked from the stand-in config while the rules
    // are still loading, so it would pass vacuously — refuse instead of deleting
    // a branch a settled rule protects.
    if (rulesSettling) {
      toast.error("Branch rules are still loading — try again in a moment");
      closeDelete();
      return;
    }
    // Belt-and-suspenders: the menu items are already disabled for protected
    // branches, but guard here too in case a rule changed under an open dialog.
    if (isDeletionBlocked(rulesConfig, deleteTarget)) {
      toast.error(
        `${deleteTarget} is protected from deletion by a branch rule`,
      );
      closeDelete();
      return;
    }
    // Outside the try, whose `.finally` cleanup would close the confirm.
    if (refuseWhileBranchPushes(deleteTarget)) return;
    await (async () => {
      try {
        // Between freeing its branch and checking it out, a promote leaves that
        // branch in no checkout, so git would let it be deleted from under it.
        if (promotionBlocksCheckout(repoPath)) {
          toast.info(PROMOTION_BLOCKS_CHECKOUT);
          return;
        }
        // git refuses to delete the checked-out branch: move off it first — onto a
        // branch not already occupied by another worktree (that checkout fails too).
        if (deleteTarget === currentName) {
          // Fetch occupancy FRESH: `worktreeByBranch` only observes its query
          // while the popover or cleanup dialog is open, and even a warm cache
          // (the header keeps one now) can be stale for a guard this destructive.
          let occupied: Set<string>;
          try {
            const wts = await listUserWorktrees(repoPath);
            occupied = new Set(
              wts
                .filter(
                  (w) => w.branch && normPath(w.path) !== normPath(repoPath),
                )
                .map((w) => w.branch),
            );
          } catch {
            occupied = new Set(worktreeByBranch.keys());
          }
          // A mutate past an await builds from the observer's CURRENT options, so
          // the checkout and delete below would act on whichever repo is live now;
          // a switch during the lookup refuses instead.
          if (
            refuseIfSwitched(
              deleteIn,
              "nothing was deleted",
              "before the delete started",
            )
          )
            return;
          // Inside the try, so the `.finally` clearTarget closes the confirm on
          // this refusal; the one before the try leaves it open.
          if (refuseWhileBranchPushes(deleteTarget)) return;
          const free = (b: string | null | undefined): b is string =>
            Boolean(b) && b !== deleteTarget && !occupied.has(b as string);
          let fallback: string | undefined;
          if (free(defaultName)) {
            fallback = defaultName;
          } else {
            const found = otherBranches.find((b) => free(b.name));
            if (found !== undefined) fallback = found.name;
          }
          if (!fallback) {
            toast.error(
              "Can't switch off this branch — every other branch is checked out in a worktree.",
            );
            clearTarget();
            return;
          }
          // Below the occupancy await, so a promote that started meanwhile counts;
          // nothing has been written yet, so the delete is refused whole.
          if (promotionBlocksCheckout(repoPath)) {
            toast.info(PROMOTION_BLOCKS_CHECKOUT);
            return;
          }
          await checkout.mutateAsync(fallback);
          // The same for the delete, which starts only after the checkout lands.
          if (
            refuseIfSwitched(
              deleteIn,
              `${fallback} is checked out and ${deleteTarget} was kept`,
              `before ${deleteTarget} was deleted`,
            )
          )
            return;
          if (
            refuseWhileBranchPushes(
              deleteTarget,
              `A push is already running — ${fallback} is checked out and ${deleteTarget} was kept.`,
            )
          )
            return;
        }
        await deleteBranch.mutateAsync(deleteTarget);
        toast.success(`Deleted ${deleteTarget}`);
      } catch (e) {
        onError(e);
      }
    })().finally(() => {
      clearTarget();
    });
  }

  async function doDeleteRemoteBranch() {
    if (!remoteDeleteTarget) return;
    const target = remoteDeleteTarget;
    if (refuseIfSwitched(target.repo, "nothing was deleted")) {
      setRemoteDeleteTarget(null);
      return;
    }
    // The confirm can sit open across a disconnect, or from before a push started
    // (a remote delete is a push, so it would queue behind it); refusing keeps it
    // open.
    if (
      refuseWhileOffline() ||
      pushAlreadyActive() ||
      refuseWhilePublishing(queryClient, repoPath)
    )
      return;
    const deleting = (async () => {
      try {
        await deleteRemoteBranch.mutateAsync({
          remote: target.remote,
          name: target.name,
        });
        toast.success(
          `Deleted ${target.name} on ${target.remote}${landedIn(target.repo).away}`,
        );
      } catch (e) {
        onError(e);
      }
    })();
    await deleting.finally(() => {
      // Functional, for the same reason as the local delete's clear: each open
      // hands a fresh row object, so identity already marks the session.
      setRemoteDeleteTarget((cur) => (cur === target ? null : cur));
    });
  }

  async function doDiscardAll() {
    await (async () => {
      try {
        if (!discardAllIn) return;
        if (refuseIfSwitched(discardAllIn, "nothing was discarded")) return;
        await discardAll.mutateAsync(undefined);
        toast.success("All changes discarded");
      } catch (e) {
        onError(e);
      }
    })().finally(() => {
      setDiscardAllIn(null);
    });
  }

  async function doStashAll() {
    await (async () => {
      try {
        if (!stashAllIn) return;
        if (refuseIfSwitched(stashAllIn, "nothing was stashed")) return;
        // A new stash buries the recorded backup, so its offer can only refuse.
        useStashReapplyMarker.getState().clearFor(stashAllIn);
        await stashAll.mutateAsync(undefined);
        toast.success("Changes stashed");
      } catch (e) {
        onError(e);
      }
    })().finally(() => {
      setStashAllIn(null);
    });
  }

  async function doStashPop() {
    await (async () => {
      try {
        if (!stashPopIn) return;
        if (refuseIfSwitched(stashPopIn, "no stash was popped")) return;
        // A conflict here must not read as the recorded reapply's.
        useStashReapplyMarker.getState().clearFor(stashPopIn);
        await stashPop.mutateAsync(undefined);
        toast.success("Stash restored");
      } catch (e) {
        onError(e);
      }
    })().finally(() => {
      setStashPopIn(null);
    });
  }

  // The picker dialog seeds its own branch + options on open; the switcher only
  // flags which mode is active.
  function openPicker(mode: PickerMode) {
    setOpen(false);
    setPicker({ mode, repo: repoPath });
  }

  // A merge into the current branch touches the working tree, so git refuses it
  // outright when uncommitted changes are in the way — offer the stash → merge →
  // reapply compound instead of a dead-end toast. `false` leaves the error to
  // the caller.
  function beginMergeRecovery(e: unknown, branch: string) {
    return recovery.handleError(e, {
      operationLabel: "merge",
      detail: branch,
      reappliedMessage: `Merged ${branch} and reapplied your changes.`,
      plainMessage: `Merged ${branch}`,
      run: { op: "merge", ref: branch },
    });
  }

  // Rebase refuses on ANY dirty tracked file, not just one the replay would
  // touch, so this dead-ends more often than the merge above — offer the same
  // stash → rebase → reapply compound. `false` leaves the error to the caller.
  function beginRebaseRecovery(e: unknown, branch: string) {
    return recovery.handleError(e, {
      operationLabel: "rebase",
      detail: branch,
      detailPreposition: "onto",
      reappliedMessage: `Rebased onto ${branch} and reapplied your changes.`,
      plainMessage: `Rebased onto ${branch}`,
      run: { op: "rebase", ref: branch },
    });
  }

  // The dialog collects the branch + options; the switcher owns the mutations
  // (they feed `busy`) and dispatches them here after closing the picker.
  async function runPicker(
    mode: PickerMode,
    branch: string,
    options: MergeRunOptions,
  ) {
    const pickedIn = picker?.repo;
    // A merge would queue on the network lock a running push holds, and a rebase
    // would rewrite the current branch under its own push (the picker can predate
    // the push). Refused before the picker closes, so the picked branch and
    // options survive; a switched repo keeps its own refusal below.
    if (pickedIn === repoPath) {
      const refused =
        mode === "rebase" ? refuseWhileCurrentPushes() : pushAlreadyActive();
      if (refused) return;
    }
    setPicker(null);
    const nothing =
      mode === "rebase" ? "nothing was rebased" : "nothing was merged";
    if (!pickedIn || refuseIfSwitched(pickedIn, nothing)) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (mode === "rebase") {
      try {
        await rebaseBranch.mutateAsync(branch);
        toast.success(`Rebased onto ${branch}`);
      } catch (e) {
        if (beginRebaseRecovery(e, branch)) return;
        onError(e);
      }
    } else {
      const squash = mode === "squash";
      // Options apply to a regular merge only, not squash.
      const noFf = mode === "merge" && options.noFf;
      const strategy = mode === "merge" ? options.strategy : "none";
      // The stash-and-retry compound runs a bare `merge --no-edit`, so it can
      // only redo a merge that asked for nothing else — offering it for the
      // others would quietly drop the option the user chose.
      const plain = !squash && !noFf && strategy === "none";
      const done = squash
        ? `Squashed ${branch} — changes are staged, review and commit`
        : `Merged ${branch}`;
      try {
        await mergeBranch.mutateAsync({ branch, squash, noFf, strategy });
        toast.success(done);
      } catch (e) {
        if (plain) {
          if (beginMergeRecovery(e, branch)) return;
        }
        onError(e);
      }
    }
  }

  function openCreate() {
    setOpen(false);
    // Mutually exclusive with the rename dialog — see `openRename`.
    setRenameTarget(null);
    setCreateOpen(true);
  }

  function openRebaseOnto() {
    setOpen(false);
    setRebaseOntoIn(repoPath);
  }

  // The dialog collects the two branches; the switcher owns the mutation (it
  // feeds `busy`). Conflicts leave the rebase in progress for the conflict
  // banner, exactly like the plain rebase above.
  //
  // Proactive rather than error-triggered: the dialog already knows the tree is
  // dirty, and git would refuse before touching anything, so offering the
  // compound up front beats a round-trip that can only fail.
  async function runRebaseOnto(newBase: string, oldBase: string) {
    const pickedIn = rebaseOntoIn;
    // Refused before the dialog closes, as the picker's run is.
    if (pickedIn === repoPath && refuseWhileCurrentPushes()) return;
    setRebaseOntoIn(null);
    if (!pickedIn || refuseIfSwitched(pickedIn, "nothing was rebased")) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const request = {
      operationLabel: "rebase",
      detail: newBase,
      detailPreposition: "onto",
      reappliedMessage: `Rebased onto ${newBase} and reapplied your changes.`,
      plainMessage: `Rebased onto ${newBase}`,
      run: { op: "rebaseOnto", newBase, oldBase },
    } as const;
    if (hasTrackedChanges) {
      recovery.begin(request);
      return;
    }
    try {
      await rebaseOnto.mutateAsync({ newBase, oldBase });
      toast.success(`Rebased onto ${newBase}`);
    } catch (e) {
      // `hasTrackedChanges` is a query-state read that can trail the tree: a
      // file saved between the check and the run still deserves the offer, so
      // a dirty refusal routes back into the same recovery.
      if (recovery.handleError(e, request)) return;
      onError(e);
    }
  }

  // A branch update only touches the working tree when it merges in place, i.e.
  // when the updated branch IS the current one — the throwaway-worktree path is
  // always clean. The branch check is belt-and-suspenders on top of the error
  // classification; a mismatch falls through to the normal error toast.
  function beginUpdateRecovery(e: unknown, branch: string, base: string) {
    if (branch !== currentName) return false;
    return recovery.handleError(e, {
      operationLabel: "update",
      detail: base,
      reappliedMessage: `Updated from ${base} and reapplied your changes.`,
      plainMessage: `Updated ${branch} from ${base}`,
      run: { op: "merge", ref: base },
    });
  }

  // Another checkout holds the branch and the update couldn't run there: the
  // remedy is opening that checkout, so the refusal toasts with it as the action
  // and any git output behind the first line rides Details in the cancel slot.
  function toastBranchHeld(e: unknown) {
    if (!isAppError(e) || e.kind !== "branchHeld") return false;
    const holder = e.holder;
    const holderEntry = (userWorktrees.data ?? []).find(
      (w) => normPath(w.path) === normPath(holder),
    );
    const presentation = presentError(e);
    toast.error(presentation.summary, {
      duration: 8000,
      // A session holder is a checkout the app keeps out of view (agent sessions,
      // update husks), so only the user's own worktrees get the open remedy.
      action:
        e.reason === "session"
          ? undefined
          : {
              label: rowCheckoutCopy(holderEntry?.isMain).open,
              onClick: () => {
                // Read at FIRE time: the toast outlives the render's removal
                // snapshot, and a removal or promote may have started since.
                if (
                  refuseWhileLeaving(
                    holder,
                    Boolean(
                      useWorktreeRemovalStore.getState().byRepo[repoPath]?.[
                        holder
                      ],
                    ),
                  )
                )
                  return;
                setOpen(false);
                void openWorktree(holder);
              },
            },
      cancel: presentation.long ? errorToastAction(presentation) : undefined,
    });
    return true;
  }

  // The menu can outlive the state that disabled its update items, and a
  // promote's claim never re-renders it. A worktree removal doesn't wait on the
  // working-tree lock a holder update takes, so the two must never overlap.
  function refuseUpdateWhileHolderLeaving(target: string) {
    const holder = worktreeByBranch.get(target);
    return (
      holder !== undefined &&
      refuseWhileLeaving(holder, removingPaths.has(holder))
    );
  }

  const defaultBranchRow = allBranches.find((b) => b.name === defaultName);
  // `patchEqual > 0` is strong evidence, not proof — two sides can apply the
  // same patch independently. It only WITHHOLDS a merge, so a false read costs
  // an explained no-op, never a duplicated history.
  function rewrittenUpstream(status: BranchRewriteStatus) {
    return status.remoteRewritten === true && status.patchEqual > 0;
  }
  function warnRewrittenUpstream(row: Branch, status: BranchRewriteStatus) {
    // The remedy has to match what the row actually offers: only the
    // nothing-unique case gets a reset item there. With local-only commits the
    // row shows a disabled update and no reset, so point at the pull that keeps
    // them.
    const remedy = carriesAllLocalCommits(status)
      ? `Open the branch menu and use the ${row.name} row's reset instead.`
      : `Switch to ${row.name} and use Pull with rebase — it keeps the ${status.localOnly} commit${status.localOnly === 1 ? "" : "s"} only ${row.name} has.`;
    toast.warning(
      `${row.upstream} already carries ${row.name}'s changes under different ids — merging it in would duplicate them.`,
      { description: remedy, duration: 10000 },
    );
  }
  // The fire-time rewrite probes an update from the default branch needs, each
  // gated as updateDefaultFromUpstream's is: only a DIVERGED branch can hold a
  // rewrite (a duplicate takes local commits with patch twins upstream). Merging
  // the default's diverged upstream (the secondary item's base): that upstream
  // may carry the default's commits rewritten. Merging a branch's OWN diverged
  // upstream: only the footer and hotkey reach it, having no own-upstream item
  // to carry the row's render-time probe (the row menu omits that duplicate).
  function rewriteProbesFor(target: string, base: string): Branch[] {
    const rows: Branch[] = [];
    const def = defaultBranchRow;
    if (
      def &&
      !def.upstreamGone &&
      def.upstream === base &&
      def.upstreamAhead > 0 &&
      def.upstreamBehind > 0
    )
      rows.push(def);
    // The unfiltered list: a checked-out gd/session/* branch still updates
    // from the hotkey and footer, and still needs its own-row probe.
    const own = branches.data?.find((b) => b.name === target);
    if (
      own &&
      !own.upstreamGone &&
      own.upstream === base &&
      own.upstreamAhead > 0 &&
      own.upstreamBehind > 0
    )
      rows.push(own);
    return rows;
  }
  // Runs the probes against the hook's own cached options; true = withheld
  // (with a warning) or the repo changed during them (with its notice).
  async function withheldForRewrite(
    rows: Branch[],
    target: string,
  ): Promise<boolean> {
    const updateIn = repoPath;
    const statuses = await Promise.all(
      rows.map((r) =>
        queryClient
          .fetchQuery(branchRewriteStatusOptions(repoPath, r.name))
          .catch(() => null),
      ),
    );
    if (
      refuseIfSwitched(
        updateIn,
        `${target} wasn't updated`,
        "before the update started",
      )
    )
      return true;
    for (const [i, status] of statuses.entries()) {
      if (status && rewrittenUpstream(status)) {
        warnRewrittenUpstream(rows[i], status);
        return true;
      }
    }
    return false;
  }
  // Pull the latest from the default branch into `target` without switching to
  // it (unless it's already current): fast-forwards when possible, otherwise
  // merges via a throwaway worktree so the working tree — and its watchers —
  // stay put. A conflicting merge aborts and reports rather than switching.
  // `base` is what the caller resolved (resolveUpdateFromDefault): the items
  // pass the base their label named, so a list refresh under an open menu
  // can't swap it between paint and click.
  async function doUpdateFromDefault(target: string, base: string) {
    if (!defaultName || target === defaultName) return;
    if (refuseUpdateWhilePushing(target)) return;
    const probes = rewriteProbesFor(target, base);
    if (probes.length > 0) {
      if (await withheldForRewrite(probes, target)) return;
      // The probe's await is a window another push can start in.
      if (refuseUpdateWhilePushing(target)) return;
    }
    // Only an in-place update can open the recovery dialog over the list; every
    // other row updates with the popover open and refreshes in place.
    if (target === currentName) setOpen(false);
    // The guard below reads not-a-promotion from the stand-in config while the
    // rules are still loading, so it would pass vacuously — refuse instead of
    // inverting a flow a settled rule names as promotion.
    if (rulesSettling) {
      toast.error("Branch rules are still loading — try again in a moment");
      return;
    }
    // The doors into this are already disabled for promotion branches, but a
    // rule can change under an open menu — and this is the only refusal the
    // hotkey path passes through.
    if (isPromotionBranch(rulesConfig, target)) {
      toast.error(
        `${target} is a promotion branch — it takes changes through promotions, not updates from ${base}`,
      );
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (refuseUpdateWhileHolderLeaving(target)) return;
    let outcome:
      | Awaited<ReturnType<typeof updateBranchFrom.mutateAsync>>
      | undefined;
    try {
      outcome = await updateBranchFrom.mutateAsync({
        branch: target,
        base,
      });
    } catch (e) {
      if (toastBranchHeld(e)) return;
      if (!beginUpdateRecovery(e, target, base)) onError(e);
      return;
    }
    toast.success(
      outcome.outcome === "up-to-date"
        ? `${target} is already up to date with ${base}`
        : `Updated ${target} from ${base}`,
    );
  }

  // An update moves `target`'s ref, which that branch's own push may be sending,
  // and one of the CURRENT branch merges in place, on the network lock a push
  // holds. Any other branch updates in a throwaway worktree, off that lock. Read at
  // fire time, for a menu or shortcut pressed from before the push started.
  function refuseUpdateWhilePushing(target: string): boolean {
    if (branchPushing(target)) {
      toast.info(BRANCH_PUSH_ACTIVE_MESSAGE);
      return true;
    }
    return target === currentName && pushAlreadyActive();
  }

  // Pull `target`'s own upstream (e.g. `origin/master`) into it without checking
  // it out — the "just merged a PR, bring master current before I switch back"
  // flow. Merges in place when `target` is current, fast-forwards otherwise.
  async function doUpdateFromUpstream(target: string, base: string) {
    if (refuseUpdateWhilePushing(target)) return;
    if (target === currentName) setOpen(false);
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (refuseUpdateWhileHolderLeaving(target)) return;
    let outcome:
      | Awaited<ReturnType<typeof updateBranchFrom.mutateAsync>>
      | undefined;
    try {
      outcome = await updateBranchFrom.mutateAsync({
        branch: target,
        base,
      });
    } catch (e) {
      if (toastBranchHeld(e)) return;
      if (!beginUpdateRecovery(e, target, base)) onError(e);
      return;
    }
    toast.success(
      outcome.outcome === "up-to-date"
        ? `${target} is already up to date with ${base}`
        : `Updated ${target} from ${base}`,
    );
  }

  // The remedy for a branch whose upstream already carries its changes under
  // other ids: point the branch back at that upstream instead of merging it in,
  // which would duplicate them. `tip` is the sha the status was measured against,
  // so a confirmed reset can only land where the copy said it would, and
  // `localTip` the branch's own tip then, so a commit landed meanwhile refuses the
  // reset in the backend instead of being dropped. The current branch takes the
  // hard reset (its working tree moves too); every other branch is a ref move,
  // which is why it works even from another checkout.
  async function doResetToUpstream(
    branch: Branch,
    tip: string,
    localTip: string,
  ) {
    const base = branch.upstream;
    if (!base) return;
    setOpen(false);
    const treeNote = branch.isCurrent
      ? ` Your files are rewritten to match, so commit or stash any uncommitted changes first.`
      : "";
    const n = branch.upstreamAhead;
    const alreadyThere =
      n === 1
        ? `The only commit on ${branch.name} is already on ${base} under a different id`
        : `All ${n} commits on ${branch.name} are already on ${base} under different ids`;
    const resetIn = repoPath;
    const ok = await useConfirm.getState().ask({
      title: `Reset ${branch.name} to ${base}?`,
      body: `${alreadyThere}, so no unique work is lost. ${branch.name} moves to ${base}'s tip.${treeNote}`,
      confirmLabel: `Reset to ${base}`,
      confirmVariant: "destructive",
    });
    if (!ok) return;
    // Both resets build from the observer's CURRENT options once the prompt
    // resolves, so they would act on whichever repo is live then: the hard
    // reset's HEAD check below passes on a same-named branch there, and the ref
    // move's `expectedTip` refuses only when that branch sits elsewhere. A switch
    // under the prompt refuses instead.
    if (refuseIfSwitched(resetIn, "nothing was reset")) return;
    if (refuseWhileBranchPushes(branch.name)) return;
    // Below the confirm: a promote can start while the prompt is open.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    if (branch.isCurrent) {
      // The confirmation above spans an await, and HEAD can move under it — an
      // out-of-app `git switch`, or the app's own checkout. `reset --hard`
      // names no branch, so a moved HEAD would rewrite whatever is checked out
      // NOW to a tip measured for a branch the user is no longer on. The ref
      // reads live; the captured name is the only branch the confirmation
      // described. Says so rather than returning quietly: the user just
      // confirmed a destructive action, and silence there reads as "it
      // worked". Wording kept in step with the sync controls' twin and with
      // HistoryDialogs' Reset to commit pre-check.
      if (currentNameRef.current !== branch.name) {
        toast.info("HEAD moved while the dialog was open — nothing was reset.");
        return;
      }
      // An outside fetch can move the upstream while the prompt sits open, so
      // the reset re-measures before it acts. A read that joins one in flight
      // may have begun before that fetch's ref write and return the older tip;
      // the reset then lands on the tip the probe proved carries every local
      // commit.
      let fresh: BranchRewriteStatus;
      try {
        fresh = await queryClient.fetchQuery({
          ...branchRewriteStatusOptions(repoPath, branch.name),
          staleTime: 0,
        });
      } catch (e) {
        toastErrorWithNote(e, "Nothing was reset.");
        return;
      }
      if (refuseIfSwitched(resetIn, "nothing was reset")) return;
      // A push can start during the re-read; the reset moves the tip it sends.
      if (refuseWhileBranchPushes(branch.name)) return;
      // No measurable upstream tip proves nothing moved.
      if (fresh.upstreamTip === null) {
        toast.info(UNCONFIRMED_NOTICE(base, branch.name));
        return;
      }
      if (fresh.upstreamTip !== tip) {
        toast.info(UPSTREAM_MOVED_NOTICE(base));
        return;
      }
      // Same upstream tip, but the read no longer proves the upstream carries
      // every commit: name a local move only when the read measured one, since
      // an unknown verdict (a failed reflog walk) proves nothing moved. A local
      // move that is still carried proceeds, and the backend's pin refuses it.
      if (!carriesAllLocalCommits(fresh)) {
        if (fresh.localTip !== null && fresh.localTip !== localTip) {
          toast.info(LOCAL_MOVED_NOTICE(branch.name));
        } else {
          toast.info(UNCONFIRMED_NOTICE(base, branch.name));
        }
        return;
      }
      // A promote can start during the re-read.
      if (promotionBlocksCheckout(repoPath)) {
        toast.info(PROMOTION_BLOCKS_CHECKOUT);
        return;
      }
      try {
        await hardReset.mutateAsync({
          hash: tip,
          expectedHead: localTip,
          expectedBranch: branch.name,
        });
      } catch (e) {
        onError(e);
        return;
      }
    } else {
      try {
        await resetToUpstream.mutateAsync({
          branch: branch.name,
          expectedTip: tip,
          expectedLocalTip: localTip,
        });
      } catch (e) {
        onError(e);
        return;
      }
    }
    toast.success(`Reset ${branch.name} to ${base}`);
  }

  // Push a branch's ref without checking it out — the outbound counterpart of
  // doUpdateFromUpstream. Whether this publishes (-u) or plain pushes is decided
  // backend-side from the branch's tracking state. The publish arms pass an
  // explicit `remote` (the chosen destination); a tracked push passes none and
  // the backend resolves to the branch's own upstream remote. A tracked push or
  // a publish the remote already has leaves the list open: a push holds only the
  // network lock, so the row shows its progress and the rest of the list stays
  // usable. A publish that would create the branch closes it for its prompt.
  function doPushBranch(branch: Branch, remote?: string) {
    if (
      refuseWhileOffline() ||
      pushAlreadyActive() ||
      refuseWhilePublishing(queryClient, repoPath)
    )
      return;
    if (willPublish(branch)) void beginPublishBranch(branch, remote);
    else
      void runPushBranch(
        branch,
        remote,
        pushOutcome({
          willPublish: false,
          create: undefined,
          presence: undefined,
        }),
      );
  }

  // One push at a time, re-checked where each network-lock route fires: a menu
  // can be stale under the pointer, and the backend would queue the route behind
  // the push for up to a minute. The shared cache check, plus this switcher's
  // own fork-PR detection, read live from its ref. The publish that owns the
  // detection passes it as `mine`: its own check is not another push.
  function pushAlreadyActive(mine?: PublishDetect): boolean {
    if (publishDetectRef.current === mine)
      return refuseWhilePushRuns(queryClient, repoPath);
    if (publishDetectRef.current?.repo === repoPath) {
      toast.info(BRANCH_PUSH_ACTIVE_MESSAGE);
      return true;
    }
    return refuseWhilePushRuns(queryClient, repoPath);
  }

  // Fire-time hold for routes that move or remove `branch`'s ref: the fork-PR
  // detection, the latched render read, and the live cache for pushes started
  // after this render. A HEAD push's recorded start keeps that branch held after
  // a checkout, and the current branch is held too.
  function refuseWhileBranchPushes(
    branch: string,
    message = BRANCH_PUSH_ACTIVE_MESSAGE,
  ): boolean {
    const detect = publishDetectRef.current;
    const live = pendingBranchPushesFor(
      pendingMutationEntries(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: branchPushKey(repoPath), status: "pending" }),
      ),
      repoPath,
    );
    if (
      !(detect?.repo === repoPath && detect.branch === branch) &&
      !branchPushing(branch) &&
      !pushesBranch(live, branch, currentNameRef.current)
    )
      return false;
    toast.info(message);
    return true;
  }

  // Publishing a branch that is really a local copy of a fork PR's head pushes a
  // separate copy to this repo and leaves the PR untouched — check for that
  // before publishing, and let the guard offer the fork instead. Advisory: a
  // detection failure is indistinguishable from no match and falls through to
  // the publish confirm.
  async function beginPublishBranch(branch: Branch, remote?: string) {
    const publishIn = repoPath;
    const mine: PublishDetect = {
      branch: branch.name,
      remote: remote ?? null,
      repo: publishIn,
    };
    publishDetectRef.current = mine;
    setPublishDetect(mine);
    // The fork-PR check runs alongside the local reads, in two phases: before
    // the ask its settle only records, and the decision reads that record after
    // the last await; once the prompt is up, a settle swaps it for the guard or
    // releases its hold. A holder object, so the record keeps its type across
    // the awaits.
    let asked: ConfirmRequest | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = { settled: false, found: null as ForkPrMatch | null };
    // The row holds from the press until the prompt (the modal is the
    // exclusion from then on), the guard, a return, or the check's settle,
    // whichever is first. Compare-and-clear, so a newer detection (in another
    // repo) keeps its slot.
    let marked = true;
    const releaseMark = () => {
      if (!marked) return;
      marked = false;
      if (publishDetectRef.current === mine) publishDetectRef.current = null;
      setPublishDetect((cur) => (cur === mine ? null : cur));
    };
    // The guard dialog takes over from the list.
    const openGuard = (match: ForkPrMatch) => {
      setOpen(false);
      setForkGuard({ match, branch, remote, repo: publishIn });
    };
    // A match lands only on this press's own prompt, still showing, in the repo
    // it was asked in; anything later is dropped without a word.
    const onPromptSettle = (m: ForkPrMatch | null) => {
      clearTimeout(timer);
      if (m === null) {
        useConfirm.getState().setRequestHold(asked, {});
        return;
      }
      if (
        asked !== null &&
        useConfirm.getState().request === asked &&
        landedIn(publishIn).live
      ) {
        withdrawPublishConfirm(publishAsk);
        openGuard(m);
      }
    };
    const check = forgeDetectForkPrForBranch(publishIn, branch.name)
      .catch(() => null)
      .then((m) => {
        probe.settled = true;
        probe.found = m;
        releaseMark();
        if (asked !== null) onPromptSettle(m);
        return m;
      });
    // A named publish with no remote goes to origin (the backend's default). A
    // branch the destination already has (as of the last fetch) only
    // fast-forwards and tracks, so only a create asks first; the list mirrors the
    // destination's FETCH side, so a differing push URL asks too.
    const destination = remote ?? "origin";
    const switchedAway = () =>
      refuseIfSwitched(
        publishIn,
        "nothing was published",
        "before the push started",
      );
    const [list, fetchUrl, pushUrl] = await Promise.all([
      queryClient
        .fetchQuery(remoteBranchesOptions(publishIn))
        .catch(() => undefined),
      gitRemoteUrl(publishIn, destination).catch(() => null),
      gitRemotePushUrl(publishIn, destination).catch(() => null),
    ]);
    if (switchedAway()) {
      releaseMark();
      return;
    }
    // A push that started during the reads refuses before any prompt.
    if (
      pushAlreadyActive(mine) ||
      refuseWhilePublishing(queryClient, repoPath)
    ) {
      releaseMark();
      return;
    }
    const presence = presenceUnderUrls(
      remoteHasBranch(list, destination, branch.name),
      fetchUrl,
      pushUrl,
    );
    const create = willCreateOnRemote({
      upstream: branch.upstream,
      upstreamGone: branch.upstreamGone,
      remoteHasSameName: presence,
    });
    if (create) {
      // The prompt takes over from the list; it opens once the list's close
      // has returned focus to its trigger, and it stamps whichever repo is live
      // when it asks. Without a prompt the list stays open while the row pushes.
      setOpen(false);
      await listClose.waitClosed();
      if (switchedAway()) {
        releaseMark();
        return;
      }
      // The decision point: nothing awaits between here and the ask, so a
      // match that settled while the list closed opens the guard instead.
      releaseMark();
      if (probe.settled && probe.found) {
        // Also takes over from this switcher's own publish prompt when a
        // repeat press matched while it was up.
        withdrawPublishConfirm(publishAsk);
        openGuard(probe.found);
        return;
      }
      const answer = askPublishConfirm(
        {
          branch: branch.name,
          remote: destination,
          pushUrl,
          visibility: visibilityApplies(destination, fetchUrl, pushUrl)
            ? recordedVisibility(settings.data?.recentRepos, publishIn)
            : null,
          goneUpstream: branch.upstreamGone,
          upstreamRemote: branch.upstreamRemote,
          upstreamBranch: branch.upstreamRemoteRef?.startsWith("refs/heads/")
            ? branch.upstreamRemoteRef.slice("refs/heads/".length)
            : null,
          heldReason: probe.settled ? undefined : PUBLISH_FORK_CHECK_REASON,
        },
        publishAsk,
      );
      asked = publishAsk.current;
      // Past the bound Publish frees with a note; the hold's identity pin
      // makes a fire on a gone prompt a no-op.
      if (!probe.settled) {
        timer = setTimeout(() => {
          if (!probe.settled)
            useConfirm
              .getState()
              .setRequestHold(asked, { note: PUBLISH_FORK_CHECK_NOTE });
        }, PUBLISH_FORK_CHECK_BOUND_MS);
        void answer.finally(() => clearTimeout(timer));
      }
      const ok = await answer;
      if (!ok) return;
    } else {
      // No prompt to hold, so the check decides before the push, and the
      // refusals re-run after it: it can take the backend's whole bound.
      const match = await check;
      releaseMark();
      // `push` builds from the live repo's options once the detection
      // resolves, while the branch and the fork match belong to this one: a
      // switch during the round-trip refuses rather than publish there.
      const { live, away } = landedIn(publishIn);
      if (!live) {
        toast.info(
          `Didn't publish ${branch.name}${away} — you switched repositories before the push started.`,
        );
        return;
      }
      if (pushAlreadyActive() || refuseWhilePublishing(queryClient, repoPath))
        return;
      if (match) {
        withdrawPublishConfirm(publishAsk);
        openGuard(match);
        return;
      }
    }
    // runPushBranch re-checks offline and running pushes at its own entry.
    void runPushBranch(
      branch,
      remote,
      pushOutcome({ willPublish: true, create, presence }),
    );
  }

  // `outcome` is decided before the push from last-fetch presence: the push
  // IPC reports no created-vs-updated signal.
  async function runPushBranch(
    branch: Branch,
    remote: string | undefined,
    outcome: PushOutcome,
  ) {
    // The fork-PR guard's "Publish anyway" and the detection's fall-through land
    // here without passing doPushBranch.
    if (
      refuseWhileOffline() ||
      pushAlreadyActive() ||
      refuseWhilePublishing(queryClient, repoPath)
    )
      return;
    const copyRemote = remote ?? "origin";
    const pushedIn = repoPath;
    try {
      await push.mutateAsync({
        setUpstream: false,
        branch: branch.name,
        remote,
      });
      const { away } = landedIn(pushedIn);
      const copy = pushSuccessCopy({
        outcome,
        branch: branch.name,
        remote: copyRemote,
        tracks: true,
        away,
      });
      if (copy) toast.success(copy.title, { description: copy.description });
      else toast.success(`Pushed ${branch.name} to ${branch.upstream}${away}`);
    } catch (e) {
      onError(e);
    }
  }

  // Every in-flight branch update in this repo, branch → base, read from the
  // mutation cache: the observer tracks only its latest call, and updates on
  // different rows run in parallel.
  const localWrites = usePendingLocalPrWrites(repoPath);
  const updatingBase = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of localWrites)
      if (w.kind === "update-from" && w.head !== null)
        map.set(w.head, w.base ?? "");
    return map;
  }, [localWrites]);
  // Stamped by the update and push items, read by the popup's click-capture
  // handler.
  const fallThroughGuardUntil = useRef(0);
  // A push holds only the network lock, so it stays out of `busy`: its own row
  // and the items that would queue on that lock hold on `pushActive` instead.
  const busy =
    checkout.isPending ||
    checkoutRemote.isPending ||
    mergeBranch.isPending ||
    rebaseBranch.isPending ||
    rebaseOnto.isPending ||
    // Only an in-place update holds the surface; other rows update in parallel.
    (currentName !== null && updatingBase.has(currentName)) ||
    resetToUpstream.isPending ||
    hardReset.isPending ||
    switchAutostash.isPending ||
    recovery.pending;

  // Every push in flight in this repo, from the mutation cache, so a reopened
  // list or a switch back still shows a push an earlier render started.
  const pendingPushes = usePendingBranchPushes(repoPath);
  const pendingPushIds = usePendingBranchPushIds();
  // A HEAD push (the header's plain push) names no branch, so for display each
  // is latched to the branch it recorded starting on, else the one current when
  // it first shows here: a checkout mid-push keeps its row spinner on that
  // branch. The fire-time holds also cover the current branch. State adjusted
  // in render (never a ref: the compiler would skip the component), keyed on
  // the mutation id so the adjust is idempotent. An id leaves only once it is
  // pending in NO repo, so a switch away and back still finds it latched.
  const [pushLatch, setPushLatch] = useState<Readonly<Record<number, string>>>(
    {},
  );
  const nextLatch = nextPushLatch(
    pushLatch,
    pendingPushes,
    pendingPushIds,
    currentName,
  );
  if (nextLatch) setPushLatch(nextLatch);
  /** The branch a pending push paints: its own, or the one its HEAD push
   *  latched. */
  const pushBranchOf = (p: BranchPushState): string | null =>
    p.branch ??
    (p.mutationId !== null && Object.hasOwn(pushLatch, p.mutationId)
      ? pushLatch[p.mutationId]
      : null);
  // A publish of THIS repo still deciding counts as a push (see `publishDetect`
  // for when it lets go): the push it decides comes next.
  const detectingBranch =
    publishDetect !== null && publishDetect.repo === repoPath
      ? publishDetect.branch
      : null;
  // "A push is running" in this repo — what one-push-at-a-time and the items
  // that would queue on the network lock hold on.
  const pushActive = pendingPushes.length > 0 || detectingBranch !== null;
  // A repository publish (from any worktree) holds every push route; the
  // handlers re-check at the press.
  const publishActive = usePendingPublishes(repoPath).length > 0;
  // Feeds the parked-write copy: a push parked offline is waiting, not running.
  const pushPaused = pendingPushes.some((p) => p.paused);
  const pushOnBranch = (name: string) =>
    pendingPushes.find((p) => pushBranchOf(p) === name);
  const branchPushing = (name: string) =>
    detectingBranch === name || pushOnBranch(name) !== undefined;
  const currentRowPushing = currentName !== null && branchPushing(currentName);
  const currentPushPaused =
    currentName !== null && (pushOnBranch(currentName)?.paused ?? false);
  // The current branch's own push holds the rebases that would rewrite it, with
  // the pushing row's reset wording on the label.
  const currentPushSuffix = currentRowPushing
    ? ` (${currentPushPaused ? branchPushHoldItemReason(true) : "pushing…"})`
    : "";

  // Every "there is none" reason below derives from a query whose empty answer
  // and whose UNANSWERED state are the same value — `?? null` for the names,
  // `?? 0` for the counts. Asserting the absence on that value tells a user with
  // a dirty tree on `master` that HEAD is detached and nothing is uncommitted,
  // so no arm may assert an absence until its own read has actually answered.
  // All four are unconditional, so `isPending` means no answer yet, including a
  // refetch of a read that has only ever failed, which the sticky failure arm
  // inside `unread` outranks. A failed first read leaves the SAME undefined
  // value a pending one does, so it gets its own arm rather than the
  // assertion — and it isn't even short-lived: the query client retries once,
  // only `status` polls, so for branches/defaultBranch/stashCount the failure
  // stands until a refocus or an invalidation. Each value below is null once
  // its read has answered, and otherwise the honest reason it can't.
  const unread = (
    q: { isPending: boolean; errorUpdateCount: number; data: unknown },
    checking: string,
    failed: string,
  ) => {
    // Sticky and checked first: a never-loaded query that errored goes back to
    // pending on every refetch, so `isPending` would flip it back to checking.
    // An error over data that already landed is a failed REFRESH, not a missing
    // answer: the row still has something true to say, so it says it.
    if (q.data === undefined && q.errorUpdateCount > 0) return failed;
    if (q.isPending) return checking;
    return null;
  };
  const headUnread = unread(
    status,
    "Checking the current branch…",
    `${STATUS_READ_FAILED_REASON}.`,
  );
  const changesUnread = unread(
    status,
    "Checking for uncommitted changes…",
    `${STATUS_READ_FAILED_REASON}.`,
  );
  const defaultBranchUnread = unread(
    defaultBranch,
    "Checking the default branch…",
    "Couldn't read the default branch.",
  );
  const branchesUnread = unread(
    branches,
    "Checking branches…",
    BRANCH_LIST_READ_FAILED,
  );
  const stashCountUnread = unread(
    stashCount,
    "Checking for stashes…",
    "Couldn't read the stashes.",
  );

  // Why each multi-condition menu row is held, arms in the order that row's own
  // `disabled` expression tests them. Null where the label already carries the
  // reason — a row must not say it twice.
  const renameCurrentBlockedReason = (() => {
    // A rename moves the ref the running push is sending.
    if (currentRowPushing) return branchPushHoldReason(pushPaused);
    if (headUnread !== null) return headUnread;
    if (currentName !== null && isSessionBranchName(currentName))
      return "Agent-session branches can't be renamed — renaming one breaks the session's Resume.";
    return "HEAD is detached — there's no current branch to rename.";
  })();
  const deleteCurrentBlockedReason = (() => {
    if (!currentName)
      return (
        headUnread ?? "HEAD is detached — there's no current branch to delete."
      );
    // Branch protection: the label already states it.
    if (isDeletionBlocked(rulesConfig, currentName)) return null;
    // A delete removes the ref the running push is sending.
    if (currentRowPushing) return branchPushHoldReason(pushPaused);
    return null;
  })();
  const updateFromDefaultBlockedReason = (() => {
    if (!defaultName)
      return defaultBranchUnread ?? "This repository has no default branch.";
    if (!currentName)
      return headUnread ?? "HEAD is detached — there's no branch to update.";
    if (defaultName === currentName) return `You're already on ${defaultName}.`;
    // Without the list, the default's upstream is unknown, and so is the base. A
    // promotion rule holds whether or not the list lands, so it isn't displaced.
    if (branchesUnread && !currentPromotion) return branchesUnread;
    // An in-place update waits on the network lock a push holds.
    if (pushActive) return branchPushHoldReason(pushPaused);
    if (busy) return "Another git operation is running.";
    // The remaining arm is the promotion rule, which the label already states.
    return null;
  })();
  // The branch-count rows below share a shape: an unanswered branch list counts
  // as zero, but a branch rule holds whether or not that list has landed — so an
  // unanswered count yields to the rule arms rather than displacing them, and
  // only a row with no rule against it reports that the list isn't in yet.
  const mergeIntoCurrentBlockedReason = (() => {
    if (otherBranches.length === 0) {
      if (!branchesUnread) return "There are no other branches to merge from.";
      if (canMergeIntoCurrent) return branchesUnread;
    }
    // A merge waits on the network lock a push holds.
    if (pushActive) return branchPushHoldReason(pushPaused);
    if (lockCurrent) return null; // the label says "(requires PR)"
    if (!canMergeIntoCurrent)
      return `A branch rule doesn't allow merge commits on ${currentName}.`;
    return null;
  })();
  const squashIntoCurrentBlockedReason = (() => {
    if (otherBranches.length === 0) {
      if (!branchesUnread) return "There are no other branches to merge from.";
      if (canSquashIntoCurrent) return branchesUnread;
    }
    if (pushActive) return branchPushHoldReason(pushPaused);
    if (lockCurrent)
      return `A branch rule requires a pull request to change ${currentName}.`;
    if (!canSquashIntoCurrent)
      return `A branch rule doesn't allow squash merges on ${currentName}.`;
    return null;
  })();
  const rebaseCurrentBlockedReason = (() => {
    if (otherBranches.length === 0) {
      if (!branchesUnread) return "There are no other branches to rebase onto.";
      if (!lockCurrent && !currentRowPushing) return branchesUnread;
    }
    if (lockCurrent)
      return `A branch rule requires a pull request to change ${currentName}.`;
    return null;
  })();
  const changeBaseBlockedReason = (() => {
    if (!currentName)
      return headUnread ?? "HEAD is detached — there's no branch to rebase.";
    if (otherBranches.length < 2) {
      if (!branchesUnread)
        return "Changing the base needs at least two other branches.";
      // `busy` and the push join the rule arms here: each is true right now,
      // whatever the branch count turns out to be.
      if (!lockCurrent && !busy && !currentRowPushing) return branchesUnread;
    }
    if (lockCurrent)
      return `A branch rule requires a pull request to change ${currentName}.`;
    if (busy) return "Another git operation is running.";
    return null;
  })();
  const noChangesBlockedReason =
    changesUnread ?? "There are no uncommitted changes.";
  const popStashBlockedReason =
    stashCountUnread ?? "There are no stashes to pop.";
  const viewStashesBlockedReason = stashCountUnread ?? "There are no stashes.";

  // Hotkey handlers reuse the menu's own flows, so every gate (clean tree,
  // stash count, picker availability) and confirm dialog applies equally.
  useHotkeyAction(
    "show-branches",
    () => {
      // Silent: a toast over the modal would be noise, and focus stays put.
      if (focusInOpenModal()) return;
      if (!open) snapshotOrder();
      setOpen(true);
    },
    !amending,
  );
  // Push-to-origin: ONE open-aware handler drives both shapes, because the popup
  // is non-modal — a two-handler split lets a focus-outside press act on the
  // wrong branch. The action is ORIGIN-scoped everywhere (label, help text,
  // name), so it must never push somewhere unpredictable; enabled whenever the
  // repo has an origin AND a target resolves (open list, or a current branch),
  // and a non-actionable invocation gives an honest info toast rather than
  // silence.
  const currentBranch = branches.data?.find((b) => b.isCurrent);
  // Held while either push-to-origin route confirms its branch: a second press
  // during the read would otherwise start a second read and push twice. It guards
  // only that read: an operation started meanwhile runs alongside the push, which
  // names its branch explicitly.
  const pushHotkeyChecking = useRef(false);
  function refuseWhileListCatchesUp(pushIn: string) {
    toast.info("The branch list is catching up — try again in a moment.");
    void queryClient.invalidateQueries({
      queryKey: repoKeys.branches(pushIn),
    });
  }
  // The branch list refreshes on focus and after in-app actions, never on the
  // status poll, so its current row can lag a checkout or tracking change made
  // outside the app; a fresh status read confirms HEAD before this route acts.
  async function pushCurrentBranchToOrigin(listed: Branch) {
    if (pushHotkeyChecking.current) return;
    // Every value the continuation acts on, pinned before the read: the repo, and
    // the listed row whose name and destination facts decide the push. The fresh
    // read confirms both, since the backend re-reads tracking when it pushes.
    const pushIn = repoPath;
    pushHotkeyChecking.current = true;
    let fresh: BranchHead | undefined;
    await (async () => {
      try {
        // The factory's queryFn straight, never fetchQuery: that joins an
        // in-flight poll, which may have been spawned before the press.
        fresh = (await repoStatusOptions(pushIn).queryFn()).branch;
      } catch {
        toast.info("Couldn't confirm the current branch — nothing was pushed.");
      }
    })().finally(() => {
      pushHotkeyChecking.current = false;
    });
    if (fresh === undefined) return;
    // `push` follows the live repo, so a switch during the read refuses.
    if (
      refuseIfSwitched(pushIn, "nothing was pushed", "before the push started")
    )
      return;
    // Structural sharing keeps an unchanged row's identity across refetches, so a
    // different live row means the list moved under the decision during the read.
    const liveRow = queryClient
      .getQueryData<Branch[]>(repoKeys.branches(pushIn))
      ?.find((b) => b.isCurrent);
    if (
      fresh.name !== listed.name ||
      liveRow !== listed ||
      !headTrackingMatchesRow(fresh, listed)
    ) {
      refuseWhileListCatchesUp(pushIn);
      return;
    }
    pushBranchToOrigin(listed, false);
  }
  // Opening the list doesn't refetch it, so the highlighted row's tracking can
  // be just as stale; a fresh branch-list read confirms it before this route acts.
  async function pushListedBranchToOrigin(row: Branch) {
    if (pushHotkeyChecking.current) return;
    const pushIn = repoPath;
    pushHotkeyChecking.current = true;
    let freshRows: Branch[] | undefined;
    await (async () => {
      try {
        // The api read straight, never fetchQuery: that can join a refetch spawned
        // before the press.
        freshRows = await gitBranches(pushIn);
      } catch {
        toast.info("Couldn't confirm the branch — nothing was pushed.");
      }
    })().finally(() => {
      pushHotkeyChecking.current = false;
    });
    if (freshRows === undefined) return;
    if (
      refuseIfSwitched(pushIn, "nothing was pushed", "before the push started")
    )
      return;
    const freshRow = freshRows.find((b) => b.name === row.name);
    if (!freshRow || !rowTrackingMatches(freshRow, row)) {
      refuseWhileListCatchesUp(pushIn);
      return;
    }
    pushBranchToOrigin(row, true);
  }
  // `fromRow`: the highlighted row of the open list, rather than the current
  // branch; it picks where the different-name toast sends the user.
  function pushBranchToOrigin(branch: Branch, fromRow: boolean) {
    const tracksOrigin =
      branch.upstreamRemote === "origin" && !branch.upstreamGone;
    const tracksOtherKnownRemote =
      !!branch.upstream &&
      !branch.upstreamGone &&
      !!branch.upstreamRemote &&
      branch.upstreamRemote !== "origin" &&
      remoteNames.includes(branch.upstreamRemote);
    // The upstream's exact branch name, from its merge ref: the short upstream
    // string can't be split (remote names may contain `/`), and a non-branch
    // upstream (`refs/pull/N/head`) is no cross-name push.
    const upstreamBranch = branch.upstreamRemoteRef?.startsWith("refs/heads/")
      ? branch.upstreamRemoteRef.slice("refs/heads/".length)
      : null;
    if (
      tracksOrigin &&
      upstreamBranch !== null &&
      upstreamBranch !== branch.name
    ) {
      // An origin push of this branch would land on a differently-named
      // branch, which this origin-scoped shortcut never decides for the user.
      toast.info(
        fromRow
          ? `${branch.name} tracks ${branch.upstream}, which has a different name — push it from its context menu`
          : `${branch.name} tracks ${branch.upstream}, which has a different name — use the sync bar's Push instead`,
      );
    } else if (
      tracksOrigin &&
      branch.upstreamAhead > 0 &&
      branch.upstreamBehind === 0
    ) {
      doPushBranch(branch);
    } else if (willPublish(branch)) {
      // `enabled` guarantees origin exists, so this publish destination is safe.
      doPushBranch(branch, "origin");
    } else if (
      tracksOrigin &&
      branch.upstreamAhead > 0 &&
      branch.upstreamBehind > 0
    ) {
      // Genuinely diverged: commits on BOTH sides. Behind-only is not
      // divergence — it gets its own arm below.
      toast.info(
        `${branch.name} has diverged — update it from its upstream first`,
      );
    } else if (tracksOrigin && branch.upstreamBehind > 0) {
      // Behind only: nothing local to push; the remedy is a pull, so say so.
      toast.info(`${branch.name} is behind ${branch.upstream} — pull first`);
    } else if (tracksOrigin) {
      toast.info(`${branch.name} has nothing to push`);
    } else if (branch.upstream && isLocalUpstream(branch.upstreamRemote)) {
      // Tracks a LOCAL branch (`git branch --track x main`), whose
      // `%(upstream:remotename)` git reports as `.`. There's nothing
      // remote-related to say — and the context menu is the same authority (it
      // offers neither Push nor Publish for these).
      toast.info(
        `${branch.name} tracks a local branch (${branch.upstream}), not a remote`,
      );
    } else if (tracksOtherKnownRemote) {
      toast.info(
        `${branch.name} tracks ${branch.upstreamRemote} — push it from its context menu`,
      );
    } else {
      // Tracked, but the upstream's remote is no longer configured.
      toast.info(`${branch.name} tracks a remote that's no longer configured`);
    }
  }
  useHotkeyAction(
    "push-to-origin",
    () => {
      // Target: the highlighted row when the list is open, else the current
      // branch. An open list with a highlight that resolves to no local branch
      // (a remote-only row) is a real miss, not a fallback.
      if (open && activeBranch) {
        const row = branches.data?.find((b) => b.name === activeBranch);
        if (!row) {
          toast.info("Only local branches can be pushed from here");
          return;
        }
        void pushListedBranchToOrigin(row);
        return;
      }
      if (!currentBranch) {
        toast.info("No branch to push");
        return;
      }
      void pushCurrentBranchToOrigin(currentBranch);
    },
    !busy &&
      !offlineHold &&
      remoteNames.includes("origin") &&
      (open || !!currentBranch),
  );

  useHotkeyAction("new-branch", openCreate);
  // The hotkeys a push holds stay live and refuse with the toast, so a press
  // never goes silent; their menu rows hold with a reason instead. The rename,
  // delete and rebase twins wait on the CURRENT branch's push: each moves or
  // removes the ref it is sending.
  function refuseWhileCurrentPushes(): boolean {
    if (!currentRowPushing) return false;
    toast.info(BRANCH_PUSH_ACTIVE_MESSAGE);
    return true;
  }
  useHotkeyAction(
    "rename-branch",
    () => {
      if (refuseWhileCurrentPushes()) return;
      if (currentName) openRename(currentName);
    },
    Boolean(currentName) && !isSessionBranchName(currentName ?? ""),
  );
  useHotkeyAction(
    "delete-branch",
    () => {
      if (refuseWhileCurrentPushes()) return;
      setOpen(false);
      if (currentName) openDelete(currentName);
    },
    Boolean(currentName && !isDeletionBlocked(rulesConfig, currentName)),
  );
  // Cleanup deletes and archives branches, the pushing one included.
  useHotkeyAction("cleanup-branches", () => {
    if (pushAlreadyActive()) return;
    setOpen(false);
    setCleanupOpen(true);
  });
  // What the update items merge, as of the last fetch: the default's own
  // upstream tip when the local default is strictly behind it.
  const updateSources = defaultName
    ? resolveUpdateFromDefault(defaultName, defaultBranchRow)
    : null;
  useHotkeyAction(
    "update-from-default",
    () => {
      // Renders nothing, so it resolves its base at fire time.
      if (currentName && defaultName)
        void doUpdateFromDefault(
          currentName,
          resolveUpdateFromDefault(defaultName, defaultBranchRow).primary.base,
        );
    },
    Boolean(
      defaultName &&
        defaultName !== currentName &&
        // An unread list would resolve the base to the local default.
        !branchesUnread &&
        !busy &&
        currentName &&
        !currentPromotion,
    ),
  );
  // The palette's own route to the same merge the row menu offers — so it needs
  // the same refusal. There is no row rendered here to hang the probe's hook on,
  // so it runs ON INVOCATION against the hook's own cached options: a diverged
  // default pays one probe (usually a cache hit), and every other default spawns
  // nothing at all.
  async function updateDefaultFromUpstream() {
    const row = defaultBranchRow;
    if (!row?.upstream || row.upstreamGone) return;
    // The update builds from the live repo's options once the probe resolves,
    // while the row belongs to this one: a switch during it refuses instead.
    if (
      row.upstreamAhead > 0 &&
      row.upstreamBehind > 0 &&
      (await withheldForRewrite([row], row.name))
    )
      return;
    void doUpdateFromUpstream(row.name, row.upstream);
  }
  useHotkeyAction(
    "update-default-from-upstream",
    () => {
      // An update would move the ref the default's own push is sending; only an
      // update of the CURRENT branch runs in place, on the network lock. Refused
      // before the rewrite probe runs.
      if (defaultBranchRow && refuseUpdateWhilePushing(defaultBranchRow.name))
        return;
      void updateDefaultFromUpstream();
    },
    Boolean(defaultBranchRow?.upstream) &&
      !defaultBranchRow?.upstreamGone &&
      !busy &&
      // `busy` holds only the current branch's update; this one holds on the
      // same per-branch read the row items use.
      !(defaultBranchRow && updatingBase.has(defaultBranchRow.name)),
  );
  useHotkeyAction(
    "merge-into-current",
    () => {
      if (!pushAlreadyActive()) openPicker("merge");
    },
    otherBranches.length > 0 && canMergeIntoCurrent,
  );
  useHotkeyAction(
    "squash-merge-into-current",
    () => {
      if (!pushAlreadyActive()) openPicker("squash");
    },
    otherBranches.length > 0 && canSquashIntoCurrent,
  );
  useHotkeyAction(
    "rebase-current",
    () => {
      if (!refuseWhileCurrentPushes()) openPicker("rebase");
    },
    otherBranches.length > 0 && !lockCurrent,
  );
  useHotkeyAction(
    "rebase-onto-new-base",
    () => {
      if (!refuseWhileCurrentPushes()) openRebaseOnto();
    },
    Boolean(currentName) && otherBranches.length >= 2 && !lockCurrent && !busy,
  );
  useHotkeyAction("stash-all", () => setStashAllIn(repoPath), hasChanges);
  useHotkeyAction("pop-stash", () => setStashPopIn(repoPath), stashes > 0);
  useHotkeyAction(
    "view-stashes",
    () => {
      setStashesView("stashes");
      setStashesOpen(true);
    },
    stashes > 0,
  );
  // Always enabled — orphaned work commonly exists even with zero live stashes.
  useHotkeyAction("recover-lost-work", () => {
    setStashesView("recoverable");
    setStashesOpen(true);
  });
  useHotkeyAction("operation-history", () => setOpHistoryOpen(true));
  useHotkeyAction("discard-all", () => setDiscardAllIn(repoPath), hasChanges);
  // Cross-worktree navigation (palette-only). They can fire while the popover is
  // closed, so they fetch the worktree list fresh rather than read the open-gated
  // `userWorktrees` cache, then re-check the live repo before acting: after a
  // repo switch the answer would navigate to (or offer to promote) a worktree of
  // the repo the user just left. `useOpenWorktree`'s own guard can't see this
  // window — it captures the live repo when CALLED, already after this await.
  useHotkeyAction("open-main-workspace", async () => {
    setOpen(false);
    // A watermark, not a claim: the lookup may end without an open.
    const noNewerOpen = repoOpenWatermark();
    try {
      const wts = await listUserWorktrees(repoPath);
      if (useUiStore.getState().repoPath !== repoPath) return;
      if (!noNewerOpen()) return;
      const main = wts.find((w) => w.isMain);
      if (!main) {
        toast.error("Couldn't find the main workspace for this repository.");
        return;
      }
      if (normPath(main.path) === normPath(repoPath)) {
        toast.info("Already in the main workspace.");
        return;
      }
      void openWorktree(main.path);
    } catch (e) {
      toastError(e);
    }
  });
  useHotkeyAction("promote-worktree-to-main", async () => {
    setOpen(false);
    try {
      const wts = await listUserWorktrees(repoPath);
      if (useUiStore.getState().repoPath !== repoPath) return;
      const here = wts.find((w) => normPath(w.path) === normPath(repoPath));
      const notLinked =
        "Open a linked worktree to promote its branch to the main workspace.";
      if (here === undefined) {
        toast.info(notLinked);
        return;
      }
      if (here.isMain) {
        toast.info(notLinked);
        return;
      }
      let hereNoBranch = false;
      if (here.isDetached) hereNoBranch = true;
      if (!here.branch) hereNoBranch = true;
      if (hereNoBranch) {
        toast.info("This worktree has no branch to promote.");
        return;
      }
      if (here.isLocked) {
        toast.info("This worktree is locked — unlock it before promoting.");
        return;
      }
      // Only a promote can have claimed the worktree you're standing in: no
      // surface offers to delete the active checkout, and a promote marks its
      // removal under the main workspace's key, never this one's.
      if (isWorktreePromoting(here.path)) {
        toast.info(WORKTREE_PROMOTING_MESSAGE);
        return;
      }
      setPromoteTarget(here);
    } catch (e) {
      toastError(e);
    }
  });

  // One branch's in-flight state, holding worktree and PR, read alike by its
  // row and by its items in the shared context menu.
  const branchRowFacts = (branch: Branch) => {
    // An update in flight on THIS row holds only its own update items.
    const rowUpdateBase = updatingBase.get(branch.name);
    // A push (or its fork check) in flight on THIS row holds the items that
    // move or remove its ref; other rows hold only what would queue behind it.
    const rowDetecting = detectingBranch === branch.name;
    const rowPush = pushOnBranch(branch.name);
    // The worktree (other than the active checkout) this branch occupies, when
    // any — the row's whole worktree menu group hangs off it, and it narrows the
    // object those items act on.
    const rowWorktree = (userWorktrees.data ?? []).find(
      (w) => w.path === worktreeByBranch.get(branch.name),
    );
    return {
      rowUpdateBase,
      rowUpdating: rowUpdateBase !== undefined,
      rowDetecting,
      rowPush,
      rowWorktree,
      // `worktreeByBranch` admits the main workspace (it's a worktree to git,
      // and any checkout other than the active one qualifies), so the strings
      // that NAME this row's holding checkout come from the record instead of
      // saying "worktree" flat.
      rowCopy: rowCheckoutCopy(rowWorktree?.isMain),
      pr: prByBranch.get(branch.name),
    };
  };

  // Shared by the visible list and the Archived section. Paints the row only:
  // its items live in the list's one shared context menu (`renderBranchMenu`).
  const renderBranchRow = (branch: Branch) => {
    const div = divByName.get(branch.name);
    const {
      rowUpdateBase,
      rowUpdating,
      rowDetecting,
      rowPush,
      rowWorktree,
      rowCopy,
      pr,
    } = branchRowFacts(branch);
    const rowSpinnerLabel = (() => {
      if (rowUpdating) return `Updating from ${rowUpdateBase}`;
      if (rowDetecting)
        return branchPublishLabel(publishDetect?.remote ?? null);
      if (rowPush !== undefined) return branchPushLabel(rowPush, branch);
      return null;
    })();
    return (
      <button
        type="button"
        data-row={branch.name}
        className="flex w-full flex-col gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
        onFocus={() => focusRow(branch.name)}
        onClick={(e) => {
          // The PR chip is part of this button (no nested control), so a
          // click on it is routed here; Enter on the row still switches.
          if (
            pr &&
            e.target instanceof Element &&
            e.target.closest("[data-pr-chip]")
          ) {
            openPrChip(pr.select);
            return;
          }
          if (!branch.isCurrent) void switchTo(branch.name);
        }}
      >
        <span className="flex w-full items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate"
            onMouseEnter={clipTitle(branch.name)}
          >
            {branch.name}
            {branch.name === defaultName && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                default
              </span>
            )}
          </span>
          {branch.isCurrent && <CheckIcon className="size-3.5 shrink-0" />}
        </span>
        <span className="flex w-full items-center gap-2">
          {pr &&
            (() => {
              const Icon = PR_AUDIT_ICON[pr.state];
              const label = prChipLabel(pr);
              // Not a control of its own: the row's click routing opens
              // it, the row menu reaches it by keyboard, and its words
              // join the row's accessible name.
              return (
                <span
                  role="img"
                  data-pr-chip
                  aria-label={label}
                  title={`${label} — open in the PRs tab`}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] tabular-nums hover:underline",
                    PR_AUDIT_TONE[pr.state],
                  )}
                >
                  <Icon className="size-3" weight="bold" />
                  {pr.label}
                </span>
              );
            })()}
          {rowWorktree && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
              title={rowCopy.title(rowWorktree.path)}
            >
              <TreeStructureIcon className="size-3" weight="bold" />
              {rowCopy.noun}
            </span>
          )}
          {/* Two distinct indicators: the sync indicator shows the
              branch's OWN upstream state in ARROW vocabulary (matching
              the header's Push/Pull counts); the divergence indicator
              shows drift from the DEFAULT branch as `+N −M {default}`
              TEXT so it can't be mistaken for unpushed work. Sync is
              skipped on a remoteless repo. */}
          {remoteNames.length > 0 &&
            (() => {
              // A branch tracking a REMOVED remote offers neither Push
              // nor Publish, so arrows would imply an action the menu
              // can't honor — muted marker with a no-action title
              // instead. The `isLocalUpstream` conjunct keeps a
              // LOCAL-upstream branch (git's `%(upstream:remotename)`
              // reads `.`) out of this case so its truthful arrows still
              // show below.
              if (
                branch.upstream &&
                !branch.upstreamGone &&
                !isLocalUpstream(branch.upstreamRemote) &&
                !remoteNames.includes(branch.upstreamRemote)
              ) {
                const label = `Tracks ${branch.upstream}, but that remote is no longer configured.`;
                return (
                  <span
                    role="img"
                    aria-label={label}
                    className="flex shrink-0 items-center text-muted-foreground"
                    title={label}
                  >
                    <CloudSlashIcon className="size-3" />
                  </span>
                );
              }
              if (branch.upstream && !branch.upstreamGone) {
                if (branch.upstreamAhead === 0 && branch.upstreamBehind === 0) {
                  // In sync with the upstream — silence means synced.
                  return null;
                }
                const parts: string[] = [];
                if (branch.upstreamAhead > 0)
                  parts.push(`${branch.upstreamAhead} to push`);
                if (branch.upstreamBehind > 0)
                  parts.push(`${branch.upstreamBehind} to pull`);
                const label = `${parts.join(", ")} — vs ${branch.upstream}`;
                return (
                  <span
                    // No text color: inherits the row foreground (a step
                    // stronger than the muted divergence) and follows the
                    // hover accent-foreground automatically. The arrow SVGs are
                    // aria-hidden, so the span carries the name for readers —
                    // role="img" because aria-label is not valid (nor reliably
                    // announced) on a generic span.
                    role="img"
                    aria-label={label}
                    className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums"
                    title={label}
                  >
                    {branch.upstreamAhead > 0 && (
                      <span className="flex items-center gap-0.5">
                        <ArrowUpIcon className="size-3" weight="bold" />
                        {branch.upstreamAhead}
                      </span>
                    )}
                    {branch.upstreamBehind > 0 && (
                      <span className="flex items-center gap-0.5">
                        <ArrowDownIcon className="size-3" weight="bold" />
                        {branch.upstreamBehind}
                      </span>
                    )}
                  </span>
                );
              }
              if (branch.upstreamGone) {
                const label = `Upstream ${branch.upstream} was deleted on the remote — likely merged. ${secondaryClickCapitalized} to publish again or delete.`;
                return (
                  <span
                    role="img"
                    aria-label={label}
                    className="flex shrink-0 items-center text-muted-foreground"
                    title={label}
                  >
                    <CloudXIcon className="size-3" />
                  </span>
                );
              }
              // !branch.upstream
              const publishHint = `Local only — never published. ${secondaryClickCapitalized} to publish.`;
              return (
                <span
                  role="img"
                  aria-label={publishHint}
                  className="flex shrink-0 items-center text-muted-foreground"
                  title={publishHint}
                >
                  <CloudSlashIcon className="size-3" />
                </span>
              );
            })()}
          {div &&
            (div.ahead > 0 || div.behind > 0) &&
            (() => {
              const parts: string[] = [];
              if (div.ahead > 0)
                parts.push(
                  `${div.ahead} commit${div.ahead === 1 ? "" : "s"} ahead of ${defaultName}`,
                );
              if (div.behind > 0)
                // Behind-only must still name the base: role="img" hides the
                // visible {defaultName} child from AT, so the label is all
                // a reader gets. Skipped when the ahead part named it already.
                parts.push(
                  `${div.behind} commit${div.behind === 1 ? "" : "s"} behind${div.ahead > 0 ? "" : ` ${defaultName}`}`,
                );
              const label = parts.join(", ");
              return (
                <span
                  role="img"
                  aria-label={label}
                  className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
                  title={label}
                >
                  {div.ahead > 0 && <span>+{div.ahead}</span>}
                  {div.behind > 0 && <span>{`−${div.behind}`}</span>}
                  <span>{defaultName}</span>
                </span>
              );
            })()}
          {/* The spinner takes the date's auto margin so the two sit
              together in the row's right cluster. One slot: an update
              in flight wins over a push. */}
          {rowSpinnerLabel !== null && (
            <span
              role="img"
              aria-label={rowSpinnerLabel}
              className="ml-auto flex shrink-0 items-center text-muted-foreground"
              title={rowSpinnerLabel}
            >
              <CircleNotchIcon className="size-3 animate-spin" />
            </span>
          )}
          {branch.lastCommitDate && (
            <span
              className={cn(
                "shrink-0 text-[11px] text-muted-foreground",
                rowSpinnerLabel === null && "ml-auto",
              )}
            >
              <RelativeTime date={branch.lastCommitDate} />
            </span>
          )}
        </span>
      </button>
    );
  };

  // A local row's items in the shared context menu, for the LIVE row the
  // menu's target resolves to on this render.
  const renderBranchMenu = (branch: Branch) => {
    const canUpdate = Boolean(defaultName) && branch.name !== defaultName;
    // The update-from-default items, minus one whose base is this row's OWN
    // upstream: the own-upstream item offers that same merge, and it carries
    // the rewrite probe.
    const rowUpdateSources =
      canUpdate && updateSources
        ? [updateSources.primary, updateSources.secondary].filter(
            (s): s is UpdateSource => s !== null && s.base !== branch.upstream,
          )
        : [];
    const deletionBlocked = isDeletionBlocked(rulesConfig, branch.name);
    // A promotion branch takes its changes through promotions, so the one-click
    // update from the default branch is withheld.
    const rowPromotion = isPromotionBranch(rulesConfig, branch.name);
    const { rowUpdating, rowDetecting, rowPush, rowWorktree, rowCopy, pr } =
      branchRowFacts(branch);
    const rowPushing = rowDetecting || rowPush !== undefined;
    // The push item's own hold: its parked copy says the push waits offline.
    const rowPushReason = pendingItemReason(
      rowPush?.paused ?? false,
      "pushing…",
    );
    // Every other item it holds: a parked push is what waits, never that item.
    const rowPushHeldReason = rowPush?.paused
      ? branchPushHoldItemReason(true)
      : "pushing…";
    const pushRunningReason = branchPushHoldItemReason(pushPaused);
    // Archiving hides a branch from the branch surfaces, so it's refused for a
    // branch that is somewhere in use: the one you're on, the default, and one
    // another worktree has checked out. Unarchiving is never refused — an
    // archived branch can be checked out, and this is its only way back.
    const archiveLabel = branch.archived ? "Unarchive" : "Archive";
    const inWorktree = rowWorktree !== undefined;
    // A natively-disabled menu item swallows its tooltip, so the items `busy`
    // alone holds carry the reason in the label. A structural reason always
    // wins — this arm shows only where nothing else explains the dimming.
    const busySuffix = busy ? " (operation in progress)" : "";
    // Push and Publish: one push at a time, never while this row updates.
    const pushItemSuffix = (() => {
      switch (true) {
        case publishActive:
          return ` (${PUBLISH_HOLD_ITEM_REASON})`;
        case rowPushing:
          return ` (${rowPushReason})`;
        case rowUpdating:
          return " (updating…)";
        case pushActive:
          return ` (${pushRunningReason})`;
        default:
          return busySuffix || offlineSuffix;
      }
    })();
    const pushItemDisabled =
      rowPushing ||
      rowUpdating ||
      pushActive ||
      busy ||
      !!offlineHold ||
      publishActive;
    // The update items hold on their own row's update and push, and on the
    // CURRENT row also on `busy` and any push: an in-place merge must not start
    // under another HEAD-moving op, and it waits on a push's network lock. Other
    // rows update in a throwaway worktree, in parallel and off that lock.
    const rowUpdateHeld =
      rowUpdating || rowPushing || (branch.isCurrent && (busy || pushActive));
    const updateHeldReason = (() => {
      if (rowUpdating) return "updating…";
      if (rowPushing) return rowPushHeldReason;
      if (branch.isCurrent && busy) return "operation in progress";
      if (branch.isCurrent && pushActive) return pushRunningReason;
      return undefined;
    })();
    const rowWorktreeRemoving = Boolean(
      rowWorktree && removingPaths.has(rowWorktree.path),
    );
    const wtLabel = (label: string, otherReason?: string) =>
      worktreeItemLabel(label, rowWorktreeRemoving, otherReason);
    const renameWorktreeBlockedReason = (() => {
      if (rowWorktree?.isMain) return rowCopy.noun;
      if (rowWorktree?.isLocked) return "locked";
      if (rowUpdating) return "updating…";
      return undefined;
    })();
    const deleteWorktreeBlockedReason = (() => {
      if (rowWorktree?.isMain) return rowCopy.noun;
      if (rowUpdating) return "updating…";
      return undefined;
    })();
    // A promote also removes this worktree, so it races an in-flight update the
    // same way a removal does.
    const promoteBlockedReason = (() => {
      if (rowWorktree?.isLocked) return "locked";
      if (rowUpdating) return "updating…";
      return undefined;
    })();
    // Best-effort by design: a null `defaultName` (still loading, or unresolvable)
    // drops the default-branch guard rather than disabling Archive everywhere.
    // The worktree guard is HELD rather than dropped while its read is in
    // flight — the map is empty until it lands, which would offer Archive on a
    // branch the answer excludes. A FAILED read falls through to best-effort:
    // no answer is coming, and holding the item forever helps no one.
    // A branch whose worktree is being removed is the one exception, and it
    // reads the removal store, not the worktree list: git goes on listing a
    // worktree until its removal finishes, and this query is gated on the menu
    // or the cleanup dialog being open, so `inWorktree` refuses on an answer
    // that is either still true or already stale. Promote entries are excluded
    // by `promotePhase`: a promote removes the worktree to CHECK THAT BRANCH
    // OUT here, so archiving it mid-flight would hide the branch you land on.
    const archiveBlockedReason = (() => {
      if (branch.archived) return null;
      if (branch.isCurrent) return "current branch";
      if (branch.name === defaultName) return "default branch";
      // Ahead of the removal arm, whose null would leave the item enabled.
      if (rowPushing) return rowPushHeldReason;
      if (removals.some((r) => r.branch === branch.name && !r.promotePhase))
        return null;
      if (userWorktrees.data === undefined && !userWorktrees.isError)
        return "checking worktrees…";
      if (inWorktree) return rowCopy.blocked;
      return null;
    })();
    // Outbound sync gating. `pushable` = tracked on a KNOWN remote and ahead →
    // offer a plain push to that remote (disabled with "(diverged)" when also
    // behind); the backend resolves to the branch's own upstream remote.
    // `publishable` = untracked or gone AND at least one remote exists → offer
    // Publish (one item per remote on a multi-remote repo). Hidden (not disabled)
    // when in-sync, or tracked on a remote that no longer exists.
    const upstreamRemote =
      branch.upstream &&
      !branch.upstreamGone &&
      branch.upstreamRemote &&
      remoteNames.includes(branch.upstreamRemote)
        ? branch.upstreamRemote
        : null;
    const pushable = Boolean(upstreamRemote) && branch.upstreamAhead > 0;
    const publishable =
      (!branch.upstream || branch.upstreamGone) && remoteNames.length > 0;
    // Publish destinations: origin first, then the rest alphabetical.
    const publishRemotes = publishable
      ? [...remoteNames].sort((a, b) =>
          a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b),
        )
      : [];
    // Upstream classification, for this row only while ITS menu is open. An
    // upstream that already carries this branch's changes under other ids makes
    // "Update from <upstream>" harmful: merging it back in duplicates them, and
    // in a throwaway worktree it can't even run against a branch checked out
    // elsewhere.
    const rowDiverged = branch.upstreamAhead > 0 && branch.upstreamBehind > 0;
    const rowProbeOpen = rowDiverged && rewriteProbe === branch.name;
    // `isFetching` matters as much as the name match: a repo-wide invalidation
    // leaves the previous answer served while the refetch is in flight, and that
    // answer is the evidence a destructive confirm would quote.
    const rowRewrite =
      rowProbeOpen && !rewrite.isFetching ? rewrite.data : undefined;
    // The verdict for the OPEN menu hasn't landed. This slot must never hold an
    // ENABLED item that changes meaning underneath a pointer already aimed at it:
    // the probe resolves a beat after the menu paints, and a merge silently
    // becoming a destructive reset at the same coordinates is the context-menu
    // TOCTOU class. So the slot waits, disabled, and only ever becomes enabled
    // wearing its FINAL identity. An ERRORED probe is not pending — it falls
    // through to the ordinary item, the same fail-safe an unprovable status takes.
    const rowProbePending =
      rowProbeOpen &&
      !rewrite.isError &&
      (rewrite.isFetching || rewrite.data === undefined);
    // The pair, never the reflog verdict alone: offering a reset while unique
    // local work exists would destroy it. Both measured shas ride the item, the
    // upstream tip it lands on and the local tip the backend pins.
    const resetTip = carriesAllLocalCommits(rowRewrite)
      ? { tip: rowRewrite.upstreamTip, localTip: rowRewrite.localTip }
      : null;
    // Patch twins upstream AND commits without one: a reset would destroy the
    // latter, and a merge would bring the twinned changes back in beside the
    // copies already there. `patchEqual > 0` is strong evidence, not proof — two
    // sides can apply the same patch independently, or cherry-pick both ways,
    // with no rewrite involved. That is why this arm only WITHHOLDS an action:
    // its failure direction is inaction, which the row's other items cover.
    const rowMixedRewrite =
      rowRewrite?.remoteRewritten === true &&
      rowRewrite.localOnly > 0 &&
      rowRewrite.patchEqual > 0;
    return (
      <>
        {(rowUpdateSources.length > 0 ||
          (branch.upstream && branch.upstreamBehind > 0) ||
          pushable ||
          publishable) && (
          <>
            {rowUpdateSources.map((source) => (
              <ContextMenuItem
                key={source.base}
                className={MENU_HELD_ROW_CLASS}
                disabled={rowUpdateHeld || rowPromotion || rowWorktreeRemoving}
                onClick={() => {
                  fallThroughGuardUntil.current = Date.now() + 300;
                  void doUpdateFromDefault(branch.name, source.base);
                }}
              >
                {rowPromotion
                  ? `${source.label} (promotion branch)`
                  : wtLabel(source.label, updateHeldReason)}
              </ContextMenuItem>
            ))}
            {/* Pull the branch's own upstream in without switching — the star
                use case is the default branch after a PR merged upstream. An
                upstream that already carries this branch's changes under other
                ids replaces it: merging there duplicates them rather than
                syncing. The waiting arm comes FIRST so the slot can never be
                enabled while its identity is still in flight. */}
            {branch.upstream &&
              branch.upstreamBehind > 0 &&
              (() => {
                const base = branch.upstream;
                // No onClick at all, not merely `disabled`: a pointer already
                // aimed here when the menu painted must be a hard no-op.
                if (rowProbePending) {
                  return (
                    <ContextMenuItem disabled>
                      Update from {base} (checking the remote…)
                    </ContextMenuItem>
                  );
                }
                if (resetTip) {
                  const holder = worktreeByBranch.get(branch.name);
                  // A reset rewrites the ref a running push is sending.
                  const resetSuffix = (() => {
                    switch (true) {
                      case inWorktree:
                        return ` (checked out in ${holder})`;
                      case rowPushing:
                        return ` (${rowPushHeldReason})`;
                      default:
                        return busySuffix;
                    }
                  })();
                  return (
                    <ContextMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      disabled={busy || inWorktree || rowPushing}
                      onClick={() =>
                        void doResetToUpstream(
                          branch,
                          resetTip.tip,
                          resetTip.localTip,
                        )
                      }
                    >
                      Reset to {base}…{resetSuffix}
                    </ContextMenuItem>
                  );
                }
                if (rowMixedRewrite) {
                  return (
                    <ContextMenuItem disabled>
                      Update from {base} ({base} already carries these changes
                      under different ids — a merge would duplicate them)
                    </ContextMenuItem>
                  );
                }
                return (
                  <ContextMenuItem
                    className={MENU_HELD_ROW_CLASS}
                    disabled={rowUpdateHeld || rowWorktreeRemoving}
                    onClick={() => {
                      fallThroughGuardUntil.current = Date.now() + 300;
                      void doUpdateFromUpstream(branch.name, base);
                    }}
                  >
                    {wtLabel(`Update from ${base}`, updateHeldReason)}
                  </ContextMenuItem>
                );
              })()}
            {/* Sync-out below sync-in. Push a branch's ref to origin without
                checking it out — works even when the branch is checked out in
                another worktree, since a push touches refs, never a working
                tree (hence deliberately NO inWorktree gate). Diverged branches
                push disabled with the reason in the label; the "Update from"
                item above is their remedy. */}
            {pushable && (
              <ContextMenuItem
                className={MENU_HELD_ROW_CLASS}
                disabled={pushItemDisabled || branch.upstreamBehind > 0}
                onClick={() => {
                  // The list stays open under the closing menu.
                  fallThroughGuardUntil.current = Date.now() + 300;
                  doPushBranch(branch);
                }}
              >
                {branch.upstreamBehind > 0
                  ? `Push to ${branch.upstream} (diverged)`
                  : `Push to ${branch.upstream}${pushItemSuffix}`}
              </ContextMenuItem>
            )}
            {/* Publish an unpushed / upstream-deleted branch: one remote → a
                single item ("Publish branch" for origin), multiple → one flat
                item per remote (origin first), each passing its explicit
                destination. */}
            {publishRemotes.length === 1 ? (
              <ContextMenuItem
                className={MENU_HELD_ROW_CLASS}
                disabled={pushItemDisabled}
                onClick={() => {
                  fallThroughGuardUntil.current = Date.now() + 300;
                  doPushBranch(branch, publishRemotes[0]);
                }}
              >
                {publishRemotes[0] === "origin"
                  ? `Publish branch${pushItemSuffix}`
                  : `Publish to ${publishRemotes[0]}${pushItemSuffix}`}
              </ContextMenuItem>
            ) : (
              publishRemotes.map((r) => (
                <ContextMenuItem
                  key={r}
                  className={MENU_HELD_ROW_CLASS}
                  disabled={pushItemDisabled}
                  onClick={() => {
                    fallThroughGuardUntil.current = Date.now() + 300;
                    doPushBranch(branch, r);
                  }}
                >
                  Publish to {r}
                  {pushItemSuffix}
                </ContextMenuItem>
              ))
            )}
            <ContextMenuSeparator />
          </>
        )}
        {pr && (
          <ContextMenuItem onClick={() => openPrChip(pr.select)}>
            {pr.select.kind === "local"
              ? "View local pull request"
              : `View ${prNoun} ${pr.label}`}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={rowUpdating || rowPushing}
          onClick={() => openRename(branch.name)}
        >
          Rename branch…
          {(() => {
            switch (true) {
              case rowUpdating:
                return " (updating…)";
              case rowPushing:
                return ` (${rowPushHeldReason})`;
              default:
                return "";
            }
          })()}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => copyText(branch.name, "Branch name copied")}
        >
          Copy branch name
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={archiveBlockedReason !== null}
          onClick={() => void setArchived(branch.name, !branch.archived)}
        >
          {archiveBlockedReason === null
            ? archiveLabel
            : `${archiveLabel} (${archiveBlockedReason})`}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {rowWorktree && (
          <>
            <ContextMenuItem
              disabled={rowWorktreeRemoving}
              onClick={() => {
                if (refuseWhileLeaving(rowWorktree.path, rowWorktreeRemoving))
                  return;
                setOpen(false);
                void openWorktree(rowWorktree.path);
              }}
            >
              {wtLabel(rowCopy.open)}
            </ContextMenuItem>
            {/* Copying a path acts on nothing, so a removal doesn't block it. */}
            <ContextMenuItem
              onClick={() => copyText(rowWorktree.path, "Path copied")}
            >
              Copy path
            </ContextMenuItem>
            <ContextMenuItem
              // git worktree move refuses the main worktree and a locked one;
              // it doesn't wait on an update running inside, so that holds too.
              disabled={
                rowWorktree.isMain ||
                rowWorktree.isLocked ||
                rowWorktreeRemoving ||
                rowUpdating
              }
              onClick={() => {
                setOpen(false);
                setRenameWorktreeTarget(rowWorktree);
              }}
            >
              {wtLabel("Rename worktree…", renameWorktreeBlockedReason)}
            </ContextMenuItem>
            {!rowWorktree.isMain &&
              (rowWorktree.isLocked ? (
                <ContextMenuItem
                  // In-place state change: the list refreshes via the
                  // mutation's invalidation, so the popover stays open.
                  disabled={rowWorktreeRemoving}
                  onClick={() => {
                    // The menu can outlive the state that disabled this item,
                    // and a promote's claim never re-renders it.
                    if (
                      refuseWhileLeaving(rowWorktree.path, rowWorktreeRemoving)
                    )
                      return;
                    void doUnlockWorktree(rowWorktree.path);
                  }}
                >
                  {wtLabel("Unlock")}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem
                  disabled={rowWorktreeRemoving}
                  onClick={() => {
                    setOpen(false);
                    setLockWorktreeTarget(rowWorktree);
                  }}
                >
                  {wtLabel("Lock…")}
                </ContextMenuItem>
              ))}
            {/* Promote moves this worktree's branch into the main workspace,
                so it needs a linked worktree with a branch. */}
            {!rowWorktree.isMain && !rowWorktree.isDetached && (
              <ContextMenuItem
                disabled={
                  rowWorktree.isLocked || rowWorktreeRemoving || rowUpdating
                }
                onClick={() => {
                  setOpen(false);
                  setPromoteTarget(rowWorktree);
                }}
              >
                {wtLabel("Promote to main workspace…", promoteBlockedReason)}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              // A removal mid-update races it: removal doesn't wait on the update's lock.
              disabled={
                rowWorktree.isMain || rowWorktreeRemoving || rowUpdating
              }
              onClick={() => {
                setOpen(false);
                setRemoveWorktreeTarget(rowWorktree);
              }}
            >
              {wtLabel("Delete worktree…", deleteWorktreeBlockedReason)}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={deletionBlocked || inWorktree || rowPushing}
          onClick={() => {
            setOpen(false);
            openDelete(branch.name);
          }}
        >
          {(() => {
            switch (true) {
              case deletionBlocked:
                return "Delete branch… (protected)";
              case inWorktree:
                return `Delete branch… (${rowCopy.held})`;
              case rowPushing:
                return `Delete branch… (${rowPushHeldReason})`;
              default:
                return "Delete branch…";
            }
          })()}
        </ContextMenuItem>
      </>
    );
  };

  // A remote-only branch: lighter than a local row (muted, a leading "bring it
  // down" glyph). Clicking checks it out, which `git switch` turns into a local
  // tracking branch — routed through `switchTo` so in-progress changes are handled.
  const renderRemoteRow = (branch: RemoteBranch) => {
    return (
      <button
        type="button"
        data-row={branch.name}
        title={`Check out ${branch.name} — creates a local branch tracking ${branch.remote}/${branch.name}`}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
        onFocus={() => focusRow(branch.name)}
        onClick={() => void switchTo(branch.name, branch.remote)}
      >
        <CloudArrowDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {multipleRemotes && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {branch.remote}
          </span>
        )}
        {branch.lastCommitDate && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            <RelativeTime date={branch.lastCommitDate} />
          </span>
        )}
      </button>
    );
  };

  // A remote-only row's items in the shared context menu, for the LIVE row.
  const renderRemoteMenu = (branch: RemoteBranch) => {
    // A protected name is protected on the remote too — reuse the local rule.
    const deletionBlocked = isDeletionBlocked(rulesConfig, branch.name);
    return (
      <>
        <ContextMenuItem
          onClick={() => void switchTo(branch.name, branch.remote)}
        >
          Check out
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => copyText(branch.name, "Branch name copied")}
        >
          Copy branch name
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* The Remote section dedupes a name across remotes to one row, so
            this targets THIS row's remote; after invalidation a same-name row
            from another remote may reappear. That's expected. */}
        {/* Held here and at the confirm; the handler still re-checks, since
            the connection can drop between render and press. */}
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          // A remote delete is a push, so it would queue on the network lock.
          disabled={
            deletionBlocked || pushActive || !!offlineHold || publishActive
          }
          onClick={() => {
            setOpen(false);
            setRemoteDeleteTarget({
              remote: branch.remote,
              name: branch.name,
              repo: repoPath,
            });
          }}
        >
          {(() => {
            switch (true) {
              case deletionBlocked:
                return `Delete on ${branch.remote}… (protected)`;
              case publishActive:
                return `Delete on ${branch.remote}… (${PUBLISH_HOLD_ITEM_REASON})`;
              case pushActive:
                return `Delete on ${branch.remote}… (${branchPushHoldItemReason(pushPaused)})`;
              default:
                return `Delete on ${branch.remote}…${offlineSuffix}`;
            }
          })()}
        </ContextMenuItem>
      </>
    );
  };

  // The shared context menu's items for whichever row it was opened on.
  const renderShownMenu = (row: Branch | RemoteBranch) => {
    if ("remote" in row) return renderRemoteMenu(row);
    return renderBranchMenu(row);
  };

  // The windowed list's row renderer: the branch rows above and the two section
  // toggles with their counts.
  const renderBranchMenuRow = (row: BranchMenuRow<Branch, RemoteBranch>) => {
    switch (row.type) {
      case "local":
        return renderBranchRow(row.branch);
      case "remote":
        return renderRemoteRow(row.branch);
      case "archived-header":
        return (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => setShowArchived((v) => !v)}
          >
            <CaretDownIcon
              className={`size-3 transition-transform ${
                showArchived ? "" : "-rotate-90"
              }`}
              weight="bold"
            />
            Archived ({archivedBranches.length})
          </button>
        );
      case "remote-header":
        return (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => setShowRemote((v) => !v)}
            title="Branches on your remotes you haven't checked out yet"
          >
            <CaretDownIcon
              className={`size-3 transition-transform ${
                showRemote ? "" : "-rotate-90"
              }`}
              weight="bold"
            />
            Remote ({remoteOnly.length})
          </button>
        );
    }
  };

  // Aims the shared menu at the row an event landed on, setting the target
  // and its probe together; false when it landed on no row (a section toggle).
  function aimBranchMenu(e: SyntheticEvent<HTMLElement>) {
    const rowEl = (e.target as Element).closest<HTMLElement>("[data-index]");
    const row =
      rowEl && e.currentTarget.contains(rowEl)
        ? flatRows[Number(rowEl.dataset.index)]
        : undefined;
    const target = menuTargetOf(row);
    if (target === null) return false;
    setMenuTarget(target);
    setRewriteProbe(
      row?.type === "local" &&
        row.branch.upstreamAhead > 0 &&
        row.branch.upstreamBehind > 0
        ? row.branch.name
        : null,
    );
    return true;
  }
  // Capture phase, so the target and its probe are both set before Base UI's
  // own handler opens the menu in this same event. A right-click on no row
  // opens nothing.
  function handleBranchContextMenu(e: MouseEvent<HTMLElement>) {
    if (!aimBranchMenu(e)) {
      suppressContextMenu(e);
      return;
    }
    menuTargetEvent.current = e.nativeEvent;
  }
  // A touch long-press opens the menu from Base UI's own timer with no
  // contextmenu event, so the touch's start aims it. On no row, stopping the
  // event keeps Base UI's same-element listener from arming that timer.
  function handleBranchTouchStart(e: TouchEvent<HTMLElement>) {
    if (!aimBranchMenu(e)) e.stopPropagation();
  }

  // Sticky, never `isError`: a never-loaded query that errored goes back to
  // pending on every refetch, which would flip the trigger back to its skeleton.
  const failedRead = statusReadFailed(status);

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          if (o && !open) snapshotOrder();
          setOpen(o);
          if (!o) {
            setBranchFilter("");
            setActiveBranch(null);
            setFrozenOrder(null);
          }
        }}
        onOpenChangeComplete={listClose.onOpenChangeComplete}
      >
        <Popover.Trigger
          render={
            <DisabledReasonButton
              variant="ghost"
              size="sm"
              // The wrapper is the header's flex item, so it owns the cascade
              // weight; shrink is weighted by width. In a wide header the badges
              // (shrink-20) shrink at five times this label's rate (shrink-4)
              // until their icon-wide floor; in a compact one they are
              // icon-only and this label shrinks at 20 times the repo name's
              // rate down to an 8-character floor, in the text-xs `ch` the
              // button renders. A label of 9 characters or fewer never shrinks,
              // so the floor can't pad it wider than its text.
              wrapperClassName={
                currentLabel.length > 9
                  ? "min-w-[calc(9ch+3.125rem)] shrink-20 text-xs @4xl/repo-header:shrink-4"
                  : "shrink-0"
              }
              disabled={busy || amending}
              reason={(() => {
                switch (true) {
                  case amending:
                    return "Finish or stop amending to switch branches";
                  case busy:
                    return "Another git operation is running.";
                  default:
                    return undefined;
                }
              })()}
              // Mouse-only by nature; the sr-only text and the popover's
              // notice carry the same reason to keyboard, touch and AT.
              title={failedRead ? STATUS_READ_FAILED_REASON : undefined}
              // overflow-hidden clips the box the shrink cascade squeezes; the
              // shrink undoes the vendored Button's own shrink-0, or nothing
              // truncates — without either, the icons spill out both sides
              // into the separator and the repository menu on a narrow header.
              className="min-w-0 shrink overflow-hidden"
            >
              {/* A failed read swaps the glyph, so the dash below reads as a
                  failure by shape and never as an empty value. */}
              {failedRead ? (
                <WarningIcon data-icon="inline-start" />
              ) : (
                <GitBranchIcon data-icon="inline-start" />
              )}
              {(() => {
                if (status.data !== undefined)
                  return (
                    <span
                      className="min-w-0 truncate"
                      // Sits under the wrapper's conditional title — a static
                      // or blanked title here would suppress that tooltip.
                      onMouseEnter={clipTitle(currentLabel)}
                    >
                      {currentLabel}
                    </span>
                  );
                // A failed read holds still until the poll heals it, in the
                // skeleton's width so the caret doesn't move between them.
                if (failedRead)
                  return (
                    <>
                      <span
                        aria-hidden
                        className="inline-block w-[9ch] shrink-0 text-muted-foreground"
                      >
                        —
                      </span>
                      <span className="sr-only">
                        {STATUS_READ_FAILED_REASON}
                      </span>
                    </>
                  );
                // The bar holds the label floor's width, so the settled name
                // moves the header less. A span wearing the house Skeleton's
                // classes: the vendored Skeleton is a div, which a button's
                // phrasing content can't hold.
                return (
                  <>
                    <span
                      aria-hidden
                      className="inline-block h-3 w-[9ch] shrink-0 animate-pulse rounded-none bg-muted"
                    />
                    <span className="sr-only">{STATUS_PENDING_REASON}</span>
                  </>
                );
              })()}
              {/* The compact header drops the badge rather than budget it in
                  the label floor: the label already reads "detached @", and
                  a shrink-0 badge there would squeeze the label to nothing. */}
              {head?.detached && (
                <Badge
                  variant="secondary"
                  className="ml-1 shrink-0 @max-4xl/repo-header:hidden"
                >
                  detached
                </Badge>
              )}
              <CaretDownIcon data-icon="inline-end" />
            </DisabledReasonButton>
          }
        />
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup
              ref={branchPopupRef}
              className="w-108 rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
              // Arrow keys move through the branch rows whether focus is on the
              // filter input, a row, or the popup itself (Esc/Tab pass through).
              onKeyDown={onBranchKeyDown}
              // The closing context menu ignores pointer events for its ~100ms fade,
              // so a click meant for an item that leaves the list open (update,
              // push, publish) lands on popup content beneath it; 300ms of capture
              // swallows it. DOM descendants only: the portaled menu is a React
              // child here too.
              onClickCapture={(e) => {
                if (
                  Date.now() < fallThroughGuardUntil.current &&
                  e.currentTarget.contains(e.target as Node)
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              {/* The trigger's title is mouse-only; this is where keyboard
                  and touch users meet the reason. */}
              {failedRead && (
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px]">
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {STATUS_READ_FAILED_REASON}.
                  </span>
                </div>
              )}
              {inLinkedWorktree && (
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px]">
                  <TreeStructureIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    In worktree{" "}
                    <span className="font-medium text-foreground">
                      {currentWorktreeName}
                    </span>{" "}
                    — a checkout lands here
                  </span>
                  {mainWorktree && (
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
                      onClick={() => {
                        setOpen(false);
                        void openWorktree(mainWorktree.path);
                      }}
                    >
                      Open main workspace
                    </button>
                  )}
                </div>
              )}
              <div className="border-b p-2">
                <Input
                  ref={listHostRef}
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder="Filter branches"
                  className="h-7"
                  autoComplete="off"
                />
              </div>
              <ContextMenu
                actionsRef={branchMenuActions}
                onOpenChange={(menuOpen, details) => {
                  branchMenuOpenRef.current = menuOpen;
                  setBranchMenuOpen(menuOpen);
                  // The closing menu's probe goes with it, unless this close is
                  // the right-click that just moved the menu to another row.
                  if (!menuOpen && details.event !== menuTargetEvent.current)
                    setRewriteProbe(null);
                }}
                // The target outlives the close until the exit fade ends, so the
                // fading popup keeps its items.
                onOpenChangeComplete={(menuOpen) => {
                  if (!menuOpen && !branchMenuOpenRef.current)
                    setMenuTarget(null);
                }}
              >
                {listState.mode === "ready" && flatRows.length > 0 ? (
                  <ContextMenuTrigger
                    render={
                      <div
                        onContextMenuCapture={handleBranchContextMenu}
                        onTouchStartCapture={handleBranchTouchStart}
                      />
                    }
                  >
                    {/* Keyed on the repo: a held cross-repo landing under an
                        open menu keeps serving rows, and a persisted
                        virtualizer would keep the old offset and compute an
                        empty range. */}
                    <BranchMenuList
                      key={repoPath}
                      flatRows={flatRows}
                      activeName={activeBranch}
                      target={menuTarget}
                      focusNonce={focusNonce}
                      filter={bq}
                      popupRef={branchPopupRef}
                      renderRow={renderBranchMenuRow}
                    />
                  </ContextMenuTrigger>
                ) : (
                  <div className="max-h-60 overflow-y-auto">
                    {listState.mode === "pending" && <BranchRowSkeletons />}
                    {listState.mode === "failed" && (
                      <div className="flex items-center gap-2 px-3 py-4 text-xs">
                        <span className="min-w-0 flex-1 text-muted-foreground">
                          {listLine}
                        </span>
                        <BranchListRetry
                          retrying={listRetrying}
                          retryRef={listRetryRef}
                          onRetry={() => void branches.refetch()}
                        />
                      </div>
                    )}
                    {listState.mode === "ready" &&
                      visibleBranches.length === 0 &&
                      archivedBranches.length === 0 &&
                      remoteOnly.length === 0 && (
                        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                          {branchFilter.trim()
                            ? `No branches match "${branchFilter.trim()}"`
                            : "No branches"}
                        </p>
                      )}
                  </div>
                )}
                <ContextMenuContent
                  className="min-w-48"
                  // Back to the targeted row, kept mounted while the menu is
                  // open: the shared trigger around the list takes no focus.
                  // Only while focus is still in the menu or nowhere, never
                  // pulled back from where the user took it during the fade.
                  finalFocus={() => {
                    const focused = document.activeElement;
                    if (
                      focused !== null &&
                      focused !== document.body &&
                      focused.closest('[data-slot="context-menu-content"]') ===
                        null
                    )
                      return false;
                    const row =
                      menuTarget &&
                      branchPopupRef.current?.querySelector<HTMLElement>(
                        `[data-row="${CSS.escape(menuTarget.name)}"]`,
                      );
                    // Base UI restores focus with preventScroll, so a row the
                    // list scrolled away from would take focus out of view.
                    row?.scrollIntoView({ block: "nearest" });
                    return row ?? true;
                  }}
                >
                  {open &&
                    shownMenuRow !== undefined &&
                    renderShownMenu(shownMenuRow)}
                </ContextMenuContent>
              </ContextMenu>
              <div className="border-t py-1">
                <MenuRow onClick={openCreate}>New branch…</MenuRow>
                <MenuRow
                  disabled={
                    currentRowPushing ||
                    !currentName ||
                    isSessionBranchName(currentName)
                  }
                  reason={renameCurrentBlockedReason}
                  onClick={() => {
                    if (!currentName || isSessionBranchName(currentName))
                      return;
                    openRename(currentName);
                  }}
                >
                  Rename current branch…
                </MenuRow>
                <MenuRow
                  disabled={
                    !currentName ||
                    isDeletionBlocked(rulesConfig, currentName) ||
                    currentRowPushing
                  }
                  reason={deleteCurrentBlockedReason}
                  onClick={() => {
                    if (!currentName) return;
                    setOpen(false);
                    openDelete(currentName);
                  }}
                >
                  {currentName && isDeletionBlocked(rulesConfig, currentName)
                    ? "Delete current branch… (protected)"
                    : "Delete current branch…"}
                </MenuRow>
                <MenuRow
                  disabled={pushActive}
                  reason={branchPushHoldReason(pushPaused)}
                  onClick={() => {
                    setOpen(false);
                    setCleanupOpen(true);
                  }}
                >
                  Clean up branches…
                </MenuRow>
                {/* Dispatched, not owned: RepositoryMenu holds the one
                    WorktreesDialog instance and the one "worktrees" handler, so
                    a second mount here would stack a duplicate dialog on top of
                    it, and a second registration would shadow the ⋮ menu's
                    handler (dispatch runs the newest enabled one). Direct call
                    in the same tick, as RepoSwitcher's rows do — the palette's
                    setTimeout exists for closing a MODAL, which a popover
                    isn't. */}
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    if (!dispatchAction("worktrees"))
                      toast.error("Couldn't open the worktree manager.");
                  }}
                >
                  Worktrees
                  {linkedWorktreeCount > 0 ? ` (${linkedWorktreeCount})` : ""}…
                </MenuRow>
              </div>
              <div className="border-t py-1">
                <MenuRow
                  disabled={!hasChanges}
                  reason={noChangesBlockedReason}
                  onClick={() => {
                    setOpen(false);
                    setDiscardAllIn(repoPath);
                  }}
                >
                  Discard all changes…
                </MenuRow>
                <MenuRow
                  disabled={!hasChanges}
                  reason={noChangesBlockedReason}
                  onClick={() => {
                    setOpen(false);
                    setStashAllIn(repoPath);
                  }}
                >
                  Stash all changes…
                </MenuRow>
                <MenuRow
                  disabled={stashes === 0}
                  reason={popStashBlockedReason}
                  onClick={() => {
                    setOpen(false);
                    setStashPopIn(repoPath);
                  }}
                >
                  Pop latest stash{stashes > 0 ? ` (${stashes})` : ""}…
                </MenuRow>
                <MenuRow
                  disabled={stashes === 0}
                  reason={viewStashesBlockedReason}
                  onClick={() => {
                    setOpen(false);
                    setStashesView("stashes");
                    setStashesOpen(true);
                  }}
                >
                  View stashes{stashes > 0 ? ` (${stashes})` : ""}…
                </MenuRow>
                {/* Not gated on stash count — orphaned work commonly exists
                    with zero live stashes. */}
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    setStashesView("recoverable");
                    setStashesOpen(true);
                  }}
                >
                  Recover lost work…
                </MenuRow>
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    setOpHistoryOpen(true);
                  }}
                >
                  Operation history…
                </MenuRow>
              </div>
              <div className="border-t py-1">
                <MenuRow
                  disabled={
                    !defaultName ||
                    !currentName ||
                    defaultName === currentName ||
                    branchesUnread !== null ||
                    pushActive ||
                    busy ||
                    currentPromotion
                  }
                  reason={updateFromDefaultBlockedReason}
                  onClick={() => {
                    if (currentName && updateSources)
                      void doUpdateFromDefault(
                        currentName,
                        updateSources.primary.base,
                      );
                  }}
                >
                  {updateSources?.primary.label ?? "Update from default branch"}
                  {currentPromotion ? " (promotion branch)" : ""}
                </MenuRow>
                {updateSources?.secondary && (
                  <MenuRow
                    disabled={
                      !currentName ||
                      defaultName === currentName ||
                      pushActive ||
                      busy ||
                      currentPromotion
                    }
                    reason={updateFromDefaultBlockedReason}
                    onClick={() => {
                      if (currentName && updateSources.secondary)
                        void doUpdateFromDefault(
                          currentName,
                          updateSources.secondary.base,
                        );
                    }}
                  >
                    {updateSources.secondary.label}
                    {currentPromotion ? " (promotion branch)" : ""}
                  </MenuRow>
                )}
                <MenuRow
                  disabled={
                    otherBranches.length === 0 ||
                    pushActive ||
                    !canMergeIntoCurrent
                  }
                  reason={mergeIntoCurrentBlockedReason}
                  onClick={() => openPicker("merge")}
                >
                  {lockCurrent
                    ? "Merge into current branch… (requires PR)"
                    : "Merge into current branch…"}
                </MenuRow>
                <MenuRow
                  disabled={
                    otherBranches.length === 0 ||
                    pushActive ||
                    !canSquashIntoCurrent
                  }
                  reason={squashIntoCurrentBlockedReason}
                  onClick={() => openPicker("squash")}
                >
                  Squash and merge into current branch…
                </MenuRow>
                <MenuRow
                  disabled={
                    otherBranches.length === 0 ||
                    lockCurrent ||
                    currentRowPushing
                  }
                  reason={rebaseCurrentBlockedReason}
                  onClick={() => openPicker("rebase")}
                >
                  Rebase current branch…{currentPushSuffix}
                </MenuRow>
                <MenuRow
                  disabled={
                    !currentName ||
                    otherBranches.length < 2 ||
                    lockCurrent ||
                    busy ||
                    currentRowPushing
                  }
                  reason={changeBaseBlockedReason}
                  onClick={openRebaseOnto}
                >
                  Change base…{currentPushSuffix}
                </MenuRow>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {/* The list's live region, outside the portal so it stays mounted: text
          a region already holds when it enters the a11y tree is never announced,
          and the popup remounts on every open. Each open of a loading or failed
          list changes this text, and so do a retry and its repeat failure. */}
      <span role="status" className="sr-only">
        {open ? listLine : ""}
      </span>

      <CreateBranchDialog
        repoPath={repoPath}
        open={createOpen}
        onOpenChange={setCreateOpen}
        rulesConfig={rulesConfig}
        aiEnabled={aiEnabled}
        aiConfigured={aiConfigured}
        hasChanges={hasChanges}
        headExists={headExists}
        entries={status.data?.entries ?? []}
        allBranchNames={allBranches.map((b) => b.name)}
        committedFallback={committedFallback}
        committedStatus={committedStatus}
        currentName={currentName}
        defaultName={defaultName}
        onOpenSettings={openSettings}
      />

      <RenameBranchDialog
        repoPath={repoPath}
        target={renameTarget}
        targetUpstream={renameTargetUpstream}
        currentName={currentName}
        onClose={() => setRenameTarget(null)}
        aiEnabled={aiEnabled}
        aiConfigured={aiConfigured}
        hasChanges={hasChanges}
        headExists={headExists}
        entries={status.data?.entries ?? []}
        allBranchNames={allBranches.map((b) => b.name)}
        committedFallback={committedFallback}
        committedStatus={committedStatus}
        onOpenSettings={openSettings}
      />

      <CleanupBranchesDialog
        repoPath={repoPath}
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        branches={allBranches}
        // undefined only while the default-branch read is loading; null once
        // it settled with none or with an error, which only the query can
        // tell apart: a failed read lists nothing, a null answer still lists.
        defaultBranch={defaultBranch.isPending ? undefined : defaultName}
        defaultBranchFailed={defaultBranchReadFailed(defaultBranch)}
        currentBranch={currentName}
        isProtected={(name) => isDeletionBlocked(rulesConfig, name)}
        // Until both rules scopes land, `isProtected` excludes nothing, so the
        // dialog holds its list rather than offering a branch a rule refuses.
        rulesSettling={rulesSettling}
        worktreeFacts={worktreeFacts}
        // From the removal store, not the worktree read: `worktreeFacts` still
        // lists a worktree git lists until its removal finishes, and that
        // read is gated on this menu or the dialog being open, so it can lag —
        // either way the exclusion holds a branch already on its way out. A
        // promote's removal (`promotePhase`) doesn't count: it frees the branch
        // to check it out here, and archiving would hide what you land on.
        isWorktreeRemoving={(name) =>
          removals.some((r) => r.branch === name && !r.promotePhase)
        }
        // The map is empty until the read lands and stays empty if it fails, so
        // the dialog is told which, and holds its list rather than acting on an
        // exclusion that isn't answering yet.
        worktreeCheckState={worktreeCheckStateFrom(userWorktrees)}
        prMergedByBranch={mergedPrByBranch}
        prClosedByBranch={prClosedByBranch}
        // Only the closed list carries merged PRs, and `canGh` is what says the
        // query runs at all — so the dialog is told which of the four it got,
        // never-ran included.
        prCheckState={prCheckStateFrom(canGh, closedPrs)}
        // react-query's own signal for "offline": networkMode "online" parks the
        // fetch, which is otherwise indistinguishable from one in flight.
        prCheckPaused={closedPrs.fetchStatus === "paused"}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onCancel={closeDelete}
        title="Delete branch?"
        body={
          <>
            Deletes {shownDeleteTarget} locally, including commits that exist
            only on it.
            {shownDeleteTarget === currentName &&
              " You'll be switched to another branch first."}
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        // This branch's push only: a local delete takes no network lock.
        heldReason={
          deleteTarget !== null && branchPushing(deleteTarget)
            ? branchPushHoldReason(pushOnBranch(deleteTarget)?.paused ?? false)
            : undefined
        }
        pending={deleteBranch.isPending || checkout.isPending}
        onConfirm={doDelete}
      />

      <ConfirmDialog
        open={remoteDeleteTarget !== null}
        onCancel={() => setRemoteDeleteTarget(null)}
        title={
          shownRemoteDeleteTarget
            ? `Delete branch on ${shownRemoteDeleteTarget.remote}?`
            : "Delete branch on remote?"
        }
        body={
          shownRemoteDeleteTarget ? (
            <>
              Deletes{" "}
              <span className="font-mono">{shownRemoteDeleteTarget.name}</span>{" "}
              from{" "}
              <span className="font-mono">
                {shownRemoteDeleteTarget.remote}
              </span>{" "}
              for everyone using that remote. This is a server-side delete and
              can't be undone from the app.
            </>
          ) : null
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        pending={deleteRemoteBranch.isPending}
        // A remote delete is a push: it waits out a running one, as an offline
        // hold would (the handler re-checks at the press).
        heldReason={(() => {
          switch (true) {
            case pushActive:
              return branchPushHoldReason(pushPaused);
            case publishActive:
              return PUBLISH_HOLD_REASON;
            default:
              return offlineHold;
          }
        })()}
        onConfirm={doDeleteRemoteBranch}
      />

      <DeleteWorktreeDialog
        key={removeWorktreeTarget?.path ?? "no-remove"}
        repoPath={repoPath}
        worktree={removeWorktreeTarget}
        onClose={() => setRemoveWorktreeTarget(null)}
      />

      <StashesDialog
        repoPath={repoPath}
        open={stashesOpen}
        onOpenChange={setStashesOpen}
        initialView={stashesView}
      />

      <OperationHistoryDialog
        repoPath={repoPath}
        open={opHistoryOpen}
        onOpenChange={setOpHistoryOpen}
      />

      <ConfirmDialog
        open={discardAllIn !== null}
        onCancel={() => setDiscardAllIn(null)}
        title="Discard all changes?"
        body="All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin."
        confirmLabel="Discard all"
        confirmVariant="destructive"
        pending={discardAll.isPending}
        onConfirm={doDiscardAll}
      />

      <ConfirmDialog
        open={stashAllIn !== null}
        onCancel={() => setStashAllIn(null)}
        title="Stash all changes?"
        body={
          'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.'
        }
        confirmLabel="Stash changes"
        pending={stashAll.isPending}
        onConfirm={doStashAll}
      />

      <ConfirmDialog
        open={stashPopIn !== null}
        onCancel={() => setStashPopIn(null)}
        title="Pop latest stash?"
        body="Applies the most recent stash to your working tree and removes it from the stash list. If applying conflicts, the stash is kept."
        confirmLabel="Pop stash"
        pending={stashPop.isPending}
        onConfirm={doStashPop}
      />

      <BranchMergePickerDialog
        repoPath={repoPath}
        mode={picker?.mode ?? null}
        onClose={() => setPicker(null)}
        onRun={runPicker}
        otherBranches={otherBranches}
        currentLabel={currentLabel}
      />

      <RebaseOntoDialog
        repoPath={repoPath}
        open={rebaseOntoIn !== null}
        onClose={() => setRebaseOntoIn(null)}
        onRun={runRebaseOnto}
        otherBranches={otherBranches}
        currentLabel={currentLabel}
        defaultBranch={defaultName}
        isPushed={Boolean(head?.upstream) && !head?.upstreamGone}
      />

      <ForkPrPublishGuard
        // The repo the match was detected in, which its fork push targets.
        repoPath={forkGuard?.repo ?? repoPath}
        match={forkGuard?.match ?? null}
        branch={forkGuard?.branch.name ?? ""}
        destination={forkGuard?.remote ?? "origin"}
        onClose={() => setForkGuard(null)}
        onPublishAnyway={() => {
          // Refused before the dialog closes, so it stays to retry from.
          if (
            forkGuard?.repo === repoPath &&
            (pushAlreadyActive() ||
              refuseWhilePublishing(queryClient, repoPath))
          )
            return;
          setForkGuard(null);
          if (
            forkGuard &&
            !refuseIfSwitched(forkGuard.repo, "nothing was published")
          )
            void runPushBranch(
              forkGuard.branch,
              forkGuard.remote,
              pushOutcome({
                willPublish: true,
                create: undefined,
                presence: undefined,
              }),
            );
        }}
      />

      <SwitchWithChangesDialog
        target={switchTarget}
        currentLabel={currentLabel}
        hint={switchHint}
        reapply={reapplyOnSwitch}
        onReapplyChange={(v) => {
          reapplyTouchedRef.current = true;
          setReapplyOnSwitch(v);
        }}
        onCancel={() => setSwitchTarget(null)}
        onBringChanges={bringAndSwitch}
        onStashAndSwitch={stashAndSwitch}
      />

      {recovery.dialog}

      <PromoteWorktreeDialog
        key={promoteTarget?.path ?? "no-promote"}
        repoPath={repoPath}
        worktree={promoteTarget}
        onClose={() => setPromoteTarget(null)}
      />

      <RenameWorktreeDialog
        key={renameWorktreeTarget?.path ?? "no-rename"}
        repoPath={repoPath}
        worktree={renameWorktreeTarget}
        onClose={() => setRenameWorktreeTarget(null)}
      />

      <LockWorktreeDialog
        key={lockWorktreeTarget?.path ?? "no-lock"}
        repoPath={repoPath}
        worktree={lockWorktreeTarget}
        onClose={() => setLockWorktreeTarget(null)}
      />
    </>
  );
}
