// Which rows @git-diff-view renders for a diff: hunk starts, hunk 0's `@@` row,
// where each hunk's buttons are hosted, and whether any rows render at all;
// plus the focus, row and line-anchor helpers both diff surfaces share.
// React-free with type-only imports, so scripts/diff-pane-hold.test.mjs and
// scripts/diff-rows.test.mjs load it under Node's type stripping.
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

/** Where a hunk's buttons (Stage + Discard, or Unstage on a staged diff) live:
 *  overlaid on its `@@` row, in its inline header, in the pane-top bar, or
 *  nowhere. */
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

/** Keys that scroll the pane from a focused hunk button without activating it.
 *  Space activates every focusable control in the pane, so it is not one. */
export const PANE_SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);

/** Moves focus to `target` only while it is where the hunk action left it: the
 *  pressed button had focus at the press and still does, or lost it to <body>
 *  because the button unmounted. Anywhere else, the user moved it. Returns
 *  whether it moved. */
export function landHunkFocus(
  pending: { button: HTMLElement; hadFocus: boolean },
  target: HTMLElement | null | undefined,
): boolean {
  if (!target || !pending.hadFocus || !target.isConnected) return false;
  const active = document.activeElement;
  const kept =
    active === pending.button ||
    ((active === null || active === document.body) &&
      !pending.button.isConnected);
  if (kept) target.focus({ preventScroll: true });
  return kept;
}

/** The number span for a line. Unified mode tags it `data-line-{new,old}-num`;
 *  split mode uses a generic `data-line-num` inside a cell marked `data-side`.
 *  Try both so either view works; a caller that knows it is in split passes
 *  `split` to skip the unified probe, which can never match there. A placeholder
 *  (a split row's empty side) carries no such span, so it can never resolve.
 *  PRECONDITION: only the wrap-mode split renderer puts `data-side` on the
 *  CELLS (the normal one puts it on the row and splits the sides across two
 *  tables), so the split arm here and in `splitRowSpans` requires the view's
 *  `diffViewWrap`. */
export function numSpanForLine(
  container: HTMLElement,
  side: "old" | "new",
  line: number,
  split = false,
) {
  const unifiedAttr =
    side === "new" ? "data-line-new-num" : "data-line-old-num";
  return (
    (split
      ? null
      : container.querySelector(`span[${unifiedAttr}="${line}"]`)) ??
    container.querySelector(
      `td[data-side="${side}"] span[data-line-num="${line}"]`,
    )
  );
}

/** The diff row for a line, in either view. */
export function rowForLine(
  container: HTMLElement,
  side: "old" | "new",
  line: number,
) {
  return numSpanForLine(container, side, line)?.closest("tr") ?? null;
}

/** A reading position: the top visible row's line number on each side that has
 *  one, and its top's distance from the scroller's top. Both sides, since a
 *  split row's placeholder side has no number to find it by. `heightPx` is that
 *  row's height; `atTop` marks a pane read at scrollTop 0, which stays there. */
export interface LineAnchor {
  old?: number;
  new?: number;
  offsetPx: number;
  heightPx?: number;
  atTop?: boolean;
}

/** A row showing this little of itself below the top edge reads as scrolled
 *  past: rows lay out at fractional tops, so the row on the edge is the one
 *  read, not the row above it. */
export const ANCHOR_EDGE_PX = 1;

/** A diff row in the scroller's content coordinates, with its line numbers. */
export interface MeasuredRow {
  top: number;
  bottom: number;
  old?: number;
  new?: number;
}

/** The index of the first row whose bottom is below `scrollTop`, or `count`
 *  when none is. Row bottoms grow in document order, so this bisects. */
export function firstRowBelow(
  count: number,
  bottomAt: (index: number) => number,
  scrollTop: number,
): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bottomAt(mid) > scrollTop) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The anchor at the first row reaching more than ANCHOR_EDGE_PX below
 *  `scrollTop` that holds a line number (`@@`, expand and widget rows hold
 *  none), or null. */
export function anchorFromRows(
  rows: readonly MeasuredRow[],
  scrollTop: number,
): LineAnchor | null {
  for (const row of rows) {
    if (row.bottom <= scrollTop + ANCHOR_EDGE_PX) continue;
    if (row.old === undefined && row.new === undefined) continue;
    return {
      old: row.old,
      new: row.new,
      offsetPx: row.top - scrollTop,
      heightPx: row.bottom - row.top,
      atTop: scrollTop <= 0,
    };
  }
  return null;
}

/** The scrollTop that puts a row whose top is at `rowTop` (content
 *  coordinates) and whose height is `rowHeight` back at the anchor's offset.
 *  Absolute, never a delta. A pane read at the top stays at the top. An offset
 *  inside the row scales to the target row's height, since layouts whose rows
 *  differ in height would otherwise land past a shorter row. */
export function restoreTop(
  anchor: LineAnchor,
  rowTop: number,
  rowHeight?: number,
): number {
  if (anchor.atTop) return 0;
  const inRow =
    anchor.offsetPx < 0 && anchor.heightPx && rowHeight !== undefined
      ? (anchor.offsetPx / anchor.heightPx) * rowHeight
      : anchor.offsetPx;
  return rowTop - inRow;
}

/** How long a restore waits for the new layout's rows (one landing later than
 *  this is no longer the switch's), and how long a placed line then holds
 *  against the layout settling under it before scrolls sample again. */
export const RESTORE_BOUND_MS = 1000;

export type RestoreStep =
  | "fire"
  | "wait"
  | "disarm-takeover"
  | "disarm-mode"
  | "disarm-file"
  | "disarm-timeout";

