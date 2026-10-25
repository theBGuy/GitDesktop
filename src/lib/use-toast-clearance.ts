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
 * too. The entry drops when `active` goes false or the host unmounts.
 */
export function useToastClearance(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  const id = useId();
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!active || !bar) return;
    const measure = () =>
      publishToastClearance(
        id,
        barClearance({
          viewportHeight: window.innerHeight,
          barTop: bar.getBoundingClientRect().top,
          gap: TOAST_BAR_GAP,
        }),
      );
    measure();
    // The parent too: a sibling appearing below the host (the activity strip)
    // moves the bar by shrinking its container, without resizing the bar.
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (bar.parentElement) observer.observe(bar.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      clearToastClearance(id);
    };
  }, [ref, active, id]);
}
