// Import-free on purpose: `scripts/repo-mutation-invalidation.test.mjs` loads this
// module directly under Node's type stripping, which resolves no path aliases and
// no extensionless specifiers. Type-only imports are erased, so they may stay.
import type { Query, QueryClient } from "@tanstack/react-query";

/** A prefix-matched key, or a prefix narrowed by a predicate over each match. */
export type InvalidationEntry =
  | readonly unknown[]
  | {
      queryKey: readonly unknown[];
      predicate: (query: Query) => boolean;
    };

type QueryKeys = readonly InvalidationEntry[];

/** A `useRepoMutation` render's invalidation lists; `onMutate` returns the
 *  ones in effect when the write started as its context. */
export interface RepoMutationKeys {
  invalidate: QueryKeys;
  invalidateAfter: QueryKeys;
}

function filtersOf(entry: InvalidationEntry): {
  queryKey: readonly unknown[];
  predicate?: (query: Query) => boolean;
} {
  // `Array.isArray` doesn't narrow a readonly array out of a union.
  return Array.isArray(entry)
    ? { queryKey: entry }
    : (entry as Exclude<InvalidationEntry, readonly unknown[]>);
}

/** Both lists in order, each entry once: keys compare by their JSON form, a filter
 *  entry by its key's JSON form AND its predicate's identity. */
function union(captured: QueryKeys, current: QueryKeys): QueryKeys {
  const seen = new Map<string, Set<unknown>>();
  return [...captured, ...current].filter((entry) => {
    const { queryKey, predicate } = filtersOf(entry);
    const hash = JSON.stringify(queryKey);
    const predicates = seen.get(hash) ?? new Set<unknown>();
    if (predicates.has(predicate)) return false;
    predicates.add(predicate);
    seen.set(hash, predicates);
    return true;
  });
}

/**
 * The invalidation callbacks behind `useRepoMutation`. Settle invalidates the
 * UNION of the lists `onMutate` captured and the settle-time ones. Built through
 * `@/lib/started-mutation`, both are the ones in effect when the write started,
 * so the union dedupes to them and `notifySuccess` is that render's too: a write
 * refreshes the repo it started on however the view switches meanwhile. The union
 * is defense in depth: it would keep the starting repo refreshed if a settle ever
 * ran through other callbacks than the ones `onMutate` ran with. No path does:
 * react-query re-executes a mutation outside its original execution only after
 * hydration, and builds that one from mutation defaults, never a render's
 * options; nothing here hydrates. A mutation that settles without an `onMutate`
 * context uses the settle-time lists.
 */
export function repoMutationCallbacks<TData, TArgs>(
  queryClient: QueryClient,
  keys: RepoMutationKeys,
  refetchBeforeSuccess: boolean,
  notifySuccess: (data: TData, variables: TArgs) => void,
) {
  const run = (list: QueryKeys) =>
    Promise.all(
      list.map((entry) => queryClient.invalidateQueries(filtersOf(entry))),
    );
  const onMutate = (): RepoMutationKeys => keys;
  const settleKeys = (context: RepoMutationKeys | undefined) =>
    context
      ? {
          invalidate: union(context.invalidate, keys.invalidate),
          invalidateAfter: union(context.invalidateAfter, keys.invalidateAfter),
        }
      : keys;
  if (refetchBeforeSuccess)
    return {
      onMutate,
      onSuccess: async (
        data: TData,
        variables: TArgs,
        context: RepoMutationKeys | undefined,
      ) => {
        notifySuccess(data, variables);
        const captured = settleKeys(context);
        await run(captured.invalidate);
        void run(captured.invalidateAfter);
      },
    };
  return {
    onMutate,
    onSuccess: notifySuccess,
    onSettled: (
      _data: TData | undefined,
      _error: unknown,
      _variables: TArgs,
      context: RepoMutationKeys | undefined,
    ) => {
      const captured = settleKeys(context);
      void run(captured.invalidate);
      void run(captured.invalidateAfter);
    },
  };
}
