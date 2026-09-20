import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  MinusCircleIcon,
  PlayIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { RunDuration } from "@/components/elapsed-time";
import { LogBlock } from "@/components/LogBlock";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  checksRerunOffer,
  isPipelineProvider,
  RERUN_TITLES,
  rerunSuccessMessage,
  StatusIcon,
  statusLabel,
} from "@/features/actions/status";
import { clipTitle } from "@/lib/clip-title";
import {
  forgeFeatureReady,
  useApproveWorkflowRun,
  useForgeStatus,
  useRepoWriteAccess,
  writeAccessReason,
} from "@/lib/git/queries";
import type { ForgeProvider, PrCheckOut } from "@/lib/git/types";
import {
  isRunActive,
  type RunJob,
  useJobLogs,
  useRerunRun,
  useRunDetail,
  useRunFailedLogs,
} from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useRepoLens } from "@/lib/repo-lens/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { formatDurationBetween } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { checkPresentation, isOutstanding } from "./check-presentation";
import { PR_SWITCH_LOADING_REASON } from "./PrMergeabilityBanner";

/** The one wording for releasing a held workflow run — this strip and the Actions
 *  run view both ask through it, so the two prompts can't drift apart. It lives
 *  here rather than in RunDetailView so sharing it can't pull that view's
 *  AI debug subtree into the pull-request surface. */
export const APPROVE_RUN_CONFIRM = {
  title: "Approve and run workflows?",
  body: "This runs the contributor's workflow code in this repository's CI.",
  confirmLabel: "Approve and run",
} as const;

/** How long a started re-run waits before re-reading the PR's checks. The
 *  mutation's own invalidation races the forge's attempt transition and can cache
 *  an EMPTY rollup, and PR details refetch on focus only — so without this second
 *  pass the checks section stays blank until the window is focused again. */
const CHECKS_REPAIR_DELAY_MS = 4500;

/** A GitHub Actions check that hasn't finished: a parsed run id, GitHub, no
 *  `completedAt`, AND a still-pending status. The bucket check guards a
 *  StatusContext whose `targetUrl` coincidentally parses as an Actions-run URL but
 *  is already SUCCESS/FAILURE with no timestamps — without it such a check reads as
 *  "running". GitLab checks carry run/job ids too but have no steps, so gating on
 *  the provider avoids wasted `forge_ci_run_view` spawns. */
function isRunningActionsCheck(
  check: PrCheckOut,
  provider: ForgeProvider,
): boolean {
  return (
    provider === "github" &&
    Boolean(check.runId) &&
    !check.completedAt &&
    checkPresentation(check.status, provider).bucket === "pending"
  );
}

/** Whether a check is a required context the base branch is still waiting on while
 *  reading as a finished, neutral result — a cancelled or stale run. Genuinely
 *  skipped or neutral runs satisfy GitHub, and failed or pending ones already carry
 *  their own presentation, so this composition is the only one that needs flagging.
 *  A cancelled run superseded by a green re-run of the same name leaves its context
 *  met, so the name is absent from the unmet list and the row stays quiet. */
function needsRequiredAttention(
  check: PrCheckOut,
  checks: PrCheckOut[],
  provider: ForgeProvider,
  unmetRequiredContexts: string[],
): boolean {
  if (
    !unmetRequiredContexts.includes(check.name) ||
    checkPresentation(check.status, provider).bucket !== "skipped" ||
    !isOutstanding(check, provider)
  ) {
    return false;
  }
  // The unmet list names a context, but a failed or still-running run of that name
  // is what the merge is actually waiting on, and it already shows that visibly —
  // so a run this one superseded stays quiet. No self-exclusion needed: the check
  // reaching here is in the skipped bucket.
  return !checks.some((other) => {
    if (other.name !== check.name) return false;
    const { bucket } = checkPresentation(other.status, provider);
    return bucket === "failed" || bucket === "pending";
  });
}

/** The run's job for a check: by job id first (the reliable key), falling back to
 *  matching the job name when the check carries no job id. */
