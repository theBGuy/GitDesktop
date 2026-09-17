import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import * as api from "../api";
import type { DiscussionDetails } from "../types";
import { keepPreviousDataForRepo } from "./core";
import { useRepoMutation } from "./internal";

export function useDiscussionMeta(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "discussion-meta"] as const,
    queryFn: () => api.ghDiscussionCategories(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useDiscussionList(
  repo: string,
  enabled: boolean,
  category: string | null,
  limit?: number,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "discussion-list",
      category ?? "all",
      limit ?? null,
    ] as const,
    queryFn: () => api.ghDiscussionList(repo, category, limit),
    enabled,
    staleTime: 30_000,
    // Keep current rows visible while a grown "Load more" page loads.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

const discussionDetailsOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["repo", repo, "discussion", number] as const,
    queryFn: () => api.ghDiscussionView(repo, number),
    staleTime: 30_000,
  });

export function useDiscussionDetails(repo: string, number: number | null) {
  return useQuery({
    ...discussionDetailsOptions(repo, number ?? 0),
    enabled: number !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function usePrefetchDiscussion(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(discussionDetailsOptions(repo, number));
    },
    [queryClient, repo],
  );
}

export function useCreateDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      repoId: string;
      categoryId: string;
      title: string;
      body: string;
    }) =>
      api.ghDiscussionCreate(
        repo,
        args.repoId,
        args.categoryId,
        args.title,
        args.body,
      ),
  );
}

export function useAddDiscussionComment(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; body: string; replyToId?: string | null }) =>
      api.ghDiscussionAddComment(
        repo,
        args.discussionId,
        args.body,
        args.replyToId ?? null,
      ),
  );
}

export function useMarkDiscussionAnswer(repo: string) {
  return useRepoMutation(
    repo,
    (args: { commentId: string; answer: boolean }) =>
      args.answer
        ? api.ghDiscussionMarkAnswer(repo, args.commentId)
        : api.ghDiscussionUnmarkAnswer(repo, args.commentId),
  );
}

export function useUpdateDiscussionComment(repo: string) {
  return useRepoMutation(repo, (args: { commentId: string; body: string }) =>
    api.ghDiscussionUpdateComment(repo, args.commentId, args.body),
  );
}

export function useDeleteDiscussionComment(repo: string) {
  return useRepoMutation(repo, (commentId: string) =>
    api.ghDiscussionDeleteComment(repo, commentId),
  );
}

/** Optimistic upvote toggle on a discussion or its comments, with rollback. */
export function useToggleDiscussionUpvote(repo: string, number: number) {
  const queryClient = useQueryClient();
  const key = ["repo", repo, "discussion", number] as const;
  return useMutation({
    mutationFn: (args: { subjectId: string; up: boolean }) =>
      api.ghDiscussionSetUpvote(repo, args.subjectId, args.up),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<DiscussionDetails>(key);
      const delta = args.up ? 1 : -1;
      queryClient.setQueryData<DiscussionDetails>(key, (d) =>
        !d
          ? d
          : args.subjectId === d.id
            ? {
                ...d,
                upvoteCount: d.upvoteCount + delta,
                viewerHasUpvoted: args.up,
              }
            : {
                ...d,
                comments: d.comments.map((c) =>
                  c.id === args.subjectId
                    ? {
                        ...c,
                        upvoteCount: c.upvoteCount + delta,
                        viewerHasUpvoted: args.up,
                      }
                    : c,
                ),
              },
      );
      return { prev };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      // The discussion list shows upvote counts too.
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "discussion-list"],
      });
    },
  });
}

export function useLockDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; reason: api.DiscussionLockReason | null }) =>
      api.ghDiscussionLock(repo, args.discussionId, args.reason),
  );
}

export function useUnlockDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionUnlock(repo, discussionId),
  );
}

export function useCloseDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; reason: api.DiscussionCloseReason }) =>
      api.ghDiscussionClose(repo, args.discussionId, args.reason),
  );
}

export function useReopenDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionReopen(repo, discussionId),
  );
}

export function useDeleteDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionDelete(repo, discussionId),
  );
}

export function useDiscussionReactions(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "discussion", number ?? 0, "reactions"] as const,
    queryFn: () => api.ghDiscussionReactions(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}
