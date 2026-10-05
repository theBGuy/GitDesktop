import type { ForgeProvider, PrCheckOut } from "@/lib/git/types";

/** The coarse bucket a check presents as, as `checkPresentation` classifies it.
 *  Passed in rather than imported: the classifier's module pulls in icon
 *  components, and this one stays free of runtime imports so it can be exercised
 *  directly by the node test harness. */
export type CheckBucket = "passed" | "failed" | "pending" | "skipped";

/** Which re-run a run gets. "failed": it holds a failed-bucket check, so it keeps
 *  the failed-jobs re-run. "cancelled": it holds no failed check but a CANCELLED
 *  one, so there is no failed job to name and the whole run re-runs. */
export type RerunMode = "failed" | "cancelled";

/** One re-runnable run: its id, the completion signature its re-run keys on
 *  when the list was derived, and the re-run it gets. */
export type RerunCandidate = readonly [
  runId: string,
  signature: string,
  mode: RerunMode,
];

/** Per run, every admitted check's `completedAt`, sorted and joined. */
function completionSignatures(
  checks: readonly PrCheckOut[],
  admit: (check: PrCheckOut) => boolean,
): Map<string, string> {
  const completions = new Map<string, string[]>();
  for (const c of checks) {
    if (!c.runId || !c.completedAt) continue;
    if (!admit(c)) continue;
    const times = completions.get(c.runId);
    if (times) times.push(c.completedAt);
    else completions.set(c.runId, [c.completedAt]);
  }
  return new Map(
    [...completions].map(
      ([id, times]) => [id, times.sort().join(" ")] as const,
    ),
  );
}

/**
 * Per run, the completion signature of its failed checks: every failed-bucket
 * `completedAt` for that run, sorted and joined. Both forges stamp a fresh
 * completion per attempt, so any change — a re-completion, a check joining or
 * leaving the failed set — is proof that a new attempt finished.
 *
 * `completedAt` is required: a StatusContext whose `targetUrl` happens to parse
 * as an Actions-run URL arrives FAILURE with no timestamps, and that id could
 * name another repository's run (the parse is slug-blind). GitLab job checks
 * always carry a finish time, so the term costs them nothing.
 */
export function failedRunSignatures(
  checks: readonly PrCheckOut[],
  bucketOf: (check: PrCheckOut) => CheckBucket,
): Map<string, string> {
  return completionSignatures(checks, (c) => bucketOf(c) === "failed");
}

/** Whether a same-named row of the same workflow started at or after `row`
 *  finished: a later attempt replaced it. The collapse kernel keeps a run
 *  cancelled before it started (it has no start to order by), so this evidence is
 *  what retires one. A row with no workflow (GitLab, Bitbucket) matches on name
 *  alone; one with a workflow is never retired by another workflow's job. */
function superseded(row: PrCheckOut, checks: readonly PrCheckOut[]): boolean {
  const finished = Date.parse(row.completedAt ?? "");
  if (Number.isNaN(finished)) return false;
  return checks.some(
    (other) =>
      other !== row &&
      other.name === row.name &&
      (row.workflow === undefined || other.workflow === row.workflow) &&
      Date.parse(other.startedAt ?? "") >= finished,
  );
}

/**
 * Per run, the signature its re-run offer and latch key on, with the re-run it
 * gets: its failed checks' signature when it has any, else its CANCELLED checks'
 * under the same `completedAt` rule. Keyed on the raw CANCELLED status, never the
 * skipped bucket: a SKIPPED, NEUTRAL or STALE row has nothing to re-run.
 *
 * A run with ANY failed-bucket row stays off the cancelled arm, dated or not: an
 * undated failure contributes no offer, and must not flip its run to re-run-all.
 * A cancelled row a later same-named attempt superseded contributes nothing.
 */
export function rerunSignatures(
  checks: readonly PrCheckOut[],
  bucketOf: (check: PrCheckOut) => CheckBucket,
): Map<string, { signature: string; mode: RerunMode }> {
  const signatures = new Map<string, { signature: string; mode: RerunMode }>();
  for (const [id, signature] of failedRunSignatures(checks, bucketOf))
    signatures.set(id, { signature, mode: "failed" });
  const failedRuns = new Set(
    checks
      .filter((c) => c.runId && bucketOf(c) === "failed")
      .map((c) => c.runId),
  );
  const cancelled = completionSignatures(
    checks,
    (c) =>
      c.status.toUpperCase() === "CANCELLED" &&
      !failedRuns.has(c.runId) &&
      !superseded(c, checks),
  );
  for (const [id, signature] of cancelled)
    if (!signatures.has(id))
      signatures.set(id, { signature, mode: "cancelled" });
  return signatures;
}

/**
 * Of the latched runs, the ones whose latch is still STANDING: their recorded
 * signature is the one their `rerunSignatures` entry carries right now.
 *
 * A latch releases on a CHANGED signature, but its key never leaves the map, so
 * key presence outlives the suppression by an entire mount. Every view derived
 * from a latch has to reproduce the latch's own release rule — ask here, never
 * `latched.has(id)`.
 *
 * A run with no failed or cancelled rows left (its re-run went green) has no
 * current signature at all, so it reads as released too.
 */
export function stillLatchedRunIds(
  checks: readonly PrCheckOut[],
  bucketOf: (check: PrCheckOut) => CheckBucket,
  latched: ReadonlyMap<string, string>,
): string[] {
  const signatures = rerunSignatures(checks, bucketOf);
  return [...latched]
    .filter(([id, signature]) => signatures.get(id)?.signature === signature)
    .map(([id]) => id);
}