function jobForCheck(
  check: PrCheckOut,
  jobs: RunJob[] | undefined,
): RunJob | undefined {
  if (!jobs) return undefined;
  if (check.jobId) {
    // Compare as strings: `check.jobId` is a string (ids can exceed 2^53) while
    // RunJob.id is still numeric — stringify the numeric side to match.
    const byId = jobs.find((j) => String(j.id) === check.jobId);
    if (byId) return byId;
  }
  return jobs.find((j) => j.name === check.name);
}

/** The step a running job is currently executing (first `in_progress` step), or
 *  null when none has started yet (still "queued"). */
function currentStep(job: RunJob | undefined) {
  return job?.steps.find((s) => s.status === "in_progress") ?? null;
}

/** A GitHub-Actions check's inline log tail (Skeleton → log tail), matching
 *  RunDetailView's `<pre>` idiom. Only mounted while the row is expanded, so the
 *  query fires lazily; the `enabled` gate carries the row-expanded state. */
function CheckLogTail({
  repoPath,
  check,
}: {
  repoPath: string;
  check: PrCheckOut;
}) {
  // A job id gets the per-job log; a run without a job id falls back to the
  // run-wide failed-step logs (same as the Actions panel's failed-logs view).
  // Ids stay *strings* the whole way — they can exceed JS's safe-integer range,
  // so the Actions log path (hooks → forge_ci_*_logs commands) threads them as
  // strings end-to-end rather than narrowing through Number().
  const jobId = check.jobId || null;
  const runId = check.runId || null;
  const jobLogs = useJobLogs(
    repoPath,
    jobId !== null ? { id: jobId } : null,
    true,
  );
  const runLogs = useRunFailedLogs(repoPath, runId, jobId === null);
  const logs = jobId !== null ? jobLogs : runLogs;

  if (logs.isPending) {
    return (
      <div className="mt-1.5 space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  }
  if (logs.isError) {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
        Couldn't load logs.
        {check.detailsUrl && (
          <button
            type="button"
            onClick={() => check.detailsUrl && openUrl(check.detailsUrl)}
            className="inline-flex cursor-pointer items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
          >
            <ArrowSquareOutIcon className="size-3" />
            Open full run
          </button>
        )}
      </p>
    );
  }
  return (
    <LogBlock
      text={logs.data ?? ""}
      maxHeightClass="max-h-72"
      className="mt-1.5"
    />
  );
}

/** The live step checklist for a running GitHub Actions check: one compact row
 *  per step (status glyph + name + duration), shown in the expanded panel instead
 *  of the (mid-run useless) log tail. Real rows render as data arrives — no spinner. */
function RunSteps({ job }: { job: RunJob }) {
  return (
    <div className="mt-1.5 space-y-0.5">
      {job.steps.map((step) => {
        const running = step.status === "in_progress" && !!step.startedAt;
        const since = new Date(step.startedAt).getTime();
        const elapsed = formatDurationBetween(step.startedAt, step.completedAt);
        return (
          <div
            key={step.number}
            className="flex items-center gap-2 text-[11px]"
          >
            {/* The step's state is shape + color alone in the icon, so a
                wrapping role="img" names it (aria-label is not valid, nor
                reliably announced, on a bare `<svg>`). No `title` — announced,
                not hovered, so the row's only tooltip stays the clipped step
                name. StatusIcon takes no aria props; the role prunes its svg
                regardless. */}
            <span
              role="img"
              aria-label={statusLabel(step.status, step.conclusion)}
              className="flex shrink-0 items-center"
            >
              <StatusIcon
                status={step.status}
                conclusion={step.conclusion}
                className="size-3.5"
              />
            </span>
            <span
              className="min-w-0 flex-1 truncate"
              onMouseEnter={clipTitle(step.name)}
            >
              {step.name}
            </span>
            <RunDuration
              running={running}
              since={since}
              elapsed={elapsed}
              className="shrink-0 text-muted-foreground"
            />
          </div>
        );
      })}
    </div>
  );
}

/** One check row: state icon + name + duration + trailing affordance. GitHub
 *  Actions checks (a parsed run id) peek their log inline; external checks link
 *  out; URL-less checks show just name + status. A running Actions check surfaces
 *  its current step inline and its live step checklist when expanded. */
function CheckRow({
  repoPath,
  check,
  provider,
  rowId,
  runJob,
  isRunning,
  requiredAttention,
}: {
  repoPath: string;
  check: PrCheckOut;
  /** The repo's forge provider — only the status label branches on it. */
  provider: ForgeProvider;
  /** Unique row identity (the sorted index) for `data-row` + roving focus —
   *  GitHub allows two checks with the same `name`, so name can't be the id. */
  rowId: string;
  /** The resolved run job for a running Actions check; undefined until run detail
   *  resolves, or for a non-running / non-Actions check. */
  runJob: RunJob | undefined;
  /** Whether this is a still-running GitHub Actions check (drives the inline
   *  current-step peek + the expanded step checklist). */
  isRunning: boolean;
  /** Whether this row is an unmet required context that reads as finished — it
   *  earns a "required" word beside the name. The status presentation stays as it
   *  is: the run really was cancelled, and only the requirement is extra. */
  requiredAttention: boolean;
}) {
  const { tone, Icon, label } = checkPresentation(check.status, provider);
  // The live counter is gated on `isRunning`, never on `check.completedAt`: that
  // field rides usePrDetails (focus-only refetch), so a finished check keeps it
  // empty and the counter would climb forever in a focused window. `isRunning`
  // folds in the 5s-polled run job, the only authority that says a check stopped.
  const runningSince =
    isRunning && check.startedAt ? new Date(check.startedAt).getTime() : null;
  const elapsed = formatDurationBetween(check.startedAt, check.completedAt);
  // "Actions check" = a details URL we parsed a run id out of. A job id peeks
  // one job's log; a run id without a job falls back to the run's failed logs.
  const isActionsCheck = Boolean(check.runId);
  const [logsOpen, setLogsOpen] = useState(false);

  // Running Actions check: the current step's name, shown inline after the check
  // name. `undefined` while run detail hasn't resolved (render nothing — no jump);
  // "queued" once resolved but no step is in progress yet.
  const stepPeek = isRunning
    ? runJob
      ? (currentStep(runJob)?.name ?? "queued")
      : undefined
    : undefined;

  // The row's shared inner content — inside a focusable button for interactive
  // rows, a plain div for a URL-less check.
  const inner = (
    <>
      {isActionsCheck &&
        (logsOpen ? (
          <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />
        ))}
      {/* The state word rides a wrapping span: aria-label is not valid (nor
          reliably announced) on a bare `<svg>`. No `title` — a tooltip here would
          shadow the row's own ("Open this check" / the clipped check name). */}
      <span
        role="img"
        aria-label={label}
        className="flex shrink-0 items-center"
      >
        <Icon className={cn("size-3.5", tone)} weight="fill" aria-hidden />
      </span>
      <span
        className="min-w-0 flex-1 truncate font-medium"
        onMouseEnter={clipTitle(check.name)}
      >
        {check.name}
      </span>
      {requiredAttention && (
        // Visible text, not a tone: the row keeps its muted cancelled glyph, and
        // this word is what says the merge is still waiting on the check.
        <span className="shrink-0 text-muted-foreground">· required</span>
      )}
      {stepPeek !== undefined && (
        // The running check's current step, after the name — muted + truncated so
        // a long step name can't push the row wide (name keeps its flex share).
        <span
          className="min-w-0 max-w-[45%] shrink truncate text-muted-foreground"
          onMouseEnter={clipTitle(stepPeek)}
        >
          · {stepPeek}
        </span>
      )}
      <RunDuration
        running={runningSince !== null}
        since={runningSince}
        elapsed={elapsed}
        className="shrink-0 text-[11px] text-muted-foreground"
      />
    </>
  );

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center hover:bg-muted/60">
        {isActionsCheck ? (
          // The whole header is the disclosure (mirrors RunDetailView's JobRow):
          // Enter/Space or click toggles the inline log; arrow-nav focuses it.
          <button
            type="button"
            data-row={rowId}
            onClick={() => setLogsOpen((v) => !v)}
            aria-expanded={logsOpen}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
          >
            {inner}
          </button>
        ) : check.detailsUrl ? (
          // An external check: the whole row opens its details URL.
          <button
            type="button"
            data-row={rowId}
            onClick={() => check.detailsUrl && openUrl(check.detailsUrl)}
            title="Open this check"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs"
          >
            {inner}
            <ArrowSquareOutIcon className="size-3 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          // No details URL: just icon + name + status, nothing to activate.
          <div
            data-row={rowId}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-xs"
          >
            {inner}
          </div>
        )}
        {isActionsCheck && check.detailsUrl && (
          <button
            type="button"
            onClick={() => check.detailsUrl && openUrl(check.detailsUrl)}
            title="Open the full run"
            className="mr-2 inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ArrowSquareOutIcon className="size-3" />
            Open full run
          </button>
        )}
      </div>
      {isActionsCheck && logsOpen && (
        <div className="px-3 pb-2 pl-10">
          {/* A running check shows its live step checklist (logs are useless
              mid-run); everything else falls back to the log tail. */}
          {isRunning && runJob && runJob.steps.length > 0 ? (
            <RunSteps job={runJob} />
          ) : (
            <CheckLogTail repoPath={repoPath} check={check} />
          )}
        </div>
      )}
    </div>
  );
}

