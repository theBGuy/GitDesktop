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
  // does not apply, which would suppress a titled parent's tooltip (HTML).
  if (el.scrollWidth > el.clientWidth) el.title = value;
  else el.removeAttribute("title");
};
