import { ArrowClockwiseIcon, PlayIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type MouseEvent,
  useEffect,
  useLayoutEffect,
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  type ListNoticeCause,
  listNotice,
  OFFLINE_ROWS_NOTICE,
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import { clipTitleFromText } from "@/lib/clip-title";
import { suppressContextMenu } from "@/lib/context-menu";
import {
  forgeFeatureReady,
  forgeProbeReason,
  forgeProbeState,
  pendingRunState,
  rerunFamilyState,
  useForgeStatus,
  usePendingRunWrites,
  useRepoStatus,
  useRepoWriteAccess,
  writeAccessReason,
} from "@/lib/git/queries";
import type { CiRunPage, WorkflowRun } from "@/lib/github/actions";
import {
  useCancelRun,
  useRerunRun,
  useWorkflowRunPages,
  useWorkflows,
} from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { pendingItemReason } from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { ManageMenu, ManagePaletteActions } from "./ManageMenu";
import { RunContextMenuItems } from "./RunContextMenu";
import { RunFilterChips } from "./RunFilterChips";
import { RunFilterPopover } from "./RunFilterPopover";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import {
  anyFacetActive,
  chipFacets,
  EMPTY_FACETS,
  type FacetKind,
  type Facets,
  FILTERED_RUN_WINDOW,
  facetsFor,
  filtersSignature,
  liveFacets,
  type RepoFacets,
  toRunFilters,
  windowApplies,
  withFacet,
  withoutFacet,
  withPicked,
  withRepoFacets,
} from "./run-filters";
import {
  type CiRunNoun,
  cancelStartedMessage,
  ciRunNoun,
  isPipelineProvider,
  rerunSuccessMessage,
  StatusIcon,
  statusLabel,
} from "./status";
import { WorkflowsSection } from "./WorkflowsSection";

/** Loading rows for the run list, shared by the forge probe and the list read,
 *  so a load whose probe hasn't failed never grows at the probe→list flip. */
const RUN_SKELETON_ROWS = 3;

/** Hides the Run button's label where the toolbar's This branch, Run, Refresh
 *  and Manage controls overflow one line (the 288px sidebar floor). CSS-only,
 *  so the button and its focus persist; its aria-label keeps the name. */
const RUN_ICON_ONLY =
  "@max-[292px]/actions-toolbar:*:data-[slot=run-label]:hidden";

/** The facet-free read the Workflows glyphs come from. */
const FACET_FREE = toRunFilters(EMPTY_FACETS, null);

/** The search box narrows loaded rows by text, whatever the facets sent. */
const SEARCH_PLACEHOLDER: Record<"pipelines" | "workflows", string> = {
  workflows: "Filter loaded runs",
  pipelines: "Filter loaded pipelines",
};

/** The list's plural noun, for copy beside the provider's other CI wording. */
const RUNS_PLURAL: Record<CiRunNoun, string> = {
  run: "runs",
  pipeline: "pipelines",
};

/** A localized run count with the provider's noun; `atLeast` marks a floor. */
function runCountText(count: number, noun: CiRunNoun, atLeast = false) {
  const word = count === 1 && !atLeast ? noun : RUNS_PLURAL[noun];
  return `${count.toLocaleString()}${atLeast ? "+" : ""} ${word}`;
}

type ListArm =
  | "probe"
  | "not-ready"
  | "offline"
  | "loading"
  | "failed"
  | "rows"
  | "no-text-match"
  | "no-facet-match"
  | "empty";

/** The loaded pages as one list, deduped by run id with the first occurrence
 *  winning. Page-number paging over a list that PREPENDS shifts rows across the
 *  boundary whenever a refetch lands after new runs started, so the same run can come
 *  back on two pages — duplicate React keys, and a selection bound to whichever twin
 *  rendered first. Freshness follows that rule: page one's copy of a twin is the one
 *  rendered, even where the later page holds the newer snapshot, until the next
 *  refetch of the page it sits on. */
function dedupeRuns(pages: CiRunPage[] | undefined): WorkflowRun[] {
  const seen = new Set<number>();
  const out: WorkflowRun[] = [];
  for (const page of pages ?? []) {
    for (const run of page.runs) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
    }
  }
  return out;
}

