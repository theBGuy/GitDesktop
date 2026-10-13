// The Changes pane's no-selection message, shared by DiffViewer and the eager
// Suspense fallback that stands in for it, so the two can never disagree.
// Import-free so scripts/diff-resting-message.test.mjs loads it under Node's
// type stripping.

/** "No changes to review" once the status read has settled with no entries,
 *  else "Select a file to see its changes". A failed FIRST read is not pending
 *  and carries no entries, so it reads as a clean tree; a failed refetch keeps
 *  its data and its message. */
export function restingDiffMessage(
  statusPending: boolean,
  entryCount: number,
): string {
  return !statusPending && entryCount === 0
    ? "No changes to review"
    : "Select a file to see its changes";
}
