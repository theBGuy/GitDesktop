import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { REPO_SHELL_GC_TIME } from "@/lib/query-cache-times";
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

export function useSaveBranchRules(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: BranchRulesConfig) => saveBranchRules(repo, config),
    // Local write — see branchRulesOptions: "online" mode would park it offline.
    networkMode: "always",
    // Every checkout's key, not just this one's: the rules are stored by repo
    // identity, so a save here changes what each worktree of the repo reads, and
    // a never-stale key would otherwise serve the old rules from the cache.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: BRANCH_RULES_FAMILY }),
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
    mutationFn: (config: BranchRulesConfig) =>
      saveSharedBranchRules(repo, config),
    // Local write — see branchRulesOptions: "online" mode would park it offline.
    networkMode: "always",
    // This checkout's key only, unlike the personal save: the file lives in each
    // working tree, so no other checkout's read changed.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: sharedBranchRulesKey(repo) }),
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
