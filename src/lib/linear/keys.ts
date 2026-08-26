function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract Linear issue identifiers (`ENG-123`) from git text (commit messages,
 * PR titles, branch names). Same boundary semantics as the Jira key extractor:
 * scoped to the linked team key only, case-insensitive, deduplicated by first
 * occurrence.
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
