import { refreshFailed } from "@/features/conversations/remote-section-state";

/** Why the composer can't post yet: the diff on screen is this pull request's
 *  at an older head, and a line counted in it would be anchored in the new
 *  head's. A moved answer under check (`headChecking`) holds too, with or
 *  without a text shown, and so does a target with no own answer yet
 *  (`headProving`, on the cold reasons): `loading` while a read runs or
 *  waits, `failed` or `offline` once it failed or parked. */
export type HeadPendingKind = "loading" | "failed" | "offline";

/** Keyed on the same arms as the diff pane's notice, so `failed` shows exactly
 *  when its Retry does. */
export function headPendingKind(read: {
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
}): HeadPendingKind {
  if (read.isPaused) return "offline";
  if (refreshFailed(read)) return "failed";
  return "loading";
}

// The reasons state the hold and promise nothing: a file whose section the push
// changed drops the composer when the new diff lands.
export const HEAD_PENDING_REVIEW_REASON: Record<
  HeadPendingKind,
  (noun: string) => string
> = {
  loading: (noun) =>
    `This ${noun} was updated and its new diff is still loading.`,
  failed: (noun) =>
    `This ${noun} was updated and its new diff couldn't load. Retry above the diff.`,
  offline: (noun) =>
    `This ${noun} was updated, and its new diff can't load while you're offline.`,
};

/** Why the composer and Submit review hold over this head's own text when no
 *  head read has proven it (an older head's text keeps the arms above): it
 *  claims no update, since none is known in this state. */
export const HEAD_UNPROVEN_REVIEW_REASON = (noun: string) =>
  `GitDesktop couldn't confirm this diff is the ${noun}'s latest. It checks again when the ${noun} refreshes.`;

/** The older-head reasons of the review controls outside the Files pane (the
 *  Submit review dialog, the direct Approve and Request changes): `failed`
 *  names the tab whose diff notice carries the Retry, since none of them sits
 *  above the diff. */
export const HEAD_PENDING_DIALOG_REASON: Record<
  HeadPendingKind,
  (noun: string) => string
> = {
  loading: HEAD_PENDING_REVIEW_REASON.loading,
  failed: (noun) =>
    `This ${noun} was updated and its new diff couldn't load. Retry it on the Files tab.`,
  offline: HEAD_PENDING_REVIEW_REASON.offline,
};

/** Why the review controls hold while this target has no own answer yet (a
 *  cold open, a switch from another pull request, a first read that failed or
 *  parked): no update is known, so they claim none. */
export const HEAD_COLD_REVIEW_REASON: Record<
  HeadPendingKind,
  (noun: string) => string
> = {
  loading: (noun) => `This ${noun}'s diff is still loading.`,
  failed: (noun) => `This ${noun}'s diff couldn't load. Retry above the diff.`,
  offline: (noun) => `This ${noun}'s diff can't load while you're offline.`,
};

/** The cold reasons outside the Files pane: `failed` names the tab whose
 *  diff notice carries the Retry. */
export const HEAD_COLD_DIALOG_REASON: Record<
  HeadPendingKind,
  (noun: string) => string
> = {
  loading: HEAD_COLD_REVIEW_REASON.loading,
  failed: (noun) =>
    `This ${noun}'s diff couldn't load. Retry it on the Files tab.`,
  offline: HEAD_COLD_REVIEW_REASON.offline,
};

/** The head hold of the Submit review dialog and of the direct Approve and
 *  Request changes, in the composer's order: an older head's or a moved
 *  answer under check's (loading, failed or offline), a cold proof's, then an
 *  unproven head's. */
export function submitReviewHeadHold(
  pending: HeadPendingKind | null,
  cold: HeadPendingKind | null,
  unproven: boolean,
  noun: string,
): string | null {
  if (pending !== null) return HEAD_PENDING_DIALOG_REASON[pending](noun);
  if (cold !== null) return HEAD_COLD_DIALOG_REASON[cold](noun);
  if (unproven) return HEAD_UNPROVEN_REVIEW_REASON(noun);
  return null;
}
