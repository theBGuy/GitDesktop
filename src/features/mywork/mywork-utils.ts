import type { MyWorkItem } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";

/** Which slice of the inbox the tab strip is showing. */
export type MyWorkTab = "all" | "prs" | "issues";

/** The backend's page cap (each search leg's `--limit` and the merged page's
 *  truncation) — mirrors `MY_WORK_LIMIT` in `src-tauri/src/github/my_work.rs`;
 *  the two must change together. A full page is the signal the feed MAY be
 *  truncated, never a count of what exists: unaddressable hits are dropped
 *  server-side, so a truncated page can arrive short and read as complete —
 *  which is why the note states the constraint, not a number. */
export const MY_WORK_LIMIT = 200;

export const MY_WORK_LISTBOX_ID = "my-work-listbox";

/** Stable DOM id per row, so the filter input's aria-activedescendant can point
 *  at the keyboard-highlighted option. The item URL is unique per item. */
export const myWorkOptionId = (url: string) =>
  `my-work-${url.replace(/[^\w-]/g, "_")}`;

/**
 * A recent repository that looks like this item's, or null. `RecentRepo.name`
 * is the checkout's FOLDER basename, not the remote's repo name, so this is a
 * heuristic in both directions: a clone in a renamed folder (or a worktree)
 * never matches and opens in the browser, and a folder that happens to be named
 * after a different repo of the same owner can match wrongly. `owner`/`host`
 * resolve in the background, so a recent missing either never matches, as does
 * an item whose URL had no parseable authority (empty host).
 */
export function matchLocalRepo(
  item: MyWorkItem,
  recents: readonly RecentRepo[],
): RecentRepo | null {
  const host = item.host.toLowerCase();
  const owner = item.repoOwner.toLowerCase();
  const name = item.repoName.toLowerCase();
  if (!host || !owner || !name) return null;
  return (
    recents.find(
      (r) =>
        !!r.host &&
        !!r.owner &&
        r.host.toLowerCase() === host &&
        r.owner.toLowerCase() === owner &&
        r.name.toLowerCase() === name,
    ) ?? null
  );
}

/**
 * Newest first by `updatedAt`. Forge timestamps are untrusted, so an
 * unparseable date sorts to the bottom rather than landing wherever a NaN
 * comparison drops it.
 */
export function sortMyWork(items: readonly MyWorkItem[]): MyWorkItem[] {
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
