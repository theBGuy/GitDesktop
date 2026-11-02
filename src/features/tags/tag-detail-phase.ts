// What a tag's detail pane paints while its release reads settle. The release
// LIST decides whether a skeleton is owed; the per-tag DETAIL stays the truth,
// so a release the list missed still swaps in, never behind a skeleton. Kept
// free of runtime imports so scripts/tag-detail-phase.test.mjs can load it.

export type TagReleasePhase = "skeleton" | "release" | "plain";

export interface TagReleaseInputs {
  /** The forge is ready to answer release reads. */
  ghReady: boolean;
  /** The list's first fetch is actively running (false while paused). */
  listLoading: boolean;
  /** The answered list has a row for this tag. */
  listHasRelease: boolean;
  /** This tag's own first detail answer is actively in flight. A placeholder
   *  reads as success, so `isLoading` can't stand in; `isFetched` keeps a
   *  post-404 refetch from counting as a first load. */
  detailFirstLoad: boolean;
  detailFetching: boolean;
  detailErrored: boolean;
  /** The detail holds THIS tag's release (tag names match), never another
   *  tag's placeholder. */
  heldRelease: boolean;
  createReleaseOpen: boolean;
  /** The plain arm already painted for this tag. */
  paintedLocal: boolean;
}

export function tagReleasePhase(i: TagReleaseInputs): {
  phase: TagReleasePhase;
  checkingLine: boolean;
  errorLine: boolean;
  latchLocal: boolean;
} {
  if (i.heldRelease)
    return {
      phase: "release",
      checkingLine: false,
      errorLine: false,
      latchLocal: false,
    };
  // Only before any plain paint: once the local view showed, the next paint is
  // the release itself, so the pane swaps once.
  if (
    i.listHasRelease &&
    i.detailFirstLoad &&
    !i.createReleaseOpen &&
    !i.paintedLocal
  )
    return {
      phase: "skeleton",
      checkingLine: false,
      errorLine: false,
      latchLocal: false,
    };
  const detailAnsweredMiss = i.detailErrored && !i.detailFetching;
  const errorLine = i.ghReady && i.listHasRelease && detailAnsweredMiss;
  // A detail that already answered outranks a list still checking.
  const checkingLine =
    i.ghReady &&
    !errorLine &&
    ((i.listLoading && !detailAnsweredMiss) ||
      (i.listHasRelease && i.detailFetching && !i.detailErrored));
  return { phase: "plain", checkingLine, errorLine, latchLocal: true };
}
