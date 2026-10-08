import { gitFilterAiIgnored, readRepoAiIgnore } from "@/lib/git/api";
import { DIFF_SECTION_BOUNDARY, sectionFilePath } from "@/lib/git/diff-split";
import { trimIgnorePattern } from "@/lib/git/glob";
import type { PathListingEntry } from "@/lib/git/types";

/** Lines of a newline-joined ignore-pattern string, dropping blanks + comments. */
export function ignoreLines(patterns: string): string[] {
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
export const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * Listing rows for names that crossed IPC as bare strings with no byte flag
 * (status entries): any U+FFFD fails closed as undecodable, since a real one is
 * indistinguishable from a lost byte there. Rows from `gitListTracked` /
 * `gitListUntracked` carry the backend's flag and never need this.
 */
export function lossyListingRows(paths: string[]): PathListingEntry[] {
  return paths.map((path) => ({
    path,
    undecodable: path.includes(REPLACEMENT_CHAR),
  }));
}

/**
 * The survivors of a bare path list under the user's AI-ignore patterns, plus
 * how many were hidden — for prompt inputs that carry file NAMES with no diff to
 * route through `filterDiffByAiIgnore` (untracked files).
 *
 * An `undecodable` row is dropped whatever the patterns say: its lossy spelling
 * can't be matched for the real name, so it fails CLOSED ahead of the pattern
 * check, while a decodable name holding a real U+FFFD gets its true verdict, as
 * in the Rust twin `filter_untracked_by_ai_ignore`
 * (src-tauri/src/mcp_server/generate.rs). `excluded` counts every hidden name (the
 * model can't see either kind) and `unreadable` the subset no pattern decided, so
 * `excluded - unreadable` is the pattern-hidden count. Result shape KEEP IN SYNC
 * with the twin. With nothing left to check, or no patterns, the survivors are
 * returned before any IPC.
 */
export async function filterPathsByAiIgnore(input: {
  repoPath: string;
  paths: PathListingEntry[];
  exclude: string[];
}): Promise<{ paths: string[]; excluded: number; unreadable: number }> {
  const { repoPath, paths, exclude } = input;
  const decodable = paths.filter((p) => !p.undecodable).map((p) => p.path);
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

/** Which causes hid changed files. */
export type HiddenCause = "patterns" | "unreadable" | "both";

/**
 * The causes behind a SUBSET pair (`unreadableFiles <= excludedFiles`: the
 * `StagedDiff` wire, or `filterPathsByAiIgnore`'s counts), or null when nothing
 * was hidden. Never fed `filterDiffByAiIgnore`'s raw pair, whose unreadable count
 * isn't a subset — convert it with `unreadableNameCount` first.
 */
export function hiddenCause(
  excludedFiles: number,
  unreadableFiles: number,
): HiddenCause | null {
  const patternHidden = excludedFiles - unreadableFiles > 0;
  if (patternHidden && unreadableFiles > 0) return "both";
  if (unreadableFiles > 0) return "unreadable";
  return patternHidden ? "patterns" : null;
}

/** The U+FFFD-name share of `filterDiffByAiIgnore`'s `unreadableFiles`: unlike the
 *  raw count it is a subset of `excludedFiles`, so the pair it forms may be
 *  subtracted. */
export function unreadableNameCount(filtered: {
  unreadableFiles: number;
  unkeyableSections: number;
}): number {
  return filtered.unreadableFiles - filtered.unkeyableSections;
}

/** Why filtering emptied a diff: `withheld` when sections couldn't be checked
 *  against active patterns; otherwise by the hidden names' causes —
 *  `excluded` (the user's patterns), `unreadable-names` (names that aren't
 *  readable text), or `unreadable-and-excluded` (both). */
export type EmptyDiffCause =
  | "excluded"
  | "withheld"
  | "unreadable-names"
  | "unreadable-and-excluded";

const EMPTY_CAUSE_BY_HIDDEN: Record<HiddenCause, EmptyDiffCause> = {
  patterns: "excluded",
  unreadable: "unreadable-names",
  both: "unreadable-and-excluded",
};

/** The cause to name for a `filterDiffByAiIgnore` result whose text came back
 *  empty; null when nothing was hidden at all. */
export function emptyDiffCause(filtered: {
  excludedFiles: number;
  unreadableFiles: number;
  unkeyableSections: number;
}): EmptyDiffCause | null {
  if (filtered.unkeyableSections > 0) return "withheld";
  const cause = hiddenCause(
    filtered.excludedFiles,
    unreadableNameCount(filtered),
  );
  return cause && EMPTY_CAUSE_BY_HIDDEN[cause];
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
 * undercount.
 *
 * A candidate carrying U+FFFD is dropped whatever the patterns say, and with no
 * patterns configured at all: diff text carries no per-name byte flag, so a real
 * U+FFFD is indistinguishable from a byte lost to a lossy decode and both fail
 * CLOSED, ahead of the pattern check. (Flagged listing rows through
 * `filterPathsByAiIgnore`, and the Rust `filtered_diff` arm, judge real bytes and
 * give a real-U+FFFD name its true verdict.) `unreadableFiles` counts that subset
 * again so a caller explaining itself can keep the two causes apart. Only
 * decodable candidates reach the matcher; an empty `exclude` skips the IPC,
 * though the sections are parsed either way, since the unreadable check reads
 * the same candidate keys.
 *
 * A section that decodes to no key is dropped too, but only while patterns are
 * active; it is counted in `unkeyableSections` and folded into `unreadableFiles`
 * ALONE: it can't be matched to a `files` entry (which stays listed), so counting
 * it as excluded would double-count a name the patterns may already have hidden.
 * `excludedFiles` is thus hidden NAMES (pattern matches plus U+FFFD names);
 * `unreadableFiles` is the U+FFFD names plus `unkeyableSections`, NOT a subset of
 * it, so never subtract that pair — `unreadableNameCount` is the subset share.
 *
 * The result is a local derivation — the input `text` is typically a cached
 * query string the Files tab and review threads want in full.
 */
export async function filterDiffByAiIgnore<F extends { path: string }>(input: {
  repoPath: string;
  text: string;
  files: F[];
  exclude: string[];
}): Promise<{
  text: string;
  files: F[];
  excludedFiles: number;
  unreadableFiles: number;
  unkeyableSections: number;
}> {
  const { repoPath, text, files, exclude } = input;
  const parts = text
    .split(DIFF_SECTION_BOUNDARY)
    .map((part) => ({ part, path: sectionFilePath(part) }));
  const candidates = [
    ...new Set([
      ...parts.flatMap(({ path }) => (path ? [path] : [])),
      ...files.map((f) => f.path),
    ]),
  ];
  const hidden = new Set(
    candidates.filter((p) => p.includes(REPLACEMENT_CHAR)),
  );
  const unreadableFiles = hidden.size;
  const decodable = candidates.filter((p) => !p.includes(REPLACEMENT_CHAR));
  if (decodable.length > 0 && exclude.length > 0) {
    for (const path of await gitFilterAiIgnored(repoPath, decodable, exclude)) {
      hidden.add(path);
    }
  }
  // A section no key decodes was never checked against the patterns, so it is
  // withheld while any are active; with none there is nothing to check it
  // against, so it stays. Runner diffs pin their `a/` `b/` prefixes, so prefix
  // config never makes a section unkeyable; what does is a malformed header or
  // text from another source (a forge-supplied or reconstructed diff).
  const unkeyable =
    exclude.length > 0
      ? parts.filter(({ part, path }) => !path && part.trim()).length
      : 0;
  if (hidden.size === 0 && unkeyable === 0) {
    return {
      text,
      files,
      excludedFiles: 0,
      unreadableFiles: 0,
      unkeyableSections: 0,
    };
  }
  // Filtering the parts in place keeps their order and every same-key section
  // (both halves of a typechange); each keeps its own `diff --git` header.
  const filtered = parts
    .filter(({ part, path }) =>
      path ? !hidden.has(path) : exclude.length === 0 || !part.trim(),
    )
    .map(({ part }) => part)
    .join("");
  return {
    text: filtered,
    files: files.filter((f) => !hidden.has(f.path)),
    excludedFiles: hidden.size,
    unreadableFiles: unreadableFiles + unkeyable,
    unkeyableSections: unkeyable,
  };
}
