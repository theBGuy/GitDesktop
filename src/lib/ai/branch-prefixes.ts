// The branch-name prompt's convention evidence: plain names in, a rendered
// frequency table out. It lives apart from `prompt.ts` so `scripts/*.test.mjs`
// can import this file under Node's type stripping — every import here must stay
// type-only and every path relative (stripping erases types but resolves no
// bundler aliases), and today there are none at all.
//
// KEEP IN SYNC: `branch_prefix_counts` / `branch_prefix_section`
// (src-tauri/src/mcp_server/generate.rs) render the same shape for the MCP
// recipe tools.

/** How many prefix rows the branch-name evidence carries. Rows descend by count,
 *  so nothing past the cap is used more often than the last row shown — but a tie
 *  can straddle the boundary, so the dropped rows are not necessarily rarer. */
const BRANCH_PREFIX_ROWS = 12;

/** What a branch carrying no `<prefix>/` segment is counted under — a real row,
 *  since "most branches here are unprefixed" is itself the convention. The label
 *  says what it means rather than naming a token, so it can't be copied into a
 *  branch name the way a real prefix row can. The test suite pins the literal
 *  by value on purpose — drift here must fail a test, not follow a rename. */
const NO_BRANCH_PREFIX = "(no prefix — bare names)";

/** Orders two prefixes the way Rust's `str` does. Rust compares UTF-8 bytes,
 *  which is code-POINT order; JS `<` compares UTF-16 code units and disagrees
 *  above the BMP, so the mirrors would tie-break differently on an astral ref
 *  name without this. */
export function compareCodePoints(a: string, b: string): number {
  const ax = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const bx = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  const shared = Math.min(ax.length, bx.length);
  for (let i = 0; i < shared; i++) {
    if (ax[i] !== bx[i]) return ax[i] - bx[i];
  }
  return ax.length - bx.length;
}

/** Branch names → `<prefix>/` counts, most used first, ties by prefix. A
 *  frequency table rather than a sample of names: any window of a branch list is
 *  ordered by something unrelated to convention, so it teaches the model
 *  whatever that window happened to hold. */
export function branchPrefixCounts(
  names: string[],
): { prefix: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const slash = name.indexOf("/");
    const prefix = slash > 0 ? name.slice(0, slash + 1) : NO_BRANCH_PREFIX;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || compareCodePoints(a.prefix, b.prefix));
}

/** The prefix evidence section, or null when there are no branches to count. */
export function branchPrefixSection(names: string[]): string | null {
  const counts = branchPrefixCounts(names);
  if (counts.length === 0) return null;
  const shown = counts.slice(0, BRANCH_PREFIX_ROWS);
  const rows = shown.map((c) => `${c.prefix} ${c.count}`).join("\n");
  const rest = counts.length - shown.length;
  return `## Branch name prefixes in this repository (most used first)\n${rows}${
    rest > 0
      ? `\n[${rest} more prefix(es), none used more often than the last row shown]`
      : ""
  }`;
}
