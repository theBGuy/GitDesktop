import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export type LocalRemoteState = "open" | "closed";

/** Minimal shape of a local PR/issue the filter needs. */
export interface LocalLike {
  id: string;
  title: string;
  labels: string[];
  status: string;
  archived?: boolean;
}

/** Minimal shape of a GitHub PR/issue the filter needs. */
export interface RemoteLike {
  number: number;
  title: string;
  author: { login: string } | null;
  labels: { name: string }[];
}

/**
 * The search + archived filtering shared by the PR and issue list panels, plus the
 * author/label option lists and counts the filter popover renders. `stateFilter`
 * stays caller-owned because it drives the data query, and so do the author/label
 * selections themselves — the server applies those now (see `useRemoteListFilter`),
 * so this hook only reports which options exist and how many rows each covers.
 *
 * Note: `labelCount` counts BOTH remote and local labels (the PR panel already
 * did; the issue panel previously undercounted local-only labels — this unifies
 * them, a deliberate parity fix).
 */
export function useLocalRemoteFilter<
  L extends LocalLike,
  R extends RemoteLike,
>(opts: {
  locals: L[];
  remotes: R[];
  stateFilter: LocalRemoteState;
  /** The server-side author selection — excludes the local section wholesale. */
  authorFilter: Set<string>;
  /** The server-side label selection; still applied client-side to LOCAL rows,
   *  which the forge query never saw. */
  labelFilter: Set<string>;
  /** Any "mine" axis (assigned / review-requested / team) is active. */
  mineActive: boolean;
  /** The forge applied `labelFilter` to the remote rows itself. False and this hook
   *  applies it here instead — see the predicate in `visibleRemote`. */
  labelsServerSide: boolean;
  /** Key PREFIX of this list's query family — everything up to and including the
   *  state axis, so every cached page (any limit, any filter) matches. Used to keep
   *  the option lists and counts whole while a filter is active. Omit to derive
   *  them from the visible rows alone. */
  optionSourcePrefix?: readonly unknown[];
}) {
  const {
    locals,
    remotes,
    stateFilter,
    authorFilter,
    labelFilter,
    mineActive,
    labelsServerSide,
    optionSourcePrefix,
  } = opts;
  const [filterText, setFilterText] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const queryClient = useQueryClient();

  const stateLocal = locals.filter((l) =>
    stateFilter === "open" ? l.status === "open" : l.status !== "open",
  );
  // The query already returns only the active-state remotes.
  const stateRemote = remotes;

  // Options and counts read a UNION of the rows on screen, EVERY cached page of
  // this list family, and the current selection. Deriving them from the filtered
  // rows alone would collapse the option list to whatever is already selected and
  // report (0) beside every other name — a one-way door out of a filter. The match
  // is a key PREFIX, not one pinned key: a limit bump, a state tab, or a lens
  // switch mints a new key, and a single-key read would miss every page under it.
  // The read sits INSIDE this expression on purpose — lifted to its own binding the
  // compiler would memoize it on the prefix alone, so a page landing later than the
  // first read would never be picked up.
  const optionRows = ((): R[] => {
    if (!optionSourcePrefix) return stateRemote;
    const pages = queryClient.getQueriesData<R[]>({
      predicate: (q) =>
        optionSourcePrefix.every((part, i) => q.queryKey[i] === part),
    });
    let rows = stateRemote;
    for (const [, page] of pages) {
      if (page && page !== rows) rows = mergeRows(rows, page);
    }
    return rows;
  })();

  const authors = [
    ...new Set([
      ...optionRows.flatMap((r) => (r.author ? [r.author.login] : [])),
      ...authorFilter,
    ]),
  ].sort();
  const labels = [
    ...new Set([
      ...optionRows.flatMap((r) => r.labels.map((l) => l.name)),
      ...stateLocal.flatMap((l) => l.labels),
      ...labelFilter,
    ]),
  ].sort();

  const query = filterText.trim().toLowerCase();

  function matchesLocal(l: L): boolean {
    if (
      query &&
      !l.title.toLowerCase().includes(query) &&
      !l.labels.some((x) => x.toLowerCase().includes(query))
    ) {
      return false;
    }
    // Local items have no forge author, assignee or requested reviewer, so an
    // author selection or any active "mine" axis excludes the whole local section
    // rather than showing rows the scope can't describe.
    if (authorFilter.size > 0 || mineActive) return false;
    if (labelFilter.size > 0 && !l.labels.some((x) => labelFilter.has(x))) {
      return false;
    }
    return true;
  }

  const matchingLocal = stateLocal.filter(matchesLocal);
  const visibleLocal = matchingLocal.filter((l) => showArchived || !l.archived);
  const archivedLocalCount = matchingLocal.filter((l) => l.archived).length;

  // Author narrowing happens server-side, so it isn't re-applied here — that would
  // hide rows the forge deliberately matched (on a label the page payload doesn't
  // carry, say). Labels are the exception a provider can force: where the forge
  // can't filter by them, the pick lands here instead, so a provider whose PRs
  // carry no labels shows an EMPTY remote section under a label pick rather than
  // an unfiltered one under an active badge.
  const visibleRemote = stateRemote.filter((r) => {
    if (
      !labelsServerSide &&
      labelFilter.size > 0 &&
      !r.labels.some((l) => labelFilter.has(l.name))
    ) {
      return false;
    }
    if (!query) return true;
    const author = r.author?.login ?? "";
    return (
      r.title.toLowerCase().includes(query) ||
      `#${r.number}`.includes(query) ||
      author.toLowerCase().includes(query) ||
      r.labels.some((l) => l.name.toLowerCase().includes(query))
    );
  });

  const authorCount = (a: string) =>
    optionRows.filter((r) => r.author?.login === a).length;
  const labelCount = (l: string) =>
    optionRows.filter((r) => r.labels.some((x) => x.name === l)).length +
    stateLocal.filter((x) => x.labels.includes(l)).length;

  return {
    filterText,
    setFilterText,
    showArchived,
    setShowArchived,
    authors,
    labels,
    stateLocal,
    stateRemote,
    visibleLocal,
    archivedLocalCount,
    visibleRemote,
    authorCount,
    labelCount,
  };
}

/** Visible rows first, then whatever the unfiltered page adds — deduped by number
 *  so a row present in both counts once. */
function mergeRows<R extends RemoteLike>(visible: R[], extra: R[]): R[] {
  const seen = new Set(visible.map((r) => r.number));
  return [...visible, ...extra.filter((r) => !seen.has(r.number))];
}
