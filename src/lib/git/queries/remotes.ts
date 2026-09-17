import { useQuery } from "@tanstack/react-query";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api";
import { useRepoMutation } from "./internal";

export function useRemotes(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "remotes"] as const,
    queryFn: () => api.gitRemotes(repo),
  });
}

export function usePublishRepo(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      provider: "github" | "gitlab" | "bitbucket";
      name: string;
      isPrivate: boolean;
      description: string;
      homepage: string;
      topics: string[];
      /** Bitbucket only — the workspace the repo is created under. */
      workspace?: string;
    }) =>
      api.forgePublishRepo(
        args.provider,
        repo,
        args.name,
        args.isPrivate,
        args.description,
        args.homepage,
        args.topics,
        args.workspace,
      ),
  );
}

/** Which providers this machine can publish to — drives the publish buttons for
 *  a repo with no hosted remote yet. Honors the cold-start test mode like
 *  `useForgeStatus` (the probe hits the real CLIs otherwise). */
export function usePublishTargets(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "publish-targets"] as const,
    queryFn: COLD_START_NO_GH
      ? () =>
          Promise.resolve({ github: false, gitlab: false, bitbucket: false })
      : () => api.forgePublishTargets(repo),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
