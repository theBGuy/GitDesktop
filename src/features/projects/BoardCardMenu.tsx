import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { OptionValue } from "@/features/conversations/ProjectFieldValues";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem } from "@/lib/git/types";
import { type BoardColumnModel, TRUNCATED_ROW_REASON } from "./board-model";
import type { ReorderDirection, ReorderPlan } from "./board-positioning";

/** What the board's one shared context menu acts on, recorded on right-click or
 *  long press. `null` means nothing actionable was under the pointer and the menu
 *  is suppressed rather than opened empty. */
export type BoardMenuTarget = {
  item: BoardItem;
  /** The column id the card's own grouped-field VALUE names — its option's column,
   *  or the catch-all when the field is unset. A card whose stored option the field
   *  no longer defines carries an id no column has: it is drawn in the catch-all
   *  but is not unset, so nothing is checked and every row, the clear included,
   *  stays live. Drawn position would be the wrong axis — the clear is exactly what
   *  fixes such a card. */
  valueColumnId: string;
} | null;

/** Callbacks the menu items invoke — owned by the panel, which holds the lens,
 *  the board's field definitions, and the one move mutation. */
export interface BoardMenuActions {
  open: () => void;
  /** Open the card's details peek — the pointer route to what Space does from the
   *  keyboard. Issue/PR cards alone: a draft's popover is its own card. */
  showDetails: () => void;
  /** Where the card should land, as an index into `columns`. */
  move: (columnIndex: number) => void;
  /** Move the card within its own column — the project's global order, which no
   *  column pick expresses. */
  reorder: (direction: ReorderDirection) => void;
  /** Rewrite a DRAFT's title, notes and assignees. Offered on draft cards alone —
   *  an issue or pull request is edited on its own tab. */
  editDraft: () => void;
  /** Turn a DRAFT into a real issue. Offered on draft cards alone. */
  convert: () => void;
  archive: () => void;
  remove: () => void;
}

/** The reposition rows, in the order the menu draws them. All four ALWAYS render,
 *  in this order — the spec's "these rows never reorder themselves" — so a held row
 *  disables in place rather than dropping out and shifting its siblings up.
 *
 *  Both held reasons ride the LABEL, since a disabled menu item can't carry a
 *  tooltip: `noopReason` for a move that would change nothing (the end of the
 *  column it heads toward), `truncatedReason` for a downward move blocked by the
 *  loaded end (the two column-end rows carry one; the upward pair can't be
 *  truncation-blocked). */
const REORDER_ROWS: {
  direction: ReorderDirection;
  label: string;
  noopReason: string;
  truncatedReason?: string;
}[] = [
  { direction: "up", label: "Move up", noopReason: "already first" },
  {
    direction: "down",
    label: "Move down",
    noopReason: "already last",
    truncatedReason: TRUNCATED_ROW_REASON,
  },
  { direction: "top", label: "Move to top", noopReason: "already first" },
  {
    direction: "bottom",
    label: "Move to bottom",
    noopReason: "already last",
    truncatedReason: TRUNCATED_ROW_REASON,
  },
];

/**
 * The board's card menu: an optional Open row, a flat "Move to" section listing the
 * current grouping's columns in board order, a "Position" section that moves the
 * card inside its own column, a read-only "Show details" peek for an issue or pull
 * request, then the rows that change what the card IS — edit a draft, convert it,
 * archive, remove. Presentational — the panel records the target on right-click
 * (capture phase) and hands it down here with the labels, the gates and the
 * confirmations already resolved.
 */
