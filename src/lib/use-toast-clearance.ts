import { type RefObject, useId, useLayoutEffect } from "react";
import {
  barClearance,
  clearToastClearance,
  moveWatchOptions,
  publishToastClearance,
  TOAST_BAR_GAP,
} from "@/lib/toast-clearance";

/**
 * Lifts the app's toasts above a docked action bar while `active`: the bar's
 * top edge is measured (not its height), so a strip docked below it is cleared
 * too. The entry drops when `active` goes false, the bar has no box
 * (`display: none`), or the host unmounts.
 */
export function useToastClearance(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  const id = useId();
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!active || !bar) return;
    let moves: IntersectionObserver | null = null;
    let clippedRetry: ReturnType<typeof setTimeout> | undefined;
    const stopWatchingMoves = () => {
      clearTimeout(clippedRetry);
      moves?.disconnect();
      moves = null;
    };
    // Each measure tears the move watch down first and re-arms it only after a
    // boxed publish, so a boxless bar keeps no observer or timer alive.
    const measureAt = (threshold: number) => {
      stopWatchingMoves();
      // A hidden bar's rect is all zeros, which would read as a full-height bar.
      if (bar.getClientRects().length === 0) {
        clearToastClearance(id);
        return;
      }
      const rect = bar.getBoundingClientRect();
      publishToastClearance(
        id,
        barClearance({
          viewportHeight: window.innerHeight,
          barTop: rect.top,
          gap: TOAST_BAR_GAP,
        }),
      );
      watchMoves(rect, threshold);
    };
    const measure = () => measureAt(1);
    // Moves that resize nothing observed below (a pane mounting under an
    // ancestor, a transform, a scroll) change the bar's ratio inside a root
    // box hugging its rect; a constructed observer's options are fixed, so
    // every measure re-arms it from the fresh rect.
    const watchMoves = (rect: DOMRect, threshold: number) => {
      const options = moveWatchOptions({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        rootWidth: document.documentElement.clientWidth,
        rootHeight: document.documentElement.clientHeight,
        threshold,
      });
      if (!options) return;
      // observe() always delivers the current state once; re-measuring
      // unconditionally from that delivery would re-arm forever.
      let first = true;
      const io = new IntersectionObserver((entries) => {
        if (moves !== io) return;
        // The entry is a snapshot: a bar that moved since (during the measure
        // included) gets a fresh measure whatever the ratio says.
        const now = bar.getBoundingClientRect();
        if (
          now.x !== rect.x ||
          now.y !== rect.y ||
          now.width !== rect.width ||
          now.height !== rect.height
        )
          return measure();
        // A batched delivery's older entries are stale; the newest is current.
        const ratio = entries[entries.length - 1].intersectionRatio;
        if (ratio !== options.threshold) {
          if (!first) return measure();
          // A bar fully clipped by an ancestor reports 0, and a move that keeps
          // it clipped crosses no threshold, so nothing fires; re-measure at a
          // throttled 1 Hz while it stays clipped.
          if (ratio === 0)
            clippedRetry = setTimeout(() => measureAt(1e-7), 1000);
          // Partly visible: settle at its real ratio, which 1 would never leave.
          else measureAt(ratio);
        }
        first = false;
      }, options);
      moves = io;
      io.observe(bar);
    };
    // In a bottom-docked column the bar's top moves when its container resizes
    // (a strip appearing below the host) or when anything after it in the
    // container grows, appears or leaves, none of which resizes the bar itself.
    const parent = bar.parentElement;
    const resizes = new ResizeObserver(measure);
    const observeAround = () => {
      resizes.disconnect();
      resizes.observe(bar);
      if (!parent) return;
      resizes.observe(parent);
      for (let el = bar.nextElementSibling; el; el = el.nextElementSibling)
        resizes.observe(el);
    };
    observeAround();
    measure();
    const children = new MutationObserver(() => {
      observeAround();
      measure();
    });
    if (parent) children.observe(parent, { childList: true });
    window.addEventListener("resize", measure);
    return () => {
      stopWatchingMoves();
      resizes.disconnect();
      children.disconnect();
      window.removeEventListener("resize", measure);
      clearToastClearance(id);
    };
  }, [ref, active, id]);
}
