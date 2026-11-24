// Whether a forge's diff text is the change between two whole files, so content
// mode may lay those files around its hunks. Its only import is a relative .ts
// one, so scripts/hunk-match.test.mjs loads it under Node's type stripping.
import { diffLines } from "../../lib/git/diff-split.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The characters `git diff -w` skips when it compares two lines. */
const GIT_WHITESPACE = /[ \t\r\n\v\f]/g;

/** Every comparison in this file goes through here, so a looser comparison is
 *  one swap. `ws`: equal once every character `-w` skips is removed. */
function sameLine(a: string, b: string, ws: boolean): boolean {
  if (a === b) return true;
  return ws && a.replace(GIT_WHITESPACE, "") === b.replace(GIT_WHITESPACE, "");
}

/** A line without the one trailing `\r` a CRLF file carries. */
function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The byte-order mark a first line may open with: the whole-file decoder
 *  strips it and a patch keeps it, so on line 1 it reads as absent. */
const BOM = String.fromCharCode(0xfeff);

/** `line` as compared at file index `at`. */
function atIndex(line: string, at: number): string {
  return at === 0 && line.startsWith(BOM) ? line.slice(1) : line;
}

/** A file's lines; a final newline ends the last line rather than starting an
 *  empty one, and an empty file has none. */
function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map(bare);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > 0) lines[0] = atIndex(lines[0], 0);
  return lines;
}

/** `old[oldFrom, oldTo)` and `new[newFrom, newTo)` hold the same lines. */
function sameRun(
  oldLines: string[],
  oldFrom: number,
  oldTo: number,
  newLines: string[],
  newFrom: number,
  newTo: number,
  ws: boolean,
): boolean {
  if (oldTo - oldFrom !== newTo - newFrom) return false;
  for (let i = 0; i < oldTo - oldFrom; i++)
    if (!sameLine(oldLines[oldFrom + i], newLines[newFrom + i], ws))
      return false;
  return true;
}

/** Where line `last` of one side sits on the other side when it falls in the
 *  gap `[from, to)`, which pairs line for line with the other side's gap from
 *  `otherFrom`; null when it isn't in that gap. */
function inGap(
  last: number,
  from: number,
  to: number,
  otherFrom: number,
): number | null {
  return last >= from && last < to ? otherFrom + (last - from) : null;
}

