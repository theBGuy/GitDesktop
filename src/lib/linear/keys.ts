/** Escape a string for safe embedding inside a `RegExp`. The team key is
 *  grammar-validated at link time, but escaping keeps this util correct for any
 *  caller and immune to a metacharacter ever slipping through. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the Linear issue identifiers of the *linked team only* referenced in
 * a piece of git text (commit message, PR title/body, branch name). Matches
 * `<TEAMKEY>-\d+` case-insensitively — never a generic `[A-Z]+-\d+`, which
 * would false-positive on ISO-8601 dates, UTF-8, and the like. Deduplicated,
 * ordered by first occurrence.
 *
 * Boundary semantics (deliberately NOT plain `\b`, which counts underscore as a
 * word char and treats a bare `.` like any non-word char):
 *   - LEFT `(?<![A-Za-z0-9])`: reject a letter/digit prefix (`XENG-1` → no),
 *     but ALLOW underscore adjacency — `_` is a common branch-name separator, so
 *     `feature_ENG-5` must yield ENG-5.
 *   - RIGHT `(?![A-Za-z])`: reject a letter suffix (`ENG-12a` → no).
 *   - RIGHT `(?!\.\d)`: reject a version-like `dot+digit` (`ENG-1.2` → no),
 *     while a sentence-ending period still matches (`fixes ENG-1.` → ENG-1).
 * Case table (all verified against this regex):
 *   feature_ENG-5 → ENG-5   |  ENG-5_x → ENG-5      |  feat/eng-2-fix → ENG-2
 *   fixes ENG-1.  → ENG-1   |  ENG-21  → ENG-21     |  (greedy \d+, no ENG-2)
 *   XENG-1 → []  |  ENG-12a → []  |  ENG-1.2 → []  |  2024-01-02 → [] (key ≠ 2024)
 *
 * Null/empty text or an empty team key yields an empty array.
 */
export function extractLinearKeys(
  text: string | null | undefined,
  teamKey: string,
): string[] {
  if (!text || !teamKey) return [];
  const re = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(teamKey)}-\\d+(?![A-Za-z])(?!\\.\\d)`,
    "gi",
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const key = m[0].toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
