/**
 * The Open/Closed tab predicate the PR and issue lists share. A remote row is
 * filed by its own `state`, never by the list read that returned it: a forge's
 * open-list membership can lag a merge, close or reopen the row itself already
 * reports. Every provider maps open to "OPEN" (a locked GitLab MR arrives as
 * "CLOSED"); merged, closed and any other state land in Closed.
 *
 * Import-free at runtime on purpose: `scripts/remote-state-filter.test.mjs`
 * loads it straight from `src/` under Node's type stripping.
 */

export type LocalRemoteState = "open" | "closed";

export function remoteStateMatches(
  state: string,
  filter: LocalRemoteState,
): boolean {
  return filter === "open" ? state === "OPEN" : state !== "OPEN";
}

export function localStateMatches(
  status: string,
  filter: LocalRemoteState,
): boolean {
  return filter === "open" ? status === "open" : status !== "open";
}

/** `rows` narrowed to `filter`'s tab. Placeholder rows pass through untouched:
 *  the list reads keep previous data across the state, limit and filter axes,
 *  so after a tab switch they are the OTHER tab's rows, and filtering them
 *  would empty the section and flash its empty copy until the tab's own read
 *  lands. */
export function filterRemoteRows<R extends { state: string }>(
  rows: R[],
  filter: LocalRemoteState,
  isPlaceholder: boolean,
): R[] {
  if (isPlaceholder) return rows;
  return rows.filter((r) => remoteStateMatches(r.state, filter));
}
