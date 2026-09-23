/**
 * The pure cache-shape helpers behind a Projects-board reposition: reading where a
 * card sits, splicing it to a new slot, and re-asserting GitHub's answered order
 * over the loaded pages.
 *
 * Import-free by design (types only, which Node's type-stripping erases) so
 * `scripts/board-order.test.mjs` can load it directly. Keep it that way — a runtime
 * import here fails that test.
 */
import type { InfiniteData, QueryKey } from "@tanstack/react-query";
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

/**
 * How one cached lens was patched for ONE card of a removal, so the rollback can
 * undo exactly that: the card taken out of it, or flipped to archived in place.
 * `itemId` rides each entry because a BULK write's undo list spans several cards
 * per lens.
 *
 * Lives here rather than beside the hooks that build it so {@link resolveUndoAnchor}
 * can too — the anchor walk is pure cache-shape reasoning, and keeping it in an
 * alias-free module is what lets the node test runner exercise the REAL walk
 * instead of a copy of it.
 */
export type BoardItemUndo =
  | {
      mode: "drop";
      key: QueryKey;
      itemId: string;
      /** Where the card sat, or null when this lens only ever COUNTED it — a card
       *  past the loaded pages of a lens whose count still included it. */
      at: RemovedBoardCard | null;
      /** Whether the drop took this lens's `totalCount` with it, so the undo knows
       *  whether to give it back. */
      counted: boolean;
    }
  | { mode: "archive"; key: QueryKey; itemId: string };

/**
 * Where `plan`'s card goes back, resolved against the cache AS IT IS NOW.
 *
 * The recorded anchor is the card's IMMEDIATE predecessor, which may itself have
 * been in the same batch. Three cases, and the walk covers all of them: the anchor
 * is still on the board (a survivor, or a sibling this rollback already put back,
 * which restoring in `flatIndex` order guarantees) and is used as-is; the anchor
 * was removed SUCCESSFULLY and is never coming back, so the walk steps through it
 * to whatever IT followed; or the chain runs out, which is the head of the board.
 *
 * `chain` is this lens's own batch, by item id. An anchor that is neither drawn nor
 * ours vanished under a concurrent change — the head is the honest answer there,
 * since nothing in this cache still says where it was.
 */
export function resolveUndoAnchor(
  data: InfiniteData<BoardItems, string | null> | undefined,
  plan: Extract<BoardItemUndo, { mode: "drop" }>,
  chain: ReadonlyMap<string, BoardItemUndo>,
): string | null {
  const drawn = (id: string) =>
    data?.pages.some((page) => page.items.some((cur) => cur.itemId === id)) ===
    true;
  let anchor = plan.at?.afterId ?? null;
  // Bounded by the batch: every step consumes one of its entries, and `seen`
  // refuses a cycle a corrupted chain could otherwise spin on.
  const seen = new Set<string>();
  while (anchor !== null && !drawn(anchor)) {
    if (seen.has(anchor)) return null;
    seen.add(anchor);
    const prev = chain.get(anchor);
    if (prev === undefined || prev.mode !== "drop") return null;
    anchor = prev.at?.afterId ?? null;
  }
  return anchor;
}

/** Where one card sat when a removal took it, as the ROLLBACK addresses it. */
export interface RemovedBoardCard {
  /** Its place in the lens's FLATTENED sequence at capture time. Used ONLY to
   *  order a multi-card undo — restoring in the order the cards left is what puts
   *  each card's predecessor back before its dependents look for it — and never as
   *  a restore target: an absolute slot moves the instant a sibling in the same
   *  batch is spliced out from in front of it. */
  flatIndex: number;
  /** The id this card directly followed, or null for the head of the board. The
   *  restore TARGET. An id rather than a slot because only an id survives the
   *  other removals in its own batch. */
  afterId: string | null;
  item: BoardItem;
}

