// When a diff surface builds its whole-file (content-mode) diff, as a pure
// decision over its reads, so each refresh paints once. Import-free so
// scripts/file-content-gate.test.mjs loads it under Node's type stripping.

/** `build`: build from the current inputs (they agree, or the shown paint was
 *  never a complete one). `hold-previous`: the diff text and its whole-file
 *  reads are mid-refresh, so the caller keeps the build on screen until they
 *  agree (with no build yet, it renders nothing and reports unsettled).
 *  `hunk-only`: content mode doesn't apply, or the bound ran out, so the
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
  /** False only for a paint the bound forced over reads still in flight (and
   *  for paints of the same reads built over it before those reads settle):
   *  such a paint is never held over, so the rest of its reads build at once
   *  as they land. */
  previousComplete: boolean;
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
  if (!i.previousComplete) return "build";
  // New text whose reads are still refetching, or a read that answered ahead
  // of the text it belongs to: either way the other half is on its way.
  const refreshing =
    (i.textChanged && (i.oldFetching || i.newFetching)) ||
    (i.contentChanged && !i.textChanged);
  if (!refreshing) return "build";
  return i.boundExpired ? "hunk-only" : "hold-previous";
}

/** The inputs of a paint, as the gate compares them. */
export interface PaintedInputs {
  /** Which reads these are (the file and both revs): another file or rev
   *  pair is another diff, never a refresh of this one. */
  reads: string;
  text: string;
  oldText: string;
  newText: string;
}

/** The shown paint: its inputs, and whether the gate may hold it over a
 *  refresh (see `previousComplete`). */
export interface Painted extends PaintedInputs {
  complete: boolean;
}

/** The `reads` identity of one file's content reads at a rev pair (`null` is
 *  the working tree, `undefined` a side with no read). `oldPath` is the path
 *  the old side reads (a rename's source); it keys only when it differs, after
 *  a NUL no git path can contain, so no path split reads as another pair. */
export function contentReadsKey(
  filePath: string,
  oldRev: string | null | undefined,
  newRev: string | null | undefined,
  oldPath: string,
): string {
  const rev = (r: string | null | undefined) =>
    r === undefined ? "-" : r === null ? "~" : `=${r}`;
  const from = oldPath === filePath ? "" : `\0${oldPath}`;
  return `${rev(oldRev)}\n${rev(newRev)}\n${filePath}${from}`;
}

/**
 * The shown paint after this render's decision. A pending read leaves nothing
 * on screen to hold (null); a hold keeps it; anything else records what it
 * built, the same object back when that is unchanged, so an identical-text
 * refetch builds nothing. Only the bound makes a paint incomplete; a paint of
 * the same reads over an incomplete one stays so while they are in flight, and
 * completes once they settle (unchanged, in place).
 */
export function paintedAfter(
  painted: Painted | null,
  decision: ContentBuildDecision,
  pending: boolean,
  now: PaintedInputs,
  reads: { wantContent: boolean; inFlight: boolean },
): Painted | null {
  if (pending) return null;
  if (decision === "hold-previous") return painted;
  const sameReads = painted !== null && painted.reads === now.reads;
  const forced = decision === "hunk-only" && reads.wantContent;
  const inherited =
    sameReads && painted !== null && !painted.complete && reads.inFlight;
  const complete = !forced && !inherited;
  if (
    sameReads &&
    painted !== null &&
    painted.text === now.text &&
    painted.oldText === now.oldText &&
    painted.newText === now.newText
  )
    return complete === painted.complete ? painted : { ...painted, complete };
  return { ...now, complete };
}

/** The gate's inputs from the shown paint: no change with none, or with one
 *  of other reads, so a move to another file or rev pair builds at once
 *  instead of holding the previous diff over it. */
export function changesSince(
  painted: Painted | null,
  now: PaintedInputs,
): {
  textChanged: boolean;
  contentChanged: boolean;
  previousComplete: boolean;
} {
  if (painted === null || painted.reads !== now.reads)
    return {
      textChanged: false,
      contentChanged: false,
      previousComplete: true,
    };
  return {
    textChanged: painted.text !== now.text,
    contentChanged:
      painted.oldText !== now.oldText || painted.newText !== now.newText,
    previousComplete: painted.complete,
  };
}
