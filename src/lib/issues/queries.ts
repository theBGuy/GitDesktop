import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLocalIssue,
  deleteLocalIssue,
  type LocalIssue,
  listLocalIssues,
  updateLocalIssue,
} from "./local";

/** The local issue records for one repo. Exported because the MCP is a second
 *  writer, so a surface offering a manual refresh has to reach this family. */
export const localIssueKey = (repo: string) => ["local-issues", repo] as const;

export function useLocalIssues(repo: string) {
  return useQuery({
    queryKey: localIssueKey(repo),
    queryFn: () => listLocalIssues(repo),
    // A local app-data read, so it must not park on the default "online" mode.
    networkMode: "always",
  });
}

/** Pinned to `op` + repo, so a repo switch mid-flight detaches the write instead of
 *  retargeting it and its invalidation (gd-conventions). The detached observer goes
 *  idle, so callers never rely on `isPending` alone for re-entry protection. */
function useLocalIssueMutation<TArgs, TData>(
  repo: string,
  op: "create" | "update" | "delete",
  fn: (args: TArgs) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["local-issue", op, repo],
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: localIssueKey(repo) }),
  });
}

export function useCreateLocalIssue(repo: string) {
  return useLocalIssueMutation(
    repo,
    "create",
    (input: { title: string; body: string }) => createLocalIssue(repo, input),
  );
}

export function useUpdateLocalIssue(repo: string) {
  return useLocalIssueMutation(
    repo,
    "update",
    ({
      id,
      mutate,
    }: {
      id: string;
      mutate: (issue: LocalIssue) => LocalIssue;
    }) => updateLocalIssue(repo, id, mutate),
  );
}

export function useDeleteLocalIssue(repo: string) {
  return useLocalIssueMutation(repo, "delete", (id: string) =>
    deleteLocalIssue(repo, id),
  );
}