export function BoardCardMenuItems({
  target,
  columns,
  openLabel,
  heldReason,
  actionHeldReason,
  reorderHeldReason,
  reorderPlans,
  actions,
}: {
  target: BoardMenuTarget;
  /** The move targets, in board order. Empty on an ungrouped board, which drops
   *  the whole section. */
  columns: BoardColumnModel[];
  /** "Open" for an in-app destination, "Open on GitHub" for the browser, or null
   *  where there is nothing to open (drafts own their popover on the card). */
  openLabel: string | null;
  /** Why every move is held, or undefined when they're live. */
  heldReason: string | undefined;
  /** Why convert/archive/remove are held, or undefined when they're live. Apart
   *  from {@link heldReason} because a move can be held by something that leaves
   *  these three fine — an ungrouped board, or a grouping GitHub owns on the issue
   *  itself. */
  actionHeldReason: string | undefined;
  /** Why every reposition row is held, or undefined when they're live. Apart from
   *  the two above because it takes an arm neither of them does: a saved view's own
   *  sort draws the columns in an order the board's position sequence isn't. */
  reorderHeldReason: string | undefined;
  /** What each direction would do to THIS card, resolved by the panel against the
   *  loaded board. A `noop` or truncation-`held` plan disables its row IN PLACE
   *  (reason on the label) rather than hiding it, so the four keep their order as
   *  the card moves. */
  reorderPlans: Record<ReorderDirection, ReorderPlan>;
  actions: BoardMenuActions;
}) {
  if (target === null) return null;
  const kind = target.item.content.kind;
  const isDraft = kind === "draft";
  // Only these two have a peek: a draft's notes open from the card itself, and a
  // redacted card has nothing to tell.
  const isPeekable = kind === "issue" || kind === "pullRequest";
  return (
    <>
      {openLabel !== null && (
        <>
          <ContextMenuItem onClick={actions.open}>{openLabel}</ContextMenuItem>
          {/* Unconditional: the Position section below always draws, so this
              separator never ends up with nothing under it. */}
          <ContextMenuSeparator />
        </>
      )}
      {columns.length > 0 &&
        (heldReason === undefined ? (
          // The caption names the radio group: Base UI's GroupLabel registers its
          // id as the group's `aria-labelledby`, and it throws outside a group at
          // all, so it can't be hoisted above this.
          <ContextMenuRadioGroup
            value={target.valueColumnId}
            onValueChange={(next) => {
              // Base UI types a radio group's value as `any`; the guard is what
              // narrows it back to the column id these rows carry.
              if (typeof next !== "string") return;
              const index = columns.findIndex((column) => column.id === next);
              if (index !== -1) actions.move(index);
            }}
          >
            <ContextMenuLabel>Move to</ContextMenuLabel>
            {columns.map((column) => (
              <ContextMenuRadioItem
                key={column.id}
                value={column.id}
                // Base UI defaults a menu radio item's `closeOnClick` to FALSE
                // (its checkbox sibling does too) — without this the menu would
                // sit over the card it just moved.
                closeOnClick
                // The card's value is already this one: checked by the row's own
                // indicator glyph, and held so the write can't be sent as a no-op.
                // By VALUE, never by drawn column — see `valueColumnId`.
                disabled={column.id === target.valueColumnId}
              >
                {column.color === null ? (
                  <span
                    className="min-w-0 truncate"
                    onMouseEnter={clipTitleFromText}
                  >
                    {column.label}
                  </span>
                ) : (
                  <OptionValue name={column.label} color={column.color} />
                )}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        ) : (
          // One held row carrying the reason, rather than the column list with
          // the same sentence repeated down it — a disabled menu item can't hold
          // a tooltip, so the reason has to BE the row.
          <ContextMenuGroup>
            <ContextMenuLabel>Move to</ContextMenuLabel>
            <ContextMenuItem disabled>{heldReason}</ContextMenuItem>
          </ContextMenuGroup>
        ))}
      {/* Its own section under the columns: "Move to" answers WHICH column, this
          answers where in it. Offered on every card the menu opens on, drafts and
          redacted ones included — a place on the board is a membership fact, like
          Archive and Remove, rather than a claim about what the card holds. */}
      <ContextMenuGroup>
        <ContextMenuLabel>Position</ContextMenuLabel>
        {reorderHeldReason === undefined ? (
          // All four rows ALWAYS render in their fixed order; a held one disables
          // in place with its reason parenthetically on the label (the only place a
          // disabled menu item can carry one) rather than dropping out and shifting
          // the rest up.
          REORDER_ROWS.map((row) => {
            const plan = reorderPlans[row.direction];
            const heldParenthetical =
              plan.kind === "noop"
                ? row.noopReason
                : plan.kind === "held"
                  ? row.truncatedReason
                  : undefined;
            return (
              <ContextMenuItem
                key={row.direction}
                disabled={plan.kind !== "move"}
                onClick={() => actions.reorder(row.direction)}
              >
                {heldParenthetical === undefined
                  ? row.label
                  : `${row.label} (${heldParenthetical})`}
              </ContextMenuItem>
            );
          })
        ) : (
          // One held row carrying the reason, the shape the Move section takes
          // when it is held.
          <ContextMenuItem disabled>{reorderHeldReason}</ContextMenuItem>
        )}
      </ContextMenuGroup>
      {/* The Position section always draws rows, so there is always something
          above this. */}
      <ContextMenuSeparator />
      {/* Above the write rows and OUTSIDE their permission gate: reading a card's
          dates asks nothing of the board, so a viewer who can't change it still
          gets this one. `onClick`, never `onSelect` — Base UI's `onSelect` is the
          DOM text-selection event and never fires. */}
      {isPeekable && (
        <>
          <ContextMenuItem onClick={actions.showDetails}>
            Show details
          </ContextMenuItem>
          {/* Its own rule: reading a card's dates belongs nowhere near Archive and
              Remove, and one unbroken group would read as a single family. */}
          <ContextMenuSeparator />
        </>
      )}
      {actionHeldReason === undefined ? (
        <>
          {/* Drafts only: an issue or pull request is already the thing a convert
              would make, and is edited on its own tab. The ellipsis is the house
              promise that a further step comes first — a dialog for the edit, a
              confirmation for the other three. */}
          {isDraft && (
            <>
              <ContextMenuItem onClick={actions.editDraft}>
                Edit draft…
              </ContextMenuItem>
              <ContextMenuItem onClick={actions.convert}>
                Convert to issue…
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onClick={actions.archive}>
            Archive card…
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={actions.remove}>
            Remove from project…
          </ContextMenuItem>
        </>
      ) : (
        // One held row carrying the reason, the same shape the Move section takes
        // when it is held: a disabled menu item can't hold a tooltip, so the
        // reason has to BE the row.
        <ContextMenuItem disabled>{actionHeldReason}</ContextMenuItem>
      )}
    </>
  );
}
