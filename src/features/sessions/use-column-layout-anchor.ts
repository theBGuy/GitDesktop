import { Component, createContext, useLayoutEffect, useState } from "react";
import { RESTORE_BOUND_MS } from "@/features/diff/diff-rows";
import type { AppSettings } from "@/lib/settings/api";

/** The step diff boxes the column anchors on; a Unified/Split switch changes
 *  the height of only those that draw diff rows. */
const BOX_SELECTOR = "[data-transcript-diff]";

/** Whether the column sits at its bottom, where streamed output keeps it. */
export function atColumnBottom(scroller: HTMLElement): boolean {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
  );
}

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

/** What a step box draws, as its mark reports it: "pending" until the box's
 *  first measurement, so that measurement is never a switch. */
export type StepLayout = "pending" | AppSettings["diffViewMode"];

/** Whether a box that showed `was` draws another layout as `now`. */
function switchesLayout(was: StepLayout, now: StepLayout): boolean {
  return was !== "pending" && now !== "pending" && was !== now;
}

interface HeldAnchor {
  el: Element;
  edge: ColumnAnchor["edge"];
  offset: number;
  height: number;
}

/** The column at the last instant it showed the reader the outgoing layout. */
interface ColumnShot {
  /** Kept with the read: a re-show restores before React re-attaches refs. */
  scroller: HTMLElement;
  pinned: boolean;
  /** The anchor a hold kept the column on, while its box is still there. */
  held: HeldAnchor | null;
  scrollTop: number;
  /** A restore to the bottom over content still this tall moves nothing: what
   *  the reader saw did not change. */
  scrollHeight: number;
  boxes: readonly (ColumnBox & { el: Element })[];
}

/** A placed anchor (null: the column's bottom) and the release of its hold. */
interface Hold {
  anchor: HeldAnchor | null;
  release: () => void;
}

/** One session column's place keeper, driven by its step boxes' marks. */
export interface ColumnLayoutAnchor {
  /** Reads the column before a switch changes the DOM: the first call in a
   *  commit reads for every box, and a column with no height reads nothing. */
  capture(): void;
  /** Puts the read place back (the bottom while pinned) and holds it. */
  restore(): void;
  /** Ends a hold, for a scroll the host makes itself. */
  release(): void;
}

export const ColumnLayoutAnchorContext =
  createContext<ColumnLayoutAnchor | null>(null);

function boxOf(scroller: HTMLElement, el: Element): ColumnBox {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const rect = el.getBoundingClientRect();
  return { top: rect.top - origin, bottom: rect.bottom - origin };
}

/** The anchor `shot` names among its boxes still in the column, at the
 *  geometry the reader saw (a removed box can't hold the place). */
function anchorOf(shot: ColumnShot): HeldAnchor | null {
  if (shot.held?.el.isConnected) return shot.held;
  const boxes = shot.boxes.filter((box) => box.el.isConnected);
  const picked = pickColumnAnchor(boxes, shot.scrollTop);
  const el = picked === null ? undefined : boxes[picked.index]?.el;
  if (picked === null || el === undefined) return null;
  return {
    el,
    edge: picked.edge,
    offset: picked.offset,
    height: picked.height,
  };
}

/** Places `anchor` (or, with none, the column's bottom from the first moment
 *  its content is not `height` tall) now and holds it there until
 *  RESTORE_BOUND_MS or the next input anywhere, then calls `done` once. Never
 *  ended by a scrollTop compare. Returns the release. */
