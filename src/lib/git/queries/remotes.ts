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
  });
}

export function useSetRemoteUrl(repo: string) {
  return useRepoMutation(repo, (args: { name: string; url: string }) =>
    api.gitRemoteSetUrl(repo, args.name, args.url),
  );
}

/** Adds a remote (e.g. `upstream` on a fork cloned without one). The default broad
 *  invalidation prefix-covers `remotes`/`remote-url`, so `useLensGate` re-reads and the
 *  fork/upstream UI lights up live. */
export function useAddRemote(repo: string) {
  return useRepoMutation(repo, (args: { name: string; url: string }) =>
    api.gitRemoteAdd(repo, args.name, args.url),
  );
}

/** Removes a remote. The default broad invalidation prefix-covers
 *  `remotes`/`remote-url`, so `useLensGate` re-reads and every fork-identity surface
 *  collapses live. */
export function useRemoveRemote(repo: string) {
  return useRepoMutation(repo, (args: { name: string }) =>
    api.gitRemoteRemove(repo, args.name),
  );
}
