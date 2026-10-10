// Import-free on purpose: scripts/frozen-order.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/** `items` (in live order) reordered by a snapshot of their keys: snapshot keys in
 *  snapshot order, then items the snapshot lacks in their live order. Items gone
 *  from `items` drop out; a null snapshot keeps the live order. Holds a list still
 *  while an action taken on it (an open that moves its row to the top) reorders the
 *  live data, and leaves each item's data live. */
export function applyFrozenOrder<T>(
  items: T[],
  frozen: readonly string[] | null,
  keyOf: (item: T) => string,
): T[] {
  if (frozen === null) return items;
  const rank = new Map(frozen.map((key, i) => [key, i] as const));
  const known = items
    .filter((item) => rank.has(keyOf(item)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  return [...known, ...items.filter((item) => !rank.has(keyOf(item)))];
}

/** A filesystem path's frozen-order key, ignoring case and separator spelling the
 *  way Windows compares paths. Mirrors `normPath` (lib/git/path.ts), re-spelled so
 *  this module stays import-free. */
export function frozenPathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
