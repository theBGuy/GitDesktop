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
import { useQueryClient } from "@tanstack/react-query";
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
  useRerunJob,
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
import {
  cancelLabel,
  cancelOffered,
  cancelStartedMessage,
  isFailureConclusion,
  isPipelineProvider,
  type JobRerunOffer,
  jobRerunOffer,
  RERUN_TITLES,
  rerunOffers,
  rerunSuccessMessage,
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
  /** Whether the play mutation is in flight for THIS job. */
  playing?: boolean;
  /** Set when the viewer may not push: the play button stays visible but
   *  disabled, with this text as its hint. */
  playDisabledReason?: string;
  /** Re-run this one finished job (GitHub + GitLab). Takes the button element
   *  for the same reason `onPlay` does — the offer retires on success. */
  onRerun?: (buttonEl: HTMLElement) => void;
  /** The provider's per-job wording — the button renders only with both this and
   *  `onRerun`, so the label can never be spelled at this call site. */
  rerunOffer?: JobRerunOffer;
  /** Whether the re-run mutation is in flight for THIS job. */
  rerunning?: boolean;
  /** Set when the viewer may not push: the re-run button stays visible but
   *  disabled, with this text as its hint. */
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
  const rerunJob = useRerunJob(repoPath);
  const approveRun = useApproveWorkflowRun(repoPath);
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
  // and keep their own. Each control suppresses the reason on ITSELF while it is
  // the one running: its spinner already says so.
  const rerunFamilyBusy = rerun.isPending || rerunJob.isPending;
  const rerunHeldReason = (() => {
    switch (true) {
      case writeReason !== undefined:
        return writeReason;
      case rerunFamilyBusy:
        return "A re-run is already in flight…";
      case runLatched:
        return "Re-run already started — waiting for the new attempt…";
      default:
        return undefined;
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
  // GitHub holds a first-time contributor's fork-PR run until a maintainer
  // approves it. Which field carries that state is unverified, so accept it on
  // either — a run that never reports it simply never shows the strip.
  const approvalPending =
    provider === "github" &&
    (run?.status === "action_required" ||
      run?.conclusion === "action_required");
  const canApprove =
    tabActive && approvalPending && !writeBlocked && !approveRun.isPending;

  // Awaited, not per-call callbacks: this view is keyed per run and unmounts the
  // moment another run is selected, and react-query drops per-call callbacks once
  // the observer has no listeners.
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
      await rerunJob.mutateAsync({ jobId: job.id });
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
    if (!ok) return;
    try {
      await approveRun.mutateAsync({ runId });
      toast.success("Workflow run approved.");
    } catch (e) {
      toastError(e);
    }
  }

  useHotkeyAction("approve-workflow-run", () => void doApprove(), canApprove);
  // Palette routes to the primary offer: a full re-run (GitHub) or the single
  // retry/rerun the pipeline forges expose, which ignore the failed-only flag.
  useHotkeyAction(
    "rerun-run",
    () => void doRerun(false),
    tabActive &&
      !writeBlocked &&
      canRerun &&
      rerunChoices.length > 0 &&
      !rerunFamilyBusy &&
      !runLatched,
  );
  useHotkeyAction(
    "cancel-run",
    () => void doCancel(),
    tabActive && !writeBlocked && canCancel && showCancel && !cancel.isPending,
  );

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
          {showCancel
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
                  {cancelLabel(provider)}
                </DisabledReasonButton>
              )
            : canRerun &&
              rerunChoices.map((offer) => {
                // Which of the offers is the one running: the guards serialize
                // the family, so at most one mutation is ever in flight and its
                // `variables` still describe it.
                const thisRerunning =
                  rerun.isPending &&
                  rerun.variables?.failed === (offer.kind === "failed");
                return (
                  <DisabledReasonButton
                    key={offer.kind}
                    variant="outline"
                    size="sm"
                    disabled={rerunFamilyBusy || runLatched || writeBlocked}
                    reason={thisRerunning ? undefined : rerunHeldReason}
                    title={RERUN_TITLES[offer.kind]}
                    onClick={() => doRerun(offer.kind === "failed")}
                  >
                    {thisRerunning ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <ArrowClockwiseIcon data-icon="inline-start" />
                    )}
                    {offer.label}
                  </DisabledReasonButton>
                );
              })}
          <DisabledReasonButton
            ref={viewOnRemoteRef}
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
              {run.jobs.map((job) => {
                // The row's own re-run, if it's the family's in-flight one —
                // the guards serialize, so `variables` still describe it.
                const thisJobRerunning =
                  rerunJob.isPending && rerunJob.variables?.jobId === job.id;
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
                    playing={playJob.isPending && playJob.variables === job.id}
                    playDisabledReason={writeReason}
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
                    rerunning={thisJobRerunning}
                    rerunDisabledReason={
                      thisJobRerunning ? undefined : rerunHeldReason
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
