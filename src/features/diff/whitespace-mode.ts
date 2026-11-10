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
  "Finish or close the comment you're writing, then change the whitespace view.";

export const WHITESPACE_ONLY_MESSAGE = "Only whitespace changed in this file";

export const SHOW_WHITESPACE_LABEL = "Show whitespace";
