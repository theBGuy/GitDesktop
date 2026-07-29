import { gitFilterAiIgnored, readRepoAiIgnore } from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";

/** Lines of a newline-joined ignore-pattern string, dropping blanks + comments. */
function ignoreLines(patterns: string): string[] {
  return patterns
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * The user's AI-ignore patterns for a repo: the repo's own
 * `.gitdesktop/aiignore` entries first, then the global setting's lines
 * (`aiIgnorePatterns`, raw and newline-joined).
 *
 * Rejects when the repo file can't be read — except under
 * `tolerateRepoReadError`, which the conflict-resolve surface passes so an
 * unreadable repo file can't abort a resolution the global patterns alone can
 * still serve.
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

/**
 * Drops every AI-ignored file from an already-resolved unified diff and its
 * changed-file list, client-side — the one recipe for both diff sources, since
 * the pathspec-exclude route (`gitBranchDiff`'s `exclude`) only exists where
 * GitDesktop runs the diff itself and a forge-supplied PR diff arrives whole.
 *
 * Candidates are the UNION of the diff's own section keys and the file list,
 * and the keys are the load-bearing half: a provider's file list can be capped
 * (gh tops a 100-entry GraphQL page up from REST only best-effort) while the
 * diff text still carries every file. `excludedFiles` counts the deduped hidden
 * union, not `files.length` minus the survivors, which a capped list would
 * undercount. An empty `exclude` returns the input untouched, before any IPC.
 *
 * The result is a local derivation — the input `text` is typically a cached
 * query string the Files tab and review threads want in full.
 */
export async function filterDiffByAiIgnore<F extends { path: string }>(input: {
  repoPath: string;
  text: string;
  files: F[];
  exclude: string[];
}): Promise<{ text: string; files: F[]; excludedFiles: number }> {
  const { repoPath, text, files, exclude } = input;
  if (exclude.length === 0) return { text, files, excludedFiles: 0 };
  const sections = splitUnifiedDiff(text);
  const candidates = [
    ...new Set([...sections.keys(), ...files.map((f) => f.path)]),
  ];
  if (candidates.length === 0) return { text, files, excludedFiles: 0 };
  const hidden = new Set(
    await gitFilterAiIgnored(repoPath, candidates, exclude),
  );
  if (hidden.size === 0) return { text, files, excludedFiles: 0 };
  // Each section keeps its own `diff --git` header, so the survivors rejoin
  // into a valid unified diff in their original order.
  const filtered = [...sections]
    .filter(([path]) => !hidden.has(path))
    .map(([, section]) => section)
    .join("");
  return {
    text: filtered,
    files: files.filter((f) => !hidden.has(f.path)),
    excludedFiles: hidden.size,
  };
}
