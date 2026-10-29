// How far the app's toaster lifts off the window's bottom edge so toasts clear a
// docked action bar, and the observer box that watches the bar move. Free of
// runtime imports (`import type` only) so scripts/toast-clearance.test.mjs
// imports it directly under Node's type stripping, with no install.

/** Space kept between a docked bar's top edge and the lowest toast. */
export const TOAST_BAR_GAP = 12;

/** The bottom offset that puts toasts `gap` px above a bar whose top edge sits
 *  at `barTop` (viewport px); 0 when the bar sits at or below the viewport
 *  bottom (or a measurement isn't finite). */
export function barClearance({
  viewportHeight,
  barTop,
  gap,
}: {
  viewportHeight: number;
  barTop: number;
  gap: number;
}): number {
  if (
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(barTop) ||
    !Number.isFinite(gap) ||
    barTop >= viewportHeight
  )
    return 0;
  return Math.round(viewportHeight - barTop) + gap;
}

/** IntersectionObserver options whose root box hugs a bar's rect (insets
 *  floored, measured against the root's client box), so any move of the bar
 *  changes its ratio from `threshold`. `threshold` is a re-arm ratio, clamped
 *  to (0, 1] with 0 read as 1. Null (don't arm) for a boxless rect or any
 *  input that isn't a finite number. */
export function moveWatchOptions({
  left,
  top,
  width,
  height,
  rootWidth,
  rootHeight,
  threshold = 1,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  rootWidth: number;
  rootHeight: number;
  threshold?: number;
}): { rootMargin: string; threshold: number } | null {
  if (
    ![left, top, width, height, rootWidth, rootHeight, threshold].every(
      Number.isFinite,
    ) ||
    !width ||
    !height
  )
    return null;
  const insetTop = Math.floor(top);
  const insetRight = Math.floor(rootWidth - (left + width));
  const insetBottom = Math.floor(rootHeight - (top + height));
  const insetLeft = Math.floor(left);
  return {
    rootMargin: `${-insetTop}px ${-insetRight}px ${-insetBottom}px ${-insetLeft}px`,
    threshold: Math.max(0, Math.min(1, threshold)) || 1,
  };
}

/** The largest clearance among `values`; 0 when there are none. */
export function maxClearance(values: Iterable<number>): number {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return max;
}

// Entries are docked action bars, keyed per bar instance; the toaster clears the
// highest.
const entries = new Map<string, number>();
const listeners = new Set<() => void>();
let aggregate = 0;

function recompute() {
  const next = maxClearance(entries.values());
  if (next === aggregate) return;
  aggregate = next;
  for (const fn of listeners) fn();
}

/** Records bar `id`'s clearance; listeners hear only a changed aggregate. */
export function publishToastClearance(id: string, px: number) {
  entries.set(id, px);
  recompute();
}

/** Drops bar `id`'s entry, e.g. when the bar hides or unmounts. */
export function clearToastClearance(id: string) {
  if (!entries.delete(id)) return;
  recompute();
}

export function subscribeToastClearance(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The toaster's current bottom clearance: a primitive, so it is safe as a
 *  `useSyncExternalStore` snapshot. */
export function toastClearance(): number {
  return aggregate;
}
