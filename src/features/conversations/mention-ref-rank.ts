// Ranking for the composer's `#`/`!` reference suggestions. Import-free at
// runtime on purpose: `scripts/mention-ref-rank.test.mjs` loads it straight from
// `src/` under Node's type stripping.

/** How many rows the popover shows, applied after ranking. */
export const MAX_ROWS = 8;

const NUMERIC = /^\d+$/;

/** A ref candidate before it becomes a row — the issue and PR lists, open and
 *  closed, share one ordering. */
export interface RefRow {
  number: number;
  title: string;
  state: string;
  isPr: boolean;
  isDraft: boolean;
  /** The freshest timestamp the source carries, for the recency ordering. */
  sortAt: string;
}

/** Prefix matches outrank substring matches; -1 drops the row. `needle` must
 *  already be lower-cased. */
export function textRank(haystack: string, needle: string): 0 | 1 | -1 {
  if (!needle) return 0;
  const i = haystack.toLowerCase().indexOf(needle);
  if (i === 0) return 0;
  return i > 0 ? 1 : -1;
}

/** Open rows (drafts included) rank above everything else at an equal text
 *  match. Must stay congruent with `remoteStateMatches(state, "open")`. */
export function refStateTier(state: string): 0 | 1 {
  return state === "OPEN" ? 0 : 1;
}

/** One kind's ranking input: the open read's rows ahead of the closed read's,
 *  the order `rankRefs`'s dedupe (first matching row wins) relies on to keep
 *  the open read's row for a number both reads returned. */
export function refInputRows(
  openRows: RefRow[],
  closedRows: RefRow[],
): RefRow[] {
  return [...openRows, ...closedRows];
}

/** The muted line under the options when a backing list failed but others
 *  still supplied rows; the all-empty case keeps the popover's empty message. */
export const PARTIAL_FAILURE_MESSAGE = "Some suggestions couldn't load";

/** Whether the popover shows `PARTIAL_FAILURE_MESSAGE`: only over rows, and
 *  only on a failure. A list still loading is never reported as one. */
export function showsPartialFailure(
  itemCount: number,
  isError: boolean,
): boolean {
  return isError && itemCount > 0;
}

/**
 * Match, dedupe and order ref rows: text rank first, then state tier, then
 * recency. Input comes from `refInputRows`, and the first matching row wins, so
 * a number both reads returned keeps the open read's row whenever it matches;
 * each row then ranks on its own state.
 */
export function rankRefs(rows: RefRow[], query: string): RefRow[] {
  const numeric = NUMERIC.test(query);
  const needle = query.toLowerCase();
  const seen = new Set<string>();
  const scored: { row: RefRow; rank: number; tier: 0 | 1 }[] = [];
  for (const row of rows) {
    const id = `${row.isPr}:${row.number}`;
    if (seen.has(id)) continue;
    let rank: 0 | 1 | -1;
    if (numeric) rank = String(row.number).startsWith(query) ? 0 : -1;
    else rank = textRank(row.title, needle);
    if (rank === -1) continue;
    // Only a matching row claims its number: a twin whose title the query
    // misses must not hide one it matches.
    seen.add(id);
    scored.push({ row, rank, tier: refStateTier(row.state) });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.tier !== b.tier) return a.tier - b.tier;
    // Equal timestamps must compare equal, not -1 both ways: an inconsistent
    // comparator lets the sort permute rows that should hold their input order.
    if (a.row.sortAt === b.row.sortAt) return 0;
    return a.row.sortAt < b.row.sortAt ? 1 : -1;
  });
  return scored.slice(0, MAX_ROWS).map(({ row }) => row);
}
