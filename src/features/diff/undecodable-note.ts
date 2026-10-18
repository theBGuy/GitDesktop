// The working-tree diff's non-UTF-8 gate and its note copy, shared by
// DiffViewer (the gate and the fire-time refusals) and DiffSurface (the note).
// Import-free so scripts/undecodable-note.test.mjs loads it under Node's type
// stripping.

export type StagingSide = "staged" | "unstaged" | "untracked";

/** The frontend tripwire for the whole class: hunk/line writes may run only
 *  over a diff this returns true for. Used by the parsed memo (the structural
 *  gate) AND the fire-time belt's live read, so the two cannot drift. */
export function hunkWritesAllowed(
  d: { undecodable?: boolean } | undefined,
): boolean {
  return d !== undefined && d.undecodable !== true;
}

/** Why hunk/line actions are off for a non-UTF-8 file, per diff side — the flag
 *  is per git_diff_file call (staged = HEAD↔index, unstaged = index↔worktree),
 *  so the copy describes the CHANGE, and each side names its own whole-file way
 *  out. Total Record over the exact union (compiler exhaustiveness). */
export const UNDECODABLE_NOTE_COPY: Record<StagingSide, string> = {
  unstaged:
    "Part of this change isn't UTF-8 text, so the file stages and discards as a whole to keep its bytes exact. Stage or discard it from its row in Changes.",
  staged:
    "Part of this change isn't UTF-8 text, so the file unstages as a whole to keep its bytes exact. Unstage it from its row in Staged.",
  untracked:
    "This new file isn't UTF-8 text, so it stages as a whole to keep its bytes exact. Stage or discard it from its row in Changes.",
};
