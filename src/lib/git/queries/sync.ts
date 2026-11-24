import {
  type MutationCache,
  type Query,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { sameRepoRoot } from "@/features/repository/submodule-row";
import { isDirtyTreeRefusal } from "@/lib/error-summary";
import { shouldRetryQuery } from "@/lib/forge-backoff";
import { isWindows } from "@/lib/hotkeys/binding";
import { isAppError } from "@/lib/tauri/invoke";
import * as api from "../api";
import { peekRepoIdentity } from "../repo-identity";
import {
  invalidateKeyHealingStraddles,
  keepPreviousDataForKeyAxes,
  repoKeys,
  useRepoIdentity,
} from "./core";
import { useMutationCacheSnapshot, useRepoMutation } from "./internal";
import { isLocalRepoQuery } from "./local-query-filter";
import { prChecksRecheck } from "./pr-actions";
import { type PendingMutationEntry, pendingMutationEntries } from "./pr-writes";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  BRANCH_PUSH_ELSEWHERE_MESSAGE,
  BRANCH_PUSH_KEY,
  type BranchPushState,
  branchPushKey,
  type PushVars,
  pendingBranchPushesFor,
  pushesBranch,
  recheckRunsAfterPush,
} from "./push-writes";
import { readStraddlesSettle, straddleOutcome } from "./write-settle";

export {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  BRANCH_PUSH_ELSEWHERE_MESSAGE,
  type BranchPushState,
  branchPreparingLabel,
  branchPushHoldItemReason,
  branchPushHoldReason,
  branchPushLabel,
  nextPushLatch,
  type PushVars,
  recheckRunsAfterPush,
} from "./push-writes";

/** Fetch, pull and switch here are `localOnly`: they move HEAD, refs or the working
 *  tree but change no forge state, so forge reads keep their own clocks. Push,
 *  merge and rebase keep the whole-repo default. */
export function useFetchRemote(repo: string) {
  return useRepoMutation(repo, () => api.gitFetch(repo), { localOnly: true });
}

export function usePull(repo: string) {
  return useRepoMutation(
    repo,
    (mode: api.PullMode = "ffOnly") => api.gitPull(repo, mode),
    { localOnly: true },
  );
}

/** Stash → run → reapply variants of pull, merge, rebase, and switch, invalidating
 *  like their plain counterparts: each moves HEAD and rewrites the working tree,
 *  and the stash list changes too. */
export function usePullAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (mode: api.PullMode = "ffOnly") => api.gitPullAutostash(repo, mode),
    { localOnly: true },
  );
}

/** Filter family of the stash → merge → reapply compound's mutation key
 *  (`[family, "merge", repo]`, the merged-in branch riding the variables), so a
 *  remounted view can hold on a compound its own observer never saw. */
export const AUTOSTASH_WRITES_FAMILY = "git-autostash";

export function useMergeAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (branch: string) => api.gitMergeAutostash(repo, branch),
    {
      // Local git write — never park it offline.
      networkMode: "always",
      identity: [AUTOSTASH_WRITES_FAMILY, "merge", repo],
    },
  );
}

