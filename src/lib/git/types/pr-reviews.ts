import type { ForgeUserRef } from "./forge";

/** When the viewer last reviewed a PR, against when the PR last changed — the
 *  review-state grouping compares the two to split "reviewed" from "needs another
 *  look". Both are ISO-8601. */
export interface ReviewStateEntry {
  lastReviewedAt: string;
  updatedAt: string;
}

/** PR number → the viewer's review state; a number ABSENT from entries = not reviewed
 *  (callers derive "not reviewed" by subtraction against the visible rows). */
export interface ReviewStatePage {
  entries: Record<number, ReviewStateEntry>;
  /** The server walk couldn't cover the list's own page, so an absent number may still
   *  have been reviewed. A capped walk alone does NOT set this: the list and the
   *  reviewed-by search share a scope and a sort, so a walk at least as deep as the
   *  page already holds every reviewed row on screen. */
  truncated: boolean;
}

/** One pending draft comment in a batch review submission — a file:line-anchored
 *  note the reviewer stages before submitting the whole review at once. */
export interface DraftCommentIn {
  path: string;
  line: number;
  /** "new" (right side) or "old" (left side). */
  side: "new" | "old";
  /** First line of a multi-line range (1-based); omitted for a single line. */
  startLine?: number;
  body: string;
}

/** The outcome of submitting a batch review: how many draft comments posted out
 *  of the total, and whether the verdict (approve / request changes) applied. */
export interface ReviewSubmitOut {
  posted: number;
  total: number;
  verdictApplied: boolean;
}

export interface PrThreadOut {
  author: string;
  /** The comment author's avatar URL when the provider supplies one
   *  (GitLab/Bitbucket). Empty for GitHub, where it's login-derived. */
  authorAvatarUrl: string;
  /** Review state (APPROVED/COMMENTED/CHANGES_REQUESTED); "" for comments. */
  state: string;
  body: string;
  date: string;
  /** GraphQL node id — a review's `PRR_…` id or a conversation comment's node id;
   *  `""` only when the source supplies none. A review's `id` is matched against a
   *  thread's `reviewId` to attach that review's line comments inline. */
  id: string;
  /** Permalink on GitHub ("" for reviews/local) — for "Copy link". */
  url: string;
  /** Whether the signed-in user wrote it (only their own comments are editable). */
  viewerDidAuthor: boolean;
  /** Whether the comment is hidden (minimized), and GitHub's recorded reason. */
  isMinimized: boolean;
  minimizedReason: string;
  /** The owning review's id when this row is a review-thread comment (GitHub
   *  populates it today, from the comment's own `pullRequestReview`); empty for
   *  review/conversation rows and on GitLab/Bitbucket. Lets the timeline tie
   *  GitHub's empty reply-wrapper reviews back to the thread they wrap. */
  reviewId: string;
}

/** One file:line-anchored review thread, provider-neutral (GitHub reviewThread /
 *  GitLab diff-note discussion / Bitbucket inline-comment chain). */
export interface ReviewThreadOut {
  /** Provider thread id (GitHub node id / GitLab discussion id / Bitbucket root comment id). */
  id: string;
  /** GraphQL id of the review that owns this thread (GitHub `PRR_…`); "" =
   *  unknown / the provider doesn't model reviews (always "" on GitLab/Bitbucket). */
  reviewId: string;
  path: string;
  /** 1-based anchored line; 0 = unknown (e.g. outdated threads). */
  line: number;
  /** First line of a multi-line range (1-based); 0 = single-line. */
  startLine: number;
  /** "new" (right side) or "old" (left side). */
  side: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Unified-diff hunk excerpt the thread anchors to (GitHub diffHunk); "" when
   *  the provider has none (GitLab/Bitbucket). */
  diffHunk: string;
  /** Full reply chain, oldest first. */
  comments: PrThreadOut[];
}

/** A reviewer who has submitted a verdict, as supplied by the backend (GitLab
 *  approvals, Bitbucket participant states). The `state` is uppercased —
 *  APPROVED / CHANGES_REQUESTED / COMMENTED. */
export interface CompletedReviewerWithState {
  user: ForgeUserRef;
  state: string;
}

/** One review item on a PR/MR with its author's bot flag — the raw material a re-review
 *  folds in from third-party AI reviewers. From `forge_pr_external_reviews` (GitHub
 *  reviews / GitLab MR discussions; Bitbucket returns none). */
export interface ExternalReviewItem {
  /** `review` = a submitted review body, `inline` = a file:line review comment,
   *  `comment` = a conversation comment, `reply` = a follow-up comment inside a
   *  review thread (emitted by the GitHub harvest for thread replies; GitLab
   *  continues to emit replies as `inline`/`comment`). */
  kind: "review" | "inline" | "comment" | "reply";
  author: string;
  isBot: boolean;
  body: string;
  /** File path for `inline` items ("" otherwise). */
  path: string;
  /** 1-based line for `inline` items (0 when unknown / outdated). */
  line: number;
  /** Commit OID the item was made against ("" when unknown) — for staleness. */
  commitSha: string;
  /** Submitted-review state (APPROVED/CHANGES_REQUESTED/COMMENTED); "" otherwise. */
  state: string;
  /** Inline only: GitHub's thread flags (`isOutdated` = the anchored line moved). */
  isResolved: boolean;
  isOutdated: boolean;
  createdAt: string;
}
