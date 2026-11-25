// What a diff pane has mounted now, and where each resolved comment goes:
// inline in the pane, or in its host's list. Membership reads the anchor rows
// mounted, never a patch's text: the library builds rows in its own passive
// effect, so text says "drawn" before any row exists. React-free so
// scripts/painted-view.test.mjs loads it under Node's type stripping
// (relative runtime imports carry their .ts suffix).
import { patchLines } from "../../lib/git/diff-split.ts";
import {
  capDiffText,
  DIFF_LINE_CAP,
  DIFF_MEGA_LINE_CHARS,
  longestLineLength,
} from "./cap-diff.ts";

/** What keeps a diff's rows from drawing the rest of its patch: the line cap
 *  until Show full diff, the mega-line placeholder until Show diff anyway,
 *  Markdown Preview until Raw, or a paint still loading. */
export type PaintedCut = "cap" | "mega-line" | "preview" | "pending";

/** A line anchor's identity in a report: its side and its line there. */
export function anchorKey(side: "old" | "new", line: number): string {
  return `${side}:${line}`;
}

/** What one diff pane has mounted now. `patch` is the text its rows were built
 *  from (an arm with no rows names its data's), `whitespaceHidden` that
 *  build's `-w` mark, `truncated` whether that read was cut short (a line it
 *  lacks may lie past the cut), `cut` what holds part of the patch back, and
 *  `anchors` the sorted {@link anchorKey}s of the anchor rows mounted now. */
export interface PaneReport {
  path: string;
  patch: string;
  whitespaceHidden: boolean;
  truncated: boolean;
  cut: PaintedCut | null;
  anchors: readonly string[];
}

/** The visible slot's report, as the host relays it. */
export type PaintedView = PaneReport;

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export function samePaneReport(
  a: PaneReport | null,
  b: PaneReport | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.path === b.path &&
    a.patch === b.patch &&
    a.whitespaceHidden === b.whitespaceHidden &&
    a.truncated === b.truncated &&
    a.cut === b.cut &&
    sameKeys(a.anchors, b.anchors)
  );
}

/** The anchor rows one diff build has mounted, counted per key: a key can
 *  mount twice (a remount's new row commits before the old one's cleanup is
 *  read), and it stays mounted until its last row leaves. */
export interface AnchorRegistry {
  /** One row of `key` mounted; the returned release unmounts it once. */
  add(key: string): () => void;
  subscribe(onChange: () => void): () => void;
  /** The mounted keys, sorted; the same array until the set changes. */
  snapshot(): readonly string[];
}

export function createAnchorRegistry(): AnchorRegistry {
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let keys: readonly string[] = [];
  const changed = () => {
    keys = [...counts.keys()].sort();
    for (const listener of [...listeners]) listener();
  };
  return {
    add(key) {
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      if (n === 0) changed();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(key) ?? 1) - 1;
        if (left > 0) {
          counts.set(key, left);
          return;
        }
        counts.delete(key);
        changed();
      };
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    snapshot: () => keys,
  };
}

/** A pane host's one view of its visible slot's report. Only a visible slot
 *  sets it; a slot that stops being visible clears only its own, so a newer
 *  visible slot's view stands whatever order their effects run in. */
export interface PaintedRelay {
  subscribe(onChange: () => void): () => void;
  /** Null while no visible slot reports (nothing is inline). */
  view(): PaintedView | null;
  set(owner: object, view: PaintedView | null): void;
  clear(owner: object): void;
}

