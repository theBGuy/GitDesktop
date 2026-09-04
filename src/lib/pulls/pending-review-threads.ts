import type { ReviewThreadOut } from "@/lib/git/types";

/**
 * Drops the line comments belonging to unsubmitted (PENDING) reviews from a threads
 * list — whole threads one of those reviews opened, plus its draft replies inside
 * threads somebody else opened.
 *
 * Both halves are needed: a thread carries only its FIRST comment's review id, so a
 * draft REPLY on an already-submitted thread rides through the thread-level test.
 * They come back from the threads read but stay drafts on the forge until the review
 * is finished or discarded, so rendering them as ordinary threads would offer Reply
 * and Resolve on comments nobody else can see. `ids` must hold no `""` — GitLab and
 * Bitbucket threads carry `reviewId: ""`, and an empty member would swallow all of them.
 *
 * Thread identity is preserved wherever nothing was dropped, so unaffected rows keep
 * the object reference their rendered cards key and memoize on.
 */
export function dropDraftsByReviewIds(
  threads: ReviewThreadOut[],
  ids: ReadonlySet<string>,
): ReviewThreadOut[] {
  return threads.flatMap((t) => {
    if (ids.has(t.reviewId)) return [];
    const comments = t.comments.filter((c) => !ids.has(c.reviewId));
    if (comments.length === 0) return [];
    return [comments.length === t.comments.length ? t : { ...t, comments }];
  });
}
