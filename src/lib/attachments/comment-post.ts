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

/** What a create or edit wrote. The wording doesn't follow `prNoun`: GitLab is
 *  all or nothing, so its outcomes never carry a warning. */
export type ItemKind = "issue" | "pr";

const ITEM_NOUN: Record<ItemKind, string> = {
  issue: "Issue",
  pr: "Pull request",
};

const FOLLOWUP_WARNING: Record<ItemKind, string> = {
  issue:
    "Issue created, but some of its details weren't applied. Check its labels, assignees, milestone and type.",
  pr: "Pull request created, but its labels and assignees weren't applied. Add them from the pull request.",
};

/** The Details heading over a follow-up reason. */
export const FOLLOWUP_HEADING: Record<ItemKind, string> = {
  issue: "Some of its details weren't applied",
  pr: "Its labels and assignees weren't applied",
};

function didntUpload(failed: readonly string[]): string {
  return failed.length === 1
    ? `${failed[0]} didn't upload. Edit the description to add it again.`
    : `${failed.length} images didn't upload. Edit the description to add them again.`;
}

/** The warning that replaces a create's success toast; null when the create
 *  left nothing to warn about. A follow-up failure leads, so the sentence
 *  never opens with a file name. */
export function createdWarning(
  kind: ItemKind,
  failed: readonly string[],
  followupError: string | null,
): string | null {
  if (followupError !== null)
    return failed.length > 0
      ? `${FOLLOWUP_WARNING[kind]} Also, ${didntUpload(failed)}`
      : FOLLOWUP_WARNING[kind];
  if (failed.length > 0)
    return `${ITEM_NOUN[kind]} created, but ${didntUpload(failed)}`;
  return null;
}

/** An edit that saved without its failed images and closed anyway. */
export function updatedWarning(
  kind: ItemKind,
  failed: readonly string[],
): string {
  return `${ITEM_NOUN[kind]} updated, but ${didntUpload(failed)}`;
}

/** The in-dialog line of an edit that saved while its failed images stay
 *  attached for the next Save. */
export function partialEditNotice(failed: readonly string[]): string {
  return failed.length === 1
    ? `Saved, but ${failed[0]} didn't upload. It's still attached here. Save again to add it.`
    : `Saved, but ${failed.length} images didn't upload. They're still attached here. Save again to add them.`;
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

/** An empty box becomes the failed references; typed text keeps its place
 *  and gains them after a blank line. */
export function withFailedReferences(prev: string, draft: string): string {
  return prev.trim() ? `${prev.trimEnd()}\n\n${draft}` : draft;
}
