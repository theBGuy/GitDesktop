import {
  CheckCircleIcon,
  ClockIcon,
  GitPullRequestIcon,
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
import { PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import { RepoLensSwitcher } from "@/features/conversations/RepoLensSwitcher";
import { useCollapsedSections } from "@/features/conversations/useCollapsedSections";
import { useLocalRemoteFilter } from "@/features/conversations/useLocalRemoteFilter";
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
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
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
  // "closed" matches the Closed tab: closed and merged alike.
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("open");
  // How many remote PRs to load; "Load more" bumps it. A tab switch (open/closed)
  // resets to the first page.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const prList = usePrList(repoPath, ghReady, stateFilter, limit, lens);
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
  const repoTab = useUiStore((s) => s.repoTab);
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
  );
  const mergeMap = prListMergeability.data;
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
    authorFilter,
    labelFilter,
    toggle,
    showArchived,
    setShowArchived,
    authors,
    labels,
    activeFilterCount,
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

  const { localCollapsed, remoteCollapsed, toggleLocal, toggleRemote } =
    useCollapsedSections("pulls");

  // Arrow keys walk the visible rows, local section first like the list. A
  // collapsed section's body is unmounted, so its rows must leave the registry
  // too — otherwise an arrow key could select an invisible row.
  const navTargets = [
    ...(localCollapsed
      ? []
      : visibleLocal.map((pr) => ({ kind: "local" as const, id: pr.id }))),
    ...(remoteCollapsed
      ? []
      : visibleRemote.map((pr) => ({
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionExpiryNotice repoPath={repoPath} />
      <ConversationListPanel
        repoPath={repoPath}
        feature={remoteNoun}
        remoteLabel={remoteLabel}
        stateFilter={stateFilter}
        onStateFilter={onStateFilter}
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
            authorFilter={authorFilter}
            labelFilter={labelFilter}
            toggle={toggle}
            activeFilterCount={activeFilterCount}
            authorCount={authorCount}
            labelCount={labelCount}
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
        renderLocalRow={(pr) => (
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
            <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
              {parseableDate(pr.createdAt) && (
                <>
                  <RelativeTime date={pr.createdAt} />
                  {" · "}
                </>
              )}
              {pr.head} → {pr.base}
              {pr.archived ? " · archived" : ""}
            </p>
          </>
        )}
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
            </p>
            <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
              #{pr.number}
              {/* Ahead of the branch names so the row's truncation can't eat it.
                  Text carries the meaning; the label is self-contained so the
                  glyph reads on its own. */}
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
              {" · "}
              {pr.author ? `${displayLogin(pr.author.login)} · ` : ""}
              {parseableDate(pr.createdAt) && (
                <>
                  <RelativeTime date={pr.createdAt} />
                  {" · "}
                </>
              )}
              {pr.headRefName} → {pr.baseRefName}
            </p>
          </>
        )}
        remoteSkeletonRows={2}
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
            deleteLocalPr.mutate(selectedLocalPr.id, {
              onSuccess: () => {
                setConfirmDeleteSelected(false);
                selectPr(null);
              },
              onError: toastError,
            });
          }}
        />
      </ConversationListPanel>
    </div>
  );
}
