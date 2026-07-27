import { readRepoAiIgnore } from "@/lib/git/api";

/** Lines of a newline-joined ignore-pattern string, dropping blanks + comments. */
function ignoreLines(patterns: string): string[] {
  return patterns
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * The user's AI-ignore patterns for a repo: the repo's own
 * `.gitdesktop/aiignore` entries first, then the global setting's lines — the
 * exclude list every AI generation path hands the git layer as pathspec
 * excludes, so a file the user excluded never reaches a model.
 *
 * `aiIgnorePatterns` is the raw newline-joined setting. Rejects when the repo
 * file can't be read; the conflict-resolve surface passes
 * `tolerateRepoReadError` because an unreadable repo file must not abort a
 * resolution that the global patterns alone can still serve.
 */
export async function aiExcludePatterns(
  repoPath: string,
  aiIgnorePatterns: string,
  opts?: { tolerateRepoReadError?: boolean },
): Promise<string[]> {
  const repoIgnore = opts?.tolerateRepoReadError
    ? await readRepoAiIgnore(repoPath).catch(() => [])
    : await readRepoAiIgnore(repoPath);
  return [...repoIgnore, ...ignoreLines(aiIgnorePatterns)];
}
