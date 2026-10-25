// When a diff surface builds its whole-file (content-mode) diff, as a pure
// decision over its reads, so each refresh paints once. Import-free so
// scripts/file-content-gate.test.mjs loads it under Node's type stripping.

/** `build`: the inputs agree, build in the final layout. `hold-previous`: the
 *  diff text and its whole-file reads are mid-refresh, so the previous complete
 *  paint stays up (never blanked, dimmed or reported unsettled) until they
 *  agree. `hunk-only`: content mode doesn't apply, or the bound ran out, so the
 *  current inputs paint with whatever highlighting they support. */
export type ContentBuildDecision = "build" | "hold-previous" | "hunk-only";

export interface ContentBuildInputs {
  /** Content mode applies to this diff (revs given, within its line budget). */
  wantContent: boolean;
  /** Each side's read has an answer (or the side has no read); a pending read
   *  is the caller's blank gate, never a hold. */
  oldSettled: boolean;
  newSettled: boolean;
  /** Each side's read has a fetch in flight. */
  oldFetching: boolean;
  newFetching: boolean;
  /** The diff text differs from the one the shown paint was built from. */
  textChanged: boolean;
  /** A whole-file read answered differently from the shown paint's. */
  contentChanged: boolean;
  /** The hold for the shown paint has run its bound. */
  boundExpired: boolean;
  /** Keep the shown paint regardless (a view held on purpose), bound or not. */
  frozen: boolean;
}

export function contentBuildGate(i: ContentBuildInputs): ContentBuildDecision {
  if (!i.wantContent) return "hunk-only";
  if (!i.oldSettled || !i.newSettled) return "build";
  const painted = i.textChanged || i.contentChanged;
  if (i.frozen && painted) return "hold-previous";
  // New text whose reads are still refetching, or a read that answered ahead
  // of the text it belongs to: either way the other half is on its way.
  const refreshing =
    (i.textChanged && (i.oldFetching || i.newFetching)) ||
    (i.contentChanged && !i.textChanged);
  if (!refreshing) return "build";
  return i.boundExpired ? "hunk-only" : "hold-previous";
}

/** The inputs of the shown complete paint, as the gate compares them. */
export interface PaintedInputs {
  /** Which reads these are (the file and both revs): another file or rev
   *  pair is another diff, never a refresh of this one. */
  reads: string;
  text: string;
  oldText: string;
  newText: string;
}

/** The `reads` identity of one file's content reads at a rev pair (`null` is
 *  the working tree, `undefined` a side with no read). */
export function contentReadsKey(
  filePath: string,
  oldRev: string | null | undefined,
  newRev: string | null | undefined,
): string {
  const rev = (r: string | null | undefined) =>
    r === undefined ? "-" : r === null ? "~" : `=${r}`;
  return `${rev(oldRev)}\n${rev(newRev)}\n${filePath}`;
}

/**
 * The shown paint after this render's decision. A pending read leaves nothing
 * on screen to hold (null); a hold keeps it; anything else records what it
 * built, the same object back when that is unchanged, so an identical-text
 * refetch builds nothing.
 */
export function paintedAfter(
  painted: PaintedInputs | null,
  decision: ContentBuildDecision,
  pending: boolean,
  now: PaintedInputs,
): PaintedInputs | null {
  if (pending) return null;
  if (decision === "hold-previous") return painted;
  if (
    painted !== null &&
    painted.reads === now.reads &&
    painted.text === now.text &&
    painted.oldText === now.oldText &&
    painted.newText === now.newText
  )
    return painted;
  return now;
}

/** The gate's two change flags against the shown paint: both false with none,
 *  or with one of other reads, so a move to another file or rev pair builds
 *  at once instead of holding the previous diff over it. */
export function changesSince(
  painted: PaintedInputs | null,
  now: PaintedInputs,
): { textChanged: boolean; contentChanged: boolean } {
  if (painted === null || painted.reads !== now.reads)
    return { textChanged: false, contentChanged: false };
  return {
    textChanged: painted.text !== now.text,
    contentChanged:
      painted.oldText !== now.oldText || painted.newText !== now.newText,
  };
}
