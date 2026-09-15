import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadAutomations, saveAutomations, saveRepoAutomations } from "./store";
import type { AutomationsConfigV2, RepoOverride } from "./types";

const automationsKey = ["automations"] as const;

export function useAutomations() {
  return useQuery({
    queryKey: automationsKey,
    queryFn: loadAutomations,
    // Local plugin-store read: the default online mode PARKS it while the OS
    // reports no connection, and every automations surface wedges.
    networkMode: "always",
  });
}

export function useSaveAutomations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: AutomationsConfigV2) => saveAutomations(config),
    // Local plugin-store write — never park it offline (see the query above).
    networkMode: "always",
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: automationsKey }),
  });
}

export function useSaveRepoAutomations(repoPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repo: RepoOverride) => saveRepoAutomations(repoPath, repo),
    // Local plugin-store write — never park it offline (see the query above).
    networkMode: "always",
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: automationsKey }),
  });
}