export function ActionsPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const forge = useForgeStatus(repoPath);
  // CI reads are provider-neutral (GitHub Actions + GitLab pipelines): a ready
  // repo lists runs either way. Starting a run is a SHARED write — `canWrite ||
  // forgeFeatureReady` keeps GitHub's button up while forge-status is pending and
  // positively enables a ready GitLab repo (which runs a pipeline on a ref rather
  // than dispatching a workflow — the dialog adapts).
  const ghReady = forgeFeatureReady(forge.data, "ci");
  const provider = forge.data?.provider;
  const isGitLab = provider === "gitlab";
  const isPipelines = isPipelineProvider(provider);
  const canWrite = !isPipelines;
  const canDispatch = canWrite || forgeFeatureReady(forge.data, "ciDispatch");
  // Re-run and cancel are shared writes too — same `canWrite || …` shape, read
  // here so the row context menu offers exactly what the run detail view does.
  const canRerun = canWrite || forgeFeatureReady(forge.data, "ciRerun");
  const canCancel = canWrite || forgeFeatureReady(forge.data, "ciCancel");
  // Starting a run is a repo write: an explicitly read-only viewer keeps the
  // control (with the reason) rather than losing it. CI is repo-wide, so the
  // probe takes no lens. It also gates on `active` as a backstop: an
  // Activity-hidden tab already fetches nothing.
  const writeAccess = useRepoWriteAccess(
    repoPath,
    undefined,
    active && !!provider,
  );
  const writeReason = writeAccessReason(writeAccess.data);
  const writeBlocked = writeAccess.data?.canPush === false;
  const runNoun = isPipelines ? "pipeline" : "workflow";
  const ciFeature = isPipelines ? "pipelines" : "workflow runs";
  // `canWrite` keeps the Run button up while the status is unknown, so the
  // probe arm says so in words that fit either provider ("workflow" is only
  // the unknown provider's default noun).
  const probe = forgeProbeState(forge);
  const runHint = (() => {
    switch (true) {
      case writeReason !== undefined:
        return writeReason;
      case probe !== null:
        return forgeProbeReason(probe, "run CI");
      case ghReady:
        return `Run a ${runNoun}`;
      case isGitLab:
        return "Sign in with the GitLab CLI (glab) to run pipelines";
      default:
        return "Sign in with GitHub CLI to run workflows";
    }
  })();
  const status = useRepoStatus(repoPath);
  const currentBranch = status.data?.branch.name ?? null;

  // The panel outlives repo switches, so facets are kept per repo: each repo
  // reads its own (derived, never cleared by an effect).
  const [repoFacets, setRepoFacets] = useState<RepoFacets>([]);
  const facets = facetsFor(repoFacets, repoPath);
  const branchPressed =
    facets.branch !== undefined && "current" in facets.branch;
  // What the read is narrowed by: a pressed This branch on a detached HEAD
  // sends nothing, so it never reads as an active filter.
  const live = liveFacets(facets, currentBranch);
  const [workflowsCollapsed, setWorkflowsCollapsed] = useState(false);
  const [workflowsShowAll, setWorkflowsShowAll] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [runOpen, setRunOpen] = useState(false);
  // The workflow the dialog opens preselected on, when a caller asked for one
  // ("Run workflow again…"); null is the plain "pick a workflow" open.
  const [dialogWorkflow, setDialogWorkflow] = useState<string | null>(null);
  // The run the one shared context menu acts on, set on right-click.
  const [menuRun, setMenuRun] = useState<WorkflowRun | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const funnelRef = useRef<HTMLButtonElement | null>(null);
  const chipRowRef = useRef<HTMLDivElement | null>(null);
  const scrollRoot = useRef<HTMLDivElement | null>(null);
  const rerun = useRerunRun(repoPath);
  const cancel = useCancelRun(repoPath);
  // The menu's holds read every surface's writes to the run, matched by the
  // writes' own variables: the observers above track only their latest call.
  const runWrites = usePendingRunWrites(repoPath);
  const menuRunWrites = menuRun
    ? pendingRunState(runWrites, menuRun.id)
    : undefined;
  const menuCancel = menuRunWrites?.cancel;
  const menuRerun = rerunFamilyState(menuRunWrites);

  const filters = toRunFilters(facets, currentBranch);
  const workflowsShown = provider === "github" && ghReady;
  const glyphsMuted = anyFacetActive(withoutFacet(live, "workflow"));
  // The Workflows glyphs read the facet-free entry. Under a workflow drill-in
  // nothing else observes it, so this read fetches and polls it then (Refresh
  // and push rechecks reach active observers only); otherwise it stays off.
  const baseRuns = useWorkflowRunPages(
    repoPath,
    workflowsShown && live.workflow !== undefined && !glyphsMuted,
    active,
    FACET_FREE,
  );
  const runs = useWorkflowRunPages(repoPath, ghReady, active, filters);
  const workflows = useWorkflows(repoPath, active && workflowsShown);
  const refreshReason = (() => {
    switch (true) {
      case probe !== null:
        return forgeProbeReason(probe, "load runs");
      case !ghReady:
        return "Connect this repo to load runs";
      case runs.isFetching:
        return `Loading ${runNoun} runs…`;
      default:
        return undefined;
    }
  })();
  const funnelReason = (() => {
    switch (true) {
      case ghReady:
        return undefined;
      case probe !== null:
        return forgeProbeReason(probe, "filter runs");
      default:
        return "Connect this repo to filter runs";
    }
  })();
  // ForgeNotReady's Retry resets the never-loaded probe to pending, which swaps
  // the card for skeletons below. Keyed on the card being mounted, a superset of
  // its Retry being mounted: the edge still rescues only a Retry that held focus.
  const forgeRescue = useRetryFocusRescue(!forge.isPending && !ghReady);
  // Loading the last page, or a press that parks offline, unmounts Load more
  // under the user's focus; land it on the list host. True exactly while the
  // button is mounted.
  const moreRescue = useRetryFocusRescue(runs.hasNextPage && !runs.isPaused);
  const queryClient = useQueryClient();
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);

  const chipKinds = chipFacets(facets);
  const facetActive = anyFacetActive(live);
  // A chip removed under focus hands it to its neighbour, then the funnel; any
  // other way the row empties (a repo switch) lands there through the rescue.
  const chipRescue = useRetryFocusRescue(chipKinds.length > 0);
  const landing = useRef<FacetKind | "funnel" | null>(null);
  const facetsKey = JSON.stringify(facets);
  const landedFor = useRef(facetsKey);
  // Lands on the commit that applied the change, never on a bare re-run.
  useLayoutEffect(() => {
    if (landedFor.current === facetsKey) return;
    landedFor.current = facetsKey;
    const target = landing.current;
    if (target === null) return;
    landing.current = null;
    const chip =
      target === "funnel"
        ? null
        : chipRowRef.current?.querySelector<HTMLElement>(
            `[data-chip-remove="${target}"]`,
          );
    (chip?.isConnected ? chip : funnelRef.current)?.focus();
  }, [facetsKey]);

  function setFacets(next: Facets) {
    setRepoFacets((m) => withRepoFacets(m, repoPath, next));
  }

  function removeFacet(kind: FacetKind) {
    const i = chipKinds.indexOf(kind);
    landing.current = chipKinds[i + 1] ?? chipKinds[i - 1] ?? "funnel";
    setFacets(withoutFacet(facets, kind));
  }

  function clearFacets() {
    landing.current = "funnel";
    setFacets(EMPTY_FACETS);
  }

  // Awaited continuations, not per-call callbacks: react-query drops those once
  // the observer has no listeners, and this panel unmounts with its tab.
  async function doRerun(runId: number, failedOnly: boolean) {
    try {
      await rerun.mutateAsync({ runId, failed: failedOnly });
      toast.success(rerunSuccessMessage(provider, failedOnly));
    } catch (e) {
      toastError(e);
    }
  }

  async function doCancel(runId: number) {
    try {
      await cancel.mutateAsync(runId);
      toast.success(cancelStartedMessage(provider));
    } catch (e) {
      toastError(e);
    }
  }

  function runAgain(workflowId: number | null) {
    setDialogWorkflow(workflowId === null ? null : String(workflowId));
    setRunOpen(true);
  }

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());
  useHotkeyAction(
    "run-workflow",
    () => runAgain(null),
    active && canDispatch && ghReady && !writeBlocked,
  );
  useHotkeyAction(
    "clear-run-filters",
    clearFacets,
    active && anyFacetActive(facets),
  );
  useHotkeyAction(
    "toggle-workflows-section",
    () => setWorkflowsCollapsed((v) => !v),
    active && workflowsShown,
  );

  const query = filterText.trim().toLowerCase();
  const allRuns = dedupeRuns(runs.data?.pages);
  // Page one's snapshot of the provider's total; null where the provider reports
  // none (GitLab), which the count line then omits rather than guessing.
  const totalCount = runs.data?.pages[0]?.totalCount ?? null;
  const visible = allRuns.filter(
    (r) =>
      !query ||
      r.displayTitle.toLowerCase().includes(query) ||
      r.workflowName.toLowerCase().includes(query) ||
      r.headBranch.toLowerCase().includes(query),
  );
  const windowed =
    totalCount !== null &&
    windowApplies(provider, filters) &&
    totalCount > FILTERED_RUN_WINDOW;
  const shownTotal = windowed
    ? `${FILTERED_RUN_WINDOW.toLocaleString()}+`
    : totalCount?.toLocaleString();

  const listArm: ListArm = (() => {
    switch (true) {
      case forge.isPending:
        return "probe";
      case !ghReady:
        return "not-ready";
      // Parked with nothing to show: a skeleton would spin until reconnect,
      // and a Refresh would only park again. A loaded-empty list keeps its
      // empty state below, being a loaded answer.
      case runs.isPaused &&
        (runs.isPending || (runs.isError && allRuns.length === 0)):
        return "offline";
      // A facet change whose placeholder holds no rows shows the skeleton,
      // never a blank region or an empty state the new read hasn't given.
      case runs.isPending ||
        (runs.isError && allRuns.length === 0 && runs.isFetching) ||
        (runs.isPlaceholderData && allRuns.length === 0):
        return "loading";
      // Only when there is nothing to show: a failed Load more also flips isError
      // while every already-loaded page survives in the cache, and that failure
      // belongs on the Load-more row rather than replacing the whole list.
      case refreshFailed(runs) && allRuns.length === 0:
        return "failed";
      case visible.length > 0:
        return "rows";
      case allRuns.length > 0:
        return "no-text-match";
      case facetActive:
        return "no-facet-match";
      default:
        return "empty";
    }
  })();
  // A read the filters made fail offers Clear filters: Refresh can't change a
  // value the provider refuses. Either arm's Clear filters unmounts on press.
  const failedFiltered = listArm === "failed" && facetActive;
  const clearRescue = useRetryFocusRescue(
    listArm === "no-facet-match" || failedFiltered,
  );

  // A facet change scrolls the list to the top and arms one announcement for
  // when its read settles; a repo switch arms nothing (its facets derive empty).
  const filtersKey = filtersSignature(filters);
  // This branch before the branch read lands: its filters move when the read
  // does, which is not the user's change.
  const branchPending = branchPressed && status.isPending;
  const lastFilters = useRef({
    repo: repoPath,
    key: filtersKey,
    pending: branchPending,
  });
  const announceArm = useRef<{ repo: string; key: string } | null>(null);
  // Each settle mounts a fresh node, so a repeat of the last text still lands
  // as an addition the live region announces.
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  useEffect(() => {
    const prev = lastFilters.current;
    lastFilters.current = {
      repo: repoPath,
      key: filtersKey,
      pending: branchPending,
    };
    if (prev.repo === repoPath && prev.key === filtersKey) return;
    if (prev.repo !== repoPath || prev.pending) {
      announceArm.current = null;
      return;
    }
    const viewport = scrollRoot.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) viewport.scrollTop = 0;
    announceArm.current = { repo: repoPath, key: filtersKey };
  }, [repoPath, filtersKey, branchPending]);
  const settled = runs.isSuccess && !runs.isPlaceholderData;
  const settleFailed = refreshFailed(runs);
  const countNoun = ciRunNoun(provider);
  const runsNoun = RUNS_PLURAL[countNoun];
  const settledText = (() => {
    switch (true) {
      case settleFailed:
        return facetActive
          ? `Couldn't load ${runNoun} runs with these filters`
          : `Couldn't load ${runNoun} runs`;
      case allRuns.length === 0 && facetActive:
        return `No ${runsNoun} match these filters`;
      case totalCount !== null:
        return windowed
          ? runCountText(FILTERED_RUN_WINDOW, countNoun, true)
          : runCountText(totalCount, countNoun);
      default:
        return runCountText(allRuns.length, countNoun, runs.hasNextPage);
    }
  })();
  // Consumed once per facet change, so polls and Load more stay silent. A
  // failed read speaks too: the last count would describe the old filters.
  useEffect(() => {
    const arm = announceArm.current;
    if (
      !arm ||
      arm.repo !== repoPath ||
      arm.key !== filtersKey ||
      !(settled || settleFailed)
    )
      return;
    announceArm.current = null;
    setAnnouncement((a) => ({ text: settledText, seq: a.seq + 1 }));
  }, [repoPath, filtersKey, settled, settleFailed, settledText]);

  // Loaded rows outlive a failed or parked refresh, under a line saying which. A
  // failed Load more also sets isError, but it keeps its own line on the
  // Load-more row, so only a failed refresh speaks for the whole list.
  const notice =
    ghReady && allRuns.length > 0
      ? listNotice({
          noun: `${runNoun} runs`,
          failed: refreshFailed({
            isError: runs.isError && !runs.isFetchNextPageError,
            isPaused: runs.isPaused,
            isFetching: runs.isFetching,
          }),
          offline: runs.isPaused,
          placeholder: runs.isPlaceholderData,
          hasRows: true,
          loadMoreFailed: false,
        })
      : null;
  // Offline mounts no Retry: a retry while offline parks again at once, and
  // reconnecting resumes the read by itself.
  const noticeRetry: Record<ListNoticeCause, (() => void) | undefined> = {
    refresh: () => void runs.refetch(),
    "load-more": () => void runs.fetchNextPage(),
    offline: undefined,
  };

  const onListKeyDown = listKeyboardNav({
    items: visible,
    activeIndex: visible.findIndex((r) => r.id === selectedRunId),
    onActivate: (run) => selectRun(run.id),
    rowKey: (run) => String(run.id),
  });

  // One shared context menu for the whole list (capture phase, so it records the
  // right-clicked row before Base UI's trigger opens the menu). Right-clicking a
  // run selects it — standard desktop behavior — so the menu and the detail pane
  // always describe the same run; blank space gets no menu.
  function handleContextMenu(e: MouseEvent) {
    const id = (e.target as HTMLElement)
      .closest("[data-row]")
      ?.getAttribute("data-row");
    const run = id ? visible.find((r) => String(r.id) === id) : undefined;
    if (!run) {
      setMenuRun(null);
      suppressContextMenu(e);
      return;
    }
    selectRun(run.id);
    setMenuRun(run);
  }

  const list = (() => {
    switch (listArm) {
      case "probe":
        return (
          // After a failed probe each retry flips error ↔ skeleton, so 1 row.
          <ListRowSkeletons
            rows={forge.errorUpdateCount > 0 ? 1 : RUN_SKELETON_ROWS}
            lines={3}
            name={ciFeature}
          />
        );
      case "not-ready":
        return (
          <ForgeNotReady
            repoPath={repoPath}
            feature={ciFeature}
            retryRef={forgeRescue.retryRef}
          />
        );
      case "offline":
        return (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {offlinePendingMessage(`${runNoun} runs`)}
          </p>
        );
      case "loading":
        return (
          <ListRowSkeletons
            rows={RUN_SKELETON_ROWS}
            lines={3}
            name={ciFeature}
          />
        );
      case "failed":
        return failedFiltered ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              Couldn't load {runNoun} runs with these filters. Refresh to try
              again, or clear them.
            </p>
            <Button
              ref={clearRescue.retryRef}
              variant="outline"
              size="xs"
              onClick={clearFacets}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            Couldn't load {runNoun} runs. Refresh to try again.
          </p>
        );
      case "no-text-match":
        return (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            No {runsNoun} match this search.
          </p>
        );
      case "no-facet-match":
        return (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              No {runsNoun} match these filters.
            </p>
            <Button
              ref={clearRescue.retryRef}
              variant="outline"
              size="xs"
              onClick={clearFacets}
            >
              Clear filters
            </Button>
          </div>
        );
      case "empty":
        return (
          <Empty className="min-h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlayIcon />
              </EmptyMedia>
              <EmptyTitle>No {runNoun} runs yet</EmptyTitle>
              <EmptyDescription>
                {isPipelines
                  ? isGitLab
                    ? "Pipelines run on pushes and merge requests — runs land here as they happen."
                    : "Pipelines run on pushes and pull requests — runs land here as they happen."
                  : "GitHub Actions workflows run on pushes and pull requests — runs land here as they happen."}
              </EmptyDescription>
            </EmptyHeader>
            {canDispatch && (
              <EmptyContent>
                <DisabledReasonButton
                  variant="outline"
                  size="sm"
                  disabled={writeBlocked}
                  reason={writeReason}
                  onClick={() => runAgain(null)}
                >
                  <PlayIcon data-icon="inline-start" />
                  Run {runNoun}…
                </DisabledReasonButton>
              </EmptyContent>
            )}
          </Empty>
        );
      case "rows":
        return (
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div
                  onKeyDown={onListKeyDown}
                  onContextMenuCapture={handleContextMenu}
                />
              }
            >
              {visible.map((run) => {
                const active = run.id === selectedRunId;
                return (
                  <button
                    type="button"
                    key={run.id}
                    data-row={String(run.id)}
                    className={cn(
                      "block w-full border-b px-3 py-2 text-left",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                    onClick={() => selectRun(run.id)}
                    onDoubleClick={() => run.url && openUrl(run.url)}
                  >
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <StatusIcon
                        status={run.status}
                        conclusion={run.conclusion}
                        className="size-3.5"
                      />
                      <span className="truncate" title={run.displayTitle}>
                        {run.displayTitle}
                      </span>
                    </p>
                    <p
                      className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground"
                      onMouseEnter={clipTitleFromText}
                    >
                      {run.workflowName} ·{" "}
                      {statusLabel(run.status, run.conclusion)}
                      {parseableDate(run.updatedAt) && (
                        <>
                          {" · "}
                          <RelativeTime date={run.updatedAt} />
                        </>
                      )}
                    </p>
                    <p
                      className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground"
                      onMouseEnter={clipTitleFromText}
                    >
                      {/* Tag/commit-triggered runs have no branch — the dash
                          keeps the row's three-line height. */}
                      {run.headBranch || <span aria-hidden="true">—</span>}
                    </p>
                  </button>
                );
              })}
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-60">
              {menuRun && (
                <RunContextMenuItems
                  run={menuRun}
                  provider={provider}
                  canRerun={canRerun}
                  canCancel={canCancel}
                  canRunAgain={canDispatch && ghReady}
                  writeBlocked={writeBlocked}
                  writeReason={writeReason}
                  cancelHeld={
                    menuCancel
                      ? pendingItemReason(menuCancel.paused, "cancelling…")
                      : undefined
                  }
                  rerunHeld={
                    menuRerun
                      ? pendingItemReason(menuRerun.paused, "re-running…")
                      : undefined
                  }
                  actions={{
                    rerun: (runId, failedOnly) =>
                      void doRerun(runId, failedOnly),
                    cancel: (runId) => void doCancel(runId),
                    runAgain,
                  }}
                />
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
    }
  })();

  // Placeholder pages belong to the departed filters: their next page is never
  // asked for, so Load more holds until the new read lands.
  const moreHeld = runs.isFetchingNextPage || runs.isPlaceholderData;
  const baseLoaded = baseRuns.data !== undefined && !baseRuns.isPlaceholderData;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container/actions-toolbar flex items-center gap-1 border-b p-2">
        <DisabledReasonButton
          variant={branchPressed ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={branchPressed}
          disabled={!currentBranch}
          reason="No current branch"
          title={
            currentBranch ? `Show runs on ${currentBranch} only` : undefined
          }
          onClick={() =>
            setFacets(
              branchPressed
                ? withoutFacet(facets, "branch")
                : withFacet(facets, "branch", { current: true }),
            )
          }
        >
          This branch
        </DisabledReasonButton>
        <div className="ml-auto flex items-center gap-1">
          {canDispatch && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              aria-label={`Run ${runNoun}…`}
              disabled={!ghReady || writeBlocked}
              reason={runHint}
              title={runHint}
              className={RUN_ICON_ONLY}
              onClick={() => runAgain(null)}
            >
              <PlayIcon data-icon="inline-start" />
              <span data-slot="run-label">Run {runNoun}…</span>
            </DisabledReasonButton>
          )}
          <DisabledReasonButton
            variant="outline"
            size="icon-sm"
            aria-label="Refresh runs"
            disabled={!ghReady || runs.isFetching}
            reason={refreshReason}
            title="Refresh runs"
            // The whole Actions subtree, as the run-detail repair pass does: the
            // open run's detail is its own read, and a refresh that skipped it
            // would leave a failed detail failed beside a recovered list.
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: ["repo", repoPath, "actions"],
              })
            }
          >
            <ArrowClockwiseIcon
              className={cn(runs.isFetching && "animate-spin")}
            />
          </DisabledReasonButton>
          <ManageMenu repoPath={repoPath} provider={provider} />
        </div>
      </div>
      <ManagePaletteActions
        repoPath={repoPath}
        provider={provider}
        active={active}
      />
      <div className="space-y-1.5 border-b p-2">
        <RunFilterChips
          facets={facets}
          provider={provider}
          onRemove={removeFacet}
          onClearAll={clearFacets}
          rowRef={(node) => {
            chipRowRef.current = node;
            return chipRescue.retryRef(node);
          }}
        />
        <div className="flex items-center gap-1">
          <Input
            ref={filterRef}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={
              SEARCH_PLACEHOLDER[isPipelines ? "pipelines" : "workflows"]
            }
            className="h-7 min-w-0 flex-1"
            autoComplete="off"
          />
          <RunFilterPopover
            provider={provider}
            facets={facets}
            currentBranch={currentBranch}
            runs={runs.isPlaceholderData ? [] : allRuns}
            workflows={workflows}
            disabledReason={funnelReason}
            paletteEnabled={active && ghReady}
            triggerRef={(node) => {
              funnelRef.current = node;
              chipRescue.hostRef(node);
              clearRescue.hostRef(node);
            }}
            onPick={(items) => setFacets(items.reduce(withPicked, facets))}
            onUnpick={(kinds) => setFacets(kinds.reduce(withoutFacet, facets))}
          />
        </div>
      </div>
      <p role="status" data-testid="run-facet-announcement" className="sr-only">
        {announcement.text && (
          <span key={announcement.seq}>{announcement.text}</span>
        )}
      </p>

      {/* overflow-hidden: contain the list's natural height (the vendored Root
          is `relative`-only) so a long list can't leak a window scrollbar. */}
      <ScrollArea
        // The host every arm below swaps inside, so a Retry's focus lands here.
        ref={(node) => {
          scrollRoot.current = node;
          forgeRescue.hostRef(node);
          moreRescue.hostRef(node);
        }}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-hidden outline-none"
      >
        {workflowsShown && (
          <WorkflowsSection
            workflows={workflows}
            collapsed={workflowsCollapsed}
            onToggle={() => setWorkflowsCollapsed((v) => !v)}
            showAll={workflowsShowAll}
            onShowAll={() => setWorkflowsShowAll(true)}
            selectedId={facets.workflow?.id}
            onSelect={(w) =>
              setFacets(
                w
                  ? withFacet(facets, "workflow", { id: w.id, name: w.name })
                  : withoutFacet(facets, "workflow"),
              )
            }
            latestRuns={
              baseLoaded ? (baseRuns.data?.pages[0]?.runs ?? []) : undefined
            }
            glyphsMuted={glyphsMuted}
          />
        )}
        {/* The notice is the only word an offline facet change gets, so it
            stays outside the busy region, which mutes live regions within. */}
        <DegradedListNotice
          noun={`${runNoun} runs`}
          degraded={notice !== null}
          message={notice?.message}
          retryLabel={notice?.retryLabel}
          onRetry={notice ? noticeRetry[notice.cause] : undefined}
          className="pt-2"
        />
        <div aria-busy={runs.isPlaceholderData}>
          {list}
          {/* Outside the arms above so a filtered-to-nothing list can still be
              deepened: paging is what brings older matches within reach. Parked,
              the row says so instead: a page asked for offline would only park,
              and reconnecting resumes the read by itself. The list notice already
              says it whenever it shows the park, so the row stays silent then. */}
          {runs.hasNextPage && runs.isPaused && notice?.cause !== "offline" && (
            <p className="border-b px-3 py-1.5 text-center text-xs text-muted-foreground">
              {OFFLINE_ROWS_NOTICE}
            </p>
          )}
          {runs.hasNextPage && !runs.isPaused && (
            <Button
              ref={moreRescue.retryRef}
              variant="ghost"
              size="xs"
              className={cn(
                "h-7 w-full justify-center border-b text-muted-foreground",
                ARIA_DISABLED_CLASS,
              )}
              // Focusable while busy, so a press never drops focus to <body>; the
              // button is the Load more retry too.
              disabled={moreHeld}
              focusableWhenDisabled
              render={heldButtonRender(moreHeld)}
              onClick={() => runs.fetchNextPage()}
            >
              {moreHeld
                ? "Loading…"
                : runs.isFetchNextPageError
                  ? "Couldn't load more — try again"
                  : "Load more"}
              {/* The count describes what was LOADED, which says nothing about a
                  filtered view — it returns when the filter clears. Suppressed on the
                  retry label too: the row says one thing at a time. */}
              {shownTotal !== undefined &&
                !query &&
                !runs.isFetchNextPageError &&
                !runs.isPlaceholderData &&
                ` · Showing ${allRuns.length.toLocaleString()} of ${shownTotal}`}
            </Button>
          )}
        </div>
      </ScrollArea>

      <RunWorkflowDialog
        repoPath={repoPath}
        open={runOpen}
        onOpenChange={(open) => {
          setRunOpen(open);
          // Drop the preselect on close so the next plain open keeps whatever
          // the picker last had, rather than re-forcing this workflow.
          if (!open) setDialogWorkflow(null);
        }}
        defaultRef={currentBranch ?? ""}
        initialWorkflow={dialogWorkflow ?? undefined}
      />
    </div>
  );
}
