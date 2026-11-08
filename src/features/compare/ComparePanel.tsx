import {
  ArrowSquareOutIcon,
  FilesIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CompareBranchCombobox } from "@/features/compare/CompareBranchCombobox";
import {
  CompareFetchStatus,
  type CompareFetchStatusState,
} from "@/features/compare/CompareFetchStatus";
import {
  CREATE_PR_LABEL,
  comparePrTarget,
} from "@/features/compare/compare-pr-target";
import {
  displayCompareValue,
  GONE_PICK_COPY,
  recordPickRemote,
  remoteCompareRows,
  remoteCompareValue,
  resolvePick,
  UPDATING_COMPARISON_COPY,
  usePickRemote,
} from "@/features/compare/compare-remote-ref";
import {
  type CompareFetchPhase,
  useCompareRemoteFetch,
} from "@/features/compare/use-compare-remote-fetch";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  emptyPickerCopy,
  failedSinceLastSuccess,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { CommitContextMenuItems } from "@/features/history/CommitContextMenu";
import {
  CHERRY_PICK_ALREADY_APPLIED,
  checkoutCommitConfirm,
  checkoutCommitSuccessToast,
  cherryPickCommitConfirm,
  revertCommitConfirm,
} from "@/features/history/commit-confirms";
import {
  CreateRefFromCommitDialog,
  createRefFromCommitFormOpts,
  MergeParentDialog,
  type MergePickTarget,
} from "@/features/history/HistoryDialogs";
import { useAddUpstreamOffer } from "@/features/pulls/AddUpstreamOffer";
import { useCommitCommentsGate } from "@/features/pulls/CommitComments";
import {
  CreatePrDialog,
  type CreatePrPreset,
  duplicateOf,
} from "@/features/pulls/CreatePrDialog";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { branchNamePlaceholder } from "@/lib/ai/branch-prefixes";
import { suppressContextMenu } from "@/lib/context-menu";
import { presentError } from "@/lib/error-summary";
import { useAppForm } from "@/lib/form";
import {
  forgeFeatureReady,
  useBranches,
  useCheckoutCommit,
  useCherryPick,
  useCompareBranches,
  useCreateBranch,
  useCreateTag,
  useDefaultBranch,
  useForgeStatus,
  useHoverPrefetch,
  usePrefetchCommit,
  usePrsForBranch,
  useRemoteBranches,
  useRemotes,
  useRepoStatus,
  useRevertCommit,
} from "@/lib/git/queries";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { CommitSummary } from "@/lib/git/types";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useLensGate } from "@/lib/repo-lens/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import { useRetained } from "@/lib/use-retained";
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";

/** A shown stamp's phase as the status line's arm, by who asked for the
 *  fetch: a pick, or the add-upstream follow-up (which describes no pick). A
 *  finished fetch has none. */
const STAMP_STATE: Record<
  "pick" | "follow-up",
  Record<CompareFetchPhase, CompareFetchStatusState | null>
> = {
  pick: {
    fetching: "fetching",
    comparing: "updating",
    failed: "failed",
    offline: "offline",
    done: null,
  },
  "follow-up": {
    fetching: "upstream-fetching",
    // Only a pick's fetch re-reads its comparison.
    comparing: null,
    failed: "upstream-failed",
    offline: "upstream-offline",
    done: null,
  },
};

/** Why Create PR / Create local PR are held. Only a successful read that
 *  found nothing ahead may say there is nothing to propose. */
type CreateBlock =
  | "fetching"
  | "updating"
  | "pruned"
  | "remote-gone"
  | "missing"
  | "comparing"
  | "compare-failed"
  | "empty";

const CREATE_BLOCK_REASON: Record<
  CreateBlock,
  (c: {
    current: string;
    display: string;
    remote: string;
    pickRemote: string;
    pickName: string;
  }) => string
> = {
  fetching: ({ remote }) => `Fetching ${remote}…`,
  updating: () => UPDATING_COMPARISON_COPY,
  pruned: ({ pickRemote, pickName }) =>
    GONE_PICK_COPY.pruned(pickRemote, pickName),
  "remote-gone": ({ pickRemote, pickName }) =>
    GONE_PICK_COPY["remote-gone"](pickRemote, pickName),
  missing: ({ pickRemote, pickName }) =>
    GONE_PICK_COPY.missing(pickRemote, pickName),
  comparing: () => "Comparing…",
  "compare-failed": ({ display }) => `Couldn't compare with ${display}`,
  empty: ({ current, display }) =>
    `${current} has no commits to propose onto ${display}`,
};