/** What a restore armed at a layout switch does now. Input in the scroller
 *  since the switch, another mode or file than the one it armed for, and the
 *  bound each disarm it, in that order; otherwise it fires once the anchored
 *  row exists. `tookOver` is a latch: the caller never sets it back. */
export function restoreDecision(s: {
  armedMode: string;
  armedFile: string;
  mode: string;
  file: string;
  tookOver: boolean;
  elapsedMs: number;
  rowReady: boolean;
}): RestoreStep {
  if (s.tookOver) return "disarm-takeover";
  if (s.mode !== s.armedMode) return "disarm-mode";
  if (s.file !== s.armedFile) return "disarm-file";
  if (s.elapsedMs >= RESTORE_BOUND_MS) return "disarm-timeout";
  return s.rowReady ? "fire" : "wait";
}

// The rows measured past the first one below the top: enough to step over the
// number-less `@@`, expand and widget rows there.
const ANCHOR_PROBE_ROWS = 16;

/** A row's line numbers from its own number spans, in either layout. */
function rowLines(row: Element): { old?: number; new?: number } {
  const num = (selector: string, attr: string) => {
    const raw = row.querySelector(selector)?.getAttribute(attr);
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isNaN(n) ? undefined : n;
  };
  return {
    old:
      num("span[data-line-old-num]", "data-line-old-num") ??
      num('td[data-side="old"] span[data-line-num]', "data-line-num"),
    new:
      num("span[data-line-new-num]", "data-line-new-num") ??
      num('td[data-side="new"] span[data-line-num]', "data-line-num"),
  };
}

/** The rows `captureLineAnchor` bisects, in document order. */
export function anchorRows(scroller: HTMLElement): ArrayLike<Element> {
  return scroller.querySelectorAll("tr[data-line]");
}

/** The scroller's top visible line, read from the rows rendered in it. A
 *  caller sampling per scrolled frame passes its cached `anchorRows` list, so
 *  a frame costs the bisect's rect reads, never a subtree walk. */
export function captureLineAnchor(
  scroller: HTMLElement,
  rows: ArrayLike<Element> = anchorRows(scroller),
): LineAnchor | null {
  const scrollTop = scroller.scrollTop;
  const origin = scroller.getBoundingClientRect().top - scrollTop;
  const first = firstRowBelow(
    rows.length,
    (i) => rows[i].getBoundingClientRect().bottom - origin,
    scrollTop,
  );
  const measured: MeasuredRow[] = [];
  const end = Math.min(rows.length, first + ANCHOR_PROBE_ROWS);
  for (let i = first; i < end; i++) {
    const rect = rows[i].getBoundingClientRect();
    measured.push({
      top: rect.top - origin,
      bottom: rect.bottom - origin,
      ...rowLines(rows[i]),
    });
  }
  return anchorFromRows(measured, scrollTop);
}

/** The anchor's sides in the order the target layout resolves them: split
 *  pairs a change's sides on one row, so new first; unified lays a change's
 *  deleted lines before its added ones, so old first, or the top line would
 *  move by the deleted block's length. */
export function anchorSides(
  anchor: LineAnchor,
  split: boolean,
): { side: "old" | "new"; line: number }[] {
  const order: ("old" | "new")[] = split ? ["new", "old"] : ["old", "new"];
  return order.flatMap((side) => {
    const line = anchor[side];
    return line === undefined ? [] : [{ side, line }];
  });
}

/** The stand-in for an anchored line a layout doesn't render (context the
 *  library expanded in the other layout only): the nearest rendered line at
 *  or before it on that side, else the first after it. Null when the side
 *  renders no numbered line yet, so a restore keeps waiting only for rows
 *  that can still come. */
export function fallbackLine(
  rendered: Iterable<number>,
  line: number,
): number | null {
  let before: number | null = null;
  let after: number | null = null;
  for (const n of rendered) {
    if (n <= line) {
      if (before === null || n > before) before = n;
    } else if (after === null || n < after) after = n;
  }
  return before ?? after;
}

/** The anchored line's row in the layout `split` names (sides per
 *  `anchorSides`), else its `fallbackLine` stand-in's row. Only that layout's
 *  number spans count, so a row of the layout being replaced never resolves. */
export function anchorRow(
  container: HTMLElement,
  anchor: LineAnchor,
  split: boolean,
): HTMLTableRowElement | null {
  const find = (side: "old" | "new", line: number) => {
    const span = split
      ? numSpanForLine(container, side, line, true)
      : container.querySelector(`span[data-line-${side}-num="${line}"]`);
    return span?.closest("tr") ?? null;
  };
  const sides = anchorSides(anchor, split);
  for (const { side, line } of sides) {
    const row = find(side, line);
    if (row !== null) return row;
  }
  for (const { side, line } of sides) {
    const spans = container.querySelectorAll(
      split
        ? `td[data-side="${side}"] span[data-line-num]`
        : `span[data-line-${side}-num]`,
    );
    const attr = split ? "data-line-num" : `data-line-${side}-num`;
    const rendered: number[] = [];
    for (const span of spans) {
      const n = Number.parseInt(span.getAttribute(attr) ?? "", 10);
      if (!Number.isNaN(n)) rendered.push(n);
    }
    const stand = fallbackLine(rendered, line);
    if (stand !== null) return find(side, stand);
  }
  return null;
}

/** The absolute scrollTop that puts `row` back at the anchor's offset. */
export function anchorScrollTop(
  scroller: HTMLElement,
  row: Element,
  anchor: LineAnchor,
): number {
  const rect = row.getBoundingClientRect();
  const top =
    rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  return restoreTop(anchor, top, rect.bottom - rect.top);
}
