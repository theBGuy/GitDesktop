import type { MouseEvent } from "react";

/**
 * Sets a hover `title` only when the content is actually clipped by `truncate` —
 * the repo's only-when-clipped tooltip pattern (PrTimeline, CommitsList,
 * WorktreesDialog, …), hoisted for reuse. Measured lazily on mouse-enter, so it
 * stays honest across resizes and never shows a tooltip for fully-visible text.
 */
export const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  // Clear by REMOVING the attribute: an empty `title` states that the ancestor's
  // does not apply, which would suppress a titled parent's tooltip (HTML). An
  // empty or whitespace-only `value` takes the remove branch for the same reason.
  const v = value.trim();
  if (v && el.scrollWidth > el.clientWidth) el.title = v;
  else el.removeAttribute("title");
};

/**
 * `clipTitle` for elements whose full text IS their own `textContent`: no value
 * to pass, and clipping is measured on both axes so `line-clamp-*` (vertical)
 * counts as clipped alongside `truncate` (horizontal). Same remove-don't-blank
 * contract as `clipTitle`.
 */
export const clipTitleFromText = (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  // Empty/whitespace text takes the remove branch — assigning "" here would
  // re-mint the blank-title suppression this helper exists to eliminate.
  const text = el.textContent?.trim();
  if (
    text &&
    (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
  )
    el.title = text;
  else el.removeAttribute("title");
};
