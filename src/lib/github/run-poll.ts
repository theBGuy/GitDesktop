/**
 * How often the CI run-watching reads poll: a per-run ladder over the age of the
 * run's current attempt, and the run lists' cadence built on it. Its one import
 * is the run-status module, by a relative `.ts` specifier, so
 * `scripts/run-poll.test.mjs` loads it under Node's type stripping.
 */
import { isRunActive } from "./run-status.ts";

/** A fresh attempt's tick: most runs finish, or fail, within minutes. */
export const RUN_POLL_FAST_MS = 5_000;
/** An attempt past its first minutes is unlikely to finish in the next few seconds. */
export const RUN_POLL_MID_MS = 15_000;
/** Long runs and runs held for approval: completion lands within a minute. */
export const RUN_POLL_SLOW_MS = 60_000;
/** The attempt age where the fast tier ends. */
export const RUN_POLL_FRESH_AGE_MS = 120_000;
/** The attempt age where the mid tier ends. */
export const RUN_POLL_MID_AGE_MS = 600_000;

/** The run fields the cadence reads. */
export type PollRun = {
  status: string;
  createdAt: string;
  startedAt?: string;
  headSha?: string;
};

/** A timestamp's epoch ms, or null when it doesn't read. Go's zero time
 *  (`0001-01-01…`) parses but means "unset", so it reads as absent. */
const parseMs = (value: string | undefined): number | null => {
  if (!value || value.startsWith("0001-")) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** One run's poll interval, or false once it has finished. The age basis is the
 *  attempt's start when readable, else the run's creation: a re-run keeps the
 *  run's old creation time while its start moves. An unreadable or future basis
 *  polls fast, never costlier than a flat fast tick. A `waiting` run polls slowly
 *  at any age, since only a human approval moves it. */
export function runPollIntervalMs(run: PollRun, nowMs: number): number | false {
  if (!isRunActive(run.status)) return false;
  if (run.status === "waiting") return RUN_POLL_SLOW_MS;
  const basis = parseMs(run.startedAt) ?? parseMs(run.createdAt);
  if (basis === null) return RUN_POLL_FAST_MS;
  const age = nowMs - basis;
  if (age < RUN_POLL_FRESH_AGE_MS) return RUN_POLL_FAST_MS;
  if (age < RUN_POLL_MID_AGE_MS) return RUN_POLL_MID_MS;
  return RUN_POLL_SLOW_MS;
}

/** The latest readable job start, or "" when none reads: the age basis for a run
 *  detail, whose wire shape carries no run start of its own (a re-run's jobs are
 *  minted fresh, so their starts track the current attempt). */
export function newestJobStartedAt(
  jobs: readonly { startedAt: string }[],
): string {
  let newest = "";
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const job of jobs) {
    const ms = parseMs(job.startedAt);
    if (ms !== null && ms > newestMs) {
      newestMs = ms;
      newest = job.startedAt;
    }
  }
  return newest;
}

/** A run detail's poll interval. An active run with no active job polls fast:
 *  right after a re-run its jobs are absent or the previous attempt's, so no
 *  job start can date the new attempt yet. Otherwise the basis is the later of
 *  the run's creation and its newest job start; a job start before the
 *  creation never ages the run past it. A `waiting` run stays slow. */
export function runDetailPollIntervalMs(
  detail: {
    status: string;
    createdAt: string;
    jobs: readonly { status: string; startedAt: string }[];
  },
  nowMs: number,
): number | false {
  if (!isRunActive(detail.status)) return false;
  if (detail.status === "waiting") return RUN_POLL_SLOW_MS;
  if (!detail.jobs.some((j) => isRunActive(j.status))) return RUN_POLL_FAST_MS;
  const newest = newestJobStartedAt(detail.jobs);
  const startMs = parseMs(newest);
  const createdMs = parseMs(detail.createdAt);
  const jobLater =
    startMs !== null && (createdMs === null || startMs > createdMs);
  return runPollIntervalMs(
    {
      status: detail.status,
      createdAt: detail.createdAt,
      startedAt: jobLater ? newest : undefined,
    },
    nowMs,
  );
}

/** A run's jobs read interval. Loaded jobs that have all finished park the
 *  read only while the run's row is absent or finished too: a re-run started
 *  elsewhere flips the row active without touching the jobs read, and the old
 *  attempt's finished jobs must not park it. While the row is active its
 *  ladder applies; with no row, the fast tier. */