const NO_PICK_COPY = "Pick a branch to compare against";

const OFFER_FAILED_COPY =
  "Couldn't check whether an upstream remote can be added.";

const OFFER_OFFLINE_COPY =
  "You're offline — whether an upstream remote can be added is checked once you're back online.";

const REMOTE_LOADING_COPY = "Loading remote branches…";

export function ComparePanel({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const branches = useBranches(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const gh = useForgeStatus(repoPath);
  const compareBranch = useUiStore((s) => s.compareBranch);
  const setCompareBranch = useUiStore((s) => s.setCompareBranch);
  const defaultCompareBranch = useUiStore((s) => s.defaultCompareBranch);
  const compareCommitHash = useUiStore((s) => s.compareCommitHash);
  const selectCompareCommit = useUiStore((s) => s.selectCompareCommit);
  const openLocalPrCreate = useUiStore((s) => s.openLocalPrCreate);
  const commentsGate = useCommitCommentsGate(repoPath);
  const prefetchCommit = usePrefetchCommit(repoPath, commentsGate);
  const hoverPrefetch = useHoverPrefetch();
  const onHoverCommit = (hash: string) =>
    hoverPrefetch(() => prefetchCommit(hash));
  const [prOpen, setPrOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  // Read after an await, where the render's `pickerOpen` is stale.
  const pickerOpenNow = useRef(false);
  function changePickerOpen(next: boolean) {
    pickerOpenNow.current = next;
    setPickerOpen(next);
  }

  const currentName = status.data?.branch?.name ?? null;
  const detached = status.data?.branch?.detached ?? false;
  // Opening a PR/MR follows the per-action create flag (GitHub + GitLab). The
  // "PRs for this branch" duplicate probe (`forge_prs_for_branch`) fires for any
  // provider whose PR reads are built, so an existing open PR/MR from this branch
  // flips the affordance to "View" instead of "Create".
  const prProbe = forgeFeatureReady(gh.data, "pullRequests");
  const isGitLab = gh.data?.provider === "gitlab";
  const prNoun = isGitLab ? "merge request" : "pull request";
  const lensGate = useLensGate(repoPath);
  // The ONE pick identity every consumer reads (fetch, PR routing and preset,
  // own-copy line, duplicate probe, gone/pruned hold and copy).
  const remotes = useRemotes(repoPath);
  const recordedRemote = usePickRemote(repoPath, compareBranch);
  const pick = resolvePick(compareBranch, remotes.data, recordedRemote);
  // A listed remote that names an unrecorded pick, or outranks a shorter
  // record, gets recorded: else the shorter split wins again once that remote
  // is removed. recordPickRemote refuses an unlisted (fallback) split.
  const resolvedRemote = pick?.remote ?? null;
  useEffect(() => {
    if (
      compareBranch !== null &&
      resolvedRemote !== null &&
      resolvedRemote !== recordedRemote
    )
      recordPickRemote(repoPath, compareBranch, remotes.data);
  }, [repoPath, compareBranch, recordedRemote, resolvedRemote, remotes.data]);
  // A remote pick is stored as its full ref; every user-facing string shows it
  // as `remote/name`.
  const compareDisplay =
    compareBranch === null ? null : displayCompareValue(compareBranch);
  // Agent-session branches (`gd/session/*`) are app-internal — never offer them
  // as a compare target (the PR button would even push one), like BranchSwitcher.
  // Archived branches are hidden here too, matching BranchSwitcher (they were
  // archived to get them out of the way); archiving a branch that was the
  // compare target auto-falls-back via the default effect below.
  const otherBranches = (branches.data ?? []).filter(
    (b) => !b.isCurrent && !b.name.startsWith("gd/session/") && !b.archived,
  );
  // Read while the picker is open, while a remote pick is current (its pruned
  // check needs a live list), and while no local branch is offered (the empty
  // state must know whether remotes exist).
  const remoteRead = useRemoteBranches(
    repoPath,
    pickerOpen || pick !== null || otherBranches.length === 0,
  );
  // Rows wait for the remotes list: a remote whose name holds "/" splits only
  // against it. A failed read with no data leaves the backend's first-slash
  // split, the only one left, held through its retry polls so the rows don't
  // blink with each one.
  const remotesKnown =
    remotes.data !== undefined || failedSinceLastSuccess(remotes);
  const remoteRows = remotesKnown
    ? remoteCompareRows(
        remoteRead.data,
        new Set(otherBranches.map((b) => b.name)),
        remotes.data,
      )
    : [];
  const offer = useAddUpstreamOffer(repoPath);
  const fetcher = useCompareRemoteFetch(
    repoPath,
    compareBranch,
    pick?.remote ?? null,
  );
  const head = status.data?.branch;
  const prTarget = comparePrTarget({
    value: compareBranch ?? "",
    pick,
    currentName: currentName ?? "",
    lensGate,
    upstreamRemote: head?.upstreamRemote ?? null,
    upstreamBranch: head?.upstreamBranch ?? null,
  });
  // The duplicate probe reads the lens the pick maps to (origin for a local
  // base or the fork, upstream for the parent); an unmapped pick reads none.
  const probeLens = prTarget.probeLens;
  const branchPrs = usePrsForBranch(
    repoPath,
    currentName,
    prProbe && probeLens !== null,
    probeLens ?? "origin",
  );
  const fromCommitPlaceholder = useMemo(
    () =>
      branchNamePlaceholder(
        (branches.data ?? []).map((b) => b.name),
        { sample: "from-commit" },
      ),
    [branches.data],
  );
  // Fallback when the default branch isn't offered: the most recently committed
  // other branch — the same row the picker surfaces first, so the auto-pick
  // matches the top of the list the user sees (not raw git ref order).
  const firstOther = otherBranches.length
    ? otherBranches.reduce((a, b) =>
        b.lastCommitDate > a.lastCommitDate ? b : a,
      ).name
    : null;
  // A remote pick never yields to the auto-default: a pruned one keeps its
  // pick and the status line says so.
  const compareValid =
    compareBranch !== null &&
    (pick !== null || otherBranches.some((b) => b.name === compareBranch));
  const defaultName = defaultBranch.data ?? null;
  // Only pick the default branch when it's actually offered: an archived default
  // must fall back to `firstOther`, else `compareValid` stays false forever and
  // the effect keeps firing a no-op set. Stable primitive for the effect deps.
  const defaultOffered = otherBranches.some((b) => b.name === defaultName);

  // Default the comparison to the default branch (when offered), else the first
  // other branch. An automatic correction (also after a refetch drops the target),
  // so it rides the non-bumping setter; the user's pick below keeps the bump.
  useEffect(() => {
    if (firstOther === null || compareValid) return;
    defaultCompareBranch(
      defaultOffered && defaultName ? defaultName : firstOther,
    );
  }, [
    firstOther,
    compareValid,
    defaultOffered,
    defaultName,
    defaultCompareBranch,
  ]);

  const comparison = useCompareBranches(repoPath, compareBranch, currentName);

  const ahead = comparison.data?.ahead ?? [];
  const behind = comparison.data?.behind ?? [];
  const canPr = forgeFeatureReady(gh.data, "mrCreate");
  // An open PR from the current branch into the compared branch already exists,
  // matched on the bare base in the probe's lens (the dialog's own rule).
  const existingPr =
    probeLens === null
      ? undefined
      : duplicateOf(branchPrs.data, prTarget.base, probeLens);
  const createLabel = CREATE_PR_LABEL[prTarget.kind];
  const showCreate = Boolean(
    canPr && compareBranch && createLabel && !existingPr,
  );
  const showLocalPr = Boolean(
    compareBranch && compareBranch !== currentName && prTarget.showLocalPr,
  );

  // The current pick's own fetch: dims the lists and holds Create. The
  // add-upstream follow-up changes no pick.
  const stamp = fetcher.stamp;
  const stampShown =
    stamp !== null &&
    stamp.repoPath === repoPath &&
    (stamp.pickedValue === null || stamp.pickedValue === compareBranch);
  const listsBusy =
    stampShown &&
    (stamp.phase === "fetching" || stamp.phase === "comparing") &&
    stamp.pickedValue !== null;
  // Gone is read from a successful remotes read alone, so it holds while the
  // remote-branch list is failed or refetching; pruned only from a settled
  // successful list, matched on the full ref no split can break.
  const remoteGone =
    pick !== null && remotes.isSuccess && !remotes.data.includes(pick.remote);
  // "Deleted on X" only while a successful remotes read still lists X;
  // otherwise the cause is unknown and the line names none.
  const prunedState = ((): "remote-gone" | "pruned" | "missing" => {
    if (remoteGone) return "remote-gone";
    return pick !== null &&
      remotes.isSuccess &&
      remotes.data.includes(pick.remote)
      ? "pruned"
      : "missing";
  })();
  const pruned =
    pick !== null &&
    remoteRead.isSuccess &&
    !remoteRead.isFetching &&
    !remoteRead.data.some(
      (b) => remoteCompareValue(b.remote, b.name) === compareBranch,
    );
  const goneOrPruned = remoteGone || pruned;
  // The pick's post-fetch read failed and nothing newer has answered: the
  // cached comparison predates the fetch, so it can't decide Create. Any later
  // success clears `isError` (a refetch in flight keeps it), whatever the clock.
  const failedRead = fetcher.failedRead;
  const staleAfterFetch =
    failedRead !== null &&
    failedRead.repoPath === repoPath &&
    failedRead.pickedValue === compareBranch &&
    failedRead.currentBranch === currentName &&
    comparison.isError &&
    comparison.dataUpdatedAt <= failedRead.over;
  // A pruned or gone pick holds even while a running fetch's line outranks its
  // line: the ref a PR would target is gone either way.
  const createBlock = ((): CreateBlock | null => {
    if (listsBusy)
      return stamp?.phase === "comparing" ? "updating" : "fetching";
    if (goneOrPruned) return prunedState;
    if (staleAfterFetch) return "compare-failed";
    if (comparison.data === undefined)
      return comparison.isError ? "compare-failed" : "comparing";
    return comparison.data.ahead.length === 0 ? "empty" : null;
  })();
  const createReason =
    createBlock === null
      ? ""
      : CREATE_BLOCK_REASON[createBlock]({
          current: currentName ?? "",
          display: compareDisplay ?? "",
          remote: stamp?.remote ?? "",
          pickRemote: pick?.remote ?? "",
          pickName: pick?.name ?? "",
        });

  // An open dialog keeps the preset it opened with: a lens-gate flip or a branch
  // switch re-deriving the kind must not unmount or re-preset it mid-edit (the
  // dialog still derives its effective target from the live gate). The
  // latch outlives the close (exit animation, a generation still running) until
  // the next open re-derives it or the repo changes.
  const [prLatch, setPrLatch] = useState<{
    repo: string;
    defaultBase: string | undefined;
    preset: CreatePrPreset | undefined;
  } | null>(null);
  // This panel survives repo switches, so the dialog closes in the render that
  // switches: left open, the next repo's auto-default would remount it open.
  const [prRepo, setPrRepo] = useState(repoPath);
  if (prRepo !== repoPath) {
    setPrRepo(repoPath);
    setPrOpen(false);
    setPrLatch(null);
  }
  const latched = prLatch?.repo === repoPath ? prLatch : null;
  const prDialogProps = latched ?? {
    defaultBase: prTarget.defaultBase,
    preset: prTarget.preset ?? undefined,
  };
  function openCreatePr() {
    setPrLatch({
      repo: repoPath,
      defaultBase: prTarget.defaultBase,
      preset: prTarget.preset ?? undefined,
    });
    setPrOpen(true);
  }

  useHotkeyAction(
    "create-pr",
    openCreatePr,
    showCreate && createBlock === null,
  );
  useHotkeyAction(
    "create-local-pr",
    () =>
      openLocalPrCreate({
        defaultHead: currentName ?? undefined,
        defaultBase: compareBranch ?? undefined,
      }),
    showLocalPr && createBlock === null,
  );

  // The status line paints a stamp only in its own repo and while its pick is
  // still the current one.
  const stampState = stampShown
    ? STAMP_STATE[stamp.pickedValue === null ? "follow-up" : "pick"][
        stamp.phase
      ]
    : null;
  // The gone or pruned line outranks a failed or parked pick's line, whose "its
  // last fetch" no longer exists, so it names the cause Create's hold names. A
  // running fetch's line and the follow-up's lines still outrank it.
  const prunedShown =
    goneOrPruned &&
    (stampState === null ||
      stampState === "failed" ||
      stampState === "offline");
  const fetchState = prunedShown ? prunedState : stampState;
  // A parked pick's line promises the reconnect fetch, which fetches the pick's
  // remote as it resolves now; the other stamp lines name the attempt that ran.
  const statusRemote =
    prunedShown || stampState === "offline"
      ? (pick?.remote ?? "")
      : (stamp?.remote ?? "");
  // The pruned line already names the cause; a Retry beside it can't succeed.
  const comparisonRefreshFailed =
    refreshFailed(comparison) && comparison.data !== undefined && !prunedShown;
  // Settled only by a successful read and a known remotes list: until then the
  // popup says so, and its empty copy claims nothing about remote branches.
  const remoteNotice = (() => {
    if (!remoteRead.isSuccess)
      return emptyPickerCopy(remoteRead, {
        noun: "remote branches",
        // Cached rows still list above the line, so a failure is a refresh's.
        loadFailed:
          remoteRead.data === undefined
            ? "Couldn't load remote branches."
            : "Couldn't refresh remote branches — showing the last loaded results.",
        empty: "",
        loading: REMOTE_LOADING_COPY,
      });
    return remotesKnown ? null : REMOTE_LOADING_COPY;
  })();
  // No local branch to default to and nothing picked yet: a resting prompt,
  // never a skeleton for a read that isn't running.
  const noPick = compareBranch === null && firstOther === null;

  function pickCompare(stored: string) {
    fetcher.clearFollowUp();
    setCompareBranch(stored);
    const remotePick = recordPickRemote(repoPath, stored, remotes.data);
    if (remotePick && currentName)
      void fetcher.fire({
        repo: repoPath,
        remote: remotePick.remote,
        pickedValue: stored,
        currentBranch: currentName,
      });
  }

  function retryFetch() {
    if (!stampShown) return;
    void fetcher.fire({
      repo: repoPath,
      // A pick's retry fetches its identity as it reads now, which a remotes
      // list that arrived since the first fetch may have corrected.
      remote:
        stamp.pickedValue !== null && pick !== null
          ? pick.remote
          : stamp.remote,
      pickedValue: stamp.pickedValue,
      currentBranch: currentName,
    });
  }

  // The user's own press: focus the trigger first so the popup's close returns
  // focus there rather than to this action, which the new pick unmounts.
  function pickAnotherBranch() {
    pickerTrigger.current?.focus();
    changePickerOpen(true);
  }

  // Adds the remote, then fetches it with no pick change, only while the user
  // is still in the repo the add started in (read live after the await).
  async function addUpstreamRemote() {
    const addIn = repoPath;
    const { ok } = await offer.addUpstream();
    if (!ok || useUiStore.getState().repoPath !== addIn) return;
    // The row unmounts once the remote lands and the popup would highlight the
    // next one, so a repeated Enter would pick an unrelated branch.
    if (pickerOpenNow.current) {
      pickerTrigger.current?.focus();
      changePickerOpen(false);
    }
    void fetcher.fire({
      repo: addIn,
      remote: "upstream",
      pickedValue: null,
      currentBranch: currentName,
    });
  }

  // With nothing to compare against locally, the empty state waits on the
  // remote read and the add-upstream offer's inputs: only answers may say there
  // is nothing at all. A retained remote pick keeps the main panel, so its
  // pruned line still names why the list emptied.
  const emptyCandidate =
    pick === null &&
    otherBranches.length === 0 &&
    remoteRows.length === 0 &&
    !offer.canOffer;
  const remoteReadFailed = remoteRead.isError && !remoteRead.isFetching;
  // Offline, an offer failed on the forge read alone waits for the reconnect
  // that re-runs it instead of offering a Retry that can't succeed; a failed
  // local read keeps its Retry.
  const online = useOnline();
  const offerWaitsOnline = !online && offer.failedOnForgeOnly;
  const emptyRetryShown =
    remoteReadFailed || (offer.failed && !offerWaitsOnline);
  const emptyRescue = useRetryFocusRescue(emptyCandidate && emptyRetryShown);
  // One focus host across every arm below (same element type and position), so
  // a Retry whose refetch swaps the arm never drops focus to <body>.
  const shell = (children: ReactNode) => (
    <div
      ref={emptyRescue.hostRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      {children}
    </div>
  );

  // The commit the one shared context menu acts on. Revert is only OFFERED for
  // ahead commits — the side already in this branch's history.
  const [menuTarget, setMenuTarget] = useState<{
    hash: string;
    onCurrentBranch: boolean;
    isMerge: boolean;
  } | null>(null);
  // A merge commit's revert or cherry-pick, awaiting its mainline parent.
  const [mergePick, setMergePick] = useState<
    (MergePickTarget & { repo: string }) | null
  >(null);
  const [branchHash, setBranchHash] = useState<string | null>(null);
  const [tagHash, setTagHash] = useState<string | null>(null);
  const shownBranchHash = useRetained(branchHash);
  const shownTagHash = useRetained(tagHash);

  const checkoutCommit = useCheckoutCommit(repoPath);
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const createBranch = useCreateBranch(repoPath);
  const createTag = useCreateTag(repoPath);

  const onError = (e: unknown) => toastError(e);

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
      try {
        await createBranch.mutateAsync({
          name,
          checkout: true,
          startPoint: branchHash,
        });
        toast.success(`Created branch ${name}`);
        setBranchHash(null);
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
      try {
        await createTag.mutateAsync({ name, hash: tagHash });
        toast.success(`Created tag ${name}`);
        setTagHash(null);
      } catch (e) {
        onError(e);
      }
    },
  });

  // The commit-level confirms are the shared ones History asks, so no route can
  // pose a different question than its twin.
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
    try {
      await revertCommit.mutateAsync({ hash });
    } catch (e) {
      onError(e);
    }
  }

  async function doCherryPick(hash: string, isMerge: boolean) {
    if (isMerge) {
      setMergePick({ hash, op: "cherry-pick", repo: repoPath });
      return;
    }
    const pickIn = repoPath;
    const ok = await useConfirm
      .getState()
      .ask(cherryPickCommitConfirm(hash, currentName));
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
      toast.info(CHERRY_PICK_ALREADY_APPLIED);
    }
  }

  // One shared context menu for both lists (capture phase, so it records the
  // right-clicked row before the menu opens). Right-clicking a commit selects it
  // (standard desktop behavior), so the menu and the diff panel always describe
  // the same commit; non-commit targets (the "All changes" row, headers, blank
  // space) get no menu.
  function handleContextMenu(e: MouseEvent) {
    const suppress = () => {
      setMenuTarget(null);
      suppressContextMenu(e);
    };
    const hash = (e.target as HTMLElement)
      .closest("[data-row]")
      ?.getAttribute("data-row");
    if (!hash) return suppress();
    const aheadCommit = ahead.find((c) => c.hash === hash);
    const commit = aheadCommit ?? behind.find((c) => c.hash === hash);
    if (!commit) return suppress();
    selectCompareCommit(hash);
    setMenuTarget({
      hash,
      onCurrentBranch: aheadCommit !== undefined,
      isMerge: commit.isMerge,
    });
  }

  if (status.isPending || branches.isPending)
    return shell(
      <div className="space-y-2 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>,
    );

  if (detached || !currentName) {
    return shell(
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>You're on a detached HEAD</EmptyTitle>
          <EmptyDescription>
            Compare needs a checked-out branch. Switch to a branch to see how it
            differs from another.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchAction("show-branches")}
          >
            <GitBranchIcon data-icon="inline-start" />
            Switch branch…
          </Button>
        </EmptyContent>
      </Empty>,
    );
  }
  if (
    emptyCandidate &&
    (!remoteRead.isSuccess || !remotesKnown || !offer.settled)
  ) {
    return shell(
      <>
        {remoteReadFailed || offer.failed ? (
          <div className="flex flex-col items-center gap-2 p-4">
            <p className="text-center text-xs text-muted-foreground">
              {(() => {
                if (remoteReadFailed)
                  return presentError(remoteRead.error).summary;
                return offerWaitsOnline
                  ? OFFER_OFFLINE_COPY
                  : OFFER_FAILED_COPY;
              })()}
            </p>
            {emptyRetryShown && (
              <Button
                ref={emptyRescue.retryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => {
                  if (remoteReadFailed) void remoteRead.refetch();
                  if (offer.failed) offer.retry();
                }}
              >
                Retry
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </>,
    );
  }
  if (emptyCandidate) {
    return shell(
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>No other branches</EmptyTitle>
          <EmptyDescription>
            Compare shows how <span className="font-mono">{currentName}</span>{" "}
            diverges from another branch. Create a branch to have something to
            compare against.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchAction("new-branch")}
          >
            <GitBranchIcon data-icon="inline-start" />
            New branch…
          </Button>
        </EmptyContent>
      </Empty>,
    );
  }

  // Arrow keys walk "All changes" → ahead → behind, mirroring the list.
  const navTargets: (string | null)[] = [
    null,
    ...ahead.map((c) => c.hash),
    ...behind.map((c) => c.hash),
  ];

  const onListKeyDown = listKeyboardNav({
    items: navTargets,
    activeIndex: navTargets.indexOf(compareCommitHash),
    onActivate: (target) => selectCompareCommit(target),
    rowKey: (target) => target ?? "all",
  });

  return shell(
    <>
      <div className="space-y-1.5 border-b p-2">
        <p className="px-1 text-xs text-muted-foreground">
          Compare <span className="font-mono">{currentName}</span> with
        </p>
        {/* The status line sits outside the space-y flow: idle, it is sr-only
            and must add no gap under the picker. */}
        <div>
          <CompareBranchCombobox
            repoPath={repoPath}
            branches={otherBranches}
            remoteRows={remoteRows}
            addUpstream={
              offer.canOffer && offer.forkParent
                ? {
                    forkParent: offer.forkParent,
                    busy: offer.pending,
                    onAdd: () => void addUpstreamRemote(),
                  }
                : null
            }
            currentName={currentName}
            defaultName={defaultName}
            value={compareBranch}
            onValueChange={pickCompare}
            open={pickerOpen}
            onOpenChange={changePickerOpen}
            triggerRef={pickerTrigger}
            placeholder={noPick ? NO_PICK_COPY : null}
            remoteNotice={remoteNotice}
            remoteSearched={remotesKnown && remoteRead.data !== undefined}
          />
          <CompareFetchStatus
            state={fetchState}
            remote={statusRemote}
            name={pick?.name ?? ""}
            onRetry={retryFetch}
            onPickAnother={pickAnotherBranch}
            idleFocusRef={pickerTrigger}
          />
        </div>
        {prTarget.ownCopyLine && (
          <p className="px-1 text-[11px] text-muted-foreground">
            Comparing with your branch on {pick?.remote}: ahead = not pushed,
            behind = not pulled.
          </p>
        )}
        {canPr && compareBranch && existingPr && (
          <Button
            variant="outline"
            size="sm"
            className="w-full cursor-pointer"
            onClick={() => openUrl(existingPr.url)}
            title={existingPr.title}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            View {prNoun} #{existingPr.number}
            {existingPr.isDraft ? " (draft)" : ""}
          </Button>
        )}
        {showCreate && (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            wrapperClassName="w-full"
            className="w-full"
            disabled={createBlock !== null}
            reason={createReason}
            title={`Open a ${prNoun} into ${compareDisplay}`}
            onClick={openCreatePr}
          >
            <GitPullRequestIcon data-icon="inline-start" />
            {createLabel?.(prNoun)}
          </DisabledReasonButton>
        )}
        {showLocalPr && (
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            wrapperClassName="w-full"
            className="w-full"
            disabled={createBlock !== null}
            reason={createReason}
            title={`Propose merging ${currentName} into ${compareDisplay} locally`}
            onClick={() =>
              openLocalPrCreate({
                defaultHead: currentName ?? undefined,
                defaultBase: compareBranch ?? undefined,
              })
            }
          >
            <GitBranchIcon data-icon="inline-start" />
            Create local PR…
          </DisabledReasonButton>
        )}
      </div>

      {/* A loaded comparison stays under this notice when a refresh fails. */}
      <DegradedListNotice
        noun="this comparison"
        degraded={comparisonRefreshFailed}
        onRetry={() => void comparison.refetch()}
        className="shrink-0 border-b py-1.5"
      />

      {/* A remote pick passes the BARE base: a full ref would reseed the
          dialog's fork reconcile onto "refs/remotes/…". */}
      {(showCreate || latched !== null) && (
        <CreatePrDialog
          repoPath={repoPath}
          defaultBase={prDialogProps.defaultBase}
          defaultHead={currentName}
          preset={prDialogProps.preset}
          open={prOpen}
          onOpenChange={setPrOpen}
        />
      )}

      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className="flex min-h-0 flex-1 flex-col"
              onKeyDown={onListKeyDown}
              role="listbox"
              aria-label="Compare selection"
              aria-busy={listsBusy}
              onContextMenuCapture={handleContextMenu}
            />
          }
        >
          <button
            type="button"
            data-row="all"
            role="option"
            aria-selected={compareCommitHash === null}
            className={cn(
              "flex w-full shrink-0 items-center gap-2 border-b px-3 py-2 text-left text-xs",
              compareCommitHash === null
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/60",
            )}
            onClick={() => selectCompareCommit(null)}
          >
            <FilesIcon className="size-3.5 shrink-0" />
            <span className="font-medium">All changes</span>
          </button>

          {noPick && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {NO_PICK_COPY}
            </p>
          )}
          {!noPick && comparison.isPending && (
            <ListRowSkeletons rows={2} lines={2} name="commits" />
          )}
          {!noPick && !comparison.isPending && (
            /* overflow-hidden contains the list's natural height (vendored Root
               is `relative`-only) so a long list can't leak a window scrollbar. */
            <ScrollArea
              className={cn(
                "min-h-0 flex-1 overflow-hidden",
                PLACEHOLDER_FADE,
                listsBusy && "opacity-80",
              )}
            >
              {/* Nothing loaded and the read failed: say why, unless the
                  pruned line already does. */}
              {comparison.isError &&
                comparison.data === undefined &&
                !prunedShown && (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {presentError(comparison.error).summary}
                  </p>
                )}
              <CommitSection
                title={`${ahead.length} ahead`}
                subtitle={`on ${currentName}, not on ${compareDisplay}`}
                commits={ahead}
                selectedHash={compareCommitHash}
                onSelect={selectCompareCommit}
                onHover={onHoverCommit}
              />
              <CommitSection
                title={`${behind.length} behind`}
                subtitle={`on ${compareDisplay}, not on ${currentName}`}
                commits={behind}
                selectedHash={compareCommitHash}
                onSelect={selectCompareCommit}
                onHover={onHoverCommit}
              />
              {/* Only a successful read may claim the pair is even. */}
              {comparison.isSuccess &&
                ahead.length === 0 &&
                behind.length === 0 && (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    These branches are even.
                  </p>
                )}
            </ScrollArea>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-60">
          {menuTarget && (
            <CommitContextMenuItems
              hash={menuTarget.hash}
              actions={{
                checkout: doCheckoutCommit,
                revert: menuTarget.onCurrentBranch
                  ? (hash) => doRevertCommit(hash, menuTarget.isMerge)
                  : undefined,
                cherryPick: (hash) => doCherryPick(hash, menuTarget.isMerge),
                createBranch: (hash) => {
                  branchForm.reset({ name: "" });
                  setBranchHash(hash);
                },
                createTag: (hash) => {
                  tagForm.reset({ name: "" });
                  setTagHash(hash);
                },
              }}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>

      <CreateRefFromCommitDialog
        form={branchForm}
        open={branchHash !== null}
        onClose={() => setBranchHash(null)}
        title="Create branch from commit"
        description={`Creates a branch starting at ${shownBranchHash?.slice(0, 7) ?? ""} and switches to it.`}
        fieldLabel="Branch name"
        placeholder={fromCommitPlaceholder}
        submitLabel="Create branch"
      />

      <CreateRefFromCommitDialog
        form={tagForm}
        open={tagHash !== null}
        onClose={() => setTagHash(null)}
        title="Create tag"
        description={`Tags commit ${shownTagHash?.slice(0, 7) ?? ""}.`}
        fieldLabel="Tag name"
        placeholder="v1.0.0"
        submitLabel="Create tag"
      />

      <MergeParentDialog
        repoPath={repoPath}
        target={mergePick}
        openedIn={mergePick?.repo ?? null}
        onClose={() => setMergePick(null)}
      />
    </>,
  );
}

function CommitSection({
  title,
  subtitle,
  commits,
  selectedHash,
  onSelect,
  onHover,
}: {
  title: string;
  subtitle: string;
  commits: CommitSummary[];
  selectedHash: string | null;
  onSelect: (hash: string) => void;
  onHover: (hash: string) => void;
}) {
  if (commits.length === 0) return null;
  return (
    <div>
      <div className="sticky top-0 bg-muted/50 px-3 py-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      {commits.map((commit) => (
        <button
          type="button"
          key={commit.hash}
          data-row={commit.hash}
          role="option"
          aria-selected={selectedHash === commit.hash}
          className={cn(
            "block w-full border-b px-3 py-2 text-left",
            selectedHash === commit.hash
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted/60",
          )}
          onClick={() => onSelect(commit.hash)}
          onMouseEnter={() => onHover(commit.hash)}
        >
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <GitCommitIcon className="size-3 shrink-0 text-muted-foreground" />
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
          </p>
          <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
            {commit.author} • <RelativeTime date={commit.date} />
          </p>
        </button>
      ))}
    </div>
  );
}
