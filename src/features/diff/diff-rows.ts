// Which rows @git-diff-view renders for a diff: hunk starts, hunk 0's `@@` row,
// and whether any rows render at all. React-free with type-only imports, so
// scripts/diff-pane-hold.test.mjs loads it under Node's type stripping.
import type { DiffHunk } from "@/lib/git/hunks";

/** A hunk's first old/new line number, from its `@@ -a,b +c,d @@` header. */
export function hunkStart(hunk: DiffHunk, side: "old" | "new"): number {
  const m = hunk.header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
  return m ? Number(side === "new" ? m[2] : m[1]) : 1;
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
