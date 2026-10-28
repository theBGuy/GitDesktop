import { type RefObject, useId, useLayoutEffect } from "react";
import {
  barClearance,
  clearToastClearance,
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
    const measure = () => {
      // A hidden bar's rect is all zeros, which would read as a full-height bar.
      if (bar.getClientRects().length === 0) {
        clearToastClearance(id);
        return;
      }
      publishToastClearance(
        id,
        barClearance({
          viewportHeight: window.innerHeight,
          barTop: bar.getBoundingClientRect().top,
          gap: TOAST_BAR_GAP,
        }),
      );
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
      resizes.disconnect();
      children.disconnect();
      window.removeEventListener("resize", measure);
      clearToastClearance(id);
    };
  }, [ref, active, id]);
}
