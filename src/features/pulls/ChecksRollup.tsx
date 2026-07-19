import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { LogBlock } from "@/components/LogBlock";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/features/actions/status";
import type { ForgeProvider, PrCheckOut } from "@/lib/git/types";
import {
  isRunActive,
  type RunJob,
  useJobLogs,
  useRunDetail,
  useRunFailedLogs,
} from "@/lib/github/actions";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/**
 * Tone + glyph for a CI check, so pass/fail isn't conveyed by color alone.
 * Moved here from RemotePrView — it's checks-specific and only this component
 * uses it now.
 */
function checkPresentation(status: string): {
  tone: string;
  Icon: typeof CheckCircleIcon;
  label: string;
  /** Coarse bucket for the rollup summary + failures-first sort. */
  bucket: "passed" | "failed" | "pending" | "skipped";
} {
  const s = status.toUpperCase();
  if (s === "SUCCESS") {
    return {
      tone: "text-success",
      Icon: CheckCircleIcon,
      label: "passed",
      bucket: "passed",
    };
  }
  if (
    ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"].includes(
      s,
    )
  ) {
    return {
      tone: "text-destructive",
      Icon: XCircleIcon,
      label: "failed",
      bucket: "failed",
    };
  }
  if (["SKIPPED", "NEUTRAL", "STALE"].includes(s)) {
    return {
      tone: "text-muted-foreground",
      Icon: MinusCircleIcon,
      // The three share a bucket/icon/tone, but the accessible label is each
      // status's own word ("skipped" / "neutral" / "stale") so a screen reader
      // announces the actual result. The summary segment still says "skipped".
      label: s.toLowerCase(),
      bucket: "skipped",
    };
  }
  // Everything still in flight — IN_PROGRESS/QUEUED/PENDING — plus
  // ACTION_REQUIRED (deliberately here: it awaits a human, so the amber warning
  // tone fits) falls through to the pending bucket.
  return {
    tone: "text-warning",
    Icon: CircleIcon,
    label: "pending",
    bucket: "pending",
  };
}

/** A GitHub Actions check that hasn't finished yet — it has a parsed run id, the
 *  repo is GitHub, no `completedAt`, AND its status still reads as pending. The
 *  bucket check guards against a StatusContext whose `targetUrl` is coincidentally
 *  an Actions-run URL (so a runId parses) but whose state is already SUCCESS/
 *  FAILURE and carries no timestamps — without it, such a check would read as
 *  "running". Only these fetch run detail for the live step checklist; GitLab
 *  checks also carry run/job ids (pipeline/job ids) but have no steps, so gating on
 *  the provider avoids wasted `forge_ci_run_view` spawns. */
function isRunningActionsCheck(
  check: PrCheckOut,
  provider: ForgeProvider,
): boolean {
  return (
    provider === "github" &&
    Boolean(check.runId) &&
    !check.completedAt &&
    checkPresentation(check.status).bucket === "pending"
  );
}

/** The run's job for a check: by job id first (the reliable key), falling back to
 *  matching the job name when the check carries no job id. */
function jobForCheck(
  check: PrCheckOut,
  jobs: RunJob[] | undefined,
): RunJob | undefined {
  if (!jobs) return undefined;
  if (check.jobId) {
    const id = Number(check.jobId);
    const byId = jobs.find((j) => j.id === id);
    if (byId) return byId;
  }
  return jobs.find((j) => j.name === check.name);
}

/** The step a running job is currently executing (first `in_progress` step), or
 *  null when none has started yet (still "queued"). */
function currentStep(job: RunJob | undefined) {
  return job?.steps.find((s) => s.status === "in_progress") ?? null;
}

/** "1m 12s" elapsed between two ISO timestamps (mirrors RunDetailView's helper).
 *  Returns "" when either timestamp is missing/unparseable. */
