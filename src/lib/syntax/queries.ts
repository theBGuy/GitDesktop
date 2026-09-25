import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSettings } from "@/lib/settings/queries";
import {
  EMPTY_SYNTAX,
  loadSharedSyntax,
  mergeSyntax,
  type SyntaxConfig,
  saveSharedSyntax,
} from "./store";

const sharedSyntaxKey = (repo: string) => ["syntax-shared", repo] as const;

/** The repo's committed `.gitdesktop/syntax.json` (shared scope). */
export function useSharedSyntax(repo: string | null) {
  return useQuery({
    queryKey: sharedSyntaxKey(repo ?? ""),
    queryFn: () => loadSharedSyntax(repo as string),
    enabled: Boolean(repo),
    // The file can change under us (pull, branch switch); refetch on focus.
    staleTime: 30_000,
    // A local file read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}

export function useSaveSharedSyntax(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: SyntaxConfig) => saveSharedSyntax(repo, config),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: sharedSyntaxKey(repo) }),
  });
}

/**
 * Effective syntax used by every diff: the repo's shared config providing
 * team defaults, with the user's personal (global settings) config winning on
 * conflict. Memoized so its identity is stable between renders (the diff build
 * depends on it).
 */
export function useEffectiveSyntax(repo: string | null): SyntaxConfig {
  const settings = useSettings();
  const shared = useSharedSyntax(repo);
  const personalMap = settings.data?.syntaxMap;
  const personalLangs = settings.data?.customLanguages;
  const sharedData = shared.data;
  return useMemo(
    () =>
      mergeSyntax(sharedData ?? EMPTY_SYNTAX, {
        syntaxMap: personalMap ?? {},
        customLanguages: personalLangs ?? [],
      }),
    [sharedData, personalMap, personalLangs],
  );
}
