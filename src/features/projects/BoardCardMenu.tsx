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

/** Why the rows that act on ONE card are held while several are selected. They
 *  address a single membership by construction — a position is a slot, a draft
 *  edit is one note — so a bulk-looking menu must say so rather than quietly
 *  acting on the card under the pointer. */
export const BULK_SINGLE_ONLY_REASON = "Acts on one card — clear the selection";

/** A column value no board column carries, so the bulk "Move to" group draws its
 *  rows with none ticked: a selection spanning columns has no current value for
 *  the indicator to claim. The same shape a card whose stored option the field no
 *  longer defines already puts the group in. */
const BULK_NO_COLUMN = "__bulk__";

/** One bulk row's words and its hold. The panel resolves both: the count is the
 *  ELIGIBLE set's, never the selection's, so a label can't promise a card the
 *  verb will skip. */
export interface BulkRow {
  label: string;
  /** Why this verb can't run over the selection, or undefined when it can. */
  reason: string | undefined;
}

/** The menu's BULK arm, or null for the single-card menu. Present exactly when
 *  the card under the pointer is one of several selected. */
export interface BulkMenuState {
  move: BulkRow;
  fields: BulkRow;
  archive: BulkRow;
  restore: BulkRow;
  remove: BulkRow;
  actions: {
    /** Where the eligible cards should land, as an index into `columns`. */
    move: (columnIndex: number) => void;
    /** Open the bulk fields editor over the eligible cards. */
    fields: () => void;
    archive: () => void;
    restore: () => void;
    remove: () => void;
  };
}

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
  /** Put an ARCHIVED card back on the board — the row that stands where Archive
   *  does on a live card, since the two are one reversible pair. */
  restore: () => void;
  remove: () => void;
}

/**
 * The write rows a SELECTION gets, count-worded per verb. Its own component rather
 * than a fourth branch inside {@link BoardCardMenuItems}: this arm has grown a row
 * per bulk verb while the single-card arm beside it has its own five, and one
 * function holding both reads as a menu with two personalities.
 *
 * `isDraft` describes the card the menu OPENED on, which is the only thing about
 * that one card this arm still says anything about: its two rewrites are one note's,
 * so the row holds rather than quietly acting on the card under the pointer.
 */
