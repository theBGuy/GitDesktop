/**
 * Where a card lands when it is moved inside its own column or dropped into any
 * column, expressed as the `afterId` GitHub's position mutation takes.
 *
 * Import-free and structurally typed on purpose: `scripts/board-positioning.test.mjs`
 * loads this module through Node's type stripping, which erases types rather than
 * compiling them and resolves no bundler aliases. A runtime or aliased import added
 * here fails that test.
 */

export type ReorderDirection = "up" | "down" | "top" | "bottom";

/** What a keypress resolves to: a write, nothing to do, or a refusal that has to
 *  be said out loud. `held` is never a silent no-op — the board has more cards
 *  than it has loaded, so the move is possible and just not expressible yet. */
export type ReorderPlan =
  | { kind: "move"; afterId: string | null }
  | { kind: "noop" }
  | { kind: "held"; reason: "truncated" };

const NOOP: ReorderPlan = { kind: "noop" };
const HELD_TRUNCATED: ReorderPlan = { kind: "held", reason: "truncated" };

/** What the planner reads of a card: its membership id, and whether it is
 *  archived. Structural, so any board item satisfies it. */
export interface PositionedCard {
  itemId: string;
  isArchived: boolean;
}

/** `cards` as the planner reads them, a card with a RESTORE in flight counted
 *  archived: the board already draws it live, but GitHub still refuses it as an
 *  anchor until the unarchive lands. The same array back when nothing restores. */
export function plannerCards(
  cards: readonly PositionedCard[],
  restoringIds: ReadonlySet<string>,
): readonly PositionedCard[] {
  if (restoringIds.size === 0) return cards;
  return cards.map((card) =>
    restoringIds.has(card.itemId)
      ? { itemId: card.itemId, isArchived: true }
      : card,
  );
}

/**
 * The card lands immediately BEFORE `beforeId`, which the position mutation can
 * only say as "after whatever comes before it" — so the answer is that neighbour's
 * nearest LIVE global predecessor, and null (the top of the board) when there
 * isn't one. Archived predecessors are walked past because GitHub refuses one as
 * an anchor, and the server keeps them in their slots either way.
 *
 * The predecessor can belong to ANOTHER column: `order` is the project's own
 * global sequence, which interleaves the columns, and a position write addresses
 * that sequence rather than the column the board draws.
 */
function landBefore(
  order: readonly PositionedCard[],
  beforeId: string,
): ReorderPlan {
  const at = order.findIndex((card) => card.itemId === beforeId);
  // A neighbour the flatten doesn't hold is a board that moved under the press;
  // refusing beats writing a position derived from a list that disagrees with
  // the columns.
  if (at === -1) return NOOP;
  for (let i = at - 1; i >= 0; i -= 1)
    if (!order[i].isArchived) return { kind: "move", afterId: order[i].itemId };
  return { kind: "move", afterId: null };
}

/**
 * Where moving `column[index]` in `direction` puts it, as an `afterId` for
 * GitHub's position mutation.
 *
 * Every verb works on the column's LIVE cards: archived ones stay where they are
 * and are never an anchor, since GitHub refuses one ("The item to be positioned
 * after is archived and cannot be used to update the position of this item",
 * VALIDATION, re-measured 2026-09-26) and places archived items around a moved
 * card exactly as the cache splice does. So "down" lands after the next live
 * card, and an archived card is never a move's subject either.
 *
 * Moving DOWN one slot is safe even on a truncated board — its anchor is always a
 * loaded neighbour — so it holds only at the loaded end. Moving to the BOTTOM is
 * held for ANY card on a truncated board: the true bottom lives past the loaded
 * end, so the last LOADED card would leave the card mid-column after `Load more`.
 * Moving UP or to the TOP never has that problem — everything above a drawn card
 * is drawn.
 *
 * Under a FILTERED view `order` is that lens's own loaded list, so the plan is
 * exact in the view and approximate in global interleave: items the filter hides
 * between the global predecessor and the visible one end up below the moved card.
 * The same accepted edge a filtered insert carries.
 */
