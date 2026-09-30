import { useEffect, useEffectEvent, useState } from "react";
import {
  guardedLimit,
  guardObservation,
  initialLoadMoreGuard,
  type LoadMoreGuardState,
  stepLoadMoreGuard,
} from "./remote-section-state";

type GuardedQuery = Parameters<typeof guardObservation>[0];

/**
 * Keeps a limit-keyed list's rows when "Load more" fails. Growing the limit
 * makes a new query key, and a failed load there has no data at all, so the
 * list would blank; instead the query rolls back to the last limit that loaded
 * (its cached rows come straight back) and `loadMoreFailed` stays up until a
 * load reaches the failed limit or `identity` changes.
 *
 * Two phases around the caller's query, because the query's key needs the
 * guarded limit and the guard needs the query's result:
 *
 *   const more = useLoadMoreGuard({ identity, limit, setLimit });
 *   const list = useSomeList(…, more.limit, …);
 *   const loadMore = more.observe(list);
 *
 * `identity` names everything besides the limit that picks the list (repo,
 * lens, state tab, filter): a failure under another identity never shows.
 */
export function useLoadMoreGuard(opts: {
  identity: string;
  limit: number;
  setLimit: (limit: number) => void;
}): {
  /** The limit to key the query with — every reader of the list's limit
   *  (its query, dependent queries, the `hasMore` count) uses this one. */
  limit: number;
  observe: (query: GuardedQuery) => {
    loadMoreFailed: boolean;
    /** Serving the previous page as placeholder because THIS list's limit
     *  grew — not a tab or filter switch, which placeholder rows also cover. */
    growing: boolean;
    retryLoadMore: () => void;
  };
} {
  const { identity, setLimit } = opts;
  const requested = opts.limit;
  const [guard, setGuard] = useState<LoadMoreGuardState>(() =>
    initialLoadMoreGuard(identity),
  );
  const limit = guardedLimit(guard, identity, requested);

  // The caller's own limit (panel state, the findings store) catches up after
  // commit; until then `guardedLimit` redirects the query, so no render ever
  // keys it on the failed limit again.
  const pending = guard.identity === identity ? guard.rollback : null;
  const syncCaller = useEffectEvent((from: number, to: number) => {
    if (opts.limit === from) setLimit(to);
  });
  useEffect(() => {
    if (pending) syncCaller(pending.from, pending.to);
  }, [pending]);

  function observe(query: GuardedQuery) {
    const next = stepLoadMoreGuard(guard, {
      identity,
      requested,
      limit,
      ...guardObservation(query),
    });
    // Adjusting state while rendering (React's "storing information from
    // previous renders" pattern, this component's own state only): React
    // re-renders before committing, so the failed render's empty list never
    // reaches the DOM and the scroll position survives. `stepLoadMoreGuard`
    // returns its input once settled, so this stops after one pass.
    if (next !== guard) setGuard(next);
    const failed = next.identity === identity ? next.failed : null;
    return {
      loadMoreFailed: failed !== null,
      growing:
        query.isPlaceholderData &&
        next.identity === identity &&
        next.lastGood !== null &&
        limit > next.lastGood,
      retryLoadMore: () => {
        if (failed === null) return;
        setGuard((g) => ({ ...g, rollback: null }));
        setLimit(failed);
      },
    };
  }

  return { limit, observe };
}
