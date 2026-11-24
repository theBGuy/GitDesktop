import { useEffect, useLayoutEffect, useRef } from "react";
import { RESTORE_BOUND_MS } from "@/features/diff/diff-rows";
import { useSettings } from "@/lib/settings/queries";

/** The step diff boxes a Unified/Split switch can change the height of. */
const BOX_SELECTOR = "[data-transcript-diff]";

// Inputs that hand the column back to scrolling: the twin of DiffSurface's
// ANCHOR_RELEASE_INPUTS (not exported, so the session column never imports the
// diff chunk). Document-wide, captured ahead of the toggle or press they start.
const RELEASE_INPUTS = [
  "wheel",
  "touchmove",
  "keydown",
  "pointerdown",
] as const;

/** A step box in the column's content coordinates. */
export interface ColumnBox {
  top: number;
  bottom: number;
}

/** Where the column's top edge sits against the anchor box: `offset` is the
 *  box edge's position minus scrollTop, `height` the box's when sampled. */
export interface ColumnAnchor {
  index: number;
  edge: "top" | "bottom";
  offset: number;
  height: number;
}

/** Picks the last box whose top is at or above the column's top edge: an edge
 *  inside it keeps its proportional place in the box, an edge below it keeps
 *  the box's bottom (only box heights change on a switch, so what lies between
 *  it and the next box moves with that bottom). No box at or above the edge:
 *  null. */
export function pickColumnAnchor(
  boxes: readonly ColumnBox[],
  scrollTop: number,
): ColumnAnchor | null {
  let index = -1;
  for (const [i, box] of boxes.entries()) if (box.top <= scrollTop) index = i;
  const box = boxes[index];
  if (box === undefined) return null;
  const height = box.bottom - box.top;
  return scrollTop < box.bottom
    ? { index, edge: "top", offset: box.top - scrollTop, height }
    : { index, edge: "bottom", offset: box.bottom - scrollTop, height };
}

/** The scrollTop that puts the anchor back on `box`. An edge inside the box
 *  lands at the same proportion of its new height, so a box that shrinks below
 *  the old depth still holds the edge; an unchanged height keeps the offset. */
export function columnScrollTop(
  box: ColumnBox,
  anchor: Pick<ColumnAnchor, "edge" | "offset" | "height">,
): number {
  if (anchor.edge === "bottom") return box.bottom - anchor.offset;
  const height = box.bottom - box.top;
  if (height === anchor.height) return box.top - anchor.offset;
  const depth = (-anchor.offset * height) / anchor.height;
  return box.top + Math.min(Math.max(depth, 0), height);
}

interface HeldAnchor {
  el: Element;
  edge: ColumnAnchor["edge"];
  offset: number;
  height: number;
}

interface ColumnAnchorRuntime {
  anchor: HeldAnchor | null;
  /** Set by a restore until the next input anywhere or RESTORE_BOUND_MS: the
   *  placed anchor is not re-sampled, and a scroll or a box resize puts it
   *  back. Never ended by a scrollTop compare. */
  frozen: { place: () => void; release: () => void } | null;
}

function boxOf(scroller: HTMLElement, el: Element): ColumnBox {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const rect = el.getBoundingClientRect();
  return { top: rect.top - origin, bottom: rect.bottom - origin };
}

function readAnchor(scroller: HTMLElement): HeldAnchor | null {
  const els = [...scroller.querySelectorAll(BOX_SELECTOR)];
  const picked = pickColumnAnchor(
    els.map((el) => boxOf(scroller, el)),
    scroller.scrollTop,
  );
  const el = picked === null ? undefined : els[picked.index];
  if (picked === null || el === undefined) return null;
  return {
    el,
    edge: picked.edge,
    offset: picked.offset,
    height: picked.height,
  };
}

/** Places `anchor` (or, with none, the column's bottom) now and holds it there,
 *  returning the release. */
