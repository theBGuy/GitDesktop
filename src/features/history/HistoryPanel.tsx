import {
  ArrowLeftIcon,
  ArrowUpIcon,
  GitCommitIcon,
  MagnifyingGlassIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { type Query, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AmendForcePushDialog } from "@/features/commit/AmendForcePushDialog";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  failedSinceLastSuccess,
  listNotice,
  refreshFailed,
  splitInfiniteFailure,
} from "@/features/conversations/remote-section-state";
import { useCommitCommentsGate } from "@/features/pulls/CommitComments";
import { isConflictedEntry } from "@/features/repository/bulk-row-targets";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { refuseWhilePublishing } from "@/features/repository/PublishPendingBanner";
import { branchNamePlaceholder } from "@/lib/ai/branch-prefixes";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { presentError } from "@/lib/error-summary";
import { useAppForm } from "@/lib/form";
import { gitCommitDetails, headBranchPin } from "@/lib/git/api";
import {
  headMoveAftermathKeys,
  isShaPrefixQuery,
  isShortHexQuery,
  opStateOptions,
  refuseWhilePinnedBranchPushes,
  remoteBranchesOptions,
  repoKeys,
  repoStatusOptions,
  useBranches,
  useCheckoutCommit,
  useCherryPick,
  useCommitAuthorAvatarIndex,
  useCommitPrefixLookup,
  useCommitRecordsParent,
  useCommitSearch,
  useCreateBranch,
  useCreateTag,
  useHoverPrefetch,
  useLog,
  useOpState,
  usePendingTagPushes,
  usePrefetchCommit,
  usePushTag,
  useRefsStamp,
  useRepoStatus,
  useRevertCommit,
  useUndoCommit,
  useUnpushedCount,
} from "@/lib/git/queries";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type {
  CommitDetails,
  CommitSummary,
  RepoOpState,
  RepoStatus,
  RewriteStep,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  OFFLINE_ITEM_REASON,
  pendingItemReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { useConfirm } from "@/lib/stores/confirm";
import { landedIn, refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
} from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { CommitContextMenuItems } from "./CommitContextMenu";
import {
  ALREADY_PUSHED_HINT,
  AMEND_HOLD_HINT,
  CHERRY_PICK_ALREADY_APPLIED,
  CHERRY_PICK_ALREADY_APPLIED_SHORT,
  checkoutCommitConfirm,
  checkoutCommitSuccessToast,
  cherryPickCommitConfirm,
  EDIT_DATES_OUT_OF_RANGE_HINT,
  HISTORY_REFRESHING_HINT,
  OP_IN_PROGRESS_HINT,
  RANGE_MERGE_ITEM_REASON,
  replacesMessageConfirm,
  replacesTypedMessage,
  revertCommitConfirm,
  UNDO_ROOT_COMMIT_CONFIRM,
  UNPUSHED_UNCHECKED_HINT,
} from "./commit-confirms";
import { EditDatesDialog, type EditDatesTarget } from "./EditDatesDialog";
import { EditHistoryDialog } from "./EditHistoryDialog";
import {
  type EditDatesHold,
  editDatesRoute,
  RESOLVE_CONFLICTS_HINT,
} from "./edit-dates-route";
import {
  advanceSnapshot,
  arrowCount,
  arrowUpstream,
  deriveEditRange,
  type EditHistoryHold,
  editHistoryHold,
  headAgrees,
  isNoUpstream,
  notAdjacentSquashHint,
  observeHeadOid,
  observeSeeded,
  preMoveStale,
  resolveUnpushedView,
  type SquashHold,
  squashGate,
  statusContentSignature,
  statusLogAction,
  type UndoPushedHold,
  type UnpushedSnapshot,
  undoPushedHold,
  viewAgrees,
} from "./editable-set";
import {
  CherryPickOntoDialog,
  CreateRefFromCommitDialog,
  createRefFromCommitFormOpts,
  DeleteTagDialog,
  MergeParentDialog,
  type MergePickTarget,
  ResetCommitDialog,
} from "./HistoryDialogs";
import {
  ARM_FAILED_LINES,
  armRead,
  distinctPrefixLength,
  loadedCheckedLine,
  loadedNoMatchLine,
  mergeSearchResults,
  OFF_BRANCH_NOTICE_CAP,
  OFF_BRANCH_NOTICE_SUFFIX,
  OPEN_COMMIT_LABEL,
  offBranchOverflowLine,
  SEARCH_ALL_FAILED_LINE,
  SHA_ARM_FAILED_LINE,
  searchAllCheckedLineFor,
  searchAllNoMatchLine,
  searchCoverage,
  searchMessagesNoMatchLine,
} from "./history-search";
import { type PickOntoHold, pickOntoHold } from "./pick-onto-hold";
import { SquashDialog } from "./RewriteDialogs";
import { useAmendWithConfirm } from "./useAmendCommit";

const FILTER_PLACEHOLDER = "Filter loaded commits, or search all history";

/** Why undo is withheld on a detached HEAD at the first commit: there is no
 *  branch ref to delete, and the backend refuses. KEEP IN STEP: commit.rs's
 *  `UNDO_DETACHED_ROOT` is the backend's copy of this exact sentence. */
const UNDO_DETACHED_ROOT =
  "HEAD is detached at the repository's first commit — nothing to undo onto.";
/** The menu item's short form of {@link UNDO_DETACHED_ROOT}. */
const UNDO_DETACHED_ROOT_HINT =
  " (detached at the first commit — nothing to undo onto)";
/** The refusal for an undo while a merge is stopped. KEEP IN STEP: commit.rs's
 *  `UNDO_MID_MERGE` is the backend's copy of this exact sentence. */
const UNDO_MID_MERGE =
  "A merge is in progress — finish or abort it first; nothing was undone.";
/** The refusal for an undo while a cherry-pick or revert is stopped. KEEP IN
 *  STEP: commit.rs's `UNDO_MID_PICK` is the backend's copy of this exact sentence. */
const UNDO_MID_PICK =
  "A cherry-pick or revert is in progress — finish or abort it first; nothing was undone.";
/** The refusal for an undo over unmerged entries with no stopped operation.
 *  KEEP IN STEP: commit.rs's `UNDO_UNRESOLVED` is the backend's copy of this
 *  exact sentence. */
const UNDO_UNRESOLVED = "Resolve the conflicts first; nothing was undone.";
/** Why the shortcut undid nothing while the pushed-commit check is unread or
 *  not yet agreeing with the log. Frontend-only: the backend reads no count. */
const UNDO_PUSHED_REFRESHING =
  "Still checking which commits are pushed — try again in a moment.";
/** Why the shortcut undid nothing while the pushed-commit check has failed.
 *  Fixed copy: a failed count refetching with no data carries no error. */
const UNDO_PUSHED_UNCHECKED =
  "Couldn't check which commits are pushed; nothing was undone.";

/** Why undo is withheld at the oldest commit a depth-limited clone holds: its
 *  parent was never fetched, so there is nothing to soft-reset to. KEEP IN
 *  STEP: commit.rs's `UNDO_SHALLOW_BOUNDARY` is the backend's copy of this
 *  exact sentence. */
const UNDO_SHALLOW_BOUNDARY =
  "The latest commit's parent isn't in this shallow clone — nothing was undone. Run git fetch --deepen=1 in a terminal, then undo again.";

/** The Undo and Reset rows' reasons, one Record so the two rows share a word
 *  for each hold. */
type HeadRowHold =
  | "refreshing"
  | "not-latest"
  | "undoing"
  | "already-pushed"
  | "detached-root"
  | "shallow-boundary"
  | "checking-parent"
  | "parent-unread"
  | "already-at"
  | "mid-pick"
  | "mid-merge"
  | "unpushed-unchecked"
  | "unresolved";
const HEAD_ROW_HOLD_HINT: Record<HeadRowHold, string> = {
  refreshing: HISTORY_REFRESHING_HINT,
  "not-latest": AMEND_HOLD_HINT["not-latest"],
  undoing: " (undoing…)",
  "already-pushed": ALREADY_PUSHED_HINT,
  "detached-root": UNDO_DETACHED_ROOT_HINT,
  "shallow-boundary": " (its parent commit isn't in this shallow clone)",
  // The menu twin of the shortcut's "Still checking the latest commit" toast.
  "checking-parent": " (checking the latest commit…)",
  "parent-unread": " (couldn't check the latest commit's parent)",
  "already-at": " (already at this commit)",
  "mid-pick": " (finish or abort the cherry-pick or revert first)",
  "mid-merge": " (finish or abort the merge first)",
  "unpushed-unchecked": UNPUSHED_UNCHECKED_HINT,
  unresolved: RESOLVE_CONFLICTS_HINT,
};

/** Cherry-pick to branch's menu-row reason per hold. Loading and unreadable
 *  speak only for a list with nothing loaded. */
const PICK_ONTO_HOLD_HINT: Record<PickOntoHold, string> = {
  op: OP_IN_PROGRESS_HINT,
  loading: " (loading branches…)",
  unreadable: " (couldn't read the branch list)",
  "all-archived": " (all other branches are archived — unarchive one first)",
  "no-branches": " (no other branches)",
};

/** Squash's menu-row reason per hold. The filter arm names the easy-to-miss
 *  case: a range that looks adjacent in the filtered view isn't adjacent in
 *  history. "refreshing" and "not-adjacent-unpushed" are built at render: they
 *  depend on the count read. */
const SQUASH_HOLD_HINT: Record<
  Exclude<SquashHold, "refreshing" | "not-adjacent-unpushed">,
  string
> = {
  op: OP_IN_PROGRESS_HINT,
  "filter-hides-range":
    " (clear the filter — a squash range must be adjacent in history)",
};

// Keeps the log and its side reads in step with status's HEAD and the refs
// stamp: refetches the log when status saw a new HEAD first, refreshes the side
// reads and the rest of the HEAD-dependent families once per observed HEAD move
// (outside commits, resets, checkouts and rebases, and in-app moves alike), the
// ref-derived reads once per observed stamp move (fetches, pushes and branch
// moves made outside the app), op state once per status-content change with
// HEAD held, and re-reads a no-upstream count taken on another head, errored,
// past the recheck interval, or on a basis the status branch contradicts. Its
// own observers keep the 5 s polls from re-rendering any panel.
// RepositoryView mounts it outside every tab's <Activity>, keyed on the repo
// to reset its last-seen oid: log readers on every tab rely on it, the commit
// detail view's Amend gate and its "refreshing history" hint included.
export function StatusLogSync({ repoPath }: { repoPath: string }) {
  const queryClient = useQueryClient();
  const log = useLog(repoPath);
  const status = useRepoStatus(repoPath);
  const stamp = useRefsStamp(repoPath);
  const head = status.data?.branch;
  const noUpstream = isNoUpstream(head);
  const unpushedVsRemotes = useUnpushedCount(repoPath, noUpstream);
  // The side keys refresh once per observed HEAD move, not per render.
  const lastOid = useRef<string | null>(null);
  // The previous status reading's time: the last one where an old oid still held.
  const lastStatusAt = useRef(0);
  const lastStamp = useRef<string | null>(null);
  // A hash, never the entries: a ref must not hold a second copy of a large status.
  const lastContent = useRef<string | null>(null);
  const headOid = head?.oid;
  const onSync = useEffectEvent(
    (
      oid: string | null | undefined,
      logAt: number,
      statusAt: number,
      stampAt: number,
    ) => {
      const seen = observeHeadOid(lastOid.current, oid);
      lastOid.current = seen.next;
      const prevStatusAt = lastStatusAt.current;
      lastStatusAt.current = statusAt;
      const stampSeen = observeSeeded(lastStamp.current, stamp.data);
      lastStamp.current = stampSeen.next;
      // An unchanged status reading carries the content already signed.
      const contentSeen =
        statusAt === prevStatusAt
          ? { next: lastContent.current, changed: false }
          : observeSeeded(
              lastContent.current,
              statusContentSignature(status.data?.entries),
            );
      lastContent.current = contentSeen.next;
      const actions = statusLogAction({
        oid,
        oidChanged: seen.changed,
        refsChanged: stampSeen.changed,
        contentChanged: contentSeen.changed,
        logHead: log.data?.pages[0]?.[0]?.hash,
        logHasData: log.data !== undefined,
        logIsFetching: log.isFetching,
        logAt,
        logErrorAt: log.errorUpdatedAt,
        statusAt,
        noUpstream,
        countIsError: unpushedVsRemotes.isError,
        countIsFetching: unpushedVsRemotes.isFetching,
        countAt: unpushedVsRemotes.dataUpdatedAt,
        countErrorAt: unpushedVsRemotes.errorUpdatedAt,
        countHead: unpushedVsRemotes.data?.headOid,
        countBasis: unpushedVsRemotes.data?.basis,
        countDefault: unpushedVsRemotes.data?.defaultBranch,
        statusBranch: head?.name,
      });
      if (!actions) return;
      if (actions.has("refetch-log")) {
        void queryClient.invalidateQueries(
          { queryKey: repoKeys.log(repoPath) },
          // Join a user's in-flight Load more instead of cancelling it; a
          // skipped refetch is re-checked at the next status poll.
          { cancelRefetch: false },
        );
      }
      if (actions.has("refresh-side-keys")) {
        // These families don't heal through the log refetch: the dialog's
        // full-message read keys on a base that holds through the reseed,
        // opState gates Edit history against outside operations, and the
        // no-upstream count counted from the old HEAD.
        for (const key of [
          repoKeys.unpushedCount(repoPath),
          repoKeys.unpushedMessages(repoPath),
          repoKeys.opState(repoPath),
        ] as const) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
      if (actions.has("refresh-head-set")) {
        // An in-app write already invalidated what it moved, so only reads older
        // than the last pre-move status reading re-read (preMoveStale); inactive
        // ones are only marked stale and heal on their next show. No commit's
        // aftermath covers the rewrite status, so this re-reads it after in-app
        // HEAD moves on a diverged branch as well as outside ones.
        for (const key of [
          ...headMoveAftermathKeys(repoPath),
          repoKeys.rewriteStatus(repoPath),
        ] as const) {
          void queryClient.invalidateQueries({
            queryKey: key,
            predicate: (q) =>
              preMoveStale({
                fetchStatus: q.state.fetchStatus,
                dataUpdatedAt: q.state.dataUpdatedAt,
                prevStatusAt,
              }),
          });
        }
      }
      if (actions.has("refresh-ref-set")) {
        // The reads that follow refs/heads or refs/remotes other than through
        // HEAD: branches, rewrite status, remote branches, the unpushed count,
        // compare, divergence, merge previews, local-PR merge states and each
        // commit's on-remote verdict. Each is re-read unless it landed after the
        // stamp reading that saw the move (an in-app fetch's refresh settling
        // after it) or is fetching now (one the head set just started). The
        // prefixes are hand-spelled as headMoveAftermathKeys spells them.
        const refStale = (q: Query) =>
          preMoveStale({
            fetchStatus: q.state.fetchStatus,
            dataUpdatedAt: q.state.dataUpdatedAt,
            prevStatusAt: stampAt,
          });
        for (const key of [
          repoKeys.branches(repoPath),
          repoKeys.rewriteStatus(repoPath),
          remoteBranchesOptions(repoPath).queryKey,
          repoKeys.unpushedCount(repoPath),
          ["repo", repoPath, "compare"],
          ["repo", repoPath, "divergence"],
          ["repo", repoPath, "merge-preview"],
          ["repo", repoPath, "local-pr-merge-states"],
        ] as const) {
          void queryClient.invalidateQueries({
            queryKey: key,
            predicate: refStale,
          });
        }
        // commitOnRemoteOptions keys the verdict under its sha, beside commit
        // reads no ref move changes.
        void queryClient.invalidateQueries({
          queryKey: ["repo", repoPath, "commit"],
          predicate: (q) => q.queryKey[4] === "on-remote" && refStale(q),
        });
      }
      if (actions.has("refresh-op-state")) {
        // No predicate: a read in flight when the entries changed may hold the
        // answer from before the stop or abort, so it is cancelled and restarted.
        void queryClient.invalidateQueries({
          queryKey: repoKeys.opState(repoPath),
        });
      }
      if (actions.has("refresh-count")) {
        void queryClient.invalidateQueries({
          queryKey: repoKeys.unpushedCount(repoPath),
        });
      }
    },
  );
  useEffect(() => {
    onSync(
      headOid,
      log.dataUpdatedAt,
      status.dataUpdatedAt,
      stamp.dataUpdatedAt,
    );
  }, [headOid, log.dataUpdatedAt, status.dataUpdatedAt, stamp.dataUpdatedAt]);
  return null;
}

/** Mirrors git_undo_commit_core's refusal order: a stopped cherry-pick or
 *  revert first, then a merge; rebasing is deliberately allowed (undo at an
 *  edit stop). */
function undoMidOpOf(
  op: RepoOpState | undefined,
): "mid-pick" | "mid-merge" | null {
  if (op?.cherryPicking || op?.reverting) return "mid-pick";
  return op?.merging ? "mid-merge" : null;
}

export function HistoryPanel({ repoPath }: { repoPath: string }) {
  const queryClient = useQueryClient();
  const log = useLog(repoPath);
  // Batch-resolve commit-author avatars for the log's authors (GitHub-only,
  // deduped by react-query across the History surfaces).
  useCommitAuthorAvatarIndex(repoPath);
  const status = useRepoStatus(repoPath);
  const opState = useOpState(repoPath);
  const undoCommit = useUndoCommit(repoPath);
  const selectedCommitHash = useUiStore((s) => s.selectedCommitHash);
  const selectCommit = useUiStore((s) => s.selectCommit);
  const clearSelectedCommit = useUiStore((s) => s.clearSelectedCommit);
  const commentsGate = useCommitCommentsGate(repoPath);
  const prefetchCommit = usePrefetchCommit(repoPath, commentsGate);
  const hoverPrefetch = useHoverPrefetch();
  const setCommitDraft = useUiStore((s) => s.setCommitDraft);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const openCommit = useUiStore((s) => s.openCommit);

  const checkoutCommit = useCheckoutCommit(repoPath);
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const createBranch = useCreateBranch(repoPath);
  const createTag = useCreateTag(repoPath);
  const pushTag = usePushTag(repoPath);
  // A tag push holds offline rather than park: a parked one lands on origin
  // whenever the connection returns.
  const offlineHold = useOfflineHold();
  const offlineSuffix = offlineHold ? ` (${OFFLINE_ITEM_REASON})` : "";
  // This repo's tag pushes in flight, read from the mutation cache: the panel
  // survives repo switches and a remount, and neither may release a hold.
  const pendingTagPushes = usePendingTagPushes(repoPath);
  const pendingTagPush = (tag: string) =>
    pendingTagPushes.find((p) => p.tag === tag);
  const branches = useBranches(repoPath);

  // The reset, delete-tag, pick-onto and merge-parent dialogs record the repo
  // they opened in: a switch closes them, and the stamp refuses an answer
  // already in flight when it lands. The reset also pins the HEAD it opened on.
  const [reset, setReset] = useState<{
    hash: string;
    repo: string;
    expectedHead: string;
    expectedBranch: string;
  } | null>(null);
  const [branchHash, setBranchHash] = useState<string | null>(null);
  const [tagHash, setTagHash] = useState<string | null>(null);
  // Each dialog's open session: minted by every opener, dropped by its close. A
  // create isn't held against Esc, so its settle closes only the session it was
  // submitted from, never a dialog reopened on another commit.
  const branchSessionRef = useRef<object | null>(null);
  const tagSessionRef = useRef<object | null>(null);
  // Both dialogs' descriptions are built at their call sites below.
  const shownBranchHash = useRetained(branchHash);
  const shownTagHash = useRetained(tagHash);
  // Multi-/range-selection for "cherry-pick to branch". Kept separate from the
  // ui store's focused commit (which drives the diff panel).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A hash, not a row index: the log can gain a top commit mid-interaction.
  const [anchorHash, setAnchorHash] = useState<string | null>(null);
  // Hashes to copy, oldest-first, and the chosen destination branch.
  const [pickOnto, setPickOnto] = useState<{
    hashes: string[];
    isMerge: boolean;
    repo: string;
  } | null>(null);
  const [pickOntoBranch, setPickOntoBranch] = useState("");
  // A merge commit's revert or cherry-pick, awaiting its mainline parent.
  const [mergePick, setMergePick] = useState<
    (MergePickTarget & { repo: string }) | null
  >(null);
  const [filterText, setFilterText] = useState("");
  // "Search all history" mode: a server-side message grep plus a SHA-prefix
  // lookup across every commit, not just the loaded pages. Kept separate from
  // the operational log so the rewrite/amend actions still see contiguous
  // recent history.
  const [searchMode, setSearchMode] = useState(false);
  // Search all reads a debounced query so typing spawns no git per keystroke.
  // The CTA stamps the text it was pressed on, so a press runs at once on the
  // live text. The stamp holds until the debounce settles on a newer value,
  // since the value it last settled on can be older than the stamp, or until
  // the live text returns to the settled value, which no new settle reports.
  const debouncedText = useDebouncedValue(filterText, 300);
  const [ctaStamp, setCtaStamp] = useState<{
    text: string;
    settled: string;
  } | null>(null);
  if (
    ctaStamp &&
    (debouncedText !== ctaStamp.settled || debouncedText === filterText)
  )
    setCtaStamp(null);
  const debouncedQuery = (ctaStamp ? ctaStamp.text : debouncedText).trim();
  const filterRef = useRef<HTMLInputElement>(null);
  // The native scroll container that hosts the virtualized list. Kept in STATE
  // (not a ref) so attaching it re-renders and the child's virtualizer
  // re-initializes with the real node — a plain ref stays null at the
  // virtualizer's mount effect, so getVirtualItems() returns [] and no rows
  // paint even though the spacer has height. Mirrors ChangesPanel's `setScrollEl`
  // callback-ref wiring on its own Base-UI ContextMenuTrigger render element.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Tag pending deletion, plus whether to delete it from origin too.
  const [deleteTag, setDeleteTag] = useState<{
    name: string;
    repo: string;
  } | null>(null);
  const [deleteTagRemote, setDeleteTagRemote] = useState(false);
  // History rewriting (quick squash + the Edit-history editor), unpushed only.
  const [squashCtx, setSquashCtx] = useState<{
    base: string;
    steps: RewriteStep[];
    count: number;
    defaultMessage: string;
  } | null>(null);
  // Edit history's open session: an opener mints a token, and a close clears
  // only its own, so a late settle can't close a dialog reopened since.
  // `datesFor` opens that commit's Dates editor (the Edit dates route).
  const [editHistoryOpen, setEditHistoryOpen] = useState<{
    datesFor?: string;
  } | null>(null);
  // HEAD's Edit dates dialog, pinned to the HEAD it opened on.
  const [editDates, setEditDates] = useState<EditDatesTarget | null>(null);
  // The commit the one shared context menu acts on; its position is derived at
  // render, since the log can gain a top commit while the menu is open.
  const [menuTarget, setMenuTarget] = useState<{
    commit: CommitSummary;
  } | null>(null);
  // This panel survives repo switches (mounted unkeyed), so its per-repo
  // dialogs and selection reset in the render that switches; an effect would
  // paint them open over the new repo first.
  const [dialogsFor, setDialogsFor] = useState(repoPath);
  if (dialogsFor !== repoPath) {
    setDialogsFor(repoPath);
    setEditHistoryOpen(null);
    setSquashCtx(null);
    setReset(null);
    setEditDates(null);
    setDeleteTag(null);
    setPickOnto(null);
    setMergePick(null);
    setBranchHash(null);
    setTagHash(null);
    setSelected(new Set());
    setAnchorHash(null);
    setMenuTarget(null);
  }

  const searchActive = searchMode && filterText.trim().length > 0;
  const search = useCommitSearch(repoPath, searchActive ? debouncedQuery : "");
  const shaLookup = useCommitPrefixLookup(
    repoPath,
    searchActive ? debouncedQuery : "",
  );

  const onError = (e: unknown) => toastError(e);

  const currentBranch = status.data?.branch?.name ?? null;
  // Agent-session branches (`gd/session/*`) are app-internal — never offer them
  // as a cherry-pick target (it would switch to and cherry-pick onto one), like
  // ComparePanel / BranchSwitcher. Archived branches are hidden here for the same
  // reason they are hidden elsewhere: they were archived to get them out of the way.
  const pickOntoCandidates = (branches.data ?? []).filter(
    (b) => !b.isCurrent && !b.name.startsWith("gd/session/"),
  );
  const targetBranches = pickOntoCandidates.filter((b) => !b.archived);
  const fromCommitPlaceholder = useMemo(
    () =>
      branchNamePlaceholder(
        (branches.data ?? []).map((b) => b.name),
        { sample: "from-commit" },
      ),
    [branches.data],
  );

  const branchForm = useAppForm({
    ...createRefFromCommitFormOpts,
    onSubmit: async ({ value }) => {
      if (!branchHash) return;
      // This create always checks the branch out, so it moves HEAD.
      if (promotionBlocksCheckout(repoPath)) {
        toast.info(PROMOTION_BLOCKS_CHECKOUT);
        return;
      }
      const name = sanitizeRefName(value.name);
      const session = branchSessionRef.current;
      try {
        await createBranch.mutateAsync({
          name,
          checkout: true,
          startPoint: branchHash,
        });
        toast.success(`Created branch ${name}`);
        if (branchSessionRef.current === session) {
          branchSessionRef.current = null;
          setBranchHash(null);
        }
      } catch (e) {
        onError(e);
      }
    },
  });

  const tagForm = useAppForm({
    ...createRefFromCommitFormOpts,
    onSubmit: async ({ value }) => {
      if (!tagHash) return;
      const name = sanitizeRefName(value.name);
      const session = tagSessionRef.current;
      try {
        await createTag.mutateAsync({ name, hash: tagHash });
        toast.success(`Created tag ${name}`);
        if (tagSessionRef.current === session) {
          tagSessionRef.current = null;
          setTagHash(null);
        }
      } catch (e) {
        onError(e);
      }
    },
  });

  const { requestAmend, forcePushDialog } = useAmendWithConfirm(repoPath);

  const head = status.data?.branch;
  const lastCommit = log.data?.pages[0]?.[0];
  // A lone loaded commit: a true root or a depth-limited clone's boundary. The
  // log walks HEAD's ancestry and only stops paging once a page comes up short,
  // so one loaded commit with no next page has no parent the log can reach.
  const headIsRoot = log.data?.pages[0]?.length === 1 && !log.hasNextPage;
  // The graft hides a boundary commit's parent from the log; its raw header
  // tells the two apart. Read only for that lone commit, so ordinary history
  // spawns nothing.
  const recordsParent = useCommitRecordsParent(
    repoPath,
    lastCommit?.hash ?? "",
    headIsRoot && Boolean(lastCommit),
  );
  const shallowBoundary = headIsRoot && recordsParent.data === true;
  const rootKnown = !headIsRoot || recordsParent.data !== undefined;
  // Only a measured root (rootUndo) takes git's ref-deleting path and its
  // confirm.
  const rootUndo = headIsRoot && recordsParent.data === false;
  // The root confirm promises to delete the branch's ref, which a detached HEAD
  // doesn't have: every route explains the backend's refusal instead.
  const detachedRoot = rootUndo && Boolean(head?.detached);
  // A pending or failed opState read holds nothing, and the backend still
  // refuses.
  const undoMidOp = undoMidOpOf(opState.data);

  // The confirm sits here rather than on the menu items, so the search menu and
  // the single-commit menu can't diverge on whether they ask.
  async function doCheckoutCommit(hash: string) {
    const checkoutIn = repoPath;
    if (!(await useConfirm.getState().ask(checkoutCommitConfirm(hash)))) return;
    if (refuseIfSwitched(checkoutIn, "nothing was checked out")) return;
    // Below the confirm: a promote can start while the prompt is open.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    try {
      await checkoutCommit.mutateAsync(hash);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(checkoutCommitSuccessToast(hash));
  }

  // A merge commit routes to the mainline-parent dialog instead of the confirm.
  async function doRevertCommit(hash: string, isMerge: boolean) {
    if (isMerge) {
      setMergePick({ hash, op: "revert", repo: repoPath });
      return;
    }
    const revertIn = repoPath;
    if (!(await useConfirm.getState().ask(revertCommitConfirm(hash)))) return;
    if (refuseIfSwitched(revertIn, "nothing was reverted")) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    void revertCommit.mutateAsync({ hash }).catch(onError);
  }

  // `alreadyApplied` is the one thing the two menus word differently.
  async function doCherryPick(
    hash: string,
    alreadyApplied: string,
    isMerge: boolean,
  ) {
    if (isMerge) {
      setMergePick({ hash, op: "cherry-pick", alreadyApplied, repo: repoPath });
      return;
    }
    const pickIn = repoPath;
    const ok = await useConfirm
      .getState()
      .ask(cherryPickCommitConfirm(hash, currentBranch));
    if (!ok || refuseIfSwitched(pickIn, "nothing was cherry-picked")) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    let applied: boolean;
    try {
      applied = await cherryPick.mutateAsync({ hash });
    } catch (e) {
      onError(e);
      return;
    }
    if (applied) {
      toast.success(`Cherry-picked ${hash.slice(0, 7)}`);
    } else {
      toast.info(alreadyApplied);
    }
  }

  async function pushTagToOrigin(tag: string) {
    if (pendingTagPush(tag) || refuseWhileOffline()) return;
    if (refuseWhilePublishing(queryClient, repoPath)) return;
    const pushedIn = repoPath;
    try {
      await pushTag.mutateAsync(tag);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(`Pushed tag ${tag} to origin${landedIn(pushedIn).away}`);
  }

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  // Derived commit lists — memoized so the per-render .flat()/.filter()/.map()
  // allocations don't churn (they feed the list + selection gating on every
  // keystroke). Computed before the early returns to satisfy the rules of hooks;
  // harmlessly empty while the log is still loading.
  const commits = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);
  // The selection and anchor keep no commit a new log answer stopped listing,
  // whichever route rewrote it, pruned in the render that lands the answer.
  // Only ids the previous answer listed go: a search hit outside the loaded
  // pages stays.
  const [prunedFor, setPrunedFor] = useState(commits);
  if (prunedFor !== commits) {
    setPrunedFor(commits);
    const listed = new Set(commits.map((c) => c.hash));
    const dropped = new Set(
      prunedFor.filter((c) => !listed.has(c.hash)).map((c) => c.hash),
    );
    if ([...selected].some((h) => dropped.has(h))) {
      setSelected(new Set([...selected].filter((h) => !dropped.has(h))));
    }
    if (anchorHash !== null && dropped.has(anchorHash)) setAnchorHash(null);
  }
  const searchCommits = useMemo(
    () => search.data?.pages.flat() ?? [],
    [search.data],
  );
  // Client-side filter over the loaded pages (subject, author, or SHA).
  const query = filterText.trim().toLowerCase();
  const filteredCommits = useMemo(
    () =>
      query
        ? commits.filter(
            (c) =>
              c.subject.toLowerCase().includes(query) ||
              c.author.toLowerCase().includes(query) ||
              c.hash.toLowerCase().startsWith(query),
          )
        : commits,
    [commits, query],
  );
  // In search mode the list is whole-history matches: the SHA arm's on-branch
  // hits lead, grep rows follow minus duplicates, and off-branch hits never
  // become rows (they're notices above the list). Otherwise it's the
  // (client-filtered) loaded pages.
  const { rows: searchRows, offBranch: offBranchRows } = useMemo(
    () => mergeSearchResults(shaLookup.data, searchCommits),
    [shaLookup.data, searchCommits],
  );
  const offBranchShown = searchActive && offBranchRows.length > 0;
  // One prefix length for every shown notice row, so their SHAs line up and
  // stay distinct; the overflow rows show no SHA and don't count.
  const offBranchNoticeRows = offBranchRows.slice(0, OFF_BRANCH_NOTICE_CAP);
  const offBranchPrefixLen = distinctPrefixLength(
    offBranchNoticeRows.map((c) => c.hash),
  );
  const visibleCommits = searchActive ? searchRows : filteredCommits;
  // A commit Edit dates rewrote takes focus on its row: the dialog's close
  // lands it when the row is already rendered, else this does once the
  // refetched log shows it. Armed only by a change that closed the dialog,
  // tagged with its repo, and dropped once focus is found anywhere but the
  // body, the closing dialog, or the commit detail's focus host (which takes
  // focus from the body when the selection moves), so it never fires later on
  // a replay or re-render.
  const landDatesRow = useRef<{ repo: string; hash: string } | null>(null);
  const datesRowEl = (hash: string) =>
    scrollEl?.querySelector<HTMLElement>(`[data-hash="${CSS.escape(hash)}"]`) ??
    null;
  useEffect(() => {
    const want = landDatesRow.current?.hash;
    if (want === undefined) return;
    if (landDatesRow.current?.repo !== repoPath) {
      landDatesRow.current = null;
      return;
    }
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      !active.matches("[data-commit-detail-focus-host]")
    ) {
      if (active.closest("[data-edit-dates-dialog]") === null) {
        landDatesRow.current = null;
      }
      return;
    }
    if (!visibleCommits.some((c) => c.hash === want)) return;
    const row = scrollEl?.querySelector<HTMLElement>(
      `[data-hash="${CSS.escape(want)}"]`,
    );
    if (!row) return;
    landDatesRow.current = null;
    row.focus();
  }, [visibleCommits, scrollEl, repoPath]);
  // Squash gating needs the selection's positions in REAL history (not the
  // filtered view), so index against `commits`.
  const selectedIndices = useMemo(
    () =>
      commits
        .map((c, i) => (selected.has(c.hash) ? i : -1))
        .filter((i) => i >= 0),
    [commits, selected],
  );

  // Commits not yet on the remote. Published branch → the top `ahead` commits
  // (ahead of its upstream). Unpublished branch (no upstream) → count them
  // against the remotes, NOT `commits.length`: the fork point and everything
  // below it live on `origin/<base>` and are already published, so only the
  // branch's own commits are unpushed. A repo with no configured remote and no
  // resolving remote-tracking ref counts against its local default branch
  // instead, and on that branch itself only the row arrows drop (`arrowCount`).
  // (Queried only in the no-upstream case.)
  // Drives both the rewrite gating below and the per-row "not pushed" marker.
  // A gone upstream counts as no upstream so the `unpushedVsRemotes` fallback
  // engages and the per-row "not pushed" markers reflect what's truly published.
  const noUpstream = isNoUpstream(head);
  const unpushedVsRemotes = useUnpushedCount(repoPath, noUpstream);
  // The `?? 0` below never claims "all pushed" for a failed count read: an
  // errored count fails `viewAgrees`, so the markers serve the last agreeing
  // snapshot (or mark nothing) and squash / Edit history hold.
  const unpushedCount = head
    ? noUpstream
      ? (unpushedVsRemotes.data?.count ?? 0)
      : head.ahead
    : 0;
  // What the no-upstream count was taken against, read from the same answer as
  // the count so the two always pair; null in upstream mode.
  const countRead = head && noUpstream ? unpushedVsRemotes.data : undefined;
  const unpushedBasis = countRead?.basis ?? null;
  const unpushedDefault = countRead?.defaultBranch ?? null;
  // The count (status's ahead, or the no-upstream count read) and the log's
  // commits refetch apart: the unpushed consumers below read them only as a
  // pair both vouched for — the log's head is status's HEAD, and a no-upstream
  // count read is unerrored, counted from that same HEAD, and taken on the
  // branch status reports (a same-tip switch moves no oid).
  const agreed = viewAgrees({
    logHead: commits[0]?.hash,
    statusOid: head?.oid,
    noUpstream,
    countIsError: unpushedVsRemotes.isError,
    countHead: unpushedVsRemotes.data?.headOid,
    countBasis: unpushedVsRemotes.data?.basis,
    countDefault: unpushedVsRemotes.data?.defaultBranch,
    statusBranch: head?.name,
  });
  // The last agreeing unpushed view, advanced only on agreement so a
  // mismatch window in which the log still starts at its head keeps serving
  // the set both reads vouched for; null until the first agreement so a
  // mismatched first render marks nothing. The render-time setState settles
  // only because advanceSnapshot returns `prev` for an unchanged input.
  const [snapshot, setSnapshot] =
    useState<UnpushedSnapshot<CommitSummary> | null>(null);
  const nextSnap = advanceSnapshot(
    snapshot,
    {
      repo: repoPath,
      branch: head?.name ?? null,
      commits,
      count: unpushedCount,
      basis: unpushedBasis,
      defaultBranch: unpushedDefault,
      hasNextPage: log.hasNextPage,
    },
    agreed,
  );
  if (nextSnap !== snapshot) setSnapshot(nextSnap);
  const view = resolveUnpushedView({
    agreed,
    repo: repoPath,
    branch: head?.name ?? null,
    statusOid: head?.oid,
    liveAhead: head?.ahead ?? 0,
    noUpstream,
    commits,
    count: unpushedCount,
    basis: unpushedBasis,
    defaultBranch: unpushedDefault,
    hasNextPage: log.hasNextPage,
    snapshot,
  });
  // The unpushed set (the top `view.count` of the gated view's HEAD-order
  // commits), for squash gating. CommitList derives its own row markers from
  // `view.commits` + `view.count`: this Set is fresh every render, and passing
  // it would keep the compiler from caching the CommitList element.
  const unpushedHashes = new Set(
    view.commits.slice(0, view.count).map((c) => c.hash),
  );

  // Above the early returns below: the Edit dates hook must run on every
  // render, and so must everything it reads. Everything here that reads `view`
  // after deriveEditRange passes primitives or fresh arrays only.
  // Hold Squash, Edit history and Cherry-pick to branch while a merge/rebase/
  // cherry-pick/revert is mid-flight — a new rebase or pick would clobber the
  // in-flight one's state (the banner drives it). The backend refuses too;
  // this just keeps the actions from looking live.
  const opInProgress = Boolean(
    opState.data?.merging ||
      opState.data?.rebasing ||
      opState.data?.cherryPicking ||
      opState.data?.reverting,
  );
  // A no-upstream count read that failed won't agree by waiting, so the hold
  // names it rather than "refreshing" indefinitely, and keeps naming it through
  // the retry each status poll fires.
  const countUnchecked =
    noUpstream && failedSinceLastSuccess(unpushedVsRemotes);
  const refreshingHint = countUnchecked
    ? UNPUSHED_UNCHECKED_HINT
    : HISTORY_REFRESHING_HINT;
  // Edit history: the top unpushed commits (capped), needing a base below them.
  // Merge commits can't be replayed, so the range stops at the first one. One
  // editable commit is enough (you can reword or drop a single commit).
  const { editLen, editCommits, editBase } = deriveEditRange(
    view.commits,
    view.count,
    view.hasNextPage,
  );
  const editableHashes = editCommits.map((c) => c.hash);
  // Unmerged entries with no stopped operation: the backend refuses the undo
  // and a date change.
  const undoUnresolved = (status.data?.entries ?? []).some(isConflictedEntry);
  const editDatesRouteOf = (hash: string) =>
    editDatesRoute({
      hash,
      index: commits.findIndex((c) => c.hash === hash),
      headOid: head?.oid,
      opInProgress,
      unresolved: undoUnresolved,
      viewAgreed: agreed,
      unpushedCount: view.count,
      editable: editableHashes,
    });
  // HEAD opens the small dialog pinned to the cached status HEAD (no cached
  // HEAD, nothing to pin, so nothing opens); an editable commit opens Edit
  // history on its dates. The cache can name a newer HEAD than the rendered
  // route saw, and a pin on it would amend a commit the dialog never showed.
  function openEditDates(hash: string) {
    const route = editDatesRouteOf(hash);
    if (route.kind === "history") {
      setEditHistoryOpen({ datesFor: hash });
      return;
    }
    if (route.kind !== "head") return;
    const shownHead = queryClient.getQueryData<RepoStatus>(
      repoStatusOptions(repoPath).queryKey,
    )?.branch;
    if (!shownHead?.oid || shownHead.oid !== hash) return;
    setEditDates({
      hash,
      repo: repoPath,
      expectedHead: shownHead.oid,
      expectedBranch: headBranchPin(shownHead),
    });
  }
  const paletteDatesRoute =
    selectedCommitHash === null
      ? null
      : editDatesRouteOf(selectedCommitHash).kind;
  useHotkeyAction(
    "edit-commit-dates",
    () => {
      if (selectedCommitHash !== null) openEditDates(selectedCommitHash);
    },
    (paletteDatesRoute === "head" || paletteDatesRoute === "history") &&
      selected.size <= 1,
  );

  // GitHub Desktop-style undo: offered while the latest commit hasn't been
  // pushed anywhere. An upstream branch reads `ahead`; with no upstream (or a
  // gone one) the live count against the remotes decides, held while it is
  // unread, failed, or not yet agreeing with the log.
  const undoPushed: UndoPushedHold | null = undoPushedHold({
    noUpstream,
    ahead: head?.ahead ?? 0,
    countLoaded: unpushedVsRemotes.data !== undefined,
    countFailed: countUnchecked,
    basis: unpushedBasis,
    count: unpushedCount,
    agreed,
  });
  const canUndo = Boolean(lastCommit && head) && undoPushed === null;

  async function undoLast() {
    if (!lastCommit || !head) return;
    // Ahead of every read and confirm: the backend would refuse anyway.
    if (undoMidOp) {
      // An abort run in a terminal that leaves HEAD in place (a merge, or a
      // pick or revert with nothing committed yet) triggers no re-read of the
      // cached op state: a refusal re-reads it first and re-gates on the
      // answer (a failed read keeps the cached one). Across the await only the
      // repo is re-checked; lastCommit and head stay this render's, and the
      // backend pins the HEAD it undoes.
      const checkIn = repoPath;
      let fresh: RepoOpState | undefined;
      try {
        fresh = await queryClient.fetchQuery({
          ...opStateOptions(repoPath),
          staleTime: 0,
        });
      } catch {
        fresh = undefined;
      }
      if (
        refuseIfSwitched(
          checkIn,
          "nothing was undone",
          "before the undo started",
        )
      )
        return;
      const midOp = fresh ? undoMidOpOf(fresh) : undoMidOp;
      if (midOp) {
        toast.info(midOp === "mid-pick" ? UNDO_MID_PICK : UNDO_MID_MERGE);
        return;
      }
    }
    // After the mid-op re-read, whose refusal outranks these (the backend's
    // order), and ahead of every read and confirm.
    if (undoUnresolved) {
      toast.info(UNDO_UNRESOLVED);
      return;
    }
    if (undoPushed === "unpushed-unchecked") {
      toast.info(UNDO_PUSHED_UNCHECKED);
      return;
    }
    if (undoPushed === "refreshing") {
      toast.info(UNDO_PUSHED_REFRESHING);
      return;
    }
    // The menu holds these arms; the shortcut and palette stay enabled and
    // explain by toast instead.
    if (headIsRoot) {
      if (shallowBoundary) {
        toast.info(UNDO_SHALLOW_BOUNDARY);
        return;
      }
      // A failed background refetch over a cached answer still answers.
      if (recordsParent.data === undefined) {
        if (recordsParent.isError) {
          toastErrorWithNote(recordsParent.error, "Nothing was undone.");
        } else {
          toast.info(
            "Still checking the latest commit — try again in a moment.",
          );
        }
        return;
      }
    }
    if (detachedRoot) {
      toast.info(UNDO_DETACHED_ROOT);
      return;
    }
    // Before the first prompt, so a running push refuses before any question;
    // checked again after the last await below.
    if (
      refuseWhilePinnedBranchPushes(queryClient, repoPath, headBranchPin(head))
    )
      return;
    const undoIn = repoPath;
    // The root case is the only one that asks about the commit itself: an
    // ordinary undo is gated to unpushed commits and leaves everything staged.
    // (Typed text in the commit box asks separately, below.)
    if (rootUndo) {
      if (!(await useConfirm.getState().ask(UNDO_ROOT_COMMIT_CONFIRM))) return;
      // Ahead of the promotion check, which reads the start repo: a switch
      // during the prompt refuses before anything reports on a repo off screen.
      if (refuseIfSwitched(undoIn, "nothing was undone")) return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    let details: CommitDetails;
    try {
      // The backend pins `lastCommit.hash` and the branch shown under the repo lock
      // and refuses if HEAD moved or switched, so a commit or checkout landing out of
      // band (another window, a terminal) never redirects the undo; the refusal
      // settles as an error, refreshing the log.
      // Read the message BEFORE the undo removes the commit it belongs to.
      details = await gitCommitDetails(repoPath, lastCommit.hash);
      // The undo builds from the observer's options when it is called, which
      // follow the live repo: a switch during the read above refuses instead.
      if (
        refuseIfSwitched(
          undoIn,
          "nothing was undone",
          "before the undo started",
        )
      )
        return;
      // The undo writes this commit's message into the commit box, so typed
      // text there asks first; a Cancel undoes nothing.
      const draft = useUiStore.getState();
      if (
        replacesTypedMessage(
          { title: draft.commitTitle, body: draft.commitBody },
          details,
        )
      ) {
        const ask = useConfirm.getState().ask;
        if (!(await ask(replacesMessageConfirm("undo", lastCommit.hash))))
          return;
        if (refuseIfSwitched(undoIn, "nothing was undone")) return;
        // Below the confirm: a promote can start while the prompt is open.
        if (promotionBlocksCheckout(repoPath)) {
          toast.info(PROMOTION_BLOCKS_CHECKOUT);
          return;
        }
      }
      // After the last await on both paths: a push of this branch began while
      // a prompt or the message read was pending.
      if (
        refuseWhilePinnedBranchPushes(
          queryClient,
          repoPath,
          headBranchPin(head),
        )
      )
        return;
      await undoCommit.mutateAsync({
        expectedHead: lastCommit.hash,
        expectedBranch: headBranchPin(head),
      });
    } catch (e) {
      onError(e);
      return;
    }
    // The draft restore, tab flip and selection prune write the LIVE repo's
    // state — a repo switch mid-undo must not land this repo's message in
    // another repo's draft. The toast stays: the undo happened regardless.
    if (useUiStore.getState().repoPath === repoPath) {
      setCommitDraft(details.subject, details.body);
      setRepoTab("changes");
      // A prune, never selectCommit(null): that bumps and strands a pending
      // amend's landing.
      if (useUiStore.getState().selectedCommitHash === lastCommit.hash) {
        clearSelectedCommit();
      }
      // The panel's own multi-selection keeps no gone commit, nor an anchor a
      // shift-range would extend from. The panel survives a repo switch, so
      // after one its selection is the new repo's and stays untouched.
      const undone = lastCommit.hash;
      setSelected((s) => {
        if (!s.has(undone)) return s;
        const next = new Set(s);
        next.delete(undone);
        return next;
      });
      setAnchorHash((a) => (a === undone ? null : a));
    }
    toast.success(
      `Undid ${lastCommit.hash.slice(0, 7)} — changes are staged again`,
    );
  }

  // The log can trail an outside commit (and push): undo only the HEAD status
  // reports. Disabled only while already pushed; the transient pushed holds,
  // unresolved conflicts and a detached first commit stay enabled ON PURPOSE,
  // unlike the menu: the palette hides disabled actions with no reason, so
  // firing explains by toast, as promotionBlocksCheckout does.
  useHotkeyAction(
    "undo-commit",
    undoLast,
    Boolean(lastCommit && head) &&
      undoPushed !== "already-pushed" &&
      !undoCommit.isPending &&
      lastCommit?.hash === head?.oid,
  );

  // A failed read never stands in for an answer: "No commits yet" and "No
  // commits … match" render only from reads that returned empty, and a failure
  // over loaded pages keeps them under the notice. The notice speaks for the
  // list on screen only, so a log failure is silent while search results show.
  const logLoadFailed = log.data === undefined && refreshFailed(log);
  const searchShown = searchActive && commits.length > 0;
  // Search all's two arms answer apart. Negative copy and the coverage claim
  // render only from arms that answered; a dead arm swaps its claim for a
  // failure line, and the error block shows only when nothing at all can. A
  // stale arm keeps its rows under the list's refresh notice instead.
  const shaEligible = isShaPrefixQuery(debouncedQuery);
  const shortHex = isShortHexQuery(debouncedQuery);
  const grepSplit = splitInfiniteFailure(search);
  const grepRead = armRead({
    hasData: search.data !== undefined,
    failed: grepSplit.failed,
  });
  const shaRead = armRead({
    hasData: shaLookup.data !== undefined,
    failed: shaEligible && refreshFailed(shaLookup),
  });
  const grepFailed = grepRead === "dead";
  const shaFailed = shaRead === "dead";
  // Every Retry on these arms refetches each one whose last read failed, dead
  // or stale, and only those.
  const retryFailedArms = () => {
    if (grepRead !== "answering") void search.refetch();
    if (shaRead !== "answering") void shaLookup.refetch();
  };
  const coverage = searchCoverage({
    shaFailed,
    grepFailed,
    hasShaMatches: (shaLookup.data?.length ?? 0) > 0,
  });
  const shaPending = shaEligible && shaLookup.data === undefined && !shaFailed;
  // Waits for a SHA arm still answering, and gives way to anything it found,
  // off-branch notices included.
  const searchLoadFailed =
    searchShown &&
    grepFailed &&
    !shaPending &&
    searchRows.length === 0 &&
    !offBranchShown;
  // Covers the debounce window and every fetch either arm runs, refetches
  // included, so the empty state never claims "No commits…" over a read
  // still in flight; failed arms drop out so their own lines can render
  // instead.
  const searchSettling =
    searchActive &&
    (filterText.trim() !== debouncedQuery ||
      search.isFetching ||
      (search.data === undefined && !grepFailed) ||
      (shaEligible && shaLookup.isFetching) ||
      shaPending);
  // The empty state gives way to the off-branch notice once settled.
  const searchEmptyShown =
    searchShown &&
    !searchLoadFailed &&
    searchRows.length === 0 &&
    !(offBranchShown && !searchSettling);
  // A dead SHA arm's line sits in the settled empty state when nothing
  // matched, and in the footer whenever rows are showing.
  const shaRetryInEmpty =
    coverage === "sha-failed" && searchEmptyShown && !searchSettling;
  const shaRetryInFooter =
    searchShown && coverage === "sha-failed" && searchRows.length > 0;
  const grepRetryInFooter = searchShown && coverage === "grep-failed";
  // One failure line at a time: a dead arm's line (footer, empty state or
  // block) speaks for a stale arm too, so the refresh notice gives way to it.
  // A failed Load more is pagination, not an arm, so its notice stays.
  const armLineShown =
    searchLoadFailed ||
    shaRetryInEmpty ||
    shaRetryInFooter ||
    grepRetryInFooter;
  const notice = (() => {
    switch (true) {
      case searchShown && search.data === undefined && shaRead !== "stale":
        return null;
      case searchShown:
        return listNotice({
          noun: "matches",
          failed: !armLineShown && (grepSplit.failed || shaRead === "stale"),
          loadMoreFailed: grepSplit.loadMoreFailed,
          offline: false,
          placeholder: false,
          hasRows: searchRows.length + offBranchRows.length > 0,
        });
      case log.data === undefined:
        return null;
      default:
        return listNotice({
          noun: "commits",
          ...splitInfiniteFailure(log),
          offline: false,
          placeholder: false,
          // Loaded rows, not filtered ones: a filter matching nothing still sits
          // over the last loaded results.
          hasRows: commits.length > 0,
        });
    }
  })();
  // Each Retry's arm unmounts as its read refetches; focus lands on the shell.
  const { hostRef: logHostRef, retryRef: logRetryRef } =
    useRetryFocusRescue(logLoadFailed);
  const { hostRef: searchHostRef, retryRef: searchRetryRef } =
    useRetryFocusRescue(searchLoadFailed);
  // One rescue per Retry position: the SHA line moving from the empty state to
  // the footer unmounts the focused Retry while the line still shows.
  const { hostRef: shaEmptyHostRef, retryRef: shaEmptyRetryRef } =
    useRetryFocusRescue(shaRetryInEmpty);
  const { hostRef: shaFooterHostRef, retryRef: shaFooterRetryRef } =
    useRetryFocusRescue(shaRetryInFooter);
  const { hostRef: grepArmHostRef, retryRef: grepArmRetryRef } =
    useRetryFocusRescue(grepRetryInFooter);
  // A Load more that fetches the last page unmounts under the user's focus;
  // the same edge rescue lands it on the shell. Each flag is true exactly
  // while its button is mounted (the list arm, in its mode, with a next page).
  const listArm = log.data !== undefined && commits.length > 0;
  const { hostRef: logMoreHostRef, retryRef: logMoreRetryRef } =
    useRetryFocusRescue(listArm && !searchActive && log.hasNextPage);
  const { hostRef: searchMoreHostRef, retryRef: searchMoreRetryRef } =
    useRetryFocusRescue(listArm && searchActive && search.hasNextPage);
  // A refreshed SHA answer can unmount a focused Open commit: focus goes to the
  // next remaining row's button (earlier rows React already removed aren't
  // counted), else the last remaining one, else the shell. A microtask decides
  // once the commit's DOM is final, and only for a row really gone with focus
  // on <body>: a hidden or re-attached row, or a newer focus move, keeps focus.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const offBranchRowRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    return () => {
      if (!node.contains(document.activeElement)) return;
      const parent = node.parentElement;
      let index = 0;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling)
        if (s.querySelector("button") !== null) index += 1;
      queueMicrotask(() => {
        if (node.isConnected || document.activeElement !== document.body)
          return;
        const buttons = parent?.isConnected
          ? Array.from(parent.children).flatMap((row) => {
              const button = row.querySelector("button");
              return button === null ? [] : [button];
            })
          : [];
        const next = buttons[Math.min(index, buttons.length - 1)];
        (next ?? shellRef.current)?.focus({ preventScroll: true });
      });
    };
  }, []);
  // Pre-mounted at one tree position, never under aria-busy: a live region
  // created together with its text announces unreliably.
  const announcement = (() => {
    switch (true) {
      case logLoadFailed:
        return `Couldn't load the history. ${presentError(log.error).summary}`;
      case searchLoadFailed:
        return `${SEARCH_ALL_FAILED_LINE} ${presentError(search.error).summary}`;
      default:
        return "";
    }
  })();

  const noticeRetry = (() => {
    switch (true) {
      case notice?.cause !== "refresh":
        return undefined;
      case searchShown:
        return retryFailedArms;
      default:
        return () => void log.refetch();
    }
  })();
  const shell = (body: ReactNode, header: ReactNode = null) => (
    <div
      ref={(node) => {
        logHostRef(node);
        searchHostRef(node);
        shaEmptyHostRef(node);
        shaFooterHostRef(node);
        grepArmHostRef(node);
        logMoreHostRef(node);
        searchMoreHostRef(node);
        shellRef.current = node;
      }}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {header}
      <DegradedListNotice
        noun={searchShown ? "matches" : "commits"}
        degraded={notice !== null}
        message={notice?.message}
        retryLabel={notice?.retryLabel}
        onRetry={noticeRetry}
        className="shrink-0 border-b px-3 py-1.5"
      />
      {body}
    </div>
  );

  if (logLoadFailed) {
    return shell(
      <div className="px-3 py-8 text-center text-xs">
        <p className="font-medium text-destructive">
          Couldn't load the history.
        </p>
        <p className="mt-1 text-muted-foreground">
          {presentError(log.error).summary}
        </p>
        <Button
          ref={logRetryRef}
          variant="outline"
          size="sm"
          className="mt-2 cursor-pointer"
          onClick={() => void log.refetch()}
        >
          Retry
        </Button>
      </div>,
    );
  }

  // A never-loaded read refetching after a failure loads like a first read.
  if (log.data === undefined) {
    return shell(
      <div className="flex-1">
        <ListRowSkeletons rows={3} lines={2} indent={false} name="commits" />
      </div>,
      <div className="border-b p-2">
        {/* A disabled copy of the header below, so the rows don't shift when
            the log lands. */}
        <Input
          disabled
          value={filterText}
          placeholder={FILTER_PLACEHOLDER}
          className="h-7"
          autoComplete="off"
        />
      </div>,
    );
  }

  if (commits.length === 0) {
    return shell(
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCommitIcon />
          </EmptyMedia>
          <EmptyTitle>No commits yet</EmptyTitle>
          <EmptyDescription>
            Your project's history shows up here. Make a change, then stage and
            commit it to record your first commit.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRepoTab("changes")}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Go to Changes
          </Button>
        </EmptyContent>
      </Empty>,
    );
  }

  // Shift-extend the selection to a contiguous range of the rendered (possibly
  // filtered) list — shared by the mouse and keyboard paths. Indices are positions
  // in `visibleCommits`.
  function selectRange(from: number, to: number) {
    const [a, b] = [from, to].sort((x, y) => x - y);
    setSelected(new Set(visibleCommits.slice(a, b + 1).map((c) => c.hash)));
  }

  // Shift extends from the anchor, else from the row the highlight rule paints
  // while nothing is multi-selected (the store's commit, which a rewrite moves
  // onto its new id).
  const rangeFrom = () =>
    visibleCommits.findIndex(
      (c) =>
        c.hash ===
        (anchorHash ?? (selected.size === 0 ? selectedCommitHash : null)),
    );
  // A range the fallback started keeps its row as the anchor, so the next Shift
  // step extends the range instead of collapsing it to one row.
  const pinFallbackAnchor = (from: number) => {
    if (anchorHash === null) setAnchorHash(visibleCommits[from].hash);
  };

  function onRowClick(e: React.MouseEvent, index: number, hash: string) {
    // Keep the diff panel on the clicked commit regardless of modifiers.
    selectCommit(hash);
    // Search results aren't contiguous history — single-select only there.
    if (searchActive) {
      setSelected(new Set([hash]));
      setAnchorHash(null);
      return;
    }
    const from = rangeFrom();
    if (e.shiftKey && from !== -1) {
      selectRange(from, index);
      pinFallbackAnchor(from);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      setSelected(next);
      setAnchorHash(hash);
    } else {
      setSelected(new Set([hash]));
      setAnchorHash(hash);
    }
  }

  function onHoverPrefetch(hash: string) {
    hoverPrefetch(() => prefetchCommit(hash));
  }

  // Right-clicking a commit outside the selection collapses the selection
  // to it (standard desktop behavior) — the context menu then always
  // describes exactly what it acts on.
  function onRowContextMenu(hash: string) {
    if (!selected.has(hash)) {
      setSelected(new Set([hash]));
      setAnchorHash(hash);
      selectCommit(hash);
    }
  }

  // Arrow keys walk the history selection; Shift extends it from the anchor,
  // else the highlighted row.
  const onListKeyDown = listKeyboardNav({
    items: visibleCommits,
    activeIndex: visibleCommits.findIndex((c) => c.hash === selectedCommitHash),
    rowKey: (c) => c.hash,
    rowAttr: "data-hash",
    onActivate: (commit, to, shift) => {
      selectCommit(commit.hash);
      const from = rangeFrom();
      if (shift && from !== -1) {
        selectRange(from, to);
        pinFallbackAnchor(from);
      } else {
        setSelected(new Set([commit.hash]));
        setAnchorHash(commit.hash);
      }
    },
  });

  // The commits a context-menu action applies to: the multi-selection when the
  // right-clicked commit is part of it, otherwise just that one commit.
  function effectiveSelection(hash: string): string[] {
    const base =
      selected.has(hash) && selected.size > 1 ? selected : new Set([hash]);
    // Cherry-pick wants oldest-first; the log is newest-first.
    return commits
      .filter((c) => base.has(c.hash))
      .map((c) => c.hash)
      .reverse();
  }

  const { canSquash, hold: squashHold } = squashGate({
    selectedIndices,
    commits,
    unpushed: unpushedHashes,
    filterActive: query !== "",
    agreed,
    opInProgress,
  });
  const squashHints: Record<SquashHold, string> = {
    ...SQUASH_HOLD_HINT,
    refreshing: refreshingHint,
    "not-adjacent-unpushed": notAdjacentSquashHint(
      view.basis,
      view.defaultBranch,
    ),
  };
  const squashDisabledHint = squashHold ? squashHints[squashHold] : "";
  const squashMax = selectedIndices.at(-1) ?? -1;

  function openSquash() {
    if (!canSquash) return;
    const minIdx = selectedIndices[0];
    const run = commits.slice(minIdx, squashMax + 1);
    // Steps replay base..HEAD oldest-first with the run collapsed.
    const steps: RewriteStep[] = [
      { hashes: [...run].reverse().map((c) => c.hash), message: "" },
      ...commits
        .slice(0, minIdx)
        .reverse()
        .map((c) => ({ hashes: [c.hash] })),
    ];
    setSquashCtx({
      base: commits[squashMax + 1].hash,
      steps,
      count: run.length,
      defaultMessage: [...run]
        .reverse()
        .map((c) => c.subject)
        .join("\n\n"),
    });
  }

  // Waits for agreement like squash: a mismatch may serve a set HEAD has
  // already moved past.
  const editHold = editHistoryHold({
    editLen,
    count: view.count,
    headIsMerge: view.commits[0]?.isMerge === true,
    shallowBoundary,
    agreed,
    opInProgress,
  });
  const canEditHistory = editHold === null;

  // CommitList is uncompiled, so a fresh element re-renders it. For the
  // compiler to cache this one: build it outside the list ternary, from stable
  // props only (never the per-render `view` or Set), and after deriveEditRange,
  // the last call the compiler assumes may mutate `view.commits`.
  const markCommits = view.commits;
  const markCount = arrowCount(view.count, view.basis);
  const markUpstream = arrowUpstream(
    head?.upstreamGone ? null : (head?.upstream ?? null),
    view.basis,
    view.defaultBranch,
  );
  const commitList = (
    <CommitList
      scrollEl={scrollEl}
      commits={visibleCommits}
      selected={selected}
      selectedCommitHash={selectedCommitHash}
      unpushedCommits={markCommits}
      unpushedCount={markCount}
      upstream={markUpstream}
      onRowClick={onRowClick}
      onHoverPrefetch={onHoverPrefetch}
    />
  );

  const nothingAheadOf =
    view.basis === "default-branch" && view.defaultBranch !== null
      ? view.defaultBranch
      : null;
  const editHistoryHints: Record<EditHistoryHold, string> = {
    op: OP_IN_PROGRESS_HINT,
    refreshing: refreshingHint,
    "nothing-unpushed":
      nothingAheadOf === null
        ? " (no unpushed commits)"
        : ` (no commits ahead of ${nothingAheadOf})`,
    "merge-on-top": " (the latest commit is a merge)",
    "shallow-boundary": HEAD_ROW_HOLD_HINT["shallow-boundary"],
    "lone-commit": " (no older commit to rebase onto)",
  };
  const editHistoryHint = editHold ? editHistoryHints[editHold] : "";
  // The empty Edit history dialog's footer line: the same hold in sentence
  // form. Reads that agree on an empty set are final, so only a disagreement
  // says it is catching up.
  const editHistoryEmptyNotes: Record<EditHistoryHold, string> = {
    op: "Finish the operation in Changes first.",
    refreshing: countUnchecked
      ? "Couldn't check which commits are pushed."
      : "Catching up with the branch…",
    "nothing-unpushed":
      nothingAheadOf === null
        ? "Nothing left to edit: every commit is pushed."
        : `Nothing left to edit: no commits ahead of ${nothingAheadOf}.`,
    "merge-on-top": "Nothing left to edit: the latest commit is a merge.",
    "shallow-boundary":
      "Nothing left to edit: the latest commit's parent isn't in this shallow clone.",
    "lone-commit":
      "Nothing left to edit: there's no older commit to rebase onto.",
  };
  // Why cherry-picking onto a branch is unavailable, in precedence order: an
  // in-flight operation (the pick's own conflict path pauses one), a branch list
  // not read yet, then a repo whose every other branch is archived —
  // offerable-looking, but not offered.
  const pickHold = pickOntoHold({
    opInProgress,
    hasData: branches.data !== undefined,
    isPending: branches.isPending,
    isError: branches.isError,
    targetCount: targetBranches.length,
    candidateCount: pickOntoCandidates.length,
  });
  const canPickOnto = pickHold === null;
  const pickOntoDisabledHint =
    pickHold === null ? "" : PICK_ONTO_HOLD_HINT[pickHold];

  function openCherryPickOnto(commit: CommitSummary) {
    const hashes = effectiveSelection(commit.hash);
    // Only a lone merge asks for its mainline, read off the row itself; a batch
    // holding one is gated off.
    const isMerge =
      hashes.length === 1 && hashes[0] === commit.hash && commit.isMerge;
    setPickOnto({ hashes, isMerge, repo: repoPath });
    setPickOntoBranch(targetBranches[0]?.name ?? "");
  }
  // One mainline can't speak for every merge in a batch, so a multi-selection
  // holding a merge can't be picked as one.
  const selectionHasMerge = commits.some(
    (c) => c.isMerge && selected.has(c.hash),
  );

  // One shared context menu for the whole list (capture phase, so it records the
  // right-clicked row before the menu opens) instead of a portal per commit.
  // Mirrors the old per-row onContextMenu's selection-collapse, then captures
  // the target; a right-click on blank space hits no row → suppress the menu.
  function handleCommitContextMenu(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest("[data-hash]");
    const hash = rowEl?.getAttribute("data-hash");
    const index = hash ? visibleCommits.findIndex((c) => c.hash === hash) : -1;
    if (index < 0) {
      setMenuTarget(null);
      suppressContextMenu(e);
      return;
    }
    onRowContextMenu(visibleCommits[index].hash);
    setMenuTarget({ commit: visibleCommits[index] });
    // The rows held mid-operation read a cache that a terminal abort leaving
    // HEAD in place never moves, so each open re-reads it and a held row
    // re-renders once it lands.
    void queryClient.invalidateQueries({
      queryKey: repoKeys.opState(repoPath),
    });
  }

  // The items for whichever commit was right-clicked — three exclusive variants:
  // search results (position-independent), a multi-selection, or a single commit.
  function renderCommitMenu() {
    if (!menuTarget) return null;
    const { commit } = menuTarget;
    // Position in REAL history (-1 once it leaves the loaded log), and HEAD as
    // status reports it: the log can trail a commit made outside the app.
    const menuIndex = commits.findIndex((c) => c.hash === commit.hash);
    const isHead = menuIndex === 0 && commit.hash === head?.oid;
    if (searchActive) {
      // Search results aren't contiguous recent history, so only the shared set.
      return (
        <CommitContextMenuItems
          hash={commit.hash}
          actions={{
            checkout: doCheckoutCommit,
            revert: (hash) => doRevertCommit(hash, commit.isMerge),
            cherryPick: (hash) =>
              doCherryPick(
                hash,
                CHERRY_PICK_ALREADY_APPLIED_SHORT,
                commit.isMerge,
              ),
            createBranch: (hash) => {
              branchForm.reset({ name: "" });
              branchSessionRef.current = {};
              setBranchHash(hash);
            },
            createTag: (hash) => {
              tagForm.reset({ name: "" });
              tagSessionRef.current = {};
              setTagHash(hash);
            },
          }}
        />
      );
    }
    if (selected.has(commit.hash) && selected.size > 1) {
      // Multi-selection: only actions that apply to the whole selection, so
      // nothing silently targets one commit.
      return (
        <>
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={!canPickOnto || selectionHasMerge}
            onClick={() => openCherryPickOnto(commit)}
          >
            Cherry-pick {selected.size} commits to branch…
            {canPickOnto && selectionHasMerge
              ? ` (${RANGE_MERGE_ITEM_REASON})`
              : pickOntoDisabledHint}
          </ContextMenuItem>
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={!canSquash}
            onClick={openSquash}
          >
            Squash {selected.size} commits…
            {!canSquash && squashDisabledHint}
          </ContextMenuItem>
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={!canEditHistory}
            onClick={() => setEditHistoryOpen({})}
          >
            Edit history…
            {editHistoryHint}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() =>
              copyText(
                effectiveSelection(commit.hash).reverse().join("\n"),
                `${selected.size} SHAs copied`,
              )
            }
          >
            Copy {selected.size} SHAs
          </ContextMenuItem>
        </>
      );
    }
    // Only HEAD can be amended; a row that IS status's HEAD while the log trails
    // (an outside reset) is waiting on the log, not out of reach.
    const amendHold = ((): keyof typeof AMEND_HOLD_HINT | null => {
      if (isHead) return null;
      if (menuIndex === 0) return "refreshing";
      if (commit.hash === head?.oid) return "refreshing";
      return "not-latest";
    })();
    // A pushed HEAD routes to its dialog, which warns; only other rows read
    // "already pushed".
    const editDatesRow = editDatesRouteOf(commit.hash);
    const editDatesHints: Record<EditDatesHold, string> = {
      op: OP_IN_PROGRESS_HINT,
      unresolved: RESOLVE_CONFLICTS_HINT,
      refreshing: refreshingHint,
      "head-sync": HISTORY_REFRESHING_HINT,
      pushed: ALREADY_PUSHED_HINT,
      "out-of-range": EDIT_DATES_OUT_OF_RANGE_HINT,
    };
    // In precedence order. A row that left the loaded log under the open menu
    // waits like a trailing log does; "already pushed" reads a loaded status
    // only (with no status, isHead is false and an earlier arm answers).
    const undoHold = ((): HeadRowHold | null => {
      if (
        (menuIndex === 0 && !isHead) ||
        (commit.hash === head?.oid && !isHead) ||
        menuIndex < 0
      )
        return "refreshing";
      if (!isHead && menuIndex > 0) return "not-latest";
      // Rows past HEAD keep their own reason; the HEAD row names a stopped
      // cherry-pick, revert or merge ahead of its other holds, the order the
      // backend refuses in.
      if (undoMidOp) return undoMidOp;
      if (undoUnresolved) return "unresolved";
      if (isHead && headIsRoot && !rootKnown && !recordsParent.isError)
        return "checking-parent";
      if (undoCommit.isPending) return "undoing";
      if (!canUndo) return undoPushed ?? "already-pushed";
      if (isHead && detachedRoot) return "detached-root";
      if (shallowBoundary) return "shallow-boundary";
      if (
        headIsRoot &&
        recordsParent.data === undefined &&
        recordsParent.isError
      )
        return "parent-unread";
      return null;
    })();
    // The reset pins the HEAD it opens on, so it opens only while the log and
    // status agree on which commit that is.
    const resetAgrees = headAgrees(lastCommit?.hash, head?.oid);
    const resetHold = ((): HeadRowHold | null => {
      if (!resetAgrees) return "refreshing";
      if (menuIndex === 0) return "already-at";
      if (menuIndex < 0) return "refreshing";
      return null;
    })();
    return (
      <>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={!isHead}
          onClick={() => requestAmend(commit.hash)}
        >
          Amend commit…
          {amendHold && AMEND_HOLD_HINT[amendHold]}
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={editDatesRow.kind === "held"}
          onClick={() => openEditDates(commit.hash)}
        >
          Edit dates…
          {editDatesRow.kind === "held" && editDatesHints[editDatesRow.hold]}
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={
            undoMidOp !== null ||
            undoUnresolved ||
            !isHead ||
            !canUndo ||
            undoCommit.isPending ||
            detachedRoot ||
            shallowBoundary ||
            (headIsRoot && !rootKnown)
          }
          onClick={undoLast}
        >
          Undo commit (keep changes)
          {undoHold && HEAD_ROW_HOLD_HINT[undoHold]}
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={menuIndex <= 0 || !resetAgrees}
          onClick={() => {
            if (!head?.oid) return;
            setReset({
              hash: commit.hash,
              repo: repoPath,
              expectedHead: head.oid,
              expectedBranch: headBranchPin(head),
            });
          }}
        >
          Reset to commit…
          {resetHold && HEAD_ROW_HOLD_HINT[resetHold]}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => doCheckoutCommit(commit.hash)}>
          Checkout commit
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => doRevertCommit(commit.hash, commit.isMerge)}
        >
          Revert changes in commit
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            branchForm.reset({ name: "" });
            branchSessionRef.current = {};
            setBranchHash(commit.hash);
          }}
        >
          Create branch from commit…
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            tagForm.reset({ name: "" });
            tagSessionRef.current = {};
            setTagHash(commit.hash);
          }}
        >
          Create tag…
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            doCherryPick(
              commit.hash,
              CHERRY_PICK_ALREADY_APPLIED,
              commit.isMerge,
            )
          }
        >
          Cherry-pick commit
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={!canPickOnto}
          onClick={() => openCherryPickOnto(commit)}
        >
          Cherry-pick to branch…
          {pickOntoDisabledHint}
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_HELD_ROW_CLASS}
          disabled={!canEditHistory}
          onClick={() => setEditHistoryOpen({})}
        >
          Edit history…
          {editHistoryHint}
        </ContextMenuItem>
        {commit.tags.length > 0 && <ContextMenuSeparator />}
        {commit.tags.map((tag) => {
          const pushing = pendingTagPush(tag);
          return (
            <ContextMenuItem
              key={`push:${tag}`}
              className={MENU_HELD_ROW_CLASS}
              disabled={!!offlineHold || !!pushing}
              onClick={() => void pushTagToOrigin(tag)}
            >
              Push tag {tag} to origin
              {pushing
                ? ` (${pendingItemReason(pushing.paused, "pushing…")})`
                : offlineSuffix}
            </ContextMenuItem>
          );
        })}
        {commit.tags.map((tag) => (
          <ContextMenuItem
            key={`delete:${tag}`}
            onClick={() => {
              setDeleteTagRemote(false);
              setDeleteTag({ name: tag, repo: repoPath });
            }}
          >
            Delete tag {tag}…
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(commit.hash, "SHA copied")}>
          Copy SHA
        </ContextMenuItem>
      </>
    );
  }

  const emptyHeadline = (() => {
    switch (true) {
      case !searchActive:
        return loadedNoMatchLine(filterText.trim());
      case searchSettling:
        return "Searching all history…";
      case coverage === "sha-failed":
        return searchMessagesNoMatchLine(debouncedQuery);
      default:
        return searchAllNoMatchLine(debouncedQuery);
    }
  })();
  const emptyDetail = (() => {
    switch (true) {
      case !searchActive:
        return (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {loadedCheckedLine(commits.length)}
          </p>
        );
      case searchSettling:
        return null;
      case shaRetryInEmpty:
        return (
          <div className="mt-1 flex items-center justify-center gap-2 text-[11px] text-destructive">
            <span>{SHA_ARM_FAILED_LINE}</span>
            <Button
              ref={shaEmptyRetryRef}
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={retryFailedArms}
            >
              Retry
            </Button>
          </div>
        );
      default:
        return (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {searchAllCheckedLineFor({
              shortHex,
              armFailed: coverage !== "full",
            })}
          </p>
        );
    }
  })();
  // What replaces the list. The list itself renders by name from the JSX
  // ternary, the placement scripts/commit-list-cache-order.test.mjs pins.
  const listHidden = searchLoadFailed || visibleCommits.length === 0;
  const listFallback = (() => {
    switch (true) {
      case searchLoadFailed:
        return (
          <div className="px-3 py-8 text-center text-xs">
            <p className="font-medium text-destructive">
              {SEARCH_ALL_FAILED_LINE}
            </p>
            <p className="mt-1 text-muted-foreground">
              {presentError(search.error).summary}
            </p>
            <div className="mt-2 flex justify-center gap-2">
              <Button
                ref={searchRetryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={retryFailedArms}
              >
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setFilterText("");
                  setSearchMode(false);
                  filterRef.current?.focus();
                }}
              >
                Clear filter
              </Button>
            </div>
          </div>
        );
      case searchActive && !searchEmptyShown:
        return null;
      default:
        return (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground">{emptyHeadline}</p>
            {emptyDetail}
            {!(searchActive && searchSettling) && (
              <Button
                variant="ghost"
                size="xs"
                className="mt-2 text-muted-foreground"
                onClick={() => {
                  setFilterText("");
                  setSearchMode(false);
                  filterRef.current?.focus();
                }}
              >
                Clear filter
              </Button>
            )}
          </div>
        );
    }
  })();

  return shell(
    <>
      {/* Outside the scroll container, so the virtualizer's range and
          scroll-to-index math never count it. */}
      {offBranchShown && (
        <div className="shrink-0">
          {offBranchNoticeRows.map((c) => (
            <div
              key={c.hash}
              ref={offBranchRowRef}
              className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground"
            >
              <p className="min-w-0">
                <span className="font-mono text-foreground">
                  {c.hash.slice(0, offBranchPrefixLen)}
                </span>
                {OFF_BRANCH_NOTICE_SUFFIX}
              </p>
              <Button
                variant="ghost"
                size="xs"
                className="text-foreground"
                aria-label={`${OPEN_COMMIT_LABEL} ${c.hash.slice(0, offBranchPrefixLen)}`}
                onClick={() => {
                  openCommit(c.hash);
                  setSelected(new Set());
                  setAnchorHash(null);
                }}
              >
                {OPEN_COMMIT_LABEL}
              </Button>
            </div>
          ))}
          {offBranchRows.length > OFF_BRANCH_NOTICE_CAP && (
            <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              {offBranchOverflowLine(
                offBranchRows.length - OFF_BRANCH_NOTICE_CAP,
              )}
            </p>
          )}
        </div>
      )}
      {/* Keyed so a repo switch remounts it closed: clearing menuTarget under
          an open menu would leave Base UI's popup empty. */}
      <ContextMenu key={repoPath}>
        <ContextMenuTrigger
          render={
            // Native overflow scroll container (not the Base-UI ScrollArea) so
            // the virtualizer's getScrollElement gets the real scrollable node —
            // see docs/list-virtualization.md. Fixed-height flex child so
            // getTotalSize resolves (max-h would leave it unbounded → 0).
            <div
              ref={setScrollEl}
              className="min-h-0 flex-1 overflow-y-auto"
              data-multiselect={searchActive ? undefined : ""}
              onKeyDown={onListKeyDown}
              onContextMenuCapture={handleCommitContextMenu}
            />
          }
        >
          {listHidden ? listFallback : commitList}
          {searchActive ? (
            <div className="space-y-0.5 px-3 py-2 text-center">
              {(shaRetryInFooter || grepRetryInFooter) && (
                <div className="flex items-center justify-center gap-2 text-[11px] text-destructive">
                  <span>{ARM_FAILED_LINES[coverage]}</span>
                  <Button
                    ref={
                      grepRetryInFooter ? grepArmRetryRef : shaFooterRetryRef
                    }
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={retryFailedArms}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {search.hasNextPage && (
                <Button
                  ref={searchMoreRetryRef}
                  variant="ghost"
                  size="xs"
                  className={cn("text-muted-foreground", ARIA_DISABLED_CLASS)}
                  // Focusable while busy, so a press never drops focus to
                  // <body>; the button is the Load more retry too.
                  disabled={search.isFetchingNextPage}
                  focusableWhenDisabled
                  render={heldButtonRender(search.isFetchingNextPage)}
                  onClick={() => search.fetchNextPage()}
                >
                  {search.isFetchingNextPage && (
                    <Spinner data-icon="inline-start" />
                  )}
                  Load more results
                </Button>
              )}
              <div>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => setSearchMode(false)}
                >
                  Back to recent history
                </Button>
              </div>
            </div>
          ) : (
            <>
              {query && (
                <div className="px-3 py-2 text-center">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-primary"
                    onClick={() => {
                      setCtaStamp({ text: filterText, settled: debouncedText });
                      setSearchMode(true);
                    }}
                  >
                    <MagnifyingGlassIcon data-icon="inline-start" />
                    Search all history for "{filterText.trim()}"
                  </Button>
                </div>
              )}
              {log.hasNextPage && (
                <div className="px-3 py-2 text-center">
                  <Button
                    ref={logMoreRetryRef}
                    variant="ghost"
                    size="xs"
                    className={cn("text-muted-foreground", ARIA_DISABLED_CLASS)}
                    disabled={log.isFetchingNextPage}
                    focusableWhenDisabled
                    render={heldButtonRender(log.isFetchingNextPage)}
                    onClick={() => log.fetchNextPage()}
                  >
                    {log.isFetchingNextPage && (
                      <Spinner data-icon="inline-start" />
                    )}
                    Load more ({commits.length} loaded)
                  </Button>
                </div>
              )}
            </>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-60">
          {renderCommitMenu()}
        </ContextMenuContent>
      </ContextMenu>

      {squashCtx && (
        <SquashDialog
          repoPath={repoPath}
          base={squashCtx.base}
          steps={squashCtx.steps}
          count={squashCtx.count}
          defaultMessage={squashCtx.defaultMessage}
          open
          onOpenChange={(open) => {
            if (!open) setSquashCtx((c) => (c === squashCtx ? null : c));
          }}
          onDone={() => {
            if (useUiStore.getState().repoPath === repoPath) {
              setSelected(new Set());
            }
          }}
        />
      )}

      {editHistoryOpen && (
        <EditHistoryDialog
          repoPath={repoPath}
          base={editBase}
          commits={editCommits}
          initialDatesFor={editHistoryOpen.datesFor}
          emptyNote={editHold ? editHistoryEmptyNotes[editHold] : ""}
          open
          onOpenChange={(o) => {
            if (!o) {
              setEditHistoryOpen((t) => (t === editHistoryOpen ? null : t));
            }
          }}
          onDone={() => {
            if (useUiStore.getState().repoPath === repoPath) {
              setSelected(new Set());
            }
          }}
        />
      )}

      <AmendForcePushDialog {...forcePushDialog} />
      <EditDatesDialog
        key={`edit-dates:${repoPath}`}
        repoPath={repoPath}
        target={editDates}
        adoptSelection
        onClose={() => {
          setEditDates((t) => (t === editDates ? null : t));
        }}
        landFocus={() => {
          const want = landDatesRow.current;
          const row =
            want === null || want.repo !== repoPath
              ? null
              : datesRowEl(want.hash);
          if (row !== null) landDatesRow.current = null;
          return row;
        }}
        onDatesChanged={(oldHash, newHash, closed) => {
          // The old id is gone: the panel's own selection keeps no trace of it.
          if (useUiStore.getState().repoPath !== repoPath) return;
          landDatesRow.current = closed
            ? { repo: repoPath, hash: newHash }
            : null;
          setSelected((s) => {
            if (!s.has(oldHash)) return s;
            const next = new Set(s);
            next.delete(oldHash);
            return next;
          });
          setAnchorHash((a) => (a === oldHash ? null : a));
        }}
      />

      {/* Keyed so a switch remounts these six closed (a deferred exit animation
          would play over the new repo); their session-scoped closes keep a
          frozen instance's late settle from reaching the new repo's dialog. */}
      <DeleteTagDialog
        key={`delete-tag:${repoPath}`}
        repoPath={repoPath}
        name={deleteTag?.name ?? null}
        openedIn={deleteTag?.repo ?? null}
        remote={deleteTagRemote}
        onRemoteChange={setDeleteTagRemote}
        onClose={() => setDeleteTag((d) => (d === deleteTag ? null : d))}
      />

      <ResetCommitDialog
        key={`reset:${repoPath}`}
        repoPath={repoPath}
        hash={reset?.hash ?? null}
        openedIn={reset?.repo ?? null}
        pin={
          reset
            ? {
                expectedHead: reset.expectedHead,
                expectedBranch: reset.expectedBranch,
              }
            : null
        }
        onClose={() => setReset((r) => (r === reset ? null : r))}
      />

      <CreateRefFromCommitDialog
        key={`branch:${repoPath}`}
        form={branchForm}
        open={branchHash !== null}
        onClose={() => {
          branchSessionRef.current = null;
          setBranchHash(null);
        }}
        title="Create branch from commit"
        description={`Creates a branch starting at ${shownBranchHash?.slice(0, 7) ?? ""} and switches to it.`}
        fieldLabel="Branch name"
        placeholder={fromCommitPlaceholder}
        submitLabel="Create branch"
      />

      <CreateRefFromCommitDialog
        key={`tag:${repoPath}`}
        form={tagForm}
        open={tagHash !== null}
        onClose={() => {
          tagSessionRef.current = null;
          setTagHash(null);
        }}
        title="Create tag"
        description={`Tags commit ${shownTagHash?.slice(0, 7) ?? ""}.`}
        fieldLabel="Tag name"
        placeholder="v1.0.0"
        submitLabel="Create tag"
      />

      <CherryPickOntoDialog
        key={`pick-onto:${repoPath}`}
        repoPath={repoPath}
        hashes={pickOnto?.hashes ?? null}
        isMerge={pickOnto?.isMerge ?? false}
        openedIn={pickOnto?.repo ?? null}
        branch={pickOntoBranch}
        onBranchChange={setPickOntoBranch}
        branches={targetBranches}
        currentBranch={currentBranch}
        onClose={() => setPickOnto((p) => (p === pickOnto ? null : p))}
        onDone={() => {
          if (useUiStore.getState().repoPath === repoPath) {
            setSelected(new Set());
          }
        }}
      />

      <MergeParentDialog
        key={`merge-parent:${repoPath}`}
        repoPath={repoPath}
        target={mergePick}
        openedIn={mergePick?.repo ?? null}
        onClose={() => setMergePick((m) => (m === mergePick ? null : m))}
      />
    </>,
    <div className="border-b p-2">
      <Input
        ref={filterRef}
        value={filterText}
        onChange={(e) => {
          setFilterText(e.target.value);
          // Clearing the box returns to filtering the loaded pages.
          if (!e.target.value.trim()) setSearchMode(false);
        }}
        placeholder={FILTER_PLACEHOLDER}
        className="h-7"
        autoComplete="off"
      />
    </div>,
  );
}

// The virtualized commit rows. Isolated in its own leaf component for two
// reasons (docs/list-virtualization.md): useVirtualizer bails its host
// component out of the React Compiler ("incompatible library"), so keeping it
// here lets HistoryPanel's body — filtering, selection, handlers — keep
// compiling; and it only mounts once `commits` is non-empty, so the virtualizer
// never races measureElement over an empty-then-filled list.
function CommitList({
  scrollEl,
  commits,
  selected,
  selectedCommitHash,
  unpushedCommits,
  unpushedCount,
  upstream,
  onRowClick,
  onHoverPrefetch,
}: {
  scrollEl: HTMLDivElement | null;
  commits: CommitSummary[];
  selected: Set<string>;
  selectedCommitHash: string | null;
  /** The gated unpushed view's HEAD-order commits; the top `unpushedCount`
   *  are marked "not pushed". */
  unpushedCommits: CommitSummary[];
  unpushedCount: number;
  upstream: string | null;
  onRowClick: (e: React.MouseEvent, index: number, hash: string) => void;
  onHoverPrefetch: (hash: string) => void;
}) {
  // This component is uncompiled (useVirtualizer), so the memo here is manual.
  const unpushedHashes = useMemo(
    () => new Set(unpushedCommits.slice(0, unpushedCount).map((c) => c.hash)),
    [unpushedCommits, unpushedCount],
  );
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollEl,
    // Rows are near-uniform (~52px: two text lines + padding); measureElement
    // corrects any that wrap.
    estimateSize: () => 52,
    overscan: 12,
    // Key by commit hash, not index, so filtering/search swaps keep stable
    // measurements instead of reusing a stale height for a different commit.
    getItemKey: (index) => commits[index].hash,
  });

  // Arrow-key nav moves the selection by index; the target row may be outside
  // the virtualizer's mounted window (offscreen rows unmount), so
  // listKeyboardNav's synchronous data-hash querySelector finds nothing and
  // focus is dropped. On a *changed* selection we scroll the target into view,
  // then re-focus it on the next frame once it has mounted.
  const prevSelectedHash = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer + scrollEl are stable refs; the guard runs only on hash change
  useEffect(() => {
    // Gate on the hash actually CHANGING so list growth (Load more appends to
    // `commits`) never yanks the scroll back to a selected-but-offscreen commit.
    if (selectedCommitHash === prevSelectedHash.current) return;
    prevSelectedHash.current = selectedCommitHash;
    if (!selectedCommitHash) return;
    const idx = commits.findIndex((c) => c.hash === selectedCommitHash);
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: "auto" });
    // The row mounts after the scroll re-renders; re-focus it next frame so the
    // focus ring + SR position follow the selection. Guard: only when focus is
    // already inside the list, so we never steal it from the filter box.
    const raf = requestAnimationFrame(() => {
      if (!scrollEl?.contains(document.activeElement)) return;
      scrollEl
        .querySelector<HTMLElement>(
          `[data-hash="${CSS.escape(selectedCommitHash)}"]`,
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedCommitHash, commits]);

  return (
    <div
      className="relative w-full"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const commit = commits[vi.index];
        const index = vi.index;
        return (
          <button
            key={vi.key}
            type="button"
            data-index={index}
            ref={virtualizer.measureElement}
            data-hash={commit.hash}
            className={cn(
              "absolute top-0 left-0 flex w-full items-start gap-2 border-b px-3 py-2 text-left",
              selected.has(commit.hash) ||
                (selected.size === 0 && selectedCommitHash === commit.hash)
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/60",
            )}
            style={{ transform: `translateY(${vi.start}px)` }}
            onClick={(e) => onRowClick(e, index, commit.hash)}
            onMouseEnter={() => onHoverPrefetch(commit.hash)}
          >
            <CommitAuthorAvatar
              name={commit.author}
              email={commit.authorEmail}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <span className="min-w-0 truncate" title={commit.subject}>
                  {commit.subject}
                </span>
                {commit.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="flex max-w-24 shrink-0 items-center gap-0.5 border px-1 py-px text-[10px] font-normal text-muted-foreground"
                    title={`tag: ${tag}`}
                  >
                    <TagIcon className="size-2.5 shrink-0" />
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
                {commit.tags.length > 2 && (
                  <span
                    className="shrink-0 text-[10px] font-normal text-muted-foreground"
                    title={commit.tags.join(", ")}
                  >
                    +{commit.tags.length - 2}
                  </span>
                )}
                {unpushedHashes.has(commit.hash) && (
                  <span
                    className="ml-auto flex shrink-0 items-center text-muted-foreground"
                    title={
                      upstream
                        ? `Not pushed yet — ahead of ${upstream}`
                        : "Not pushed yet"
                    }
                    aria-label="Not pushed yet"
                  >
                    <ArrowUpIcon className="size-3" weight="bold" />
                  </span>
                )}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">{commit.author}</span>
                <span>•</span>
                <span className="shrink-0">
                  <RelativeTime date={commit.date} />
                </span>
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
