/** Escape a string for safe embedding inside a `RegExp`. The project key is
 *  grammar-validated at link time, but escaping keeps this util correct for any
 *  caller and immune to a metacharacter ever slipping through. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the Jira issue keys of the *linked project only* referenced in a piece
 * of git text (commit message, PR title/body, branch name). Matches
 * `<PROJECTKEY>-\d+` case-insensitively — never a generic `[A-Z]+-\d+`, which
 * would false-positive on ISO-8601 dates, UTF-8, and the like. Deduplicated,
 * ordered by first occurrence.
 *
 * Boundary semantics (deliberately NOT plain `\b`, which counts underscore as a
 * word char and treats a bare `.` like any non-word char):
 *   - LEFT `(?<![A-Za-z0-9])`: reject a letter/digit prefix (`XMYT-1` → no), but
 *     ALLOW underscore adjacency — `_` is a common branch-name separator, so
 *     `feature_MYT-5` must yield MYT-5.
 *   - RIGHT `(?![A-Za-z])`: reject a letter suffix (`MYT-12a` → no).
 *   - RIGHT `(?!\.\d)`: reject a version-like `dot+digit` (`MYT-1.2` → no), while
 *     a sentence-ending period still matches (`fixes MYT-1.` → MYT-1).
 * Case table (all verified against this regex):
 *   feature_MYT-5 → MYT-5   |  MYT-5_x → MYT-5      |  feat/myt-2-fix → MYT-2
 *   fixes MYT-1.  → MYT-1   |  MYT-21  → MYT-21     |  (greedy \d+, no MYT-2)
 *   XMYT-1 → []  |  MYT-12a → []  |  MYT-1.2 → []  |  2024-01-02 → [] (key ≠ 2024)
 *
 * Null/empty text or an empty project key yields an empty array.
 */
export function extractJiraKeys(
  text: string | null | undefined,
  projectKey: string,
): string[] {
  if (!text || !projectKey) return [];
  // `i` so a lowercased key in a branch name (e.g. `proj-42-fix`) still matches;
  // `g` to walk every occurrence. Lookarounds implement the boundary table above
  // (Chromium/WebView2 supports lookbehind).
  const re = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(projectKey)}-\\d+(?![A-Za-z])(?!\\.\\d)`,
    "gi",
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    // Normalize to the canonical upper-case key so `proj-42` and `PROJ-42`
    // dedupe to one entry (and navigate to the same issue).
    const key = m[0].toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
