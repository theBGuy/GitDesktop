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
}

/**
 * The board's card menu: an optional Open row, then a flat "Move to" section
 * listing the current grouping's columns in board order. Presentational — the
 * panel records the target on right-click (capture phase) and hands it down here
 * with the labels and gates already resolved.
 */
export function BoardCardMenuItems({
  target,
  columns,
  openLabel,
  heldReason,
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
  actions: BoardMenuActions;
}) {
  if (target === null) return null;
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
    </>
  );
}
