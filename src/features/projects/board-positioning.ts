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

/**
 * The card lands immediately BEFORE `beforeId`, which the position mutation can
 * only say as "after whatever comes before it" — so the answer is that neighbour's
 * own global predecessor, and null (the top of the board) when there isn't one.
 *
 * The predecessor can belong to ANOTHER column: `order` is the project's own
 * global sequence, which interleaves the columns, and a position write addresses
 * that sequence rather than the column the board draws.
 */
function landBefore(order: readonly string[], beforeId: string): ReorderPlan {
  const at = order.indexOf(beforeId);
  // A neighbour the flatten doesn't hold is a board that moved under the press;
  // refusing beats writing a position derived from a list that disagrees with
  // the columns.
  if (at === -1) return NOOP;
  return { kind: "move", afterId: at === 0 ? null : order[at - 1] };
}

/**
 * Where moving `column[index]` in `direction` puts it, as an `afterId` for
 * GitHub's position mutation.
 *
 * Moving DOWN one slot is safe even on a truncated board — its anchor is always a
 * loaded neighbour — so it holds only at the loaded end. Moving to the BOTTOM is
 * held for ANY card on a truncated board: the true bottom lives past the loaded
 * end, so `column[last]` (the last LOADED card) would leave the card mid-column
 * after `Load more`. Moving UP or to the TOP never has that problem — everything
 * above a drawn card is drawn.
 *
 * Under a FILTERED view `order` is that lens's own loaded list, so the plan is
 * exact in the view and approximate in global interleave: items the filter hides
 * between the global predecessor and the visible one end up below the moved card.
 * The same accepted edge a filtered insert carries.
 */
export function planReorder(args: {
  /** Item ids in loaded project-global order (the deduped page flatten). Only
   *  POSITIONABLE ids belong here — GitHub refuses an archived item as an anchor
   *  ("The item to be positioned after is archived and cannot be used to update
   *  the position of this item", VALIDATION, measured 2026-09-19) — and the caller
   *  owns that filter. Dropping them also walks a landing back to the nearest
   *  non-archived predecessor for free, which is the same placement the board and
   *  github.com both draw. */
  order: readonly string[];
  /** The card's own column, visible order (ids). */
  column: readonly string[];
  /** Index of the moved card within `column`. */
  index: number;
  direction: ReorderDirection;
  /** Last loaded page's truncated flag. */
  truncated: boolean;
}): ReorderPlan {
  const { order, column, index, direction, truncated } = args;
  const last = column.length - 1;
  if (index < 0 || index > last) return NOOP;
  switch (direction) {
    case "down": {
      if (index === last) return truncated ? HELD_TRUNCATED : NOOP;
      return { kind: "move", afterId: column[index + 1] };
    }
    case "bottom": {
      // Held whenever the board is truncated, not only at the last index: the true
      // bottom is past the loaded end, so `column[last]` would land the card
      // mid-column once the rest pages in.
      if (truncated) return HELD_TRUNCATED;
      if (index === last) return NOOP;
      return { kind: "move", afterId: column[last] };
    }
    case "up": {
      if (index === 0) return NOOP;
      return landBefore(order, column[index - 1]);
    }
    // "top": the same landing as an `up` whose neighbour is the column's first
    // card, which is what makes a card already sitting there a no-op.
    default: {
      if (index === 0) return NOOP;
      return landBefore(order, column[0]);
    }
  }
}