export function createPaintedRelay(): PaintedRelay {
  const listeners = new Set<() => void>();
  let owner: object | null = null;
  let current: PaintedView | null = null;
  const put = (next: PaintedView | null) => {
    if (current === next || samePaneReport(current, next)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    view: () => current,
    set(by, view) {
      owner = by;
      put(view);
    },
    clear(by) {
      if (owner !== by) return;
      owner = null;
      put(null);
    },
  };
}

/** A comment of the reported file; `line` is null when the host could not
 *  resolve its position to a line. */
export interface PlaceableComment {
  id: string;
  side: "old" | "new";
  line: number | null;
}

/** A pane control that draws more of the patch: Raw (Markdown Preview's
 *  toggle), Show diff anyway (the mega-line placeholder), Show full diff (the
 *  line cap). */
export type DrawStep = "raw" | "show-diff-anyway" | "show-full-diff";

/** The controls a listed line takes to draw inline, in the order it takes
 *  them, each at most once. */
export type DrawSteps = readonly [DrawStep, ...DrawStep[]];

/** Why a listed comment isn't inline, as far as the report can tell: the
 *  {@link DrawSteps} that draw its line; `whitespace`, a whole `-w` paint whose
 *  patch lacks the line (Show whitespace may draw it; confirmed against a
 *  whitespace-shown read by {@link confirmWhitespace}); `unplaced`, any other
 *  judged paint whose patch lacks the line, or a position no line resolves. */
export type ListedReason = DrawSteps | "whitespace" | "unplaced";

/** The lines a hunk-only paint draws before Show full diff: DiffSurface caps
 *  the patch at `DIFF_LINE_CAP` (`capDiffText`), as Show diff anyway's rows
 *  and Raw's fresh rows do (a mega line never takes content mode, and a patch
 *  past the cap never does). */
function linesUnderCap(patch: string): ReturnType<typeof patchLines> {
  return patchLines(capDiffText(patch, DIFF_LINE_CAP).text);
}

/** The pane's side of the split is the host's to build: it anchors every
 *  resolved comment but the pinned ones, resolving lines as the list does. */
export interface Placement<C> {
  /** The comments no mounted row draws, plus the pinned ones. */
  listed: { comment: C; reason: ListedReason | null }[];
}

/** What holds a judged report's rows back from a line its patch holds. */
interface Held {
  /** Markdown Preview is up. */
  preview: boolean;
  /** The mega-line placeholder blocks the rows: the cut, or under Preview the
   *  placeholder Raw would draw. */
  megaBlocked: boolean;
  /** The line lies past the cap the hunk-only rows apply (every cut but none:
   *  a mega line never takes content mode, and a patch past the cap never
   *  does). */
  pastCap: boolean;
}

/** The ordered steps a held line takes; null when the rows draw it now. */
function stepsFor({ preview, megaBlocked, pastCap }: Held): DrawSteps | null {
  const steps: DrawStep[] = [];
  if (preview) steps.push("raw");
  if (megaBlocked) steps.push("show-diff-anyway");
  if (pastCap) steps.push("show-full-diff");
  const [first, ...rest] = steps;
  return first === undefined ? null : [first, ...rest];
}

/**
 * Places each comment exactly once: inline when the pane has its anchor row
 * mounted (and it isn't pinned), else listed. `pinned` holds the ids of listed
 * rows whose editor is open, which stay listed and which the pane never
 * anchors, so no row change can unmount an edit. Notes come only from a
 * judged report (one present and not pending): no report means nothing is
 * mounted, so every comment is listed with no note. Under a judged report a
 * line the rows draw now gets no note (rows still catching up: no cut, or
 * inside a cap's shown part), nor does a pinned one on a line the patch holds;
 * a comment with no line is `unplaced` once `patchReady` (the host resolved
 * positions against the patch), else it has no note.
 */
export function placeComments<C extends PlaceableComment>(
  comments: readonly C[],
  report: PaneReport | null,
  pinned: ReadonlySet<string>,
  patchReady: boolean,
): Placement<C> {
  const mounted = new Set(report?.anchors ?? []);
  const listed = comments.filter(
    (c) =>
      c.line === null ||
      pinned.has(c.id) ||
      !mounted.has(anchorKey(c.side, c.line)),
  );
  const judged =
    report === null || report.cut === "pending" || listed.length === 0
      ? null
      : {
          report,
          lines: patchLines(report.patch),
          capped: report.cut === null ? null : linesUnderCap(report.patch),
          megaBlocked:
            report.cut === "mega-line" ||
            (report.cut === "preview" &&
              longestLineLength(report.patch) > DIFF_MEGA_LINE_CHARS),
        };
  return {
    listed: listed.map((comment) => {
      if (judged === null) return { comment, reason: null };
      const { side, line } = comment;
      if (line === null)
        return { comment, reason: patchReady ? "unplaced" : null };
      if (judged.lines[side].has(line)) {
        if (pinned.has(comment.id)) return { comment, reason: null };
        return {
          comment,
          reason: stepsFor({
            preview: judged.report.cut === "preview",
            megaBlocked: judged.megaBlocked,
            pastCap: judged.capped?.[side].has(line) === false,
          }),
        };
      }
      return {
        comment,
        reason:
          judged.report.whitespaceHidden && !judged.report.truncated
            ? "whitespace"
            : "unplaced",
      };
    }),
  };
}

/** A whitespace-shown read of the painted file, as {@link confirmWhitespace}
 *  sees it: not answered yet, failed with nothing loaded, or the new-side lines
 *  it holds. */
export type ShownRead =
  | { kind: "unread" }
  | { kind: "failed" }
  | { kind: "read"; lines: ReadonlySet<number> };

/** A truncated read's text minus its last line, which the cut may have split. */
function withoutLastLine(text: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.slice(0, body.lastIndexOf("\n") + 1);
}

/** The host's whitespace-shown read as a {@link ShownRead}: loaded data wins
 *  over a failed refetch. A binary file holds no lines, and a truncated read
 *  drops its last line. Show whitespace is the first control any of its lines
 *  needs: a line past the shown view's cap, or in a generated-looking file,
 *  then waits on the pane's own control, which its note names once the mode is
 *  off. */
export function shownRead(
  data: { text: string; isBinary: boolean; isTruncated: boolean } | undefined,
  failed: boolean,
): ShownRead {
  if (data !== undefined) {
    if (data.isBinary) return { kind: "read", lines: new Set() };
    const text = data.isTruncated ? withoutLastLine(data.text) : data.text;
    return { kind: "read", lines: patchLines(text).new };
  }
  return failed ? { kind: "failed" } : { kind: "unread" };
}

/** A listed comment's final note: a `whitespace` candidate stays one only while
 *  the whitespace-shown read holds its line, turns `unplaced` once that read
 *  lacks it or failed, and has no note while unread; any other note passes. */
export function confirmWhitespace(
  reason: ListedReason | null,
  line: number | null,
  read: ShownRead,
): ListedReason | null {
  if (reason !== "whitespace" || line === null) return reason;
  switch (read.kind) {
    case "read":
      return read.lines.has(line) ? "whitespace" : "unplaced";
    case "failed":
      return "unplaced";
    case "unread":
      return null;
  }
}
