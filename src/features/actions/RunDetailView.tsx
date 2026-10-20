import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  PlayIcon,
  ProhibitIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import {
  type QueryClient,
  type UseQueryResult,
  useQueryClient,
} from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { RunDuration } from "@/components/elapsed-time";
import { LogBlock } from "@/components/LogBlock";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime, useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  offlinePendingMessage,
  refreshFailed,
  resolveDetailPane,
  sectionReadNotice,
} from "@/features/conversations/remote-section-state";
import { APPROVE_RUN_CONFIRM } from "@/features/pulls/ChecksRollup";
import { presentError } from "@/lib/error-summary";
import {
  forgeFeatureReady,
  pendingJobState,
  pendingRunState,
  rerunFamilyState,
  useApproveWorkflowRun,
  useForgeStatus,
  usePendingRunWrites,
  useRepoWriteAccess,
  writeAccessReason,
} from "@/lib/git/queries";
import { type ForgeProvider, providerLabel } from "@/lib/git/types";
import type { RunJob } from "@/lib/github/actions";
import {
  isRunActive,
  useCancelRun,
  useJobLogs,
  usePlayCiJob,
  useRerunJob,
  useRerunRun,
  useRunDetail,
  useRunFailedLogs,
} from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  ACT_PENDING_REASON,
  pendingWriteReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { useAiEnabled } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { formatDurationBetween, parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { DebugJobDialog } from "./DebugJobDialog";
import { cachedRunRow, type RunRowSeed } from "./run-row-cache";
import {
  useReportRunSettled,
  useRunSlotInteractive,
  useRunSlotShown,
} from "./run-slots";
import {
  type CiRunNoun,
  cancelLabel,
  cancelOffered,
  cancelStartedMessage,
  ciRunNoun,
  isFailureConclusion,
  isPipelineProvider,
  type JobRerunOffer,
  jobRerunOffer,
  RERUN_TITLES,
  rerunOffers,
  rerunSuccessMessage,
  rerunWindowReason,
  StatusIcon,
  statusLabel,
} from "./status";

/** `gh` writes a short "still in progress" line to the log when a job's archive
 *  isn't ready yet (it briefly races a just-finished job). Detect it so we show
 *  a clean note instead of the raw line. Real logs are far longer. */
function isLogPending(log: string): boolean {
  const t = log.trim();
  return t.length < 300 && /still in progress|will be available/i.test(t);
}

/** How long a started re-run or play waits before re-reading this run. The
 *  mutation's own invalidation races the forge's attempt transition and can
 *  cache the OLD finished attempt — and `useRunDetail` only polls while the run
 *  reads active, so that stale read parks the poll and leaves the view offering
 *  buttons the forge would now refuse. Same rationale and same 4.5s as the PR
 *  checks rollup's repair pass; its constant stays private to that module rather
 *  than exporting pull-request state into this view. */
const RUN_REPAIR_DELAY_MS = 4500;

/** A log pane's line over its read. Loaded log text stays drawn through a
 *  failed or parked refresh, so this only says which; with nothing loaded it
 *  stands in for the log. Mounted whenever the pane shows, so its live region
 *  announces and its wrapper catches a Retry's focus. */
function LogsNotice({
  logs,
}: {
  logs: Pick<
    UseQueryResult<string>,
    "data" | "error" | "isError" | "isPaused" | "isFetching" | "refetch"
  >;
}) {
  // gh's own reason (no access, logs expired) is what tells a permanent failure
  // from one a Retry can fix.
  const reason = logs.error ? presentError(logs.error).summary : "";
  const notice = sectionReadNotice({
    noun: "logs",
    loadFailed: reason
      ? `Couldn't load logs: ${reason}`
      : "Couldn't load logs.",
    // A log is one block, so "rows" is whether it has any text to show.
    rowCount: logs.data === undefined ? undefined : logs.data === "" ? 0 : 1,
    isError: logs.isError,
    isPaused: logs.isPaused,
    isFetching: logs.isFetching,
  });
  return (
    <DegradedListNotice
      noun="logs"
      degraded={notice !== null}
      message={notice?.message}
      retryLabel={notice?.retryLabel}
      onRetry={notice?.retry ? () => void logs.refetch() : undefined}
      className="px-0 pb-1"
    />
  );
}

function JobRow({
  repoPath,
  job,
  stepsExpected = true,
  remoteLabel = "GitHub",
  onDebug,
  onPlay,
  playing = false,
  playDisabledReason,
  onRerun,
  rerunOffer,
  rerunning = false,
  rerunDisabledReason,
}: {
  repoPath: string;
  job: RunJob;
  /** Whether this provider's jobs have steps (GitLab pipelines don't — suppress
   *  the "no step details" placeholder for them; the job is the leaf unit). */
  stepsExpected?: boolean;
  remoteLabel?: string;
  onDebug?: () => void;
  /** Play a manual GitLab job awaiting a manual trigger (GitLab-only). Takes the
   *  button element: this offer retires the moment the job starts, so the parent
   *  needs it to tell whether the click is about to lose focus. */
  onPlay?: (buttonEl: HTMLElement) => void;
  /** Whether the play mutation is running for THIS job, which shows the
   *  spinner; a parked one holds by its reason alone. */
  playing?: boolean;
  /** Set when the viewer may not push or this job's play is pending: the play
   *  button stays visible but disabled, with this text as its hint. */
  playDisabledReason?: string;
  /** Re-run this one finished job (GitHub + GitLab). Takes the button element
   *  for the same reason `onPlay` does — the offer retires on success. */
  onRerun?: (buttonEl: HTMLElement) => void;
  /** The provider's per-job wording — the button renders only with both this and
   *  `onRerun`, so the label can never be spelled at this call site. */
  rerunOffer?: JobRerunOffer;
  /** Whether the re-run mutation is running for THIS job, which shows the
   *  spinner; a parked one holds by its reason alone. */
  rerunning?: boolean;
  /** Set when the viewer may not push or a re-run is pending: the re-run button
   *  stays visible but disabled, with this text as its hint. */
  rerunDisabledReason?: string;
}) {
  // Failed and in-progress jobs are the interesting ones — open them by default.
  const [open, setOpen] = useState(
    isRunActive(job.status) || isFailureConclusion(job.conclusion),
  );
  const [showLogs, setShowLogs] = useState(false);
  const jobActive = isRunActive(job.status);
  // The archived log only exists once the job finishes, so don't fetch while it
  // runs (gh would just return a "still in progress" line).
  const logs = useJobLogs(repoPath, job, open && showLogs && !jobActive);
  const jobRunning = jobActive && !!job.startedAt;
  const jobSince = new Date(job.startedAt).getTime();
  const elapsed = formatDurationBetween(job.startedAt, job.completedAt);

  // Auto-reveal the (now archived) logs the moment a job we're watching finishes.
  const wasActive = useRef(jobActive);
  useEffect(() => {
    if (wasActive.current && !jobActive && open) setShowLogs(true);
    wasActive.current = jobActive;
  }, [jobActive, open]);

  // The archive briefly races a just-finished job; poll until it's ready.
  const pendingLog =
    !jobActive && showLogs && !!logs.data && isLogPending(logs.data);
  const refetchLogs = logs.refetch;
  useEffect(() => {
    if (!pendingLog) return;
    const t = setTimeout(() => void refetchLogs(), 3000);
    return () => clearTimeout(t);
  }, [pendingLog, refetchLogs]);

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center hover:bg-muted/60">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <StatusIcon status={job.status} conclusion={job.conclusion} />
          <span className="min-w-0 flex-1 truncate font-medium">
            {job.name}
          </span>
          <RunDuration
            running={jobRunning}
            since={jobSince}
            elapsed={elapsed}
            className="shrink-0 text-[11px] text-muted-foreground"
          />
        </button>
        {onPlay && (
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            wrapperClassName="mr-2"
            className="text-muted-foreground"
            disabled={playing || !!playDisabledReason}
            reason={playDisabledReason}
            aria-label={`Run job ${job.name}`}
            onClick={(e) => onPlay(e.currentTarget)}
          >
            {playing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Run job
          </DisabledReasonButton>
        )}
        {onRerun && rerunOffer && (
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            wrapperClassName="mr-2"
            className="text-muted-foreground"
            disabled={rerunning || !!rerunDisabledReason}
            reason={rerunDisabledReason}
            title={rerunOffer.title}
            // The accessible name adds the job to the visible label and keeps
            // that label inside it (WCAG 2.5.3).
            aria-label={`${rerunOffer.label} ${job.name}`}
            onClick={(e) => onRerun(e.currentTarget)}
          >
            {rerunning ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowClockwiseIcon data-icon="inline-start" />
            )}
            {rerunOffer.label}
          </DisabledReasonButton>
        )}
        {onDebug && (
          <Button
            variant="ghost"
            size="xs"
            className="mr-2 shrink-0 text-muted-foreground"
            onClick={onDebug}
          >
            <SparkleIcon data-icon="inline-start" />
            Debug with AI
          </Button>
        )}
      </div>
      {open && job.steps.length > 0 && (
        <ul className="pb-1">
          {job.steps.map((step) => {
            const stepRunning =
              step.status === "in_progress" && !!step.startedAt;
            const stepSince = new Date(step.startedAt).getTime();
            const stepElapsed = formatDurationBetween(
              step.startedAt,
              step.completedAt,
            );
            // Deep-link to the step's log section on GitHub (its own steps UI).
            const href = job.url ? `${job.url}#step:${step.number}:1` : null;
            const inner = (
              <>
                <StatusIcon
                  status={step.status}
                  conclusion={step.conclusion}
                  className="size-3.5"
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {step.name}
                </span>
                <RunDuration
                  running={stepRunning}
                  since={stepSince}
                  elapsed={stepElapsed}
                  className="shrink-0 text-[11px] text-muted-foreground"
                />
                {href && (
                  <ArrowSquareOutIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                )}
              </>
            );
            return (
              <li key={`${step.number}:${step.name}`}>
                {href ? (
                  <button
                    type="button"
                    onClick={() => openUrl(href)}
                    title="Open this step's logs on GitHub"
                    className="group flex w-full cursor-pointer items-center gap-2 py-1 pr-3 pl-10 text-left text-xs hover:bg-muted/40"
                  >
                    {inner}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 py-1 pr-3 pl-10 text-xs">
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && stepsExpected && job.steps.length === 0 && (
        <p className="py-1 pr-3 pl-10 text-[11px] text-muted-foreground">
          {isRunActive(job.status)
            ? "Waiting for steps…"
            : "No step details available."}
        </p>
      )}
      {open && (
        <div className="pr-3 pb-2 pl-10">
          {jobActive ? (
            // GitHub's logs API only serves a job's log once it's archived (on
            // completion), so while it runs we point at GitHub's live view
            // instead of showing gh's "still in progress" stderr.
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3" />
                Logs appear here when this job finishes.
              </span>
              {job.url && (
                <button
                  type="button"
                  onClick={() => openUrl(job.url)}
                  className="inline-flex cursor-pointer items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                >
                  <ArrowSquareOutIcon className="size-3" />
                  Watch live on {remoteLabel}
                </button>
              )}
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowLogs((v) => !v)}
                className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showLogs ? "Hide logs" : "Show logs"}
              </button>
              {showLogs && (
                <div className="mt-1.5">
                  <LogsNotice logs={logs} />
                  {logs.data === undefined ? (
                    logs.isPending &&
                    !logs.isPaused && (
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Spinner /> Loading logs…
                      </div>
                    )
                  ) : pendingLog ? (
                    <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Spinner className="size-3" />
                      Logs are being archived — this can take a moment.
                    </p>
                  ) : (
                    <LogBlock text={logs.data} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** What a loading frame's controls say while a run switch loads, in the
 *  provider's own noun. Matches the frame's `ListRowSkeletons` status, which
 *  composes "Loading {name}…" from the same noun. */
function runSwitchLoadingReason(noun: CiRunNoun): string {
  return `Loading this ${noun}…`;
}

/** GitHub holds a first-time contributor's fork-PR run until a maintainer
 *  approves it. Which field carries that state is unverified, so accept it on
 *  either; a run that never reports it never shows the strip. Shared by the
 *  loaded view and its loading frame so the two can't drift. */
function approvalPendingFor(
  provider: ForgeProvider | null | undefined,
  status: string,
  conclusion: string,
): boolean {
  return (
    provider === "github" &&
    (status === "action_required" || conclusion === "action_required")
  );
}

/** This run's row in any cached runs list of the repo, for the loading frame's
 *  header. Placeholder data lives on observers, never in a query's state, so a
 *  borrowed placeholder can't read as a row. */
function readCachedRunRow(
  queryClient: QueryClient,
  repoPath: string,
  runId: number,
): RunRowSeed | undefined {
  const entries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["repo", repoPath, "actions"] })
    .map((query) => ({
      key: query.queryKey,
      data: query.state.data,
      dataUpdatedAt: query.state.dataUpdatedAt,
    }));
  return cachedRunRow(entries, runId);
}

/**
 * The run's header: status, title, meta line, and the action row ending in
 * View on <remote>. The loaded view and its loading frame render it at the same
 * place under the host, so a header button keeps its node (and focus) through
 * the land, and a frame seeded from a cached row already has the loaded
 * geometry (a stale row may still re-wrap its meta or swap an offer at the
 * land). Without `run` (no cached row) the status, title and meta are
 * skeletons of a typical width.
 */
function RunHeader({
  run,
  noun,
  actions,
  viewOn,
  viewOnRef,
}: {
  run: RunRowSeed | undefined;
  /** The provider's CI noun, for the header's own copy. */
  noun: CiRunNoun;
  /** The leading Cancel or re-run offers. */
  actions: ReactNode;
  viewOn: {
    remoteLabel: string;
    disabled: boolean;
    reason: string;
    onClick?: () => void;
  };
  /** The view's keyless focus anchor (`handOffJobFocus`). A top-level prop:
   *  React Compiler refuses a ref read off an object during render. */
  viewOnRef: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="border-b p-4">
      <div className="flex items-start gap-2">
        {run === undefined ? (
          <Skeleton
            aria-hidden
            className="mt-0.5 size-5 shrink-0 rounded-full"
          />
        ) : (
          <StatusIcon
            status={run.status}
            conclusion={run.conclusion}
            className="mt-0.5 size-5"
          />
        )}
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-sm font-semibold"
            title={run?.displayTitle}
          >
            {run === undefined ? (
              <Skeleton
                aria-hidden
                className="inline-block h-4 w-80 max-w-full align-middle"
              />
            ) : (
              run.displayTitle
            )}
          </h2>
          {run === undefined ? (
            // A div, since the skeleton bar is one and can't nest in a <p>; the
            // classes give it the meta line's box.
            <div className="mt-0.5 text-xs text-muted-foreground">
              <Skeleton
                aria-hidden
                className="inline-block h-3 w-64 max-w-full align-middle"
              />
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {run.workflowName} · #{run.number} · {run.headBranch} ·{" "}
              {run.event} · {statusLabel(run.status, run.conclusion)}
              {parseableDate(run.createdAt) && (
                <>
                  {" · "}
                  <RelativeTime date={run.createdAt} />
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions}
        <DisabledReasonButton
          ref={viewOnRef}
          variant="ghost"
          size="sm"
          wrapperClassName="ml-auto"
          className="cursor-pointer"
          disabled={viewOn.disabled}
          reason={viewOn.reason}
          title={`Open this ${noun} on ${viewOn.remoteLabel}`}
          onClick={viewOn.onClick}
        >
          <ArrowSquareOutIcon data-icon="inline-start" />
          View on {viewOn.remoteLabel}
        </DisabledReasonButton>
      </div>
    </div>
  );
}

/** GitHub's wait-for-approval strip. A persistent state belongs in the layout
 *  flow: it pushes the jobs list down rather than floating over the header. */
function RunApprovalStrip({
  disabled,
  reason,
  busy,
  onApprove,
}: {
  disabled: boolean;
  reason: string | undefined;
  busy: boolean;
  onApprove?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b bg-warning/10 px-4 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-warning">
        <WarningIcon weight="fill" className="size-3.5 shrink-0" />
        GitHub is waiting for a maintainer to approve this workflow run before
        it starts.
      </span>
      <DisabledReasonButton
        variant="outline"
        size="sm"
        disabled={disabled}
        reason={reason}
        onClick={onApprove}
      >
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        Approve and run
      </DisabledReasonButton>
    </div>
  );
}

/** The loading frame's twins of the loaded action row: the same offer
 *  builders and render gates, every button disabled with the frame's reason.
 *  Same shapes and keys as the loaded row, so a surviving button keeps its node
 *  through the land. */
function frameRunActions({
  provider,
  row,
  canCancel,
  canRerun,
  reason,
}: {
  provider: ForgeProvider | null | undefined;
  row: RunRowSeed;
  canCancel: boolean;
  canRerun: boolean;
  reason: string;
}): ReactNode {
  if (cancelOffered(provider, row.status, row.conclusion)) {
    return (
      canCancel && (
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled
          reason={reason}
        >
          <ProhibitIcon data-icon="inline-start" />
          {cancelLabel(provider)}
        </DisabledReasonButton>
      )
    );
  }
  return (
    canRerun &&
    rerunOffers(provider, row.status, row.conclusion).map((offer) => (
      <DisabledReasonButton
        key={offer.kind}
        variant="outline"
        size="sm"
        disabled
        reason={reason}
        title={RERUN_TITLES[offer.kind]}
      >
        <ArrowClockwiseIcon data-icon="inline-start" />
        {offer.label}
      </DisabledReasonButton>
    ))
  );
}

/**
 * The run view's loading frame under its `RunHeader`: the jobs section's own
 * chrome, so when the run lands only the count and the rows fill in. `notice`
 * stands in for the rows when the read failed or parked under a cached row's
 * header.
 */
function RunLoadingFrame({
  noun,
  notice,
}: {
  noun: CiRunNoun;
  notice: ReactNode;
}) {
  const shown = useRunSlotShown();
  return (
    <ScrollArea className="min-h-0 flex-1 overflow-hidden">
      <div className="p-4">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Jobs</h3>
        {notice ?? (
          <div className="border">
            {/* Remounted when the slot shows: a status inserted while the slot
                prepares out of sight isn't reliably announced. */}
            <ListRowSkeletons
              key={shown ? "shown" : "hidden"}
              rows={3}
              lines={1}
              name={`this ${noun}`}
            />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

export function RunDetailView({
  repoPath,
  runId,
  active: tabActive,
}: {
  repoPath: string;
  runId: number;
  /** Whether the Actions tab is visible — gates polling while hidden. Renamed
   *  locally to avoid clashing with the run's own `active` (is-in-flight) flag. */
  active: boolean;
}) {
  const detail = useRunDetail(repoPath, runId, tabActive);
  const rerun = useRerunRun(repoPath);
  const cancel = useCancelRun(repoPath);
  const playJob = usePlayCiJob(repoPath);
  const rerunJob = useRerunJob(repoPath);
  const approveRun = useApproveWorkflowRun(repoPath);
  // False while this run is held or preparing in the Actions tab's two-slot
  // host, or isn't the live selection yet: it gates the global hotkeys `inert`
  // misses and closes the debug dialog for good (below).
  const interactive = useRunSlotInteractive();
  const aiEnabled = useAiEnabled();
  // Re-run and cancel are SHARED writes (GitHub + GitLab): `canWrite || …` keeps
  // GitHub's controls up while forge-status is pending and positively enables a
  // ready GitLab repo. Which re-runs each provider offers comes from
  // `rerunOffers`; these flags only decide whether the group renders at all.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const canWrite = !isPipelineProvider(provider);
  const canRerun = canWrite || forgeFeatureReady(forge.data, "ciRerun");
  const canCancel = canWrite || forgeFeatureReady(forge.data, "ciCancel");
  // Playing a manual job is GitLab-only (no GitHub analogue here), so the flag
  // alone gates — never `canWrite || …`. With the gate GitHub never matches the
  // manual-job shape anyway.
  const canPlay = forgeFeatureReady(forge.data, "ciJobPlay");
  // Re-running ONE job is a shared write, so this flag reads like re-run/cancel
  // above. It isn't what gates the offer while the probe is pending, though: the
  // button's own wording comes from `provider`, which is undefined until the
  // probe answers, so on EVERY provider the offer arrives a beat after the
  // run-level ones — cosmetic.
  const canRerunJob = canWrite || forgeFeatureReady(forge.data, "ciJobRerun");
  const jobOffer = jobRerunOffer(provider);
  // Re-run and cancel are repo writes: an explicitly read-only viewer keeps the
  // buttons (disabled, with the reason). CI is repo-wide — no lens.
  const writeAccess = useRepoWriteAccess(
    repoPath,
    undefined,
    tabActive && !!provider,
  );
  const writeReason = writeAccessReason(writeAccess.data);
  const writeBlocked = writeAccess.data?.canPush === false;
  const remoteLabel = providerLabel(provider);
  // GitLab pipelines and Bitbucket steps carry no per-job step list; only GitHub
  // jobs do — so the steps placeholder is suppressed for both.
  const stepsExpected = !isPipelineProvider(provider);
  const [debugJob, setDebugJob] = useState<RunJob | null>(null);
  // Dialog visibility is tracked separately from the debug session so closing
  // the dialog just hides it (the run keeps streaming) and reopening resumes.
  const [debugOpen, setDebugOpen] = useState(false);
  // Closes for good once this run stops being interactive (held, preparing, or
  // no longer the live selection), a render-time adjustment: an open portal
  // would act on the run the user left, a lag-only hide would flicker it back,
  // and returning within the bound must not re-pop it.
  if (!interactive && debugOpen) setDebugOpen(false);
  const [showLogs, setShowLogs] = useState(false);
  const logs = useRunFailedLogs(repoPath, runId, showLogs);
  // Jobs re-run from this view, each against the completion it carried at the
  // click. The offer returns only on EVIDENCE of a new finished attempt — a
  // different completion, which on both forges means a different job id — never
  // on observing a transient; `checks-rerun.ts`'s latch states the rule in full.
  // It holds the window where a refetch that loses to the forge's attempt
  // transition hands back the OLD failed job, which GitHub would refuse and
  // GitLab would honour by minting a second retry. A stale entry orphans once
  // the new attempt lands, and dies with this view.
  const [recentlyRerunJobs, setRecentlyRerunJobs] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  // …and the run-wide half of the same latch: the completion signature this run
  // carried when any re-run started here. The per-job map retires ONE re-offered
  // job; this retires the whole family, so a stale snapshot can't re-offer the
  // run-level buttons or a SIBLING failed job of the attempt just restarted.
  const [runRerunLatch, setRunRerunLatch] = useState<string | null>(null);
  // The re-run family's synchronous edge: `isPending` is render state behind
  // batched notifications, so two activations inside one pre-render window both
  // pass it. (The rollup gets the same edge from its `rerunning`/`rerunningJob`
  // state, set before its first await.)
  const rerunLockRef = useRef(false);
  // Where a job action's focus goes when its own button dies with the offer.
  // The header's "View on <remote>" is the one control that renders for every
  // run whatever its status, and it stays focusable even URL-less (its reason
  // takes `focusableWhenDisabled`) — the only keyless anchor on this view.
  const viewOnRemoteRef = useRef<HTMLButtonElement>(null);

  /** Hand focus to the header after a job action whose button retires on
   *  success (play, per-job re-run): the awaited refetch flips the run active or
   *  mints a new job id, and the row's button unmounts under the user. Never
   *  overrides a move made during the await. */
  function handOffJobFocus(buttonEl: HTMLElement, fromButton: boolean) {
    const unclaimed =
      document.activeElement === document.body ||
      document.activeElement === buttonEl;
    if (fromButton && unclaimed) viewOnRemoteRef.current?.focus();
  }

  // One pending repair — this view holds exactly one run, so a second start
  // inside the window re-arms the same timer rather than accumulating ids: the
  // keys it invalidates are identical either way, and a plain re-arm can never
  // drop a repair without replacing it. It deliberately outlives an unmount,
  // like the rollup's: the invalidation is global and idempotent whether or not
  // this view is still mounted.
  const queryClient = useQueryClient();
  const repairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Re-read this run once a started attempt has had time to transition. */
  function scheduleRunRepair() {
    if (repairTimer.current !== null) clearTimeout(repairTimer.current);
    repairTimer.current = setTimeout(() => {
      repairTimer.current = null;
      // The same subtree the mutations' own `onSettled` invalidates — this run's
      // detail, every runs-list shape, the header's latest badge. A narrower
      // pass can't be written from here: the list keys carry the panel's branch
      // filter, which this view never sees. Unawaited, like the mutation's pass.
      void queryClient.invalidateQueries({
        queryKey: ["repo", repoPath, "actions"],
      });
    }, RUN_REPAIR_DELAY_MS);
  }

  const run = detail.data;
  const active = run ? isRunActive(run.status) : false;
  const failed = run ? isFailureConclusion(run.conclusion) : false;
  // This run's completion signature — the run-detail analogue of the rollup's
  // `failedRunSignatures`. Every job's `completedAt`, sorted: a new attempt
  // re-mints every job, so any movement here is evidence the attempt turned
  // over. Empty completions count — they move too once the new attempt lands.
  const runSignature = run
    ? run.jobs
        .map((j) => j.completedAt)
        .sort()
        .join(" ")
    : "";
  // Both latches are the rollup's evidence-keyed construction, stated in full on
  // `checks-rerun.ts`: release is a MOVED signature, never the observation of a
  // transient, so a refetch that never sees the pending window can neither free
  // nor strand the offer.
  const runLatched = runRerunLatch !== null && runRerunLatch === runSignature;
  // ONE busy notion for the re-run FAMILY — the run-level re-runs and the
  // per-job ones act on the same run, so an overlapping submission just buys the
  // forge's mid-run refusal. Play, cancel and approve are different operations
  // and keep their own. The running control holds with its own in-flight reason,
  // never none: a disabled control without a reason drops focus.
  // Read from the mutation cache by this run's id, so a write started on another
  // surface, or by an earlier mount of this view, holds here too. Its `paused`
  // explains the same entry its presence holds by.
  const runWrites = usePendingRunWrites(repoPath);
  const runState = pendingRunState(runWrites, runId);
  const rerunFamily = rerunFamilyState(runState);
  const rerunFamilyBusy = rerunFamily !== undefined;
  const cancelPending = runState?.cancel;
  // GitHub refuses a re-run once the run is past its window; the run-level and
  // per-job offers stay up, held with the reason.
  const now = useRelativeNow();
  const rerunAgedOut = rerunWindowReason(provider, run?.createdAt, now);
  const rerunHeldReason = (() => {
    switch (true) {
      case writeReason !== undefined:
        return writeReason;
      case rerunFamily !== undefined:
        return pendingWriteReason(
          rerunFamily.paused,
          "A re-run is already in flight…",
        );
      case runLatched:
        return "Re-run already started — waiting for the new attempt…";
      default:
        return rerunAgedOut;
    }
  })();
  // Which re-runs this provider offers for this run, and whether Cancel applies
  // — shared with the runs-list context menu so the offers and their wording
  // stay identical on both surfaces.
  const rerunChoices = run
    ? rerunOffers(provider, run.status, run.conclusion)
    : [];
  const showCancel = run
    ? cancelOffered(provider, run.status, run.conclusion)
    : false;
  const approvalPending =
    run !== undefined &&
    approvalPendingFor(provider, run.status, run.conclusion);
  // Approving starts the contributor's code, so it holds offline as its prompt
  // does; cancel and the re-runs may park, and say so on their controls.
  const offlineHold = useOfflineHold();
  // From the cache like cancel's, so an approval started on the PR checks or by
  // an earlier mount of this view holds Approve here too.
  const approvePending = runState?.approve;
  const canApprove =
    tabActive &&
    approvalPending &&
    !writeBlocked &&
    approvePending === undefined &&
    !offlineHold;
  const approveHeldReason =
    writeReason ??
    (approvePending
      ? pendingWriteReason(approvePending.paused, ACT_PENDING_REASON)
      : offlineHold);

  // Awaited, not per-call callbacks: this view is keyed per run and unmounts once
  // another selected run takes its slot, and react-query drops per-call callbacks
  // once the observer has no listeners.
  async function doRerun(failedOnly: boolean) {
    if (rerunFamilyBusy) return;
    if (rerunLockRef.current) return;
    rerunLockRef.current = true;
    try {
      await rerun.mutateAsync({ runId, failed: failedOnly });
      toast.success(rerunSuccessMessage(provider, failedOnly));
      // Latch only where the re-run mutates THIS run: GitHub re-attempts and
      // GitLab retries move its signature, so the latch releases on that
      // evidence. Bitbucket re-triggers the BRANCH into a fresh pipeline —
      // this run's jobs never change again, so a latch here would never release.
      if (provider !== "bitbucket") setRunRerunLatch(runSignature);
      scheduleRunRepair();
    } catch (e) {
      toastError(e);
    } finally {
      rerunLockRef.current = false;
    }
  }

  async function doCancel() {
    try {
      await cancel.mutateAsync(runId);
      toast.success(cancelStartedMessage(provider));
    } catch (e) {
      toastError(e);
    }
  }

  async function doPlay(jobId: string, buttonEl: HTMLElement) {
    // Read before the first await: the started job stops being manual, so this
    // button is gone by the time the mutation settles.
    const fromButton = document.activeElement === buttonEl;
    try {
      await playJob.mutateAsync(jobId);
      toast.success("Starting job…");
      // A played job flips the run active the same way a re-run does, so it
      // races the same settle.
      scheduleRunRepair();
    } catch (e) {
      toastError(e);
    }
    handOffJobFocus(buttonEl, fromButton);
  }

  async function doRerunJob(
    job: RunJob,
    offer: JobRerunOffer,
    buttonEl: HTMLElement,
  ) {
    if (rerunFamilyBusy) return;
    if (rerunLockRef.current) return;
    rerunLockRef.current = true;
    // Read before the first await: the refetch flips the run active (GitHub) or
    // remounts the row under a new job id (GitLab), either way taking this
    // button with it.
    const fromButton = document.activeElement === buttonEl;
    try {
      // No lens: this is the repo-wide CI surface, like the run-level re-run.
      await rerunJob.mutateAsync({ jobId: job.id, runId });
      toast.success(offer.toast);
      setRecentlyRerunJobs((prev) =>
        new Map(prev).set(job.id, job.completedAt),
      );
      setRunRerunLatch(runSignature);
      scheduleRunRepair();
    } catch (e) {
      toastError(e);
    } finally {
      rerunLockRef.current = false;
    }
    handOffJobFocus(buttonEl, fromButton);
  }

  async function doApprove() {
    const ok = await useConfirm.getState().ask(APPROVE_RUN_CONFIRM);
    if (!ok || refuseWhileOffline()) return;
    try {
      await approveRun.mutateAsync({ runId });
      toast.success("Workflow run approved.");
    } catch (e) {
      toastError(e);
    }
  }

  useHotkeyAction(
    "approve-workflow-run",
    () => void doApprove(),
    interactive && canApprove,
  );
  // Palette routes to the primary offer: a full re-run (GitHub) or the single
  // retry/rerun the pipeline forges expose, which ignore the failed-only flag.
  useHotkeyAction(
    "rerun-run",
    () => void doRerun(false),
    interactive &&
      tabActive &&
      !writeBlocked &&
      canRerun &&
      rerunChoices.length > 0 &&
      !rerunFamilyBusy &&
      !runLatched &&
      rerunAgedOut === undefined,
  );
  useHotkeyAction(
    "cancel-run",
    () => void doCancel(),
    interactive &&
      tabActive &&
      !writeBlocked &&
      canCancel &&
      showCancel &&
      cancelPending === undefined,
  );

  // A manual GitLab job arrives as completed + action_required; with the flag
  // gate GitHub never matches (its manual approvals work differently).
  const isManualJob = (job: RunJob) =>
    job.status === "completed" && job.conclusion === "action_required";

  // A loaded run always renders: a failed or parked refresh keeps it on screen
  // under a notice rather than replacing it, open logs included.
  const pane = resolveDetailPane({
    pending: detail.isPending,
    error: detail.isError,
    hasData: run !== undefined,
    paused: detail.isPaused,
    fetching: detail.isFetching,
  });
  const runNoun = ciRunNoun(provider);
  // A pressed Retry resets the never-loaded read to pending, swapping the error
  // for the skeleton. Every arm's root is the same host div, so React keeps that
  // node through the swap and on into the loaded run, and focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(pane === "error");
  // The error and offline arms are final answers, so only the skeleton keeps a
  // preparing slot waiting.
  useReportRunSettled(pane !== "skeleton");

  // The loading frame stands in for this view's run until its detail lands,
  // its header seeded from a cached list row. Read once per run and latched: a
  // list poll landing mid-frame would re-lay the header. Cleared once the run
  // renders.
  const [frameSeed, setFrameSeed] = useState<{
    forRun: number;
    row: RunRowSeed | undefined;
  } | null>(null);
  let seed = frameSeed;
  if (run !== undefined) {
    if (frameSeed !== null) setFrameSeed(null);
  } else if (frameSeed === null || frameSeed.forRun !== runId) {
    seed = {
      forRun: runId,
      row: readCachedRunRow(queryClient, repoPath, runId),
    };
    setFrameSeed(seed);
  }

  if (run === undefined) {
    const row = seed?.row;
    const offlineMessage = offlinePendingMessage(`this ${runNoun}`);
    const loadFailedMessage = `Couldn't load this ${runNoun}.`;
    const retryButton = (
      <Button
        ref={retryRef}
        variant="outline"
        size="sm"
        className="cursor-pointer"
        onClick={() => void detail.refetch()}
      >
        Retry
      </Button>
    );

    // With no cached row there is no header to keep, so a final answer takes
    // the whole pane rather than sitting beside loading bars.
    if (row === undefined && pane === "offline") {
      return (
        <div
          ref={hostRef}
          tabIndex={-1}
          className="p-6 text-center text-sm text-muted-foreground outline-none"
        >
          {offlineMessage}
        </div>
      );
    }
    if (row === undefined && pane === "error") {
      return (
        <div
          ref={hostRef}
          tabIndex={-1}
          className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground outline-none"
        >
          {loadFailedMessage}
          {retryButton}
        </div>
      );
    }

    // The frame's controls never claim a load that isn't running: an offline
    // or failed read says so instead.
    const frame = (() => {
      switch (pane) {
        case "offline":
          return {
            reason: offlineMessage,
            notice: (
              <p className="text-xs text-muted-foreground">{offlineMessage}</p>
            ),
          };
        case "error":
          return {
            reason: loadFailedMessage,
            notice: (
              <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
                {loadFailedMessage}
                {retryButton}
              </div>
            ),
          };
        default:
          return { reason: runSwitchLoadingReason(runNoun), notice: null };
      }
    })();

    // The loaded view's boxes in its order, the empty notice included, so the
    // header keeps its place (and React its nodes) when the run lands.
    return (
      <div
        ref={hostRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-col outline-none"
      >
        <DegradedListNotice noun={`this ${runNoun}`} degraded={false} />
        <RunHeader
          run={row}
          noun={runNoun}
          actions={
            row &&
            frameRunActions({
              provider,
              row,
              canCancel,
              canRerun,
              reason: frame.reason,
            })
          }
          viewOn={{
            remoteLabel,
            disabled: true,
            reason: frame.reason,
          }}
          viewOnRef={viewOnRemoteRef}
        />
        {row !== undefined &&
          approvalPendingFor(provider, row.status, row.conclusion) && (
            <RunApprovalStrip disabled reason={frame.reason} busy={false} />
          )}
        <RunLoadingFrame noun={runNoun} notice={frame.notice} />
      </div>
    );
  }

  const detailFailed = refreshFailed(detail);

  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <DegradedListNotice
        noun={`this ${runNoun}`}
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: runNoun,
          isError: detailFailed,
          stale: false,
        })}
        onRetry={detailFailed ? () => void detail.refetch() : undefined}
        className="shrink-0 border-b px-4 py-1.5"
      />
      <RunHeader
        run={run}
        noun={runNoun}
        actions={
          showCancel
            ? canCancel && (
                <DisabledReasonButton
                  variant="outline"
                  size="sm"
                  disabled={cancelPending !== undefined || writeBlocked}
                  reason={
                    writeReason ??
                    (cancelPending
                      ? pendingWriteReason(
                          cancelPending.paused,
                          ACT_PENDING_REASON,
                        )
                      : undefined)
                  }
                  onClick={doCancel}
                >
                  {cancelPending && !cancelPending.paused ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ProhibitIcon data-icon="inline-start" />
                  )}
                  {cancelLabel(provider)}
                </DisabledReasonButton>
              )
            : canRerun &&
              rerunChoices.map((offer) => {
                // Which of the offers is the one in flight, by the mode its
                // pending write carries.
                const runRerun = runState?.rerun;
                const thisRerunning =
                  runRerun !== undefined &&
                  (offer.kind === "failed" ? runRerun.failed : runRerun.whole);
                return (
                  <DisabledReasonButton
                    key={offer.kind}
                    variant="outline"
                    size="sm"
                    disabled={
                      rerunFamilyBusy ||
                      runLatched ||
                      writeBlocked ||
                      rerunAgedOut !== undefined
                    }
                    reason={
                      thisRerunning
                        ? (writeReason ??
                          pendingWriteReason(
                            runRerun.paused,
                            ACT_PENDING_REASON,
                          ))
                        : rerunHeldReason
                    }
                    title={RERUN_TITLES[offer.kind]}
                    onClick={() => doRerun(offer.kind === "failed")}
                  >
                    {thisRerunning && !runRerun.paused ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <ArrowClockwiseIcon data-icon="inline-start" />
                    )}
                    {offer.label}
                  </DisabledReasonButton>
                );
              })
        }
        viewOn={{
          remoteLabel,
          disabled: !run.url,
          reason: `No URL for this ${runNoun}`,
          onClick: () => run.url && openUrl(run.url),
        }}
        viewOnRef={viewOnRemoteRef}
      />

      {approvalPending && (
        <RunApprovalStrip
          disabled={
            approvePending !== undefined || writeBlocked || !!offlineHold
          }
          reason={approveHeldReason}
          busy={approvePending !== undefined && !approvePending.paused}
          onApprove={() => void doApprove()}
        />
      )}

      {/* overflow-hidden contains the content's natural height (vendored Root is
          `relative`-only) so a long run can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="p-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            Jobs ({run.jobs.length})
          </h3>
          {run.jobs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {active
                ? "Jobs haven't started yet."
                : "No jobs were reported for this run."}
            </p>
          ) : (
            <div className="border">
              {run.jobs.map((job) => {
                // The row's own re-run and play in flight, from any surface.
                const jobWrites = pendingJobState(runWrites, job.id);
                const jobRerun = jobWrites?.rerun;
                const jobPlay = jobWrites?.play;
                return (
                  <JobRow
                    key={job.id}
                    repoPath={repoPath}
                    job={job}
                    stepsExpected={stepsExpected}
                    remoteLabel={remoteLabel}
                    onDebug={
                      aiEnabled && isFailureConclusion(job.conclusion)
                        ? () => {
                            setDebugJob(job);
                            setDebugOpen(true);
                          }
                        : undefined
                    }
                    onPlay={
                      canPlay && isManualJob(job)
                        ? (buttonEl) => void doPlay(job.id, buttonEl)
                        : undefined
                    }
                    playing={jobPlay !== undefined && !jobPlay.paused}
                    playDisabledReason={
                      writeReason ??
                      (jobPlay
                        ? pendingWriteReason(jobPlay.paused, ACT_PENDING_REASON)
                        : undefined)
                    }
                    onRerun={
                      // GitHub refuses a per-job re-run while the run is still in
                      // flight; GitLab accepts one, so only GitHub gates on `active`.
                      // The last two terms are the latches: while a stale
                      // snapshot still reports the attempt that was re-run —
                      // this job's own, or the run's — the offer stays retired.
                      jobOffer &&
                      canRerunJob &&
                      isFailureConclusion(job.conclusion) &&
                      (provider !== "github" || !active) &&
                      !runLatched &&
                      recentlyRerunJobs.get(job.id) !== job.completedAt
                        ? (buttonEl) => void doRerunJob(job, jobOffer, buttonEl)
                        : undefined
                    }
                    rerunOffer={jobOffer ?? undefined}
                    rerunning={jobRerun !== undefined && !jobRerun.paused}
                    rerunDisabledReason={
                      jobRerun
                        ? (writeReason ??
                          pendingWriteReason(
                            jobRerun.paused,
                            ACT_PENDING_REASON,
                          ))
                        : rerunHeldReason
                    }
                  />
                );
              })}
            </div>
          )}

          {failed && (
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowLogs((v) => !v)}
              >
                {showLogs ? "Hide failed logs" : "Show failed logs"}
              </Button>
              {showLogs && (
                <div className="mt-2">
                  <LogsNotice logs={logs} />
                  {logs.data === undefined ? (
                    logs.isPending &&
                    !logs.isPaused && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Spinner /> Loading logs…
                      </div>
                    )
                  ) : (
                    <LogBlock
                      text={logs.data}
                      emptyLabel="No failed logs available."
                      maxHeightClass="max-h-96"
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <DebugJobDialog
        repoPath={repoPath}
        workflowName={run.workflowName}
        job={debugJob}
        open={debugOpen}
        onOpenChange={setDebugOpen}
      />
    </div>
  );
}
