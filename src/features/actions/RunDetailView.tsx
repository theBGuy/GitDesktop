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
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { RunDuration } from "@/components/elapsed-time";
import { LogBlock } from "@/components/LogBlock";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { APPROVE_RUN_CONFIRM } from "@/features/pulls/ChecksRollup";
import {
  forgeFeatureReady,
  useApproveWorkflowRun,
  useForgeStatus,
  useRepoWriteAccess,
  writeAccessReason,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import type { RunJob } from "@/lib/github/actions";
import {
  isRunActive,
  useCancelRun,
  useJobLogs,
  usePlayCiJob,
  useRerunRun,
  useRunDetail,
  useRunFailedLogs,
} from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useAiEnabled } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { formatDurationBetween, parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { DebugJobDialog } from "./DebugJobDialog";
import { isFailureConclusion, StatusIcon, statusLabel } from "./status";

/** `gh` writes a short "still in progress" line to the log when a job's archive
 *  isn't ready yet (it briefly races a just-finished job). Detect it so we show
 *  a clean note instead of the raw line. Real logs are far longer. */
function isLogPending(log: string): boolean {
  const t = log.trim();
  return t.length < 300 && /still in progress|will be available/i.test(t);
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
}: {
  repoPath: string;
  job: RunJob;
  /** Whether this provider's jobs have steps (GitLab pipelines don't — suppress
   *  the "no step details" placeholder for them; the job is the leaf unit). */
  stepsExpected?: boolean;
  remoteLabel?: string;
  onDebug?: () => void;
  /** Play a manual GitLab job awaiting a manual trigger (GitLab-only). */
  onPlay?: () => void;
  /** Whether the play mutation is in flight for THIS job. */
  playing?: boolean;
  /** Set when the viewer may not push: the play button stays visible but
   *  disabled, with this text as its hint. */
  playDisabledReason?: string;
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
            onClick={onPlay}
          >
            {playing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Run job
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
                  {logs.isPending ? (
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Spinner /> Loading logs…
                    </div>
                  ) : logs.isError ? (
                    <p className="text-[11px] text-muted-foreground">
                      Couldn't load logs.
                    </p>
                  ) : pendingLog ? (
                    <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Spinner className="size-3" />
                      Logs are being archived — this can take a moment.
                    </p>
                  ) : (
                    <LogBlock text={logs.data ?? ""} />
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
  const approveRun = useApproveWorkflowRun(repoPath);
  const aiEnabled = useAiEnabled();
  // Re-run and cancel are SHARED writes (GitHub + GitLab): `canWrite || …` keeps
  // GitHub's controls up while forge-status is pending and positively enables a
  // ready GitLab repo. GitLab's retry restarts failed+canceled jobs only, so it
  // gets a single "Retry pipeline" button — "Re-run all jobs" has no GitLab
  // analogue and stays on `canWrite` (GitHub-only). GitLab pipelines also have no
  // per-job steps, so the steps placeholder is suppressed for them.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const canRerun = canWrite || forgeFeatureReady(forge.data, "ciRerun");
  const canCancel = canWrite || forgeFeatureReady(forge.data, "ciCancel");
  // Playing a manual job is GitLab-only (no GitHub analogue here), so the flag
  // alone gates — never `canWrite || …`. With the gate GitHub never matches the
  // manual-job shape anyway.
  const canPlay = forgeFeatureReady(forge.data, "ciJobPlay");
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
  const stepsExpected = provider !== "gitlab" && provider !== "bitbucket";
  const [debugJob, setDebugJob] = useState<RunJob | null>(null);
  // Dialog visibility is tracked separately from the debug session so closing
  // the dialog just hides it (the run keeps streaming) and reopening resumes.
  const [debugOpen, setDebugOpen] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const logs = useRunFailedLogs(repoPath, runId, showLogs);

  const run = detail.data;
  const active = run ? isRunActive(run.status) : false;
  const failed = run ? isFailureConclusion(run.conclusion) : false;
  // GitLab's retry also covers a canceled pipeline (its retry restarts
  // failed + canceled jobs), so the Retry button shows for both conclusions.
  const retryable = failed || run?.conclusion === "cancelled";
  // Bitbucket has no rerun endpoint — "rerun" re-triggers the branch pipeline (a
  // fresh run), which makes sense on ANY finished pipeline (success too). Show it
  // once the run is no longer in flight (a conclusion has been recorded).
  const bitbucketRerunnable =
    provider === "bitbucket" && !active && !!run?.conclusion;
  // A manual/blocked GitLab pipeline maps to completed/action_required, but
  // GitLab's cancel endpoint does cancel it — keep Cancel available there.
  const gitlabBlocked =
    provider === "gitlab" && run?.conclusion === "action_required";
  // GitHub holds a first-time contributor's fork-PR run until a maintainer
  // approves it. Which field carries that state is unverified, so accept it on
  // either — a run that never reports it simply never shows the strip.
  const approvalPending =
    provider === "github" &&
    (run?.status === "action_required" ||
      run?.conclusion === "action_required");
  const canApprove =
    tabActive && approvalPending && !writeBlocked && !approveRun.isPending;

  function doRerun(failedOnly: boolean) {
    rerun.mutate(
      { runId, failed: failedOnly },
      {
        onSuccess: () =>
          toast.success(
            provider === "gitlab"
              ? "Retrying pipeline"
              : provider === "bitbucket"
                ? "Triggering a new pipeline"
                : failedOnly
                  ? "Re-running failed jobs"
                  : "Re-running workflow",
          ),
        onError: toastError,
      },
    );
  }

  function doCancel() {
    cancel.mutate(runId, {
      onSuccess: () => toast.success("Cancelling run…"),
      onError: toastError,
    });
  }

  function doPlay(jobId: number) {
    playJob.mutate(jobId, {
      onSuccess: () => toast.success("Starting job…"),
      onError: toastError,
    });
  }

  async function doApprove() {
    const ok = await useConfirm.getState().ask(APPROVE_RUN_CONFIRM);
    if (!ok) return;
    approveRun.mutate(
      { runId },
      {
        onSuccess: () => toast.success("Workflow run approved."),
        onError: toastError,
      },
    );
  }

  useHotkeyAction("approve-workflow-run", () => void doApprove(), canApprove);

  // A manual GitLab job arrives as completed + action_required; with the flag
  // gate GitHub never matches (its manual approvals work differently).
  const isManualJob = (job: RunJob) =>
    job.status === "completed" && job.conclusion === "action_required";

  if (detail.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (detail.isError || !run) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Couldn't load this run.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <div className="flex items-start gap-2">
          <StatusIcon
            status={run.status}
            conclusion={run.conclusion}
            className="mt-0.5 size-5"
          />
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-sm font-semibold"
              title={run.displayTitle}
            >
              {run.displayTitle}
            </h2>
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
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {active || gitlabBlocked
            ? canCancel && (
                <DisabledReasonButton
                  variant="outline"
                  size="sm"
                  disabled={cancel.isPending || writeBlocked}
                  reason={writeReason}
                  onClick={doCancel}
                >
                  {cancel.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ProhibitIcon data-icon="inline-start" />
                  )}
                  Cancel run
                </DisabledReasonButton>
              )
            : provider === "gitlab"
              ? canRerun &&
                retryable && (
                  <DisabledReasonButton
                    variant="outline"
                    size="sm"
                    disabled={rerun.isPending || writeBlocked}
                    reason={writeReason}
                    title="Restart this pipeline's failed and canceled jobs"
                    onClick={() => doRerun(true)}
                  >
                    <ArrowClockwiseIcon data-icon="inline-start" />
                    Retry pipeline
                  </DisabledReasonButton>
                )
              : provider === "bitbucket"
                ? canRerun &&
                  bitbucketRerunnable && (
                    <DisabledReasonButton
                      variant="outline"
                      size="sm"
                      disabled={rerun.isPending || writeBlocked}
                      reason={writeReason}
                      title="Trigger this pipeline's branch again"
                      onClick={() => doRerun(true)}
                    >
                      <ArrowClockwiseIcon data-icon="inline-start" />
                      Rerun pipeline
                    </DisabledReasonButton>
                  )
                : canWrite && (
                    <>
                      <DisabledReasonButton
                        variant="outline"
                        size="sm"
                        disabled={rerun.isPending || writeBlocked}
                        reason={writeReason}
                        onClick={() => doRerun(false)}
                      >
                        <ArrowClockwiseIcon data-icon="inline-start" />
                        Re-run all jobs
                      </DisabledReasonButton>
                      {failed && (
                        <DisabledReasonButton
                          variant="outline"
                          size="sm"
                          disabled={rerun.isPending || writeBlocked}
                          reason={writeReason}
                          onClick={() => doRerun(true)}
                        >
                          <ArrowClockwiseIcon data-icon="inline-start" />
                          Re-run failed jobs
                        </DisabledReasonButton>
                      )}
                    </>
                  )}
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            wrapperClassName="ml-auto"
            className="cursor-pointer"
            disabled={!run.url}
            reason="No URL for this run"
            title={`Open this run on ${remoteLabel}`}
            onClick={() => run.url && openUrl(run.url)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            View on {remoteLabel}
          </DisabledReasonButton>
        </div>
      </div>

      {approvalPending && (
        // A persistent state belongs in the layout flow: the strip pushes the
        // jobs list down rather than floating over the run header.
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b bg-warning/10 px-4 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-warning">
            <WarningIcon weight="fill" className="size-3.5 shrink-0" />
            GitHub is waiting for a maintainer to approve this workflow run
            before it starts.
          </span>
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={approveRun.isPending || writeBlocked}
            reason={writeReason}
            onClick={() => void doApprove()}
          >
            {approveRun.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Approve and run
          </DisabledReasonButton>
        </div>
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
              {run.jobs.map((job) => (
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
                      ? () => doPlay(job.id)
                      : undefined
                  }
                  playing={playJob.isPending && playJob.variables === job.id}
                  playDisabledReason={writeReason}
                />
              ))}
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
                  {logs.isPending ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner /> Loading logs…
                    </div>
                  ) : logs.isError ? (
                    <p className="text-xs text-muted-foreground">
                      Couldn't load logs.
                    </p>
                  ) : (
                    <LogBlock
                      text={logs.data ?? ""}
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