/** Headless per-run fetcher: one `useRunDetail` query for a running Actions run,
 *  lifting its jobs to the parent so each row resolves its own job (React Query
 *  dedupes by run-id key, so N rows sharing a run cost one fetch). Mounted only
 *  while the rollup is open; refetches every 5s while the run stays active. */
function RunDetailFetcher({
  repoPath,
  runId,
  setJobs,
}: {
  repoPath: string;
  runId: string;
  /** The parent's `setJobsByRun` state updater (stable across renders). */
  setJobs: Dispatch<SetStateAction<Record<string, RunJob[]>>>;
}) {
  const detail = useRunDetail(repoPath, runId, true);
  const jobs = detail.data?.jobs;
  useEffect(() => {
    if (jobs) setJobs((prev) => ({ ...prev, [runId]: jobs }));
  }, [jobs, runId, setJobs]);
  return null;
}

/**
 * The PR's CI checks as a disclosure rollup: a summary line
 * (`✓ N passed · ✕ M failed · ● K pending` — each count with its own icon + word, so
 * meaning is never color-alone) expanding to a keyboard-navigable, height-capped
 * list with failures first. Checks with a fetchable run/job (GitHub Actions, GitLab
 * pipeline jobs) peek their log inline; external checks (Bitbucket build statuses,
 * etc.) link out. Auto-expanded when anything failed, or when a required check was
 * cancelled or went stale. Renders nothing with no checks.
 */
