import type { BoardItem } from "@/lib/git/types";
import type { BoardColumnModel } from "./board-model";

/** A board card the user may put in a selection. A REDACTED card is not one: it
 *  renders as an inert div with no click or key handlers, so it can never be
 *  picked — and a range that spans one steps over it rather than carrying an
 *  item the board offers no way to deselect. */
function selectable(item: BoardItem): boolean {
  return item.content.kind !== "redacted";
}

/**
 * The item ids from `anchorId` to `targetId` inclusive, within the ONE column
 * that holds them both, or null when they sit in different columns.
 *
 * Column-scoped because a kanban has no honest two-dimensional range: the
 * columns are buckets of a field rather than an ordering, so a rectangle across
 * them would claim a sequence the board never draws. The panel answers the null
 * by TOGGLE-ADDING the target instead, which is the extension a user can still
 * predict.
 *
 * Null too when either id is undrawn — an anchor a refetch dropped has no range
 * left to extend, and the caller re-anchors on the landed card.
 */
export function columnRange(
  columns: BoardColumnModel[],
  anchorId: string,
  targetId: string,
): string[] | null {
  for (const column of columns) {
    const from = column.items.findIndex((item) => item.itemId === anchorId);
    if (from === -1) continue;
    const to = column.items.findIndex((item) => item.itemId === targetId);
    if (to === -1) return null;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return column.items
      .slice(lo, hi + 1)
      .filter(selectable)
      .map((item) => item.itemId);
  }
  return null;
}

/**
 * `selectedIds` narrowed to the cards the board currently DRAWS — the reading
 * every bulk action takes at fire time.
 *
 * Derived rather than swept by an effect: the columns change under the selection
 * from several directions at once (the archived toggle, a view's filter, a
 * refetch, a write's own patch), and a card that has left the board must never be
 * acted on by a verb that counted it.
 */
export function pruneSelection(
  selectedIds: ReadonlySet<string>,
  columns: BoardColumnModel[],
): Set<string> {
  const live = new Set<string>();
  if (selectedIds.size === 0) return live;
  for (const column of columns) {
    for (const item of column.items) {
      if (selectedIds.has(item.itemId) && selectable(item))
        live.add(item.itemId);
    }
  }
  return live;
}

/** The bulk verbs the selection bar and the card menu offer. */
export type BulkVerb = "move" | "fields" | "archive" | "restore" | "remove";

/**
 * A selection split into what `verb` can act on and what it skips. Mixed states
 * never BLOCK a verb — they scope it: archiving a selection that already holds
 * archived cards archives the rest, and the label counts only what will move.
 *
 * A move, a field write and an archive all need a live card (an archived one sits
 * in no column and is in no state to be rewritten); a restore needs an archived
 * one; a removal reaches every card by its membership alone.
 */
export function partitionEligible(
  verb: BulkVerb,
  items: BoardItem[],
): { eligible: BoardItem[]; skipped: BoardItem[] } {
  const eligible: BoardItem[] = [];
  const skipped: BoardItem[] = [];
  for (const item of items) {
    const ok =
      verb === "restore"
        ? item.isArchived
        : verb === "remove" || !item.isArchived;
    (ok ? eligible : skipped).push(item);
  }
  return { eligible, skipped };
}
