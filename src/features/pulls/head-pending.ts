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

// The reasons state the hold and promise nothing: what the new diff does to an
// open composer (restored on its line, or its file's earlier rows kept) is the
// diff's call, in editor-keep.tsx.
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
