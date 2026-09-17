import { invoke } from "@/lib/tauri/invoke";
import type {
  ApplyLinesResult,
  CommitResult,
  FileDiff,
  IgnoredFile,
  StagedDiff,
  UnignoreRule,
} from "../types";

export const gitDiffFile = (
  repoPath: string,
  filePath: string,
  staged: boolean,
  untracked: boolean,
) =>
  invoke<FileDiff>("git_diff_file", { repoPath, filePath, staged, untracked });

/** A single file's cumulative diff in an agent session worktree, against the
 *  session's base commit (committed turns + uncommitted edits; new untracked
 *  files show as a full add). Powers the inline edit-step diff in the transcript. */
export const gitSessionFileDiff = (
  repoPath: string,
  filePath: string,
  base: string,
) => invoke<FileDiff>("git_session_file_diff", { repoPath, filePath, base });

/** Staged diff vs HEAD. With `worktree: true` it instead returns ALL in-progress
 *  tracked changes (staged + unstaged) vs HEAD — for naming a branch off work
 *  that may not be staged yet. Untracked files are never included (callers pass
 *  their paths from the status entries separately). */
export const gitStagedDiff = (
  repoPath: string,
  opts: { maxBytes?: number; exclude?: string[]; worktree?: boolean } = {},
) =>
  invoke<StagedDiff>("git_staged_diff", {
    repoPath,
    maxBytes: opts.maxBytes ?? null,
    exclude: opts.exclude ?? null,
    ...(opts.worktree ? { worktree: true } : {}),
  });

export const gitStage = (repoPath: string, paths: string[]) =>
  invoke<void>("git_stage", { repoPath, paths });

export const gitUnstage = (repoPath: string, paths: string[]) =>
  invoke<void>("git_unstage", { repoPath, paths });

export const gitCommit = (
  repoPath: string,
  title: string,
  body?: string,
  amend = false,
) =>
  invoke<CommitResult>("git_commit", {
    repoPath,
    title,
    body: body ?? null,
    amend,
  });

/** One file's bytes for the webview, or the reason they're withheld. */
export interface FileBytes {
  /** Base64 of the file bytes; null when the preview is refused. */
  base64: string | null;
  /** Media type sniffed from the bytes, not the extension — one of PNG, GIF,
   *  JPEG, WebP. null for anything else (SVG, BMP, ICO, text, …). */
  mime: string | null;
  /** Past the byte cap, or a raster whose header declares more than the
   *  webview's decoder should be handed. */
  tooLarge: boolean;
}

/** File content at a rev (null rev = working tree; null result = absent). */
export const gitFileBase64 = (
  repoPath: string,
  rev: string | null,
  filePath: string,
) => invoke<FileBytes | null>("git_file_base64", { repoPath, rev, filePath });

/** Decode base64 file bytes (from git_file_base64) to a UTF-8 string. */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export const gitApplyPatch = (
  repoPath: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
) => invoke<void>("git_apply_patch", { repoPath, patch, cached, reverse });

/** One selected changed line for partial staging. */
export interface SelectedLine {
  side: "old" | "new";
  line: number;
}

/** Stage/unstage/discard a selected subset of lines from a file's diff. */
export const gitApplyPartial = (
  repoPath: string,
  diffText: string,
  selected: SelectedLine[],
  cached: boolean,
  reverse: boolean,
) =>
  invoke<void>("git_apply_partial", {
    repoPath,
    diffText,
    selected,
    cached,
    reverse,
  });

/** Replace lines `[startLine, startLine + expectedLines.length)` (1-based) of a
 *  file with `replacementLines` — GitHub's "Commit suggestion", applied locally.
 *  The backend verifies `expectedLines` still match before editing (a mismatch is
 *  a specific error), preserves EOL/BOM/trailing newline, and stages the file only
 *  when `stageWhenClean` and it had no other local changes. */
export const gitReplaceFileLines = (
  repoPath: string,
  filePath: string,
  startLine: number,
  expectedLines: string[],
  replacementLines: string[],
  stageWhenClean: boolean,
) =>
  invoke<ApplyLinesResult>("git_replace_file_lines", {
    repoPath,
    filePath,
    startLine,
    expectedLines,
    replacementLines,
    stageWhenClean,
  });

/** Discards selected lines from an untracked (new) file — removes just those
 *  1-based line numbers and rewrites it in place (the file stays untracked).
 *  Used for line/hunk discard of a new file, where reverse-applying a patch
 *  would delete the whole file instead. */
export const gitDiscardUntrackedLines = (
  repoPath: string,
  path: string,
  lines: number[],
) => invoke<void>("git_discard_untracked_lines", { repoPath, path, lines });

/** Appends ignore patterns to the repo root `.gitignore` (created if absent),
 *  returning the number of patterns actually appended (already-present ones are
 *  skipped). */
export const appendToGitignore = (repoPath: string, patterns: string[]) =>
  invoke<number>("append_to_gitignore", { repoPath, patterns });

export const gitUntrack = (
  repoPath: string,
  pathspecs: string[],
  ignorePatterns: string[],
) => invoke<void>("git_untrack", { repoPath, pathspecs, ignorePatterns });

export const gitListTracked = (repoPath: string) =>
  invoke<string[]>("git_list_tracked", { repoPath });

/** Every file in the working tree git doesn't track and doesn't ignore. */
export const gitListUntracked = (repoPath: string) =>
  invoke<string[]>("git_list_untracked", { repoPath });

export const gitIgnoredFiles = (repoPath: string) =>
  invoke<IgnoredFile[]>("git_ignored_files", { repoPath });

export const gitForceAdd = (repoPath: string, pathspecs: string[]) =>
  invoke<void>("git_force_add", { repoPath, pathspecs });

export const gitUnignoreRules = (repoPath: string, rules: UnignoreRule[]) =>
  invoke<void>("git_unignore_rules", { repoPath, rules });

export const gitDiscardAll = (repoPath: string) =>
  invoke<void>("git_discard_all", { repoPath });

export const gitDiscardPaths = (
  repoPath: string,
  paths: { path: string; untracked: boolean }[],
) => invoke<void>("git_discard_paths", { repoPath, paths });
