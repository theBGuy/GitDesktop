import { gitFilterAiIgnored, readRepoAiIgnore } from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import { trimIgnorePattern } from "@/lib/git/glob";

/** Lines of a newline-joined ignore-pattern string, dropping blanks + comments. */
function ignoreLines(patterns: string): string[] {
  return patterns
    .split("\n")
    .map(trimIgnorePattern)
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * The user's AI-ignore patterns for a repo: the repo's own
 * `.gitdesktop/aiignore` entries first, then the global setting's lines
 * (`aiIgnorePatterns`, raw and newline-joined).
 *
 * That order is a security invariant, not a preference: `!` un-ignore lines are
 * honored last-match-wins, and the repo file is committed content anyone with
 * push access can write. Global LAST means a committed `!` can never re-expose a
 * file the user excluded globally.
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

/** U+FFFD, what a lossy UTF-8 decode leaves where the bytes weren't valid. Built
 *  from its code point, never written literally: the character is invisible in
 *  source and a re-encode that mangled it would silently unguard the check below. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * The survivors of a bare path list under the user's AI-ignore patterns, plus
 * how many were hidden — for prompt inputs that carry file NAMES with no diff to
 * route through `filterDiffByAiIgnore` (untracked files).
 *
 * A name carrying U+FFFD is dropped whatever the patterns say: `git status` is
 * decoded lossily, so a non-UTF-8 path arrives mangled and can match no rule the
 * user could write — it fails CLOSED, ahead of the pattern check. `excluded`
 * counts every hidden name (the model can't see either kind), while `unreadable`
 * breaks out the subset no pattern could have matched — a caller explaining
 * itself must not blame the user's patterns for those. KEEP IN SYNC with
 * `filter_untracked_by_ai_ignore` (src-tauri/src/mcp_server/generate.rs). With
 * nothing left to check, or no patterns, the survivors are returned before any IPC.
 */
export async function filterPathsByAiIgnore(input: {
  repoPath: string;
  paths: string[];
  exclude: string[];
}): Promise<{ paths: string[]; excluded: number; unreadable: number }> {
  const { repoPath, paths, exclude } = input;
  const decodable = paths.filter((p) => !p.includes(REPLACEMENT_CHAR));
  const unreadable = paths.length - decodable.length;
  if (decodable.length === 0 || exclude.length === 0) {
    return { paths: decodable, excluded: unreadable, unreadable };
  }
  const hidden = new Set(
    await gitFilterAiIgnored(repoPath, decodable, exclude),
  );
  if (hidden.size === 0) {
    return { paths: decodable, excluded: unreadable, unreadable };
  }
  const kept = decodable.filter((p) => !hidden.has(p));
  return {
    paths: kept,
    excluded: unreadable + (decodable.length - kept.length),
    unreadable,
  };
}

/**
 * Drops every AI-ignored file from an already-resolved unified diff and its
 * changed-file list, client-side — the one recipe for both diff sources, since
 * the server-side route (`gitBranchDiff`'s `exclude`) only exists where
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