export function planReorder(args: {
  /** Loaded project-global order (the deduped page flatten), archived cards
   *  INCLUDED: the planner walks past them itself. */
  order: readonly PositionedCard[];
  /** The card's own column, in drawn order, archived cards included when drawn. */
  column: readonly PositionedCard[];
  /** Index of the moved card within `column`. */
  index: number;
  direction: ReorderDirection;
  /** Last loaded page's truncated flag. */
  truncated: boolean;
}): ReorderPlan {
  const { order, column, index, direction, truncated } = args;
  const moved = column[index];
  if (moved === undefined || moved.isArchived) return NOOP;
  const live = (card: PositionedCard) => !card.isArchived;
  switch (direction) {
    case "down": {
      const next = column.slice(index + 1).find(live);
      if (next === undefined) return truncated ? HELD_TRUNCATED : NOOP;
      return { kind: "move", afterId: next.itemId };
    }
    case "bottom": {
      // Held whenever the board is truncated, not only at the last index: the true
      // bottom is past the loaded end, so the last loaded card would land the card
      // mid-column once the rest pages in.
      if (truncated) return HELD_TRUNCATED;
      const last = column.findLastIndex(live);
      if (last <= index) return NOOP;
      return { kind: "move", afterId: column[last].itemId };
    }
    case "up": {
      const prev = column.slice(0, index).findLast(live);
      if (prev === undefined) return NOOP;
      return landBefore(order, prev.itemId);
    }
    // "top": the same landing as an `up` whose neighbour is the column's first
    // live card, which is what makes a card already sitting there a no-op.
    default: {
      const first = column.findIndex(live);
      if (first === -1 || first >= index) return NOOP;
      return landBefore(order, column[first].itemId);
    }
  }
}

/** A pointer drop's arguments, shared by `dropAnchor` and `planDrop`. */
interface DropArgs {
  /** Loaded project-global order (the deduped page flatten), archived cards INCLUDED. */
  order: readonly PositionedCard[];
  /** The TARGET column in drawn order, archived cards included when drawn. It holds the
   *  moved card when the drop stays in its own column, and does not when it crosses. */
  column: readonly PositionedCard[];
  /** The dragged card. */
  movedId: string;
  /** The card in `column` the drop slot sits immediately before; null = end of the column. */
  beforeId: string | null;
  /** Last loaded page's truncated flag. */
  truncated: boolean;
}

/**
 * The anchor that puts `movedId` immediately before `beforeId` in `column`, or
 * at the column's end when it is null, whether or not the card already sits
 * there: a board that already draws the card at the slot (the status write's
 * optimistic patch) still gets its position written.
 *
 * Both lists are read with the moved card removed, so a slot is named by the
 * cards that stay. An end drop on a truncated board is held for the same reason
 * `bottom` is, since cards may exist past the loaded end. A column with no other
 * live card is the exception and plans nothing: the status write alone lands the
 * card there, so a truncated board can still take a drag into an empty column.
 */
export function dropAnchor(args: DropArgs): ReorderPlan {
  const { order, column, movedId, beforeId, truncated } = args;
  const at = order.findIndex((card) => card.itemId === movedId);
  if (at === -1 || order[at].isArchived || beforeId === movedId) return NOOP;
  const staying = (card: PositionedCard) => card.itemId !== movedId;
  const rest = order.filter(staying);
  const target = column.filter(staying);
  if (beforeId !== null) {
    // A slot neighbour the column no longer draws is a board that moved under
    // the drag; refuse rather than anchor on a card the user never dropped by.
    if (!target.some((card) => card.itemId === beforeId)) return NOOP;
    return landBefore(rest, beforeId);
  }
  const last = target.findLast((card) => !card.isArchived);
  if (last === undefined) return NOOP;
  if (truncated) return HELD_TRUNCATED;
  return { kind: "move", afterId: last.itemId };
}

/**
 * Where a pointer drop puts `movedId`: `dropAnchor`'s answer, unless the write
 * would change nothing. Position only; the caller owns the status write a
 * cross-column drop also needs, and decides it by comparing columns.
 *
 * A drop into the card's own slot (no live card of its column between the card
 * and the slot) is a no-op. The anchor check can't see that on an interleaved
 * board: another column's card sits between, so the write would still rewrite
 * the global order while the drawn column stays the same. An end drop on a
 * truncated board skips that test and is held, even from the card's own slot.
 * A plan whose anchor is the card's current nearest live predecessor is a
 * no-op: the write would leave the global order unchanged.
 */
export function planDrop(args: DropArgs): ReorderPlan {
  const { order, column, movedId, beforeId, truncated } = args;
  const at = order.findIndex((card) => card.itemId === movedId);
  if (at === -1 || order[at].isArchived || beforeId === movedId) return NOOP;
  const live = (card: PositionedCard) => !card.isArchived;
  const from = column.findIndex((card) => card.itemId === movedId);
  const slot =
    beforeId === null
      ? column.length
      : column.findIndex((card) => card.itemId === beforeId);
  if (from !== -1 && slot !== -1 && !(beforeId === null && truncated)) {
    const between =
      slot > from ? column.slice(from + 1, slot) : column.slice(slot, from);
    if (!between.some(live)) return NOOP;
  }
  const candidate = dropAnchor(args);
  if (candidate.kind !== "move") return candidate;
  const current = order.slice(0, at).findLast(live)?.itemId ?? null;
  return candidate.afterId === current ? NOOP : candidate;
}
