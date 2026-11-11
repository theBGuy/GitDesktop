import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { TINT_FADE_MS } from "./drag-model";
import {
  BoardDragColumnsContext,
  BoardDragVisualsContext,
} from "./seam-context";

type RowAt = (index: number) => { start: number; size: number };

/** The tint a column takes while it is a valid drop target. */
export const BOARD_DROP_TARGET_CLASS = "bg-accent/40";

/** The tint's transition, both ways, on the column at all times: scoped to the
 *  background, so nothing else on a column (a theme switch's borders and text)
 *  animates. Under reduced motion `transition-none` drops the property, so the
 *  inline duration has nothing left to time and the tint is instant. */
export const BOARD_DROP_TARGET_MOTION = {
  className:
    "transition-[background-color] ease-out motion-reduce:transition-none",
  style: { transitionDuration: `${TINT_FADE_MS}ms` },
} as const;

/**
 * One column's half of the drag: registers its handle with the seam (in an
 * effect, so a remount or `<Activity>` hide unregisters it). `itemIds` must be
 * memoized on the column's items, or the handle re-registers every render.
 * With no drag root above it registers nothing and reports no tint and no line.
 */
export function useBoardDragColumn(args: {
  columnId: string;
  scrollEl: HTMLElement | null;
  itemIds: readonly string[];
  rowAt: RowAt;
}): { tinted: boolean; lineIndex: number | null } {
  const { columnId, scrollEl, itemIds, rowAt } = args;
  const register = useContext(BoardDragColumnsContext);
  const visuals = useContext(BoardDragVisualsContext);
  // The virtualizer's measurements change without a new rowAt identity, so the
  // handle reads the latest one through a ref written after each commit.
  const rowAtRef = useRef(rowAt);
  useLayoutEffect(() => {
    rowAtRef.current = rowAt;
  });
  useEffect(() => {
    if (register === null || scrollEl === null) return;
    return register({
      columnId,
      scrollEl,
      itemIds,
      rowAt: (index) => rowAtRef.current(index),
    });
  }, [register, columnId, scrollEl, itemIds]);
  const line = visuals?.line ?? null;
  if (line === null || line.columnId !== columnId)
    return { tinted: false, lineIndex: null };
  const index =
    line.beforeId === null ? itemIds.length : itemIds.indexOf(line.beforeId);
  return { tinted: true, lineIndex: index === -1 ? null : index };
}
