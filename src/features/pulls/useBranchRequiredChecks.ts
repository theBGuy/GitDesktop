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
  // Indexed once: GitHub allows several checks under one name, and every run of a
  // required context has to be consulted before that context counts as satisfied.
  const runs = new Map<string, PrCheckOut[]>();
  for (const check of checks) {
    const existing = runs.get(check.name);
    if (existing) existing.push(check);
    else runs.set(check.name, [check]);
  }
  return required.filter((context) => {
    const named = runs.get(context);
    if (!named) return true;
    // Unmet = never reported, still running, or failed — the three a viewer is
    // waiting on. A skipped or neutral run has reported a conclusion, so naming
    // it as something still to come would be wrong.
    return named.some((check) => {
      const { bucket } = checkPresentation(check.status, provider);
      return bucket === "failed" || bucket === "pending";
    });
  });
}
