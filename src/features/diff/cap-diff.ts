// The diff renderer (@git-diff-view/react) has no virtualization: it commits a
// DOM row for every line in one synchronous render, so a large file blocks the
// main thread on each file switch. Until/unless we virtualize, we cap how much
// of a big diff we hand it at once and offer a one-click "show full diff".

/** Past this many lines, a diff is capped to keep the render under ~1 frame. */
export const DIFF_LINE_CAP = 200;

/** Per-line display cap: any rendered diff line longer than this is hard-shortened. */
export const DIFF_MAX_LINE_CHARS = 4_000;
/** Longest-line threshold past which a diff is treated as generated/minified. */
export const DIFF_MEGA_LINE_CHARS = 20_000;

/**
 * Length (in chars) of the longest line in `text`. Allocation-free scan (no
 * `split` — a single-line minified blob would otherwise build a whole-string
 * array). Mirrors {@link capDiffText}'s own newline-counting style.
 */
export function longestLineLength(text: string): number {
  let longest = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) === 10 /* \n */) {
      if (k - start > longest) longest = k - start;
      start = k + 1;
    }
  }
  // The final line has no trailing \n.
  if (text.length - start > longest) longest = text.length - start;
  return longest;
}

/**
 * Hard-shorten every line longer than `maxChars` so the un-virtualized renderer
 * never mounts a mega-line that freezes the main thread. Shortening a line is a
 * plain `line.slice(0, maxChars)`: the diff marker char (`+`/`-`/space/`\`/`@`)
 * is index 0, so it's preserved, and NO marker/ellipsis text is appended — a
 * diff viewer must not display characters that aren't in the file (the footer
 * strip signals the shortening instead). Line COUNT is unchanged, so `@@` hunk
 * headers stay valid and line numbers stay true. Fast-path: when no line
 * exceeds the cap, return the ORIGINAL string with `shortened: 0` (no split, no
 * allocation) — the common case.
 */
export function shortenLongLines(
  text: string,
  maxChars: number,
): { text: string; shortened: number } {
  if (longestLineLength(text) <= maxChars) return { text, shortened: 0 };
  // Past the fast-path we know at least one line overflows. Split once and
  // shorten in place — mutate only the overflowing entries — rather than
  // building a second array with `.map`.
  const lines = text.split("\n");
  let shortened = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= maxChars) continue;
    shortened++;
    // Surrogate-pair safety: if the last kept char is a high surrogate
    // (0xD800–0xDBFF), cut one char earlier so an astral char / emoji is never
    // split into a lone surrogate (repo bug class — PR #100).
    const code = line.charCodeAt(maxChars - 1);
    const cut = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
    lines[i] = line.slice(0, cut);
  }
  return { text: lines.join("\n"), shortened };
}

interface CappedDiff {
  /** The (possibly shortened) unified-diff text to render. */
  text: string;
  /** Diff lines hidden by the cap; 0 when nothing was cut. */
  hidden: number;
}

/**
 * Cap a unified diff to at most `maxLines` lines so the un-virtualized renderer
 * doesn't mount thousands of rows at once. Cuts on hunk boundaries where it can;
 * a single oversized hunk is cut mid-body with its `@@` header counts rewritten
 * so the result stays a valid hunk the renderer can parse.
 */
export function capDiffText(text: string, maxLines: number): CappedDiff {
  // Count lines without allocating — most diffs fit under the cap and never need
  // the full split (which builds an array as large as the whole diff).
  let lineCount = 1;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) === 10 /* \n */) lineCount++;
  }
  if (lineCount <= maxLines) return { text, hidden: 0 };
  const lines = text.split("\n");

  // Header = everything before the first hunk (diff --git, index, ---, +++).
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk === -1) {
    // No recognizable hunks — slice raw rather than guess.
    return {
      text: lines.slice(0, maxLines).join("\n"),
      hidden: lines.length - maxLines,
    };
  }

  let i = firstHunk;
  let kept = firstHunk; // header lines are always kept

  while (i < lines.length) {
    // This hunk runs from i (an `@@` line) to the next `@@` or EOF.
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("@@")) j++;
    const hunkLen = j - i;

    if (kept + hunkLen <= maxLines) {
      kept += hunkLen;
      i = j;
      continue;
    }

    if (kept > firstHunk) {
      // Already kept at least one whole hunk — stop on this clean boundary.
      return { text: lines.slice(0, i).join("\n"), hidden: lines.length - i };
    }

    // The very first hunk overflows on its own — keep its header plus as much
    // body as fits, with the `@@` counts rewritten to match what we kept.
    const budget = Math.max(1, maxLines - kept - 1);
    const body = lines.slice(i + 1, i + 1 + budget);
    const cut = i + 1 + body.length;
    return {
      text: [
        ...lines.slice(0, i),
        rewriteHunkHeader(lines[i], body),
        ...body,
      ].join("\n"),
      hidden: lines.length - cut,
    };
  }

  return { text, hidden: 0 };
}

/** Rewrite a hunk header's line counts to match a truncated body. */
function rewriteHunkHeader(header: string, body: string[]): string {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!m) return header;
  let oldCount = 0;
  let newCount = 0;
  for (const l of body) {
    const c = l[0];
    if (c === "+") newCount++;
    else if (c === "-") oldCount++;
    else if (c === "\\")
      continue; // "\ No newline at end of file" counts for neither
    else {
      oldCount++; // context line (leading space) belongs to both sides
      newCount++;
    }
  }
  return `@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3]}`;
}