function BoardBulkMenuItems({
  bulk,
  isDraft,
}: {
  bulk: BulkMenuState;
  isDraft: boolean;
}) {
  return (
    <>
      {isDraft && (
        <ContextMenuItem disabled>{BULK_SINGLE_ONLY_REASON}</ContextMenuItem>
      )}
      {/* Above the two removals, where the single-card menu puts its own rewrites:
          a field write changes what the cards HOLD, which is a smaller step than
          taking them off the board. */}
      <ContextMenuItem
        disabled={bulk.fields.reason !== undefined}
        onClick={bulk.actions.fields}
      >
        {bulk.fields.reason ?? bulk.fields.label}
      </ContextMenuItem>
      {/* Both directions render, unlike the single card's either/or: a mixed
          selection really can archive some cards and restore others, and each row
          counts only what it will reach. */}
      <ContextMenuItem
        disabled={bulk.archive.reason !== undefined}
        onClick={bulk.actions.archive}
      >
        {bulk.archive.reason ?? bulk.archive.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={bulk.restore.reason !== undefined}
        onClick={bulk.actions.restore}
      >
        {bulk.restore.reason ?? bulk.restore.label}
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        disabled={bulk.remove.reason !== undefined}
        onClick={bulk.actions.remove}
      >
        {bulk.remove.reason ?? bulk.remove.label}
      </ContextMenuItem>
    </>
  );
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
 * archive or restore it, remove. Presentational — the panel records the target on
 * right-click (capture phase) and hands it down here with the labels, the gates and
 * the confirmations already resolved.
 *
 * With `bulk` set the write block speaks for the SELECTION instead, count-worded per
 * verb. The rows that can only mean one card — Position, and a draft's edit and
 * convert — stay in place holding {@link BULK_SINGLE_ONLY_REASON}: a menu that looks
 * like it acts on several must never quietly act on one. Show details is the
 * exception and stays the target's, reading nothing and writing nothing.
 */
export function BoardCardMenuItems({
  target,
  bulk,
  columns,
  openLabel,
  heldReason,
  actionHeldReason,
  editHeldReason,
  reorderHeldReason,
  reorderPlans,
  actions,
}: {
  target: BoardMenuTarget;
  /** The selection this menu acts on, when the card under the pointer is one of
   *  several selected — the whole write block then speaks for the SET, and the
   *  rows that can only mean one card say so. Null is the single-card menu. */
  bulk: BulkMenuState | null;
  /** The move targets, in board order. Empty on an ungrouped board, which drops
   *  the whole section. */
  columns: BoardColumnModel[];
  /** "Open" for an in-app destination, "Open on GitHub" for the browser, or null
   *  where there is nothing to open (drafts own their popover on the card). */
  openLabel: string | null;
  /** Why every move is held, or undefined when they're live. */
  heldReason: string | undefined;
  /** Why the whole write block below the peek is held — the draft rows as well as
   *  archive-or-restore and remove — or undefined when it's live. Apart from
   *  {@link heldReason} because a move can be held by something that leaves these
   *  fine: an ungrouped board, or a grouping GitHub owns on the issue itself. */
  actionHeldReason: string | undefined;
  /** Why the DRAFT rows — edit and convert — are held, or undefined when they're
   *  live. Apart from {@link actionHeldReason} because an ARCHIVED card holds these
   *  two (they rewrite what the card IS) while leaving its restore and its removal
   *  live: the whole point of the menu on such a card is the way back. */
  editHeldReason: string | undefined;
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
  const isArchived = target.item.isArchived;
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
        (bulk !== null ? (
          // The same section, addressing the SET. Nothing is ticked and nothing is
          // held per row: a selection spanning columns has no current value, and
          // which cards a pick can actually reach is the eligible count on the
          // caption — not a per-column claim.
          <ContextMenuRadioGroup
            value={BULK_NO_COLUMN}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              const index = columns.findIndex((column) => column.id === next);
              if (index !== -1) bulk.actions.move(index);
            }}
          >
            <ContextMenuLabel>{bulk.move.label}</ContextMenuLabel>
            {bulk.move.reason !== undefined ? (
              <ContextMenuItem disabled>{bulk.move.reason}</ContextMenuItem>
            ) : (
              columns.map((column) => (
                <ContextMenuRadioItem
                  key={column.id}
                  value={column.id}
                  closeOnClick
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
              ))
            )}
          </ContextMenuRadioGroup>
        ) : heldReason === undefined ? (
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
        {bulk !== null ? (
          // A position is one card's slot in the project's order, so a selection
          // has nothing for these four to address. Held with the reason rather
          // than silently acting on the card under the pointer.
          <ContextMenuItem disabled>{BULK_SINGLE_ONLY_REASON}</ContextMenuItem>
        ) : reorderHeldReason === undefined ? (
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
      {actionHeldReason !== undefined ? (
        // One held row carrying the reason, the same shape the Move section takes
        // when it is held: a disabled menu item can't hold a tooltip, so the
        // reason has to BE the row.
        <ContextMenuItem disabled>{actionHeldReason}</ContextMenuItem>
      ) : bulk !== null ? (
        <BoardBulkMenuItems bulk={bulk} isDraft={isDraft} />
      ) : (
        <>
          {/* Drafts only: an issue or pull request is already the thing a convert
              would make, and is edited on its own tab. An ellipsis is the house
              promise that a further step comes first: a dialog for the edit, a
              confirmation for every other row carrying one. */}
          {isDraft &&
            (editHeldReason === undefined ? (
              <>
                <ContextMenuItem onClick={actions.editDraft}>
                  Edit draft…
                </ContextMenuItem>
                <ContextMenuItem onClick={actions.convert}>
                  Convert to issue…
                </ContextMenuItem>
              </>
            ) : (
              // One held row carrying the reason, the shape the sections above take
              // when they are held: a disabled menu item can't hold a tooltip.
              <ContextMenuItem disabled>{editHeldReason}</ContextMenuItem>
            ))}
          {/* One reversible pair, one row: whichever direction this card can go.
              Restore carries NO ellipsis and asks nothing first — the archive is the
              step that warns, and its reversal is what that warning promised. */}
          {isArchived ? (
            <ContextMenuItem onClick={actions.restore}>
              Restore card
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={actions.archive}>
              Archive card…
            </ContextMenuItem>
          )}
          <ContextMenuItem variant="destructive" onClick={actions.remove}>
            Remove from project…
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
