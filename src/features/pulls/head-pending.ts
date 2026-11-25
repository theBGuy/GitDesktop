import { refreshFailed } from "@/features/conversations/remote-section-state";

/** Why the composer can't post yet: the diff on screen is this pull request's
 *  at an older head, and a line counted in it would be anchored in the new
 *  head's. */
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

/** Why the composer and Submit review hold over a diff no head read has
 *  proven: it claims no update, since none is known in this state. */
export const HEAD_UNPROVEN_REVIEW_REASON = (noun: string) =>
  `GitDesktop couldn't confirm this diff is the ${noun}'s latest. It checks again when the ${noun} refreshes.`;

/** The older-head reasons of the review controls outside the Files pane (the
 *  Submit review dialog, the direct Approve): `failed` names the tab whose
 *  diff notice carries the Retry, since neither sits above the diff. */
export const HEAD_PENDING_DIALOG_REASON: Record<
  HeadPendingKind,
  (noun: string) => string
> = {
  loading: HEAD_PENDING_REVIEW_REASON.loading,
  failed: (noun) =>
    `This ${noun} was updated and its new diff couldn't load. Retry it on the Files tab.`,
  offline: HEAD_PENDING_REVIEW_REASON.offline,
};

/** The Submit review dialog's head hold, in the composer's order: an older
 *  head's reason, then an unproven head's. */
export function submitReviewHeadHold(
  pending: HeadPendingKind | null,
  unproven: boolean,
  noun: string,
): string | null {
  if (pending !== null) return HEAD_PENDING_DIALOG_REASON[pending](noun);
  if (unproven) return HEAD_UNPROVEN_REVIEW_REASON(noun);
  return null;
}
