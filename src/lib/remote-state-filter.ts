/**
 * The state-tab predicates the PR and issue lists share. A remote row is filed
 * by its own `state`, never by the list read that returned it: a forge's list
 * membership can lag a merge, close or reopen the row itself already reports.
 * Every provider maps open to "OPEN" and merged to "MERGED" (a locked GitLab MR
 * arrives as "CLOSED"). "closed" means everything not open (the issue lists'
 * Closed tab and the legacy PR callers); the PR panel's tabs split that into
 * "merged" and "unmerged", where every state but OPEN and MERGED lands.
 *
 * Import-free at runtime on purpose: `scripts/remote-state-filter.test.mjs`
 * and `scripts/pr-state-tabs.test.mjs` load it straight from `src/` under
 * Node's type stripping, so any import here must be type-only.
 */

export type LocalRemoteState = "open" | "closed" | "merged" | "unmerged";

/** The PR panel's three tabs (never "closed"). */
export type PrListTab = "open" | "merged" | "unmerged";

export function remoteStateMatches(
  state: string,
  filter: LocalRemoteState,
): boolean {
  switch (filter) {
    case "open":
      return state === "OPEN";
    case "closed":
      return state !== "OPEN";
    case "merged":
      return state === "MERGED";
    case "unmerged":
      return state !== "OPEN" && state !== "MERGED";
  }
}

/** Mirrors {@link remoteStateMatches}, so a stored status this build doesn't
 *  know (the app-data file is hand-editable) still lands under Closed. */
export function localStateMatches(
  status: string,
  filter: LocalRemoteState,
): boolean {
  switch (filter) {
    case "open":
      return status === "open";
    case "closed":
      return status !== "open";
    case "merged":
      return status === "merged";
    case "unmerged":
      return status !== "open" && status !== "merged";
  }
}

/** Which PR tab a remote PR's own state lands on. Total by construction, and
 *  congruent with {@link remoteStateMatches}: the align never lands on a tab
 *  that won't list the row. */
export function prAlignTab(state: string): PrListTab {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "unmerged";
}

/** Which PR tab a local PR's status lands on. Mirrors {@link prAlignTab} and
 *  {@link localStateMatches}: the stored status is untrusted, so anything but
 *  "open" or "merged" lands on Closed, the tab that lists it. */
export function localPrAlignTab(status: unknown): PrListTab {
  if (status === "open") return "open";
  if (status === "merged") return "merged";
  return "unmerged";
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
 *  cached page's identity (no observer notify churn). Anything but an array comes
 *  back as it is: the callers run in a write's success callback, where a throw
 *  can turn a landed write into an error. */
export function patchRowState<R extends { number: number; state: string }>(
  page: R[] | undefined,
  number: number,
  state: string,
): R[] | undefined {
  if (!Array.isArray(page)) return page;
  if (!page.some((r) => r.number === number && r.state !== state)) return page;
  return page.map((r) => (r.number === number ? { ...r, state } : r));
}
