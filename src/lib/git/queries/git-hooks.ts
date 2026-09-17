import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { useRepoMutation } from "./internal";

// ── Git hooks ────────────────────────────────────────────────────────────────

export function useHooks(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "hooks"] as const,
    queryFn: () => api.gitHooksList(repo),
  });
}

/** A hook's script content, loaded when one is selected for editing. */
export function useHookContent(repo: string, name: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "hook", name] as const,
    queryFn: () => api.gitHookRead(repo, name ?? ""),
    enabled: name !== null,
  });
}

export function useWriteHook(repo: string) {
  return useRepoMutation(repo, (args: { name: string; content: string }) =>
    api.gitHookWrite(repo, args.name, args.content),
  );
}

export function useSetHookEnabled(repo: string) {
  return useRepoMutation(repo, (args: { name: string; enabled: boolean }) =>
    api.gitHookSetEnabled(repo, args.name, args.enabled),
  );
}

export function useDeleteHook(repo: string) {
  return useRepoMutation(repo, (name: string) => api.gitHookDelete(repo, name));
}

export function useRunHookManager(repo: string) {
  return useRepoMutation(
    repo,
    (args: { manager: string; action: "install" | "update" }) =>
      api.gitRunHookManager(repo, args.manager, args.action),
  );
}
