import type { MouseEvent } from "react";

/**
 * Sets a hover `title` only when the content is actually clipped by `truncate` —
 * the repo's only-when-clipped tooltip pattern (PrTimeline, CommitsList,
 * WorktreesDialog, …), hoisted for reuse. Measured lazily on mouse-enter, so it
 * stays honest across resizes and never shows a tooltip for fully-visible text.
 */
export const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};
