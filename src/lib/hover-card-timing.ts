import type { RefObject } from "react";

// A card positioned by hand off an inert trigger gets none of Base UI's own
// hover machinery, so its delays are hand-rolled from that library's constants.
export const CARD_OPEN_DELAY = 600;
export const CARD_CLOSE_DELAY = 300;

export function cancelTimer(
  ref: RefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

export function cancelFrame(ref: RefObject<number | null>) {
  if (ref.current !== null) {
    cancelAnimationFrame(ref.current);
    ref.current = null;
  }
}
