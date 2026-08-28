/**
 * Text search over the actions list, shared by the command palette and the
 * Settings → Keyboard list so a query can't find an action in one and miss it
 * in the other.
 */

const norm = (s: string) => s.toLowerCase().replaceAll("-", "");

/**
 * A query's searchable tokens: whitespace-separated, lowercased, hyphens
 * dropped. Filtering AFTER normalizing matters — an all-hyphen token
 * normalizes to "", which every haystack "contains", so dropping it keeps the
 * no-constraint path the only one that matches everything.
 */
export function queryTokens(query: string): string[] {
  return query.trim().split(/\s+/).map(norm).filter(Boolean);
}

/**
 * Whether every token appears somewhere in an action's label + category, so
 * word order and gaps cost nothing ("cancel pipeline" finds "Cancel workflow
 * run/pipeline") and neither does hyphenation ("rerun" finds "Re-run…"). Each
 * token still has to be a literal substring of what's left. No tokens matches
 * everything.
 */
export function matchesActionText(
  tokens: string[],
  label: string,
  category: string,
): boolean {
  if (tokens.length === 0) return true;
  const hay = norm(`${label} ${category}`);
  return tokens.every((t) => hay.includes(t));
}
