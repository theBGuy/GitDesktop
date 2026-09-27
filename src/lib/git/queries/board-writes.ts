/**
 * The pure pieces of the board-write bookkeeping: the keys a board write and a
 * board read are filed under, how a write's variables name its repo, and the
 * predicates the settle, window-focus and mount paths decide by.
 *
 * Import-free at runtime on purpose (types only, erased): internal.ts, core.ts and
 * projects.ts all import this file, so it can sit under each of them without a
 * cycle, and `scripts/board-writes.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
import type { InvalidateQueryFilters } from "@tanstack/react-query";

/** EVERY cached board read in one repo — every board, every lens of each. The
 *  scope a board write settles against: a write changes what an item IS, which no
 *  board's filter makes untrue. */
export const projectItemsRepoKey = (repo: string) =>
  ["repo", repo, "project-items"] as const;

/** Filter prefix for EVERY board write (projects.ts `boardWriteKey`) — narrowed
 *  to one repo by {@link boardWriteVars}. */
export const BOARD_WRITES_KEY = ["board-write"] as const;

/** Every board write's variables carry the repo it addresses; the rest are per-kind
 *  and read only for labels. Untrusted at this boundary in the sense that the
 *  filter sees `Mutation<any>`, so each field is `typeof`-guarded rather than
 *  asserted. The two BULK list spellings are read here rather than at the call
 *  site for the same reason: one place decides what a write's variables mean. */
export function boardWriteVars(mutation: { state: { variables?: unknown } }): {
  repo: string | null;
  itemId: string | null;
  number: number | null;
  count: number | null;
} {
  const vars = mutation.state.variables;
  if (typeof vars !== "object" || vars === null)
    return { repo: null, itemId: null, number: null, count: null };
  const { repo, itemId, number, items, itemIds } = vars as Record<
    string,
    unknown
  >;
  const list = Array.isArray(items)
    ? items
    : Array.isArray(itemIds)
      ? itemIds
      : null;
  return {
    repo: typeof repo === "string" ? repo : null,
    itemId: typeof itemId === "string" ? itemId : null,
    number: typeof number === "number" ? number : null,
    count: list === null ? null : list.length,
  };
}

/**
 * Whether a board-write mutation on `repo` is PAUSED offline — it ran its
 * `onMutate` patch, but query-core parked it before its `mutationFn`, so the
 * request-scoped count (internal.ts `pendingBoardWrites`) never saw it. Never
 * true for a write inside its request, so the two readings can't both count one
 * write.
 *
 * Never true for a write that is settling either, so a settle can't count itself
 * — PROVIDED every board-write `onMutate` awaits only microtask-scope work (today:
 * `cancelQueries`). query-core captures `isPaused` BEFORE `onMutate` and clears
 * it only on resume or at the final success/error dispatch, after `onSettled`: a
 * write that went offline→online across an `onMutate` spanning a real event would
 * start without pausing and carry `isPaused: true` through its own settle.
 */
export function pausedBoardWriteOn(
  mutation: { state: { isPaused: boolean; variables?: unknown } },
  repo: string,
): boolean {
  return mutation.state.isPaused && boardWriteVars(mutation).repo === repo;
}

/** Count one more live chase on the lens `hash`. */
export function holdLens(held: Map<string, number>, hash: string): void {
  held.set(hash, (held.get(hash) ?? 0) + 1);
}

/** Count one chase on `hash` finished; the entry is DELETED at zero, so the map
 *  holds only lenses a chase is reading. */
export function releaseLens(held: Map<string, number>, hash: string): void {
  const left = (held.get(hash) ?? 1) - 1;
  if (left > 0) held.set(hash, left);
  else held.delete(hash);
}

/**
 * A board lens's `refetchOnMount`: false while a date-shift chase holds the lens,
 * the query-core default (`true`) otherwise. Reads `held` LIVE on every mount —
 * a lens held after the predicate was built must still be caught.
 */
export function refetchOnMountUnlessHeld(held: ReadonlyMap<string, number>) {
  return (query: { queryHash: string }): boolean => !held.has(query.queryHash);
}

/**
 * The window-focus bridge's invalidation of every repo query, as the filter sets
 * to run. A lens in `held` (a date-shift chase is reading it) is marked stale but
 * NOT refetched: an answer landing mid-chase replaces the patched dates the chase
 * compares against, and it would write the server's older ones back. The chase's
 * own settle reconciles the lens through `invalidateProjectBoards` whatever became
 * of this mark, which a later press's patch clears. With nothing held this is the
 * one plain invalidation, unchanged.
 */
export function repoFocusInvalidations(
  held: ReadonlyMap<string, number>,
): InvalidateQueryFilters[] {
  if (held.size === 0) return [{ queryKey: ["repo"] }];
  // A snapshot: the filters run synchronously, but nothing should read a map a
  // chase settling in between could change.
  const chased = new Set(held.keys());
  return [
    { queryKey: ["repo"], predicate: (query) => !chased.has(query.queryHash) },
    {
      queryKey: ["repo"],
      predicate: (query) => chased.has(query.queryHash),
      refetchType: "none",
    },
  ];
}
