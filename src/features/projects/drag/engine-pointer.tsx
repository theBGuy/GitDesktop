import {
  createContext,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { BoardDragGhost } from "./BoardDragGhost";
import {
  autoscrollStep,
  BOARD_EDGE_ZONE_PX,
  COLUMN_EDGE_ZONE_PX,
  crossedLiftThreshold,
  edgeVelocity,
} from "./drag-model";
import {
  type BoardDragCardBind,
  type BoardDragEngine,
  type BoardDragSeam,
  type DragPoint,
  isLiftEvent,
} from "./engine";
import { useBoardDragSeam } from "./seam-context";

/** One autoscroll axis: the scroller it last stepped and its sub-pixel carry. */
interface Axis {
  el: HTMLElement | null;
  carry: number;
}

/** One press, from pointerdown to its end. It holds the card's id and the
 *  press-time box; the slot is read only for the one measurement at lift, which
 *  falls back to that box, since a virtualized column may unmount it mid-drag. */
interface Gesture {
  pointerId: number;
  itemId: string;
  slot: HTMLElement;
  press: DragPoint;
  /** The press point relative to the slot's box, kept by the ghost. */
  grab: DragPoint;
  /** The slot's size at the press, for a lift after the slot left the DOM. */
  pressSize: { width: number; height: number };
  phase: "pressed" | "lifted";
  last: DragPoint;
  frame: number;
  prevTs: number | null;
  x: Axis;
  y: Axis;
}

const CAPTURE = { capture: true } as const;

const point = (e: PointerEvent): DragPoint => ({ x: e.clientX, y: e.clientY });

/** Steps one axis by whole pixels, carrying the fraction: a slow edge speed is
 *  under a pixel per frame, which a pixel-snapping scroller would drop every
 *  frame. */
function stepAxis(
  axis: Axis,
  el: HTMLElement | null,
  velocity: number,
  dtMs: number,
  prop: "scrollTop" | "scrollLeft",
) {
  if (el !== axis.el || velocity === 0) axis.carry = 0;
  axis.el = el;
  if (el === null || velocity === 0) return;
  axis.carry += autoscrollStep(velocity, dtMs);
  const whole = Math.trunc(axis.carry);
  if (whole === 0) return;
  axis.carry -= whole;
  el[prop] += whole;
}

/** The engine's state outside React: one per Provider, mutated only in event
 *  handlers, ref callbacks and the Provider's effect. */
function createController(initialSeam: BoardDragSeam) {
  let seam = initialSeam;
  let layer: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let gesture: Gesture | null = null;

  const placeGhost = (g: Gesture) => {
    if (ghost === null) return;
    ghost.style.transform = `translate3d(${g.last.x - g.grab.x}px, ${g.last.y - g.grab.y}px, 0px)`;
  };

  const hideGhost = () => {
    if (ghost === null) return;
    for (const prop of ["visibility", "width", "height", "transform"])
      ghost.style.removeProperty(prop);
  };

  /** Ends the gesture and calls nothing on the seam; callers report the
   *  outcome after it returns. Idempotent, so it is also the seam's abort. A
   *  caller that reports passes `keepGhost` and hides it after the report, so
   *  the seam can still read where the ghost was. */
  const end = (g: Gesture, keepGhost = false) => {
    if (gesture !== g) return;
    gesture = null;
    window.removeEventListener("pointerdown", onPointerDown, CAPTURE);
    window.removeEventListener("pointermove", onPointerMove, CAPTURE);
    window.removeEventListener("pointerup", onPointerUp, CAPTURE);
    window.removeEventListener("pointercancel", onPointerCancel, CAPTURE);
    window.removeEventListener("lostpointercapture", onLostCapture, CAPTURE);
    window.removeEventListener("blur", onBlur, CAPTURE);
    if (g.frame !== 0) cancelAnimationFrame(g.frame);
    if (g.phase === "lifted") {
      try {
        if (layer?.hasPointerCapture(g.pointerId))
          layer.releasePointerCapture(g.pointerId);
      } catch {
        // The pointer is already gone; there is no capture left to release.
      }
    }
    if (!keepGhost) hideGhost();
  };

  /** Ends a gesture whose release never arrived: silently before the lift,
   *  as a cancel after it. */
  const endLost = (g: Gesture) => {
    const lifted = g.phase === "lifted";
    end(g, true);
    if (lifted) seam.cancel();
    hideGhost();
  };

  const autoscroll = (g: Gesture, dtMs: number) => {
    const board = seam.boardScrollEl();
    const boardRect = board?.getBoundingClientRect();
    // Horizontal containment only, as the shared hit-test picks a column: a
    // pointer pushed past a column's bottom edge must keep scrolling it.
    let column: HTMLElement | null = null;
    let columnRect: DOMRect | null = null;
    for (const handle of seam.columns()) {
      const rect = handle.scrollEl.getBoundingClientRect();
      if (g.last.x < rect.left || g.last.x >= rect.right) continue;
      column = handle.scrollEl;
      columnRect = rect;
      break;
    }
    const vx =
      boardRect === undefined
        ? 0
        : edgeVelocity(
            g.last.x,
            boardRect.left,
            boardRect.right,
            BOARD_EDGE_ZONE_PX,
          );
    const vy =
      columnRect === null
        ? 0
        : edgeVelocity(
            g.last.y,
            columnRect.top,
            columnRect.bottom,
            COLUMN_EDGE_ZONE_PX,
          );
    stepAxis(g.x, board ?? null, vx, dtMs, "scrollLeft");
    stepAxis(g.y, column, vy, dtMs, "scrollTop");
  };

  /** One autoscroll frame. The target is re-read every frame: a scroll or a
   *  re-measured column can move the rows under a still pointer without any
   *  event reaching the engine, and the seam's hover is cheap when unchanged. */
  const frame = (g: Gesture, ts: number) => {
    if (gesture !== g || g.phase !== "lifted") return;
    g.frame = 0;
    // The first frame only records its time, so no step spans the lift.
    if (g.prevTs !== null) autoscroll(g, ts - g.prevTs);
    g.prevTs = ts;
    seam.hover(seam.targetAt(g.last));
    if (gesture !== g) return;
    g.frame = requestAnimationFrame((next) => frame(g, next));
  };

  const lift = (g: Gesture, at: DragPoint) => {
    const ok = seam.lift({
      itemId: g.itemId,
      pointer: at,
      abort: () => end(g),
    });
    if (!ok) {
      end(g);
      return;
    }
    // The seam may abort from inside lift itself.
    if (gesture !== g) return;
    g.phase = "lifted";
    g.last = at;
    const box = g.slot.isConnected
      ? g.slot.getBoundingClientRect()
      : g.pressSize;
    if (ghost !== null) {
      ghost.style.width = `${box.width}px`;
      ghost.style.height = `${box.height}px`;
      ghost.style.visibility = "visible";
    }
    placeGhost(g);
    // Taken on the Provider's layer, never the slot, and only now: a capture
    // taken at the press would retarget the click away from the card.
    try {
      layer?.setPointerCapture(g.pointerId);
    } catch {
      // Without capture the window listeners still see the gesture through.
    }
    g.frame = requestAnimationFrame((ts) => frame(g, ts));
  };

  // A pointerdown while a gesture is live means its release was lost.
  function onPointerDown() {
    if (gesture !== null) endLost(gesture);
  }

  function onPointerMove(e: PointerEvent) {
    const g = gesture;
    if (g === null || e.pointerId !== g.pointerId) return;
    const at = point(e);
    if (g.phase === "pressed") {
      // The primary released unseen, or another button joined the press.
      if (e.buttons !== 1) end(g);
      else if (crossedLiftThreshold(at.x - g.press.x, at.y - g.press.y))
        lift(g, at);
      return;
    }
    if ((e.buttons & 1) === 0) {
      endLost(g);
      return;
    }
    g.last = at;
    seam.hover(seam.targetAt(at));
    if (gesture === g) placeGhost(g);
  }

  function onPointerUp(e: PointerEvent) {
    const g = gesture;
    if (g === null || e.pointerId !== g.pointerId) return;
    if (g.phase === "pressed") {
      end(g);
      return;
    }
    // The release point, not the last move's: the two can differ.
    const target = seam.targetAt(point(e));
    end(g, true);
    seam.drop(target);
    hideGhost();
  }

  function onPointerCancel(e: PointerEvent) {
    const g = gesture;
    if (g === null || e.pointerId !== g.pointerId) return;
    endLost(g);
  }

  function onLostCapture(e: PointerEvent) {
    const g = gesture;
    if (g === null || g.phase !== "lifted") return;
    if (e.target !== layer || e.pointerId !== g.pointerId) return;
    endLost(g);
  }

  // The window losing focus only: a press focuses the card, and the element
  // that loses focus to it blurs past this capture listener (its target is a
  // Node). After the lift the seam owns blur.
  function onBlur(e: FocusEvent) {
    if (e.target instanceof Node) return;
    const g = gesture;
    if (g !== null && g.phase === "pressed") end(g);
  }

  return {
    setLayer(node: HTMLElement | null) {
      // A hidden panel detaches refs after the cleanup that may still need it.
      if (node !== null) layer = node;
    },
    setGhost(node: HTMLElement | null) {
      if (node !== null) ghost = node;
    },
    attach(next: BoardDragSeam) {
      seam = next;
    },
    /** Provider unmount or a hidden panel: nothing outlives the effect, and
     *  the seam ends its own session; the controller stays reusable. */
    dispose() {
      if (gesture !== null) end(gesture);
    },
    press(
      e: ReactPointerEvent<HTMLElement>,
      itemId: string,
      disabled: boolean,
    ) {
      if (disabled || gesture !== null || !isLiftEvent(e.nativeEvent)) return;
      const slot = e.currentTarget;
      const rect = slot.getBoundingClientRect();
      const at = { x: e.clientX, y: e.clientY };
      gesture = {
        pointerId: e.pointerId,
        itemId,
        slot,
        press: at,
        grab: { x: at.x - rect.left, y: at.y - rect.top },
        pressSize: { width: rect.width, height: rect.height },
        phase: "pressed",
        last: at,
        frame: 0,
        prevTs: null,
        x: { el: null, carry: 0 },
        y: { el: null, carry: 0 },
      };
      window.addEventListener("pointerdown", onPointerDown, CAPTURE);
      window.addEventListener("pointermove", onPointerMove, CAPTURE);
      window.addEventListener("pointerup", onPointerUp, CAPTURE);
      window.addEventListener("pointercancel", onPointerCancel, CAPTURE);
      window.addEventListener("lostpointercapture", onLostCapture, CAPTURE);
      window.addEventListener("blur", onBlur, CAPTURE);
    },
  };
}

type Controller = ReturnType<typeof createController>;

const ControllerContext = /* @__PURE__ */ createContext<Controller | null>(
  null,
);

const NOOP_REF = () => undefined;
const INERT_BIND: BoardDragCardBind = { ref: NOOP_REF };

function Provider({ children }: { children: ReactNode }) {
  const seam = useBoardDragSeam();
  const [ctl] = useState(() => createController(seam));
  useLayoutEffect(() => {
    ctl.attach(seam);
    return () => ctl.dispose();
  }, [ctl, seam]);
  return (
    <ControllerContext.Provider value={ctl}>
      {children}
      {/* The capture target: 0 x 0 so it is never hit, and inside the seam's
          wrapper so the wrapper's drag cursor reaches it. */}
      <div
        data-board-drag-pointer-layer=""
        aria-hidden
        ref={ctl.setLayer}
        className="fixed top-0 left-0 z-50 size-0"
      />
      {createPortal(
        <div
          data-board-drag-pointer-ghost=""
          ref={ctl.setGhost}
          className="pointer-events-none invisible fixed top-0 left-0 z-50 will-change-transform"
        >
          <BoardDragGhost />
        </div>,
        document.body,
      )}
    </ControllerContext.Provider>
  );
}

function useCard({
  itemId,
  disabled,
}: {
  itemId: string;
  disabled: boolean;
}): BoardDragCardBind {
  const ctl = useContext(ControllerContext);
  if (ctl === null) return INERT_BIND;
  return {
    ref: NOOP_REF,
    onPointerDown: (e) => ctl.press(e, itemId, disabled),
  };
}

/** The board's drag engine, on raw pointer events; HTML5 drag and drop is
 *  never used. */
export const pointerEngine: BoardDragEngine = {
  marker: "gd-board-drag-engine-pointer",
  Provider,
  useCard,
};
