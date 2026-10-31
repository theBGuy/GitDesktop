// Import-free so scripts/file-history-entries.test.mjs can load it under
// Node's type stripping.

/** First occurrence wins; order preserved. Keeps React keys unique through
 *  the refetch/HEAD-move window. */
export function dedupeByHash<T extends { hash: string }>(
  entries: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    out.push(entry);
  }
  return out;
}

/** The path the diff pane reads for `hash`: that entry's path, else `fallback`
 *  (the dialog's own path) when the hash isn't in the loaded entries. */
export function entryPathFor(
  entries: readonly { hash: string; path: string }[],
  hash: string,
  fallback: string,
): string {
  return entries.find((e) => e.hash === hash)?.path ?? fallback;
}
