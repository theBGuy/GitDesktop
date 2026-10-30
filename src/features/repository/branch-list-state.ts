// Import-free on purpose: scripts/branch-list-state.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

export type BranchListMode = "pending" | "failed" | "ready";

/** Which arm the branch menu's list renders. Data wins (an error over data is a
 *  failed refresh; the rows still render). With nothing loaded, any error keeps it
 *  "failed" through retries, which flip `isPending` back on; no data and no errors
 *  is exactly `isPending` for this always-enabled query. Same arm order as
 *  BranchSwitcher's `unread`, so the list and the disabled reasons agree. The
 *  Remote group waits for local names, which it subtracts. */
export function branchListState(q: {
  errorUpdateCount: number;
  hasData: boolean;
}): { mode: BranchListMode; remoteGroupMayRender: boolean } {
  if (q.hasData) return { mode: "ready", remoteGroupMayRender: true };
  if (q.errorUpdateCount > 0)
    return { mode: "failed", remoteGroupMayRender: false };
  return { mode: "pending", remoteGroupMayRender: false };
}

/** Whether a failed list's read is being retried, by Try again or any other fetch:
 *  the mode stays "failed" through it, so this is what tells the two apart. Takes
 *  the query and reads `isFetching` only for a failed list, because react-query
 *  re-renders on just the fields a render read, and a healthy list's refetches
 *  shouldn't re-render the whole switcher. */
export function branchListRetrying(
  mode: BranchListMode,
  q: { isFetching: boolean },
): boolean {
  return mode === "failed" && q.isFetching;
}
