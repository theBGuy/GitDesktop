import type { QueryClient } from "@tanstack/react-query";
import type { RemoteLens } from "@/lib/git/types";
import {
  markReviewPosted,
  type PersistedReview,
  reviewHistoryKey,
  reviewPartialKey,
} from "@/lib/pulls/reviews-history";

/** The stored record a manual post stamps, with the review scope it was posted
 *  under: pinned by the caller before any await, so a PR switch never moves it. */
export interface ReviewStampTarget {
  repo: string;
  lens: RemoteLens;
  kind: "remote" | "local";
  ref: string;
  id: string;
}

/** `data` with the record `id` stamped, or `data` itself when it holds no such
 *  record. Covers both cache shapes under the keys: a record list (completed
 *  reviews, the partials list) and the single latest partial. */
function withPosted(data: unknown, id: string, postedAt: number): unknown {
  if (Array.isArray(data)) {
    if (!data.some((r: PersistedReview | undefined) => r?.id === id))
      return data;
    return data.map((r: PersistedReview) =>
      r?.id === id ? { ...r, postedAt } : r,
    );
  }
  if (
    typeof data === "object" &&
    data !== null &&
    (data as PersistedReview).id === id
  )
    return { ...(data as PersistedReview), postedAt };
  return data;
}

/**
 * Stamps a posted review, shared by the live Post and a history row's Post so both
 * surfaces read "posted" the moment the comment lands. Fire-and-forget: patches
 * the cached copies (only caches holding the record; it never creates an entry),
 * then writes the store and re-reads both keys. A failed write re-reads too, which
 * rolls the patch back to store truth; nothing is surfaced, since the comment
 * itself landed. It cancels in-flight reads of both keys first: one started before
 * the stamp would land the pre-stamp store copy over the patch.
 */
export function stampReviewPosted(
  queryClient: QueryClient,
  { repo, lens, kind, ref, id }: ReviewStampTarget,
): void {
  const postedAt = Date.now();
  // The partial key is a prefix of the partials list's, so it reaches both.
  const keys = [
    reviewHistoryKey(repo, lens, kind, ref),
    reviewPartialKey(repo, lens, kind, ref),
  ];
  void (async () => {
    // Awaited, so no revert of a cancelled fetch can land after the patch. With
    // nothing in flight it resolves at once, so the patch lands before a next click.
    await Promise.all(
      keys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    );
    for (const queryKey of keys) {
      for (const [key, data] of queryClient.getQueriesData({ queryKey })) {
        const next = withPosted(data, id, postedAt);
        if (next !== data) queryClient.setQueryData(key, next);
      }
    }
    try {
      await markReviewPosted(repo, id, postedAt);
    } finally {
      await Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    }
  })().catch(() => undefined);
}
