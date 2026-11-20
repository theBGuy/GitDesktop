import type { MyWorkItem, MyWorkPage } from "@/lib/git/types";

/** Which slice of the inbox the tab strip is showing. */
export type MyWorkTab = "all" | "prs" | "issues";

export const MY_WORK_LISTBOX_ID = "my-work-listbox";

/** Stable DOM id per row, so the filter input's aria-activedescendant can point
 *  at the keyboard-highlighted option. The item URL is unique per item, and the
 *  encoding is injective (every char outside `[A-Za-z0-9-]`, `_` included,
 *  becomes `_` + its 4-hex UTF-16 unit), so the id stays unique and needs no
 *  CSS escaping. */
export const myWorkOptionId = (url: string) =>
  `my-work-${url.replace(
    /[^A-Za-z0-9-]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}`;

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