function duration(start?: string, end?: string): string {
  if (!start || !end) return "";
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return "";
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Sets a hover title only when the name is actually clipped by `truncate`;
 *  mirrors the only-when-clipped pattern in CommitsList/WorktreesDialog. */
const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};

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
  // A job id gets the per-job log; a run without a parsed job id falls back to
  // the run-wide failed-step logs (same as the Actions panel's failed-logs view).
  // NOTE: run/job ids are kept as *strings* on PrCheckOut (they can exceed JS's
  // safe-integer range), but the shared Actions log hooks (useJobLogs/
  // useRunFailedLogs → forge_ci_*_logs) still take numeric ids, so we narrow here.
  // Safe today — real GitHub/GitLab ids are ~1e10, far below 2^53 — but a
  // follow-up should thread these as strings end-to-end through the Actions log
  // path (commands + Actions panel + MCP callers) to make it precision-safe.
  const jobId = check.jobId ? Number(check.jobId) : null;
  const runId = check.runId ? Number(check.runId) : null;
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
        const elapsed = duration(step.startedAt, step.completedAt);
        return (
          <div
            key={step.number}
            className="flex items-center gap-2 text-[11px]"
          >
            <StatusIcon
              status={step.status}
              conclusion={step.conclusion}
              className="size-3.5"
            />
            <span
              className="min-w-0 flex-1 truncate"
              onMouseEnter={clipTitle(step.name)}
            >
              {step.name}
            </span>
            {elapsed && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {elapsed}
              </span>
            )}
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
  rowId,
  runJob,
  isRunning,
}: {
  repoPath: string;
  check: PrCheckOut;
  /** Unique row identity (the sorted index) for `data-row` + roving focus —
   *  GitHub allows two checks with the same `name`, so name can't be the id. */
  rowId: string;
  /** The resolved run job for a running Actions check (from the rollup's shared
   *  run-detail queries); undefined until the run detail resolves, or for a
   *  non-running / non-Actions check. */
  runJob: RunJob | undefined;
  /** Whether this is a still-running GitHub Actions check (drives the inline
   *  current-step peek + the expanded step checklist). */
  isRunning: boolean;
}) {
  const { tone, Icon, label } = checkPresentation(check.status);
  const elapsed = duration(check.startedAt, check.completedAt);
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

  // The row's shared inner content (icon + name + duration). Rendered inside a
  // focusable button for interactive rows (Actions → toggles logs; else the
  // details link opens) and a plain div for a URL-less check.
  const inner = (
    <>
      {isActionsCheck &&
        (logsOpen ? (
          <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />
        ))}
      <Icon
        className={cn("size-3.5 shrink-0", tone)}
        aria-label={label}
        weight="fill"
      />
      <span
        className="min-w-0 flex-1 truncate font-medium"
        onMouseEnter={clipTitle(check.name)}
      >
        {check.name}
      </span>
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
      {elapsed && (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {elapsed}
        </span>
      )}
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
          {/* A running Actions check shows its live step checklist (logs are
              useless mid-run); if its job can't be resolved yet or it has no
              steps, and for every completed check, fall back to the log tail. */}
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

/** A headless per-run fetcher: mounts one `useRunDetail` query for a running
 *  Actions run and lifts its jobs to the parent so each row can resolve its own
 *  job (React Query dedupes by run-id key, so N rows sharing a run cost one fetch).
 *  Mounted only while the rollup is open; `useRunDetail` refetches every 5s while
 *  the run stays active. Renders nothing. */
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
  const detail = useRunDetail(repoPath, Number(runId), true);
  const jobs = detail.data?.jobs;
  useEffect(() => {
    if (jobs) setJobs((prev) => ({ ...prev, [runId]: jobs }));
  }, [jobs, runId, setJobs]);
  return null;
}

/**
 * The PR's CI checks, as a disclosure rollup: a summary line
 * (`✓ N passed · ✕ M failed · ● K pending`, each count with its own icon + word
 * so meaning is never color-alone) that expands to a keyboard-navigable,
 * height-capped list with failures first. Checks with a fetchable run/job (GitHub
 * Actions, GitLab pipeline jobs) peek their log inline; external checks (Bitbucket
 * build statuses, etc.) link out. Auto-expanded when anything failed.
 *
 * Renders nothing when there are no checks (a PR whose provider reports none, or a
 * GitHub PR with no CI) — RemotePrView also guards, but this stays defensive.
 */
export function ChecksRollup({
  checks,
  repoPath,
  provider,
}: {
  checks: PrCheckOut[];
  repoPath: string;
  /** The repo's forge provider — gates the running-Actions live-steps fetch to
   *  GitHub (GitLab checks also carry run/job ids but have no steps). */
  provider: ForgeProvider;
}) {
  const passed = checks.filter(
    (c) => checkPresentation(c.status).bucket === "passed",
  ).length;
  const failed = checks.filter(
    (c) => checkPresentation(c.status).bucket === "failed",
  ).length;
  const pending = checks.filter(
    (c) => checkPresentation(c.status).bucket === "pending",
  ).length;
  const skipped = checks.filter(
    (c) => checkPresentation(c.status).bucket === "skipped",
  ).length;

  // Auto-expand on any failure — a failing PR should show what failed without a
  // click. Otherwise collapsed by default.
  const [open, setOpen] = useState(failed > 0);
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

  // Failures first, then pending, then passed, then skipped (least interesting);
  // stable within a bucket.
  const bucketRank = { failed: 0, pending: 1, passed: 2, skipped: 3 } as const;
  const sorted = [...checks].sort(
    (a, b) =>
      bucketRank[checkPresentation(a.status).bucket] -
      bucketRank[checkPresentation(b.status).bucket],
  );

  // The distinct run ids of the still-running GitHub Actions checks — one
  // run-detail query mounts per id below (React Query dedupes rows sharing a run),
  // and only while the rollup is OPEN, so a collapsed rollup fires nothing.
  const runningRunIds = [
    ...new Set(
      checks
        .filter((c) => isRunningActionsCheck(c, provider))
        .map((c) => c.runId as string),
    ),
  ];

  // Roving focus: the "active" row is whichever row element currently holds DOM
  // focus, keyed by `data-row` = the row's sorted index (a check `name` isn't
  // unique — GitHub allows two same-named checks). ArrowUp/Down step from
  // wherever focus is; `listKeyboardNav` moves focus + scrolls into view; the
  // rows are their own focusable buttons, so there's no separate selection state.
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
      // No selection model — focus movement + scroll-into-view is all done by
      // `rowKey` below (the rows are their own focusable buttons). Identity is
      // the sorted index (`indexOf` on the distinct array element), not the
      // check name, so two same-named checks stay individually focusable.
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
      <button
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
                <s.Icon className="size-3 shrink-0" weight="fill" aria-hidden />
                {s.count} {s.word}
              </span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <>
          {/* One run-detail query per distinct running Actions run, mounted only
              while the rollup is open (collapsed → no fetch). Headless — they lift
              jobs into `jobsByRun` for the rows to read. */}
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
              // Key + data-row on the sorted index — `c.name` isn't unique (GitHub
              // allows two checks with the same name), which would collide keys and
              // make the second row unfocusable.
              const running = isRunningActionsCheck(c, provider);
              const runJob = running
                ? jobForCheck(c, c.runId ? jobsByRun[c.runId] : undefined)
                : undefined;
              // `useRunDetail` polls at 5s but usePrDetails only refetches on
              // focus, so when a run finishes the check's `completedAt` stays
              // stale (→ `running` true) until a focus event. Treat the resolved
              // job as authoritative: once it reports a non-active status, drop
              // the live UI immediately, reverting the row to the log tail before
              // the PR payload catches up.
              const jobDone = runJob ? !isRunActive(runJob.status) : false;
              const live = running && !jobDone;
              return (
                <CheckRow
                  key={rowId(i)}
                  rowId={rowId(i)}
                  repoPath={repoPath}
                  check={c}
                  isRunning={live}
                  runJob={runJob}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
