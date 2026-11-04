// Imported by scripts/conflict-jump.test.mjs under Node's type stripping, so
// this module keeps to type-only imports.

/** Fractional-zoom slack: a region within this distance of the pane top
 *  counts as current, so a landed jump does not pick itself again. */
export const JUMP_TOLERANCE_PX = 2;

/** `anchor` is the focused region's ordinal, read from the DOM at press time;
 *  null, non-integer or out-of-range anchors use the position fallback.
 *  `tops` are region tops relative to the pane's viewport, in document order. */
export function nextConflictIndex(
  anchor: number | null,
  tops: readonly number[],
  tolerance = JUMP_TOLERANCE_PX,
): number | null {
  const n = tops.length;
  if (n === 0) return null;
  if (anchor !== null && Number.isInteger(anchor) && anchor >= 0 && anchor < n)
    return (anchor + 1) % n;
  const next = tops.findIndex((top) => top > tolerance);
  return next === -1 ? 0 : next;
}

/** Shares nextConflictIndex's anchor and position contract; both ends wrap. */
export function previousConflictIndex(
  anchor: number | null,
  tops: readonly number[],
  tolerance = JUMP_TOLERANCE_PX,
): number | null {
  const n = tops.length;
  if (n === 0) return null;
  if (anchor !== null && Number.isInteger(anchor) && anchor >= 0 && anchor < n)
    return (anchor - 1 + n) % n;
  for (let i = n - 1; i >= 0; i--) {
    if (tops[i] < -tolerance) return i;
  }
  return n - 1;
}

/** Land only when the first region starts at/below the fold; the caller's
 *  landConflictRegion owns scrolling and leaves focus untouched on open. */
export function shouldLandOnOpen(
  firstTop: number,
  paneHeight: number,
  tolerance = JUMP_TOLERANCE_PX,
): boolean {
  return firstTop >= paneHeight - tolerance;
}
