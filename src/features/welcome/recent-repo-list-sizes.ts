// This column at its tallest, which the Welcome reserves so filtering or loading
// never changes the centered block's height: the heading row (the `text-sm` h2's
// line box), the `space-y-2` gap, the box's `border`, and RepoList's own maximum.
// Each px figure mirrors its class at a 16px root, so a size change edits both;
// scripts/repo-list-sizes.test.mjs enforces it.
import { REPO_LIST_MAX_HEIGHT_PX } from "../repository/repo-list-sizes.ts";

export const COLUMN_CLASS = "min-w-0 space-y-2";
export const COLUMN_GAP_PX = 8;
export const HEADING_CLASS = "font-heading text-sm font-medium";
export const HEADING_ROW_PX = 20;
export const BOX_CLASS = "overflow-hidden rounded-none border";
export const BOX_BORDER_PX = 1;
export const RECENT_REPO_LIST_MAX_HEIGHT_PX =
  HEADING_ROW_PX + COLUMN_GAP_PX + 2 * BOX_BORDER_PX + REPO_LIST_MAX_HEIGHT_PX;
// The rem part scales with the root font like the rem classes it mirrors; the
// `border` stays a fixed 1px per side, so it stays px.
export const RECENT_REPO_LIST_MAX_HEIGHT_CSS = `calc(${
  (RECENT_REPO_LIST_MAX_HEIGHT_PX - 2 * BOX_BORDER_PX) / 16
}rem + ${2 * BOX_BORDER_PX}px)`;
