import type { RepoLabel } from "./forge";

export interface DiscussionCategory {
  id: string;
  name: string;
  /** The category glyph (e.g. "🏎️"); may be empty. */
  emoji: string;
  isAnswerable: boolean;
}

export interface DiscussionMeta {
  /** GraphQL node id of the repository — needed to create a discussion. */
  repoId: string;
  hasDiscussionsEnabled: boolean;
  categories: DiscussionCategory[];
}

export interface DiscussionInfo {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isAnswered: boolean;
  closed: boolean;
  stateReason: string | null;
  categoryName: string;
  categoryEmoji: string;
  author: string;
  commentCount: number;
  upvoteCount: number;
  labels: RepoLabel[];
}

export interface DiscussionReply {
  id: string;
  author: string;
  body: string;
  date: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
}

export interface DiscussionComment {
  id: string;
  author: string;
  body: string;
  date: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  /** Whether this comment is the discussion's accepted answer. */
  isAnswer: boolean;
  replies: DiscussionReply[];
}

export interface DiscussionDetails {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  createdAt: string;
  categoryName: string;
  categoryEmoji: string;
  /** Whether the category accepts answers (Q&A) — gates "Mark as answer". */
  isAnswerable: boolean;
  isAnswered: boolean;
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  locked: boolean;
  /** GitHub's lock reason (OFF_TOPIC/TOO_HEATED/RESOLVED/SPAM) or null. */
  activeLockReason: string | null;
  closed: boolean;
  /** Close reason (RESOLVED/OUTDATED/DUPLICATE) or null. */
  stateReason: string | null;
  labels: RepoLabel[];
  comments: DiscussionComment[];
}
