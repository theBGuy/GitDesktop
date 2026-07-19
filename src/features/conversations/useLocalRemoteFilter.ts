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
 * The search + author/label + archived filtering shared by the PR and issue
 * list panels (they were ~95% identical). Owns the filter UI state; `stateFilter`
 * stays caller-owned because it drives the data query. Exposes the visible
 * local/remote lists plus the per-author/per-label counts the popover needs.
 *
 * Note: `labelCount` counts BOTH remote and local labels (the PR panel already
 * did; the issue panel previously undercounted local-only labels — this unifies
 * them, a deliberate parity fix).
 */
export function useLocalRemoteFilter<
  L extends LocalLike,
  R extends RemoteLike,
>(opts: { locals: L[]; remotes: R[]; stateFilter: LocalRemoteState }) {
  const { locals, remotes, stateFilter } = opts;
  const [filterText, setFilterText] = useState("");
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  const stateLocal = locals.filter((l) =>
    stateFilter === "open" ? l.status === "open" : l.status !== "open",
  );
  // The query already returns only the active-state remotes.
  const stateRemote = remotes;

  // Filter options come from everything in the current state tab.
  const authors = [
    ...new Set(stateRemote.flatMap((r) => (r.author ? [r.author.login] : []))),
  ].sort();
  const labels = [
    ...new Set([
      ...stateRemote.flatMap((r) => r.labels.map((l) => l.name)),
      ...stateLocal.flatMap((l) => l.labels),
    ]),
  ].sort();

  const query = filterText.trim().toLowerCase();

  // Intersect the persisted filter Sets with the CURRENT option lists at every
  // consumption point below. State switches (Open↔Closed, Fork↔Upstream) change
  // which authors/labels exist without pruning the Sets, so a Set can hold an
  // entry absent from `authors`/`labels`; left live it would filter the list and
  // inflate the badge with no checkable row to clear it. Intersection makes such
  // out-of-scope entries INERT while leaving the state Set intact — an author who
  // vanishes on Open→Closed and returns on switching back is still selected.
  const activeAuthorFilter = new Set(
    authors.filter((a) => authorFilter.has(a)),
  );
  const activeLabelFilter = new Set(labels.filter((l) => labelFilter.has(l)));

  function matchesLocal(l: L): boolean {
    if (
      query &&
      !l.title.toLowerCase().includes(query) &&
      !l.labels.some((x) => x.toLowerCase().includes(query))
    ) {
      return false;
    }
    // Local items have no GitHub author — an author filter excludes them.
    if (activeAuthorFilter.size > 0) return false;
    if (
      activeLabelFilter.size > 0 &&
      !l.labels.some((x) => activeLabelFilter.has(x))
    ) {
      return false;
    }
    return true;
  }

  const matchingLocal = stateLocal.filter(matchesLocal);
  const visibleLocal = matchingLocal.filter((l) => showArchived || !l.archived);
  const archivedLocalCount = matchingLocal.filter((l) => l.archived).length;

  const visibleRemote = stateRemote.filter((r) => {
    const author = r.author?.login ?? "";
    if (
      query &&
      !r.title.toLowerCase().includes(query) &&
      !`#${r.number}`.includes(query) &&
      !author.toLowerCase().includes(query) &&
      !r.labels.some((l) => l.name.toLowerCase().includes(query))
    ) {
      return false;
    }
    if (activeAuthorFilter.size > 0 && !activeAuthorFilter.has(author))
      return false;
    if (
      activeLabelFilter.size > 0 &&
      !r.labels.some((l) => activeLabelFilter.has(l.name))
    ) {
      return false;
    }
    return true;
  });

  const activeFilterCount = activeAuthorFilter.size + activeLabelFilter.size;

  function toggle(which: "author" | "label", value: string, on: boolean) {
    const update = which === "author" ? setAuthorFilter : setLabelFilter;
    // Functional update: several toggles fired in one event batch must each
    // build on the previous one — cloning the render-time Set here would
    // silently drop all but the last (latent until a "clear all"-style
    // affordance emits multi-toggle batches).
    update((prev) => {
      const next = new Set(prev);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  const authorCount = (a: string) =>
    stateRemote.filter((r) => r.author?.login === a).length;
  const labelCount = (l: string) =>
    stateRemote.filter((r) => r.labels.some((x) => x.name === l)).length +
    stateLocal.filter((x) => x.labels.includes(l)).length;

  return {
    filterText,
    setFilterText,
    authorFilter,
    labelFilter,
    toggle,
    showArchived,
    setShowArchived,
    authors,
    labels,
    activeFilterCount,
    stateLocal,
    stateRemote,
    visibleLocal,
    archivedLocalCount,
    visibleRemote,
    authorCount,
    labelCount,
  };
}
