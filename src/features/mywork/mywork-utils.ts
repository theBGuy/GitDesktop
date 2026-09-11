import type { MyWorkItem, MyWorkPage } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";

/** Which slice of the inbox the tab strip is showing. */
export type MyWorkTab = "all" | "prs" | "issues";

export const MY_WORK_LISTBOX_ID = "my-work-listbox";

/** Stable DOM id per row, so the filter input's aria-activedescendant can point
 *  at the keyboard-highlighted option. The item URL is unique per item. */
export const myWorkOptionId = (url: string) =>
  `my-work-${url.replace(/[^\w-]/g, "_")}`;

/**
 * The host/owner/name test a recent must pass to look like this item's, or null
 * when the item can't supply one. Matches on `RecentRepo.repoName` — the name
 * the record's origin URL spells — so a clone in a renamed folder resolves
 * exactly. Rows the owner probe hasn't touched yet carry no `repoName` and fall
 * back to `name`, the FOLDER basename, which stays a heuristic in both
 * directions: a renamed clone never matches and opens in the browser, and a
 * folder named after a different repo of the same owner can match wrongly.
 * `owner`/`host` resolve in the background, so a recent missing either never
 * matches, as does an item whose URL had no parseable authority (empty host).
 */
function localMatcher(item: MyWorkItem): ((r: RecentRepo) => boolean) | null {
  const host = item.host.toLowerCase();
  const owner = item.repoOwner.toLowerCase();
  const name = item.repoName.toLowerCase();
  if (!host || !owner || !name) return null;
  return (r) =>
    !!r.host &&
    !!r.owner &&
    r.host.toLowerCase() === host &&
    r.owner.toLowerCase() === owner &&
    (r.repoName ?? r.name).toLowerCase() === name;
}

/**
 * EVERY recent repository that looks like this item's, in recents order. The key
 * is not always identity: a GitLab item's owner is only the segment before the
 * repo name, so two different projects can both answer it and only reading each
 * checkout's origin can say which is the row's. Callers narrow this further and
 * resolve across what remains — both to open and to decide whether a row may
 * advertise a local action at all.
 */
export function matchLocalRepos(
  item: MyWorkItem,
  recents: readonly RecentRepo[],
): RecentRepo[] {
  const matches = localMatcher(item);
  return matches ? recents.filter(matches) : [];
}

/**
 * Newest first by `updatedAt`. Forge timestamps are untrusted, so an
 * unparseable date sorts to the bottom rather than landing wherever a NaN
 * comparison drops it.
 */
function sortMyWork(items: readonly MyWorkItem[]): MyWorkItem[] {
  return items.toSorted((a, b) => {
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    const aOk = !Number.isNaN(at);
    const bOk = !Number.isNaN(bt);
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (!aOk) return 0;
    return bt - at;
  });
}

/**
 * Every provider's leg merged into one page, in the order given. Dedups by
 * `url` — the identity a row navigates by — keeping the first leg's copy, and
 * never re-caps: each leg arrives already capped, so `truncated` only has to
 * carry whether ANY of them was.
 */
export function mergeMyWorkPages(
  pages: Array<MyWorkPage | undefined>,
): MyWorkPage {
  const seen = new Set<string>();
  const items: MyWorkItem[] = [];
  for (const page of pages) {
    for (const item of page?.items ?? []) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }
  return {
    items: sortMyWork(items),
    truncated: pages.some((p) => p?.truncated ?? false),
  };
}

/** The rows a tab + filter leave visible. Client-side over already-loaded data,
 *  so no debounce: every keystroke re-filters an array, never the network. */
export function filterMyWork(
  items: readonly MyWorkItem[],
  tab: MyWorkTab,
  query: string,
): MyWorkItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (tab === "prs" && !item.isPullRequest) return false;
    if (tab === "issues" && item.isPullRequest) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.repoFullName.toLowerCase().includes(q) ||
      `#${item.number}`.includes(q)
    );
  });
}
