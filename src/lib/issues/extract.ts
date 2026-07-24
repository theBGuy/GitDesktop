/**
 * Extract candidate issue numbers referenced in git text (branch name, commit
 * subjects). Deduplicated, first-occurrence order. Matches:
 *   - `#123` (not preceded by a letter/digit, and not `&#123` HTML entities)
 *   - a branch segment starting `123-` (e.g. `123-fix-crash`, `fix/123-crash`)
 *   - `issue-123` / `gh-123` (case-insensitive, boundary-guarded)
 * Numbers are validated against real repo issues by the caller — this is
 * extraction only. KEEP IN SYNC: extract_issue_numbers in
 * src-tauri/src/mcp_server/generate.rs (which has no lookbehind — both sides
 * use explicit leading-boundary capture groups so behavior stays identical).
 *
 * The three patterns are run in order over the WHOLE text; capture group 1 is
 * parsed as an integer, `0` and anything > 999_999_999 dropped, and the results
 * deduped preserving first-occurrence order across patterns (1 → 2 → 3).
 *
 * Case table (verified against the patterns below):
 *   `fix/123-crash` → 123   (pattern 2: after `/`, digits then `-`)
 *   `123-fix`       → 123   (pattern 2: string start, digits then `-`)
 *   `#45`           → 45    (pattern 1: `#` not preceded by letter/digit/`&`)
 *   `&#39;`         → []    (pattern 1's `&` exclusion keeps HTML entities out)
 *   `issue-7`       → 7     (pattern 3, case-insensitive)
 *   `gh-7`          → 7     (pattern 3, case-insensitive)
 *   `v2-123`        → []    (pattern 2 fires only at string start or after `/`,
 *                            and the segment here starts `v2`, not digits; the
 *                            mid-token `2-1` is preceded by `v`, so nothing)
 *   `abc#12`        → []    (pattern 1: `#` preceded by a letter)
 *   `#12 #12`       → [12]  (deduped, first occurrence kept)
 */
export function extractIssueNumbers(text: string | null | undefined): number[] {
  if (!text) return [];

  // Explicit leading-boundary capture groups (no lookbehind) so the Rust `regex`
  // crate twin behaves identically.
  const patterns = [
    // `#123`, where `#` is at the start or after a non-alphanumeric that isn't
    // `&` (so `&#39;`-style HTML entities never match).
    /(?:^|[^A-Za-z0-9&])#(\d+)/g,
    // A branch segment starting with a number: `123-…` at the string start or
    // right after a `/` (`fix/123-crash`).
    /(?:^|\/)(\d+)-/g,
    // `issue-123` / `gh-123`, boundary-guarded on the left.
    /(?:^|[^A-Za-z0-9])(?:issue|gh)-(\d+)/gi,
  ];

  const seen = new Set<number>();
  const out: number[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number.parseInt(m[1], 10);
      if (!Number.isInteger(n) || n <= 0 || n > 999_999_999) continue;
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}
