/**
 * The confirm a manual AI-review post asks before posting, shared by the live
 * Post (PrReviewPanel) and a history row's Post (ReviewHistory) so identical
 * inputs ask in identical words. Every reason merges into ONE dialog: the
 * confirm store keeps one request live, so a second ask would cancel the first.
 *
 * Import-free at runtime but for the dependency-free comment-branding module:
 * `scripts/review-post-confirm.test.mjs` loads it straight from `src/` under
 * Node's type stripping, which resolves no bundler aliases.
 */

import { formatRefList } from "../ai/comment-branding.ts";
import type { ReviewMode } from "../ai/types.ts";
import type { PersistedReview } from "./reviews-history.ts";

/** Why the text may be incomplete: the run stopped before it finished. */
export type ReviewIncomplete = "cancelled" | "timed-out" | "failed";

/** A stored record's stop, for the post confirm; a completed review is whole.
 *  Mirrors `isPartialReview` / `partialReviewReason` (exact-value compares over
 *  untrusted store JSON), which this import-free module can't reach at runtime. */
export function recordIncomplete(
  r: Pick<PersistedReview, "phase" | "timedOut">,
): ReviewIncomplete | null {
  if (r.phase !== "error") return null;
  return r.timedOut === true ? "timed-out" : "failed";
}

/** The success toast after a manual post, named by the posted text's mode. */
export function reviewPostedToast(mode: ReviewMode): string {
  return mode === "security"
    ? "Security audit posted to the conversation"
    : "Review posted to the conversation";
}

export type ReviewPostConfirm = {
  title: string;
  body: string;
  confirmLabel: string;
};

const INCOMPLETE_SENTENCE: Record<ReviewIncomplete, string> = {
  cancelled:
    "This run was cancelled before it finished, so the text may be incomplete.",
  "timed-out":
    "This run timed out before it finished, so the text may be incomplete.",
  failed: "This run failed before completing, so the text may be incomplete.",
};

const ALREADY_SENTENCE =
  "This review was already posted to the conversation — posting it again adds a second comment.";

/** The confirm for a post with these reasons to ask, or null to post without
 *  asking. Title precedence: incomplete, then already posted, then live refs. */
export function reviewPostConfirm({
  incomplete,
  already,
  suspectRefs,
}: {
  incomplete: ReviewIncomplete | null;
  already: boolean;
  suspectRefs: string[];
}): ReviewPostConfirm | null {
  const hasRefs = suspectRefs.length > 0;
  if (!incomplete && !already && !hasRefs) return null;
  const sentences: string[] = [];
  if (incomplete) sentences.push(INCOMPLETE_SENTENCE[incomplete]);
  if (already) sentences.push(ALREADY_SENTENCE);
  if (hasRefs) {
    const tail =
      suspectRefs.length === 1
        ? "it becomes a live cross-reference that notifies the thread it names. Backticks keep it plain."
        : "each becomes a live cross-reference that notifies the thread it names. Backticks keep them plain.";
    sentences.push(
      `The text mentions ${formatRefList(suspectRefs)} — posted as-is, ${tail}`,
    );
  }
  sentences.push("Post it as a comment anyway?");
  return {
    title: confirmTitle(incomplete, already),
    body: sentences.join(" "),
    confirmLabel: incomplete || hasRefs ? "Post anyway" : "Post again",
  };
}

function confirmTitle(
  incomplete: ReviewIncomplete | null,
  already: boolean,
): string {
  if (incomplete) return "Post partial review?";
  if (already) return "Post this review again?";
  return "Post review with live references?";
}
