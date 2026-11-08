import { useQuery } from "@tanstack/react-query";
import { REPO_SHELL_GC_TIME } from "@/lib/query-cache-times";
import {
  addUserWorktree,
  listUserWorktrees,
  lockWorktree,
  moveUserWorktree,
  repairWorktrees,
  unlockWorktree,
} from "../worktree";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";

export const worktreeKey = (repo: string) =>
  ["repo", repo, "user-worktrees"] as const;

/** Shared so an imperative `fetchQuery` on this key can't run under different
 *  options than the hook: a local `git worktree list` read, and react-query's
 *  default "online" mode parks the fetch whenever the OS reports no connection —
 *  a parked query is neither loading nor errored, so a consumer awaiting one
 *  waits forever. */
export function userWorktreesOptions(repo: string) {
  return {
    queryKey: worktreeKey(repo),
    queryFn: () => listUserWorktrees(repo),
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** How old a worktree list the hook (and the shell warm-up) may serve. Never in
 *  {@link userWorktreesOptions}: the switcher's imperative fetchQuery spreads the
 *  OPTIONS and must keep fetch-always semantics for its checkout-redirect guard. */
export const USER_WORKTREES_STALE_TIME = 30_000;

/** The repo's user-facing worktrees (session worktrees filtered out by the
 *  backend). `enabled` gates the fetch to the surface asking for it — the
 *  manager, the branch switcher and its cleanup dialog, the branch pickers;
 *  the repo header reads it ungated for the worktree subtitle. */
export function useUserWorktrees(repo: string, enabled = true) {
  return useQuery({
    ...userWorktreesOptions(repo),
    enabled: enabled && Boolean(repo),
    // The header observes this key on every open repo, so without a staleTime
    // the window-focus refetch re-spawns `git worktree list` on each Alt-Tab
    // back (mutations invalidate the key regardless). Every hook consumer shares
    // the bound and opens on data up to 30s old, so only external git changes
    // ride the window.
    staleTime: USER_WORKTREES_STALE_TIME,
  });
}

/** How many no-prune reads may run at once: a recents list paints a hint per
 *  remembered row and each read spawns `git worktree list`, so many such rows
 *  must not burst. */
const PEEK_READ_CONCURRENCY = 3;
let peekReadsRunning = 0;
const peekReadQueue: (() => void)[] = [];

/** Runs `read` in a free peek slot, first come first served. A finished read
 *  hands its slot straight to the oldest waiter, so the count never dips. Only a
 *  read that WAITED calls `signal`, once its slot arrives, and passes the slot on
 *  unrun if it aborted; a read started at once never touches it. */
async function withPeekReadSlot<T>(
  read: () => Promise<T>,
  signal?: () => AbortSignal | undefined,
): Promise<T> {
  let waited = false;
  if (peekReadsRunning < PEEK_READ_CONCURRENCY) peekReadsRunning++;
  else {
    waited = true;
    await new Promise<void>((resolve) => peekReadQueue.push(resolve));
  }
  try {
    const aborted = waited ? signal?.() : undefined;
    if (aborted?.aborted) {
      throw aborted.reason ?? new DOMException("Aborted", "AbortError");
    }
    return await read();
  } finally {
    const next = peekReadQueue.shift();
    if (next) next();
    else peekReadsRunning--;
  }
}

/** The same list read WITHOUT the backend's prune-first, for surfaces that only
 *  paint (a recents row hint): rendering must never unlink an unlocked worktree
 *  on a disconnected drive. Keyed under {@link worktreeKey} so every invalidation
 *  of the pruned list reaches it too; git still flags a deleted worktree
 *  prunable, and the backend filters it out of this read as well. While a read
 *  is queued for a slot: an explicit `cancelQueries`, or an invalidate's
 *  `cancelRefetch` over a query that already has data (a data-less fetch is
 *  deduped instead), skips its spawn when the slot arrives, while its observers
 *  merely unmounting fires no abort, so that alone never skips it. A read that
 *  waited reads the signal at slot arrival, so if its observers leave while it
 *  runs, react-query reverts the fetch and discards the result. A read started
 *  at once never reads the signal, so an unmount never discards its spawn. */
export function userWorktreesPeekOptions(repo: string) {
  return {
    queryKey: [...worktreeKey(repo), "no-prune"] as const,
    queryFn: (context?: { signal?: AbortSignal }) =>
      withPeekReadSlot(
        () => listUserWorktrees(repo, { prune: false }),
        () => context?.signal,
      ),
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** {@link userWorktreesPeekOptions} as a hook, under the same staleTime as
 *  {@link useUserWorktrees}. */
export function useUserWorktreesPeek(repo: string, enabled = true) {
  return useQuery({
    ...userWorktreesPeekOptions(repo),
    enabled: enabled && Boolean(repo),
    staleTime: USER_WORKTREES_STALE_TIME,
  });
}

/** Creates a user worktree. Invalidates the worktree list, branches and their
 *  divergence (a new branch may have been created). */
export function useAddUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      path: string;
      branch: string;
      newBranch: boolean;
      baseRef?: string;
    }) =>
      addUserWorktree(
        repo,
        args.path,
        args.branch,
        args.newBranch,
        args.baseRef,
      ),
    {
      invalidate: [
        worktreeKey(repo),
        repoKeys.branches(repo),
        ["repo", repo, "divergence"],
      ],
      // Local worktree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Renames (moves) a user worktree to a new path. */
export function useMoveUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { from: string; to: string }) =>
      moveUserWorktree(repo, args.from, args.to),
    {
      invalidate: [worktreeKey(repo)],
      // Local worktree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Locks a user worktree (optionally with a reason). */
export function useLockUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; reason?: string }) =>
      lockWorktree(repo, args.path, args.reason),
    {
      invalidate: [worktreeKey(repo)],
      // Local worktree write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Unlocks a user worktree. */
export function useUnlockUserWorktree(repo: string) {
  return useRepoMutation(repo, (path: string) => unlockWorktree(repo, path), {
    invalidate: [worktreeKey(repo)],
    // Local worktree write — never park it offline.
    networkMode: "always",
  });
}

/** Repairs worktree links after the repo folder was moved or renamed. */
export function useRepairWorktrees(repo: string) {
  return useRepoMutation(repo, (_: void) => repairWorktrees(repo), {
    invalidate: [worktreeKey(repo)],
    // Local worktree write — never park it offline.
    networkMode: "always",
  });
}
