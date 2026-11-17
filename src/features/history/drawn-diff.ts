import { sameDiffContent } from "@/lib/git/diff-content";
import type { FileDiff } from "@/lib/git/types";

/** What the History host knows about the selected file's diff read. */
export interface DrawnDiffInput {
  selectedPathProp: string | null;
  shownDiff: { data: FileDiff | undefined; isPlaceholderData: boolean };
  hash: string;
  renderedHash: string;
  retainedDiff: { hash: string; path: string; data: FileDiff } | null;
}

/**
 * The diff the comment list may judge its comments against: the rendered
 * commit's settled read of the listed path, the only one the pane's anchors are
 * placed on. Stricter than the slot's own gate on purpose: during a file switch
 * the previous file's placeholder never judges the new file's comments.
 */
export function drawnDiffFor({
  selectedPathProp,
  shownDiff,
  hash,
  renderedHash,
  retainedDiff,
}: DrawnDiffInput): FileDiff | null {
  if (selectedPathProp === null || shownDiff.data === undefined) return null;
  if (!shownDiff.isPlaceholderData)
    return hash === renderedHash && shownDiff.data.filePath === selectedPathProp
      ? shownDiff.data
      : null;
  return retainedDiff?.hash === renderedHash &&
    retainedDiff.path === selectedPathProp &&
    sameDiffContent(retainedDiff.data, shownDiff.data)
    ? retainedDiff.data
    : null;
}
