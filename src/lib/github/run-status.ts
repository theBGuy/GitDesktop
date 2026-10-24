/**
 * The one spelling of the CI run-status predicates. `@/lib/github/actions` and
 * `@/features/actions/status` re-export them, so every caller keeps its import.
 *
 * Import-free on purpose: `src/features/actions/run-notify-diff.ts` imports it by a
 * relative `.ts` specifier, and `scripts/run-notify-diff.test.mjs` loads both under
 * Node's type stripping, which resolves no path aliases.
 */

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

/** A run/job still executing (so the UI keeps polling and offers Cancel). */
export const isRunActive = (status: string) => ACTIVE_STATUSES.has(status);

/** Whether a completed conclusion counts as a failure (drives "Re-run failed"). */
export function isFailureConclusion(conclusion: string): boolean {
  return (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "startup_failure"
  );
}
