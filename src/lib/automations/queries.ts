import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import { useMutation } from "@/lib/started-mutation";
import { loadAutomations, saveAutomations, saveRepoAutomations } from "./store";
import type { AutomationsConfigV2, RepoOverride } from "./types";

const automationsKey = ["automations"] as const;
/** Both saves below write {@link automationsKey}, so they share one key. */
const saveAutomationsKey = ["save", ...automationsKey] as const;

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: loadAutomations,
    // Local plugin-store read: the default online mode PARKS it while the OS
    // reports no connection, and every automations surface wedges.
    networkMode: "always",
  });
}

/** `config` with one repo's override folded in the way `saveRepoAutomations`
 *  folds it on disk: keyed by identity, the raw-path twin dropped, and an
 *  override holding no cells deleted. */
function withRepoOverride(
  config: AutomationsConfigV2,
  identity: string,
  repoPath: string,
  repo: RepoOverride,
): AutomationsConfigV2 {
  const repos = { ...config.repos };
  if (identity !== repoPath) delete repos[repoPath];
  const hasCells = Object.values(repo.lifecycles).some(
    (actions) => actions && Object.keys(actions).length > 0,
  );
  if (hasCells) repos[identity] = repo;
  else delete repos[identity];
  return { ...config, repos };
}

// Both saves patch the cache at mutate time, so a surface seeding mid-save
// reads the save's target. `optimistic` is read BACK after the write: structural
// sharing stores a merged copy, never the object passed in. The rollback runs
// only while that copy is still cached, so a newer save or a landed refetch
// keeps what replaced it.

/** The settle's refetch, skipped while another save of the config is in flight
 *  (a settling save still counts itself): disk would replace that save's patch
 *  until it lands, so the last save out refetches. */
function refetchUnlessQueued(queryClient: QueryClient) {
  if (queryClient.isMutating({ mutationKey: saveAutomationsKey }) > 1) return;
  return queryClient.invalidateQueries({ queryKey: automationsKey });
}

export function useSaveAutomations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: saveAutomationsKey,
    mutationFn: (config: AutomationsConfigV2) => saveAutomations(config),
    // Local plugin-store write — never park it offline (see the query above).
    networkMode: "always",
    onMutate: async (config) => {
      await queryClient.cancelQueries({ queryKey: automationsKey });
      const snapshot =
        queryClient.getQueryData<AutomationsConfigV2>(automationsKey);
      queryClient.setQueryData<AutomationsConfigV2>(automationsKey, config);
      return {
        snapshot,
        optimistic:
          queryClient.getQueryData<AutomationsConfigV2>(automationsKey),
      };
    },
    onError: (_e, _config, ctx) => {
      if (ctx && queryClient.getQueryData(automationsKey) === ctx.optimistic)
        queryClient.setQueryData(automationsKey, ctx.snapshot);
    },
    onSettled: () => refetchUnlessQueued(queryClient),
  });
}

export function useSaveRepoAutomations(repoPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: saveAutomationsKey,
    mutationFn: (repo: RepoOverride) => saveRepoAutomations(repoPath, repo),
    // Local plugin-store write — never park it offline (see the query above).
    networkMode: "always",
    onMutate: async (repo) => {
      await queryClient.cancelQueries({ queryKey: automationsKey });
      const snapshot =
        queryClient.getQueryData<AutomationsConfigV2>(automationsKey);
      // Nothing cached to patch: the settle's refetch brings the saved config.
      if (snapshot === undefined) return { snapshot, optimistic: undefined };
      // An unresolved identity patches the raw-path key, which `repoEntry`
      // still reads until the settle's refetch reconciles it.
      const identity =
        queryClient.getQueryData<string>(
          repoIdentityQueryOptions(repoPath).queryKey,
        ) ?? repoPath;
      queryClient.setQueryData<AutomationsConfigV2>(
        automationsKey,
        withRepoOverride(snapshot, identity, repoPath, repo),
      );
      return {
        snapshot,
        optimistic:
          queryClient.getQueryData<AutomationsConfigV2>(automationsKey),
      };
    },
    onError: (_e, _repo, ctx) => {
      if (
        ctx?.optimistic !== undefined &&
        queryClient.getQueryData(automationsKey) === ctx.optimistic
      )
        queryClient.setQueryData(automationsKey, ctx.snapshot);
    },
    onSettled: () => refetchUnlessQueued(queryClient),
  });
}