function matches(
  diffText: string,
  oldText: string,
  newText: string,
  ws: boolean,
): boolean {
  const oldLines = fileLines(oldText);
  const newLines = fileLines(newText);
  // Where the last hunk ended on each side: the lines between two hunks, and
  // after the last, are the ones content mode draws from the files alone.
  let oldEnd = 0;
  let newEnd = 0;
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let oldAt = 0;
  let newAt = 0;
  // A side's final newline is in the patch once a hunk line on that side is
  // its file's last: `\ No newline at end of file` after that line says the
  // file has none, its absence that it has one.
  let lastKind = "";
  let oldShown = false;
  let newShown = false;
  // Under `ws`, a context line is printed from the new side, so its marker
  // (or its absence) speaks for the new file only.
  let oldViaContext = false;
  let oldMarked = false;
  let newMarked = false;
  // Where each side's last line sits on the other, when no hunk holds it.
  let oldTwin: number | null = null;
  let newTwin: number | null = null;
  // The marker belongs to the line before it, on that line's sides, and only
  // a file's last line can carry it.
  const mark = (): boolean => {
    if (lastKind === "") return false;
    if (ws && lastKind === " ") {
      if (newAt !== newLines.length) return false;
      newMarked = true;
      return true;
    }
    if (lastKind !== "+") {
      if (oldAt !== oldLines.length) return false;
      oldMarked = true;
    }
    if (lastKind !== "-") {
      if (newAt !== newLines.length) return false;
      newMarked = true;
    }
    return true;
  };
  for (const raw of diffLines(diffText)) {
    const line = bare(raw);
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) {
        if (!mark()) return false;
        continue;
      }
      // An empty line in a hunk is a blank context line without its space.
      const kind = line === "" ? " " : line[0];
      const body = line.slice(1);
      if (kind === " " || kind === "-") {
        if (oldLeft <= 0 || oldAt >= oldLines.length) return false;
        if (!sameLine(oldLines[oldAt], atIndex(body, oldAt), ws)) return false;
        oldAt++;
        oldLeft--;
        oldShown = oldAt === oldLines.length;
        oldViaContext = kind === " ";
      }
      if (kind === " " || kind === "+") {
        if (newLeft <= 0 || newAt >= newLines.length) return false;
        if (!sameLine(newLines[newAt], atIndex(body, newAt), ws)) return false;
        newAt++;
        newLeft--;
        newShown = newAt === newLines.length;
      }
      if (kind !== " " && kind !== "-" && kind !== "+") return false;
      lastKind = kind;
      if (oldLeft === 0 && newLeft === 0) {
        oldEnd = oldAt;
        newEnd = newAt;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER.exec(line);
      if (!m) return false;
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      // A zero count names the line before the hunk, so it starts after it.
      const oldFrom = oldCount === 0 ? Number(m[1]) : Number(m[1]) - 1;
      const newFrom = newCount === 0 ? Number(m[3]) : Number(m[3]) - 1;
      if (oldFrom < oldEnd || newFrom < newEnd) return false;
      // A start past the file's end names no line, and the gap walk below
      // would run to it unbounded; a zero-count hunk at EOF starts AT the end.
      if (oldFrom > oldLines.length || newFrom > newLines.length) return false;
      if (!sameRun(oldLines, oldEnd, oldFrom, newLines, newEnd, newFrom, ws))
        return false;
      oldTwin ??= inGap(oldLines.length - 1, oldEnd, oldFrom, newEnd);
      newTwin ??= inGap(newLines.length - 1, newEnd, newFrom, oldEnd);
      oldAt = oldFrom;
      newAt = newFrom;
      oldLeft = oldCount;
      newLeft = newCount;
      oldEnd = oldFrom;
      newEnd = newFrom;
      hunks++;
      lastKind = "";
      continue;
    }
    if (hunks > 0 && line.startsWith("\\")) {
      if (!mark()) return false;
      continue;
    }
    if (hunks === 0 || line === "" || line.startsWith("\\")) continue;
    // Anything else after a hunk (a second file's header) is not one file's
    // change.
    return false;
  }
  if (hunks === 0 || oldLeft > 0 || newLeft > 0) return false;
  const oldEol = oldText.endsWith("\n");
  const newEol = newText.endsWith("\n");
  // `-w` counts a final newline as whitespace: it prints nothing for a pair
  // that differs only there, and marks a context line by the new side alone
  // (git 2.51.1, probed; transcript in scripts/hunk-match.test.mjs).
  if (oldShown && !(ws && oldViaContext) && oldMarked === oldEol) return false;
  if (newShown && newMarked === newEol) return false;
  // Last lines outside every hunk are the same line on both sides, so their
  // final newlines agree too.
  if (!ws && !oldShown && !newShown && oldEol !== newEol) return false;
  if (
    !sameRun(
      oldLines,
      oldEnd,
      oldLines.length,
      newLines,
      newEnd,
      newLines.length,
      ws,
    )
  )
    return false;
  oldTwin ??= inGap(oldLines.length - 1, oldEnd, oldLines.length, newEnd);
  newTwin ??= inGap(newLines.length - 1, newEnd, newLines.length, oldEnd);
  // A line no hunk holds is the same on both sides, terminator included: it
  // ends with a newline unless it is that side's last line too.
  const twinEol = (at: number, lines: string[], eol: boolean) =>
    at === lines.length - 1 ? eol : true;
  if (ws) return true;
  if (oldTwin !== null && oldEol !== twinEol(oldTwin, newLines, newEol))
    return false;
  if (newTwin !== null && newEol !== twinEol(newTwin, oldLines, oldEol))
    return false;
  return true;
}

/** True when `diffText` is exactly the change from `oldText` to `newText`:
 *  every hunk's context and `-` lines are the old file's lines at the hunk's
 *  old offset, its context and `+` lines the new file's at its new offset, and
 *  the lines outside all hunks are the same on both sides.
 *  `ignoreWhitespace`: `diffText` is a `git diff -w` of the two, so lines
 *  compare as `-w` compares them and final newlines don't count. */
export function hunksMatchContent(
  diffText: string,
  oldText: string,
  newText: string,
  opts?: { ignoreWhitespace?: boolean },
): boolean {
  if (
    typeof diffText !== "string" ||
    typeof oldText !== "string" ||
    typeof newText !== "string"
  )
    return false;
  try {
    return matches(diffText, oldText, newText, opts?.ignoreWhitespace === true);
  } catch {
    return false;
  }
}
