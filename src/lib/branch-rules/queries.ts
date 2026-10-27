import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { REPO_SHELL_GC_TIME } from "@/lib/query-cache-times";
import { useMutation } from "@/lib/started-mutation";
import { mergeBranchRules } from "./match";
import {
  loadBranchRules,
  loadSharedBranchRules,
  saveBranchRules,
  saveSharedBranchRules,
} from "./store";
import { type BranchRulesConfig, EMPTY_BRANCH_RULES } from "./types";

const BRANCH_RULES_FAMILY = ["branch-rules"] as const;
const branchRulesKey = (repo: string) =>
  [...BRANCH_RULES_FAMILY, repo] as const;
const sharedBranchRulesKey = (repo: string) =>
  ["branch-rules-shared", repo] as const;

// ── Personal scope ──────────────────────────────────────────────────────────

export function branchRulesOptions(repo: string) {
  return {
    queryKey: branchRulesKey(repo),
    queryFn: () => loadBranchRules(repo),
    staleTime: Number.POSITIVE_INFINITY,
    // Local read: the default "online" mode parks it while the OS reports no
    // connection, which would hold every rules-settling gate closed forever.
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** This repo's personal branch rules; the read is {@link branchRulesOptions}. */
export function useBranchRules(repo: string) {
  return useQuery(branchRulesOptions(repo));
}

// Both saves patch their key at mutate time, so a dialog reopened mid-save seeds
// the save's target. The key is built in onMutate and read back from the context;
// `optimistic` is read BACK after the write, since structural sharing stores a
// merged copy, and the rollback runs only while that copy is still cached, so a
// newer save or a landed refetch keeps what replaced it.

/** Patches `key` to `config`, returning what a failed save's rollback needs. */
async function patchRules(
  queryClient: QueryClient,
  key: readonly unknown[],
  config: BranchRulesConfig,
) {
  await queryClient.cancelQueries({ queryKey: key });
  const snapshot = queryClient.getQueryData<BranchRulesConfig>(key);
  queryClient.setQueryData<BranchRulesConfig>(key, config);
  return {
    key,
    snapshot,
    optimistic: queryClient.getQueryData<BranchRulesConfig>(key),
  };
}

/** Restores the snapshot unless something newer replaced the patch. */
function rollBackRules(
  queryClient: QueryClient,
  ctx: Awaited<ReturnType<typeof patchRules>> | undefined,
) {
  if (ctx && queryClient.getQueryData(ctx.key) === ctx.optimistic)
    queryClient.setQueryData(ctx.key, ctx.snapshot);
}

/** A save's mutation key: its cache key under "save", so a settle can count the
 *  saves of the same key still in flight. */
const saveKey = (key: readonly unknown[]) => ["save", ...key];

/** Whether another save of `key` is still in flight (a settling save still
 *  counts itself). Its settle skips the refetch, which would replace that save's
 *  patch with disk until it lands: the last save out refetches. */
function saveQueued(queryClient: QueryClient, key: readonly unknown[]) {
  return queryClient.isMutating({ mutationKey: saveKey(key) }) > 1;
}

export function useSaveBranchRules(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: saveKey(branchRulesKey(repo)),
    mutationFn: (config: BranchRulesConfig) => saveBranchRules(repo, config),
    // Local write — see branchRulesOptions: "online" mode would park it offline.
    networkMode: "always",
    onMutate: (config) => patchRules(queryClient, branchRulesKey(repo), config),
    onError: (_e, _config, ctx) => rollBackRules(queryClient, ctx),
    // Every checkout's key, not just this one's: the rules are stored by repo
    // identity, so a save here changes what each worktree of the repo reads, and
    // a never-stale key would otherwise serve the old rules from the cache.
    onSettled: (_d, _e, _config, ctx) =>
      ctx && saveQueued(queryClient, ctx.key)
        ? undefined
        : queryClient.invalidateQueries({ queryKey: BRANCH_RULES_FAMILY }),
  });
}

// ── Shared scope (committed `.gitdesktop/branch-rules.json`) ─────────────────

export function sharedBranchRulesOptions(repo: string) {
  return {
    queryKey: sharedBranchRulesKey(repo),
    queryFn: () => loadSharedBranchRules(repo),
    // The file can change out from under us (pull, branch switch), so let it
    // refetch on focus rather than caching forever.
    staleTime: 30_000,
    // Local read — see branchRulesOptions: "online" mode would park it offline.
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** This checkout's shared rules; the read is {@link sharedBranchRulesOptions}. */
export function useSharedBranchRules(repo: string) {
  return useQuery(sharedBranchRulesOptions(repo));
}

export function useSaveSharedBranchRules(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: saveKey(sharedBranchRulesKey(repo)),
    mutationFn: (config: BranchRulesConfig) =>
      saveSharedBranchRules(repo, config),
    // Local write — see branchRulesOptions: "online" mode would park it offline.
    networkMode: "always",
    // Built at mutate time and read back from the context, so the settle names
    // the repo the write fired on whatever render it settles through.
    onMutate: (config) =>
      patchRules(queryClient, sharedBranchRulesKey(repo), config),
    onError: (_e, _config, ctx) => rollBackRules(queryClient, ctx),
    // This checkout's key only, unlike the personal save: the file lives in each
    // working tree, so no other checkout's read changed.
    onSettled: (_d, _e, _config, ctx) =>
      ctx &&
      !saveQueued(queryClient, ctx.key) &&
      queryClient.invalidateQueries({ queryKey: ctx.key }),
  });
}

// ── Effective (merged) rules used by every enforcement point ─────────────────

/** Shared (repo) rules merged with personal rules — what actually enforces. */
export function useEffectiveBranchRules(repo: string): BranchRulesConfig {
  const personal = useBranchRules(repo);
  const shared = useSharedBranchRules(repo);
  return mergeBranchRules(
    shared.data ?? EMPTY_BRANCH_RULES,
    personal.data ?? EMPTY_BRANCH_RULES,
  );
}

/**
 * Whether either scope is still on its FIRST read, so the effective rules stand
 * in as empty. An action a rule would have refused must hold on this rather than
 * act on the stand-in. A read that FAILED is not pending: it falls open, since
 * nothing would ever arrive to lift the hold.
 */
export function useEffectiveBranchRulesSettling(repo: string): boolean {
  const personal = useBranchRules(repo);
  const shared = useSharedBranchRules(repo);
  return personal.isPending || shared.isPending;
}
