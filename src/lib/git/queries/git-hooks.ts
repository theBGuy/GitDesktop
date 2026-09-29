import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { useRepoMutation } from "./internal";

// ── Git hooks ────────────────────────────────────────────────────────────────

export function useHooks(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "hooks"] as const,
    queryFn: () => api.gitHooksList(repo),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

/** A hook's script content, loaded when one is selected for editing. */
export function useHookContent(repo: string, name: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "hook", name] as const,
    queryFn: () => api.gitHookRead(repo, name ?? ""),
    enabled: name !== null,
    networkMode: "always",
  });
}

export function useWriteHook(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; content: string }) =>
      api.gitHookWrite(repo, args.name, args.content),
    {
      // Local hook write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useSetHookEnabled(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; enabled: boolean }) =>
      api.gitHookSetEnabled(repo, args.name, args.enabled),
    {
      // Local hook write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useDeleteHook(repo: string) {
  return useRepoMutation(
    repo,
    (name: string) => api.gitHookDelete(repo, name),
    {
      // Local hook write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useInstallHookManager(repo: string) {
  return useRepoMutation(
    repo,
    (manager: string) => api.gitInstallHookManager(repo, manager),
    {
      // Local hook write — never park it offline.
      networkMode: "always",
    },
  );
}

/** pre-commit `autoupdate` fetches, so it keeps the default and pauses offline. */
export function useUpdateHookManager(repo: string) {
  return useRepoMutation(repo, (manager: string) =>
    api.gitUpdateHookManager(repo, manager),
  );
}
