import {
  failedAttachmentsOf,
  failedReferencesDraft,
  referencedNames,
} from "./references";
import {
  endDraftAttachments,
  type PostTicket,
  settleAttachmentPost,
} from "./store";

// The host side of a post that may carry staged images: the views and the
// Create PR dialog settle through these so the store's rules (end where the
// text ends, keep failed images, hold posted ones) stay in one place.

/** The partial-failure strip above a comment editor. */
export function partialCommentNotice(failed: readonly string[]): string {
  return failed.length === 1
    ? `Comment posted, but ${failed[0]} didn't upload. It's still attached here, so you can post it in a follow-up comment.`
    : `Comment posted, but ${failed.length} images didn't upload. They're still attached here, so you can post them in a follow-up comment.`;
}

/** The warning toast that replaces Create PR's success toast. */
export function partialCreateWarning(failed: readonly string[]): string {
  return failed.length === 1
    ? `Pull request created, but ${failed[0]} didn't upload. Add it in a comment on the pull request.`
    : `Pull request created, but ${failed.length} images didn't upload. Add them in a comment on the pull request.`;
}

/** Request changes posts the draft through a command that takes no images. */
export const REQUEST_CHANGES_IMAGES_REASON =
  "Post your draft as a comment first. Request changes can't carry images.";

/** Whether `text` references any of the handle's staged images. */
export function referencesStaged(
  text: string,
  images: readonly { name: string }[],
): boolean {
  return (
    referencedNames(
      text,
      images.map((i) => i.name),
    ).length > 0
  );
}

/**
 * Settles a comment that landed. Without a ticket the draft simply ended; with
 * one, failed images stay attached and the text they need comes back (null when
 * every image posted, or when the draft was ended mid-post and they went too).
 */
export function landCommentPost(
  draftKey: string,
  ticket: PostTicket | null,
  body: string,
  outcome: unknown,
): string | null {
  if (ticket === null) {
    endDraftAttachments(draftKey);
    return null;
  }
  const failed = failedAttachmentsOf(outcome);
  const kept = settleAttachmentPost(ticket, { posted: true, failed });
  return kept ? failedReferencesDraft(body, failed) : null;
}

/** A post that failed left every staged file in place: only `posting` clears. */
export function failCommentPost(ticket: PostTicket | null) {
  if (ticket !== null)
    settleAttachmentPost(ticket, { posted: false, failed: [] });
}

/** D13: an empty box becomes the failed references; typed text keeps its place
 *  and gains them after a blank line. */
export function withFailedReferences(prev: string, draft: string): string {
  return prev.trim() ? `${prev.trimEnd()}\n\n${draft}` : draft;
}
