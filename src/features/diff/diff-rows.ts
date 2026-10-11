// Which rows @git-diff-view renders for a diff: hunk starts, hunk 0's `@@` row,
// where each hunk's buttons are hosted, and whether any rows render at all.
// React-free with type-only imports, so scripts/diff-pane-hold.test.mjs loads it
// under Node's type stripping.
import type { DiffHunk } from "@/lib/git/hunks";

const HUNK_HEADER_RE = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/;

/** A hunk's first old/new line number, from its `@@ -a,b +c,d @@` header. */
export function hunkStart(hunk: DiffHunk, side: "old" | "new"): number {
  const m = hunk.header.match(HUNK_HEADER_RE);
  return m ? Number(side === "new" ? m[3] : m[1]) : 1;
}

export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** A hunk's two ranges from its header; an omitted count means one line. */
export function hunkRange(hunk: DiffHunk): HunkRange {
  const m = hunk.header.match(HUNK_HEADER_RE);
  if (!m) return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** The lines a hunk covers, for its buttons' description: the new range, or
 *  the old one for a deletion-only hunk, which has no new lines. */
export function hunkRangeText(hunk: DiffHunk): string {
  const r = hunkRange(hunk);
  const [start, count] =
    r.newLines > 0 ? [r.newStart, r.newLines] : [r.oldStart, r.oldLines];
  return count === 1 ? `line ${start}` : `lines ${start}–${start + count - 1}`;
}

/**
 * The new-file line directly above a hunk, which anchors its inline header;
 * null for a hunk starting on new line 1 (or an emptied file), where no line
 * above can ever show.
 */
export function headerAnchorLine(hunk: DiffHunk): number | null {
  const start = hunkStart(hunk, "new");
  return start > 1 ? start - 1 : null;
}

/** What an inline header's extend row carries: the hunk's index, plus `side`
 *  for split's old-column half. Always an object: the library renders an extend
 *  row only for a truthy `data`, so a bare index would drop hunk 0. */
export interface HunkHeaderData {
  hunk: number;
  side?: "old";
}

type HeaderExtendMap = Record<string, { data: HunkHeaderData }>;

/**
 * The view's `extendData` for the inline hunk headers, keyed on each hunk's
 * anchor line. The library shows an extend row only while its line is visible,
 * so a header appears once expanding reveals the line above the hunk. Unified
 * feeds the new side alone: a unified row looks up both sides, and the anchor is
 * a context line carrying both numbers, so feeding both would render the header
 * twice in one row. Split adds the old column's half.
 */
export function hunkHeaderExtendData(
  hunks: DiffHunk[],
  split: boolean,
): { oldFile: HeaderExtendMap; newFile: HeaderExtendMap } {
  const oldFile: HeaderExtendMap = {};
  const newFile: HeaderExtendMap = {};
  hunks.forEach((hunk, i) => {
    const anchor = headerAnchorLine(hunk);
    if (anchor === null) return;
    newFile[String(anchor)] = { data: { hunk: i } };
    const oldAnchor = hunkStart(hunk, "old") - 1;
    if (split && oldAnchor >= 1)
      oldFile[String(oldAnchor)] = { data: { hunk: i, side: "old" } };
  });
  return { oldFile, newFile };
}

/** Where a hunk's Stage/Unstage + Discard buttons live: overlaid on its `@@`
 *  row, in its inline header, in the pane-top bar, or nowhere. */
export type HunkHost = "row" | "inline" | "top" | "none";

/**
 * The host for hunk `index`, from the `data-state` of the row rendered directly
 * above its first row: the library's collapsed-gap row (`hunk`) or our inline
 * header's extend row (`extend`). With neither, only hunk 0 has a host, the
 * pane-top bar: nothing renders above a hunk starting on line 1.
 */
export function hunkHost(
  prevRowState: string | null | undefined,
  index: number,
): HunkHost {
  if (prevRowState === "hunk") return "row";
  if (prevRowState === "extend") return "inline";
  return index === 0 ? "top" : "none";
}

/**
 * Whether @git-diff-view renders a `@@` row above the diff's first hunk. Mirrors
 * the library: core gives a hunk a row entry only when the line after its header
 * is context, and the first hunk's row hides when it starts at new line 1.
 */
export function firstHunkHasSepRow(hunk: DiffHunk): boolean {
  const bodyStart = hunk.text.indexOf("\n") + 1;
  return (
    hunkStart(hunk, "new") > 1 &&
    bodyStart > 0 &&
    hunk.text.charAt(bodyStart) === " "
  );
}

/**
 * Whether a built @git-diff-view DiffFile will render any rows. `initRaw` sets
 * `diffLineLength` from the hunk lines it parsed; with none (an empty new or
 * deleted file, a mode-only change, a pure rename or copy) the view renders no
 * rows in content or hunk-only mode, so a settle gate must not wait for any.
 */
export function diffRendersRows(file: { diffLineLength: number }): boolean {
  return file.diffLineLength > 0;
}

/**
 * Collapses the context expanded in either layout. The library keeps unified
 * and split expansion apart, and one Collapse bar stands for both: collapsing
 * only the layout on screen would leave the other expanded behind a toggle,
 * with nothing left to collapse it.
 */
export function collapseAllContext(file: {
  onAllCollapse: (mode: "split" | "unified") => void;
}): void {
  file.onAllCollapse("split");
  file.onAllCollapse("unified");
}
