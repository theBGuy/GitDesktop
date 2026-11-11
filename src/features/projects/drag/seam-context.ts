import { createContext, useContext } from "react";
import type { BoardItem, ProjectFieldDef } from "@/lib/git/types";
import type { BoardColumnModel } from "../board-model";
import type { BoardDragColumnHandle, BoardDragSeam } from "./engine";

/** What the panel hands the drag seam each render. Engines never read it. */
export interface BoardDragHost {
  repo: string;
  /** Identity of the board on screen: JSON of [repoPath, projectId, view?.id ?? null, lensQuery,
   *  showArchived, bucketField?.id ?? null]. A change ends a live session and stops a pending slot write. */
  signature: string;
  columns: readonly BoardColumnModel[];
  /** The deduped loaded order, archived cards included. */
  loaded: readonly BoardItem[];
  /** The panel's restoringIds(). */
  restoring: ReadonlySet<string>;
  /** The panel's pagesTruncated(). */
  truncated: boolean;
  /** The panel's reorderHeldFor. */
  repositionHeld(item: BoardItem): string | undefined;
  /** The panel's moveHeldFor. */
  moveHeld(item: BoardItem): string | undefined;
  /** Its synchronous checks first (the column, the grouping field and the project exist): null when
   *  one fails and nothing was sent. Otherwise setChase(item.itemId), then move.mutateAsync with
   *  moveCard's exact variables plus `slot`, returning that promise. `slot`: the dropped slot as the
   *  id the card follows in the project order (null = the top), for the cache to draw at once;
   *  undefined when the card's project slot already is the dropped slot. */
  writeStatus(
    item: BoardItem,
    columnId: string,
    slot: { afterId: string | null } | undefined,
  ): Promise<unknown> | null;
  /** null when the project is unknown and nothing was sent; otherwise reorder.mutateAsync with
   *  reorderCard's exact variables, returning that promise. */
  writePosition(
    item: BoardItem,
    afterId: string | null,
  ): Promise<unknown> | null;
  /** reorderCard's cursor trio plus the nonce. */
  landCursor(itemId: string, col: number, idx: number): void;
  /** announce(reason) + toast(reason, { id: REORDER_REFUSAL_TOAST_ID }). */
  refuse(reason: string): void;
  announce(text: string): void;
  /** What the ghost's BoardCard needs. */
  card: {
    repoSlug: string | null;
    ghHost: string | null;
    chipFields: ProjectFieldDef[];
  };
}

/** The lifted card as the ghost draws it; null with no session. `ref` hands
 *  the ghost's node to the seam, which reads its rect when the session ends to
 *  place the fading copy. */
export interface BoardDragGhostData {
  item: BoardItem;
  card: BoardDragHost["card"];
  ref: (node: HTMLElement | null) => void;
}

/** Shared-code visuals for slots and columns: the dimmed source card, and the
 *  insertion line of a VALID verdict (no line for any other verdict). */
export interface BoardDragVisuals {
  sourceId: string | null;
  line: { columnId: string; beforeId: string | null } | null;
}

/** The column registry `useBoardDragColumn` writes. Returns the unregister. */
export type BoardDragColumnRegistry = (
  handle: BoardDragColumnHandle,
) => () => void;

export const BoardDragSeamContext = createContext<BoardDragSeam | null>(null);
export const BoardDragGhostContext = createContext<BoardDragGhostData | null>(
  null,
);
export const BoardDragVisualsContext = createContext<BoardDragVisuals | null>(
  null,
);
export const BoardDragColumnsContext =
  createContext<BoardDragColumnRegistry | null>(null);

/** The seam, for an engine rendered inside `BoardDragRoot`. */
export function useBoardDragSeam(): BoardDragSeam {
  const seam = useContext(BoardDragSeamContext);
  if (seam === null)
    throw new Error("useBoardDragSeam must be called inside BoardDragRoot");
  return seam;
}