function holdColumn(
  scroller: HTMLElement,
  anchor: HeldAnchor | null,
  height: number,
  boxes: Iterable<Element>,
  done: () => void,
): () => void {
  // Once the content differs from `height`, every later place pins: content
  // that regrows to that height has still moved the bottom since the capture.
  let moved = false;
  const place = () => {
    if (anchor === null) {
      if (!moved && scroller.scrollHeight === height) return;
      moved = true;
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
  const watch = (els: Iterable<Element>) => {
    resized.disconnect();
    for (const child of scroller.children) resized.observe(child);
    for (const box of els) resized.observe(box);
  };
  const swapped = new MutationObserver(() =>
    watch(scroller.querySelectorAll(BOX_SELECTOR)),
  );
  const timer = setTimeout(release, RESTORE_BOUND_MS);
  let holding = true;
  function release() {
    if (!holding) return;
    holding = false;
    clearTimeout(timer);
    resized.disconnect();
    swapped.disconnect();
    scroller.removeEventListener("scroll", place);
    for (const type of RELEASE_INPUTS)
      document.removeEventListener(type, release, true);
    done();
  }
  place();
  watch(boxes);
  swapped.observe(scroller, { childList: true, subtree: true });
  scroller.addEventListener("scroll", place, { passive: true });
  for (const type of RELEASE_INPUTS)
    document.addEventListener(type, release, { capture: true, passive: true });
  return release;
}

function createColumnAnchor(
  scrollerRef: { readonly current: HTMLElement | null },
  jumpingRef: { readonly current: boolean },
): ColumnLayoutAnchor & { discard: () => void } {
  // No place is kept between switches: each restore reads the shot its own
  // commit (or the hide that preceded it) took.
  let shot: ColumnShot | null = null;
  let hold: Hold | null = null;
  const release = () => hold?.release();
  return {
    capture() {
      const scroller = scrollerRef.current;
      if (shot !== null || scroller === null || scroller.clientHeight === 0)
        return;
      // A hold already placed the reader's place: a capture during it keeps
      // that place, so a second switch inside the hold round-trips.
      const held =
        hold !== null && (hold.anchor === null || hold.anchor.el.isConnected)
          ? hold
          : null;
      shot = {
        scroller,
        pinned:
          held === null
            ? atColumnBottom(scroller) || jumpingRef.current
            : held.anchor === null,
        held: held?.anchor ?? null,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        boxes: Array.from(scroller.querySelectorAll(BOX_SELECTOR), (el) => ({
          el,
          ...boxOf(scroller, el),
        })),
      };
    },
    restore() {
      const taken = shot;
      shot = null;
      if (taken === null || !taken.scroller.isConnected) return;
      const { scroller } = taken;
      const anchor = taken.pinned ? null : anchorOf(taken);
      hold?.release();
      if (!taken.pinned && anchor === null) return;
      const boxes = taken.boxes
        .filter((box) => box.el.isConnected)
        .map((box) => box.el);
      let next: Hold | null = null;
      const end = holdColumn(
        scroller,
        anchor,
        taken.scrollHeight,
        boxes,
        () => {
          if (hold === next) hold = null;
        },
      );
      next = { anchor, release: end };
      hold = next;
    },
    release,
    discard() {
      shot = null;
    },
  };
}

/** A step box's report of the layout it draws; renders nothing. The commit
 *  that changes it reads the column before any DOM change (React runs every
 *  snapshot ahead of the mutation phase) and restores after it. Snapshots
 *  skip a hidden subtree and the commit that reveals it, so a re-show compares
 *  the layout the box last showed and restores from the read taken at the
 *  hide. */
export class ColumnLayoutMark extends Component<
  { layout: StepLayout },
  object,
  boolean
> {
  static contextType = ColumnLayoutAnchorContext;
  declare context: ColumnLayoutAnchor | null;
  /** What the box drew when the column last showed it. */
  private shown: StepLayout | null = null;

  componentDidMount() {
    const was = this.shown;
    this.shown = this.props.layout;
    if (was !== null && switchesLayout(was, this.props.layout))
      this.context?.restore();
  }

  getSnapshotBeforeUpdate() {
    const switched =
      this.shown !== null && switchesLayout(this.shown, this.props.layout);
    if (switched) this.context?.capture();
    return switched;
  }

  componentDidUpdate(_props: unknown, _state: unknown, switched?: boolean) {
    this.shown = this.props.layout;
    if (switched === true) this.context?.restore();
  }

  render() {
    return null;
  }
}

/** Keeps the session column's place across a Unified/Split switch of what its
 *  step diffs draw (the setting, a step's width crossing Split's floor, or an
 *  `<Activity>` re-show after a switch made while hidden): only open step
 *  diffs change height, so the column holds the last open step box at or
 *  above its top edge (`pickColumnAnchor`), or its bottom while it sits there
 *  or `jumpingRef` animates it there. Each step box renders a
 *  `ColumnLayoutMark` under `ColumnLayoutAnchorContext` carrying the returned
 *  value (a box drawing no diff rows renders none); a first measurement or a
 *  step opening or closing never restores. */
export function useColumnLayoutAnchor(
  scrollerRef: { readonly current: HTMLElement | null },
  jumpingRef: { readonly current: boolean },
): ColumnLayoutAnchor {
  const [column] = useState(() => createColumnAnchor(scrollerRef, jumpingRef));
  // The setup runs after the marks' own work in the commit that shows the
  // column, so it drops a hide-time read no mark restored from. The cleanup
  // runs on a hide before React applies display:none (the column still shows
  // the reader's place), and ends a hold on a hide or unmount.
  useLayoutEffect(() => {
    column.discard();
    return () => {
      column.capture();
      column.release();
    };
  }, [column]);
  return column;
}
