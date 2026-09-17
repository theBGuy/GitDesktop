import { invoke } from "@/lib/tauri/invoke";
import type {
  DiscussionDetails,
  DiscussionInfo,
  DiscussionMeta,
  IssueReactions,
  PrRef,
} from "../types";

export const ghDiscussionCategories = (repoPath: string) =>
  invoke<DiscussionMeta>("gh_discussion_categories", { repoPath });

export const ghDiscussionList = (
  repoPath: string,
  category: string | null,
  limit?: number,
) =>
  invoke<DiscussionInfo[]>("gh_discussion_list", { repoPath, category, limit });

export const ghDiscussionView = (repoPath: string, number: number) =>
  invoke<DiscussionDetails>("gh_discussion_view", { repoPath, number });

export const ghDiscussionCreate = (
  repoPath: string,
  repoId: string,
  categoryId: string,
  title: string,
  body: string,
) =>
  invoke<PrRef>("gh_discussion_create", {
    repoPath,
    repoId,
    categoryId,
    title,
    body,
  });

export const ghDiscussionAddComment = (
  repoPath: string,
  discussionId: string,
  body: string,
  replyToId: string | null,
) =>
  invoke<void>("gh_discussion_add_comment", {
    repoPath,
    discussionId,
    body,
    replyToId,
  });

export const ghDiscussionMarkAnswer = (repoPath: string, commentId: string) =>
  invoke<void>("gh_discussion_mark_answer", { repoPath, commentId });

export const ghDiscussionUnmarkAnswer = (repoPath: string, commentId: string) =>
  invoke<void>("gh_discussion_unmark_answer", { repoPath, commentId });

export const ghDiscussionUpdateComment = (
  repoPath: string,
  commentId: string,
  body: string,
) =>
  invoke<void>("gh_discussion_update_comment", { repoPath, commentId, body });

export const ghDiscussionDeleteComment = (
  repoPath: string,
  commentId: string,
) => invoke<void>("gh_discussion_delete_comment", { repoPath, commentId });

export const ghDiscussionSetUpvote = (
  repoPath: string,
  subjectId: string,
  up: boolean,
) => invoke<void>("gh_discussion_set_upvote", { repoPath, subjectId, up });

export const ghDiscussionReactions = (repoPath: string, number: number) =>
  invoke<IssueReactions>("gh_discussion_reactions", { repoPath, number });

export type DiscussionLockReason =
  | "OFF_TOPIC"
  | "TOO_HEATED"
  | "RESOLVED"
  | "SPAM";

export const ghDiscussionLock = (
  repoPath: string,
  discussionId: string,
  reason: DiscussionLockReason | null,
) => invoke<void>("gh_discussion_lock", { repoPath, discussionId, reason });

export const ghDiscussionUnlock = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_unlock", { repoPath, discussionId });

export type DiscussionCloseReason = "RESOLVED" | "OUTDATED" | "DUPLICATE";

export const ghDiscussionClose = (
  repoPath: string,
  discussionId: string,
  reason: DiscussionCloseReason,
) => invoke<void>("gh_discussion_close", { repoPath, discussionId, reason });

export const ghDiscussionReopen = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_reopen", { repoPath, discussionId });

export const ghDiscussionDelete = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_delete", { repoPath, discussionId });
