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