export function ChecksRollup({
  checks,
  repoPath,
  provider,
  crossRepository,
  stale,
  unmetRequiredContexts = [],
}: {
  checks: PrCheckOut[];
  repoPath: string;
  /** The repo's forge provider — gates the running-Actions live-steps fetch to
   *  GitHub (GitLab checks also carry run/job ids but have no steps). */
  provider: ForgeProvider;
  /** The PR's cross-repository (fork) flag, as the caller reads it off the PR.
   *  Only the approval strip uses it: GitHub holds runs for approval on fork PRs
   *  alone, so the affordance is fork-scoped by design. */
  crossRepository: boolean;
  /** True while the host view doesn't own the selection or the details are the
   *  previous PR's placeholder — suppresses every mutating affordance in the
   *  rollup, which would otherwise act on a PR the user never opened. */
  stale: boolean;
  /** The base branch's required contexts the PR's checks haven't satisfied, exactly
   *  as the caller's blocked-merge join computes them. GitHub blocked-by-rules PRs
   *  only — absent or empty everywhere else, and the rollup never reads the rules
   *  itself. */
  unmetRequiredContexts?: string[];
}) {
  const passed = checks.filter(
    (c) => checkPresentation(c.status, provider).bucket === "passed",
  ).length;
  const failed = checks.filter(
    (c) => checkPresentation(c.status, provider).bucket === "failed",
  ).length;
  const pending = checks.filter(
    (c) => checkPresentation(c.status, provider).bucket === "pending",
  ).length;
  const skipped = checks.filter(
    (c) => checkPresentation(c.status, provider).bucket === "skipped",
  ).length;
  // Required contexts sitting on a cancelled or stale run. Counted apart from the
  // summary segments, which keep stating run results — such a row still counts as
  // skipped there, because that is what the run did. Decided once per render and
  // keyed by the check OBJECT (a `name` isn't unique): the predicate scans the whole
  // list, and the count, the sort comparator, and every row all ask for it.
  const attentionFlags = new Map(
    checks.map((c) => [
      c,
      needsRequiredAttention(c, checks, provider, unmetRequiredContexts),
    ]),
  );
  const attention = checks.filter((c) => attentionFlags.get(c)).length;
  // React identity is content-first: a sorted-index key hands one row's open log to
  // another check when `unmetRequiredContexts` re-ranks, and a `checks`-index key
  // does the same when a refetch rebuilds the array. A `jobId` is per-job unique
  // (`runId` is NOT — every job in a run shares it), so id-bearing rows keep
  // their state across both; only id-less ones fall back to name+index and still
  // remount on a reorder. `data-row` is recomputed per render, so nav identity
  // stays positional even though the row itself moves with its check.
  const orderKey = new Map(
    checks.map((c, i) => [
      c,
      c.jobId ? `job:${c.jobId}` : `name:${c.name}:${i}`,
    ]),
  );

  // Auto-expand on any failure, or on a required check that reads finished but
  // still holds the merge — either way the PR should show it without a click.
  // Otherwise collapsed by default.
  const [open, setOpen] = useState(failed > 0 || attention > 0);
  // The jobs of each running Actions run, keyed by run id. Populated by the
  // headless `RunDetailFetcher`s mounted while the rollup is open (one per distinct
  // run id); each row resolves its own job from here. Empty until run detail lands.
  const [jobsByRun, setJobsByRun] = useState<Record<string, RunJob[]>>({});
  // …and re-open when failures FIRST appear after mount: usePrDetails refetches
  // on window focus (no remount), so a PR opened while CI is pending would
  // otherwise stay collapsed when a check later fails. Fire only on the 0→>0
  // transition — never force-open while failing, so a manual collapse sticks.
  const prevFailed = useRef(failed);
  useEffect(() => {
    if (prevFailed.current === 0 && failed > 0) setOpen(true);
    prevFailed.current = failed;
  }, [failed]);
  // Attention gets one auto-open per mount rather than a 0→>0 edge: the unmet list
  // rides a mergeability gate that empties and refills whenever GitHub reports the
  // PR unknown after a push, and an edge would reopen a manual collapse each time.
  const attentionOpened = useRef(attention > 0);
  useEffect(() => {
    if (attention > 0 && !attentionOpened.current) {
      attentionOpened.current = true;
      setOpen(true);
    }
  }, [attention]);

  const approveRun = useApproveWorkflowRun(repoPath);
  const rerun = useRerunRun(repoPath);
  // Own busy state: each batch spans several sequential mutations, so the
  // mutations' own `isPending` would flicker between them.
  const [approving, setApproving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // Run ids re-run from this rollup that still read failed — the one refetch
  // onSettled fires can land before the forge flips them, and usePrDetails is
  // focus-only after that, so the offer must retire locally. An id leaves the
  // latch when it leaves the failed set (it flipped to pending, or vanished),
  // so a later genuine re-failure of the same run re-offers.
  const [recentlyRerun, setRecentlyRerun] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // The re-run button unmounts the moment its offer retires, so a keyboard batch
  // started there would drop focus to `<body>`; the summary disclosure is the
  // stable neighbour that catches it.
  const rerunButtonRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  // The pending repair pass — one per batch, so a second batch resets it.
  const queryClient = useQueryClient();
  const repairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (repairTimer.current !== null) clearTimeout(repairTimer.current);
    },
    [],
  );
  // The blocked runs this rollup can approve. A run GitHub holds before it starts
  // may not reach the check rollup at all — that shape is unverified — so an empty
  // list renders nothing rather than an approval offer with nothing to approve.
  // Ids narrow to number for the mutation's contract; anything unrepresentable is
  // dropped rather than approved wrong.
  const blockedRunIds =
    crossRepository && provider === "github"
      ? [
          ...new Set(
            checks
              .filter(
                (c) => c.status.toUpperCase() === "ACTION_REQUIRED" && c.runId,
              )
              .map((c) => Number(c.runId)),
          ),
        ].filter((id) => Number.isSafeInteger(id))
      : [];

  // The re-run arm asks the forge probe itself rather than the `provider` prop:
  // that prop is a default-to-github guess until the probe answers, and a GitLab
  // MR must never be offered GitHub's wording. `undefined` = still pending.
  const forge = useForgeStatus(repoPath);
  const rerunProvider = forge.isPending ? undefined : forge.data?.provider;
  const canRerun =
    rerunProvider !== undefined &&
    (!isPipelineProvider(rerunProvider) ||
      forgeFeatureReady(forge.data, "ciRerun"));

  // The distinct run ids of the still-running GitHub Actions checks. Two
  // consumers: one run-detail query mounts per id while the rollup is OPEN
  // (React Query dedupes rows sharing a run, so a collapsed rollup fires
  // nothing), and the GitHub re-run arm subtracts them — GitHub refuses a run
  // still in progress, and that gate is not open-scoped.
  const runningRunIds = [
    ...new Set(
      checks
        .filter((c) => isRunningActionsCheck(c, provider))
        .map((c) => c.runId as string),
    ),
  ];
  // The runs a failed check sits on. `completedAt` is required: a StatusContext
  // whose `targetUrl` happens to parse as an Actions-run URL arrives FAILURE with
  // no timestamps, and that id could name another repository's run (the parse is
  // slug-blind). GitLab job checks always carry a finish time, so the term costs
  // them nothing.
  const failedRunIds = [
    ...new Set(
      checks
        .filter(
          (c) =>
            checkPresentation(c.status, provider).bucket === "failed" &&
            c.runId &&
            c.completedAt,
        )
        .map((c) => c.runId as string),
    ),
  ];
  // Membership alone decides whether a latched id still belongs, and the array
  // itself is rebuilt every render — so the prune keys on a primitive.
  const failedKey = failedRunIds.join(" ");
  useEffect(() => {
    const live = new Set(failedKey ? failedKey.split(" ") : []);
    setRecentlyRerun((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [failedKey]);
  // GitHub refuses to re-run a run that is still in progress, and one run can
  // hold a failed check while a sibling job runs on. GitLab gets no such gate:
  // it collapses running/pending/manual into one PENDING check status, so an
  // activity gate would hide the offer forever on a pipeline with a manual job —
  // a mid-run retry it rejects surfaces as that run's own error toast instead.
  const rerunnable = (
    rerunProvider === "github"
      ? failedRunIds.filter((id) => !runningRunIds.includes(id))
      : failedRunIds
  ).filter((id) => !recentlyRerun.has(id));
  // The one offer this rollup makes, or null when any gate closes — the button
  // and the palette action both read it, so no gate can hold for one and not the
  // other.
  const rerunOffer =
    canRerun && !stale && rerunnable.length > 0
      ? checksRerunOffer(rerunProvider)
      : null;

  // Approving and re-running are repo writes, so an explicitly read-only viewer
  // keeps the buttons (disabled, with the reason). Probed only when one of them
  // renders — the id lists already carry their provider gates — and on the same
  // lens the rest of the PR view uses, so it shares that query's cache entry.
  const lens = useRepoLens(repoPath);
  const writeAccess = useRepoWriteAccess(
    repoPath,
    lens,
    blockedRunIds.length > 0 || rerunOffer !== null,
  );
  const writeReason = writeAccessReason(writeAccess.data);
  const writeBlocked = writeAccess.data?.canPush === false;
  // A permission reason outranks the switch window: it stays true once the
  // switch lands, while the transient wording doesn't.
  const heldReason =
    writeReason ?? (stale ? PR_SWITCH_LOADING_REASON : undefined);

  async function approveBlockedRuns() {
    if (writeBlocked || stale) return;
    const ok = await useConfirm.getState().ask(APPROVE_RUN_CONFIRM);
    if (!ok) return;
    setApproving(true);
    try {
      // Sequential, and each failure is reported on its own: one run the viewer
      // can't approve must not strand the rest of the batch.
      for (const id of blockedRunIds) {
        try {
          await approveRun.mutateAsync({ runId: id, lens });
        } catch (e) {
          toastError(e);
        }
      }
    } finally {
      setApproving(false);
    }
  }

  async function rerunFailedChecks() {
    if (writeBlocked || stale) return;
    // Read before the first await: the button may be gone by the end of the
    // batch, and `activeElement` then reads `<body>` for a palette run and a
    // button run alike.
    const fromButton =
      rerunButtonRef.current !== null &&
      document.activeElement === rerunButtonRef.current;
    setRerunning(true);
    let started = 0;
    try {
      // Sequential, and each failure is reported on its own: one run raced to
      // "in progress" by the forge must not strand the rest of the batch.
      for (const id of rerunnable) {
        try {
          await rerun.mutateAsync({ runId: id, failed: true, lens });
          started += 1;
          setRecentlyRerun((prev) => new Set(prev).add(id));
        } catch (e) {
          toastError(e);
        }
      }
      if (started > 0) {
        toast.success(rerunSuccessMessage(rerunProvider, true));
        if (repairTimer.current !== null) clearTimeout(repairTimer.current);
        repairTimer.current = setTimeout(() => {
          repairTimer.current = null;
          // The same two keys the mutation invalidates, re-read once the attempt
          // transition has settled; unawaited, like the mutation's own pass.
          void queryClient.invalidateQueries({
            queryKey: ["repo", repoPath, "pr"],
          });
          void queryClient.invalidateQueries({
            queryKey: ["repo", repoPath, "pr-ci"],
          });
        }, CHECKS_REPAIR_DELAY_MS);
      }
    } finally {
      setRerunning(false);
    }
    // Every id latched means the offer retires with its button; anything short
    // of that leaves the button standing, and focus stays where the user put it.
    if (fromButton && started === rerunnable.length)
      summaryRef.current?.focus();
  }

  useHotkeyAction(
    "pr-rerun-failed-checks",
    () => void rerunFailedChecks(),
    rerunOffer !== null && !writeBlocked && !rerunning,
  );

  // Failures first, then the required contexts still holding the merge, then
  // pending, passed, and skipped (least interesting); stable within a rank.
  const bucketRank = { failed: 0, pending: 2, passed: 3, skipped: 4 } as const;
  const rank = (c: PrCheckOut) =>
    (attentionFlags.get(c) ?? false)
      ? 1
      : bucketRank[checkPresentation(c.status, provider).bucket];
  const sorted = [...checks].sort((a, b) => rank(a) - rank(b));

  // Roving focus: the "active" row is whichever element holds DOM focus, keyed by
  // `data-row` = the sorted index (a check `name` isn't unique — GitHub allows two
  // same-named checks). The rows are their own focusable buttons, so no selection
  // state.
  const rowId = (i: number) => String(i);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const focusedId =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("data-row")
        : null;
    const focusedIdx = focusedId === null ? -1 : Number(focusedId);
    const activeIndex = Number.isInteger(focusedIdx) ? focusedIdx : -1;
    listKeyboardNav({
      items: sorted,
      activeIndex,
      // No selection model — `rowKey` does focus movement + scroll-into-view;
      // identity is the sorted index, not the name.
      onActivate: () => undefined,
      rowKey: (c) => rowId(sorted.indexOf(c)),
    })(e);
  };

  if (checks.length === 0) return null;

  const summary: {
    key: string;
    count: number;
    Icon: typeof CheckCircleIcon;
    tone: string;
    word: string;
  }[] = [
    {
      key: "passed",
      count: passed,
      Icon: CheckCircleIcon,
      tone: "text-success",
      word: "passed",
    },
    {
      key: "failed",
      count: failed,
      Icon: XCircleIcon,
      tone: "text-destructive",
      word: "failed",
    },
    {
      key: "pending",
      count: pending,
      Icon: CircleIcon,
      tone: "text-warning",
      word: "pending",
    },
    {
      key: "skipped",
      count: skipped,
      Icon: MinusCircleIcon,
      tone: "text-muted-foreground",
      word: "skipped",
    },
  ].filter((s) => s.count > 0);

  return (
    <div className="text-[11px]">
      {blockedRunIds.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border bg-warning/10 px-2.5 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-warning">
            <WarningIcon weight="fill" className="size-3 shrink-0" />
            {`${blockedRunIds.length} workflow run${
              blockedRunIds.length === 1 ? "" : "s"
            } awaiting maintainer approval.`}
          </span>
          <DisabledReasonButton
            variant="outline"
            size="xs"
            disabled={approving || writeBlocked || stale}
            reason={heldReason}
            onClick={() => void approveBlockedRuns()}
          >
            {approving ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Approve and run
          </DisabledReasonButton>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button
          ref={summaryRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <CaretDownIcon className="size-3 shrink-0" />
          ) : (
            <CaretRightIcon className="size-3 shrink-0" />
          )}
          <span className="flex items-center gap-x-2.5">
            {summary.map((s, i) => (
              <span key={s.key} className="flex items-center gap-x-2.5">
                {i > 0 && (
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                )}
                <span className={cn("flex items-center gap-1", s.tone)}>
                  <s.Icon
                    className="size-3 shrink-0"
                    weight="fill"
                    aria-hidden
                  />
                  {s.count} {s.word}
                </span>
              </span>
            ))}
          </span>
        </button>
        {rerunOffer ? (
          <DisabledReasonButton
            ref={rerunButtonRef}
            variant="outline"
            size="xs"
            disabled={rerunning || writeBlocked}
            reason={writeReason}
            title={RERUN_TITLES[rerunOffer.kind]}
            onClick={() => void rerunFailedChecks()}
          >
            {rerunning ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowClockwiseIcon data-icon="inline-start" />
            )}
            {rerunOffer.label}
          </DisabledReasonButton>
        ) : null}
      </div>
      {open && (
        <>
          {/* Headless: one run-detail query per distinct running Actions run, only
              while open. */}
          {runningRunIds.map((id) => (
            <RunDetailFetcher
              key={id}
              repoPath={repoPath}
              runId={id}
              setJobs={setJobsByRun}
            />
          ))}
          <div
            className="mt-1.5 max-h-64 overflow-y-auto border"
            onKeyDown={onKeyDown}
          >
            {sorted.map((c, i) => {
              const running = isRunningActionsCheck(c, provider);
              const runJob = running
                ? jobForCheck(c, c.runId ? jobsByRun[c.runId] : undefined)
                : undefined;
              // `useRunDetail` polls at 5s but usePrDetails only refetches on
              // focus, so a finished run keeps a stale `completedAt` (→ `running`
              // true) until a focus event. Treat the resolved job as authoritative:
              // once it reports a non-active status, drop the live UI immediately.
              const jobDone = runJob ? !isRunActive(runJob.status) : false;
              const live = running && !jobDone;
              return (
                <CheckRow
                  key={orderKey.get(c)}
                  rowId={rowId(i)}
                  repoPath={repoPath}
                  check={c}
                  provider={provider}
                  isRunning={live}
                  runJob={runJob}
                  requiredAttention={attentionFlags.get(c) ?? false}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
