import { type RefCallback, useCallback, useRef, useState } from "react";

/**
 * Measures the BORDER-box width of the element the returned ref is attached to
 * — the same box `getBoundingClientRect` reports, so the first measurement and
 * every observed one agree even on a padded or bordered element. Width is React
 * state (a mutable module/ref value would be invisible to the compiler's render
 * memoization) and integer-rounded so sub-pixel resizes don't re-render.
 * `null` until the first measurement lands.
 */
export function useContainerWidth<T extends HTMLElement>(): [
  RefCallback<T>,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    // Detach (unmount, or <Activity> hiding the panel): keep the last width so
    // a re-show renders at the size it had rather than flashing the fallback.
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // `contentRect` is the CONTENT box; fall back to it only where
      // borderBoxSize is unavailable, so the two measurement paths can't
      // disagree by the element's padding + border.
      const border = entry.borderBoxSize?.[0]?.inlineSize;
      setWidth(Math.round(border ?? entry.contentRect.width));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [measureRef, width];
}
