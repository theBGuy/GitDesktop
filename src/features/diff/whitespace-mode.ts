// No runtime imports: scripts/hide-whitespace.test.mjs loads this under Node.
import type { StagingSide } from "./undecodable-note";

type WriteKind = "stage" | "unstage" | "discard";

/** A diff read with whitespace hidden: its hunks skip lines and carry new-side
 *  context, so no patch may be built from it. */
export function whitespaceWritesOff(
  d: { whitespaceHidden?: boolean } | undefined,
): boolean {
  return d?.whitespaceHidden === true;
}

/** The Changes diff's note while whitespace is hidden, per side: the staged
 *  side offers Unstage, the others Stage and Discard. */
export const WHITESPACE_STRIP_COPY: Record<StagingSide, string> = {
  unstaged:
    "Whitespace changes are hidden, so hunks and lines can't be staged or discarded from this view.",
  untracked:
    "Whitespace changes are hidden, so hunks and lines can't be staged or discarded from this view.",
  staged:
    "Whitespace changes are hidden, so hunks and lines can't be unstaged from this view.",
};

export const WHITESPACE_HUNK_REASON: Record<WriteKind, string> = {
  stage: "Show whitespace changes to stage this hunk",
  unstage: "Show whitespace changes to unstage this hunk",
  discard: "Show whitespace changes to discard this hunk",
};

export const WHITESPACE_REFUSAL: Record<WriteKind, string> = {
  stage: "Whitespace changes are hidden, so nothing was staged.",
  unstage: "Whitespace changes are hidden, so nothing was unstaged.",
  discard: "Whitespace changes are hidden, so nothing was discarded.",
};

export const WHITESPACE_ANNOUNCEMENT: { hidden: string; shown: string } = {
  hidden: "Whitespace changes are hidden. Hunk and line actions are off.",
  shown: "Whitespace changes are shown.",
};

export const WHITESPACE_COMPOSER_HELD =
  "Finish or close the line comment you're writing (here or in another tab), then change the whitespace view.";

/** The layout twin: switching Unified/Split rebuilds the view, and an open line
 *  composer would lose its text with it. */
export const LAYOUT_COMPOSER_HELD =
  "Finish or close the line comment you're writing (here or in another tab), then change the diff display.";

// Both diff settings are app-wide and hidden tabs keep their DOM under
// `<Activity>`, so a flip from any pane rebuilds a hidden tab's composer too.
// Every writer of either setting checks its probe first
// (scripts/hide-whitespace.test.mjs pins the roster).

/** The layout probe: a line comment composer is open on any diff, since
 *  Unified/Split rebuilds every one. */
export function lineComposerOpen(): boolean {
  return document.querySelector("[data-diff-line-widget]") !== null;
}

/** The whitespace probe: a composer is open on a diff a whitespace flip
 *  re-reads. Its wrapper's `data-diff-line-widget` is "whitespace" exactly on
 *  a host with a whitespace mode (DiffContent's `whitespaceControl`); a forge
 *  patch ("layout") never changes with the setting. */
export function whitespaceComposerOpen(): boolean {
  return (
    document.querySelector('[data-diff-line-widget="whitespace"]') !== null
  );
}

/** The Diff options sheet's helper line, on the working-tree staging hosts
 *  only (the read-only hosts have no staging for it to turn off), per side as
 *  WHITESPACE_STRIP_COPY. */
export const WHITESPACE_SHEET_STAGING_NOTE: Record<StagingSide, string> = {
  unstaged:
    "Line and hunk staging and discards are off while whitespace is hidden.",
  untracked:
    "Line and hunk staging and discards are off while whitespace is hidden.",
  staged: "Line and hunk unstaging is off while whitespace is hidden.",
};

export const WHITESPACE_ONLY_MESSAGE = "Only whitespace changed in this file";

export const SHOW_WHITESPACE_LABEL = "Show whitespace";
