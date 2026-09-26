/**
 * Where a card lands when it is moved inside its own column, expressed as the
 * `afterId` GitHub's position mutation takes.
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
