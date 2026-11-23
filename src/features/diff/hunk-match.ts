// Whether a forge's diff text is the change between two whole files, so content
// mode may lay those files around its hunks. Import-free so
// scripts/hunk-match.test.mjs loads it under Node's type stripping.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Every comparison in this file goes through here, so a looser comparison is
 *  one swap. */
function sameLine(a: string, b: string): boolean {
  return a === b;
}

/** A line without the one trailing `\r` a CRLF file carries. */
function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** A file's lines; a final newline ends the last line rather than starting an
 *  empty one, and an empty file has none. */
function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map(bare);
  if (lines[lines.length - 1] === "") lines.pop();
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
): boolean {
  if (oldTo - oldFrom !== newTo - newFrom) return false;
  for (let i = 0; i < oldTo - oldFrom; i++)
    if (!sameLine(oldLines[oldFrom + i], newLines[newFrom + i])) return false;
  return true;
}

function matches(diffText: string, oldText: string, newText: string): boolean {
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
  for (const raw of diffText.split("\n")) {
    const line = bare(raw);
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue;
      const kind = line[0];
      const body = line.slice(1);
      if (kind === " " || kind === "-") {
        if (oldLeft <= 0 || oldAt >= oldLines.length) return false;
        if (!sameLine(oldLines[oldAt], body)) return false;
        oldAt++;
        oldLeft--;
      }
      if (kind === " " || kind === "+") {
        if (newLeft <= 0 || newAt >= newLines.length) return false;
        if (!sameLine(newLines[newAt], body)) return false;
        newAt++;
        newLeft--;
      }
      if (kind !== " " && kind !== "-" && kind !== "+") return false;
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
      if (!sameRun(oldLines, oldEnd, oldFrom, newLines, newEnd, newFrom))
        return false;
      oldAt = oldFrom;
      newAt = newFrom;
      oldLeft = oldCount;
      newLeft = newCount;
      oldEnd = oldFrom;
      newEnd = newFrom;
      hunks++;
      continue;
    }
    if (hunks === 0 || line === "" || line.startsWith("\\")) continue;
    // Anything else after a hunk (a second file's header) is not one file's
    // change.
    return false;
  }
  if (hunks === 0 || oldLeft > 0 || newLeft > 0) return false;
  return sameRun(
    oldLines,
    oldEnd,
    oldLines.length,
    newLines,
    newEnd,
    newLines.length,
  );
}

/** True when `diffText` is exactly the change from `oldText` to `newText`:
 *  every hunk's context and `-` lines are the old file's lines at the hunk's
 *  old offset, its context and `+` lines the new file's at its new offset, and
 *  the lines outside all hunks are the same on both sides. */
export function hunksMatchContent(
  diffText: string,
  oldText: string,
  newText: string,
): boolean {
  if (
    typeof diffText !== "string" ||
    typeof oldText !== "string" ||
    typeof newText !== "string"
  )
    return false;
  try {
    return matches(diffText, oldText, newText);
  } catch {
    return false;
  }
}