/**
 * The runs the PR checks rollup may re-run right now, each with the signature
 * that identifies the attempt it failed or was cancelled on.
 *
 * GitHub refuses to re-run a run that is still in progress, and one run can hold
 * a failed check while a sibling job runs on. GitLab gets no such gate: it
 * collapses running/pending/manual into one PENDING check status, so an activity
 * gate would hide the offer forever on a pipeline with a manual job — a mid-run
 * retry it rejects surfaces as that run's own error toast instead.
 *
 * On GitHub, failed runs outrank cancelled-only ones: the rollup's one button
 * names one operation, so cancelled-only runs are offered once no failed run is.
 * GitLab's retry is one operation for both, so it offers them together.
 *
 * A latched run comes back only once its signature moves off the latched one —
 * release is evidence of a new attempt, never the observation of a transient, so
 * a snapshot that never shows the pending window (or shows none at all) cannot
 * free or strand the offer.
 */
export function rerunnableRuns(input: {
  checks: readonly PrCheckOut[];
  bucketOf: (check: PrCheckOut) => CheckBucket;
  /** Run ids whose GitHub Actions run is still in flight (GitHub-only by
   *  construction; empty on the other providers). */
  runningRunIds: readonly string[];
  /** Run ids re-run from this rollup → the signature they carried then. */
  latched: ReadonlyMap<string, string>;
  /** The SETTLED forge provider — `undefined` while the probe is pending. */
  provider: ForgeProvider | null | undefined;
}): RerunCandidate[] {
  const github = input.provider === "github";
  const offerable: RerunCandidate[] = [];
  for (const [id, { signature, mode }] of rerunSignatures(
    input.checks,
    input.bucketOf,
  )) {
    if (github && input.runningRunIds.includes(id)) continue;
    if (input.latched.get(id) === signature) continue;
    offerable.push([id, signature, mode]);
  }
  return github && offerable.some(([, , mode]) => mode === "failed")
    ? offerable.filter(([, , mode]) => mode === "failed")
    : offerable;
}

/** One re-runnable job: its id, the completion it carried when the list was
 *  derived (the latch key), and the run it belongs to — the run-level latch the
 *  caller writes alongside needs that id. */
export type JobRerunCandidate = readonly [
  jobId: string,
  completedAt: string,
  runId: string,
];

/**
 * The individual jobs the PR checks rollup may re-run right now.
 *
 * A candidate is a failed-bucket check carrying a job id, a run id AND a
 * `completedAt`. The completion term is the same guard `failedRunSignatures`
 * documents: a StatusContext whose `targetUrl` happens to parse as an Actions
 * URL arrives FAILURE with no timestamps, and the parse is slug-blind — it must
 * never mint a re-runnable id pointing at another repository's job.
 *
 * An UNSETTLED provider derives nothing, deliberately diverging from
 * `rerunnableRuns` (whose test pins the opposite): re-running one job is a
 * capability-gated write with no GitHub default to fall back on, so the offer
 * waits for the probe rather than guessing which forge — and which wording —
 * the click would buy.
 *
 * Two run-level subtractions, and the split between them is the point.
 * SNAPSHOT-RUNNING is GitHub-only: GitHub refuses a per-job re-run while the run
 * is in flight, while GitLab keeps the offer exactly as the run-level derivation
 * does (it collapses running/pending/manual into one PENDING status, so an
 * activity gate would hide the offer forever on a pipeline with a manual job) —
 * that activity is someone else's, and a mid-run retry there is legitimate.
 * STILL-LATCHED is universal: a latched run is OUR OWN resubmission, and both
 * forges' batch re-runs restart every failed job of the run (GitLab's retry
 * covers failed AND canceled), so re-offering one of them would re-submit work
 * already started. A per-job start latches its run too, so that run's OTHER
 * failed jobs park as well: wider than the act, accepted because it lasts only
 * until the next snapshot. Either way release is the latch's own signature
 * rule, not observed activity.
 *
 * A latched job comes back only once its `completedAt` moves — evidence of a new
 * finished attempt, never the observation of a transient. Both forges mint a NEW
 * job id per attempt, so a latch entry simply orphans once the re-run lands; it
 * dies with the per-PR remount.
 *
 * Cancelled rows get no per-job offer: their path is the run-level offer in
 * `rerunnableRuns`, which re-runs a cancelled-only run whole and leaves a run
 * that also failed on its failed re-run.
 */
export function rerunnableJobs(input: {
  checks: readonly PrCheckOut[];
  bucketOf: (check: PrCheckOut) => CheckBucket;
  /** Run ids whose GitHub Actions run is still in flight (GitHub-only by
   *  construction; empty on the other providers). */
  runningRunIds: readonly string[];
  /** Run ids re-run from this rollup whose latch still STANDS (see
   *  `stillLatchedRunIds`) — subtracted on every provider. */
  stillLatchedRunIds: readonly string[];
  /** Job ids re-run from this rollup → the completion they carried then. */
  latchedJobs: ReadonlyMap<string, string>;
  /** The SETTLED forge provider — `undefined` while the probe is pending. */
  provider: ForgeProvider | null | undefined;
}): JobRerunCandidate[] {
  if (input.provider !== "github" && input.provider !== "gitlab") return [];
  const candidates: JobRerunCandidate[] = [];
  for (const c of input.checks) {
    if (!c.jobId || !c.runId || !c.completedAt) continue;
    if (input.bucketOf(c) !== "failed") continue;
    if (input.provider === "github" && input.runningRunIds.includes(c.runId))
      continue;
    if (input.stillLatchedRunIds.includes(c.runId)) continue;
    if (input.latchedJobs.get(c.jobId) === c.completedAt) continue;
    candidates.push([c.jobId, c.completedAt, c.runId]);
  }
  return candidates;
}
