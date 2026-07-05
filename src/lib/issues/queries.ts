import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLocalIssue,
  deleteLocalIssue,
  type LocalIssue,
  listLocalIssues,
  updateLocalIssue,
} from "./local";

const localIssueKey = (repo: string) => ["local-issues", repo] as const;

export function useLocalIssues(repo: string) {
  return useQuery({
    queryKey: localIssueKey(repo),
    queryFn: () => listLocalIssues(repo),
  });
}

function useLocalIssueMutation<TArgs, TData>(
  repo: string,
  fn: (args: TArgs) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: localIssueKey(repo) }),
  });
}

export function useCreateLocalIssue(repo: string) {
  return useLocalIssueMutation(repo, (input: { title: string; body: string }) =>
    createLocalIssue(repo, input),
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
