import type { ForgeProvider, PrCheckOut } from "@/lib/git/types";

/** The coarse bucket a check presents as, as `checkPresentation` classifies it.
 *  Passed in rather than imported: the classifier's module pulls in icon
 *  components, and this one stays free of runtime imports so it can be exercised
 *  directly by the node test harness. */
export type CheckBucket = "passed" | "failed" | "pending" | "skipped";

/** One re-runnable run: its id, and the completion signature its failed checks
 *  carried when the list was derived. */
export type RerunCandidate = readonly [runId: string, signature: string];

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
  const completions = new Map<string, string[]>();
  for (const c of checks) {
    if (!c.runId || !c.completedAt) continue;
    if (bucketOf(c) !== "failed") continue;
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
 * Of the latched runs, the ones whose latch is still STANDING: their recorded
 * signature is the one their failed checks carry right now.
 *
 * A latch releases on a CHANGED signature, but its key never leaves the map, so
 * key presence outlives the suppression by an entire mount. Every view derived
 * from a latch has to reproduce the latch's own release rule — ask here, never
 * `latched.has(id)`.
 *
 * A run whose failed rows are gone (its re-run went green) has no current
 * signature at all, so it reads as released too.
 */
export function stillLatchedRunIds(
  checks: readonly PrCheckOut[],
  bucketOf: (check: PrCheckOut) => CheckBucket,
  latched: ReadonlyMap<string, string>,
): string[] {
  const signatures = failedRunSignatures(checks, bucketOf);
  return [...latched]
    .filter(([id, signature]) => signatures.get(id) === signature)
    .map(([id]) => id);
}

/**
 * The runs the PR checks rollup may re-run right now, each with the signature
 * that identifies the attempt they failed on.
 *
 * GitHub refuses to re-run a run that is still in progress, and one run can hold
 * a failed check while a sibling job runs on. GitLab gets no such gate: it
 * collapses running/pending/manual into one PENDING check status, so an activity
 * gate would hide the offer forever on a pipeline with a manual job — a mid-run
 * retry it rejects surfaces as that run's own error toast instead.
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
  const signatures = failedRunSignatures(input.checks, input.bucketOf);
  const offerable =
    input.provider === "github"
      ? [...signatures].filter(([id]) => !input.runningRunIds.includes(id))
      : [...signatures];
  return offerable.filter(
    ([id, signature]) => input.latched.get(id) !== signature,
  );
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
 * Cancelled rows are out of scope by design, not by omission: a cancelled GitLab
 * job is forge-retryable but presents in the skipped bucket, and the run-level
 * Retry (which does fire on cancelled) already covers it.
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
