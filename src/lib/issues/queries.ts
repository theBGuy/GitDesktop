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
  });
}

/** `identity` pins the mutation key, so a repo switch mid-flight detaches the write
 *  instead of retargeting it and its invalidation (gd-conventions). Opt-in rather
 *  than automatic: the update/delete hooks' callers read `isPending` as a re-entry
 *  guard, and a detach would silently open it. */
function useLocalIssueMutation<TArgs, TData>(
  repo: string,
  fn: (args: TArgs) => Promise<TData>,
  identity?: readonly unknown[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...(identity ? { mutationKey: identity } : {}),
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: localIssueKey(repo) }),
  });
}

export function useCreateLocalIssue(repo: string) {
  return useLocalIssueMutation(
    repo,
    (input: { title: string; body: string }) => createLocalIssue(repo, input),
    // Pinned: the create and the list invalidation close over `repo`, and the
    // dialog survives a repo switch — its only caller awaits the promise and
    // reads no observer state.
    ["local-issue", "create", repo],
  );
}

export function useUpdateLocalIssue(repo: string) {
  return useLocalIssueMutation(
    repo,
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
  return useLocalIssueMutation(repo, (id: string) =>
    deleteLocalIssue(repo, id),
  );
}
