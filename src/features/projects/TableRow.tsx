import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { memo } from "react";
import { OptionValue } from "@/features/conversations/ProjectFieldValues";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import type { TableColumn, TableEntry } from "./board-model";
import type { FieldDraft } from "./ProjectFieldControls";
import {
  CELL_CLASS,
  columnWidth,
  TABLE_ROW_HEIGHT,
  TitleCell,
  ValueCell,
} from "./TableCell";

/** Where a virtualized row sits: absolutely positioned at its offset, as wide as
 *  the columns it lays out. */
function rowStyle(start: number, width: number) {
  return {
    height: TABLE_ROW_HEIGHT,
    width,
    transform: `translateY(${start}px)`,
  };
}

/**
 * One item's row. Memoized and light for the reason a board card is: the grid
 * re-renders its whole mounted window when the cursor moves, and only the rows
 * whose flags flip should follow. Every prop is a primitive or an identity the
 * panel holds stable.
 */
export const TableItemRow = memo(function TableItemRow({
  rowKey,
  item,
  columns,
  rowIndex,
  start,
  width,
  selected,
  checked,
  busy,
  peek,
  tabCol,
  editHeld,
  editingCell,
  onCellFocus,
  onPeekChange,
  onCellCommit,
  onCellCancel,
}: {
  rowKey: string;
  item: BoardItem;
  columns: TableColumn[];
  /** Position in the drawn row list, the header row excluded. */
  rowIndex: number;
  start: number;
  width: number;
  /** In the selection — or, with nothing selected, the cursor's own row. The
   *  accent and `aria-selected` ride this one reading, as on a board card. */
  selected: boolean;
  /** Selected in a selection of several, which earns the tick. */
  checked: boolean;
  busy: boolean;
  peek: boolean;
  /** The column holding the grid's single tab stop, when it is in this row. */
  tabCol: number | null;
  /** Why no cell can be edited right now, board-wide — a primitive, for the memo. */
  editHeld: string | undefined;
  /** The editor open in THIS row, and which run of it, or null. */
  editingCell: { fieldId: string; session: number } | null;
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
  onPeekChange: (itemId: string | null) => void;
  onCellCommit: (itemId: string, fieldId: string, entry: FieldDraft) => void;
  onCellCancel: (session: number) => void;
}) {
  const hasTitle = columns[0]?.title === true;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={selected}
      // Absent rather than false when nothing is in flight: only the row being
      // written has anything to say.
      aria-busy={busy || undefined}
      aria-disabled={item.content.kind === "redacted" || undefined}
      data-row-key={rowKey}
      data-item-id={item.itemId}
      // The background is always set, never transparent: the pinned Title cell
      // inherits it to hide the cells that scroll beneath it.
      className={cn(
        "absolute top-0 left-0 flex border-b border-border/60 bg-background text-xs",
        item.isArchived && "text-muted-foreground",
        selected && "bg-accent text-accent-foreground",
        busy && "opacity-60",
      )}
      style={rowStyle(start, width)}
    >
      {columns.map((column, colIndex) => {
        const cell = {
          rowKey,
          colIndex,
          width: columnWidth(column),
          tabbable: tabCol === colIndex,
          onCellFocus,
        };
        return column.title ? (
          <TitleCell
            key={column.def.id}
            {...cell}
            item={item}
            checked={checked}
            peek={peek}
            onPeekChange={onPeekChange}
          />
        ) : (
          <ValueCell
            key={column.def.id}
            {...cell}
            item={item}
            column={column}
            // With no Title column, the first one carries the row's marks.
            lead={!hasTitle && colIndex === 0 ? { checked } : null}
            editHeld={editHeld}
            editSession={
              editingCell?.fieldId === column.def.id
                ? editingCell.session
                : null
            }
            onCommit={onCellCommit}
            onCancel={onCellCancel}
          />
        );
      })}
    </div>
  );
});

/**
 * A group section's header: the bucket's value and how many rows it holds, one
 * full-width cell that collapses and expands the section (on click here, and on
 * Enter or Space through the grid's key handler). The label stays pinned at the
 * left edge while the columns scroll sideways.
 */
export const TableGroupRow = memo(function TableGroupRow({
  entry,
  rowIndex,
  start,
  width,
  colCount,
  tabbable,
  onCellFocus,
}: {
  entry: Extract<TableEntry, { kind: "group" }>;
  rowIndex: number;
  start: number;
  width: number;
  colCount: number;
  tabbable: boolean;
  /** Reports the header with NO column of its own, so a walk passing through it
   *  keeps the column it was on. */
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
}) {
  const Caret = entry.expanded ? CaretDownIcon : CaretRightIcon;
  const count = `${entry.count} ${entry.count === 1 ? "item" : "items"}`;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-expanded={entry.expanded}
      data-row-key={entry.key}
      className="absolute top-0 left-0 flex border-b bg-muted text-xs font-medium"
      style={rowStyle(start, width)}
    >
      <div
        role="gridcell"
        aria-colindex={1}
        aria-colspan={colCount}
        data-table-cell=""
        data-col-index={0}
        data-group-toggle={entry.bucketId}
        tabIndex={tabbable ? 0 : -1}
        onFocus={() => onCellFocus(entry.key, null)}
        className={cn(CELL_CLASS, "w-full cursor-pointer")}
      >
        <span className="sticky left-0 flex min-w-0 items-center gap-1.5">
          <Caret aria-hidden className="size-3 shrink-0" />
          {entry.color === null ? (
            <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
              {entry.label}
            </span>
          ) : (
            <OptionValue name={entry.label} color={entry.color} />
          )}
          <span
            aria-hidden
            className="shrink-0 tabular-nums text-muted-foreground"
          >
            {entry.count}
          </span>
          <span className="sr-only">, {count}</span>
        </span>
      </div>
    </div>
  );
});
