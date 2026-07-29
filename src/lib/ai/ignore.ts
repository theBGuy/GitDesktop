import { gitFilterAiIgnored, readRepoAiIgnore } from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";

/**
 * A concrete file/folder path turned into an AI-ignore pattern that matches
 * exactly that path.
 *
 * `[`, `*` and `?` are glob metacharacters, so an unescaped path protects
 * nothing the moment it holds one — a Next.js/SvelteKit dynamic route like
 * `app/[slug]/page.tsx` reads as a character class and matches no real file.
 * Each is wrapped as a one-character class (`[` → `[[]`), which both matching
 * engines honor; a backslash escape does NOT work on the pathspec side. `]`
 * outside a class is already literal. A literal backslash in a name is not
 * expressible on either engine and is left alone (it cannot occur on Windows).
 */
export function aiIgnorePathPattern(path: string): string {
  return path.replace(/[[*?]/g, (c) => `[${c}]`);
}

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

/**
 * Drops every AI-ignored file from an already-resolved unified diff and its
 * changed-file list, client-side.
 *
 * The pathspec-exclude route (`gitBranchDiff`'s `exclude`) only exists where
 * GitDesktop itself runs the diff; a forge-supplied PR diff arrives whole, and
 * the review funnels mix both sources. This is the one recipe for both:
 *
 * - An empty `exclude` returns the input untouched, BEFORE any IPC — no
 *   patterns must cost nothing on any path.
 * - Candidates are the UNION of the diff's own section keys and the file
 *   list, and the section keys are the load-bearing half: a provider's file
 *   list can be capped (gh tops a 100-entry GraphQL page up from REST only on
 *   a best-effort basis) while the diff text still carries every file, so
 *   anything filtered by the short list alone would reach the model
 *   unexamined. Each side is then filtered by its own keys, which keeps that
 *   impossible whatever a provider's list omits.
 * - `excludedFiles` counts the deduped hidden union — not `files.length`
 *   minus the survivors, which a capped list would undercount.
 *
 * Callers must treat the result as a local derivation: the input `text` is
 * typically a cached query string that also feeds the Files tab and the review
 * threads, and those want the full diff.
 */
export async function filterDiffByAiIgnore<F extends { path: string }>(input: {
  repoPath: string;
  text: string;
  files: F[];
  exclude: string[];
}): Promise<{ text: string; files: F[]; excludedFiles: number }> {
  const { repoPath, text, files, exclude } = input;
  // No patterns ⇒ the pre-filter behavior, and no git spawn (the command
  // short-circuits on an empty list too, but don't pay the IPC hop).
  if (exclude.length === 0) return { text, files, excludedFiles: 0 };
  const sections = splitUnifiedDiff(text);
  const candidates = [
    ...new Set([...sections.keys(), ...files.map((f) => f.path)]),
  ];
  // Nothing to hide (an empty diff) — same reason: skip the hop.
  if (candidates.length === 0) return { text, files, excludedFiles: 0 };
  // Ask git's own gitignore engine which paths the patterns hide — the same
  // matcher the diff-side pathspec translation is pinned to.
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
