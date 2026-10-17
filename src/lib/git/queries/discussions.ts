import {
  type MutationCache,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { REPO_SHELL_GC_TIME } from "@/lib/query-cache-times";
import * as api from "../api";
import type { DiscussionDetails } from "../types";
import { keepPreviousDataForRepo, repoKeys } from "./core";
import {
  useMutationCacheSnapshot,
  useOptimisticCacheMutation,
  useRepoMutation,
} from "./internal";
import { type PendingRepoWrite, pendingWriteMatching } from "./issues";
import {
  type DiscussionUpvoteVars,
  pendingDiscussionUpvoteFor,
  pendingMutationEntries,
} from "./pr-writes";

export function useDiscussionMeta(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "discussion-meta"] as const,
    queryFn: () => api.ghDiscussionCategories(repo),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: REPO_SHELL_GC_TIME,
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
      ...repoKeys.discussionList(repo),
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
      // Pinned: the call and its invalidation close over `repo`, and the dialog
      // host survives a repo switch — without the key the newly-live repo's
      // controls would read the pending create as busy.
      identity: ["create-discussion", repo],
    },
  );
}

export function useAddDiscussionComment(repo: string) {
  return useRepoMutation(
    repo,
    (args: DiscussionWriteVars["add-comment"]) =>
      api.ghDiscussionAddComment(
        repo,
        args.discussionId,
        args.body,
        args.replyToId ?? null,
      ),
    { identity: discussionWriteKey("add-comment", repo) },
  );
}

export function useMarkDiscussionAnswer(repo: string) {
  return useRepoMutation(
    repo,
    // `discussionId` rides along only for the pending read; the API keys on the comment.
    (args: DiscussionWriteVars["mark-answer"]) =>
      args.answer
        ? api.ghDiscussionMarkAnswer(repo, args.commentId)
        : api.ghDiscussionUnmarkAnswer(repo, args.commentId),
    { identity: discussionWriteKey("mark-answer", repo) },
  );
}

export function useUpdateDiscussionComment(repo: string) {
  return useRepoMutation(repo, (args: { commentId: string; body: string }) =>
    api.ghDiscussionUpdateComment(repo, args.commentId, args.body),
  );
}

export function useDeleteDiscussionComment(repo: string) {
  return useRepoMutation(
    repo,
    // `discussionId` rides along only for the pending read; the API keys on the comment.
    (args: DiscussionWriteVars["delete-comment"]) =>
      api.ghDiscussionDeleteComment(repo, args.commentId),
    { identity: discussionWriteKey("delete-comment", repo) },
  );
}

const UPVOTE_KEY = "toggle-discussion-upvote";

/** Optimistic upvote toggle on a discussion or its comments, with rollback. Per call,
 *  `number` is the containing discussion and `subjectId` its body or a comment. */
export function useToggleDiscussionUpvote(repo: string) {
  // The discussion rides the variables, never the hook: one host serves the body and
  // every comment of a discussion, and the pending-upvote reads match each toggle by
  // its variables, so the target is fixed per call.
  return useOptimisticCacheMutation<
    DiscussionUpvoteVars,
    void,
    DiscussionDetails
  >(
    (args) => api.ghDiscussionSetUpvote(repo, args.subjectId, args.up),
    (args) => discussionDetailsOptions(repo, args.number).queryKey,
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
    (queryClient, args) => {
      // The discussion list shows upvote counts too.
      void queryClient.invalidateQueries({
        queryKey: repoKeys.discussionList(repo),
      });
      return queryClient.invalidateQueries({
        queryKey: discussionDetailsOptions(repo, args.number).queryKey,
      });
    },
    [UPVOTE_KEY, repo],
  );
}

const NO_PENDING_UPVOTE = { pending: false, paused: false };

/**
 * Whether an upvote toggle on discussion `number` is in flight, and whether any such
 * toggle is parked offline. Read from the mutation cache through
 * {@link useMutationCacheSnapshot}, never the observer, which tracks only its latest
 * call (a toggle fired on another discussion would release this one's hold).
 */
export function usePendingDiscussionUpvote(
  repo: string,
  number: number,
): { pending: boolean; paused: boolean } {
  const select = useCallback(
    (cache: MutationCache) =>
      pendingDiscussionUpvoteFor(
        pendingMutationEntries(
          cache.findAll({ mutationKey: [UPVOTE_KEY], status: "pending" }),
        ),
        repo,
        number,
      ),
    [repo, number],
  );
  return useMutationCacheSnapshot(select, NO_PENDING_UPVOTE);
}

/** The discussion writes whose pending state a view reads back from the cache. */
export type DiscussionWriteKind =
  | "lock"
  | "unlock"
  | "close"
  | "reopen"
  | "delete"
  | "add-comment"
  | "mark-answer"
  | "delete-comment";

/** Each discussion write's variables, shared by the mutation's generic and the
 *  pending scan's cast. */
export type DiscussionWriteVars = {
  lock: { discussionId: string; reason: api.DiscussionLockReason | null };
  /** The discussion's node id, bare. */
  unlock: string;
  close: { discussionId: string; reason: api.DiscussionCloseReason };
  /** The discussion's node id, bare. */
  reopen: string;
  /** The discussion's node id, bare. */
  delete: string;
  "add-comment": {
    discussionId: string;
    body: string;
    replyToId?: string | null;
  };
  "mark-answer": { discussionId: string; commentId: string; answer: boolean };
  "delete-comment": { discussionId: string; commentId: string };
};

/** Filter prefix for EVERY discussion write ({@link discussionWriteKey}). */
export const DISCUSSION_WRITES_FAMILY = "discussion-write";

/** A discussion write's mutation key. Static per repo, so it never detaches a
 *  pending write across a discussion switch; the discussion rides the variables. */
export const discussionWriteKey = (kind: DiscussionWriteKind, repo: string) =>
  [DISCUSSION_WRITES_FAMILY, kind, repo] as const;

/** {@link pendingWriteMatching} over the discussion family, typed per kind. */
export const pendingDiscussionWrite = <K extends DiscussionWriteKind>(
  writes: readonly PendingRepoWrite[],
  kind: K,
  match: (vars: DiscussionWriteVars[K]) => boolean,
) => pendingWriteMatching(writes, kind, match);

export function useLockDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: DiscussionWriteVars["lock"]) =>
      api.ghDiscussionLock(repo, args.discussionId, args.reason),
    { identity: discussionWriteKey("lock", repo) },
  );
}

export function useUnlockDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (discussionId: DiscussionWriteVars["unlock"]) =>
      api.ghDiscussionUnlock(repo, discussionId),
    { identity: discussionWriteKey("unlock", repo) },
  );
}

export function useCloseDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: DiscussionWriteVars["close"]) =>
      api.ghDiscussionClose(repo, args.discussionId, args.reason),
    { identity: discussionWriteKey("close", repo) },
  );
}

export function useReopenDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (discussionId: DiscussionWriteVars["reopen"]) =>
      api.ghDiscussionReopen(repo, discussionId),
    { identity: discussionWriteKey("reopen", repo) },
  );
}

export function useDeleteDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (discussionId: DiscussionWriteVars["delete"]) =>
      api.ghDiscussionDelete(repo, discussionId),
    { identity: discussionWriteKey("delete", repo) },
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