export function runJobsPollIntervalMs(
  jobs: readonly { status: string }[] | undefined,
  run: PollRun | null,
  nowMs: number,
): number | false {
  if (
    jobs !== undefined &&
    jobs.every((j) => !isRunActive(j.status)) &&
    (run === null || !isRunActive(run.status))
  )
    return false;
  return run ? runPollIntervalMs(run, nowMs) : RUN_POLL_FAST_MS;
}

/** The fastest interval among the active runs, or false when none is active. */
export function runsPollIntervalMs(
  runs: readonly PollRun[] | undefined,
  nowMs: number,
): number | false {
  let best: number | false = false;
  for (const run of runs ?? []) {
    const ms = runPollIntervalMs(run, nowMs);
    if (ms !== false && (best === false || ms < best)) best = ms;
  }
  return best;
}

/** When a wake (below) re-reads the PR's checks, measured from its start: the
 *  PR's checks rollup can lag the runs list, and a failed PR read isn't retried. */
export const CHECKS_RECHECK_DELAYS_MS = [15_000, 30_000, 60_000] as const;
/** How long one wake lasts: one mid-tier poll past the last re-check. */
export const HEAD_WAKE_WINDOW_MS =
  CHECKS_RECHECK_DELAYS_MS[2] + RUN_POLL_MID_MS;

/** A head-list row as the wake reads it. */
export type HeadWakeRow = PollRun & { id: number | string; updatedAt?: string };

/** The pending ids whose head row reads finished: a check the open rollup still
 *  reports pending (never a latch-only re-run id) over a finished run, which may
 *  be a new attempt started elsewhere. Keyed by the row's `updatedAt`, so each
 *  finished attempt wakes once. An id the rows don't carry is the per-run
 *  fallback's, never a wake. */
export function headWakeMismatches(
  rows: readonly HeadWakeRow[] | undefined,
  pendingIds: readonly string[],
): { id: string; key: string }[] {
  if (rows === undefined || pendingIds.length === 0) return [];
  const pending = new Set(pendingIds);
  return rows.flatMap((r) => {
    const id = String(r.id);
    return pending.has(id) && !isRunActive(r.status)
      ? [{ id, key: `${id} ${r.updatedAt ?? ""}` }]
      : [];
  });
}

/** Whether a wake that started at `startedAtMs` has run its course. */
export function headWakeWindowClosed(
  startedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - startedAtMs >= HEAD_WAKE_WINDOW_MS;
}

/** A PR head poll's interval: {@link runsPollIntervalMs}, except that an open
 *  wake (a mismatch whose key isn't in `closedKeys`) holds the poll at the mid
 *  tier at most, so a new attempt started elsewhere shows up. */
export function headRunsPollIntervalMs(
  rows: readonly HeadWakeRow[] | undefined,
  pendingIds: readonly string[],
  nowMs: number,
  closedKeys: ReadonlySet<string> = new Set<string>(),
): number | false {
  const base = runsPollIntervalMs(rows, nowMs);
  const awake = headWakeMismatches(rows, pendingIds).some(
    (m) => !closedKeys.has(m.key),
  );
  if (!awake) return base;
  return base === false ? RUN_POLL_MID_MS : Math.min(base, RUN_POLL_MID_MS);
}

/** A run list's interval. The governing runs are the newest (the list's first)
 *  when active, plus every `in_progress` run of the newest run's push (a
 *  non-empty `headSha`), the rule `notifyPollInterval` spells in
 *  run-notify-diff.ts (the congruence is pinned in scripts/run-poll.test.mjs);
 *  they poll at their own ladder. Any other active run holds the list at the
 *  slow tier, so an approval or an unstuck queue still lands within a minute;
 *  nothing active stops it. */
export function listRunsPollIntervalMs(
  runs: readonly PollRun[] | undefined,
  nowMs: number,
): number | false {
  const newest = runs?.[0];
  if (runs === undefined || newest === undefined) return false;
  const sha = newest.headSha;
  const governing = runs.filter(
    (r, i) =>
      (i === 0 && isRunActive(r.status)) ||
      (typeof sha === "string" &&
        sha !== "" &&
        r.headSha === sha &&
        r.status === "in_progress"),
  );
  const fast = runsPollIntervalMs(governing, nowMs);
  if (fast !== false) return fast;
  return runs.some((r) => isRunActive(r.status)) ? RUN_POLL_SLOW_MS : false;
}
