// Helpers shared by more than one query module. Deliberately NOT re-exported from
// the barrel: they are implementation details of this package, and exporting them
// would widen its public surface.

import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { repoKeys } from "./core";

/**
 * The keys a working-tree write invalidates: repo status, every working-tree file diff,
 * and only the MUTABLE file-at-rev slices — `"worktree"` and the index `":0"`, which
 * staging rewrites — all prefix-matched. Staging-class mutations (stage/unstage/discard/
 * apply) pass this ALONE so they don't mark the heavy history/branches/Insights/SBOM
 * queries stale; {@link useCommit} passes it as its AWAITED set and defers what HEAD
 * moves to {@link commitAftermathKeys}. Committed-rev reads are immutable under staging.
 */
export const workingTreeKeys = (repo: string) =>
  [
    repoKeys.status(repo),
    ["repo", repo, "diff"],
    ["repo", repo, "file-b64", "worktree"],
    ["repo", repo, "file-b64", ":0"],
  ] as const;

/**
 * The shared skeleton behind the optimistic-cache mutations in prs.ts and pr-actions.ts:
 * cancel in-flight fetches on the target key, snapshot it, apply an optimistic
 * `setQueryData` patch, roll the snapshot back on error, reconcile on settle. Wrappers
 * differ only in `keyFor(args)` (the key is derived from the args AT MUTATE TIME, so a
 * mid-flight repo/number/sha switch can never corrupt another key's cache), `patch`, and
 * `reconcile`. `TCache` is the shape stored at the key; the rollback context carries the
 * exact key + prior value.
 */
export function useOptimisticCacheMutation<TArgs, TData, TCache>(
  mutationFn: (args: TArgs) => Promise<TData>,
  keyFor: (args: TArgs) => QueryKey,
  patch: (prev: TCache | undefined, args: TArgs) => TCache | undefined,
  reconcile: (
    queryClient: ReturnType<typeof useQueryClient>,
    args: TArgs,
  ) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (args: TArgs) => {
      const key = keyFor(args);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<TCache>(key);
      queryClient.setQueryData<TCache>(key, (data) => patch(data, args));
      return { prev, key };
    },
    onError: (
      _e: unknown,
      _args: TArgs,
      ctx: { prev: TCache | undefined; key: QueryKey } | undefined,
    ) => {
      // Explicit guard: in TanStack Query v5 `setQueryData(key, undefined)` BAILS
      // without updating (it does not remove the entry), so an unguarded call would be
      // a silent no-op, not a rollback. A create-from-nothing patch would need
      // removeQueries here instead.
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d: TData | undefined, _e: unknown, args: TArgs) =>
      reconcile(queryClient, args),
  });
}

/** EVERY cached board read in one repo — every board, every lens of each. The
 *  scope a board write settles against: a write changes what an item IS, which no
 *  board's filter makes untrue. */
export const projectItemsRepoKey = (repo: string) =>
  ["repo", repo, "project-items"] as const;

/** How many of a repo's own board writes are between their request and their
 *  answer, PER REPO — keyed by the same `repo` string the invalidation targets,
 *  because that is the scope the deferral decides. One shared number would let a
 *  write in one repository defer another's settle-refetch, and since each settle
 *  invalidates only its own repo, the deferred one's stale mark would never be
 *  flushed: a board left stale after its own successful write.
 *
 *  Module-scoped rather than a `mutationKey` + `isMutating` count because a
 *  mutation is still `pending` while its own `onSettled` runs (query-core 5.102.8
 *  dispatches `success` AFTER the callbacks), so an `isMutating` reading would
 *  have to subtract a self that only SOME callers of
 *  {@link invalidateProjectBoards} contribute — the issue-side callers are not in
 *  the family. A count the writes hold across their own request has one meaning
 *  for every caller: "someone else is mid-write on THIS repo". */
export const pendingBoardWrites = new Map<string, number>();

