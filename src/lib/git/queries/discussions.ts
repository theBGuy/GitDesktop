import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import * as api from "../api";
import type { DiscussionDetails } from "../types";
import { keepPreviousDataForRepo, repoKeys } from "./core";
import { useOptimisticCacheMutation, useRepoMutation } from "./internal";

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
    {
      // Pinned: the call and its invalidation close over `repo`, and the dialog host
      // survives a repo switch — without the key a switch retargets the pending create.
      identity: ["create-discussion", repo],
    },
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
  // Pinned on the discussion: its host stays mounted across a discussion switch, and
  // a changed key detaches the pending toggle with its options frozen, so a late
  // settle rolls back and refetches the discussion it was fired on.
  return useOptimisticCacheMutation<
    { subjectId: string; up: boolean },
    void,
    DiscussionDetails
  >(
    (args) => api.ghDiscussionSetUpvote(repo, args.subjectId, args.up),
    () => discussionDetailsOptions(repo, number).queryKey,
    (d, args) => {
      // Never creates the entry: the helper rolls back only a defined snapshot.
      if (d === undefined) return undefined;
      const delta = args.up ? 1 : -1;
      return args.subjectId === d.id
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
          };
    },
    (queryClient) => {
      // The discussion list shows upvote counts too.
      void queryClient.invalidateQueries({
        queryKey: ["repo", repo, "discussion-list"],
      });
      return queryClient.invalidateQueries({
        queryKey: discussionDetailsOptions(repo, number).queryKey,
      });
    },
    ["toggle-discussion-upvote", repo, number],
  );
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
    queryKey: repoKeys.reactions(repo, ["discussion", number ?? 0]),
    queryFn: () => api.ghDiscussionReactions(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}
