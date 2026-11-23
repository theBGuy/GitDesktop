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
  /** The caller paints hunk-only over unsettled reads rather than blanking (a
   *  forge-patch host): that paint is never held over, so the reads build as
   *  they land. */
  paintsUnsettled?: boolean;
}

export function contentBuildGate(i: ContentBuildInputs): ContentBuildDecision {
  if (!i.wantContent) return "hunk-only";
  if (!i.oldSettled || !i.newSettled)
    return i.paintsUnsettled ? "hunk-only" : "build";
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

/** A forge-patch diff's content-mode upgrade. `pending`: render nothing yet
 *  (a local first read with nothing of this path on screen, the single-paint
 *  gate). `hunk-only`: paint or keep the hunk-only diff. `build`: build content
 *  mode now. `keep`: the content build on screen stays as it is. `release`:
 *  other content is ready over the build on screen, and waits for the step that
 *  keeps the reader's line; an editor open in the diff holds that step. */
export type ContentUpgradeDecision =
  | "pending"
  | "hunk-only"
  | "build"
  | "keep"
  | "release";

export interface ContentUpgradeInputs {
  /** The whole-file reads come from a forge, never this clone's objects. */
  forge: boolean;
  /** Content mode applies: revs and their source are known, within budget. */
  wanted: boolean;
  /** A build of this path and diff text is on screen. */
  onScreen: boolean;
  /** That build is a content build (implies `onScreen`). */
  contentShown: boolean;
  /** A build of this path is on screen, of any diff text. */
  pathOnScreen: boolean;
  /** Both whole-file reads have an answer. */
  settled: boolean;
  /** The reads fit content mode and the hunk-match guard passed. */
  matched: boolean;
  /** The matched reads are the content build on screen. */
  same: boolean;
  /** An editor is open inside this diff; its text goes with a rebuild. */
  editorOpen: boolean;
}

/** A build on screen is never blanked or rebuilt without its text changing:
 *  losing the reads (revs, source, a refetch) keeps a content build, and every
 *  move to other content for the same text goes through the release step. */
export function contentUpgradeGate(
  i: ContentUpgradeInputs,
): ContentUpgradeDecision {
  if (i.contentShown)
    return i.matched && !i.same && !i.editorOpen ? "release" : "keep";
  if (!i.wanted) return "hunk-only";
  if (!i.settled) return i.forge || i.pathOnScreen ? "hunk-only" : "pending";
  if (!i.matched) return "hunk-only";
  if (!i.onScreen) return "build";
  return i.editorOpen ? "hunk-only" : "release";
}
