import { queryOptions } from "@tanstack/react-query";
import { repoIdentityStrict } from "./repo-identity";

/** The ONE options factory for the `["repo-identity", repoPath]` query: the shared
 *  fetch takes its options from whichever observer starts it, so an inline copy
 *  splits behavior (notably `networkMode`, without which this local read parks
 *  offline). Strict REJECTS on IPC failure — the ladder and the next observer mount
 *  heal it, but a MOUNTED observer holds isError with no data until one comes, so
 *  gating consumers fall back; a raw-path success is git's settled answer and pins. */
export function repoIdentityQueryOptions(repoPath: string | null) {
  return queryOptions({
    queryKey: ["repo-identity", repoPath] as const,
    queryFn: () => repoIdentityStrict(repoPath as string),
    enabled: !!repoPath,
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });
}
