import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem, ProjectViewSort } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import type { TableColumn, TableEntry, TablePosition } from "./board-model";
import type { FieldDraft } from "./ProjectFieldControls";
import {
  CELL_CLASS,
  columnWidth,
  PINNED_CLASS,
  TABLE_ROW_HEIGHT,
} from "./TableCell";
import { TableGroupRow, TableItemRow } from "./TableRow";

/** What a press inside the grid may move focus to: a cell (every cell and group
 *  header carries a tabindex) or a real control. */
const IN_GRID_FOCUSABLE =
  "[tabindex], button, a[href], input, select, textarea";

/** The sort glyph per direction. A glyph AND `aria-sort` on the primary key's
 *  header, never a colour, so the order is stated both ways. */
const SORT_GLYPH: Record<ProjectViewSort["direction"], string> = {
  asc: "▲",
  desc: "▼",
};
const SORT_WORD: Record<
  ProjectViewSort["direction"],
  "ascending" | "descending"
> = {
  asc: "ascending",
  desc: "descending",
};

/** One column's header: its name, and the view's sort on it when there is one —
 *  the key's rank as well when the sort has several, since the glyph alone can't
 *  say which key breaks the others' ties. */
function HeaderCell({
  column,
  colIndex,
  sortKeys,
}: {
  column: TableColumn;
  colIndex: number;
  sortKeys: ProjectViewSort[];
}) {
  const rank = sortKeys.findIndex((sort) => sort.fieldId === column.def.id);
  const sort = rank === -1 ? undefined : sortKeys[rank];
  return (
    <div
      role="columnheader"
      aria-colindex={colIndex + 1}
      // One header at a time may carry `aria-sort`, so the primary key's does;
      // the others say their place in words.
      aria-sort={
        rank === 0 && sort !== undefined ? SORT_WORD[sort.direction] : undefined
      }
      className={cn(CELL_CLASS, column.title && PINNED_CLASS)}
      style={{ width: columnWidth(column) }}
    >
      <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
        {column.def.name}
      </span>
      {sort !== undefined && (
        <span className="shrink-0 text-foreground tabular-nums">
          <span aria-hidden>
            {SORT_GLYPH[sort.direction]}
            {sortKeys.length > 1 && rank + 1}
          </span>
          {rank > 0 && (
            <span className="sr-only">
              , sort key {rank + 1}, {SORT_WORD[sort.direction]}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * A saved TABLE view as a data table: a sticky header row, a Title column pinned
 * while the rest scroll sideways, and one virtualized list of rows in which group
 * headers and items share a single sequence.
 *
 * A leaf on purpose, like a board column: `useVirtualizer` opts its component
 * out of the React Compiler's memoization, so the panel stays compiled and hands
 * this everything already derived — the rows in draw order, the live cursor, the
 * selection. The panel owns the keyboard and the pointer grammar; this owns the
 * window, the focus claims, and the two clicks that belong to the grid itself.
 */
export function ProjectsTableView({
  label,
  columns,
  rows,
  sortKeys,
  cursor,
  focusNonce,
  selectedIds,
  selectionSize,
  busyItemId,
  peekItemId,
  editHeld,
  editingCell,
  onCellFocus,
  onToggleGroup,
  onActivate,
  onPeekChange,
  onEditCell,
  onCellCommit,
  onCellCancel,
  onFocusLost,
  onKeyDown,
}: {
  /** The grid's accessible name — the view's own. */
  label: string;
  columns: TableColumn[];
  /** The rows drawn right now, collapsed groups' items already left out. */
  rows: TableEntry[];
  /** The view's HONOURED sort keys, in its order — the only ones a header may
   *  claim. */
  sortKeys: ProjectViewSort[];
  /** The keyboard cursor resolved against `rows`, or null for none yet. */
  cursor: TablePosition | null;
  /** Bumped by every route that means to move DOM focus; nothing else may. */
  focusNonce: number;
  selectedIds: ReadonlySet<string>;
  selectionSize: number;
  busyItemId: string | null;
  peekItemId: string | null;
  /** Why no cell can be edited right now, board-wide, or undefined. */
  editHeld: string | undefined;
  /** The one cell whose editor is open, and which run of it, or null. */
  editingCell: { itemId: string; fieldId: string; session: number } | null;
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
  onToggleGroup: (bucketId: string) => void;
  /** A click on a row's title: open the item, or peek at a draft's notes. */
  onActivate: (item: BoardItem) => void;
  onPeekChange: (itemId: string | null) => void;
  /** A click on an editable cell: open its editor. */
  onEditCell: (item: BoardItem, fieldId: string) => void;
  onCellCommit: (itemId: string, fieldId: string, entry: FieldDraft) => void;
  /** An editor closed without a draft; `session` is the run it belongs to. */
  onCellCancel: (session: number) => void;
  /** The grid owned focus and has no row left to hand it to. */
  onFocusLost: () => void;
  /** The panel's key handler, handed how many rows a viewport holds so Page Up
   *  and Page Down can jump by it. */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, pageSize: number) => void;
}) {
  // State-backed, never a ref: the virtualizer captures its scroll element in a
  // mount effect and never re-reads a RefObject.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const width = columns.reduce((sum, column) => sum + columnWidth(column), 0);
  const pinnedWidth = columns[0]?.title ? columnWidth(columns[0]) : 0;
  // With no cursor yet, the first row holds the tab stop, so Tab lands in the
  // grid at all.
  const tabStop: TablePosition | null =
    cursor ?? (rows.length > 0 ? { rowIndex: 0, colIndex: 0 } : null);
  const tabStopRow = tabStop?.rowIndex ?? null;
  // Re-minted per row SEQUENCE: the virtualizer keys its measurement projection
  // on this callback's identity.
  const getItemKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );
  // The grid's single tab stop has to stay MOUNTED or Tab can't reach the grid:
  // scrolled past the overscan window, it would unmount with its row.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const drawn = defaultRangeExtractor(range);
      if (tabStopRow === null || drawn.includes(tabStopRow)) return drawn;
      return [...drawn, tabStopRow].sort((a, b) => a - b);
    },
    [tabStopRow],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => TABLE_ROW_HEIGHT,
    getItemKey,
    rangeExtractor,
    overscan: 8,
    // The rows start below the sticky header, which also covers the top of the
    // viewport — so a row scrolled "into view" must clear it.
    scrollMargin: TABLE_ROW_HEIGHT,
    scrollPaddingStart: TABLE_ROW_HEIGHT,
  });

  // Focus follows the NONCE only, the board column's rule: the ref starts at the
  // nonce this grid mounted with, so neither an <Activity> show replaying this
  // effect nor a layout swap remounting the grid claims focus unasked. The target
  // is found by ROW KEY, never by index, so a splice still landing can't hand
  // focus to the neighbour it swaps past.
  const cursorKey =
    cursor === null ? null : (rows[cursor.rowIndex]?.key ?? null);
  const cursorRow = cursor?.rowIndex ?? null;
  const cursorCol = cursor?.colIndex ?? null;
  /** Scroll the cursor's row in and focus its cell, over a few frames: under
   *  virtualization the row may not be mounted yet, and an optimistic splice lands
   *  a frame or two late. Returns the cancel. */
  const claimCursorCell = useEffectEvent(() =>
    cursorKey === null || cursorRow === null
      ? undefined
      : claimCell(cursorKey, cursorRow, cursorCol ?? 0),
  );
  /** Focus one row's cell by KEY (the virtualizer scrolls it in by index first). */
  const claimCell = useEffectEvent(
    (key: string, rowIndex: number, at: number) => {
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      let frame = 0;
      let tries = 6;
      const claim = () => {
        tries -= 1;
        const row = scrollEl?.querySelector<HTMLElement>(
          `[data-row-key="${CSS.escape(key)}"]`,
        );
        // A group header has one cell, whatever column the walk is on.
        const col = row?.dataset.itemId === undefined ? 0 : at;
        const cell = row?.querySelector<HTMLElement>(
          `[data-col-index="${col}"]`,
        );
        if (cell) {
          cell.focus({ preventScroll: true });
          // Both axes: the scroll padding keeps it clear of the sticky header and
          // the pinned Title column.
          cell.scrollIntoView({ block: "nearest", inline: "nearest" });
          return;
        }
        if (tries === 0) return;
        frame = requestAnimationFrame(claim);
      };
      frame = requestAnimationFrame(claim);
      return () => cancelAnimationFrame(frame);
    },
  );
  const appliedNonce = useRef(focusNonce);
  useEffect(() => {
    const unseen = appliedNonce.current !== focusNonce;
    appliedNonce.current = focusNonce;
    if (!unseen) return;
    return claimCursorCell();
  }, [focusNonce]);

  // Focus RECOVERY: one detector for every way the grid loses the cell it had
  // focused. React re-slotting or unmounting that cell — its row re-sorted at
  // settle, folded into a collapsed section, or taken out of the view's filter by a
  // refetch or an edit; its column dropped or replaced — leaves focus on <body>.
  // So after every commit: if the grid OWNED focus and focus is now on <body>, the
  // grid lands it. On the cursor's cell where the cursor still resolves (a
  // collapsed section's header included), else in the slot the focused row left,
  // else on the toolbar's Add item when no row is left.
  //
  // Deliberately NOT recovered: focus the user moved out (Tab, a click on another
  // control, a popup the grid opened — each gives ownership up); a press on
  // non-focusable space outside the grid (the pointer listener below gives it
  // up); a window switch (the cell stays the active element). The whole grid
  // unmounting (a layout switch) is the panel's handoff, not this.
  //
  // "On <body>" includes an ANCESTOR of the grid: the panel root is focusable (the
  // last-resort landing), so a press on non-focusable space inside the grid parks
  // focus there natively rather than on <body>.
  //
  // One claim overrides ownership: a grid popup whose ANCHOR stops being drawn (the
  // panel retires its session). The grid owns exactly two: the cell editor (anchor:
  // its row and column) and the Title peek (anchor: its row and the Title column).
  // The popup unmounted with its anchor in this same commit, and its close-handoff
  // target is gone, so focus it held is on <body> now; the grid lands it whatever
  // the press into the popup gave up. Focus found anywhere else was moved there by
  // the user, and stays.
  const ownsFocusRef = useRef(false);
  const lastFocusRef = useRef<{ row: number; col: number } | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof Element && (scrollEl?.contains(active) ?? false)) {
      const key = active.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
      const row = rows.findIndex((entry) => entry.key === key);
      const col = Number(
        active.closest<HTMLElement>("[data-col-index]")?.dataset.colIndex,
      );
      if (row !== -1)
        lastFocusRef.current = { row, col: Number.isInteger(col) ? col : 0 };
      return;
    }
    const onBody =
      active === null ||
      active === document.body ||
      (scrollEl !== null && active.contains(scrollEl));
    const drawsRow = (itemId: string) =>
      rows.some(
        (entry) => entry.kind === "item" && entry.item.itemId === itemId,
      );
    const editorRetired =
      editingCell !== null &&
      (!drawsRow(editingCell.itemId) ||
        !columns.some((column) => column.def.id === editingCell.fieldId));
    const peekRetired =
      peekItemId !== null &&
      (!drawsRow(peekItemId) || !columns.some((column) => column.title));
    if ((editorRetired || peekRetired) && onBody) ownsFocusRef.current = true;
    if (!ownsFocusRef.current || !onBody) return;
    if (cursorKey !== null && cursorRow !== null) return claimCursorCell();
    const last = lastFocusRef.current;
    const slot = Math.min(last?.row ?? 0, rows.length - 1);
    const landing = rows[slot];
    if (landing === undefined) {
      ownsFocusRef.current = false;
      onFocusLost();
      return;
    }
    return claimCell(
      landing.key,
      slot,
      Math.min(last?.col ?? 0, Math.max(columns.length - 1, 0)),
    );
  });

  // Ownership is given up by a pointer press anywhere outside the grid, which is
  // the one signal a press on NON-focusable space leaves: its blur has no
  // destination, exactly like the blur a re-slotted node's focus loss can raise, so
  // the blur alone can't tell the two apart. A press inside a popup the grid opened
  // counts as outside too; that popup hands focus back to its cell as it closes,
  // which takes ownership again, or the recovery above claims when that cell is gone.
  // The listener also records a press INSIDE the grid until its release, for the
  // blur below.
  const pressInGridRef = useRef(false);
  useEffect(() => {
    if (scrollEl === null) return;
    const onPress = (e: PointerEvent) => {
      const inside = e.target instanceof Node && scrollEl.contains(e.target);
      pressInGridRef.current = inside;
      if (!inside) ownsFocusRef.current = false;
    };
    const onRelease = () => {
      pressInGridRef.current = false;
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("pointerup", onRelease, true);
    document.addEventListener("pointercancel", onRelease, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("pointerup", onRelease, true);
      document.removeEventListener("pointercancel", onRelease, true);
    };
  }, [scrollEl]);

  // A press on NON-focusable space inside the grid (a column header, the empty
  // rowgroup, the gap beside a short table) keeps focus where it was: its mousedown
  // default is cancelled, so the focused cell stays focused and the arrows keep
  // working, with nothing to reclaim. The scrollbars are left their default.
  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    const el = e.target instanceof Element ? e.target : null;
    if (el === null || !e.currentTarget.contains(el)) return;
    const grid = e.currentTarget;
    // Grid-contained only: the panel root above it is focusable too.
    const focusable = el.closest(IN_GRID_FOCUSABLE);
    if (focusable !== null && grid.contains(focusable)) return;
    if (
      el === grid &&
      (e.nativeEvent.offsetX >= grid.clientWidth ||
        e.nativeEvent.offsetY >= grid.clientHeight)
    )
      return;
    e.preventDefault();
  }

  /** The grid's own clicks: a group header toggles its section, an editable
   *  cell opens its editor, and a row's title opens the item. Everything else a
   *  press does is the panel's pointer grammar, which runs first in the capture
   *  phase and swallows a modified click whole. */
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target instanceof Element ? e.target : null;
    if (el === null) return;
    const toggle = el.closest<HTMLElement>("[data-group-toggle]");
    if (toggle?.dataset.groupToggle !== undefined) {
      onToggleGroup(toggle.dataset.groupToggle);
      return;
    }
    const key = el.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    const entry = rows.find((row) => row.key === key);
    if (entry?.kind !== "item") return;
    const edit =
      el.closest<HTMLElement>("[data-edit-field]")?.dataset.editField;
    if (edit !== undefined) {
      onEditCell(entry.item, edit);
      return;
    }
    if (el.closest("[data-title-open]") !== null) onActivate(entry.item);
  }

  const scrollMargin = virtualizer.options.scrollMargin;
  return (
    <>
      <div
        ref={setScrollEl}
        role="grid"
        aria-label={label}
        // Honest under virtualization: the header row plus every row the grid
        // draws, collapsed sections' items excluded — they are not in it.
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length}
        aria-multiselectable
        onKeyDown={(e) =>
          onKeyDown(
            e,
            Math.max(
              Math.floor(e.currentTarget.clientHeight / TABLE_ROW_HEIGHT) - 2,
              1,
            ),
          )
        }
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onFocus={() => {
          ownsFocusRef.current = true;
        }}
        onBlur={(e) => {
          // Focus that went somewhere ELSE gives the grid's ownership up, with two
          // blurs deciding nothing: one with no destination (the outside-press
          // listener above reads that case), and one to an ANCESTOR during a press
          // inside the grid — the browser handing an in-grid press to the focusable
          // panel root. `handleMouseDown` stops that for non-focusable grid space;
          // this stays as the belt for a press it lets through (a scrollbar, whose
          // focus behaviour isn't pinned).
          const to = e.relatedTarget;
          if (!(to instanceof Node) || e.currentTarget.contains(to)) return;
          if (pressInGridRef.current && to.contains(e.currentTarget)) return;
          ownsFocusRef.current = false;
        }}
        className={cn(
          "relative overflow-auto border",
          rows.length > 0 && "min-h-0 flex-1",
        )}
        style={{
          scrollPaddingTop: TABLE_ROW_HEIGHT,
          scrollPaddingLeft: pinnedWidth,
        }}
      >
        <div role="rowgroup" className="sticky top-0 z-20" style={{ width }}>
          <div
            role="row"
            aria-rowindex={1}
            className="flex border-b bg-background text-xs font-medium text-muted-foreground"
            style={{ height: TABLE_ROW_HEIGHT, width }}
          >
            {columns.map((column, i) => (
              <HeaderCell
                key={column.def.id}
                column={column}
                colIndex={i}
                sortKeys={sortKeys}
              />
            ))}
          </div>
        </div>
        {rows.length > 0 && (
          <div
            role="rowgroup"
            className="relative"
            style={{ height: virtualizer.getTotalSize(), width }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = rows[vi.index];
              const start = vi.start - scrollMargin;
              if (entry.kind === "group")
                return (
                  <TableGroupRow
                    key={entry.key}
                    entry={entry}
                    rowIndex={vi.index}
                    start={start}
                    width={width}
                    colCount={columns.length}
                    tabbable={tabStopRow === vi.index}
                    onCellFocus={onCellFocus}
                  />
                );
              const item = entry.item;
              // With NOTHING selected the cursor's row wears the accent, the board
              // exactly; a redacted row never reads as selected, mirroring the
              // prune that keeps it out of every verb.
              const selected =
                (item.content.kind !== "redacted" &&
                  selectedIds.has(item.itemId)) ||
                (selectionSize === 0 && cursorRow === vi.index);
              return (
                <TableItemRow
                  key={entry.key}
                  rowKey={entry.key}
                  item={item}
                  columns={columns}
                  rowIndex={vi.index}
                  start={start}
                  width={width}
                  selected={selected}
                  checked={selected && selectionSize >= 2}
                  busy={item.itemId === busyItemId}
                  peek={item.itemId === peekItemId}
                  tabCol={
                    tabStopRow === vi.index ? (tabStop?.colIndex ?? 0) : null
                  }
                  editHeld={editHeld}
                  editingCell={
                    editingCell?.itemId === item.itemId ? editingCell : null
                  }
                  onCellFocus={onCellFocus}
                  onPeekChange={onPeekChange}
                  onCellCommit={onCellCommit}
                  onCellCancel={onCellCancel}
                />
              );
            })}
          </div>
        )}
      </div>
      {rows.length === 0 && (
        <p className="px-2 py-3 text-[11px] text-muted-foreground">No items</p>
      )}
    </>
  );
}
