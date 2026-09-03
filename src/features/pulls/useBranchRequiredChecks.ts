import { useQuery } from "@tanstack/react-query";
import { ghBranchRequiredChecks } from "@/lib/git/api";
import type { ForgeProvider, PrCheckOut, RemoteLens } from "@/lib/git/types";
import { checkPresentation } from "./check-presentation";

/**
 * What a pull request's BASE branch requires — status-check contexts and any
 * approving-review count — read from GitHub's active rules for that branch. Never
 * polls, and it is enabled only where the answer is about to be shown: the read
 * exists to name what a blocked merge is waiting on. It can still refetch on the
 * usual triggers (focus, reconnect, remount) once stale, so the caller's gate
 * carries the <Activity> term too. An empty answer is the honest one for a branch
 * with no rules this viewer can see.
 */
export function useBranchRequiredChecks(
  repo: string,
  branch: string,
  lens: RemoteLens,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "branch",
      lens,
      branch,
      "required-checks",
    ] as const,
    queryFn: () => ghBranchRequiredChecks(repo, branch, lens),
    enabled: enabled && branch !== "",
    // Branch rules change on a human timescale, so one read covers a visit.
    staleTime: 5 * 60_000,
  });
}

/** When a run reported, for ordering same-named runs. Start time is the one key
 *  both rollup shapes carry: a status context reports when it was created but never
 *  a completion. NaN when the run is undated, which the API permits. */
const reportedAt = (run: PrCheckOut) =>
  Date.parse(run.startedAt ?? run.completedAt ?? "");

/**
 * The most recent of several same-named runs, or null when none of them is dated.
 * Newest-wins is MEASURED, not GitHub's documented contract: a workflow that
 * cancels its own in-progress runs on re-trigger leaves the superseded run in the
 * rollup, and GitHub reports such a branch mergeable anyway. Ties keep the later
 * entry, the order the rollup itself supplied.
 */
function latestReportedRun(runs: PrCheckOut[]): PrCheckOut | null {
  let latest: PrCheckOut | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const at = reportedAt(run);
    if (Number.isNaN(at)) continue;
    if (at >= latestAt) {
      latest = run;
      latestAt = at;
    }
  }
  return latest;
}

/** Whether one run leaves its context still to come. STALE and CANCELLED count
 *  here but not in the rollup's presentation: GitHub's passing set is success,
 *  skipped or neutral, so either holds the merge until it re-runs even though both
 *  read as finished, neutral results. The rollup imports it to flag those rows,
 *  so the two surfaces share one marker set. */
export function isOutstanding(
  check: PrCheckOut,
  provider: ForgeProvider,
): boolean {
  const s = check.status.toUpperCase();
  if (s === "STALE" || s === "CANCELLED") return true;
  const { bucket } = checkPresentation(check.status, provider);
  return bucket === "failed" || bucket === "pending";
}

/**
 * Which required contexts the PR's own checks have not satisfied, in the order the
 * rules named them. Joined by NAME — the rules speak in contexts and the rollup in
 * check names, and that string is all the two share.
 */
export function unmetRequiredChecks(
  required: string[],
  checks: PrCheckOut[],
  provider: ForgeProvider,
): string[] {
  if (required.length === 0) return [];
  // Indexed once: GitHub allows several runs under one name, and one of them
  // decides the context — which one is resolved per group below.
  const runs = new Map<string, PrCheckOut[]>();
  for (const check of checks) {
    const existing = runs.get(check.name);
    if (existing) existing.push(check);
    else runs.set(check.name, [check]);
  }
  return required.filter((context) => {
    const named = runs.get(context);
    // Unmet = never reported, still running, failed, stale, or cancelled — what a
    // viewer is waiting on. A skipped or neutral run has reported a conclusion GitHub
    // accepts; cancelled shares their muted presentation but not that acceptance.
    if (!named) return true;
    // The newest DATED run decides, and an undated one is never overruled by it:
    // nothing orders that run against the others, so it has to clear on its own.
    // A group with no dated run at all therefore keeps the old rule — all of them.
    const decisive = latestReportedRun(named);
    const undated = named.some(
      (check) =>
        Number.isNaN(reportedAt(check)) && isOutstanding(check, provider),
    );
    return undated || (decisive !== null && isOutstanding(decisive, provider));
  });
}
