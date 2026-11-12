import {
  type MutationCache,
  type Query,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import * as api from "../api";
import { peekRepoIdentity } from "../repo-identity";
import { useMutationCacheSnapshot, useRepoMutation } from "./internal";

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

const keepLocalHookKey = (repo: string) =>
  ["repo", repo, "keep-local-hook"] as const;

/** The Keep local pre-push hook's state in this clone. */
export function useKeepLocalHookStatus(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: keepLocalHookKey(repo),
    queryFn: () => api.gitKeepLocalHookStatus(repo),
    enabled,
    // Also what puts it under the git-only invalidation of the two writes below.
    networkMode: "always",
  });
}

/** Install and remove take the repo as a variable and resolve to the status
 *  AFTER the write, the authoritative answer (a lost race comes back blocked).
 *  It is seeded into that repo's status entry before the invalidation re-reads
 *  it, so the status never contradicts the write; the key comes from the
 *  write's own variables, so a settle after a repo switch seeds its own repo.
 *  The other checkouts of the repository share the hook, so their status and
 *  hook list re-read (unobserved ones are cleared first). */
type KeepLocalHookWrite = { repo: string };

/** Matches the cached hook status and hook list of `repo`'s sibling worktrees:
 *  another checkout whose repository identity is `repo`'s. Identities are
 *  peeked when it runs (never resolved), and one unknown on either side counts
 *  as a sibling, as `siblingRemotesOf` (remotes.ts) does. */
function siblingHookReadsOf(repo: string) {
  return (q: Query): boolean => {
    const [root, path, kind] = q.queryKey;
    if (root !== "repo" || typeof path !== "string" || path === repo)
      return false;
    if (kind !== "keep-local-hook" && kind !== "hooks") return false;
    const own = peekRepoIdentity(repo);
    if (own === undefined || own === repo) return true;
    const theirs = peekRepoIdentity(path);
    return theirs === undefined || theirs === path || theirs === own;
  };
}

export function useInstallKeepLocalHook(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: KeepLocalHookWrite) => api.gitKeepLocalHookInstall(args.repo),
    {
      networkMode: "always",
      localOnly: true,
      identity: ["keep-local-hook", "install", repo],
      onSuccess: (status, args) => {
        queryClient.setQueryData(keepLocalHookKey(args.repo), status);
        const siblings = siblingHookReadsOf(args.repo);
        void queryClient.resetQueries({
          predicate: siblings,
          type: "inactive",
        });
        void queryClient.invalidateQueries({
          predicate: siblings,
          type: "active",
        });
      },
    },
  );
}

export function useRemoveKeepLocalHook(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: KeepLocalHookWrite) => api.gitKeepLocalHookRemove(args.repo),
    {
      networkMode: "always",
      localOnly: true,
      identity: ["keep-local-hook", "remove", repo],
      onSuccess: (status, args) => {
        queryClient.setQueryData(keepLocalHookKey(args.repo), status);
        const siblings = siblingHookReadsOf(args.repo);
        void queryClient.resetQueries({
          predicate: siblings,
          type: "inactive",
        });
        void queryClient.invalidateQueries({
          predicate: siblings,
          type: "active",
        });
      },
    },
  );
}

/** Whether an install or remove of `repo`'s hook is between its request and its
 *  answer. Read from the mutation cache by the writes' identity keys: a reopened
 *  dialog's own observers never saw an earlier open's write. */
export function useKeepLocalHookWritePending(repo: string): boolean {
  const select = useCallback(
    (cache: MutationCache) =>
      cache.findAll({
        status: "pending",
        predicate: (m) => {
          const key = m.options.mutationKey;
          return key?.[0] === "keep-local-hook" && key[2] === repo;
        },
      }).length > 0,
    [repo],
  );
  return useMutationCacheSnapshot(select, false);
}

/** pre-commit `autoupdate` fetches, so it keeps the default and pauses offline. */
export function useUpdateHookManager(repo: string) {
  return useRepoMutation(repo, (manager: string) =>
    api.gitUpdateHookManager(repo, manager),
  );
}
