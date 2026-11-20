/**
 * The state-tab predicates the PR and issue lists share. A remote row is filed
 * by its own `state`, never by the list read that returned it: a forge's list
 * membership can lag a merge, close or reopen the row itself already reports.
 * Every provider maps open to "OPEN" and merged to "MERGED"; a GitLab MR that
 * is mid-merge (`locked`) maps to "MERGING" and is filed like "CLOSED" here,
 * and only the merge-state read says whether it is
 * still locked ({@link prAlignStep} holds the align on that read). "closed"
 * means everything not open (the issue lists' Closed tab and the legacy PR
 * callers); the PR panel's tabs split that into "merged" and "unmerged",
 * where every state but OPEN and MERGED lands.
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
 *  congruent with {@link remoteStateMatches}. A GitLab MR mid-merge reports
 *  "MERGING", filed like "CLOSED", though no tab lists it, so the align consults
 *  {@link prAlignStep} before taking this answer for one. */
export function prAlignTab(state: string): PrListTab {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "unmerged";
}

/** The merge-state read an align of a GitLab MR consults, as the panel sees it. */
export type PrAlignProbe =
  | { status: "idle" | "pending" | "failed" }
  | { status: "ok"; locked: boolean; state: string | undefined };

export type PrAlignStepResult =
  | { do: "settle"; tab: PrListTab }
  | { do: "wait" }
  | { do: "disarm" };

/** What a pending remote align does next. Only a `lockable` provider's would-be
 *  Closed answer consults `probe`, since a locked GitLab MR reads "MERGING" while
 *  its merge runs; the tab then comes from the probe's OWN state, so two reads
 *  can't straddle the unlock. A probe that never answered falls back to `tab0`,
 *  but once one read said locked (`sawLocked`) a failure never settles Closed:
 *  it waits on the remaining polls and disarms when they run out. */
export function prAlignStep(
  detailsState: string,
  lockable: boolean,
  probe: PrAlignProbe,
  pollsLeft: number,
  sawLocked: boolean,
): PrAlignStepResult {
  const tab0 = prAlignTab(detailsState);
  if (!lockable || tab0 !== "unmerged") return { do: "settle", tab: tab0 };
  switch (probe.status) {
    case "idle":
    case "pending":
      return { do: "wait" };
    case "failed":
      if (!sawLocked) return { do: "settle", tab: tab0 };
      return pollsLeft > 0 ? { do: "wait" } : { do: "disarm" };
    case "ok":
      if (probe.locked)
        return pollsLeft > 0 ? { do: "wait" } : { do: "disarm" };
      return {
        do: "settle",
        tab:
          typeof probe.state === "string" && probe.state !== ""
            ? prAlignTab(probe.state)
            : tab0,
      };
  }
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

/** The stack layers a merge at `mergedPosition` takes with it: the numbers of
 *  members below it that are still open, the set the merge dialog discloses
 *  (StackSection's `stackMergeBelow` keeps the same `m.position < stack.position`
 *  predicate). `members` comes from cached forge JSON, so it never throws: a
 *  member that is not an object with a finite `number` and `position` and a
 *  string `state` is skipped, and anything but an array or a finite
 *  `mergedPosition` gives `[]`. */
export function cascadedStackNumbers(
  members: unknown,
  mergedPosition: unknown,
): number[] {
  if (!Array.isArray(members)) return [];
  if (typeof mergedPosition !== "number" || !Number.isFinite(mergedPosition)) {
    return [];
  }
  const out: number[] = [];
  for (const m of members as unknown[]) {
    if (typeof m !== "object" || m === null) continue;
    const { number, position, state } = m as Record<string, unknown>;
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    if (typeof position !== "number" || !Number.isFinite(position)) continue;
    if (typeof state !== "string") continue;
    if (position < mergedPosition && state.toLowerCase() === "open") {
      out.push(number);
    }
  }
  return out;
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
