// RepoList at its tallest: the filter row (`p-2` around an `h-7` input) plus the
// list viewport at its cap. Each px figure mirrors the class beside it, so a size
// change edits both; the Welcome builds its reserved height on this maximum.
// scripts/repo-list-sizes.test.mjs enforces the mirror (Tailwind spacing at a
// 16px root). Pure constants with no imports, so Node can load this file.
export const FILTER_ROW_CLASS = "shrink-0 p-2";
export const FILTER_ROW_PADDING_PX = 8;
export const FILTER_INPUT_CLASS = "h-7";
export const FILTER_INPUT_HEIGHT_PX = 28;
export const LIST_VIEWPORT_CLASS =
  "min-h-0 **:data-[slot=scroll-area-viewport]:max-h-96";
export const LIST_VIEWPORT_MAX_HEIGHT_PX = 384;
export const REPO_LIST_MAX_HEIGHT_PX =
  2 * FILTER_ROW_PADDING_PX +
  FILTER_INPUT_HEIGHT_PX +
  LIST_VIEWPORT_MAX_HEIGHT_PX;
