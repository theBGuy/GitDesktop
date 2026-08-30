/**
 * Narrowest container that still fits a side-by-side diff: below it a split
 * view keeps under ~40 monospace columns per side once the ~91px of line-number
 * and marker gutters are taken out, so the surfaces fall back to unified.
 *
 * Its own module rather than a member of `cap-diff`: the surfaces that need
 * only the threshold (an agent transcript's inline diff, the conflict preview)
 * reach the renderer itself through a lazy boundary, and importing the cap
 * helpers to get one number would pull them back into the eager chunk.
 */
export const SPLIT_MIN_CONTAINER_PX = 672;
