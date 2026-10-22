// Imported by scripts/discard-targets.test.mjs under Node's type stripping, so
// this module keeps to type-only imports.
import type { FileEntry } from "@/lib/git/types";

/**
 * One discard target per path, in first-seen path order. Git can list a path
 * twice (a staged deletion `D.` beside an untracked `?` after `git rm
 * --cached`); the untracked record wins, since its twin has no working-tree
 * change and discard never touches the index, and the backend refuses a batch
 * naming one path both ways.
 */
export function collapseDiscardEntries<
  T extends Pick<FileEntry, "path" | "unstaged">,
>(entries: readonly T[]): T[] {
  const byPath = new Map<string, T>();
  for (const entry of entries) {
    const kept = byPath.get(entry.path);
    if (
      kept === undefined ||
      (entry.unstaged === "untracked" && kept.unstaged !== "untracked")
    )
      byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}
