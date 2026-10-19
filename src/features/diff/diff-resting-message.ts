// The Changes pane's no-selection message, shared by DiffViewer and the eager
// Suspense fallback that stands in for it, so the two can never disagree.
// Import-free so scripts/diff-resting-message.test.mjs loads it under Node's
// type stripping.

/** Mirrors `STATUS_READ_FAILED_REASON` (sync-controls-state.ts), which the
 *  Changes tab's error block shows; the test pins the two equal. */
const STATUS_READ_FAILED = "Couldn't read the repository status";

/** The failed-read reason while `statusReadFailed`, the Changes tab's sticky
 *  gate (`data === undefined && errorUpdateCount > 0`), which outranks
 *  `statusPending` because each poll of that read flips back to pending. Else
 *  "No changes to review" once the read has settled with no entries, and
 *  "Select a file to see its changes" otherwise. A failed refetch keeps its
 *  data, so its message is the healthy one. */
export function restingDiffMessage(
  statusPending: boolean,
  entryCount: number,
  statusReadFailed: boolean,
): string {
  if (statusReadFailed) return STATUS_READ_FAILED;
  return !statusPending && entryCount === 0
    ? "No changes to review"
    : "Select a file to see its changes";
}
