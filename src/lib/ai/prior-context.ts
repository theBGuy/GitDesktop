import { gitDiffBetweenRefs, gitFetchObjects } from "@/lib/git/api";
import { getLatestReview } from "@/lib/pulls/reviews-history";
import { filterDiffByAiIgnore } from "./ignore";
import type { ReviewDeltaState, ReviewMode } from "./types";

/** Upper bound on the delta fetched from git; the prompt budget trims further. */
const DELTA_MAX_BYTES = 200_000;

/** What `buildReviewPrompt` needs about a prior review of the same PR + mode. */
export interface PriorContext {
  priorFindings?: string;
  priorReviewedAt?: number;
  deltaDiffText?: string;
  deltaTruncated?: boolean;
  deltaState?: ReviewDeltaState;
}

/**
 * Loads the previous review for a PR + mode (if any) and computes a two-dot
 * delta of what changed since. All SOFT and best-effort: a missing prior, an
 * un-fetched remote SHA, a rewritten branch, or any git failure degrades to
 * "prior findings without a delta" (or nothing) — it never blocks the review.
 * The full current diff stays the authoritative source of truth.
 *
 * Shared by the interactive review (`src/lib/stores/reviews.ts`) and the
 * automation runner's pr-open / pr-sync paths — both build on a prior the same
 * way. Takes primitives (not a `ReviewTarget`) to avoid a circular import.
 *
 * `exclude` is the caller's AI-ignore pattern list, empty for an agentic run.
 * The delta is a SECOND diff, so filtering only the main one would leak the
 * very files the user withheld. Filtered inside the try below, which fails
 * closed: a filter failure drops the delta rather than carrying an unfiltered
 * one.
 */
export async function resolvePriorContext(
  repoPath: string,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
  currentHeadSha: string | undefined,
  exclude: string[] = [],
): Promise<PriorContext> {
  const prior = await getLatestReview(repoPath, kind, ref, mode);
  if (!prior?.text.trim()) return {};
  const base: PriorContext = {
    priorFindings: prior.text,
    priorReviewedAt: prior.finishedAt,
  };
  if (!currentHeadSha || !prior.headSha) {
    return { ...base, deltaState: "indeterminate" };
  }
  if (currentHeadSha === prior.headSha) {
    // Head unchanged — but the authoritative (merge-base-relative) diff can still
    // differ if the base moved, so we never treat this as a no-op here.
    return { ...base, deltaState: "head-unchanged" };
  }
  try {
    if (kind === "remote") {
      // A remote PR may never have been checked out, so its commits aren't local
      // objects (gh pr diff fetches nothing). Best-effort fetch the two SHAs so
      // the delta can resolve; ignore failure — the diff falls back gracefully.
      await gitFetchObjects(repoPath, [prior.headSha, currentHeadSha]).catch(
        () => undefined,
      );
    }
    const delta = await gitDiffBetweenRefs(
      repoPath,
      prior.headSha,
      currentHeadSha,
      DELTA_MAX_BYTES,
    );
    if (delta.reason === "ok") {
      // No file list pairs with a two-dot delta — its section keys are the
      // whole candidate set.
      const filtered = await filterDiffByAiIgnore({
        repoPath,
        text: delta.text,
        files: [],
        exclude,
      });
      return {
        ...base,
        deltaDiffText: filtered.text,
        deltaTruncated: delta.truncated,
        deltaState: "ok",
      };
    }
    if (delta.reason === "rewritten") {
      return { ...base, deltaState: "rewritten" };
    }
    // "missing" (un-fetched remote SHA) and "indeterminate" (shallow clone) both
    // mean "no usable delta" — carry the prior findings, drop the delta.
    return { ...base, deltaState: "indeterminate" };
  } catch {
    return { ...base, deltaState: "indeterminate" };
  }
}