/**
 * `itemId` as a rollback target: the card, its flattened place, and the id it
 * follows — or null when this lens doesn't draw it.
 *
 * Computed against the DEDUPED view, which is the property this whole anchor
 * shape turns on: the board draws the LAST copy of every membership
 * (`oneCardPerItem` in ProjectsBoardPanel), so a cache holding one card twice
 * renders a sequence the raw flatten does not. An earlier copy is not a card
 * anyone can see, and anchoring to one would place the restored card against
 * something that isn't there — `[x, b, x, c]` renders `[b, x, c]`, where a raw
 * walk reads b's predecessor as the invisible leading `x` and puts b back in
 * second place.
 *
 * {@link insertBoardCardAfter} resolves its anchor the same way, and the pair is
 * what makes a capture/restore round trip render exactly what it started as.
 */
export function captureRemovedCard(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
): RemovedBoardCard | null {
  if (data === undefined) return null;
  const flat = data.pages.flatMap((page) => page.items);
  // Every membership's drawn copy, in one pass — the same last-occurrence-wins
  // reading `oneCardPerItem` applies at the flatten point.
  const drawnAt = new Map<string, number>();
  flat.forEach((item, i) => drawnAt.set(item.itemId, i));
  const at = drawnAt.get(itemId);
  if (at === undefined) return null;
  let afterId: string | null = null;
  for (let i = at - 1; i >= 0; i -= 1) {
    // Skips every occurrence that is not its OWN item's last, which subsumes the
    // target's earlier copies (their drawn index is `at`, never `i`) and keeps an
    // undrawn duplicate of any OTHER membership from becoming the anchor.
    if (drawnAt.get(flat[i].itemId) !== i) continue;
    afterId = flat[i].itemId;
    break;
  }
  return { flatIndex: at, afterId, item: flat[at] };
}

/**
 * One card put back directly after `afterId`, or at the head of the board for
 * null — {@link captureRemovedCard}'s inverse, onto the CURRENT cache rather than
 * a snapshot of the world.
 *
 * Anchored rather than indexed because a partial rollback restores into pages the
 * SUCCESSFUL removals have already shortened: dropping A and B from `[A, B, C, D]`
 * and putting only B back at its old index 1 yields `[C, B, D]`, where anchoring B
 * to what it followed yields `[B, C, D]`.
 *
 * Three ways the board can have moved on underneath, each left alone rather than
 * forced: a refetch already put the card back (never insert it twice), the cache
 * holds no pages to insert into, or the anchor itself is no longer drawn — which
 * the caller normally resolves away, so the append here is a floor rather than a
 * behaviour anything relies on.
 */
export function insertBoardCardAfter(
  data: InfiniteData<BoardItems, string | null> | undefined,
  item: BoardItem,
  afterId: string | null,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  if (data.pages.length === 0) return data;
  if (
    data.pages.some((page) =>
      page.items.some((cur) => cur.itemId === item.itemId),
    )
  )
    return data;
  const put = (pageIndex: number, itemIndex: number) => ({
    ...data,
    pages: data.pages.map((page, i) => {
      if (i !== pageIndex) return page;
      const items = [...page.items];
      items.splice(itemIndex, 0, item);
      return { ...page, items };
    }),
  });
  if (afterId === null) return put(0, 0);
  // The anchor's LAST flattened occurrence — pages walked BACKWARD, and the last
  // index within the page that holds it. Symmetric with
  // {@link captureRemovedCard}, and for the same reason: one membership can sit in
  // two pages at once (a write-through insert plus a later `Load more` that
  // carries it again), and `oneCardPerItem` draws the LAST copy. Landing after the
  // FIRST copy puts the restored card ahead of the anchor in the rendered board —
  // pages `[A, X], [X, C]` restoring B after X would flatten to `[A, X, B, X, C]`
  // and render `[A, B, X, C]`, which is the one order the anchor ruled out.
  for (let pageIndex = data.pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const at = data.pages[pageIndex].items.findLastIndex(
      (cur) => cur.itemId === afterId,
    );
    if (at !== -1) return put(pageIndex, at + 1);
  }
  const last = data.pages.length - 1;
  return put(last, data.pages[last].items.length);
}

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