function holdColumn(
  rt: ColumnAnchorRuntime,
  scroller: HTMLElement,
  anchor: HeldAnchor | null,
): () => void {
  rt.frozen?.release();
  const place = () => {
    if (anchor === null) {
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      if (Math.abs(bottom - scroller.scrollTop) > 1)
        scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (!anchor.el.isConnected) return;
    const top = columnScrollTop(boxOf(scroller, anchor.el), anchor);
    if (Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTop = top;
  };
  // Rows landing in a box after the switch re-lay it with no scroll event, so
  // a box or content resize re-places; boxes opened during the hold join it.
  const resized = new ResizeObserver(place);
  const watch = () => {
    resized.disconnect();
    for (const child of scroller.children) resized.observe(child);
    for (const box of scroller.querySelectorAll(BOX_SELECTOR))
      resized.observe(box);
  };
  const swapped = new MutationObserver(watch);
  const timer = setTimeout(release, RESTORE_BOUND_MS);
  function release() {
    clearTimeout(timer);
    resized.disconnect();
    swapped.disconnect();
    for (const type of RELEASE_INPUTS)
      document.removeEventListener(type, release, true);
    if (rt.frozen?.release === release) rt.frozen = null;
  }
  place();
  watch();
  swapped.observe(scroller, { childList: true, subtree: true });
  for (const type of RELEASE_INPUTS)
    document.addEventListener(type, release, { capture: true, passive: true });
  rt.anchor = anchor;
  rt.frozen = { place, release };
  return release;
}

/** Keeps the session column's place across a Unified/Split switch of the
 *  setting: only open step diffs change height, so the column holds the last
 *  open step box at or above its top edge (`pickColumnAnchor`), or its bottom
 *  while `stickRef` pins it there. Scrolling and a step box resize sample the
 *  anchor; the switch restores it, also on an `<Activity>` re-show after a
 *  switch made while hidden. */
export function useColumnLayoutAnchor(
  scrollerRef: { readonly current: HTMLElement | null },
  stickRef: { readonly current: boolean },
): void {
  const mode = useSettings().data?.diffViewMode ?? "unified";
  const runtime = useRef<ColumnAnchorRuntime>({ anchor: null, frozen: null });
  const appliedRef = useRef(mode);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rt = runtime.current;
    let frame = 0;
    let watchFrame = 0;
    // A hidden column has no height, so it reads no anchor.
    const read = () => {
      if (rt.frozen !== null || scroller.clientHeight === 0) return;
      rt.anchor = readAnchor(scroller);
    };
    // Only the scroll frame's own run clears its handle, so cleanup still
    // cancels a frame pending when a resize read the anchor.
    const sample = () => {
      frame = 0;
      read();
    };
    const onScroll = () => {
      if (rt.frozen !== null) {
        rt.frozen.place();
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(sample);
    };
    // A step opened, closed or re-built without a scroll moves the anchor.
    const resized = new ResizeObserver(read);
    const observed = new Set<Element>();
    const watch = () => {
      watchFrame = 0;
      const boxes = new Set(scroller.querySelectorAll(BOX_SELECTOR));
      for (const box of observed)
        if (!boxes.has(box)) {
          resized.unobserve(box);
          observed.delete(box);
        }
      for (const box of boxes)
        if (!observed.has(box)) {
          resized.observe(box);
          observed.add(box);
        }
    };
    // One box query per frame however many mutations land in it (each
    // streamed delta is one): a box added in that frame is observed at the
    // frame, and a ResizeObserver reports a box's size on its first observation.
    const swapped = new MutationObserver(() => {
      if (watchFrame === 0) watchFrame = requestAnimationFrame(watch);
    });
    watch();
    swapped.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(watchFrame);
      swapped.disconnect();
      resized.disconnect();
    };
  }, [scrollerRef]);
  // Its cleanup is the release, so the next switch, a hide and an unmount each
  // end a hold. The applied mode survives a hide, so a re-show restores only
  // when the setting moved while hidden.
  useLayoutEffect(() => {
    const applied = appliedRef.current;
    appliedRef.current = mode;
    const scroller = scrollerRef.current;
    if (applied === mode || !scroller) return;
    const rt = runtime.current;
    if (stickRef.current) return holdColumn(rt, scroller, null);
    if (rt.anchor === null) return;
    return holdColumn(rt, scroller, rt.anchor);
  }, [mode, scrollerRef, stickRef]);
}
