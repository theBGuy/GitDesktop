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
import type { BoardColumnModel } from "./board-model";

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
  /** Where the card should land, as an index into `columns`. */
  move: (columnIndex: number) => void;
  /** Turn a DRAFT into a real issue. Offered on draft cards alone. */
  convert: () => void;
  archive: () => void;
  remove: () => void;
}

/**
 * The board's card menu: an optional Open row, a flat "Move to" section listing the
 * current grouping's columns in board order, then the rows that change what the
 * card IS — convert, archive, remove. Presentational — the panel records the target
 * on right-click (capture phase) and hands it down here with the labels, the gates
 * and the confirmations already resolved.
 */
export function BoardCardMenuItems({
  target,
  columns,
  openLabel,
  heldReason,
  actionHeldReason,
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
  actions: BoardMenuActions;
}) {
  if (target === null) return null;
  const isDraft = target.item.content.kind === "draft";
  // A draft on an ungrouped board has neither an Open row nor a Move section, so
  // its menu starts at these rows — and a separator with nothing above it reads as
  // a rendering fault.
  const hasRowsAbove = openLabel !== null || columns.length > 0;
  return (
    <>
      {openLabel !== null && (
        <>
          <ContextMenuItem onClick={actions.open}>{openLabel}</ContextMenuItem>
          {columns.length > 0 && <ContextMenuSeparator />}
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
      {hasRowsAbove && <ContextMenuSeparator />}
      {actionHeldReason === undefined ? (
        <>
          {/* Drafts only: an issue or pull request is already the thing a convert
              would make. The ellipsis is the house promise that a confirmation
              comes first — all three of these ask. */}
          {isDraft && (
            <ContextMenuItem onClick={actions.convert}>
              Convert to issue…
            </ContextMenuItem>
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
