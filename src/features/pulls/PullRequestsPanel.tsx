import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  ClockIcon,
  GitPullRequestIcon,
  ProhibitIcon,
  StackSimpleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SessionExpiryNotice } from "@/features/accounts/SessionExpiryNotice";
import { ConversationFilterPopover } from "@/features/conversations/ConversationFilterPopover";
import { ConversationListPanel } from "@/features/conversations/ConversationListPanel";
import { ConversationPresetSwitcher } from "@/features/conversations/ConversationPresetSwitcher";
import { PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import { RepoLensSwitcher } from "@/features/conversations/RepoLensSwitcher";
import {
  type ReviewGroupKind,
  useCollapsedSections,
} from "@/features/conversations/useCollapsedSections";
import { useLocalRemoteFilter } from "@/features/conversations/useLocalRemoteFilter";
import {
  gitlabAxisCap,
  useRemoteListFilter,
} from "@/features/conversations/useRemoteListFilter";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import type { PrStateFilter } from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import {
  forgeFeatureReady,
  keepPreviousDataForKeyAxes,
  prDetailsOptions,
  repoKeys,
  useForgeStatus,
  useHoverPrefetch,
  usePrefetchPr,
  usePrList,
  usePrListCi,
  usePrListMergeability,
  usePrReviewState,
} from "@/lib/git/queries";
import { providerLabel, type ReviewStateEntry } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { type LocalPrStatus, reloadLocalPrs } from "@/lib/pulls/local";
import {
  localPrKey,
  useDeleteLocalPr,
  useLocalPrs,
  useUpdateLocalPr,
} from "@/lib/pulls/queries";
import { useLensState, useRemoteSlug } from "@/lib/repo-lens/queries";
import {
  containedHolds,
  containedHoldsKey,
  settlePrCreateIfCurrent,
  usePrCreates,
} from "@/lib/stores/pr-create";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { CreatePrDialog } from "./CreatePrDialog";
import { LocalPrContextMenu } from "./LocalPrContextMenu";
import { PendingPrRow } from "./PendingPrRow";
import { useReconcileLocalPrs } from "./useReconcileLocalPrs";

/** The review-state subsections, in the order a triage pass wants them. */
const REVIEW_GROUPS: {
  kind: ReviewGroupKind;
  label: string;
  title?: string;
}[] = [
  { kind: "not-reviewed", label: "Not reviewed yet" },
  {
    kind: "updated",
    label: "Updated since my review",
    title: "Any activity after your last review — commits, comments, labels",
  },
  { kind: "reviewed", label: "Reviewed" },
];

/** How the list chases a held row the forge hasn't listed yet. The limit bounds
 *  ONE chase, not the tab: a server-side filter may genuinely never show the PR,
 *  and an unbounded poll would spend API budget on that case forever, while a
 *  new hold identity or the toolbar's refresh re-arms a full ladder. */
const HOLD_POLL_MS = 5_000;
const HOLD_POLL_LIMIT = 8;

/** Why the list is flat despite the grouping toggle being on. */
const UNGROUPED_NOTE = {
  error: "Couldn't load your review state — the list is ungrouped.",
  truncated: "Couldn't check every review — the list is ungrouped.",
} as const;

/** Which tab a local PR's status belongs on — the Closed tab covers merged and
 *  closed alike. Total over {@link LocalPrStatus}, so a new status has to be
 *  classified here rather than silently reading as open. */
const LOCAL_ALIGN_TAB: Record<LocalPrStatus, PrStateFilter> = {
  open: "open",
  merged: "closed",
  closed: "closed",
};

/** The saved team filter couldn't be validated, so the list ran without it — a
 *  WIDER scope than the one saved, which the rows themselves can't show. */
const TEAM_SCOPE_DROPPED_NOTE =
  "Couldn't check your team filter — showing results without it.";

/** Which subsection a PR belongs to. A number the backend didn't answer for is
 *  absent from `entries` and reads as not reviewed. Both timestamps are ISO-8601
 *  UTC, so a string compare orders them. */
function reviewBucket(
  number: number,
  entries: Record<number, ReviewStateEntry>,
): ReviewGroupKind {
  const entry = entries[number];
  if (!entry) return "not-reviewed";
  return entry.updatedAt > entry.lastReviewedAt ? "updated" : "reviewed";
}

export function PullRequestsPanel({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  const provider = gh.data?.provider;
  // Merge request reads work for GitHub and GitLab; the noun + section header
  // follow the provider so a GitLab repo reads "merge requests" / "GitLab".
  const isGitLab = provider === "gitlab";
  // The origin|upstream lens (GitHub forks only; "origin" everywhere else). It
  // decides which repo the remote PR list + every PR read/write below target.
  // One call for both: each input behind the lens is async, so a fork's lens starts out
  // provisionally "origin", and the value and its settledness must come from one read.
  const { lens, settled: lensSettled } = useLensState(repoPath);
  // When browsing the parent, the section header names the parent slug (whose
  // data this is) — falling back to "Upstream" while the slug loads.
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", lens === "upstream");
  const providerName = providerLabel(provider);
  const remoteLabel =
    lens === "upstream" ? (upstreamSlug ?? "Upstream") : providerName;
  const remoteNoun = isGitLab ? "merge requests" : "pull requests";
  const ghReady = forgeFeatureReady(gh.data, "pullRequests");
  // The provider's own capabilities, read separately from `forgeFeatureReady` so a
  // not-yet-connected repo never gets told its PROVIDER lacks an axis it has.
  const implemented = gh.data?.implemented;
  const canFilterMine = forgeFeatureReady(gh.data, "listFilterMine");
  const canFilterTeam = forgeFeatureReady(gh.data, "listFilterTeam");
  const canFilterAuthor = forgeFeatureReady(gh.data, "listFilterAuthor");
  // Borrowed from the label-editing flag: Bitbucket PRs have no labels at all, so
  // there is nothing for the forge to filter by — the pick runs client-side there.
  const canFilterLabel = forgeFeatureReady(gh.data, "mrLabels");
  const canGroupByReview = forgeFeatureReady(gh.data, "reviewGrouping");
  // "closed" matches the Closed tab: closed and merged alike.
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("open");
  // How many remote PRs to load; "Load more" bumps it. A tab switch (open/closed)
  // resets to the first page.
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Read once, high: three gates below key off it (team membership, mergeability,
  // review state) — every network read this panel owns beyond the list itself.
  const repoTab = useUiStore((s) => s.repoTab);
  const onPullsTab = repoTab === "pulls";
  const listFilter = useRemoteListFilter({
    repoPath,
    feature: "pulls",
    lens,
    canFilterMine,
    canFilterTeam,
    canFilterAuthor,
    canFilterLabel,
    canGroupByReview,
    tabActive: onPullsTab,
  });
  // Bounded self-heal for a held row the forge's list hasn't caught up to. The
  // interval is decided below, once containment is known — that read comes from
  // this query, so it is one render behind by construction. Rungs live in a ref
  // because the ladder is advanced from an effect and a render read of mutable
  // state goes stale under the compiler; `holdPollMs` is the render-visible
  // mirror the query's options read.
  const [holdPollMs, setHoldPollMs] = useState<number | false>(false);
  const holdPolls = useRef(0);
  const holdLadderFor = useRef("");
  const holdSeen = useRef({ ok: 0, failed: 0 });
  // Exempts the NEXT completion from spending a rung, for the two reads the
  // armed poll didn't cause: an explicit refresh, and a fetch already in flight
  // when a new hold identity resets the ladder.
  const holdExemptNext = useRef(false);
  // Scope for the row-focus rescue below: every query it makes runs inside this
  // panel, never the document.
  const panelRef = useRef<HTMLDivElement>(null);
  // `scopeReady` in the gate: a repo with a stored filter would otherwise fetch
  // once under a DIFFERENT scope and again under the saved one — unfiltered before
  // the prefs land, or whole-repo before a saved team choice validates. The wait is
  // covered by the same skeletons a cold load already shows (a held query reports
  // `isPending`, which is what `listPending` below renders), and the gate always
  // opens — see the hook's note on why neither leg can wedge.
  const prList = usePrList(
    repoPath,
    ghReady && listFilter.scopeReady,
    stateFilter,
    limit,
    lens,
    listFilter.filter,
    holdPollMs,
  );
  // Row CI icons hydrate separately from the list, so the list paints immediately; the
  // backend routes GitHub/GitLab/Bitbucket, so `ghReady` is the readiness gate. Idle
  // while the list serves placeholder rows (tab switch or Load more): otherwise the
  // intermediate key caches a map fetched against rows that are about to be replaced,
  // and that cached map becomes the placeholder source for the next key.
  const prListCi = usePrListCi(
    repoPath,
    ghReady && !prList.isPlaceholderData,
    stateFilter,
    limit,
    prList.data,
    lens,
  );
  const ciMap = prListCi.data;
  // Row conflict chips. The extra gates are load-bearing on top of `ghReady`: this call
  // takes seconds on large GitHub repos and every active forge query joins the commit
  // mutation's awaited invalidation set, so it must be idle off this tab and off the
  // Closed tab, where no row has live mergeability to report.
  // `!isPlaceholderData` covers the first half of a tab switch or Load more: while
  // the LIST is still serving placeholder rows, this stays idle rather than describing
  // a page that isn't on screen. None of these gates stop a chip on their own, though —
  // a DISABLED query still renders placeholder data, so keeping the previous tab's or
  // lens's map off these rows is the hook's placeholder comparator's job.
  // PR numbers repeat across states and repos, so a misplaced chip is a wrong claim.
  const prListMergeability = usePrListMergeability(
    repoPath,
    ghReady &&
      repoTab === "pulls" &&
      stateFilter === "open" &&
      !prList.isPlaceholderData,
    stateFilter,
    limit,
    prList.data,
    lens,
    listFilter.filter,
  );
  const mergeMap = prListMergeability.data;
  // The viewer's review timestamps, only while the grouping is actually on (the
  // caller contract on the hook). `groupByReview` already carries the provider
  // gate, but the contract names it, so it stays visible at the call site.
  // `repoTab` mirrors the mergeability gate above: a hidden <Activity> panel
  // still refetches, and this query is a multi-page search walk.
  const reviewState = usePrReviewState(
    repoPath,
    ghReady &&
      repoTab === "pulls" &&
      listFilter.groupByReview &&
      canGroupByReview &&
      stateFilter === "open" &&
      !prList.isPlaceholderData,
    stateFilter,
    limit,
    lens,
    listFilter.filter,
  );
  // A pending align is one-shot and this is the single door to `stateFilter`, so
  // an explicit tab pick retires it — the user's choice outranks it, and the align
  // itself is already done with the intent when it comes through here.
  const pendingPrAlign = useUiStore((s) => s.pendingPrAlign);
  const clearPendingPrAlign = useUiStore((s) => s.clearPendingPrAlign);
  const noteUserInteraction = useUiStore((s) => s.noteUserInteraction);
  const onStateFilter = (s: PrStateFilter) => {
    setStateFilter(s);
    setLimit(PAGE_SIZE);
    clearPendingPrAlign();
  };
  // The user's own pick. `stateFilter` is panel state, so the epoch can only move
  // through this door: bump FIRST, or a settling continuation lands, re-arms the align,
  // and flips the list against the tab just chosen. The automatic align keeps the plain
  // `onStateFilter` — a correction the app makes for itself is not a user action.
  const onUserStateFilter = (s: PrStateFilter) => {
    noteUserInteraction();
    onStateFilter(s);
  };
  const localPrs = useLocalPrs(repoPath);
  // Mark local PRs merged when their branch was merged outside the app.
  useReconcileLocalPrs(repoPath);
  const selectedPr = useUiStore((s) => s.selectedPr);
  const selectPr = useUiStore((s) => s.selectPr);
  const prefetchPr = usePrefetchPr(repoPath, lens);
  const hoverPrefetch = useHoverPrefetch();
  const [ghCreateOpen, setGhCreateOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const {
    filterText,
    setFilterText,
    showArchived,
    setShowArchived,
    authors,
    labels,
    stateLocal,
    stateRemote,
    visibleLocal,
    archivedLocalCount,
    visibleRemote,
    authorCount,
    labelCount,
  } = useLocalRemoteFilter({
    locals: localPrs.data ?? [],
    remotes: prList.data ?? [],
    stateFilter,
    authorFilter: listFilter.authorFilter,
    labelFilter: listFilter.labelFilter,
    mineActive: listFilter.mineActive,
    labelsServerSide: listFilter.labelsServerSide,
    // `usePrList`'s key up to the state axis: every cached page for this lens and
    // state feeds the author/label options and counts, whatever limit or filter
    // produced it, so they don't collapse to the active filter.
    optionSourcePrefix: [...repoKeys.prList(repoPath), lens, stateFilter],
  });

  // Creating a remote PR/MR follows its per-action write flag — ready GitHub AND
  // GitLab repos both get the create dialog (provider-aware copy; the head branch
  // is pushed first either way). The dialog picks the head/base branches itself.
  const canCreateGhPr = forgeFeatureReady(gh.data, "mrCreate");
  const ghCreateReason = canCreateGhPr
    ? null
    : isGitLab
      ? gh.data?.installed
        ? "Sign in to GitLab (glab auth login) to work with merge requests here."
        : "Install the GitLab CLI (glab) to work with merge requests here."
      : provider === "bitbucket"
        ? "Connect your Bitbucket account in Settings → Accounts to create pull requests here."
        : "Connect this repository to GitHub to open a pull request here.";
  const pendingCreate = useUiStore((s) => s.pendingCreate);
  const clearPendingCreate = useUiStore((s) => s.clearPendingCreate);
  const openLocalPrCreate = useUiStore((s) => s.openLocalPrCreate);

  // CANCEL before invalidate: a read already in flight would otherwise resolve
  // afterwards and stamp itself fresh, erasing the invalidation.
  // `usePrReviewState`'s co-invalidation contract owes `pr-review-state` any
  // narrow `pr-list` refresh. `pr-ci` and `pr-mergeability` are the rows' other
  // badges and take the same pass.
  const queryClient = useQueryClient();
  function refreshPrList() {
    // An explicit refresh RE-ARMS the bounded chase rather than spending from
    // it: rungs go back to zero, and the flag exempts this refresh's own
    // completion so the user gets a whole ladder instead of one read.
    holdPolls.current = 0;
    holdExemptNext.current = true;
    // The four families go out CONCURRENTLY: `pr-ci` and `pr-mergeability` key
    // on a digest of the rows they describe, so a refetch that raced the list
    // caches under the outgoing key; `pr-review-state` keys on no rows and
    // re-walks the forge from the filters.
    for (const queryKey of [
      repoKeys.prList(repoPath),
      repoKeys.prCi(repoPath),
      repoKeys.prMergeability(repoPath),
      repoKeys.prReviewState(repoPath),
    ])
      void queryClient
        .cancelQueries({ queryKey })
        .then(() => queryClient.invalidateQueries({ queryKey }))
        .catch(() => {
          // Best-effort, like the local arm below: an invalidate's refetch can
          // settle as a rejection, which would otherwise surface as an
          // unhandled rejection rather than a stale list.
        });
    // The local records ride along — the control speaks for the whole list —
    // but reload FIRST: the MCP writes that store file from another process and
    // tauri-plugin-store serves its in-memory copy, so a bare invalidate
    // refetches the stale snapshot (the pair App.tsx's focus sweep makes).
    const localKey = localPrKey(repoPath);
    void reloadLocalPrs()
      .then(() => queryClient.cancelQueries({ queryKey: localKey }))
      .then(() => queryClient.invalidateQueries({ queryKey: localKey }))
      .catch(() => {
        // Best-effort: a failed reload leaves the last known records.
      });
  }

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());
  // Tab-gated like the scope actions below: both panels stay mounted under
  // <Activity>, so an ungated registration would refresh this list from Issues.
  useHotkeyAction("refresh-pr-list", () => refreshPrList(), onPullsTab);
  useHotkeyAction("create-local-pr", () => openLocalPrCreate());
  useHotkeyAction("create-pr", () => setGhCreateOpen(true), canCreateGhPr);
  // Each scope action mirrors its toolbar segment's availability, and adds the
  // tab (`onPullsTab`, hoisted above): both panels stay mounted under <Activity>,
  // so an ungated registration would rewrite this repo's PR filter from the Issues
  // tab with nothing visible.
  useHotkeyAction(
    "pr-preset-all",
    () => listFilter.setPreset("all"),
    onPullsTab && canFilterMine && listFilter.prefsReady,
  );
  useHotkeyAction(
    "pr-preset-mine",
    () => listFilter.setPreset("mine"),
    onPullsTab && canFilterMine && listFilter.prefsReady,
  );
  useHotkeyAction(
    "pr-preset-needs-review",
    () => listFilter.setPreset("needs-review"),
    onPullsTab && canFilterMine && canGroupByReview && listFilter.prefsReady,
  );
  useHotkeyAction(
    "pr-group-review",
    () => listFilter.setGroupByReview(!listFilter.groupByReview),
    onPullsTab && canGroupByReview && listFilter.prefsReady,
  );

  // Palette path for the row context menu's record-management actions: they act
  // on the currently-selected LOCAL PR (enabled only when one is selected), so a
  // keyboard user reaches Archive/Delete without a right-click. Delete confirms
  // through the same dialog the row menu uses.
  const updateLocalPr = useUpdateLocalPr(repoPath);
  const deleteLocalPr = useDeleteLocalPr(repoPath);
  const selectedLocalPr =
    selectedPr?.kind === "local"
      ? (localPrs.data ?? []).find((p) => p.id === selectedPr.id)
      : undefined;
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const shownSelectedLocalPr = useRetained(selectedLocalPr);

  useHotkeyAction(
    "pr-archive",
    () => {
      if (!selectedLocalPr) return;
      if (selectedLocalPr.archived) {
        updateLocalPr.mutate({
          id: selectedLocalPr.id,
          mutate: (cur) => ({ ...cur, archived: false }),
        });
      } else {
        updateLocalPr.mutate({
          id: selectedLocalPr.id,
          mutate: (cur) => ({ ...cur, archived: true }),
        });
        selectPr(null);
      }
    },
    selectedLocalPr !== undefined,
  );
  useHotkeyAction(
    "pr-delete",
    () => setConfirmDeleteSelected(true),
    selectedLocalPr !== undefined,
  );

  // Awaited rather than per-call mutate callbacks: an `<Activity>` tab hide tears
  // this observer's subscription down mid-delete, and react-query drops per-call
  // callbacks once an observer has no listeners — the confirm dialog would stay
  // open over a PR that was already gone.
  async function deleteSelectedLocalPr(id: string) {
    try {
      await deleteLocalPr.mutateAsync(id);
      setConfirmDeleteSelected(false);
      // Deselect only if the deleted PR is still the selection — the await can
      // resolve after the user has selected another PR or navigated, and a
      // blind clear would wipe that newer selection.
      const sel = useUiStore.getState().selectedPr;
      if (sel?.kind === "local" && sel.id === id) selectPr(null);
    } catch (e) {
      toastError(e);
    }
  }

  // Opened from the command palette / New menu via requestCreate (any tab).
  // Re-check the gate: the requester's own gate can lag this panel's (e.g. a
  // provider flip mid-flight) — never open a create dialog that can't submit.
  useEffect(() => {
    if (pendingCreate === "pr") {
      if (canCreateGhPr) setGhCreateOpen(true);
      clearPendingCreate();
    } else if (pendingCreate === "local-pr") {
      openLocalPrCreate();
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate, canCreateGhPr, openLocalPrCreate]);

  // Land on the tab that can CONTAIN the PR a navigation opened: this tab is local
  // state a notification / My work / Automation-history click can't reach, so a merged
  // PR arrives selected on a tab that will never list it. The target comes from the PR's
  // own state, which the event can't name — a review posted on a PR that merged
  // afterwards is the reported case. One-shot, retired as soon as it's answered.
  // Every term gates the ARMING, so no doomed or wrong read is ever issued: off-tab an
  // armed intent would refetch on each window focus; under a provisional "origin" lens
  // this would fetch a fork's ORIGIN pull request #N, a different PR; and a not-ready
  // forge can only answer errors. Readiness also supplies the disabled→enabled
  // transition the observer needs to fetch at all. The id is untrusted — a
  // hand-editable store feeds one route — so only a positive integer arms.
  const alignSelectedNumber =
    selectedPr?.kind === "remote" ? Number(selectedPr.id) : Number.NaN;
  const alignRemoteNumber =
    pendingPrAlign &&
    onPullsTab &&
    ghReady &&
    lensSettled &&
    Number.isInteger(alignSelectedNumber) &&
    alignSelectedNumber > 0
      ? alignSelectedNumber
      : null;
  // `usePrDetails`' observer with ONE delta: `staleTime: 0`, so data minted before the
  // intent armed can't satisfy the gate below — a prefetched or just-viewed PR is exactly
  // the state a merged-PR notification contradicts, and nothing would refetch it inside
  // the shared 30s window. staleTime is per-OBSERVER and the key is unchanged, so this
  // still shares RemotePrView's cache entry while that view keeps its own window.
  const alignDetails = useQuery({
    ...prDetailsOptions(repoPath, alignRemoteNumber ?? 0, lens),
    enabled: alignRemoteNumber !== null,
    placeholderData: keepPreviousDataForKeyAxes(repoPath, [[3, lens]]),
    staleTime: 0,
  });
  // Consume only once every axis of the deciding read has settled AND the state was
  // fetched after the intent armed. `isPlaceholderData` refuses the previous number's
  // retained data (it describes another PR); `isFetching` refuses a cached pre-merge
  // state while its refetch is in flight. A fetch failure leaves status "error", so the
  // intent stays armed for a retry rather than consuming stale truth.
  const alignDetailsSettled =
    alignDetails.isSuccess &&
    !alignDetails.isPlaceholderData &&
    !alignDetails.isFetching;
  const alignRemoteState = alignDetails.data?.state;
  // The `data-row` key an align still owes a scroll to, consumed once the settled
  // tab draws that row. Only `settleAlign` sets it, so plain clicks and arrow-key
  // nav (which scrolls on its own) never gain a scroll from it.
  const [alignScrollRow, setAlignScrollRow] = useState<string | null>(null);
  // The tab and the archived toggle are READ here rather than depended on: the align
  // is keyed on the PR's state landing, not on the state it is correcting.
  const settleAlign = useEffectEvent(
    (target: PrStateFilter, revealArchived: boolean) => {
      // Only when it differs — `onStateFilter` resets paging, so a no-op align would
      // throw away however deep the user had loaded the list.
      if (target !== stateFilter) onStateFilter(target);
      if (revealArchived && !showArchived) setShowArchived(true);
      if (selectedPr) setAlignScrollRow(`${selectedPr.kind}:${selectedPr.id}`);
      clearPendingPrAlign();
    },
  );
  useEffect(() => {
    if (alignRemoteNumber === null || !alignDetailsSettled) return;
    // Anything but OPEN lands on Closed, which holds merged and closed alike. An
    // ERROR deliberately leaves the intent armed so a Retry still completes the
    // align; it can't target a different PR, because any reselection clears it.
    settleAlign(alignRemoteState === "OPEN" ? "open" : "closed", false);
  }, [alignRemoteNumber, alignDetailsSettled, alignRemoteState]);
  useEffect(() => {
    if (!pendingPrAlign || selectedPr?.kind !== "local") return;
    // Same hold as the remote arm, for the same reason: this query serves its cached
    // records while refetching, so a status merged or archived since that snapshot
    // would be consumed as final. A fetch failure keeps the intent armed (status
    // flips to error), resolved by a later successful read or a reselection.
    if (!localPrs.isSuccess || localPrs.isFetching) return;
    // Settled without the record — deleted between the event and the click — disarms
    // without moving the tab: no tab can show a record that is gone.
    if (!selectedLocalPr) {
      clearPendingPrAlign();
      return;
    }
    // `archived` is a visibility sub-filter WITHIN a tab, so the aligned tab keeps
    // hiding the row until that toggle is on. The Record is declared TOTAL for
    // exhaustiveness but READ as partial: the stored status is untrusted (the app-data
    // file is hand-editable, a newer build can add a member), and a miss falls back to
    // the current tab — a no-op align that just retires the intent.
    settleAlign(
      (LOCAL_ALIGN_TAB as Partial<Record<string, PrStateFilter>>)[
        selectedLocalPr.status
      ] ?? stateFilter,
      selectedLocalPr.archived === true,
    );
  }, [
    pendingPrAlign,
    selectedPr,
    localPrs.isSuccess,
    localPrs.isFetching,
    selectedLocalPr,
    stateFilter,
    clearPendingPrAlign,
  ]);

  const {
    localCollapsed,
    remoteCollapsed,
    toggleLocal,
    toggleRemote,
    isReviewGroupCollapsed,
    toggleReviewGroup,
  } = useCollapsedSections("pulls");

  // The grouping needs its own answered page: a truncated map can't say which bucket
  // the rows it dropped belong to, so it falls back to the flat list rather than
  // guessing.
  const reviewPage = reviewState.data;
  // Two gates, deliberately different: the GROUPING additionally refuses stale rows
  // and a failed map, while the explanation keys only on the user having asked —
  // an error or a short map must never leave the list flat with nothing said. (A
  // map still FETCHING is flat and silent by design; the note speaks for verdicts.)
  const groupingRequested =
    listFilter.groupByReview && canGroupByReview && stateFilter === "open";
  // The LIST's placeholder is the live gate: its rows can still be the previous
  // filter's while this map is a real answer for the incoming one, and bucketing
  // those rows against it would misfile the ones outside it as "Not reviewed yet".
  // The map's own gate is the standing rule's guard — `usePrReviewState` serves no
  // placeholder, and this keeps the grouping honest if one is ever reintroduced.
  // …and not on a failed refresh: react-query retains the previous map beside
  // isError, and grouping from it would contradict the note announcing the
  // flat-list fallback.
  const groupingAsked =
    groupingRequested &&
    !reviewState.isPlaceholderData &&
    !prList.isPlaceholderData &&
    !reviewState.isError;
  const remoteGroups =
    groupingAsked && reviewPage && !reviewPage.truncated
      ? REVIEW_GROUPS.map((group) => {
          const items = visibleRemote.filter(
            (pr) => reviewBucket(pr.number, reviewPage.entries) === group.kind,
          );
          return {
            key: group.kind,
            label: group.label,
            title: group.title,
            count: items.length,
            collapsed: isReviewGroupCollapsed(group.kind),
            onToggle: () => toggleReviewGroup(group.kind),
            items,
          };
        })
      : undefined;
  // Both ways the grouping can fail say so: silently falling back to a flat list
  // would read as "the toggle did nothing".
  const groupingNote = (() => {
    if (!groupingRequested) return undefined;
    if (reviewState.isError) return UNGROUPED_NOTE.error;
    if (groupingAsked && reviewPage?.truncated) return UNGROUPED_NOTE.truncated;
    return undefined;
  })();
  // Two independent notes over one channel: SCOPE (which rows these are) before
  // ARRANGEMENT (how they're ordered), because the first changes what the second
  // describes. Deliberately not folded into UNGROUPED_NOTE — that Record is about
  // the review grouping, and this is about the filter that fetched the page.
  const remoteNote =
    [
      listFilter.teamScopeDropped ? TEAM_SCOPE_DROPPED_NOTE : undefined,
      groupingNote,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  // Running creates that still need a place held in this list. The HIDE
  // predicate is derived at render, never in an effect: this panel lives under
  // <Activity>, where an effect would be deferred while the tab is hidden — and
  // the hand-off has to be exact, since a frame showing both the strip and the
  // real row (or neither) is what the strip exists to prevent. (The delete below
  // is the deliberate exception; its own note says why it can afford to wait.)
  // The containment test runs against the RAW page, not `visibleRemote`: a real
  // row hidden by the user's own text/label filter means the strip's job is
  // done, not that it should linger. Per entry by its OWN number, so one
  // create's arrival never hides a still-creating sibling.
  // Deliberately NOT gated on `isPlaceholderData`: the strip and the rows render
  // from the SAME `prList.data`, so a placeholder page holding the number is
  // already painting that row — gating here would show both at once.
  // Entries persist past their guard release, so this predicate is also what
  // RE-shows the strip when a pre-settle refetch loses the number again — the
  // hold self-heals. Never gate it on the lane's guard state.
  const creates = usePrCreates(repoPath);
  const pendingCreates =
    stateFilter === "open"
      ? creates.filter(
          (c) =>
            c.lens === lens &&
            !(
              c.phase === "created" &&
              (prList.data?.some((p) => p.number === c.number) ?? false)
            ),
        )
      : [];

  // Deleting a held entry is THIS panel's call, because only it knows which page
  // the strip sits in: sibling surfaces fetch UNFILTERED pages under the same
  // lens, and a watcher settling on one of those would drop the strip while this
  // panel's own filtered page still lacks the row. Pre-arm, containment only
  // hides the strip; the entry and banner stay until the flow ends. Both derives
  // are pure store functions, where their own tests reach them.
  const containedCreates = containedHolds(creates, prList.data, {
    open: stateFilter === "open",
    lens,
    isPlaceholder: prList.isPlaceholderData,
  });
  const containedKey = containedHoldsKey(containedCreates);
  // Where the user last stood in THIS panel's rows, captured while the row
  // still exists: an unmount fires no event that can report its own `data-row`.
  // Scoped to the panel, not the document: `remote:<n>` is the shared list
  // scaffold's namespace, so the issues panel — kept mounted by <Activity> —
  // writes the same keys for its own numbers.
  const lastRowFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    const onFocusIn = (e: FocusEvent) => {
      lastRowFocusRef.current =
        e.target instanceof HTMLElement ? (e.target.dataset.row ?? null) : null;
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);
  const settleContained = useEffectEvent(() => {
    // The held row's button unmounts on the CONTAINMENT render — the strip
    // predicate drops the entry in the same render that fills `containedKey` —
    // and React commits that removal before this passive effect runs, so focus
    // has already fallen to <body> by now. The ref above, fed continuously by
    // its focusin listener, is what still knows where the user stood.
    const stood = lastRowFocusRef.current;
    const orphaned =
      document.activeElement === document.body ||
      document.activeElement === null;
    const losing =
      orphaned &&
      containedCreates.some(
        (c) => c.phase === "created" && stood === `remote:${c.number}`,
      );
    for (const c of containedCreates)
      settlePrCreateIfCurrent(repoPath, c.head, c.startedAt);
    if (!losing || stood === null) return;
    // Containment tests the RAW page, so the replacement row may not RENDER —
    // a collapsed review group unmounts its rows, and the client-side text
    // filter hides them — and then the first rendered row keeps the keyboard
    // position inside the list rather than on <body>. When the panel renders NO
    // row at all (every group collapsed, or the filter excludes all of them),
    // the search input is the terminal landing: always rendered, and where
    // `focus-filter` already puts the keyboard. Both row queries stay inside
    // this panel: the `remote:<n>` namespace is shared with the issues panel.
    const selector = `[data-row="${CSS.escape(stood)}"]`;
    requestAnimationFrame(() => {
      const root = panelRef.current;
      const row =
        root?.querySelector<HTMLElement>(selector) ??
        root?.querySelector<HTMLElement>("[data-row]");
      (row ?? filterRef.current)?.focus();
    });
  });
  // Deferred while this panel's tab is hidden, since it lives under <Activity> —
  // accepted: the strip is invisible there and the long stop still bounds the
  // entry, and the settle is idempotent, so the replay on show costs nothing.
  useEffect(() => {
    if (containedKey) settleContained();
  }, [containedKey]);

  // The rows a hold is actually waiting on: the created subset of the SAME strip
  // predicate, so the poll and the strip can never disagree about what is
  // outstanding. A `creating` entry has no number for the list to show yet.
  const heldRows = pendingCreates.filter((c) => c.phase === "created");
  const heldKey = heldRows.map((c) => `${c.head} ${c.startedAt}`).join("|");
  // One rung per completion that lands while the poll is armed; the ladder
  // re-arms on a new hold identity or an explicit refresh.
  const listUpdatedAt = prList.dataUpdatedAt;
  const listFailedAt = prList.errorUpdatedAt;
  const listFetching = prList.isFetching;
  // Tab-gated on top of `refetchIntervalInBackground: false`: that covers a
  // hidden WINDOW, but an <Activity>-hidden panel keeps active observers and
  // would poll behind the Issues tab.
  const canPollHold = onPullsTab && ghReady && listFilter.scopeReady;
  useEffect(() => {
    if (holdLadderFor.current !== heldKey) {
      holdLadderFor.current = heldKey;
      holdPolls.current = 0;
      // A reset ladder takes CURRENT state as its baseline, not zero: zeroing
      // would read the completion that predates this hold as a rung and leave
      // it seven. It also absorbs the placeholder `dataUpdatedAt: 0` dip, which
      // can only move the baseline down. A fetch already IN FLIGHT at the reset
      // lands past that baseline, so it takes the same exemption a refresh does.
      holdSeen.current = { ok: listUpdatedAt, failed: listFailedAt };
      if (listFetching) holdExemptNext.current = true;
    }
    const advanced =
      listUpdatedAt > holdSeen.current.ok ||
      listFailedAt > holdSeen.current.failed;
    holdSeen.current = { ok: listUpdatedAt, failed: listFailedAt };
    if (advanced) {
      if (holdExemptNext.current) holdExemptNext.current = false;
      else if (holdPollMs !== false) holdPolls.current += 1;
    }
    setHoldPollMs(
      heldKey && canPollHold && holdPolls.current < HOLD_POLL_LIMIT
        ? HOLD_POLL_MS
        : false,
    );
  }, [
    heldKey,
    canPollHold,
    holdPollMs,
    listUpdatedAt,
    listFailedAt,
    listFetching,
  ]);

  // Arrow keys walk the visible rows, local section first like the list. A
  // collapsed section's body is unmounted, so its rows must leave the registry
  // too — otherwise an arrow key could select an invisible row. Grouped, the
  // remote rows walk group by group in the order they render.
  const navRemote = remoteGroups
    ? remoteGroups.flatMap((group) => (group.collapsed ? [] : group.items))
    : visibleRemote;
  // Held rows walk where they are drawn: pinned above the remote rows, in the
  // order `usePrCreates` sorts them. They carry the real row's id, so the
  // registry entry survives the swap untouched.
  const navTargets = [
    ...(localCollapsed
      ? []
      : visibleLocal.map((pr) => ({ kind: "local" as const, id: pr.id }))),
    ...(remoteCollapsed
      ? []
      : [
          ...heldRows.map((c) => ({
            kind: "remote" as const,
            id: String(c.number),
          })),
          ...navRemote.map((pr) => ({
            kind: "remote" as const,
            id: String(pr.number),
          })),
        ]),
  ];

  // The align's scroll lands when `navTargets` (the rows the list draws) holds its
  // row, and retires unscrolled once the list settles without it (filtered out,
  // collapsed, past the loaded page) or any other selection lands. Remote rows
  // count only off a placeholder page: that page is the previous tab's, and a
  // stale copy of the row there is about to move. A held row is never placeholder.
  const selectedRowKey = selectedPr
    ? `${selectedPr.kind}:${selectedPr.id}`
    : null;
  const alignScrollDrawn =
    alignScrollRow !== null &&
    navTargets.some((t) => `${t.kind}:${t.id}` === alignScrollRow) &&
    (selectedPr?.kind === "local" ||
      !prList.isPlaceholderData ||
      heldRows.some((c) => `remote:${c.number}` === alignScrollRow));
  const alignScrollSettled =
    selectedPr?.kind === "local" ||
    prList.isError ||
    (prList.isSuccess && !prList.isPlaceholderData && !prList.isFetching);
  useLayoutEffect(() => {
    if (alignScrollRow === null) return;
    if (alignScrollRow !== selectedRowKey) {
      setAlignScrollRow(null);
      return;
    }
    if (alignScrollDrawn) {
      // A held strip can share its row's key; the list row renders after the
      // pinned slot, so the last match is the one to reveal.
      const rows = panelRef.current?.querySelectorAll<HTMLElement>(
        `[data-row="${CSS.escape(alignScrollRow)}"]`,
      );
      rows?.[rows.length - 1]?.scrollIntoView({ block: "nearest" });
      setAlignScrollRow(null);
    } else if (alignScrollSettled) {
      setAlignScrollRow(null);
    }
  }, [alignScrollRow, selectedRowKey, alignScrollDrawn, alignScrollSettled]);

  // One spelling for "this number is the selection", shared by the real rows and
  // the held rows standing in for them — the swap only carries the selection
  // across because both answer the same question.
  const isRemoteSelected = (number: number) =>
    selectedPr?.kind === "remote" && selectedPr.id === String(number);

  const onListKeyDown = listKeyboardNav({
    items: navTargets,
    activeIndex: navTargets.findIndex(
      (t) => t.kind === selectedPr?.kind && t.id === selectedPr.id,
    ),
    onActivate: (target) => selectPr(target),
    rowKey: (target) => `${target.kind}:${target.id}`,
  });

  // Held filter rows say which of the two reasons holds them: the provider can't
  // express the axis, or this repo isn't connected yet. Never both, never a
  // provider claim while `implemented` is still unknown.
  const mineReason = (() => {
    if (canFilterMine) return null;
    if (implemented && !implemented.listFilterMine)
      return `${providerName} pull requests have no assignees or review requests to filter by`;
    return `Connect this repository to ${providerName} to filter by assignee or reviewer`;
  })();
  const teamsReason = (() => {
    if (canFilterTeam) return null;
    if (implemented && !implemented.listFilterTeam)
      return `${providerName} has no team review requests`;
    // Falls through to the group's reason (not connected) rather than repeating it.
    return null;
  })();
  const reviewReason = (() => {
    if (canGroupByReview) return null;
    if (implemented && !implemented.reviewGrouping)
      return `${providerName} doesn't report your last review on this list`;
    return `Connect this repository to ${providerName} to group by your review`;
  })();
  const teamsNote = (() => {
    if (listFilter.teamsError) return "Couldn't load your teams.";
    if (listFilter.missingTeamScope)
      return "Your GitHub token lacks read:org — run gh auth refresh -s read:org";
    return null;
  })();
  // Same two-reason shape as mineReason above, and the order matters: the provider
  // claim is only made where `implemented` actually refutes the axis, so a forge
  // status that hasn't loaded — or one whose provider DOES support authors but
  // isn't connected yet — falls to the connect line instead. Left null, the rows
  // would stay live while the axis was dropped from the query, and a pick would
  // silently empty the local section under a zero badge.
  const authorReason = (() => {
    if (canFilterAuthor) return null;
    if (implemented && !implemented.listFilterAuthor)
      return `${providerName} can't filter pull requests by author here`;
    return `Connect this repository to ${providerName} to filter by author`;
  })();
  const axisCap = isGitLab ? gitlabAxisCap(providerName) : undefined;

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
      <SessionExpiryNotice repoPath={repoPath} />
      <ConversationListPanel
        repoPath={repoPath}
        feature={remoteNoun}
        remoteLabel={remoteLabel}
        stateFilter={stateFilter}
        onStateFilter={onUserStateFilter}
        presetControl={
          <ConversationPresetSwitcher
            feature="pulls"
            preset={listFilter.preset}
            onPreset={listFilter.setPreset}
            canFilterMine={canFilterMine}
            canGroupByReview={canGroupByReview}
            disabledReason={listFilter.prefsReason}
          />
        }
        lensControl={<RepoLensSwitcher repoPath={repoPath} />}
        newMenu={{
          ghLabel: isGitLab
            ? "Merge request on GitLab…"
            : `Pull request on ${providerName}…`,
          ghDisabled: !canCreateGhPr,
          ghReason: ghCreateReason ?? undefined,
          onGh: () => setGhCreateOpen(true),
          localLabel: "Local pull request…",
          onLocal: () => openLocalPrCreate(),
        }}
        filterSlot={
          <ConversationFilterPopover
            authors={authors}
            labels={labels}
            authorFilter={listFilter.authorFilter}
            labelFilter={listFilter.labelFilter}
            toggle={listFilter.toggleValue}
            activeFilterCount={listFilter.activeFilterCount}
            authorCount={authorCount}
            labelCount={labelCount}
            authorReason={authorReason}
            axisCap={axisCap}
            disabledReason={listFilter.prefsReason}
            mine={{
              label: "Mine",
              disabledReason: mineReason,
              rows: [
                {
                  key: "assigned",
                  label: "Assigned to me",
                  checked: listFilter.assignedToMe,
                  onToggle: listFilter.setAssignedToMe,
                },
                {
                  key: "review-requested",
                  label: "Review requested: me",
                  checked: listFilter.reviewRequestedMe,
                  onToggle: listFilter.setReviewRequestedMe,
                },
              ],
              teams: {
                chosen: listFilter.chosenTeams,
                options: listFilter.teamOptions,
                pending: listFilter.teamsPending,
                name: listFilter.teamName,
                isStale: listFilter.isStaleTeam,
                onToggle: listFilter.toggleTeam,
                disabledReason: teamsReason,
                note: teamsNote,
                noteTitle: listFilter.missingTeamScope
                  ? "gh auth refresh -s read:org"
                  : undefined,
              },
            }}
            review={{
              label: "My review",
              disabledReason: reviewReason,
              rows: [
                {
                  key: "group-by-review",
                  label: "Group by my review",
                  checked: listFilter.groupByReview,
                  onToggle: listFilter.setGroupByReview,
                },
              ],
            }}
          />
        }
        toolbarActions={
          // Never `disabled` and never gated on `isFetching`: cancel-then-
          // invalidate is idempotent against a read in flight, and mid-poll a
          // guard would swallow the user's FIRST press. The spin plus
          // `aria-busy` carry the state instead.
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
            aria-busy={prList.isFetching}
            onClick={refreshPrList}
          >
            <ArrowClockwiseIcon
              className={cn(prList.isFetching && "animate-spin")}
            />
          </Button>
        }
        filterRef={filterRef}
        filterText={filterText}
        onFilterText={setFilterText}
        onListKeyDown={onListKeyDown}
        stateLocal={stateLocal}
        visibleLocal={visibleLocal}
        localKey={(pr) => pr.id}
        isLocalActive={(pr) =>
          selectedPr?.kind === "local" && selectedPr.id === pr.id
        }
        onSelectLocal={(pr) => selectPr({ kind: "local", id: pr.id })}
        renderLocalRow={(pr) => {
          const created = parseableDate(pr.createdAt);
          return (
            <>
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <GitPullRequestIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate" title={pr.title}>
                  {pr.title}
                </span>
                {pr.status !== "open" && (
                  <Badge variant="secondary" className="capitalize">
                    {pr.status}
                  </Badge>
                )}
              </p>
              <p
                className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
                onMouseEnter={clipTitleFromText}
              >
                {created && <RelativeTime date={pr.createdAt} />}
                {pr.archived && (created ? " · archived" : "archived")}
                {!created && !pr.archived && <span aria-hidden="true">—</span>}
              </p>
              <p
                className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
                onMouseEnter={clipTitleFromText}
              >
                {pr.head} → {pr.base}
              </p>
            </>
          );
        }}
        localRowContextMenu={(pr, row) => (
          <LocalPrContextMenu repoPath={repoPath} pr={pr}>
            {row}
          </LocalPrContextMenu>
        )}
        archivedLocalCount={archivedLocalCount}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        localCollapsed={localCollapsed}
        remoteCollapsed={remoteCollapsed}
        onToggleLocal={toggleLocal}
        onToggleRemote={toggleRemote}
        ghPending={gh.isPending}
        ghReady={ghReady}
        listPending={prList.isPending}
        remoteError={prList.isError}
        remoteErrorSlot={
          <div className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
            <p>Couldn't load {remoteNoun}.</p>
            {/* The filter refusals this panel can provoke — a fan-out too wide for
                the provider, a rejected author/label/team term, an advanced search
                the host doesn't offer — are PERMANENT, and each already carries the
                sentence that says how to get out of it. Retry stays for the
                transient half, which can't tell itself apart from here. */}
            {prList.error != null && (
              <p className="text-[11px]">
                {presentError(prList.error).summary}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => prList.refetch()}
            >
              Retry
            </Button>
          </div>
        }
        // More may exist server-side exactly when this page filled the requested
        // limit (compared against the raw loaded count, not the filtered view).
        hasMore={(prList.data?.length ?? 0) === limit}
        remoteCount={prList.data?.length ?? 0}
        loadingMore={prList.isFetching}
        onLoadMore={() => setLimit((n) => n + PAGE_SIZE)}
        stateRemote={stateRemote}
        visibleRemote={visibleRemote}
        remoteGroups={remoteGroups}
        remoteNote={remoteNote}
        // Oldest-first, the order `usePrCreates` already sorts — the same order
        // the repo view's banner lists them in, and the order `navTargets`
        // registers them in. A created entry already has the number the PR view
        // fetches by, so its row is real; a creating one has nothing to open.
        remotePinned={
          pendingCreates.length > 0
            ? {
                items: pendingCreates,
                key: (c) => c.head,
                rowId: (c) => (c.phase === "created" ? String(c.number) : null),
                isActive: (c) =>
                  c.phase === "created" && isRemoteSelected(c.number),
                onSelect: (c) => {
                  if (c.phase === "created")
                    selectPr({ kind: "remote", id: String(c.number) });
                },
                onHover: (c) => {
                  if (c.phase === "created")
                    hoverPrefetch(() => prefetchPr(c.number));
                },
                render: (c) => <PendingPrRow create={c} />,
              }
            : undefined
        }
        remoteKey={(pr) => String(pr.number)}
        isRemoteActive={(pr) => isRemoteSelected(pr.number)}
        onSelectRemote={(pr) =>
          selectPr({ kind: "remote", id: String(pr.number) })
        }
        onRemoteHover={(pr) => hoverPrefetch(() => prefetchPr(pr.number))}
        renderRemoteRow={(pr) => (
          <>
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <GitPullRequestIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={pr.title}>
                {pr.title}
              </span>
              {pr.isDraft && <Badge variant="secondary">Draft</Badge>}
              {pr.state !== "OPEN" && (
                <Badge variant="secondary" className="capitalize">
                  {pr.state.toLowerCase()}
                </Badge>
              )}
              {ciMap?.get(pr.number) === "passing" && (
                <span
                  className="ml-auto shrink-0 text-success"
                  role="img"
                  title="Checks passing"
                  aria-label="Checks passing"
                >
                  <CheckCircleIcon className="size-3" />
                </span>
              )}
              {ciMap?.get(pr.number) === "failing" && (
                <span
                  className="ml-auto shrink-0 text-destructive"
                  role="img"
                  title="Checks failing"
                  aria-label="Checks failing"
                >
                  <XCircleIcon className="size-3" />
                </span>
              )}
              {ciMap?.get(pr.number) === "pending" && (
                <span
                  className="ml-auto shrink-0 text-warning"
                  role="img"
                  title="Checks pending"
                  aria-label="Checks pending"
                >
                  <ClockIcon className="size-3" />
                </span>
              )}
              {ciMap?.get(pr.number) === "neutral" && (
                // Glyph + tone match `checkPresentation`'s CANCELLED so the row and
                // the PR's checks panel read the same state.
                <span
                  className="ml-auto shrink-0 text-muted-foreground"
                  role="img"
                  title="Checks cancelled"
                  aria-label="Checks cancelled"
                >
                  <ProhibitIcon className="size-3" />
                </span>
              )}
            </p>
            <p
              className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
              onMouseEnter={clipTitleFromText}
            >
              #{pr.number}
              {/* Indicators lead this line: truncation eats the tail first, so
                  the age and author drop before the glyphs. Text carries the
                  meaning; the label is self-contained so the glyph reads alone. */}
              {mergeMap?.get(pr.number) === "conflicting" && (
                <>
                  {" · "}
                  <span
                    role="img"
                    title="Has conflicts with the base branch"
                    aria-label="Has conflicts with the base branch"
                    className="inline-flex items-center gap-1 align-middle text-warning"
                  >
                    <WarningIcon className="size-3 shrink-0" />
                    Conflicts
                  </span>
                </>
              )}
              {pr.stack && (
                <>
                  {" · "}
                  <span
                    className="inline-flex items-center gap-1 align-middle"
                    role="img"
                    title={`Stack position ${pr.stack.position} of ${pr.stack.size}`}
                    aria-label={`Stack position ${pr.stack.position} of ${pr.stack.size}`}
                  >
                    <StackSimpleIcon className="size-3 shrink-0 text-muted-foreground" />
                    {pr.stack.position}/{pr.stack.size}
                  </span>
                </>
              )}
              {pr.author ? ` · ${displayLogin(pr.author.login)}` : ""}
              {parseableDate(pr.createdAt) && (
                <>
                  {" · "}
                  <RelativeTime date={pr.createdAt} />
                </>
              )}
            </p>
            <p
              className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground"
              onMouseEnter={clipTitleFromText}
            >
              {pr.headRefName} → {pr.baseRefName}
            </p>
          </>
        )}
        remoteSkeletonRows={2}
        skeletonRowLines={3}
        localNoun="pull requests"
        remoteNoun={remoteNoun}
      >
        <CreatePrDialog
          repoPath={repoPath}
          open={ghCreateOpen}
          onOpenChange={setGhCreateOpen}
        />

        {/* Confirm for the palette "Delete pull request" action (the row menu owns
          its own confirm). Guarded on a selected local PR still existing. */}
        <ConfirmDialog
          open={confirmDeleteSelected && selectedLocalPr !== undefined}
          onCancel={() => setConfirmDeleteSelected(false)}
          title="Delete this local pull request?"
          body={
            shownSelectedLocalPr ? (
              <>
                Permanently deletes "{shownSelectedLocalPr.title}"
                {shownSelectedLocalPr.comments.length > 0
                  ? ` and its ${shownSelectedLocalPr.comments.length} comment${
                      shownSelectedLocalPr.comments.length === 1 ? "" : "s"
                    }`
                  : ""}
                . The branches are not affected. This cannot be undone.
              </>
            ) : null
          }
          confirmLabel="Delete"
          confirmVariant="destructive"
          pending={deleteLocalPr.isPending}
          onConfirm={() => {
            if (!selectedLocalPr) return;
            void deleteSelectedLocalPr(selectedLocalPr.id);
          }}
        />
      </ConversationListPanel>
    </div>
  );
}
