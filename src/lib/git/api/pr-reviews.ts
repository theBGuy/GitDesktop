import { invoke } from "@/lib/tauri/invoke";
import type {
  DraftCommentIn,
  ExternalReviewItem,
  RemoteLens,
  ReviewSubmitOut,
  ReviewThreadOut,
} from "../types";

/** Third-party AI-reviewer findings on a PR/MR (Copilot/CodeRabbit/…), behind the
 *  forge abstraction: GitHub delegates unchanged, GitLab maps MR discussions,
 *  Bitbucket returns empty by design. Shape is provider-agnostic. */
export const forgePrExternalReviews = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ExternalReviewItem[]>("forge_pr_external_reviews", {
    repoPath,
    number,
    lens,
  });

/** File:line-anchored review threads on a PR/MR, provider-neutral (GitHub
 *  reviewThreads / GitLab diff-note discussions / Bitbucket inline comments). */
export const forgePrReviewThreads = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ReviewThreadOut[]>("forge_pr_review_threads", {
    repoPath,
    number,
    lens,
  });

/** Post a reply into an existing review thread. */
export const forgePrThreadReply = (
  repoPath: string,
  number: number,
  threadId: string,
  body: string,
) =>
  invoke<void>("forge_pr_thread_reply", { repoPath, number, threadId, body });

/** Resolve / unresolve a review thread. */
export const forgePrThreadResolve = (
  repoPath: string,
  number: number,
  threadId: string,
  resolved: boolean,
) =>
  invoke<void>("forge_pr_thread_resolve", {
    repoPath,
    number,
    threadId,
    resolved,
  });

/** Create a new file:line-anchored review thread on a PR/MR (distinct from
 *  replying into an existing one). `side` is "new" (right) or "old" (left);
 *  `startLine` opens a multi-line range. */
export const forgePrThreadCreate = (
  repoPath: string,
  args: {
    number: number;
    path: string;
    line: number;
    side: "new" | "old";
    startLine?: number;
    body: string;
  },
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_thread_create", {
    repoPath,
    number: args.number,
    path: args.path,
    line: args.line,
    side: args.side,
    startLine: args.startLine ?? null,
    body: args.body,
    lens,
  });

export type ReviewVerdict = "comment" | "approve" | "request_changes";

/** Submit a batch review — a verdict, an optional summary, and any staged draft
 *  comments posted together. Returns how many comments landed and whether the
 *  verdict applied. */
export const forgePrReviewSubmit = (
  repoPath: string,
  args: {
    number: number;
    verdict: ReviewVerdict;
    summary?: string;
    comments: DraftCommentIn[];
  },
  lens: RemoteLens,
) =>
  invoke<ReviewSubmitOut>("forge_pr_review_submit", {
    repoPath,
    number: args.number,
    verdict: args.verdict,
    summary: args.summary ?? null,
    comments: args.comments,
    lens,
  });
