import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { isLiftPress } from "./drag-model";

/** A pointer position in CLIENT coordinates (clientX, clientY). */
export interface DragPoint {
  x: number;
  y: number;
}

/** A drop slot. `beforeId` is the card of that column the slot sits immediately
 *  before; null is the column's end, and the only slot of an empty column. */
export interface BoardDragTarget {
  columnId: string;
  beforeId: string | null;
}

/** One mounted column as an engine hit-tests and scrolls it. Read handles from
 *  `seam.columns()` inside each event and never keep one across events: a refetch
 *  replaces them, and most of a column's cards are not in the DOM. */
export interface BoardDragColumnHandle {
  columnId: string;
  /** The column's own vertical scroller. */
  scrollEl: HTMLElement;
  /** Every card of the column in drawn order, mounted or not. */
  itemIds: readonly string[];
  /** Row `index`: its top offset inside the scroll content and its height, px.
   *  Measured once the row has been mounted, estimated before; rows tile. */
  rowAt(index: number): { start: number; size: number };
}

/** What the shared code gives an engine: one stable object for the provider's
 *  lifetime. Every method is safe to call at any time and takes effect
 *  synchronously; all but `lift` do nothing when no session is live. A session
 *  started on a board the panel has since left counts as no session. */
export interface BoardDragSeam {
  /** The mounted columns in the board's own left-to-right order, whatever
   *  order they mounted in. */
  columns(): readonly BoardDragColumnHandle[];
  /** The board's horizontal scroller, or null before it mounts. */
  boardScrollEl(): HTMLElement | null;
  /** The slot under `pointer` by the shared hit-test; null = no valid slot.
   *  During a session the seam keeps the last point asked about, and re-tests
   *  it when the board changes under a still pointer whose last hover was this
   *  method's answer for it. */
  targetAt(pointer: DragPoint): BoardDragTarget | null;
  /** The press on `itemId` crossed the lift threshold. `pointer` is where the
   *  pointer is NOW, at the crossing (not the press point); the seam hit-tests
   *  it as the session's first target, so no `hover` is owed before the next
   *  move. True: a session started and the engine owns the gesture until it
   *  calls `drop` or `cancel`, or the seam calls `abort`: a cancel key, a
   *  non-primary press, the window losing focus, the board changing under the
   *  drag, or the panel hiding or unmounting. False: the card does
   *  not lift, and the engine drops the press and shows nothing. A card whose
   *  reposition is held is refused aloud; a live session, a board that is not on
   *  screen, an unknown card and a redacted one are refused silently. */
  lift(args: {
    itemId: string;
    pointer: DragPoint;
    abort: () => void;
  }): boolean;
  /** The live target. Call on every pointer move and on every frame of a
   *  lifted gesture; cheap when the target is unchanged. */
  hover(target: BoardDragTarget | null): void;
  /** The primary button was released over `target` (null = outside every
   *  column). Ends the session; the seam plans, writes and announces. */
  drop(target: BoardDragTarget | null): void;
  /** The engine lost the gesture WHILE MOUNTED AND SHOWN (pointercancel, lost
   *  capture, a lost release). Ends the session; nothing is written. Never
   *  called from an unmount or hide cleanup. */
  cancel(): void;
}

/** What an engine binds to one card's slot element, whose box is the card's
 *  box. Nothing else may be attached: no role, tabIndex or aria attribute. The
 *  slot calls `onPointerDown` only for a press inside its own DOM, never for
 *  one React bubbled up from a portalled child. */
export interface BoardDragCardBind {
  ref: (node: HTMLElement | null) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface BoardDragEngine {
  /** Unique to this engine module and rendered as `data-board-drag-engine`, so
   *  a built bundle can be grepped for the engine it contains. */
  marker: string;
  /** Wraps the board layout. Owns every listener the engine needs beyond a
   *  card's own press handler, and places `<BoardDragGhost />`. The ghost box
   *  keeps its last placement until the engine's `drop` or `cancel` call has
   *  returned: the seam reads it there to fade the ghost in place. */
  Provider: (props: { children: ReactNode }) => ReactNode;
  /** Called once by every mounted card slot. `disabled` cards never lift. */
  useCard: (args: { itemId: string; disabled: boolean }) => BoardDragCardBind;
}

/** The only lift test an engine calls: a plain primary mouse press. Shift and
 *  AltGraph count as modified beside the chord modifiers, since a Shift press is
 *  the board's range select. Takes the DOM event or React's wrapper of it. */
export function isLiftEvent(
  e: PointerEvent | ReactPointerEvent<Element>,
): boolean {
  const modified =
    hasChordModifier(e) || e.shiftKey || e.getModifierState("AltGraph");
  return isLiftPress({
    pointerType: e.pointerType,
    isPrimary: e.isPrimary,
    button: e.button,
    modified,
  });
}
