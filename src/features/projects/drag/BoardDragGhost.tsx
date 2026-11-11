import { useContext } from "react";
import type { BoardItem } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import { BoardCard } from "../BoardCard";
import { GHOST_FADE_EASING, GHOST_FADE_MS } from "./drag-model";
import { BoardDragGhostContext, type BoardDragHost } from "./seam-context";

// Module-level so the memoized card keeps its props stable across renders.
const ignore = () => undefined;

// Square like the board's cards, opaque, with the popover's elevation.
const GHOST_CLASS =
  "pointer-events-none bg-background shadow-md ring-1 ring-foreground/10";

// Inline, so the timer that removes the copy and its animation read one value.
const FADE_TIMING = {
  animationDuration: `${GHOST_FADE_MS}ms`,
  animationTimingFunction: GHOST_FADE_EASING,
  animationFillMode: "forwards",
} as const;

/** The ghost's viewport box, read when its session ended. */
export interface GhostRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function GhostCard({
  item,
  card,
}: {
  item: BoardItem;
  card: BoardDragHost["card"];
}) {
  return (
    <BoardCard
      item={item}
      index={0}
      setSize={1}
      columnIndex={0}
      selected={false}
      checked={false}
      busy={false}
      peek={false}
      rovingTab={-1}
      repoSlug={card.repoSlug}
      ghHost={card.ghHost}
      chipFields={card.chipFields}
      onFocus={ignore}
      onPeekChange={ignore}
      onOpen={ignore}
    />
  );
}

/** The lifted card drawn from data, never from the source node (which the
 *  column may have virtualized away). Fills the box the engine places it in;
 *  inert and hidden from assistive tech, since it is a picture of the card. */
export function BoardDragGhost() {
  const ghost = useContext(BoardDragGhostContext);
  if (ghost === null) return null;
  return (
    <div
      ref={ghost.ref}
      aria-hidden
      inert
      data-board-drag-ghost=""
      className={cn(GHOST_CLASS, "size-full")}
    >
      <GhostCard item={ghost.item} card={ghost.card} />
    </div>
  );
}

/** A copy of the ghost fading out in place where its session ended. Fixed in
 *  the viewport, so the caller portals it out of any transformed ancestor. */
export function BoardDragGhostFade({
  item,
  card,
  rect,
}: {
  item: BoardItem;
  card: BoardDragHost["card"];
  rect: GhostRect;
}) {
  return (
    <div
      aria-hidden
      inert
      data-board-drag-ghost-fade=""
      className={cn(GHOST_CLASS, "fixed z-50 animate-out fade-out")}
      style={{ ...FADE_TIMING, ...rect }}
    >
      <GhostCard item={item} card={card} />
    </div>
  );
}