export function useRebaseAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (branch: string) => api.gitRebaseAutostash(repo, branch),
    {
      // Local git write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useRebaseOntoAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (args: { newBase: string; oldBase: string }) =>
      api.gitRebaseOntoAutostash(repo, args.newBase, args.oldBase),
    {
      // Local git write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useSwitchAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; remote: string | null; reapply: boolean }) =>
      api.gitSwitchAutostash(repo, args.name, args.remote, args.reapply),
    {
      // Local git write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** Phase B of a guarded rebase pull, plus its stash → run → reapply twin. Same
 *  local-only invalidation as the plain pull: both move HEAD and rewrite the
 *  working tree. */
export function usePullRebaseDecided(repo: string) {
  return useRepoMutation(
    repo,
    (decided: api.PullDecisionShas) => api.gitPullRebaseDecided(repo, decided),
    {
      // Local git write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

export function usePullRebaseDecidedAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (decided: api.PullDecisionShas) =>
      api.gitPullRebaseDecidedAutostash(repo, decided),
    {
      // Local git write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** Outcome of an "Update from upstream" run, for an honest toast. `branch` is
 *  the upstream default branch name (no `upstream/` prefix). */
export type UpstreamUpdateOutcome =
  | { kind: "up-to-date"; branch: string }
  | { kind: "fast-forwarded"; branch: string }
  | { kind: "merged"; branch: string }
  /** The final merge refused to overwrite uncommitted changes. Returned rather
   *  than thrown so the caller can offer stash-and-reapply: `ref` is the
   *  already-resolved `upstream/<branch>`, so the retry needs no re-fetch. */
  | { kind: "dirty-blocked"; branch: string; ref: string };

/**
 * Sync the current branch with a fork's `upstream` remote: fetch upstream
 * (a bare fetch never touches it), resolve upstream's default branch, then
 * bring the current branch up to date by merging `upstream/<default>`.
 *
 * Reuses the existing merge machinery — no second pipeline. The merge
 * fast-forwards silently when possible and creates a merge commit when
 * cleanly diverged; a conflicting merge rejects and leaves the repo in the
 * usual conflict state, so the conflict banner/editor takes over exactly like
 * a branch merge. The preview short-circuits the already-current case so we
 * report "already up to date" instead of a no-op merge. Never auto-pushes —
 * the Push affordance lights up on its own afterward.
 *
 * Default (whole-repo) invalidation, matching the merge flow, so branches,
 * status, and history all refresh.
 */
export function useUpdateFromUpstream(repo: string) {
  return useRepoMutation<void, UpstreamUpdateOutcome>(repo, async () => {
    await api.gitFetchRemote(repo, "upstream");
    const branch = await api.gitRemoteDefaultBranch(repo, "upstream");
    const ref = `upstream/${branch}`;
    // Strategy-free preview: only used to short-circuit the already-current
    // case; every other status runs the real merge below.
    const preview = await api.gitMergePreview(repo, ref, "none");
    if (preview.status === "up-to-date") {
      return { kind: "up-to-date", branch };
    }
    const fastForward = preview.status === "fast-forward";
    // Plain merge: ff-when-possible, merge commit otherwise. A conflict makes
    // gitMerge reject — the error propagates and the conflict UI takes over.
    // Only this final step can hit the dirty-tree refusal (fetch/resolve/preview
    // never touch the working tree), so it alone is caught and reported as an
    // outcome; every other failure still throws.
    try {
      await api.gitMerge(repo, ref, false, false, "none");
    } catch (e) {
      if (isDirtyTreeRefusal(e)) return { kind: "dirty-blocked", branch, ref };
      throw e;
    }
    return { kind: fastForward ? "fast-forwarded" : "merged", branch };
  });
}

const submodulesKey = (repo: string) => ["repo", repo, "submodules"] as const;

/** Whether a read of the submodule list is running now. */
export function submodulesReadRunning(queryClient: QueryClient, repo: string) {
  return (
    queryClient.getQueryState(submodulesKey(repo))?.fetchStatus === "fetching"
  );
}

/**
 * Starts a list read, or joins one already running when `joinRunning`. A read
 * running from before the caller's moment otherwise lands first and the read
 * starts after it: a refetch joins a read with no rows instead of restarting it.
 */
export function rereadSubmodules(
  queryClient: QueryClient,
  repo: string,
  joinRunning: boolean,
) {
  const queryKey = submodulesKey(repo);
  const reread = () =>
    void queryClient.refetchQueries(
      { queryKey, exact: true },
      { cancelRefetch: false },
    );
  const cache = queryClient.getQueryCache();
  const running = cache.find({ queryKey, exact: true });
  if (joinRunning || running?.state.fetchStatus !== "fetching") {
    reread();
    return;
  }
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== running) return;
    const outcome = straddleOutcome(event);
    if (outcome === null) return;
    unsubscribe();
    // Never from inside the notification that reports the landing.
    if (outcome === "landed") queueMicrotask(reread);
  });
}

export function useSubmodules(repo: string) {
  return useQuery({
    queryKey: submodulesKey(repo),
    queryFn: () => api.gitSubmodules(repo),
    staleTime: 30_000,
    // Re-read on every mount: a submodule set up or repaired outside the app must
    // show, and Tauri never refetches on window focus. Cached rows paint meanwhile.
    // The palette's resolver settles only on this mount re-read; the list also
    // re-reads on each open edge, since a reopen mid exit-animation never remounts.
    refetchOnMount: "always",
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}

/** Rows per page of the commit picker; the backend clamps at 200. */
export const SUBMODULE_COMMITS_PAGE = 50;

/** The commit picker's reads, children of `["repo", repo]` so the parent's
 *  settles cover them. `commits` keeps the path at index 3 and the rev at 5,
 *  which its placeholder axes name. Every pick read keeps staleTime 0: the
 *  picker masks verdicts cached before it opened until a re-read lands, and a
 *  read that skipped its mount re-read would hold one in loading. */
export const submodulePickKeys = {
  all: (repo: string, path: string) =>
    ["repo", repo, "submodule-pick", path] as const,
  refs: (repo: string, path: string) =>
    ["repo", repo, "submodule-pick", path, "refs"] as const,
  commits: (repo: string, path: string, rev: string, search: string | null) =>
    ["repo", repo, "submodule-pick", path, "commits", rev, search] as const,
  plan: (repo: string, path: string, sha: string) =>
    ["repo", repo, "submodule-pick", path, "plan", sha] as const,
};

export function useSubmoduleRefs(repo: string, path: string) {
  return useQuery({
    queryKey: submodulePickKeys.refs(repo, path),
    queryFn: () => api.gitSubmoduleRefs(repo, path),
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}

/** One ref's history inside the submodule, paged. Rows survive a new `search`
 *  only: another ref's rows under a new ref's label would mislead. */
export function useSubmoduleCommits(
  repo: string,
  path: string,
  rev: string | null,
  search: string | null,
) {
  return useInfiniteQuery({
    queryKey: submodulePickKeys.commits(repo, path, rev ?? "", search),
    queryFn: ({ pageParam }) =>
      api.gitSubmoduleCommits(
        repo,
        path,
        rev ?? "",
        pageParam,
        SUBMODULE_COMMITS_PAGE,
        search,
      ),
    enabled: rev !== null,
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore
        ? allPages.reduce((n, p) => n + p.commits.length, 0)
        : undefined,
    placeholderData: keepPreviousDataForKeyAxes(repo, [
      [3, path],
      [5, rev ?? ""],
    ]),
  });
}

/** What applying `sha` would do. No placeholder: a plan describes one commit. */
export function useSubmodulePickPlan(
  repo: string,
  path: string,
  sha: string | null,
) {
  return useQuery({
    queryKey: submodulePickKeys.plan(repo, path, sha ?? ""),
    queryFn: () => api.gitSubmodulePickPlan(repo, path, sha ?? ""),
    enabled: sha !== null,
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
    // A malformed or over-long id is refused the same way every time, and the
    // read costs a dozen git spawns.
    retry: (failureCount, err) =>
      !(isAppError(err) && err.kind === "invalidArgument") &&
      shouldRetryQuery(failureCount, err),
  });
}

/** The setter's mutation key: what the picker's pending reads match on. */
const submoduleSetCommitKey = (repo: string, path: string) =>
  ["submodule-set-commit", repo, path] as const;

/** Every LOCAL cached query rooted at the submodule's own folder, whichever
 *  spelling opened it: a checkout or fetch inside it changes no forge read. */
function submoduleSubtree(repo: string, path: string) {
  const root = `${repo.replace(/[/\\]+$/, "")}/${path}`;
  return {
    queryKey: ["repo"],
    predicate: (q: Query) =>
      typeof q.queryKey[1] === "string" &&
      sameRepoRoot(q.queryKey[1], root, isWindows) &&
      isLocalRepoQuery(q),
  };
}

/**
 * A submodule write's own settle: waits for the submodule's reads that straddle
 * it ({@link readStraddlesSettle}) to land (its folder's and its picker's, keyed
 * under the parent), so the invalidations after it re-read them instead of
 * joining a pre-write read. No other parent read holds the write: those keep
 * `localOnly`'s plain invalidation. A read that straddles the final
 * invalidation (one whose observer left during the wait included) is healed
 * after it lands, since that invalidation alone can't replace it.
 */
async function submoduleWriteSettled(
  queryClient: QueryClient,
  repo: string,
  path: string,
): Promise<void> {
  const subRepo = submoduleSubtree(repo, path);
  const cache = queryClient.getQueryCache();
  const scoped = () => [
    ...cache.findAll(subRepo),
    ...cache.findAll({ queryKey: submodulePickKeys.all(repo, path) }),
  ];
  const waiting = new Set(scoped().filter(readStraddlesSettle));
  if (waiting.size > 0)
    await new Promise<void>((resolve) => {
      const unsubscribe = cache.subscribe((event) => {
        if (!waiting.has(event.query) || straddleOutcome(event) === null)
          return;
        waiting.delete(event.query);
        if (waiting.size > 0) return;
        unsubscribe();
        resolve();
      });
    });
  const straddling = new Set(scoped().filter(readStraddlesSettle));
  for (const query of straddling)
    void invalidateKeyHealingStraddles(queryClient, query.queryKey);
  void queryClient.invalidateQueries({
    ...subRepo,
    predicate: (q) => !straddling.has(q) && subRepo.predicate(q),
  });
}

/** Checks a commit out inside the submodule, then stages it. Keyed per repo and
 *  path so a pick holds only its own row's picker; callers await `mutateAsync`
 *  and read pending through {@link useSubmodulePickPending}. */
export function useSetSubmoduleCommit(repo: string, path: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    async (args: { sha: string; expectedIndexSha: string }) => {
      try {
        return await api.gitSubmoduleSetCommit(
          repo,
          path,
          args.sha,
          args.expectedIndexSha,
        );
      } finally {
        await submoduleWriteSettled(queryClient, repo, path);
      }
    },
    {
      // Local git write — never park it offline.
      networkMode: "always",
      localOnly: true,
      identity: submoduleSetCommitKey(repo, path),
    },
  );
}

/** The fetch's mutation key: what the picker's fetch-pending reads match on. */
const submoduleFetchKey = (repo: string, path: string) =>
  ["submodule-fetch", repo, path] as const;

/** Fetches inside the submodule. A network run: it parks offline, so its
 *  controls hold on `useOnline` instead. Callers await `mutateAsync` and read
 *  pending through {@link useSubmoduleFetchPending}. */
export function useFetchSubmodule(repo: string, path: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    async (args: { unshallow: boolean }) => {
      try {
        return await api.gitSubmoduleFetch(repo, path, args.unshallow);
      } finally {
        await submoduleWriteSettled(queryClient, repo, path);
      }
    },
    { localOnly: true, identity: submoduleFetchKey(repo, path) },
  );
}

/** The running fetch for this row, from the mutation cache, so a remounted
 *  picker still sees it: "full" when one completes history, else "fetch", or
 *  null. Notifies a macrotask late; handlers ask {@link isSubmoduleFetchPending}. */
export function useSubmoduleFetchPending(
  repo: string,
  path: string,
): "fetch" | "full" | null {
  const select = useCallback(
    (cache: MutationCache) => {
      const running = cache.findAll({
        mutationKey: submoduleFetchKey(repo, path),
        status: "pending",
      });
      if (running.length === 0) return null;
      return running.some((m) => {
        const v = m.state.variables;
        return (
          typeof v === "object" &&
          v !== null &&
          "unshallow" in v &&
          v.unshallow === true
        );
      })
        ? "full"
        : "fetch";
    },
    [repo, path],
  );
  return useMutationCacheSnapshot(select, null);
}

/** Event-time twin of {@link useSubmoduleFetchPending}. */
export function isSubmoduleFetchPending(
  queryClient: QueryClient,
  repo: string,
  path: string,
): boolean {
  return (
    queryClient.getMutationCache().findAll({
      mutationKey: submoduleFetchKey(repo, path),
      status: "pending",
    }).length > 0
  );
}

/** Whether a pick for this row is in flight, from the mutation cache, so a
 *  reopen or another mount still sees it. Notifies a macrotask late: handlers
 *  that must not act mid-pick ask {@link isSubmodulePickPending} instead. */
export function useSubmodulePickPending(repo: string, path: string): boolean {
  const select = useCallback(
    (cache: MutationCache) =>
      cache.findAll({
        mutationKey: submoduleSetCommitKey(repo, path),
        status: "pending",
      }).length > 0,
    [repo, path],
  );
  return useMutationCacheSnapshot(select, false);
}

/** Event-time twin of {@link useSubmodulePickPending}. */
export function isSubmodulePickPending(
  queryClient: QueryClient,
  repo: string,
  path: string,
): boolean {
  return (
    queryClient.getMutationCache().findAll({
      mutationKey: submoduleSetCommitKey(repo, path),
      status: "pending",
    }).length > 0
  );
}

/** One side of a submodule row in Changes. The key MUST stay a child of
 *  {@link repoKeys.status}: every staging-class mutation invalidates that prefix.
 *  It polls on its own, since a commit inside the submodule leaves the parent's
 *  status record unchanged; an errored read stops polling until a retry.
 *  `origPath` is a staged rename's old path (the row's `origPath`). */
export function useSubmoduleChanges(
  repo: string,
  path: string,
  staged: boolean,
  origPath?: string,
) {
  return useQuery({
    queryKey: [
      ...repoKeys.status(repo),
      "submodule-changes",
      path,
      staged,
      origPath ?? null,
    ] as const,
    queryFn: () => api.gitSubmoduleChanges(repo, path, staged, origPath),
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
    refetchInterval: (query) => (query.state.status === "error" ? false : 5000),
    refetchIntervalInBackground: false,
  });
}

/** Init + update submodules per each one's `update` setting (by default, a
 *  checkout of the recorded commit); omit `path` for all, set `remote` to move
 *  them to the tip of the branch they track instead. */
export function useUpdateSubmodule(repo: string) {
  return useRepoMutation(repo, (args: { path?: string; remote?: boolean }) =>
    api.gitSubmoduleUpdate(repo, args.path, args.remote ?? false),
  );
}

export function useAddSubmodule(repo: string) {
  return useRepoMutation(
    repo,
    (args: { url: string; path: string | null; branch: string | null }) =>
      api.gitSubmoduleAdd(repo, args.url, args.path, args.branch),
  );
}

/** Resolves to the removal's outcome — callers must read it: a `refusedDirty`
 *  result mutated nothing and is not an error. */
export function useRemoveSubmodule(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; force: boolean; deleteModuleData: boolean }) =>
      api.gitSubmoduleRemove(
        repo,
        args.path,
        args.force,
        args.deleteModuleData,
      ),
    {
      // Local submodule write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useSetSubmoduleUrl(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; url: string }) =>
      api.gitSubmoduleSetUrl(repo, args.path, args.url),
    {
      // Local submodule write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useSetSubmoduleBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; branch: string | null }) =>
      api.gitSubmoduleSetBranch(repo, args.path, args.branch),
    {
      // Local submodule write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Keyed per repo with the branch in the variables: {@link usePendingBranchPushes}
 *  reads every push in flight, whichever mount fired it. The key also carries the
 *  repository identity once resolved, so a sibling worktree's
 *  {@link refuseWhileBranchPushes} sees the push. The client-only vars (`source`,
 *  `startedOn`) stay on the client; the backend gets exactly the push's own
 *  arguments. */
export function usePush(repo: string) {
  const queryClient = useQueryClient();
  const identity = useRepoIdentity(repo).data;
  return useRepoMutation(
    repo,
    (args: PushVars) =>
      api.gitPush(
        repo,
        args.setUpstream,
        args.force ?? false,
        args.branch,
        args.remote,
        args.remoteBranch,
      ),
    {
      identity: branchPushKey(repo, identity),
      // The whole-repo default: a push moves the pushed branch's PR head, checks,
      // mergeability and runs, and only active observers refetch. The push names
      // no PR or lens, so the recheck re-reads every PR's details in both lenses:
      // only on-screen PR views and active list CI maps refetch.
      onSuccess: () =>
        recheckRunsAfterPush(queryClient, repo, [
          ...prChecksRecheck(repo, "origin"),
          ...prChecksRecheck(repo, "upstream"),
        ]),
    },
  );
}

const NO_PENDING_BRANCH_PUSHES: BranchPushState[] = [];

/** The pushes of `repo` in flight, read from the mutation cache, so a remount or
 *  a switch back still sees a push an earlier mount started. */
export function usePendingBranchPushes(repo: string): BranchPushState[] {
  const select = useCallback(
    (cache: MutationCache) =>
      pendingBranchPushesFor(
        pendingMutationEntries(
          cache.findAll({
            mutationKey: branchPushKey(repo),
            status: "pending",
          }),
        ),
        repo,
      ),
    [repo],
  );
  return useMutationCacheSnapshot(select, NO_PENDING_BRANCH_PUSHES);
}

const NO_PENDING_PUSH_IDS: number[] = [];

const selectPendingPushIds = (cache: MutationCache) =>
  cache
    .findAll({ mutationKey: BRANCH_PUSH_KEY, status: "pending" })
    .map((m) => m.mutationId);

/** The mutation ids of every branch push in flight, in ANY repo: what a reader
 *  that remembers pushes across a repo switch prunes against. */
export function usePendingBranchPushIds(): number[] {
  return useMutationCacheSnapshot(selectPendingPushIds, NO_PENDING_PUSH_IDS);
}

/** Fire-time twin of {@link usePendingBranchPushes}: whether `repo` has a push in
 *  flight right now, for a handler a stale render could otherwise let through. */
function isBranchPushActive(queryClient: QueryClient, repo: string): boolean {
  return (
    queryClient
      .getMutationCache()
      .findAll({ mutationKey: branchPushKey(repo), status: "pending" }).length >
    0
  );
}

/** The fire-time refusal every network-lock route shares: true (and says why)
 *  while `repo` has a push in flight, which the route would queue behind. */
export function refuseWhilePushRuns(
  queryClient: QueryClient,
  repo: string,
): boolean {
  if (!isBranchPushActive(queryClient, repo)) return false;
  toast.info(BRANCH_PUSH_ACTIVE_MESSAGE);
  return true;
}

/** A branch push filed before its checkout's identity resolved keys on the path
 *  alone, which no sibling's check could match, so its identity is peeked from
 *  the memo by that path at check time. A key that already names an identity, or
 *  a path the memo never learned, is left as it is. */
function withLearnedIdentities(
  entries: PendingMutationEntry[],
): PendingMutationEntry[] {
  return entries.map((e) => {
    const [prefix, path, keyIdentity] = e.key ?? [];
    if (prefix !== BRANCH_PUSH_KEY[0] || typeof path !== "string") return e;
    if (keyIdentity !== undefined) return e;
    const learned = peekRepoIdentity(path);
    return learned === undefined
      ? e
      : { ...e, key: branchPushKey(path, learned) };
  });
}

/** The fire-time refusal for a route that moves or removes `branch`'s ref: true
 *  (and says why) while a push in this checkout, or in another worktree of the
 *  same repository, is sending it. `currentName` is this checkout's HEAD branch
 *  (null when unknown). Synchronous: identities are peeked, never resolved, so a
 *  checker whose own identity is unresolved matches this checkout's own pushes
 *  only, while a push filed before its identity resolved is matched once the memo
 *  holds it ({@link withLearnedIdentities}). `alsoHeld` adds a hold
 *  the caller tracks itself; `message` overrides the toast, and
 *  `elsewhereMessage` overrides it when only another worktree's push holds. */
export function refuseWhileBranchPushes(
  queryClient: QueryClient,
  repo: string,
  branch: string,
  currentName: string | null,
  opts: {
    message?: string;
    elsewhereMessage?: string;
    alsoHeld?: boolean;
  } = {},
): boolean {
  const pushes = pendingBranchPushesFor(
    withLearnedIdentities(
      pendingMutationEntries(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: BRANCH_PUSH_KEY, status: "pending" }),
      ),
    ),
    repo,
    peekRepoIdentity(repo),
  );
  const holding = pushes.filter((p) => pushesBranch([p], branch, currentName));
  if (opts.alsoHeld !== true && holding.length === 0) return false;
  const onlyElsewhere =
    opts.alsoHeld !== true && holding.every((p) => p.foreign);
  toast.info(
    onlyElsewhere
      ? (opts.elsewhereMessage ?? opts.message ?? BRANCH_PUSH_ELSEWHERE_MESSAGE)
      : (opts.message ?? BRANCH_PUSH_ACTIVE_MESSAGE),
  );
  return true;
}

/** {@link refuseWhileBranchPushes} for a route that moves the current branch
 *  under a `headBranchPin`: `"HEAD"` (detached) moves no branch ref and is never
 *  held; `null` (name unknown) holds on this checkout's HEAD pushes only, since
 *  git refuses a branch named `HEAD` and so no named push can match it. */
export function refuseWhilePinnedBranchPushes(
  queryClient: QueryClient,
  repo: string,
  pin: string | null,
): boolean {
  if (pin === "HEAD") return false;
  if (pin === null)
    return refuseWhileBranchPushes(queryClient, repo, "HEAD", null);
  return refuseWhileBranchPushes(queryClient, repo, pin, pin);
}

export function useUndoCommit(repo: string) {
  return useRepoMutation(
    repo,
    (args: { expectedHead: string; expectedBranch: string }) =>
      api.gitUndoCommit(repo, args.expectedHead, args.expectedBranch),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}
