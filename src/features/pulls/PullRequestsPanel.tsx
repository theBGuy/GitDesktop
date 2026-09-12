import {
  CheckCircleIcon,
  ClockIcon,
  GitPullRequestIcon,
  ProhibitIcon,
  StackSimpleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
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
import {
  useDeleteLocalPr,
  useLocalPrs,
  useUpdateLocalPr,
} from "@/lib/pulls/queries";
import { useRemoteSlug, useRepoLens } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { CreatePrDialog } from "./CreatePrDialog";
import { LocalPrContextMenu } from "./LocalPrContextMenu";
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

/** Why the list is flat despite the grouping toggle being on. */
const UNGROUPED_NOTE = {
  error: "Couldn't load your review state — the list is ungrouped.",
  truncated: "Couldn't check every review — the list is ungrouped.",
} as const;

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
  const lens = useRepoLens(repoPath);
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
  const onStateFilter = (s: PrStateFilter) => {
    setStateFilter(s);
    setLimit(PAGE_SIZE);
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
    optionSourcePrefix: ["repo", repoPath, "pr-list", lens, stateFilter],
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

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());
  useHotkeyAction("create-local-pr", () => openLocalPrCreate());
  useHotkeyAction("create-pr", () => setGhCreateOpen(true), canCreateGhPr);
  // Each scope action mirrors its toolbar segment's availability, and adds the
  // tab (`onPullsTab`, hoisted above): both panels stay mounted under <Activity>,
  // so an ungated registration would rewrite this repo's PR filter from the Issues
  // tab with nothing visible.
  useHotkeyAction(
    "pr-preset-all",
    () => listFilter.setPreset("all"),
    onPullsTab && canFilterMine,
  );
  useHotkeyAction(
    "pr-preset-mine",
    () => listFilter.setPreset("mine"),
    onPullsTab && canFilterMine,
  );
  useHotkeyAction(
    "pr-preset-needs-review",
    () => listFilter.setPreset("needs-review"),
    onPullsTab && canFilterMine && canGroupByReview,
  );
  useHotkeyAction(
    "pr-group-review",
    () => listFilter.setGroupByReview(!listFilter.groupByReview),
    onPullsTab && canGroupByReview,
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

  // Arrow keys walk the visible rows, local section first like the list. A
  // collapsed section's body is unmounted, so its rows must leave the registry
  // too — otherwise an arrow key could select an invisible row. Grouped, the
  // remote rows walk group by group in the order they render.
  const navRemote = remoteGroups
    ? remoteGroups.flatMap((group) => (group.collapsed ? [] : group.items))
    : visibleRemote;
  const navTargets = [
    ...(localCollapsed
      ? []
      : visibleLocal.map((pr) => ({ kind: "local" as const, id: pr.id }))),
    ...(remoteCollapsed
      ? []
      : navRemote.map((pr) => ({
          kind: "remote" as const,
          id: String(pr.number),
        }))),
  ];

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
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionExpiryNotice repoPath={repoPath} />
      <ConversationListPanel
        repoPath={repoPath}
        feature={remoteNoun}
        remoteLabel={remoteLabel}
        stateFilter={stateFilter}
        onStateFilter={onStateFilter}
        presetControl={
          <ConversationPresetSwitcher
            feature="pulls"
            preset={listFilter.preset}
            onPreset={listFilter.setPreset}
            canFilterMine={canFilterMine}
            canGroupByReview={canGroupByReview}
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
        remoteKey={(pr) => String(pr.number)}
        isRemoteActive={(pr) =>
          selectedPr?.kind === "remote" && selectedPr.id === String(pr.number)
        }
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
