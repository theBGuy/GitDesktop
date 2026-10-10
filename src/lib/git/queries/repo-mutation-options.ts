// Import-free on purpose: `scripts/repo-mutation-invalidation.test.mjs` loads this
// module directly under Node's type stripping, which resolves no path aliases and
// no extensionless specifiers. Type-only imports are erased, so they may stay.
import type { QueryClient } from "@tanstack/react-query";

type QueryKeys = readonly (readonly unknown[])[];

/** The key lists a `useRepoMutation` call invalidates, captured when it starts. */
export interface RepoMutationKeys {
  invalidate: QueryKeys;
  invalidateAfter: QueryKeys;
}

/** Both lists in order, each key once (compared by its JSON form). */
function union(captured: QueryKeys, current: QueryKeys): QueryKeys {
  const seen = new Set<string>();
  return [...captured, ...current].filter((queryKey) => {
    const hash = JSON.stringify(queryKey);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/**
 * The invalidation callbacks behind `useRepoMutation`. A mounted observer
 * re-rendered with new props replaces its PENDING mutation's options, so the
 * settle-time closure may describe another repo than the call started on.
 * Settle invalidates the UNION of the lists `onMutate` captured and the current
 * ones: a write that ran before a switch refreshes the repo it started on, and
 * one parked offline runs the retargeted `mutationFn` on reconnect, writing the
 * repo current then, which the current lists cover. If the view switches again
 * while that write runs, the repo it wrote is NOT refreshed. With no switch the
 * lists are equal and dedupe to one, at no extra cost. A mutation that settles
 * without an `onMutate` context uses the current lists. `notifySuccess` stays
 * the latest render's on purpose; a site whose write, refresh or callback must
 * stay on the render that started it opts into `useRepoMutation`'s `identity`.
 */
export function repoMutationCallbacks<TData, TArgs>(
  queryClient: QueryClient,
  keys: RepoMutationKeys,
  refetchBeforeSuccess: boolean,
  notifySuccess: (data: TData, variables: TArgs) => void,
) {
  const run = (list: QueryKeys) =>
    Promise.all(
      list.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
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
