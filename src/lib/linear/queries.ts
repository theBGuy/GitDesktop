import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keepPreviousDataForRepo } from "@/lib/git/queries";
import {
  linearIssueComment,
  linearIssueCreate,
  linearIssueList,
  linearIssueTransition,
  linearIssueAssign,
  linearIssueView,
  linearStoredAccount,
  linearTeams,
} from "./api";
import {
  clearLinearLink,
  getLinearLink,
  type LinearLink,
  setLinearLink,
} from "./store";
import type {
  LinearIssueDetails,
  LinearIssueState,
} from "./types";

const linearLinkKey = (repo: string) => ["linear-link", repo] as const;

export function useLinearLink(repo: string) {
  return useQuery({
    queryKey: linearLinkKey(repo),
    queryFn: () => getLinearLink(repo),
  });
}

function invalidateLinearForRepo(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
) {
  queryClient.invalidateQueries({ queryKey: linearLinkKey(repo) });
  queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "repo" &&
      q.queryKey[1] === repo &&
      (q.queryKey[2] === "linear-issues" ||
        q.queryKey[2] === "linear-issue"),
  });
}

function invalidateLinearIssue(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
  issueIdentifier: string,
) {
  queryClient.invalidateQueries({
    queryKey: ["repo", repo, "linear-issue", issueIdentifier],
  });
  queryClient.invalidateQueries({
    queryKey: ["repo", repo, "linear-issues"],
  });
}

export function useSaveLinearLink(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (link: LinearLink) => setLinearLink(repo, link),
    onSettled: () => invalidateLinearForRepo(queryClient, repo),
  });
}

export function useClearLinearLink(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearLinearLink(repo),
    onSettled: () => invalidateLinearForRepo(queryClient, repo),
  });
}

export function useLinearAccount() {
  return useQuery({
    queryKey: ["linear-account"] as const,
    queryFn: () => linearStoredAccount(),
  });
}

export function useLinearTeams(enabled: boolean) {
  return useQuery({
    queryKey: ["linear-teams"] as const,
    queryFn: () => linearTeams(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useLinearIssues(
  repo: string,
  link: LinearLink | null | undefined,
  state: LinearIssueState,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "linear-issues",
      link?.teamKey ?? "",
      state,
    ] as const,
    queryFn: () =>
      linearIssueList((link as LinearLink).teamKey, state),
    enabled: !!link,
    staleTime: 30_000,
  });
}

export function useLinearIssue(
  repo: string,
  link: LinearLink | null | undefined,
  identifier: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "linear-issue", identifier] as const,
    queryFn: () => linearIssueView(identifier as string),
    enabled: !!link && identifier !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useLinearComment(
  repo: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueId: string;
      issueIdentifier: string;
      bodyMd: string;
    }) => linearIssueComment(args.issueId, args.bodyMd),
    onSuccess: (comment, args) => {
      const key = [
        "repo",
        repo,
        "linear-issue",
        args.issueIdentifier,
      ] as const;
      queryClient.setQueryData<LinearIssueDetails>(key, (d) =>
        d ? { ...d, comments: [...d.comments, comment] } : d,
      );
    },
    onSettled: (_d, _e, args) =>
      invalidateLinearIssue(queryClient, repo, args.issueIdentifier),
  });
}

export function useLinearTransition(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueId: string; stateId: string }) =>
      linearIssueTransition(args.issueId, args.stateId),
    onSettled: () => invalidateLinearForRepo(queryClient, repo),
  });
}

export function useLinearAssign(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueId: string;
      assigneeId: string | null;
    }) => linearIssueAssign(args.issueId, args.assigneeId),
    onSettled: () => invalidateLinearForRepo(queryClient, repo),
  });
}

export function useLinearCreateIssue(
  repo: string,
  link: LinearLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      teamId: string;
      title: string;
      descriptionMd?: string;
    }) => linearIssueCreate(args.teamId, args.title, args.descriptionMd),
    onSettled: () => invalidateLinearForRepo(queryClient, repo),
  });
}