/**
 * Mark every board this repo has opened stale, for any write that changes what a
 * board card SHOWS — its title, state glyph, assignees, membership, or the field
 * value that decides its column. Partial key on purpose: the caller is editing an
 * issue/PR and has no board id in scope, and the family is one entry per board
 * actually visited.
 *
 * CANCEL before invalidate. A board read already in flight when the mutation
 * settles would otherwise resolve afterwards and stamp itself fresh —
 * `successState` clears `isInvalidated` — erasing the invalidation and serving
 * pre-mutation cards for the rest of the staleTime window. There is no second
 * chance: `invalidateQueries` refetches ACTIVE queries only, and a board behind
 * the Projects tab's Activity gate is not active. (The repo's cancel-then-
 * invalidate class, same as the item-field-values chains in projects.ts.)
 *
 * Invalidate-only past that: no forced refetch, so the Activity gate still owns
 * WHEN a hidden board re-reads.
 *
 * The key stops SHORT of the board id and its lens, so every saved view's cache
 * of every board goes stale together — a write changes what the item is, which no
 * filter makes untrue.
 *
 * LAST WRITE REFETCHES, with one named gap. While another board write on THIS repo
 * is still in flight this marks stale WITHOUT fetching (`refetchType: "none"`),
 * because the answer a refetch would bring back has not seen that sibling yet:
 * server truth fetched mid-flight puts an archived card back on the board, or a
 * moved one in its old column, until the sibling's own settle re-reads. Deferring
 * costs nothing while the last write out is one of THESE —
 * {@link trackBoardWrite} decrements before any `onSettled` runs, so it sees a
 * clear count and performs the one real refetch. The gap: when the last one out
 * settles through {@link markProjectBoardsStale} instead, nothing refetches at all.
 * That is the point of that mode — its own patch is already on screen, and the
 * boards stay marked stale for the next natural read. A lone write here sees zero
 * and refetches immediately, exactly as before.
 *
 * Read PER REPO, matching the key this invalidates: a write pending in another
 * repository must not defer this one, whose stale mark that write's own settle
 * would never come back to flush.
 *
 * The cancel above stays unconditional either way: a read already in flight holds
 * pre-write values whether or not this call is the one that re-reads.
 *
 * The refetching branch RESTARTS what it cancelled — `refetchQueries` under the
 * default active type re-runs every cancelled read that still has an enabled
 * observer, dataless ones included. The deferred branch does not, and relies on the
 * last write out to do it; when that last write settles through
 * {@link markProjectBoardsStale} instead, its own repo-wide rescue is what covers
 * the reads this branch left with nothing.
 */
export function invalidateProjectBoards(
  queryClient: QueryClient,
  repo: string,
): void {
  const queryKey = projectItemsRepoKey(repo);
  const deferred = (pendingBoardWrites.get(repo) ?? 0) > 0;
  void queryClient
    .cancelQueries({ queryKey })
    .then(() =>
      queryClient.invalidateQueries(
        deferred ? { queryKey, refetchType: "none" } : { queryKey },
      ),
    );
}

/**
 * A mutation that invalidates repo queries on completion. Defaults to the whole repo
 * subtree (correct but broad); pass `opts.invalidate` to narrow it for hot mutations
 * (each key is prefix-matched). Reserve the whole-subtree default for ops that touch
 * history or branch topology (checkout/pull/reset/merge); a hot history op (commit)
 * splits instead — narrow awaited `invalidate` plus deferred `opts.invalidateAfter`.
 */
export function useRepoMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  opts: {
    /** Query keys to invalidate on completion (prefix-matched). Defaults to the
     *  whole repo subtree. */
    invalidate?: readonly (readonly unknown[])[];
    /** Keys invalidated fire-and-forget on top of `invalidate` — NEVER awaited, so
     *  callers can refresh heavy/slow families without holding the mutation's
     *  isPending. Sequenced after the awaited set only under `refetchBeforeSuccess`;
     *  otherwise both fire together in `onSettled`. */
    invalidateAfter?: readonly (readonly unknown[])[];
    /** Invalidate (and AWAIT) in onSuccess instead of fire-and-forget in
     *  onSettled, so the refetch lands BEFORE the caller's own onSuccess —
     *  commit uses this so the emptied list, cleared draft, and toast appear
     *  together. (As a result it does NOT invalidate on error.) */
    refetchBeforeSuccess?: boolean;
    /** Runs on success before any invalidation fires (react-query awaits
     *  `onSuccess` ahead of `onSettled`), so store state can be fixed up while the
     *  cache still describes the pre-mutation world. Must be synchronous — an
     *  async callback's rejection escapes the containment; a synchronous throw
     *  is contained and logged, and the invalidation still runs. */
    onSuccess?: (data: TData, variables: TArgs) => void;
    /**
     * Identity axes this mutation's `mutationFn` and callbacks close over (repo,
     * lens, …). Opt in wherever a mid-flight change of those would misdirect the
     * work: a MOUNTED observer re-rendered with new props retargets its PENDING
     * mutation's whole options object, so the call lands — and any cache patch
     * writes — under the new identity. A changed mutation-key hash detaches the
     * pending mutation instead, freezing its options; `mutateAsync` still settles,
     * but the observer's own `isPending`/`data` go idle at the switch, so only
     * award this to sites whose callers await the promise.
     */
    identity?: readonly unknown[];
  } = {},
) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all(
      (opts.invalidate ?? [repoKeys.all(repo)]).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  const invalidateAfter = () =>
    Promise.all(
      (opts.invalidateAfter ?? []).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  // A caller's hook must not take the mutation down with it: a throw here would
  // otherwise skip the invalidation, or report a succeeded mutation as failed.
  const notifySuccess = (data: TData, variables: TArgs) => {
    try {
      opts.onSuccess?.(data, variables);
    } catch (e) {
      console.error("[queries] mutation onSuccess failed", e);
    }
  };
  return useMutation({
    mutationFn,
    ...(opts.identity ? { mutationKey: opts.identity } : {}),
    ...(opts.refetchBeforeSuccess
      ? {
          onSuccess: async (data: TData, variables: TArgs) => {
            notifySuccess(data, variables);
            await invalidate();
            void invalidateAfter();
          },
        }
      : {
          onSuccess: notifySuccess,
          onSettled: () => {
            void invalidate();
            void invalidateAfter();
          },
        }),
  });
}

export const repoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings"] as const;
