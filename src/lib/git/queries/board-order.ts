/**
 * The pure cache-shape helpers behind a Projects-board reposition: reading where a
 * card sits, splicing it to a new slot, and re-asserting GitHub's answered order
 * over the loaded pages.
 *
 * Import-free by design (types only, which Node's type-stripping erases) so
 * `scripts/board-order.test.mjs` can load it directly. Keep it that way — a runtime
 * import here fails that test.
 */
import type { InfiniteData } from "@tanstack/react-query";
import type { BoardItem, BoardItems, BoardOrder } from "../types";

/** One flat item sequence chunked back onto `data`'s pages at their ORIGINAL
 *  lengths, so each page keeps its own `endCursor`, `truncated` and `totalCount` —
 *  a reposition moves a card between pages, and page metadata describes the
 *  REQUEST that produced it, not the cards that happen to sit there now. A page
 *  whose items didn't move keeps its identity, so no column re-renders for a slice
 *  nothing touched. */
export function rechunkPages(
  data: InfiniteData<BoardItems, string | null>,
  flat: BoardItem[],
): InfiniteData<BoardItems, string | null> {
  let cut = 0;
  return {
    ...data,
    pages: data.pages.map((page) => {
      const items = flat.slice(cut, cut + page.items.length);
      cut += page.items.length;
      // Length first: a dedup shrinks the trailing page, and `every` alone would
      // pass vacuously over the shorter slice and reuse the page's OLD longer items.
      return items.length === page.items.length &&
        items.every((item, i) => item === page.items[i])
        ? page
        : { ...page, items };
    }),
  };
}

/** Where one item sits in a board's cached pages as a POSITION claim: the id it
 *  follows, or null when nothing eligible precedes it. Undefined when this lens
 *  doesn't draw it at all, which is a different statement from "first" and the only
 *  one a rollback may refuse to act on.
 *
 *  `positionable` skips ARCHIVED predecessors, which is the difference between the
 *  two callers: GitHub refuses an archived item as a position anchor ("The item to
 *  be positioned after is archived and cannot be used to update the position of this
 *  item", VALIDATION, measured 2026-09-19), while the cache splice is happy to sit
 *  after one.
 *
 *  The scan also skips further occurrences of the TARGET itself: one membership can
 *  appear twice while a write-through insert and a later `Load more` page both hold
 *  it, and an adjacent duplicate would otherwise make the item its own predecessor —
 *  an afterId GitHub rejects.
 *
 *  LAST occurrence, here and in {@link reorderBoardItem}: the board renders the last
 *  copy (`oneCardPerItem`), so a first-occurrence lookup would read and splice a copy
 *  the user cannot see. */
export function boardItemPredecessor(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  positionable: boolean,
): string | null | undefined {
  if (data === undefined) return undefined;
  const flat = data.pages.flatMap((page) => page.items);
  const at = flat.findLastIndex((item) => item.itemId === itemId);
  if (at === -1) return undefined;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (flat[i].itemId === itemId) continue;
    if (!positionable || !flat[i].isArchived) return flat[i].itemId;
  }
  return null;
}

/** The id this card follows in the cache, archived cards included — the ROLLBACK's
 *  target, which only has to describe where the splice put it. */
export const boardPredecessorId = (
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
) => boardItemPredecessor(data, itemId, false);

/** The id a WRITE may anchor this card to: the nearest non-archived predecessor,
 *  null when only archived cards precede it. Also what the chase compares against,
 *  so the comparison and the next anchor are the same reading of the cache. */
export const boardAnchorId = (
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
) => boardItemPredecessor(data, itemId, true);

/** One item spliced out of the loaded pages and reinserted directly after
 *  `afterId` — at the front for null, which is what the position mutation means by
 *  a null `afterId`. Both directions of the write go through here, the rollback
 *  included: it acts on the CURRENT cache rather than a snapshot, so a concurrent
 *  write to a sibling card and a `Load more` page that landed mid-flight both
 *  survive it. An item or an anchor the cache doesn't hold leaves the data
 *  untouched rather than inventing a place for it.
 *
 *  EVERY occurrence of the moved id is pulled from the flatten and one copy
 *  reinserted, not just the last: a write-through append plus a later `Load more`
 *  can hold the same membership twice, and reinserting the moved copy AHEAD of a
 *  lingering earlier duplicate would leave that stale-position duplicate as the last
 *  occurrence — the one `oneCardPerItem` draws and {@link boardItemPredecessor}
 *  reads. Deduping to a single copy is the correct side effect; the total drops by
 *  the removed duplicate and {@link rechunkPages} carries that shorter sequence with
 *  every page's own metadata intact. */
export function reorderBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  afterId: string | null,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  const flat = data.pages.flatMap((page) => page.items);
  const at = flat.findLastIndex((item) => item.itemId === itemId);
  if (at === -1) return data;
  const moved = flat[at];
  const rest = flat.filter((item) => item.itemId !== itemId);
  let to = 0;
  if (afterId !== null) {
    const anchor = rest.findLastIndex((item) => item.itemId === afterId);
    if (anchor === -1) return data;
    to = anchor + 1;
  }
  const next = [...rest.slice(0, to), moved, ...rest.slice(to)];
  // No-op only when the flatten is unchanged — same order AND no duplicate removed,
  // so an already-in-place card with no stray copy touches nothing.
  if (next.length === flat.length && next.every((item, i) => item === flat[i]))
    return data;
  return rechunkPages(data, next);
}

/** The board's own answer to a position write re-asserted over one cached lens:
 *  the loaded pages re-ordered into the sequence GitHub sent back, re-chunked in
 *  place. A cached id the payload never named leaves the lens exactly as it is —
 *  the payload covers the board's first 100 items, and ordering a cache against a
 *  list that doesn't contain all of it would be a guess. Those lenses reconcile on
 *  the stale mark `writeThroughBoards` (this function's caller, in
 *  queries/projects.ts) leaves behind. */
export function applyBoardOrder(
  data: InfiniteData<BoardItems, string | null> | undefined,
  order: BoardOrder,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  const rank = new Map(order.itemIds.map((id, i) => [id, i]));
  const flat = data.pages.flatMap((page) => page.items);
  if (flat.length === 0) return data;
  if (flat.some((item) => !rank.has(item.itemId))) return data;
  // Every id is in `rank` by the guard above; the fallbacks keep the comparator
  // total without an assertion.
  return rechunkPages(
    data,
    flat.toSorted(
      (a, b) => (rank.get(a.itemId) ?? 0) - (rank.get(b.itemId) ?? 0),
    ),
  );
}
