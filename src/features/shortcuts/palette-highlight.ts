// Cursor math for palette-style pickers. Stays free of runtime imports: node's
// type stripping (scripts/palette-highlight.test.mjs) resolves no bundler aliases.

/** The one clamped cursor a palette-style picker renders and runs: the stored
 *  index clamped into [0, count-1], or -1 for an empty list (indexes to
 *  undefined, so Enter is a no-op). */
export function clampHighlight(stored: number, count: number): number {
  return count > 0 ? Math.min(Math.max(stored, 0), count - 1) : -1;
}

/** The next stored value after an arrow step. Steps from the CLAMPED cursor,
 *  never the raw stored value, so the first press steps from the row the
 *  user sees; an empty list returns `stored` unchanged (React bails on the
 *  same-value set). */
export function stepHighlight(
  stored: number,
  count: number,
  delta: 1 | -1,
): number {
  if (count === 0) return stored;
  const active = clampHighlight(stored, count);
  return delta === 1
    ? Math.min(active + 1, count - 1)
    : Math.max(active - 1, 0);
}
