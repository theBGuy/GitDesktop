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

/**
 * The invalidation callbacks behind `useRepoMutation`. The key lists are captured
 * by `onMutate` and read back from its context at settle: a mounted observer
 * re-rendered with new props replaces its PENDING mutation's options, so keys read
 * from the settle-time closure would refresh whatever repo the view moved to. A
 * mutation restored from dehydrated state skips `onMutate`, so a missing context
 * falls back to the current lists. `notifySuccess` deliberately stays the latest
 * render's: retargeting that callback is what `useRepoMutation`'s `identity` is for.
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
  if (refetchBeforeSuccess)
    return {
      onMutate,
      onSuccess: async (
        data: TData,
        variables: TArgs,
        context: RepoMutationKeys | undefined,
      ) => {
        notifySuccess(data, variables);
        const captured = context ?? keys;
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
      const captured = context ?? keys;
      void run(captured.invalidate);
      void run(captured.invalidateAfter);
    },
  };
}
