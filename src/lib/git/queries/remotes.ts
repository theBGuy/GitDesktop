import {
  type MutationCache,
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import {
  REPO_SHELL_GC_TIME,
  REPO_SHELL_WARM_STALE_MS,
} from "@/lib/query-cache-times";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api";
import { peekRepoIdentity } from "../repo-identity";
import { useRepoIdentity } from "./core";
import { useMutationCacheSnapshot, useRepoMutation } from "./internal";
import {
  type PendingPublish,
  PUBLISH_REPO_KEY,
  pendingMutationEntries,
  pendingPublishesFor,
  publishRepoKey,
} from "./pr-writes";
import { recheckRunsAfterPush } from "./push-writes";

export function remotesOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "remotes"] as const,
    queryFn: () => api.gitRemotes(repo),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always" as const,
    staleTime: REPO_SHELL_WARM_STALE_MS,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** How often a remotes read that failed with nothing loaded retries: it is
 *  otherwise re-read only by a repo write or a window focus, and the sync bar
 *  and the forge panel hold until it answers. */
const REMOTES_FAILED_RETRY_MS = 10_000;

/** The error-only poll rides the hook, never `remotesOptions`: the repo-shell
 *  warm-up spreads those, and a repo nobody observes must not keep polling. */
export function useRemotes(repo: string) {
  return useQuery({
    ...remotesOptions(repo),
    refetchInterval: (query) =>
      query.state.data === undefined && query.state.errorUpdateCount > 0
        ? REMOTES_FAILED_RETRY_MS
        : false,
    refetchIntervalInBackground: false,
  });
}

/** Publishing pushes the repo's commits to the new remote, so it arms the delayed
 *  run recheck like a push. */
export function usePublishRepo(repo: string) {
  const queryClient = useQueryClient();
  const identity = useRepoIdentity(repo).data;
  return useRepoMutation(
    repo,
    async (args: {
      provider: "github" | "gitlab" | "bitbucket";
      name: string;
      isPrivate: boolean;
      description: string;
      homepage: string;
      topics: string[];
      /** Bitbucket only — the workspace the repo is created under. */
      workspace?: string;
    }) => {
      try {
        return await api.forgePublishRepo(
          args.provider,
          repo,
          args.name,
          args.isPrivate,
          args.description,
          args.homepage,
          args.topics,
          args.workspace,
        );
      } finally {
        // Every worktree shares origin, and a publish can fail after the remote
        // is already added (before its push), so on either outcome a sibling's
        // cached remotes (and its Publish arm) drop their no-origin answer. This
        // repo's own remotes ride useRepoMutation's settle-time subtree pass.
        void queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === "repo" &&
            q.queryKey[1] !== repo &&
            q.queryKey[2] === "remotes",
        });
      }
    },
    {
      // Pinned: the publish and its repo-subtree invalidation close over `repo`, and
      // the dialog survives a repo switch — without the key the newly-live repo's
      // controls would read the pending publish as busy. The identity element lets
      // every worktree of the repository see the publish.
      identity: publishRepoKey(repo, identity),
      onSuccess: () => recheckRunsAfterPush(queryClient, repo),
    },
  );
}

const NO_PENDING_PUBLISHES: PendingPublish[] = [];

/** The publishes of the repository in flight, matched by checkout path or repo
 *  identity, read from the mutation cache rather than the publish's observer: the
 *  identity pin idles the observer at a repo switch, and every Publish host
 *  (hidden tabs and sibling worktrees included) must read the same answer. */
export function usePendingPublishes(repo: string): PendingPublish[] {
  const identity = useRepoIdentity(repo).data;
  const select = useCallback(
    (cache: MutationCache) =>
      pendingPublishesFor(
        pendingMutationEntries(
          cache.findAll({ mutationKey: PUBLISH_REPO_KEY, status: "pending" }),
        ),
        repo,
        identity,
      ),
    [repo, identity],
  );
  return useMutationCacheSnapshot(select, NO_PENDING_PUBLISHES);
}

/** Fire-time twin of {@link usePendingPublishes}: the repository's first publish
 *  in flight right now, for a press a stale render could otherwise let through.
 *  `identity` defaults to the one this session already resolved for `repo`;
 *  unresolved, it matches by checkout path alone. */
export function activePublishOf(
  queryClient: QueryClient,
  repo: string,
  identity?: string,
): PendingPublish | null {
  return (
    pendingPublishesFor(
      pendingMutationEntries(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PUBLISH_REPO_KEY, status: "pending" }),
      ),
      repo,
      identity ?? peekRepoIdentity(repo),
    )[0] ?? null
  );
}

/** Whether the repository has a publish in flight; see {@link activePublishOf}. */
export function isPublishActive(
  queryClient: QueryClient,
  repo: string,
  identity?: string,
): boolean {
  return activePublishOf(queryClient, repo, identity) !== null;
}

/** Which providers this machine can publish to — drives the publish buttons for
 *  a repo with no hosted remote yet. Honors the cold-start test mode like
 *  `useForgeStatus` (the probe hits the real CLIs otherwise). */
export function publishTargetsOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "publish-targets"] as const,
    queryFn: COLD_START_NO_GH
      ? () =>
          Promise.resolve({ github: false, gitlab: false, bitbucket: false })
      : () => api.forgePublishTargets(repo),
    staleTime: 60_000,
    retry: false,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** The publish-button providers; the read is {@link publishTargetsOptions}. */
export function usePublishTargets(repo: string, enabled: boolean) {
  return useQuery({ ...publishTargetsOptions(repo), enabled });
}

export function useRemoteUrl(repo: string, name: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "remote-url", name] as const,
    queryFn: () => api.gitRemoteUrl(repo, name),
    enabled,
    // Always-visible consumers (RepoLensSwitcher + CreatePrDialog via useRemoteSlug), so
    // it needs a staleTime at all — without one every window focus re-spawned
    // `git remote get-url` twice. Not Infinity: the Rust cache's 5s TTL exists so an
    // external `git remote set-url` is picked up promptly, and in-app edits invalidate
    // this key eagerly (useSetRemoteUrl).
    staleTime: 30_000,
    networkMode: "always",
  });
}

export function useSetRemoteUrl(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; url: string }) =>
      api.gitRemoteSetUrl(repo, args.name, args.url),
    {
      // Local git-config write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Adds a remote (e.g. `upstream` on a fork cloned without one). The default broad
 *  invalidation prefix-covers `remotes`/`remote-url`, so `useLensGate` re-reads and the
 *  fork/upstream UI lights up live. */
export function useAddRemote(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; url: string }) =>
      api.gitRemoteAdd(repo, args.name, args.url),
    {
      // Local git-config write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Removes a remote. The default broad invalidation prefix-covers
 *  `remotes`/`remote-url`, so `useLensGate` re-reads and every fork-identity surface
 *  collapses live. */
export function useRemoveRemote(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string }) => api.gitRemoteRemove(repo, args.name),
    {
      // Local git-config write — never park it offline.
      networkMode: "always",
    },
  );
}
