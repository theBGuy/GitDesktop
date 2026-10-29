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
 *  a same-state placeholder arrives already filed by the list hooks
 *  ({@link filterPlaceholderRows}), and a cross-state one is the OTHER tab's
 *  rows, which filtering would empty, flashing the section's empty copy until
 *  the tab's own read lands. */
export function filterRemoteRows<R extends { state: string }>(
  rows: R[],
  filter: LocalRemoteState,
  isPlaceholder: boolean,
): R[] {
  if (isPlaceholder) return rows;
  return rows.filter((r) => remoteStateMatches(r.state, filter));
}

const placeholderMemo = new WeakMap<
  object,
  Partial<Record<LocalRemoteState, unknown[] | undefined>>
>();

/** A served placeholder page's rows: a page kept from ANOTHER state axis passes
 *  whole (the other tab's rows — filtering would empty the section and flash its
 *  empty copy), while a page kept across a limit/filter change on the SAME state
 *  axis is this tab's, so its rows are filed by their own state like settled ones.
 *  A non-empty page that files down to nothing serves no placeholder: an empty
 *  list is the new read's answer to give. Memoized per source array. */
export function filterPlaceholderRows<R extends { state: string }>(
  rows: R[],
  filter: LocalRemoteState,
  sourceState: unknown,
): R[] | undefined {
  if (sourceState !== filter) return rows;
  let byFilter = placeholderMemo.get(rows);
  if (!byFilter) {
    byFilter = {};
    placeholderMemo.set(rows, byFilter);
  }
  if (filter in byFilter) return byFilter[filter] as R[] | undefined;
  const filed = filterRemoteRows(rows, filter, false);
  const served = filed.length === 0 && rows.length > 0 ? undefined : filed;
  byFilter[filter] = served;
  return served;
}

/** `page` with `number`'s row re-filed under `state`. Returns the SAME array when
 *  no row matches or it already carries that state, so a no-op write keeps every
 *  cached page's identity (no observer notify churn). */
export function patchRowState<R extends { number: number; state: string }>(
  page: R[] | undefined,
  number: number,
  state: string,
): R[] | undefined {
  if (!page?.some((r) => r.number === number && r.state !== state)) return page;
  return page.map((r) => (r.number === number ? { ...r, state } : r));
}
