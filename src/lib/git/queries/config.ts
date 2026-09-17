import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";

export function useGlobalIdentity() {
  return useQuery({
    queryKey: ["global-identity"] as const,
    queryFn: api.gitGlobalIdentity,
  });
}

export function useSetGlobalIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; email: string }) =>
      api.gitSetGlobalIdentity(args.name, args.email),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-identity"] }),
  });
}

/** The global `init.defaultBranch` — the branch `git init` gives new repos
 *  (empty string when unset). */
export function useGlobalDefaultBranch() {
  return useQuery({
    queryKey: ["global-default-branch"] as const,
    queryFn: api.gitGlobalDefaultBranch,
  });
}

export function useSetGlobalDefaultBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => api.gitSetGlobalDefaultBranch(branch),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-default-branch"] }),
  });
}

/** The global line-ending policy (`core.autocrlf`): "true" | "input" | "false"
 *  | "" (unset). */
export function useGlobalAutocrlf() {
  return useQuery({
    queryKey: ["global-autocrlf"] as const,
    queryFn: api.gitGlobalAutocrlf,
  });
}

export function useSetGlobalAutocrlf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => api.gitSetGlobalAutocrlf(value),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-autocrlf"] }),
  });
}

export function useUserIdentity(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "user-identity"] as const,
    queryFn: () => api.gitUserIdentity(repo),
    staleTime: 5 * 60_000,
  });
}

/** The repo-local identity override (empty name/email = no override). */
export function useLocalIdentity(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "local-identity"] as const,
    queryFn: () => api.gitLocalIdentity(repo),
  });
}

export function useSetLocalIdentity(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; email: string }) =>
      api.gitSetLocalIdentity(repo, args.name, args.email),
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "local-identity"],
      });
      // The effective identity (used for co-author suggestions) changes too.
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "user-identity"],
      });
    },
  });
}
