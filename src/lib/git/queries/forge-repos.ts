import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api";
import type { ForgeProvider, ForgeSearchList, MyWorkSources } from "../types";
import { keepPreviousDataForRepo } from "./core";

/** Every repo the signed-in user can access (clone dialog). */
export function useGhRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["gh-repos"] as const,
    queryFn: api.ghListRepos,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Stable fallback for an unresolved {@link useForgeRepos} or
 *  {@link useForgeOwnedNamespaces} read, so a pending query doesn't hand its
 *  consumers a fresh array identity every render. */
export const EMPTY_NAMESPACES: readonly string[] = [];

/** The signed-in user's repositories on a provider (GitHub via gh, GitLab via
 *  glab), for the clone browser — and its `ownedNamespaces` feeds Explore's
 *  yours-first grouping and its detail pane's Fork gate. (The repo menu's Fork
 *  gate reads {@link useForgeOwnedNamespaces} instead.) The provider-neutral
 *  successor to {@link useGhRepos} on that surface. */
export function useForgeRepos(provider: ForgeProvider, enabled: boolean) {
  return useQuery({
    queryKey: ["forge-repos", provider] as const,
    queryFn: () => api.forgeListRepos(provider),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The namespaces the signed-in user owns on a provider, feeding the repo menu's
 *  Fork gate. Not {@link useForgeRepos}: its Bitbucket arm lists repositories
 *  from every workspace to reach the same set, and the gate needs no repository.
 *  The key carries no host/account axis, same as `["forge-repos", provider]` —
 *  one ambient account per provider today, and the self-managed-forge work owns
 *  adding it. */
export function useForgeOwnedNamespaces(
  provider: ForgeProvider,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["forge-owned-namespaces", provider] as const,
    queryFn: () => api.forgeOwnedNamespaces(provider),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The inbox's sources-probe key, exported so anything that changes a forge
 *  sign-in invalidates the probe without restating the literal. Its 5-minute
 *  window is otherwise how long a just-connected account stays invisible. */
export const MY_WORK_SOURCES_KEY = ["my-work-sources"] as const;

/** Every inbox page, as a key prefix: one entry per provider, each carrying a
 *  repo-paths axis after it. */
export const MY_WORK_PAGES_KEY = ["forge-my-work"] as const;

/** One provider's inbox page prefix — the sorted repo-paths axis follows it, so
 *  this is what an invalidation targets. */
export const myWorkPageKey = (provider: ForgeProvider) =>
  [...MY_WORK_PAGES_KEY, provider] as const;

/** The "no forge connected" answer cold-start test mode forces. */
const NO_MY_WORK_SOURCES: MyWorkSources = {
  github: false,
  gitlab: false,
  bitbucket: false,
};

// Shared definition so the hook and the app-open prefetch can't drift. Honors
// the cold-start test mode like `useForgeStatus`: the real probe reads gh's and
// glab's own configs, which in a cold-start run are still the developer's, so it
// would report connected accounts the test is meant to be without.
const myWorkSourcesOptions = () =>
  queryOptions({
    queryKey: MY_WORK_SOURCES_KEY,
    queryFn: COLD_START_NO_GH
      ? (): Promise<MyWorkSources> => Promise.resolve(NO_MY_WORK_SOURCES)
      : () => api.forgeMyWorkSources(),
    staleTime: 5 * 60_000,
    retry: false,
    // Local reads (CLI config files, keychain) must not park on react-query's
    // default "online" mode offline; the same holds for every `networkMode` here.
    networkMode: "always",
  });

/** Which providers the work inbox can fetch from, probed once when it opens so
 *  each provider's leg is asked for only when there is a sign-in behind it. */
export function useMyWorkSources(enabled: boolean) {
  return useQuery({ ...myWorkSourcesOptions(), enabled });
}

/** Warms that probe at app open. Local reads, but still two CLI configs plus a
 *  keyring lookup behind an IPC round trip, and on a cold open every leg waits on
 *  its answer — welcome → My work is a common enough path to pay for it once, up
 *  front. prefetchQuery honors the staleTime, so an already-warm entry costs
 *  nothing. */
export function usePrefetchMyWorkSources() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(myWorkSourcesOptions());
  }, [queryClient]);
}

/** The viewer's work items across every repository on a provider, for the
 *  cross-repo inbox. Resolves the whole `MyWorkPage` envelope, not a bare array,
 *  so consumers can read its `truncated` flag. The key carries no host/account
 *  axis, same as `["forge-repos", provider]` — one ambient account per provider
 *  today. `repoPaths` scopes providers that can't search account-wide; it is
 *  sorted into the key so caller order can't fork the cache. */
export function useForgeMyWork(
  provider: ForgeProvider,
  enabled: boolean,
  repoPaths?: string[],
) {
  const paths = repoPaths ? [...repoPaths].sort() : null;
  return useQuery({
    queryKey: [...myWorkPageKey(provider), paths] as const,
    queryFn: () => api.forgeMyWork(provider, paths ?? undefined),
    enabled,
    staleTime: 60_000,
    retry: false,
    // The repo-paths axis re-keys the Bitbucket leg whenever a recent is added or
    // removed (only `path` is in the key, and the owner probe never rewrites it),
    // so keep the outgoing page instead of dropping its rows out of the merge
    // until the new key lands.
    // Pinned on the provider segment (index 1) and no further: another forge's
    // page is a different inbox, while another path set is the same forge's.
    // CALLER CONTRACT: gate on `!isPlaceholderData` before counting a leg as
    // ANSWERED — placeholder rows belong to the previous key.
    placeholderData: keepPreviousDataForRepo(provider, 1),
  });
}

// ── Explore: search / browse / fork / star / README ──────────────────────────

/** What a provider supports and has built — the Explore surface's gate for the
 *  Fork/Star/README controls. Capabilities rarely change, so cache forever. */
export function useForgeProviderFeatures(provider: ForgeProvider) {
  return useQuery({
    queryKey: ["forge-provider-features", provider] as const,
    queryFn: () => api.forgeProviderFeatures(provider),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    networkMode: "always",
  });
}

/** Paged repository search on a provider (empty `query` = the Popular feed on
 *  GitHub/GitLab). Pages are 1-based; `getNextPageParam` walks `hasMore`. */
export function useForgeSearchRepos(
  provider: ForgeProvider,
  query: string,
  sort: "best" | "stars" | "updated",
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ["forge-search", provider, query, sort] as const,
    queryFn: ({ pageParam }) =>
      api.forgeSearchRepos(provider, query, sort, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage: ForgeSearchList, allPages) =>
      lastPage.hasMore ? allPages.length + 1 : undefined,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A repository's rendered README, lazily fetched when a repo is selected in the
 *  Explore detail pane. Null = no README (rendered as a quiet note, not an error). */
export function useRepoReadme(
  provider: ForgeProvider,
  owner: string,
  name: string,
  defaultBranch: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["forge-readme", provider, owner, name, defaultBranch] as const,
    queryFn: () => api.forgeRepoReadme(provider, owner, name, defaultBranch),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const starredKey = (provider: ForgeProvider, owner: string, name: string) =>
  ["forge-starred", provider, owner, name] as const;

/** Whether the viewer has starred the selected Explore repo — drives the
 *  Star/Unstar toggle's pressed state; only fetched when a repo is selected. */
export function useRepoStarred(
  provider: ForgeProvider,
  owner: string,
  name: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: starredKey(provider, owner, name),
    queryFn: () => api.forgeStarred(provider, owner, name),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Star / unstar a repo, optimistically flipping the starred-query cache with exact-key
 *  snapshot/rollback. The key is derived from the args at mutate time so a mid-flight
 *  repo switch never corrupts another repo's cache. */
export function useStarRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      provider: ForgeProvider;
      owner: string;
      name: string;
      star: boolean;
    }) => api.forgeStarRepo(args.provider, args.owner, args.name, args.star),
    onMutate: async (args) => {
      const key = starredKey(args.provider, args.owner, args.name);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<boolean>(key);
      queryClient.setQueryData<boolean>(key, args.star);
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: starredKey(args.provider, args.owner, args.name),
      }),
  });
}

/** Fork a repo by owner/name. Returns the `ForgeForkResult` (types/forge-repos.ts)
 *  so the caller can offer "Clone the fork" (and warn when it's not yet clonable).
 *  The new fork belongs in the provider's own-repos list; invalidating at the
 *  mutation level keeps that refresh alive after the calling pane unmounts. */
export function useForkRepoByName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      provider: ForgeProvider;
      owner: string;
      name: string;
    }) => api.forgeForkRepo(args.provider, args.owner, args.name),
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: ["forge-repos", args.provider],
      }),
  });
}
