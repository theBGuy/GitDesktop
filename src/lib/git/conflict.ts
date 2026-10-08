import { invoke } from "@/lib/tauri/invoke";

/** The AI-ignore gate's answer for one conflicted path. `unreadable` implies
 *  `ignored`: a name that can't be read as text is withheld with no pattern at
 *  all, so copy naming it must not blame the user's rules. */
export interface ConflictAiVerdict {
  ignored: boolean;
  unreadable: boolean;
}

/** The clean and marked versions of one conflicted file, for AI resolution. */
export interface ConflictSides {
  /** The working-tree file with conflict markers — the primary input. Not every
   *  conflict has markers; a modify/delete file is the surviving side's content. */
  working: string;
  /** Common-ancestor version (stage 1); null for add/add conflicts. */
  base: string | null;
  /** Our side / current HEAD (stage 2); null if our side deleted it. */
  ours: string | null;
  /** Their side / incoming (stage 3); null if their side deleted it. */
  theirs: string | null;
  /** Whether the file must never be sent to a model, and why. Gate on
   *  `.ignored`: the object itself is always truthy. */
  aiIgnored: ConflictAiVerdict;
  /** Whether the working file exists on disk — false when the user deleted it
   *  (`working` collapses to "" either way). */
  workingExists: boolean;
}

/** Reads a conflicted file's base/ours/theirs blobs + the marked working file,
 *  plus whether it's AI-ignored. `exclude` is the combined (repo + global)
 *  AI-ignore pattern list, decided by git's own gitignore engine — the same
 *  matcher, and the same pinned truth table, as the diff commands. */
export const conflictSides = (
  repoPath: string,
  path: string,
  exclude: string[],
) => invoke<ConflictSides>("git_conflict_sides", { repoPath, path, exclude });

/** Writes a resolution to the file, staging it when `stage` (which marks the
 *  conflict resolved). Per-region accepts pass `stage: false` while markers
 *  remain and `true` on the final region; the AI flow stages immediately. */
export const resolveConflict = (
  repoPath: string,
  path: string,
  content: string,
  stage: boolean,
) => invoke<void>("git_resolve_conflict", { repoPath, path, content, stage });

/** Resolves a whole conflicted file by taking one side: "ours" (current/HEAD)
 *  or "theirs" (incoming). Writes that side + stages it, or removes the file when
 *  that side has no version at this path. Works for binary too. */
export const checkoutConflictSide = (
  repoPath: string,
  path: string,
  side: "ours" | "theirs",
) => invoke<void>("git_checkout_conflict_side", { repoPath, path, side });

/** A unified diff between two in-memory contents (for the proposed-vs-ours
 *  resolution preview), rendered by the same viewer as every other diff. */
export const diffContents = (oldText: string, newText: string) =>
  invoke<string>("git_diff_contents", { old: oldText, new: newText });
